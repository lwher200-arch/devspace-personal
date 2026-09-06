import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { createLocalAgentClient, type LocalAgentClient } from "./local-agent-client.js";
import { presentAgentObservation } from "./local-agent-presentation.js";
import type { LocalAgentRecord, LocalAgentWorkspaceScope } from "./local-agent-store.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import { canonicalAllowedPath } from "./roots.js";
import { resolveCodexCommand, type CodexCommandResolver } from "./local-agent-codex.js";
import { assertExecutionSelection, executionEvidenceSchema, type CodexExecutionPolicy } from "./local-agent-execution.js";

type AgentClient = Pick<LocalAgentClient, "start" | "continue" | "get" | "list">;
type WriteMode = "read_only" | "allowed";
type Receipt = { fingerprint: string; agent_id: string | null; state: string };

export class CodexBridge {
  private readonly database: DatabaseHandle;
  private readonly busyRoots = new Set<string>();

  constructor(
    private readonly config: ServerConfig,
    private readonly client: AgentClient = createLocalAgentClient(config),
    private readonly commandResolver: CodexCommandResolver = resolveCodexCommand,
  ) {
    this.database = openDatabase(join(config.stateDir, "codex-bridge"));
    this.database.sqlite.exec(`CREATE TABLE IF NOT EXISTS bridge_requests (
      request_hash TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      agent_id TEXT,
      state TEXT NOT NULL
    )`);
  }

  close(): void { this.database.close(); }

  preflight() {
    const command = this.commandResolver(process.env);
    const policy = this.config.bridge?.executionPolicy;
    if (policy) assertExecutionSelection(policy, policy.requiredModel, command?.version);
    if (!command?.version) throw new Error("Codex executable/version evidence is unavailable.");
    return { command, executionPolicy: policy, configuredProviderModel: this.config.subagents.providers.find(provider => provider.id === "codex")?.model,
      modelAvailabilityChecked: false, inferenceStarted: false,
      instruction: "This is executable/configuration preflight only. Use executionPolicy.requiredModel when present, not the informational provider default. Supply model explicitly on start/continue; the worker verifies its actual runtime, model availability and completed-turn evidence." };
  }

  async submit(scope: LocalAgentWorkspaceScope, input: {
    requestKey: string;
    prompt: string;
    writeMode: WriteMode;
    agentId?: string;
    model?: string;
  }) {
    const policy = this.config.bridge?.executionPolicy;
    if (policy && input.model !== policy.requiredModel) throw new Error(`Supply explicit model ${policy.requiredModel}; no inherited or fallback model is allowed.`);
    if (input.writeMode === "allowed" && !this.config.bridge?.allowWorkspaceWrite) {
      throw new Error("Workspace writes are disabled in the local bridge configuration.");
    }
    const physicalRoot = canonicalAllowedPath(scope.workspaceRoot);
    if (relative(physicalRoot, resolve(scope.workspaceRoot)) !== "") {
      throw new Error("Codex bridge requires a canonical workspace directory. Open its real path within the configured allowed roots.");
    }
    const key = digest(JSON.stringify([physicalRoot, input.requestKey]));
    const fingerprint = digest(JSON.stringify([input.agentId ?? null, input.prompt, input.writeMode,
      ...(input.model !== undefined || policy ? [input.model ?? null, policy ?? null] : [])]));
    const previous = this.receipt(key);
    if (previous) return this.replay(previous, fingerprint, scope);
    if (policy) this.preflight();
    if (this.busyRoots.has(physicalRoot)) {
      throw new Error("Another task is being submitted for this workspace. Retry with the same requestKey.");
    }
    this.busyRoots.add(physicalRoot);
    try {
      const active = await this.client.list({ workspaceRoot: scope.workspaceRoot });
      if (active.isErr()) throw new Error(active.error.message);
      if (active.value.some((task) => (task.status === "starting" || task.status === "running") &&
        canonicalAllowedPath(task.workspaceRoot) === physicalRoot)) {
        throw new Error("A task is already running in this workspace. Inspect it before submitting more work.");
      }
      if (input.agentId) {
        const existing = await this.client.get(input.agentId, scope);
        if (existing.isErr()) throw new Error(existing.error.message);
        if (existing.value.provider !== "codex") throw new Error("This is not a Codex task.");
      }
      // Claim before sending. A crash after delivery must not silently repeat a task.
      const claimed = this.database.sqlite.prepare(
        "INSERT OR IGNORE INTO bridge_requests (request_hash, fingerprint, state) VALUES (?, ?, 'pending')",
      ).run(key, fingerprint);
      if (!claimed.changes) return this.replay(this.receipt(key)!, fingerprint, scope);
      try {
        const result = input.agentId
          ? await this.client.continue(input.agentId, input.prompt, { writeMode: input.writeMode, model: input.model, executionPolicy: policy }, scope)
          : await this.client.start({
            target: "provider:codex", prompt: input.prompt, ...scope, writeMode: input.writeMode, model: input.model, executionPolicy: policy,
          });
        if (result.isErr()) throw new Error(result.error.message);
        this.database.sqlite.prepare(
          "UPDATE bridge_requests SET agent_id = ?, state = 'accepted' WHERE request_hash = ?",
        ).run(result.value.id, key);
        return observation(result.value, policy);
      } catch (error) {
        this.database.sqlite.prepare("UPDATE bridge_requests SET state = 'uncertain' WHERE request_hash = ?").run(key);
        throw new Error(`Task delivery could not be confirmed. Use codex_tasks to reconcile before retrying. ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    } finally { this.busyRoots.delete(physicalRoot); }
  }

  async status(scope: LocalAgentWorkspaceScope, id: string, waitSeconds = 0) {
    const deadline = Date.now() + Math.min(20, Math.max(0, waitSeconds)) * 1000;
    while (true) {
      const result = await this.client.get(id, scope);
      if (result.isErr()) throw new Error(result.error.message);
      if (result.value.provider !== "codex") throw new Error("This is not a Codex task.");
      const output = observation(result.value, this.config.bridge?.executionPolicy);
      if (output.status !== "running" || Date.now() >= deadline) return output;
      await delay(500);
    }
  }

  async list(scope: LocalAgentWorkspaceScope) {
    const result = await this.client.list(scope);
    if (result.isErr()) throw new Error(result.error.message);
    return { tasks: result.value.filter((task) => task.provider === "codex").slice(0, 50).map(task => observation(task, this.config.bridge?.executionPolicy)) };
  }

  private receipt(key: string): Receipt | undefined {
    return this.database.sqlite.prepare("SELECT fingerprint, agent_id, state FROM bridge_requests WHERE request_hash = ?")
      .get(key) as Receipt | undefined;
  }

  private async replay(receipt: Receipt, fingerprint: string, scope: LocalAgentWorkspaceScope) {
    if (receipt.fingerprint !== fingerprint) throw new Error("requestKey was already used for a different request.");
    if (!receipt.agent_id) throw new Error("Previous delivery is pending or uncertain. Use codex_tasks; do not automatically create another task.");
    return { ...await this.status({ workspaceRoot: scope.workspaceRoot }, receipt.agent_id), replayed: true };
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function observation(record: LocalAgentRecord, policy?: CodexExecutionPolicy) {
  const value = presentAgentObservation(record);
  if (policy && value.status === "completed") {
    try {
      const evidence = executionEvidenceSchema.parse(record.executionEvidence);
      assertExecutionSelection(policy, evidence.runtimeModel, evidence.cliVersion);
      if (evidence.requestedModel !== policy.requiredModel || evidence.sessionModel !== policy.requiredModel ||
        evidence.threadId !== record.providerSessionId || record.model !== policy.requiredModel) throw new Error();
    } catch {
      return { id: record.id, status: "failed" as const, requestedModel: record.model,
        error: { code: "MODEL_EVIDENCE_UNAVAILABLE", message: "Stored result has no matching approved runtime model evidence; historical/unverified output is withheld.", retryable: false },
        ...(record.providerSessionId ? { codexThreadId: record.providerSessionId } : {}), updatedAt: record.updatedAt };
    }
  }
  return {
    ...value,
    ...(record.model ? { requestedModel: record.model } : {}),
    ...(value.status === "completed" && value.response ? {
      response: value.response.slice(0, 24000),
      responseTruncated: value.response.length > 24000,
    } : {}),
    ...(record.providerSessionId ? { codexThreadId: record.providerSessionId } : {}),
    updatedAt: record.updatedAt,
  };
}

export function registerCodexBridgeTools(server: McpServer, workspaces: WorkspaceRegistry, bridge: CodexBridge): void {
  const scope = (workspaceId: string): LocalAgentWorkspaceScope => {
    const workspace = workspaces.getWorkspace(workspaceId);
    return { workspaceId: workspace.id, workspaceRoot: workspace.root };
  };
  const submission = {
    workspaceId: z.string().min(1),
    requestKey: z.string().min(1).max(160).describe("Unique key for this user-requested task or follow-up; reuse exactly on transport retries."),
    prompt: z.string().trim().min(1).max(16000),
    model: z.string().trim().min(1).max(128).optional()
      .describe("Explicit Codex model for this turn. Required when the server has an execution policy, including continuations. Never infer it from the Chat model or a historical session."),
    writeMode: z.enum(["read_only", "allowed"]).default("read_only")
      .describe("Default read_only. Use allowed only when the user asked Codex to modify this workspace. Full-access is never available."),
  };
  const respond = async (run: () => Promise<unknown>) => {
    try {
      const result = await run();
      const text = JSON.stringify(result);
      return { content: [{ type: "text" as const, text }], structuredContent: { result: text } };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Codex bridge failed" }] };
    }
  };
  server.registerTool("codex_preflight", {
    description: "Inspect the resolved Codex executable/version and server model policy without starting inference. Does not prove account model access or runtime execution. Run before a programming handoff.",
    inputSchema: { workspaceId: z.string() }, outputSchema: { result: z.string() }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ workspaceId }) => respond(async () => { scope(workspaceId); return bridge.preflight(); }));
  server.registerTool("codex_task_start", {
    description: "Start one user-requested task in local Codex. Returns a durable task ID immediately. Then use codex_task_status to obtain the result and return it to this conversation. Never start an autonomous conversation loop.",
    inputSchema: submission,
    outputSchema: { result: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, ({ workspaceId, ...input }) => respond(() => bridge.submit(scope(workspaceId), input)));
  server.registerTool("codex_task_continue", {
    description: "Give an existing Codex task one explicit follow-up, preserving its context. Wait for the previous turn to complete. Use a new requestKey for each new follow-up, not for transport retries.",
    inputSchema: { ...submission, agentId: z.string().min(1).max(160) },
    outputSchema: { result: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, ({ workspaceId, ...input }) => respond(() => bridge.submit(scope(workspaceId), input)));
  server.registerTool("codex_task_status", {
    description: "Read a Codex task result. Bounded wait up to 20 seconds. Report failed/stopped states honestly; do not treat an accepted task as completed work.",
    inputSchema: { workspaceId: z.string(), agentId: z.string(), waitSeconds: z.number().int().min(0).max(20).default(0) },
    outputSchema: { result: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ workspaceId, agentId, waitSeconds }) => respond(() => bridge.status(scope(workspaceId), agentId, waitSeconds)));
  server.registerTool("codex_tasks", {
    description: "Recover the latest local Codex task IDs and results for this workspace after reconnecting. Never access tasks from an unrelated workspace.",
    inputSchema: { workspaceId: z.string() },
    outputSchema: { result: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ workspaceId }) => respond(() => bridge.list(scope(workspaceId))));
}
