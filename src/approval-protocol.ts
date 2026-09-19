export const REVIEW_APPROVAL_TOOL = 'review_approval';
export const REVIEW_APPROVALS_TOOL = 'review_approvals';
export const REVIEW_APPROVAL_CENTER_COMPAT_ID = '__approval_center__';
export const REVIEW_APPROVAL_CLAIM_COMPAT_PREFIX = '__claim__';
export const DECIDE_APPROVAL_TOOL = 'decide_approval';
export const REISSUE_APPROVAL_TOOL = 'reissue_approval';
export const CLAIM_APPROVAL_TOOL = 'claim_approval';
export const REVOKE_CONVERSATION_APPROVALS_TOOL = 'revoke_conversation_approvals';
export const RECYCLE_APPROVALS_TOOL = 'recycle_approvals';
export const APPROVAL_META_KEY = 'devspace/approval';
export const APPROVAL_CENTER_META_KEY = 'devspace/approval-center';
export const APPROVAL_TTL_SECONDS = { min: 1800, max: 7200, default: 1800 } as const;
export const APPROVAL_ERROR_CODES = ['CHAT_CLIENT_NOT_ENABLED', 'CHAT_CONTEXT_REQUIRED', 'APPROVAL_UNAVAILABLE', 'APPROVAL_CONTEXT_CHANGED', 'APPROVAL_RESPONSE_MISMATCH', 'CHAT_BRIDGE_UNAVAILABLE'] as const;
export type ApprovalErrorCode = typeof APPROVAL_ERROR_CODES[number];
export class ApprovalError extends Error {
  constructor(readonly code: ApprovalErrorCode) { super(code); this.name = 'ApprovalError'; }
}
export type ApprovalState = 'pending' | 'approved' | 'denied' | 'submitting' | 'submitted' | 'failed';
export interface ApprovalView {
  version: 1;
  id: string;
  state: ApprovalState;
  tool: string;
  reason: string;
  args: Record<string, unknown>;
  context: unknown;
  expiresAt: string;
  approvalUrl?: string;
  automatic: boolean;
  /** Safe to remove from the visible approval history without revoking live authority. */
  recyclable?: boolean;
  decisionToken?: string;
  conversationLease?: {
    eligible: true;
    scope: string;
    /** All authority granted by the conversation decision. `scope` remains the primary label for compatibility. */
    scopes?: string[];
    expiresAt?: string;
  };
  submission?: { agentId: string; workspaceId: string };
}

export interface ApprovalCenterView {
  version: 1;
  approvals: ApprovalView[];
  leases: Array<{ scope: string; expiresAt: string }>;
}
