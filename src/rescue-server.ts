import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { OAuthConfig } from "./oauth-provider.js";

const execFileAsync = promisify(execFile);
const DEFAULT_RESCUE_PORT = 7677;
const DEFAULT_RESCUE_UNIT = "xm001-devspace.service";
const DEFAULT_MAIN_READY_URL = "http://127.0.0.1:7676/readyz";
const MAX_RESCUE_LOG_LINES = 200;
const MAX_ACTION_OUTPUT_BYTES = 64 * 1024;

export interface RescueServiceStatus {
  activeState: string;
  subState: string;
  mainPid: number;
}

export interface RescueReadyStatus {
  ok: boolean;
  status: number;
}

export interface RescueLogResult {
  lines: number;
  output: string;
}

export interface RescueRestartResult extends RescueServiceStatus {
  restarted: true;
}

export interface RescueActions {
  status(): Promise<RescueServiceStatus>;
  ready(): Promise<RescueReadyStatus>;
  logs(lines: number): Promise<RescueLogResult>;
  restart(): Promise<RescueRestartResult>;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RescueActionConfig {
  unit: string;
  readyUrl: URL;
}

interface RescueActionDependencies {
  run?: (executable: string, args: string[]) => Promise<CommandResult>;
  probeReady?: (url: URL) => Promise<RescueReadyStatus>;
}

export interface RescueServerConfig {
  host: "127.0.0.1";
  port: number;
  publicBaseUrl: string;
  stateDir: string;
  unit: string;
  readyUrl: URL;
  oauth: OAuthConfig;
}

function textResult<T extends object>(value: T) {
  const result = JSON.stringify(value);
  const structuredContent: Record<string, unknown> = { result, ...value };
  return {
    content: [{ type: "text" as const, text: result }],
    structuredContent,
  };
}

/** Fixed recovery surface. No arbitrary command, path, workspace or file input exists. */
export function createRescueMcpServer(actions: RescueActions): McpServer {
  const server = new McpServer(
    {
      name: "devspace-rescue",
      title: "DevSpace Rescue",
      version: "1",
      description: "Minimal recovery control plane for one configured DevSpace service.",
    },
    {
      instructions:
        "Use only for DevSpace recovery. This server exposes fixed service status, readiness, recent logs and restart actions. It has no shell, file, workspace or arbitrary process capability.",
    },
  );

  server.registerTool("rescue_status", {
    title: "Read DevSpace service status",
    description: "Read the configured DevSpace systemd user service state and PID.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => textResult(await actions.status()));

  server.registerTool("rescue_ready", {
    title: "Probe DevSpace readiness",
    description: "Probe the fixed loopback DevSpace readiness URL configured when the rescue service starts.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => textResult(await actions.ready()));

  server.registerTool("rescue_logs", {
    title: "Read recent DevSpace service logs",
    description: "Read a bounded number of recent journal lines for the configured DevSpace systemd user service.",
    inputSchema: {
      lines: z.number().int().min(1).max(MAX_RESCUE_LOG_LINES).optional()
        .describe("Recent journal lines to return. Defaults to 50; maximum 200."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ lines }) => textResult(await actions.logs(lines ?? 50)));

  server.registerTool("rescue_restart", {
    title: "Restart DevSpace service",
    description: "Restart only the configured DevSpace systemd user service, then return its observed state.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async () => textResult(await actions.restart()));

  return server;
}

function parseSystemdStatus(output: string): RescueServiceStatus {
  const fields = Object.fromEntries(output.split(/\r?\n/)
    .map(line => line.split("=", 2))
    .filter((entry): entry is [string, string] => entry.length === 2 && Boolean(entry[0])));
  const mainPid = Number.parseInt(fields.MainPID ?? "0", 10);
  return {
    activeState: fields.ActiveState ?? "unknown",
    subState: fields.SubState ?? "unknown",
    mainPid: Number.isSafeInteger(mainPid) && mainPid >= 0 ? mainPid : 0,
  };
}

function boundedOutput(value: string): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= MAX_ACTION_OUTPUT_BYTES) return value;
  return bytes.subarray(bytes.byteLength - MAX_ACTION_OUTPUT_BYTES).toString("utf8");
}

function requireSuccess(action: string, result: CommandResult): void {
  if (result.exitCode === 0) return;
  const detail = boundedOutput(result.stderr || result.stdout).trim();
  throw new Error(`${action} failed with exit code ${result.exitCode}${detail ? `: ${detail}` : ""}`);
}

async function defaultRun(executable: string, args: string[]): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: MAX_ACTION_OUTPUT_BYTES,
      windowsHide: true,
    });
    return { exitCode: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    const failure = error as Error & { code?: string | number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? failure.message),
    };
  }
}

async function defaultProbeReady(url: URL): Promise<RescueReadyStatus> {
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

export function createSystemdRescueActions(
  config: RescueActionConfig,
  dependencies: RescueActionDependencies = {},
): RescueActions {
  const run = dependencies.run ?? defaultRun;
  const probeReady = dependencies.probeReady ?? defaultProbeReady;
  const statusArgs = [
    "--user", "show", config.unit, "--no-pager",
    "--property=ActiveState", "--property=SubState", "--property=MainPID",
  ];

  const readStatus = async (): Promise<RescueServiceStatus> => {
    const result = await run("systemctl", statusArgs);
    requireSuccess("systemctl show", result);
    return parseSystemdStatus(result.stdout);
  };

  return {
    status: readStatus,
    ready: () => probeReady(config.readyUrl),
    async logs(lines: number) {
      if (!Number.isSafeInteger(lines) || lines < 1 || lines > MAX_RESCUE_LOG_LINES) {
        throw new RangeError(`rescue log lines must be between 1 and ${MAX_RESCUE_LOG_LINES}`);
      }
      const result = await run("journalctl", [
        "--user-unit", config.unit, "-n", String(lines), "--no-pager", "--output=short-iso",
      ]);
      requireSuccess("journalctl", result);
      return { lines, output: boundedOutput(result.stdout) };
    },
    async restart() {
      const result = await run("systemctl", ["--user", "restart", config.unit]);
      requireSuccess("systemctl restart", result);
      return { restarted: true as const, ...await readStatus() };
    },
  };
}

function parsePort(value: string | undefined): number {
  const port = value === undefined ? DEFAULT_RESCUE_PORT : Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("DEVSPACE_RESCUE_PORT must be an integer from 1 to 65535.");
  }
  return port;
}

function parseUnit(value: string | undefined): string {
  const unit = (value ?? DEFAULT_RESCUE_UNIT).trim();
  if (!/^[A-Za-z0-9_.@:-]+\.service$/.test(unit)) {
    throw new Error("DEVSPACE_RESCUE_UNIT must be one literal systemd .service unit name.");
  }
  return unit;
}

function parseLoopbackReadyUrl(value: string | undefined): URL {
  const url = new URL(value ?? DEFAULT_MAIN_READY_URL);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("DEVSPACE_RESCUE_READY_URL must be an http loopback URL.");
  }
  if (url.username || url.password) throw new Error("DEVSPACE_RESCUE_READY_URL must not contain credentials.");
  return url;
}

function parseOwnerToken(value: string | undefined): string {
  const token = value?.trim();
  if (!token || token.length < 16) {
    throw new Error("DEVSPACE_RESCUE_OWNER_TOKEN must contain at least 16 characters.");
  }
  return token;
}

function parsePublicBaseUrl(value: string | undefined, port: number): string {
  const url = new URL(value ?? `http://127.0.0.1:${port}`);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("DEVSPACE_RESCUE_PUBLIC_BASE_URL must use http or https.");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function parseAllowedRedirectHosts(value: string | undefined): string[] {
  const configured = value?.split(",").map(item => item.trim()).filter(Boolean) ?? [];
  return Array.from(new Set(["127.0.0.1", "localhost", ...configured]));
}

/** Rescue configuration is intentionally independent from main DevSpace config/state. */
export function loadRescueServerConfig(env: NodeJS.ProcessEnv = process.env): RescueServerConfig {
  const ownerToken = parseOwnerToken(env.DEVSPACE_RESCUE_OWNER_TOKEN);
  const unit = parseUnit(env.DEVSPACE_RESCUE_UNIT);
  const port = parsePort(env.DEVSPACE_RESCUE_PORT);
  const publicBaseUrl = parsePublicBaseUrl(env.DEVSPACE_RESCUE_PUBLIC_BASE_URL, port);
  const readyUrl = parseLoopbackReadyUrl(env.DEVSPACE_RESCUE_READY_URL);
  const stateDir = env.DEVSPACE_RESCUE_STATE_DIR?.trim()
    || join(homedir(), ".config", "devspace-rescue", "state");
  return {
    host: "127.0.0.1",
    port,
    publicBaseUrl,
    stateDir,
    unit,
    readyUrl,
    oauth: {
      ownerToken,
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 30 * 24 * 3600,
      ownerSessionTtlSeconds: 12 * 3600,
      scopes: ["devspace-rescue"],
      allowedRedirectHosts: parseAllowedRedirectHosts(env.DEVSPACE_RESCUE_ALLOWED_REDIRECT_HOSTS),
    },
  };
}
