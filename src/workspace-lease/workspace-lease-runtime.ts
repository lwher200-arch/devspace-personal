import {
  WorkspaceLeaseStore,
  type WorkspaceLeaseRecord,
  type WorkspaceLeaseRecoveryReason,
} from "./workspace-lease.js";

export const A2_WORKSPACE_LEASE_POLICY_VERSION = "a2-workspace-lease-v2-network-none";

export type WorkspaceLeaseRuntimeReason =
  | WorkspaceLeaseRecoveryReason
  | "no_lease"
  | "conversation_scope_missing"
  | "candidate_workspace_unavailable"
  | "ready";

export interface WorkspaceLeaseRuntimeObservation {
  lease?: WorkspaceLeaseRecord;
  authorityActive: boolean;
  executionEligible: boolean;
  reason: WorkspaceLeaseRuntimeReason;
}

export interface WorkspaceLeaseRuntimeInput {
  clientId: string;
  conversationScopeId?: string;
  workspaceRoot: string;
  boundaryProfile?: string;
  candidateAvailable?: boolean;
}

export class WorkspaceLeaseRuntime {
  constructor(
    private readonly store: WorkspaceLeaseStore,
    private readonly options: {
      policyVersion?: string;
      boundaryVerified?: boolean | (() => boolean);
      emergencyFreeze?: boolean;
    } = {},
  ) {}

  observe(input: WorkspaceLeaseRuntimeInput): WorkspaceLeaseRuntimeObservation {
    const conversationScopeId = input.conversationScopeId?.trim();
    if (!conversationScopeId) {
      return {
        authorityActive: false,
        executionEligible: false,
        reason: "conversation_scope_missing",
      };
    }

    const latest = this.store.latestForContext({
      clientId: input.clientId,
      conversationScopeId,
      workspaceRoot: input.workspaceRoot,
    });
    if (!latest) {
      return {
        authorityActive: false,
        executionEligible: false,
        reason: "no_lease",
      };
    }

    const currentBoundaryProfile = input.boundaryProfile?.trim();
    const recovered = this.store.recover(latest.id, {
      clientId: input.clientId,
      conversationScopeId,
      workspaceRoot: input.workspaceRoot,
      policyVersion: this.options.policyVersion ?? A2_WORKSPACE_LEASE_POLICY_VERSION,
      boundaryProfile: currentBoundaryProfile || latest.boundaryProfile,
      boundaryVerified: Boolean(currentBoundaryProfile) && this.boundaryVerified(),
      emergencyFreeze: this.options.emergencyFreeze === true,
    });

    if (recovered.record.state !== "active") {
      return {
        lease: recovered.record,
        authorityActive: false,
        executionEligible: false,
        reason: recovered.reason,
      };
    }

    if (input.candidateAvailable !== true) {
      return {
        lease: recovered.record,
        authorityActive: true,
        executionEligible: false,
        reason: "candidate_workspace_unavailable",
      };
    }

    return {
      lease: recovered.record,
      authorityActive: true,
      executionEligible: true,
      reason: "ready",
    };
  }

  private boundaryVerified(): boolean {
    try {
      const source = this.options.boundaryVerified;
      return typeof source === "function" ? source() === true : source === true;
    } catch {
      return false;
    }
  }
}
