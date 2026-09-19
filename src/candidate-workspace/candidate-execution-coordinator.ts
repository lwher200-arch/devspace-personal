import { randomBytes, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProcessSnapshot } from "../process-sessions.js";
import {
  type WorkspaceLeaseRuntime,
  type WorkspaceLeaseRuntimeObservation,
} from "../workspace-lease/workspace-lease-runtime.js";
import {
  type CandidateMutationSet,
  type CandidateWorkspace,
  type CandidateWorkspaceCapability,
  type CandidateWorkspaceProvider,
} from "./candidate-workspace.js";

export const A2_CANDIDATE_GRANT_META_KEY = "devspace/a2CandidateGrant";
export const A2_CANDIDATE_NETWORK_PROFILE = "none" as const;

export type CandidateExecutionTool = "exec_command" | "bash" | "run_process";

export interface CandidateExecutionAuthorizationInput {
  clientId: string;
  conversationScopeId?: string;
  workspaceId: string;
  stableRoot: string;
  tool: CandidateExecutionTool;
}

export interface CandidateExecutionAuthorization {
  observation: WorkspaceLeaseRuntimeObservation;
  capability: CandidateWorkspaceCapability;
  grantToken?: string;
}

export interface CandidateExecutionPlan {
  candidate: CandidateWorkspace;
  workspaceId: string;
  tool: CandidateExecutionTool;
  workspaceRoot: string;
  cwd: string;
  networkProfile: typeof A2_CANDIDATE_NETWORK_PROFILE;
}

export interface CandidateExecutionEvidence {
  candidateId: string;
  profile: string;
  networkProfile: typeof A2_CANDIDATE_NETWORK_PROFILE;
  state: "running" | "completed";
  mutation?: CandidateMutationEvidence;
}

export interface CandidateMutationEvidence {
  created: string[];
  modified: string[];
  deleted: string[];
  createdCount: number;
  modifiedCount: number;
  deletedCount: number;
  changedBytes: number;
  stableChanged: boolean;
  pathListTruncated: boolean;
}

interface CandidateGrant {
  token: string;
  clientId: string;
  conversationScopeId?: string;
  workspaceId: string;
  stableRoot: string;
  tool: CandidateExecutionTool;
  expiresAt: number;
}

interface SessionBinding {
  plan: CandidateExecutionPlan;
}

export class CandidateExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateExecutionError";
  }
}

export class CandidateExecutionCoordinator {
  private readonly grants = new Map<string, CandidateGrant>();
  private readonly sessions = new Map<string, SessionBinding>();
  private closed = false;

  constructor(
    private readonly leaseRuntime: WorkspaceLeaseRuntime,
    private readonly provider: CandidateWorkspaceProvider,
    private readonly boundaryProfile: string | undefined,
    private readonly options: { now?: () => number; grantTtlMs?: number } = {},
  ) {}

  async authorizeRequest(
    input: CandidateExecutionAuthorizationInput,
  ): Promise<CandidateExecutionAuthorization> {
    if (this.closed) throw new CandidateExecutionError("Candidate execution coordinator is closed.");
    this.pruneGrants();
    const capability = await this.provider.probe(input.stableRoot);
    const observation = this.leaseRuntime.observe({
      clientId: input.clientId,
      conversationScopeId: input.conversationScopeId,
      workspaceRoot: input.stableRoot,
      boundaryProfile: this.boundaryProfile,
      candidateAvailable: capability.available,
    });
    if (!observation.executionEligible) return { observation, capability };

    const token = randomBytes(32).toString("base64url");
    const grant: CandidateGrant = {
      token,
      clientId: input.clientId,
      conversationScopeId: input.conversationScopeId,
      workspaceId: input.workspaceId,
      stableRoot: resolve(input.stableRoot),
      tool: input.tool,
      expiresAt: this.now() + (this.options.grantTtlMs ?? 60_000),
    };
    this.grants.set(token, grant);
    return { observation, capability, grantToken: token };
  }

  async beginGrantedExecution(input: {
    grantToken?: string;
    workspaceId: string;
    stableRoot: string;
    stableCwd: string;
    tool: CandidateExecutionTool;
  }): Promise<CandidateExecutionPlan | undefined> {
    if (!input.grantToken) return undefined;
    if (this.closed) throw new CandidateExecutionError("Candidate execution coordinator is closed.");
    this.pruneGrants();
    const grant = this.grants.get(input.grantToken);
    this.grants.delete(input.grantToken);
    if (!grant) throw new CandidateExecutionError("Candidate execution grant is unavailable or expired.");
    if (
      grant.workspaceId !== input.workspaceId ||
      grant.tool !== input.tool ||
      grant.stableRoot !== resolve(input.stableRoot)
    ) {
      throw new CandidateExecutionError("Candidate execution grant does not match this workspace/tool request.");
    }

    const capability = await this.provider.probe(input.stableRoot);
    const observation = this.leaseRuntime.observe({
      clientId: grant.clientId,
      conversationScopeId: grant.conversationScopeId,
      workspaceRoot: input.stableRoot,
      boundaryProfile: this.boundaryProfile,
      candidateAvailable: capability.available,
    });
    if (!observation.executionEligible) {
      throw new CandidateExecutionError(
        `Candidate execution authorization is no longer valid: ${observation.reason}.`,
      );
    }

    const stableRoot = resolve(input.stableRoot);
    const stableCwd = resolve(input.stableCwd);
    const tail = relative(stableRoot, stableCwd);
    if (tail === ".." || tail.startsWith(`..${sep}`) || isAbsolute(tail)) {
      throw new CandidateExecutionError("Candidate execution working directory is outside Stable Workspace.");
    }

    const candidate = await this.provider.create(stableRoot, randomUUID());
    return {
      candidate,
      workspaceId: input.workspaceId,
      tool: input.tool,
      workspaceRoot: candidate.root,
      cwd: tail ? join(candidate.root, tail) : candidate.root,
      networkProfile: A2_CANDIDATE_NETWORK_PROFILE,
    };
  }

  async observeSnapshot(
    plan: CandidateExecutionPlan,
    snapshot: ProcessSnapshot,
  ): Promise<CandidateExecutionEvidence> {
    if (snapshot.running) {
      if (!snapshot.sessionId) {
        throw new CandidateExecutionError("Running candidate process did not expose a session identifier.");
      }
      this.sessions.set(this.sessionKey(plan.workspaceId, snapshot.sessionId), { plan });
      return this.runningEvidence(plan);
    }
    return this.completedEvidence(plan);
  }

  async observeSession(
    workspaceId: string,
    sessionId: number,
    snapshot: ProcessSnapshot,
  ): Promise<CandidateExecutionEvidence | undefined> {
    const key = this.sessionKey(workspaceId, sessionId);
    const binding = this.sessions.get(key);
    if (!binding) return undefined;
    if (snapshot.running) return this.runningEvidence(binding.plan);
    const evidence = await this.completedEvidence(binding.plan);
    this.sessions.delete(key);
    return evidence;
  }

  async abandon(plan: CandidateExecutionPlan): Promise<void> {
    for (const [key, binding] of this.sessions) {
      if (binding.plan.candidate.id === plan.candidate.id) this.sessions.delete(key);
    }
    await this.provider.discard(plan.candidate);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.grants.clear();
    this.sessions.clear();
    await this.provider.close();
  }

  private async completedEvidence(
    plan: CandidateExecutionPlan,
  ): Promise<CandidateExecutionEvidence> {
    return {
      candidateId: plan.candidate.id,
      profile: plan.candidate.profile,
      networkProfile: plan.networkProfile,
      state: "completed",
      mutation: summarizeMutation(await this.provider.inspect(plan.candidate)),
    };
  }

  private runningEvidence(plan: CandidateExecutionPlan): CandidateExecutionEvidence {
    return {
      candidateId: plan.candidate.id,
      profile: plan.candidate.profile,
      networkProfile: plan.networkProfile,
      state: "running",
    };
  }

  private sessionKey(workspaceId: string, sessionId: number): string {
    return `${workspaceId}:${sessionId}`;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private pruneGrants(): void {
    const now = this.now();
    for (const [token, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(token);
    }
  }
}

export function candidateGrantFromMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>)[A2_CANDIDATE_GRANT_META_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function summarizeMutation(mutation: CandidateMutationSet): CandidateMutationEvidence {
  const limit = 100;
  const created = mutation.created.slice(0, limit);
  const remainingAfterCreated = Math.max(0, limit - created.length);
  const modified = mutation.modified.slice(0, remainingAfterCreated);
  const remainingAfterModified = Math.max(0, remainingAfterCreated - modified.length);
  const deleted = mutation.deleted.slice(0, remainingAfterModified);
  const total = mutation.created.length + mutation.modified.length + mutation.deleted.length;
  return {
    created,
    modified,
    deleted,
    createdCount: mutation.created.length,
    modifiedCount: mutation.modified.length,
    deletedCount: mutation.deleted.length,
    changedBytes: mutation.changedBytes,
    stableChanged: mutation.stableChanged,
    pathListTruncated: total > limit,
  };
}
