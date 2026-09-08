export const REVIEW_APPROVAL_TOOL = 'review_approval';
export const DECIDE_APPROVAL_TOOL = 'decide_approval';
export const APPROVAL_META_KEY = 'devspace/approval';
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
  automatic: boolean;
  decisionToken?: string;
  submission?: { agentId: string; workspaceId: string };
}
