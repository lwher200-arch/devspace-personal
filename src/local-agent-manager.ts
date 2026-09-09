import { resolve } from "node:path";
import { localAgentTokenUsageSchema } from "./local-agent-usage.js";
import { Result, type Result as BetterResult } from "better-result";
import {
  AgentConflictError,
  AgentScopeError,
  AgentStoreError,
  AgentTargetError,
  isLocalAgentError,
  isProgrammerDefect,
  type LocalAgentError,
} from "./local-agent-errors.js";
import {
  type LocalAgentProfile,
  type LocalAgentProvider,
  isLocalAgentProvider,
} from "./local-agent-profiles.js";
import {
  resolveLocalAgentTarget,
} from "./local-agent-targets.js";
import {
  type LocalAgentRecord,
  type LocalAgentStore,
  type LocalAgentWorkspaceScope,
} from "./local-agent-store.js";
import {
  type LocalAgentDriver,
  type LocalAgentRunCallbacks,
  type LocalAgentRunInput,
  type LocalAgentRuntimeContext,
  type LocalAgentWriteMode,
} from "./local-agent-runtime.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import { assertAllowedPath } from "./roots.js";
import { assertExecutionSelection, executionEvidenceSchema, executionPolicySchema, approvedModels, selectExecutionModel, sameExecutionPolicy, type CodexExecutionPolicy } from "./local-agent-execution.js";
import {
  isSubagentProviderEnabled,
  type SubagentsConfig,
} from "./local-agent-config.js";

export interface StartLocalAgentInput {
  target: string;
  prompt: string;
  workspaceRoot: string;
  workspaceId?: string;
  model?: string;
  effort?: string;
  writeMode?: LocalAgentWriteMode;
  executionPolicy?: CodexExecutionPolicy;
}

export interface RunOverrides {
  model?: string;
  effort?: string;
  writeMode?: LocalAgentWriteMode;
  executionPolicy?: CodexExecutionPolicy;
}

export interface LocalAgentManagerLogger {
  (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void;
}

export interface LocalAgentManagerOptions {
  store: LocalAgentStore;
  drivers: readonly LocalAgentDriver[];
  pool: LocalAgentRuntimePool;
  loadProfiles: (workspaceRoot: string) => Promise<LocalAgentProfile[]>;
  agentDir?: string;
  allowedRoots?: readonly string[];
  logger?: LocalAgentManagerLogger;
  subagents: SubagentsConfig;
  codexExecutionPolicy?: CodexExecutionPolicy;
}

export type AgentStartError = AgentTargetError | AgentScopeError | AgentConflictError | AgentStoreError;
export type AgentContinueError = AgentStartError;
export type AgentLookupError = AgentTargetError | AgentScopeError | AgentStoreError;
export type AgentListError = AgentScopeError | AgentStoreError;

/**
 * Owns one durable DevSpace agent's turn lifecycle. Provider runtimes remain
 * below this seam; this class only translates records into provider inputs and
 * persists the result.
 */
export class LocalAgentManager {
  private readonly store: LocalAgentStore;
  private readonly drivers = new Map<LocalAgentProvider, LocalAgentDriver>();
  private readonly pool: LocalAgentRuntimePool;
  private readonly loadProfiles: (workspaceRoot: string) => Promise<LocalAgentProfile[]>;
  private readonly agentDir?: string;
  private readonly allowedRoots?: readonly string[];
  private readonly logger?: LocalAgentManagerLogger;
  private readonly subagents: SubagentsConfig;
  private readonly codexExecutionPolicy?: CodexExecutionPolicy;
  private readonly activeTurns = new Map<string, Promise<void>>();
  private accepting = true;
  private closePromise?: Promise<void>;

  constructor(options: LocalAgentManagerOptions) {
    this.store = options.store;
    for (const driver of options.drivers) this.drivers.set(driver.provider, driver);
    this.pool = options.pool;
    this.loadProfiles = options.loadProfiles;
    this.agentDir = options.agentDir;
    this.allowedRoots = options.allowedRoots;
    this.logger = options.logger;
    this.subagents = options.subagents;
    this.codexExecutionPolicy = options.codexExecutionPolicy;
  }

  reconcileActiveRuns(message?: string): BetterResult<number, AgentStoreError> {
    return this.store.reconcileActiveRunsResult(message);
  }

  async start(input: StartLocalAgentInput): Promise<BetterResult<LocalAgentRecord, AgentStartError>> {
    const manager = this;
    return Result.gen(async function* () {
      yield* manager.acceptingResult("start");
      const workspaceRoot = yield* manager.authorizeWorkspace(
        input.workspaceRoot,
        input.workspaceId,
        "start",
      );
      const profiles = yield* Result.await(manager.loadProfilesResult(workspaceRoot, input.target));
      const target = resolveLocalAgentTarget(
        input.target,
        profiles,
        input.model,
        input.effort,
        manager.subagents.providers,
      );
      if (!target) {
        return Result.err(new AgentTargetError({
          code: "UNKNOWN_TARGET",
          target: input.target,
          retryable: false,
          message: `Unknown subagent profile or provider: ${input.target}.`,
        }));
      }
      if (target.kind === "profile" && target.profile.disabled) {
        return Result.err(new AgentTargetError({
          code: "PROVIDER_DISABLED",
          target: target.name,
          provider: target.provider,
          retryable: false,
          message: `Subagent profile is disabled: ${target.name}.`,
        }));
      }
      yield* manager.providerEnabledResult(target.provider, target.name, "start");
      const serverPolicy = target.provider === "codex" && input.workspaceId ? manager.codexExecutionPolicy : undefined;
      const executionPolicy = serverPolicy ?? input.executionPolicy;
      if (serverPolicy && input.executionPolicy && !sameExecutionPolicy(serverPolicy, input.executionPolicy)) {
        return Result.err(new AgentTargetError({ code: "TARGET_RESOLUTION_FAILED", target: input.target,
          retryable: false, message: "The MCP Codex execution policy cannot be overridden." }));
      }
      const selected = yield* manager.modelSelectionResult(executionPolicy, input.model, input.prompt);
      if (selected) { input = { ...input, model: selected }; target.model = selected; }
      yield* manager.executionPolicyResult(target.provider, executionPolicy, input.model);
      yield* manager.driverResult(target.provider, "start");
      const record = yield* manager.store.createResult({
        workspaceId: input.workspaceId,
        workspaceRoot,
        // Older records cannot distinguish a profile named after its provider.
        // Only collisions need a tag; ordinary durable targets keep their shape.
        profileName: target.kind === "profile" && target.name === target.provider
          ? `profile:${target.name}`
          : target.kind === "provider" && profiles.some((profile) => profile.name === target.provider)
            ? `provider:${target.provider}`
            : target.name,
        provider: target.provider,
        model: target.model,
        effort: target.effort,
        executionPolicy,
      });
      return manager.begin(record, input.prompt, {
        model: target.model,
        effort: target.effort,
        writeMode: input.writeMode,
        executionPolicy,
      }, input.workspaceId);
    });
  }

  async continue(
    agentId: string,
    prompt: string,
    overrides: RunOverrides = {},
    scope: LocalAgentWorkspaceScope,
  ): Promise<BetterResult<LocalAgentRecord, AgentContinueError>> {
    const manager = this;
    return Result.gen(async function* () {
      yield* manager.acceptingResult("continue", agentId);
      const record = yield* manager.store.getByIdResult(agentId);
      if (!record) return Result.err(agentNotFound(agentId));
      yield* manager.agentWorkspaceResult(record, scope, "continue");
      const profiles = yield* Result.await(manager.loadProfilesResult(record.workspaceRoot, record.profileName));
      yield* manager.profileForRecordResult(record, profiles);
      yield* manager.providerEnabledResult(record.provider, record.profileName, "continue");
      yield* manager.driverResult(record.provider, "continue", agentId);
      const serverPolicy = record.provider === "codex" && scope.workspaceId ? manager.codexExecutionPolicy : undefined;
      if (serverPolicy && overrides.executionPolicy && !sameExecutionPolicy(serverPolicy, overrides.executionPolicy)) {
        return Result.err(new AgentTargetError({ code: "TARGET_RESOLUTION_FAILED", target: record.profileName,
          retryable: false, message: "The MCP Codex execution policy cannot be overridden." }));
      }
      overrides = { ...overrides, executionPolicy: serverPolicy ?? overrides.executionPolicy };
      if (record.executionPolicy && overrides.executionPolicy &&
        !sameExecutionPolicy(record.executionPolicy, overrides.executionPolicy)) {
        return Result.err(new AgentTargetError({ code: "TARGET_RESOLUTION_FAILED", target: record.profileName,
          retryable: false, message: "A stored execution policy cannot be replaced or weakened." }));
      }
      const selected = yield* manager.modelSelectionResult(record.executionPolicy ?? overrides.executionPolicy, overrides.model, prompt);
      if (selected) overrides = { ...overrides, model: selected };
      yield* manager.executionPolicyResult(record.provider, record.executionPolicy ?? overrides.executionPolicy, overrides.model);
      return manager.begin(record, prompt, overrides, scope.workspaceId);
    });
  }

  get(
    agentId: string,
    scope: LocalAgentWorkspaceScope,
  ): BetterResult<LocalAgentRecord, AgentLookupError> {
    const lookup = this.store.getByIdResult(agentId);
    if (lookup.isErr()) return lookup;
    const record = lookup.value;
    if (!record) return Result.err(agentNotFound(agentId));
    const scoped = this.agentWorkspaceResult(record, scope, "get");
    if (scoped.isErr()) return scoped;
    return Result.ok(record);
  }

  list(scope: LocalAgentWorkspaceScope): BetterResult<LocalAgentRecord[], AgentListError> {
    return this.authorizeWorkspace(scope.workspaceRoot, scope.workspaceId, "list").andThen((workspaceRoot) => (
      this.store.listResult({
        workspaceId: scope.workspaceId,
        workspaceRoot,
      })
    ));
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.accepting = false;
    const turns = Array.from(this.activeTurns.values());
    this.closePromise = (async () => {
      // Closing pooled runtimes is what interrupts provider turns. Waiting for
      // those turns first can strand a provider process indefinitely.
      await this.pool.close();
      const turnResults = await Promise.allSettled(turns);
      for (const result of turnResults) {
        if (result.status === "rejected") {
          this.log("warn", "local_agent_close_failed", { error: errorMessage(result.reason) });
        }
      }
      this.store.close();
    })();
    return this.closePromise;
  }

  get activeTurnCount(): number {
    return this.activeTurns.size;
  }

  get runtimeCount(): number {
    return this.pool.size;
  }

  async evictIdle(now?: number): Promise<void> {
    await this.pool.evictIdle(now);
  }

  private begin(
    record: LocalAgentRecord,
    prompt: string,
    overrides: RunOverrides,
    workspaceId?: string,
  ): BetterResult<LocalAgentRecord, AgentConflictError | AgentStoreError> {
    if (this.activeTurns.has(record.id)) {
      return Result.err(new AgentConflictError({
        code: "AGENT_CONFLICT",
        agentId: record.id,
        operation: "continue",
        retryable: true,
        message: `Agent ${record.id} already has a running turn.`,
      }));
    }

    const updated = this.store.updateResult(record.id, {
      status: "running",
      model: overrides.model ?? record.model,
      effort: overrides.effort ?? record.effort,
      latestResponse: undefined,
      executionPolicy: record.executionPolicy ?? overrides.executionPolicy,
      executionEvidence: undefined,
      error: undefined,
      errorCode: undefined,
      errorRetryable: undefined,
    });
    if (updated.isErr()) return updated;
    // Defer invocation until after the tracking entry is visible. This keeps
    // cleanup correct even if runTurn later gains a synchronous completion path.
    const turn = Promise.resolve().then(() => (
      this.runTurn(updated.value, prompt, overrides, workspaceId)
    ));
    this.activeTurns.set(record.id, turn);
    void turn.catch(() => undefined);
    return updated;
  }

  private async runTurn(
    record: LocalAgentRecord,
    prompt: string,
    overrides: RunOverrides,
    workspaceId?: string,
  ): Promise<void> {
    const startedAt = Date.now();
    this.log("info", "agent_run_started", {
      provider: record.provider,
      agentId: record.id,
      providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
    });
    try {
      const authorized = this.authorizeWorkspace(record.workspaceRoot, workspaceId, "run");
      if (authorized.isErr()) {
        this.persistRunError(record, authorized.error, startedAt);
        return;
      }
      const workspaceRoot = authorized.value;
      const authorizedRecord = workspaceRoot === record.workspaceRoot
        ? record
        : { ...record, workspaceRoot };
      const profiles = await this.loadProfilesResult(workspaceRoot, record.profileName);
      if (profiles.isErr()) {
        this.persistRunError(record, profiles.error, startedAt);
        return;
      }
      const profile = this.profileForRecordResult(record, profiles.value);
      if (profile.isErr()) {
        this.persistRunError(record, profile.error, startedAt);
        return;
      }
      const input = this.buildRunInputResult(authorizedRecord, profile.value, prompt, overrides);
      if (input.isErr()) {
        this.persistRunError(record, input.error, startedAt);
        return;
      }
      const driver = this.driverResult(record.provider, "run", record.id);
      if (driver.isErr()) {
        this.persistRunError(record, driver.error, startedAt);
        return;
      }
      const context: LocalAgentRuntimeContext = {
        agentId: record.id,
        provider: driver.value.provider,
        workspaceRoot,
        providerSessionId: record.providerSessionId,
        writeMode: input.value.writeMode,
        executionPolicy: input.value.executionPolicy,
        model: input.value.model,
        effort: input.value.effort,
        agentDir: this.agentDir,
      };
      const callbacks: LocalAgentRunCallbacks = {
        onUsage: (usage) => {
          const parsed = localAgentTokenUsageSchema.safeParse(usage);
          if (!parsed.success) return;
          const current = this.store.getByIdResult(record.id);
          if (current.isErr()) throw current.error;
          if (!current.value || current.value.providerSessionId !== parsed.data.threadId) return;
          const updated = this.store.updateResult(record.id, { usage: parsed.data });
          if (updated.isErr()) throw updated.error;
        },
        onSessionId: (providerSessionId) => {
          const current = this.store.getByIdResult(record.id);
          if (current.isErr()) throw current.error;
          if (!current.value || current.value.providerSessionId === providerSessionId) return;
          const updated = this.store.updateResult(record.id, { providerSessionId });
          if (updated.isErr()) throw updated.error;
        },
      };
      const result = await this.pool.run(driver.value, context, input.value, callbacks);
      if (result.isErr()) {
        this.persistRunError(record, result.error, startedAt);
        return;
      }
      const runResult = result.value;
      if (input.value.executionPolicy) {
        try {
          const evidence = executionEvidenceSchema.parse(runResult.executionEvidence);
          assertExecutionSelection(input.value.executionPolicy, evidence.runtimeModel, evidence.cliVersion);
          if (evidence.requestedModel !== input.value.model || evidence.sessionModel !== input.value.model || evidence.runtimeModel !== input.value.model ||
            evidence.threadId !== runResult.providerSessionId || evidence.sandbox !== (input.value.writeMode === "allowed" ? "workspaceWrite" : "readOnly")) {
            throw new Error("Execution evidence does not match the requested turn.");
          }
        } catch {
          this.persistRunError(record, new AgentTargetError({ code: "TARGET_RESOLUTION_FAILED", target: record.profileName,
            retryable: false, message: "Provider result has no matching verified model evidence; result rejected." }), startedAt);
          return;
        }
      }
      const current = this.store.getByIdResult(record.id);
      if (current.isErr()) throw current.error;
      if (!current.value) return;
      const updated = this.store.updateResult(record.id, {
        providerSessionId: runResult.providerSessionId ?? current.value.providerSessionId,
        status: "idle",
        latestResponse: runResult.finalResponse,
        executionEvidence: runResult.executionEvidence,
        ...(runResult.usage === undefined ? {} : { usage: runResult.usage }),
        error: undefined,
        errorCode: undefined,
        errorRetryable: undefined,
      });
      if (updated.isErr()) throw updated.error;
      this.log("info", "agent_run_completed", {
        provider: updated.value.provider,
        agentId: updated.value.id,
        providerSessionIdPrefix: updated.value.providerSessionId?.slice(0, 8),
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    } catch (error) {
      if (isLocalAgentError(error)) {
        this.persistRunError(record, error, startedAt);
        return;
      }
      const persisted = this.store.updateResult(record.id, {
        status: "error",
        error: "Unexpected internal subagent failure.",
        errorCode: "AGENT_INTERNAL_ERROR",
        errorRetryable: false,
      });
      this.log("error", "agent_run_failed", {
        provider: record.provider,
        agentId: record.id,
        providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
        durationMs: Math.max(0, Date.now() - startedAt),
        error: "Unexpected internal subagent failure.",
        errorType: error instanceof Error ? error.name : typeof error,
        persistenceFailed: persisted.isErr(),
      });
      throw error;
    } finally {
      this.activeTurns.delete(record.id);
    }
  }

  private persistRunError(
    record: LocalAgentRecord,
    error: LocalAgentError,
    startedAt: number,
  ): void {
    const persisted = this.store.updateResult(record.id, {
      status: "error",
      error: error.message,
      errorCode: error.code,
      errorRetryable: error.retryable,
    });
    this.log("error", "agent_run_failed", {
      provider: record.provider,
      agentId: record.id,
      providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
      durationMs: Math.max(0, Date.now() - startedAt),
      errorCode: error.code,
      error: error.message,
      causeType: safeCauseType("cause" in error ? error.cause : undefined),
      persistenceFailed: persisted.isErr(),
    });
  }

  private buildRunInputResult(
    record: LocalAgentRecord,
    profile: LocalAgentProfile | undefined,
    prompt: string,
    overrides: RunOverrides,
  ): BetterResult<LocalAgentRunInput, AgentTargetError> {
    const isRawProvider = record.profileName === record.provider
      || record.profileName === `provider:${record.provider}`;
    if (!profile && !isRawProvider) {
      return Result.err(new AgentTargetError({
        code: "UNKNOWN_TARGET",
        target: record.profileName,
        provider: isLocalAgentProvider(record.provider) ? record.provider : undefined,
        retryable: false,
        message: `Subagent profile not found: ${record.profileName}.`,
      }));
    }
    const body = profile?.body.trim();
    const fullPrompt = body ? `${body}\n\nTask:\n${prompt}` : prompt;
    return Result.ok({
      prompt: fullPrompt,
      workspaceRoot: record.workspaceRoot,
      providerSessionId: record.providerSessionId,
      // A profile is an authority ceiling, including on resumed provider sessions.
      // Omitted profile policy retains the existing per-turn override behavior.
      writeMode: profile?.writeMode === "read_only" || overrides.writeMode === "read_only"
        ? "read_only"
        : profile?.writeMode ?? overrides.writeMode ?? "allowed",
      model: record.model ?? profile?.model,
      effort: record.effort ?? profile?.effort,
      modelOverrideRequested: overrides.model !== undefined,
      effortOverrideRequested: overrides.effort !== undefined,
      executionPolicy: record.executionPolicy ?? overrides.executionPolicy,
    });
  }

  private executionPolicyResult(provider: string, policy: CodexExecutionPolicy | undefined, model: string | undefined): BetterResult<void, AgentTargetError> {
    if (!policy) return Result.ok(undefined);
    try {
      executionPolicySchema.parse(policy);
      if (provider !== "codex" || !model || !approvedModels(policy).includes(model)) throw new Error();
      return Result.ok(undefined);
    } catch {
      return Result.err(new AgentTargetError({ code: "TARGET_RESOLUTION_FAILED", target: provider,
        retryable: false, message: `Execution policy requires an explicit Codex model ${policy.requiredModel} on every start and continuation.` }));
    }
  }

  private modelSelectionResult(policy: CodexExecutionPolicy | undefined, model: string | undefined, prompt: string): BetterResult<string | undefined, AgentTargetError> {
    try { return Result.ok(policy ? selectExecutionModel(policy, model, prompt).model : model); }
    catch (error) { return Result.err(new AgentTargetError({ code: 'TARGET_RESOLUTION_FAILED', target: 'codex', retryable: false,
      message: error instanceof Error ? error.message : 'Model selection failed.' })); }
  }

  private profileForRecordResult(
    record: LocalAgentRecord,
    profiles: readonly LocalAgentProfile[],
  ): BetterResult<LocalAgentProfile | undefined, AgentTargetError> {
    if (record.profileName === `provider:${record.provider}`) return Result.ok(undefined);
    const taggedProfile = record.profileName === `profile:${record.provider}`;
    const profileName = taggedProfile ? record.provider : record.profileName;
    const profile = profiles.find((candidate) => candidate.name === profileName);
    if ((record.profileName === record.provider && profile)
      || (taggedProfile && profiles.some((candidate) => candidate.name === record.profileName))) {
      return Result.err(new AgentTargetError({
        code: "TARGET_RESOLUTION_FAILED",
        target: record.profileName,
        provider: isLocalAgentProvider(record.provider) ? record.provider : undefined,
        retryable: false,
        message: `Subagent target is ambiguous: ${record.profileName}. Create a new agent using a uniquely named profile or an explicit provider target; the existing record is preserved.`,
      }));
    }
    if (record.profileName === record.provider) return Result.ok(undefined);
    if (!profile) {
      return Result.err(new AgentTargetError({
        code: "UNKNOWN_TARGET",
        target: record.profileName,
        provider: isLocalAgentProvider(record.provider) ? record.provider : undefined,
        retryable: false,
        message: `Subagent profile not found: ${record.profileName}.`,
      }));
    }
    if (profile.disabled) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_DISABLED",
        target: profile.name,
        provider: profile.provider,
        retryable: false,
        message: `Subagent profile is disabled: ${profile.name}.`,
      }));
    }
    return Result.ok(profile);
  }

  private driverResult(
    provider: string,
    operation: string,
    agentId?: string,
  ): BetterResult<LocalAgentDriver, AgentTargetError> {
    if (!isLocalAgentProvider(provider)) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_NOT_CONFIGURED",
        target: provider,
        operation,
        retryable: false,
        message: `No local agent driver is configured for provider: ${provider}.`,
      }));
    }
    const driver = this.drivers.get(provider);
    if (!driver) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_NOT_CONFIGURED",
        target: agentId ?? provider,
        provider,
        operation,
        retryable: false,
        message: `No local agent driver is configured for provider: ${provider}.`,
      }));
    }
    return Result.ok(driver);
  }

  private providerEnabledResult(
    provider: string,
    target: string,
    operation: string,
  ): BetterResult<void, AgentTargetError> {
    if (!isLocalAgentProvider(provider)) return Result.ok(undefined);
    if (isSubagentProviderEnabled(this.subagents, provider)) return Result.ok(undefined);
    return Result.err(new AgentTargetError({
      code: "PROVIDER_DISABLED",
      target,
      provider,
      operation,
      retryable: false,
      message: `Subagent provider is disabled: ${provider}.`,
    }));
  }

  private acceptingResult(
    operation: string,
    agentId?: string,
  ): BetterResult<void, AgentConflictError> {
    if (this.accepting) return Result.ok(undefined);
    return Result.err(new AgentConflictError({
      code: "AGENT_CONFLICT",
      agentId,
      operation,
      retryable: false,
      message: "Local agent manager is closed.",
    }));
  }

  private authorizeWorkspace(
    workspaceRoot: string,
    workspaceId: string | undefined,
    operation: string,
  ): BetterResult<string, AgentScopeError> {
    const normalized = resolve(workspaceRoot);
    if (!workspaceId || !this.allowedRoots) return Result.ok(normalized);
    try {
      return Result.ok(assertAllowedPath(normalized, [...this.allowedRoots]));
    } catch (cause) {
      return Result.err(new AgentScopeError({
        code: "WORKSPACE_NOT_ALLOWED",
        operation,
        retryable: false,
        cause,
        message: "Workspace root is outside configured allowed roots.",
      }));
    }
  }

  private agentWorkspaceResult(
    record: LocalAgentRecord,
    scope: LocalAgentWorkspaceScope,
    operation: string,
  ): BetterResult<void, AgentScopeError> {
    const workspaceRoot = this.authorizeWorkspace(scope.workspaceRoot, scope.workspaceId, operation);
    if (workspaceRoot.isErr()) return workspaceRoot;
    const idMismatch = scope.workspaceId !== undefined && record.workspaceId !== scope.workspaceId;
    if (workspaceRoot.value !== record.workspaceRoot || idMismatch) {
      return Result.err(new AgentScopeError({
        code: "WORKSPACE_MISMATCH",
        agentId: record.id,
        workspaceId: scope.workspaceId,
        operation,
        retryable: false,
        message: `Subagent ${record.id} belongs to a different workspace.`,
      }));
    }
    return Result.ok(undefined);
  }

  private async loadProfilesResult(
    workspaceRoot: string,
    target: string,
  ): Promise<BetterResult<LocalAgentProfile[], AgentTargetError>> {
    try {
      return Result.ok(await this.loadProfiles(workspaceRoot));
    } catch (cause) {
      if (isProgrammerDefect(cause)) throw cause;
      return Result.err(new AgentTargetError({
        code: "TARGET_RESOLUTION_FAILED",
        target,
        retryable: false,
        cause,
        message: "Unable to load subagent profiles.",
      }));
    }
  }

  private log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>,
  ): void {
    this.logger?.(level, event, fields);
  }
}

export function createLocalAgentManager(options: LocalAgentManagerOptions): LocalAgentManager {
  return new LocalAgentManager(options);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeCauseType(cause: unknown): string | undefined {
  if (cause instanceof Error) return cause.name;
  if (cause && typeof cause === "object" && "error" in cause) {
    const nested = (cause as { error?: unknown }).error;
    if (nested instanceof Error) return nested.name;
  }
  return cause === undefined ? undefined : typeof cause;
}

function agentNotFound(agentId: string): AgentTargetError {
  return new AgentTargetError({
    code: "AGENT_NOT_FOUND",
    target: agentId,
    retryable: false,
    message: `Unknown subagent id: ${agentId}.`,
  });
}
