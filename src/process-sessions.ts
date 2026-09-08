import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";

const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_INTERACTIVE_YIELD_MS = 250;
const DEFAULT_POLL_YIELD_MS = 5_000;
const MAX_COMMAND_YIELD_MS = 30_000;
const MAX_POLL_YIELD_MS = 110_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const DEFAULT_BUFFER_CHARACTERS = 1_000_000;
const COMPLETED_SESSION_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export interface StartCommandInput {
  workspaceId: string;
  command: string;
  cwd: string;
  workspaceRoot?: string;
  tty?: boolean;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

export interface WriteStdinInput {
  workspaceId: string;
  sessionId: number;
  chars?: string;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

export interface StartProcessInput {
  workspaceId: string;
  executable: string;
  args?: string[];
  stdin?: string;
  cwd: string;
  workspaceRoot?: string;
  timeoutMs?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

export interface NativeProcessSnapshot extends ProcessSnapshot {
  executionId: string;
  cwd: string;
  timedOut: boolean;
  cancelled: boolean;
  spawnError?: string;
  stdinError?: string;
}

export interface ProcessSnapshot {
  sessionId?: number;
  output: string;
  outputTruncated: boolean;
  running: boolean;
  exitCode?: number;
  signal?: string;
  wallTimeMs: number;
}

interface ManagedProcess {
  write(data: string): void;
  kill(signal?: NodeJS.Signals): void;
  resize?(columns: number, rows: number): void;
}

interface ProcessSession {
  id: number;
  workspaceId: string;
  process?: ManagedProcess;
  startedAt: number;
  columns: number;
  rows: number;
  buffer: HeadTailBuffer;
  running: boolean;
  exitCode?: number;
  signal?: string;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  cleanupTimer?: NodeJS.Timeout;
  runtimeTimer?: NodeJS.Timeout;
  native?: {
    executionId: string;
    cwd: string;
    timedOut: boolean;
    cancelled: boolean;
    spawnError?: string;
    stdinError?: string;
  };
}

interface ProcessSessionManagerOptions {
  maxBufferCharacters?: number;
  completedSessionTtlMs?: number;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Duration and output limits must be non-negative.");
  }
  return Math.min(Math.floor(value), maximum);
}

function nativeInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Native process limits must be integers between ${minimum} and ${maximum}.`);
  }
  return value;
}

function validateNativeInput(input: StartProcessInput): { args: string[]; timeoutMs: number; yieldTimeMs: number } {
  if (typeof input.executable !== "string" || !input.executable.trim() || input.executable.length > 1_024 || input.executable.includes("\0")) {
    throw new Error("Native executable must be a non-empty string of at most 1024 characters without NUL.");
  }
  if (process.platform === "win32" && /\.(cmd|bat)[ .]*$/i.test(input.executable)) {
    throw new Error("Windows .cmd and .bat files require shell semantics; use exec_command or bash explicitly.");
  }
  const args = input.args ?? [];
  if (!Array.isArray(args) || args.length > 256 || args.some(arg => typeof arg !== "string" || arg.length > 8_192 || arg.includes("\0"))) {
    throw new Error("Native args must contain at most 256 strings, each at most 8192 characters without NUL.");
  }
  if ([input.executable, ...args].reduce((total, value) => total + Buffer.byteLength(value, "utf8") + 1, 0) > 16_000) {
    throw new Error("Native executable and args must fit within 16000 UTF-8 bytes including argument boundaries.");
  }
  if (input.stdin !== undefined && (typeof input.stdin !== "string" || Buffer.byteLength(input.stdin, "utf8") > 65_536)) {
    throw new Error("Native stdin must fit within 65536 UTF-8 bytes.");
  }
  const timeoutMs = nativeInteger(input.timeoutMs, 60_000, 1, 3_600_000);
  const yieldTimeMs = nativeInteger(input.yieldTimeMs, DEFAULT_EXEC_YIELD_MS, 0, MAX_COMMAND_YIELD_MS);
  nativeInteger(input.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 1, 100_000);
  return { args: [...args], timeoutMs, yieldTimeMs };
}

function terminalSize(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Terminal dimensions must be integers between 1 and 1000.");
  }
  return value;
}

function processEnvironment(input?: {
  workspaceId?: string;
  workspaceRoot?: string;
}): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    NO_COLOR: "1",
    TERM: "dumb",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GH_PAGER: "cat",
    CODEX_CI: "1",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    ...(input?.workspaceId ? { DEVSPACE_WORKSPACE_ID: input.workspaceId } : {}),
    ...(input?.workspaceRoot ? { DEVSPACE_WORKSPACE_ROOT: input.workspaceRoot } : {}),
  };
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function sliceCodePoints(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join("");
}

function takeHead(value: string, count: number): string {
  if (count <= 0) return "";
  return sliceCodePoints(value, 0, count);
}

function takeTail(value: string, count: number): string {
  if (count <= 0) return "";
  const characters = Array.from(value);
  return characters.slice(Math.max(0, characters.length - count)).join("");
}

function splitBudget(maxCharacters: number): { head: number; tail: number } {
  return {
    head: Math.ceil(maxCharacters / 2),
    tail: Math.floor(maxCharacters / 2),
  };
}

function formatHeadTail(head: string, tail: string, omittedCharacters: number): string {
  if (omittedCharacters <= 0) return head + tail;
  return `${head}\n... output truncated (${omittedCharacters} characters omitted) ...\n${tail}`;
}

export class HeadTailBuffer {
  private head = "";
  private tail = "";
  private totalCharacters = 0;

  constructor(private readonly maxCharacters: number) {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Head/tail buffer limit must be a positive integer.");
    }
  }

  append(output: string): void {
    if (!output) return;

    const previousTotal = this.totalCharacters;
    this.totalCharacters += codePointLength(output);

    if (this.totalCharacters <= this.maxCharacters) {
      this.head += output;
      return;
    }

    const budget = splitBudget(this.maxCharacters);
    if (previousTotal <= this.maxCharacters) {
      const fullOutput = this.head + output;
      this.head = takeHead(fullOutput, budget.head);
      this.tail = takeTail(fullOutput, budget.tail);
      return;
    }

    this.tail = takeTail(this.tail + output, budget.tail);
  }

  hasOutput(): boolean {
    return this.totalCharacters > 0;
  }

  drain(maxCharacters: number): { output: string; truncated: boolean } {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Output limit must be a positive integer.");
    }

    const omittedByBuffer = Math.max(
      0,
      this.totalCharacters - codePointLength(this.head) - codePointLength(this.tail),
    );
    const retained = formatHeadTail(this.head, this.tail, omittedByBuffer);
    const output = truncateOutput(retained, maxCharacters);
    const truncated = omittedByBuffer > 0 || output.truncated;

    this.head = "";
    this.tail = "";
    this.totalCharacters = 0;

    return { output: output.output, truncated };
  }
}

function truncateOutput(output: string, maxCharacters: number): { output: string; truncated: boolean } {
  const outputCharacters = codePointLength(output);
  if (outputCharacters <= maxCharacters) return { output, truncated: false };

  const marker = "\n... output truncated ...\n";
  const markerCharacters = codePointLength(marker);
  const available = Math.max(0, maxCharacters - markerCharacters);
  const budget = splitBudget(available);
  return {
    output: takeHead(output, budget.head) + marker + takeTail(output, budget.tail),
    truncated: true,
  };
}

export class ProcessSessionManager {
  private readonly sessions = new Map<number, ProcessSession>();
  private readonly maxBufferCharacters: number;
  private readonly completedSessionTtlMs: number;
  private nextSessionId = 1;

  constructor(options: ProcessSessionManagerOptions = {}) {
    this.maxBufferCharacters = options.maxBufferCharacters ?? DEFAULT_BUFFER_CHARACTERS;
    this.completedSessionTtlMs = options.completedSessionTtlMs ?? COMPLETED_SESSION_TTL_MS;
  }

  async start(input: StartCommandInput): Promise<ProcessSnapshot> {
    const session = this.createSession(input);
    this.sessions.set(session.id, session);

    try {
      if (input.tty && process.platform !== "win32") await this.startPty(session, input);
      else this.startPipe(session, input);
    } catch (error) {
      this.sessions.delete(session.id);
      throw error;
    }

    const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_EXEC_YIELD_MS, MAX_COMMAND_YIELD_MS);
    await this.waitForExit(session, yieldTimeMs);

    const snapshot = this.consume(session, input.maxOutputTokens);
    if (!session.running) this.removeSession(session.id);
    return snapshot;
  }

  async startProcess(input: StartProcessInput): Promise<NativeProcessSnapshot> {
    // Validate all budgets before the child can have any side effects.
    const { args, timeoutMs, yieldTimeMs } = validateNativeInput(input);
    const session = this.createSession({ workspaceId: input.workspaceId });
    session.native = { executionId: randomUUID(), cwd: input.cwd, timedOut: false, cancelled: false };
    this.sessions.set(session.id, session);
    this.startNativePipe(session, input, args, timeoutMs);
    await this.waitForExit(session, yieldTimeMs);
    const snapshot = this.consume(session, input.maxOutputTokens) as NativeProcessSnapshot;
    if (!session.running) this.removeSession(session.id);
    return snapshot;
  }

  async nativeStatus(input: Omit<WriteStdinInput, "chars" | "columns" | "rows">): Promise<NativeProcessSnapshot> {
    const session = this.getNativeSession(input.workspaceId, input.sessionId);
    nativeInteger(input.yieldTimeMs, DEFAULT_POLL_YIELD_MS, 0, MAX_COMMAND_YIELD_MS);
    nativeInteger(input.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 1, 100_000);
    return await this.writeSession(session, { workspaceId: input.workspaceId, sessionId: input.sessionId,
      yieldTimeMs: input.yieldTimeMs, maxOutputTokens: input.maxOutputTokens }) as NativeProcessSnapshot;
  }

  async cancelNative(input: Omit<WriteStdinInput, "chars" | "columns" | "rows">): Promise<NativeProcessSnapshot> {
    const session = this.getNativeSession(input.workspaceId, input.sessionId);
    nativeInteger(input.yieldTimeMs, DEFAULT_INTERACTIVE_YIELD_MS, 0, MAX_COMMAND_YIELD_MS);
    nativeInteger(input.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 1, 100_000);
    this.terminate(input.workspaceId, input.sessionId);
    return await this.writeSession(session, { workspaceId: input.workspaceId, sessionId: input.sessionId,
      yieldTimeMs: input.yieldTimeMs ?? DEFAULT_INTERACTIVE_YIELD_MS, maxOutputTokens: input.maxOutputTokens }) as NativeProcessSnapshot;
  }

  async write(input: WriteStdinInput): Promise<ProcessSnapshot> {
    const session = this.getOwnedSession(input.workspaceId, input.sessionId);
    if (session.native) {
      throw new Error("Native process sessions require process_status or process_cancel; write_stdin cannot preserve their execution result.");
    }
    return this.writeSession(session, input);
  }

  private async writeSession(session: ProcessSession, input: WriteStdinInput): Promise<ProcessSnapshot> {
    const chars = input.chars ?? "";
    const interactionRequested =
      chars.length > 0 || input.columns !== undefined || input.rows !== undefined;

    if (input.columns !== undefined || input.rows !== undefined) {
      session.columns = terminalSize(input.columns, session.columns);
      session.rows = terminalSize(input.rows, session.rows);
      if (!session.process?.resize) {
        throw new Error(`Process session ${session.id} is not a PTY and cannot be resized.`);
      }
      session.process.resize(session.columns, session.rows);
    }

    const interruptRequested = chars.includes("\u0003") && session.running;
    if (interruptRequested) {
      session.process?.kill("SIGINT");
    }
    const writableChars = chars.replaceAll("\u0003", "");
    if (writableChars && session.running) session.process?.write(writableChars);

    if ((interactionRequested || !session.buffer.hasOutput()) && session.running) {
      const fallback = interactionRequested ? DEFAULT_INTERACTIVE_YIELD_MS : DEFAULT_POLL_YIELD_MS;
      const maximum = interactionRequested ? MAX_COMMAND_YIELD_MS : MAX_POLL_YIELD_MS;
      const yieldTimeMs = boundedInteger(input.yieldTimeMs, fallback, maximum);
      await this.waitForExit(session, yieldTimeMs);
    }

    const snapshot = this.consume(session, input.maxOutputTokens);
    if (!session.running) this.removeSession(session.id);
    return snapshot;
  }

  terminate(workspaceId: string, sessionId: number): void {
    const session = this.getOwnedSession(workspaceId, sessionId);
    if (session.running) {
      if (session.native) {
        session.native.cancelled = true;
        if (session.runtimeTimer) clearTimeout(session.runtimeTimer);
      }
      session.process?.kill(session.native ? "SIGKILL" : "SIGTERM");
    }
  }

  shutdown(): void {
    for (const session of this.sessions.values()) {
      if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
      if (session.runtimeTimer) clearTimeout(session.runtimeTimer);
      if (session.running) session.process?.kill(session.native ? "SIGKILL" : "SIGTERM");
    }
    this.sessions.clear();
  }

  private async waitForExit(session: ProcessSession, yieldTimeMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        session.exitPromise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, yieldTimeMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private createSession(input: Pick<StartCommandInput, "workspaceId" | "columns" | "rows">): ProcessSession {
    let resolveExit = (): void => undefined;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    return {
      id: this.nextSessionId++,
      workspaceId: input.workspaceId,
      startedAt: Date.now(),
      columns: terminalSize(input.columns, DEFAULT_COLUMNS),
      rows: terminalSize(input.rows, DEFAULT_ROWS),
      buffer: new HeadTailBuffer(this.maxBufferCharacters),
      running: true,
      exitPromise,
      resolveExit,
    };
  }

  private startPipe(session: ProcessSession, input: StartCommandInput): void {
    const shell = resolveShellCommand(input.command);
    const detached = process.platform !== "win32";
    const child = spawn(input.command, {
      cwd: input.cwd,
      env: processEnvironment({
        workspaceId: input.workspaceId,
        workspaceRoot: input.workspaceRoot,
      }),
      stdio: "pipe",
      windowsHide: true,
      detached,
      shell: shell.executable,
    });

    session.process = {
      write: (data) => child.stdin.write(data),
      kill: (signal = "SIGTERM") => terminateProcessTree(child, signal, detached),
      resize: input.tty ? () => undefined : undefined,
    };
    child.stdout.on("data", (data: Buffer) => this.append(session, data.toString("utf8")));
    child.stderr.on("data", (data: Buffer) => this.append(session, data.toString("utf8")));
    child.on("error", (error) => this.append(session, `${error.message}\n`));
    child.on("close", (code, signal) => this.finish(session, code ?? undefined, signal ?? undefined));
  }

  private startNativePipe(session: ProcessSession, input: StartProcessInput, args: string[], timeoutMs: number): void {
    const detached = process.platform !== "win32";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.executable, args, {
        cwd: input.cwd,
        env: processEnvironment(input),
        stdio: "pipe",
        shell: false,
        windowsHide: true,
        detached,
      });
    } catch (error) {
      session.native!.spawnError = (error as NodeJS.ErrnoException).code ?? "SPAWN_FAILED";
      this.finish(session);
      return;
    }
    session.process = {
      write: () => { throw new Error("Native process stdin is closed."); },
      kill: (signal = "SIGKILL") => terminateProcessTree(child, signal, detached),
    };
    for (const stream of [child.stdout!, child.stderr!]) {
      const decoder = new StringDecoder("utf8");
      stream.on("data", (data: Buffer) => this.append(session, decoder.write(data)));
      stream.on("end", () => this.append(session, decoder.end()));
    }
    child.on("error", (error: NodeJS.ErrnoException) => {
      // Error codes identify launch failures without copying argv or stdin into logs.
      session.native!.spawnError = error.code ?? "SPAWN_FAILED";
    });
    child.stdin!.on("error", (error: NodeJS.ErrnoException) => {
      session.native!.stdinError = error.code ?? "STDIN_FAILED";
    });
    child.on("close", (code, signal) => this.finish(session, code ?? undefined, signal ?? undefined));
    session.runtimeTimer = setTimeout(() => {
      if (!session.running) return;
      session.native!.timedOut = true;
      // A total runtime limit must also stop children that ignore graceful signals.
      session.process?.kill("SIGKILL");
    }, Math.max(0, timeoutMs - (Date.now() - session.startedAt)));
    session.runtimeTimer.unref();
    child.stdin!.end(input.stdin ?? "", "utf8");
  }

  private async startPty(session: ProcessSession, input: StartCommandInput): Promise<void> {
    let nodePty: typeof import("node-pty");
    try {
      nodePty = await import("node-pty");
    } catch {
      throw new Error("PTY support requires the optional node-pty dependency.");
    }

    const shell = resolveShellCommand(input.command);
    let pty: import("node-pty").IPty;
    try {
      pty = nodePty.spawn(shell.executable, shell.args, {
        cwd: input.cwd,
        env: processEnvironment({
          workspaceId: input.workspaceId,
          workspaceRoot: input.workspaceRoot,
        }),
        name: "xterm-256color",
        cols: session.columns,
        rows: session.rows,
      });
    } catch (error) {
      throw error;
    }

    session.process = {
      write: (data) => pty.write(data),
      kill: (signal) => pty.kill(signal),
      resize: (columns, rows) => pty.resize(columns, rows),
    };
    pty.onData((data) => this.append(session, data));
    pty.onExit(({ exitCode, signal }) => {
      this.finish(session, exitCode, signal === 0 ? undefined : String(signal));
    });
  }

  private finish(session: ProcessSession, exitCode?: number, signal?: string): void {
    if (!session.running) return;
    session.running = false;
    if (session.runtimeTimer) clearTimeout(session.runtimeTimer);
    session.exitCode = exitCode;
    session.signal = signal;
    session.resolveExit();
    session.cleanupTimer = setTimeout(
      () => this.sessions.delete(session.id),
      this.completedSessionTtlMs,
    );
    session.cleanupTimer.unref();
  }

  private append(session: ProcessSession, output: string): void {
    session.buffer.append(output);
  }

  private consume(session: ProcessSession, maxOutputTokens?: number): ProcessSnapshot {
    const limit = boundedInteger(maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
    const maxCharacters = Math.max(256, limit * 4);
    const buffered = session.buffer.drain(maxCharacters);

    return {
      sessionId: session.running ? session.id : undefined,
      output: buffered.output,
      outputTruncated: buffered.truncated,
      running: session.running,
      exitCode: session.exitCode,
      signal: session.signal,
      wallTimeMs: Date.now() - session.startedAt,
      ...(session.native ?? {}),
    };
  }

  private getOwnedSession(workspaceId: string, sessionId: number): ProcessSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown process session: ${sessionId}`);
    if (session.workspaceId !== workspaceId) {
      throw new Error(`Process session ${sessionId} does not belong to workspace ${workspaceId}.`);
    }
    return session;
  }

  private removeSession(sessionId: number): void {
    const session = this.sessions.get(sessionId);
    if (session?.cleanupTimer) clearTimeout(session.cleanupTimer);
    this.sessions.delete(sessionId);
  }

  private getNativeSession(workspaceId: string, sessionId: number): ProcessSession {
    const session = this.getOwnedSession(workspaceId, sessionId);
    if (!session.native) throw new Error(`Process session ${sessionId} was not started by run_process.`);
    return session;
  }
}
