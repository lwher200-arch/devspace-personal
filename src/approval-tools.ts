import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { ServerConfig } from './config.js';
import { OwnerApprovals, approvalPrincipal, approvalContextMatches, classifyMcpOperation } from './mcp-authorization.js';
import { APPROVAL_META_KEY, REVIEW_APPROVAL_TOOL, DECIDE_APPROVAL_TOOL, ApprovalError, type ApprovalView } from './approval-protocol.js';
import { openAiConversationScopeId } from './request-meta.js';
import { parseCodexSubmission } from './codex-bridge.js';
import type { WorkspaceRegistry } from './workspaces.js';
import { WORKSPACE_APP_URI } from './tool-surfaces/types.js';
import { logEvent } from './logger.js';

export function isApprovalUiTool(name: string) {
  return name === REVIEW_APPROVAL_TOOL || name === DECIDE_APPROVAL_TOOL;
}
export function chatApprovalEnabled(config: ServerConfig, clientId: string, metadata: unknown) {
  return config.toolAuthorization === 'owner_approval' && config.uiEnabled && Boolean(config.chatApprovalClientIds?.includes(clientId))
    && Boolean(openAiConversationScopeId(metadata)?.trim());
}
export function chatApprovalMode(config: ServerConfig, clientId: string, metadata: unknown) {
  const enabled = chatApprovalEnabled(config, clientId, metadata);
  const conversationBound = Boolean(openAiConversationScopeId(metadata)?.trim());
  return { enabled, mode: enabled ? 'chat_card' : 'owner_page', conversationBound,
    ...(!enabled ? { fallbackReason: config.toolAuthorization !== 'owner_approval' || !config.uiEnabled || !config.chatApprovalClientIds?.includes(clientId) ? 'CHAT_CLIENT_NOT_ENABLED' : 'CHAT_CONTEXT_REQUIRED' } : {}) };
}
function result(view: ApprovalView) {
  const summary = { approvalId: view.id, state: view.state, tool: view.tool, ...view.submission,
    instruction: view.state === 'pending' ? 'The user must click Approve once or Deny in the card. Never approve on their behalf.' :
      view.state === 'approved' ? 'The user approved one exact retry of the original operation.' :
        view.state === 'denied' ? 'The user denied this operation. Do not retry it.' :
          view.state === 'failed' ? 'Submission is unconfirmed. Inspect existing tasks; do not start another operation.' :
        'Inspect the approved task status; do not submit another operation automatically.' };
  const text = JSON.stringify(summary);
  return { content: [{ type: 'text' as const, text }], structuredContent: { result: text }, _meta: { [APPROVAL_META_KEY]: view } };
}

export function registerApprovalTools(server: McpServer, config: ServerConfig, approvals: OwnerApprovals, workspaces: WorkspaceRegistry) {
  const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
  const respond = (approvalId: string, run: () => ApprovalView) => {
    try { return result(run()); }
    catch (error) {
      const code = error instanceof ApprovalError ? error.code : 'APPROVAL_UNAVAILABLE';
      logEvent(config.logging, 'warn', 'chat_approval_rejected', { approvalId, code });
      const text = JSON.stringify({ code, instruction: 'Do not approve or retry execution automatically. Use the original conversation. If context changed, review a new request; use the Owner page when the host cannot provide a conversation context.' });
      return { isError: true, content: [{ type: 'text' as const, text }], structuredContent: { result: text } };
    }
  };
  const principal = (extra: { authInfo?: { clientId: string }; _meta?: unknown }) => {
    if (!extra.authInfo || config.toolAuthorization !== 'owner_approval' || !config.uiEnabled || !config.chatApprovalClientIds?.includes(extra.authInfo.clientId)) throw new ApprovalError('CHAT_CLIENT_NOT_ENABLED');
    if (!openAiConversationScopeId(extra._meta)?.trim()) throw new ApprovalError('CHAT_CONTEXT_REQUIRED');
    return approvalPrincipal(extra.authInfo.clientId, extra._meta);
  };
  const validatePending = (view: ApprovalView) => {
    if (view.state !== 'pending') return;
    try {
      const args = config.bridge?.enabled && ['codex_task_start', 'codex_task_continue'].includes(view.tool) ? parseCodexSubmission(view.tool, view.args) : view.args;
      if (!approvalContextMatches(view, classifyMcpOperation(config, workspaces, view.tool, args))) throw Error('Context changed');
    } catch { throw new ApprovalError('APPROVAL_CONTEXT_CHANGED'); }
  };
  server.registerTool(REVIEW_APPROVAL_TOOL, {
    title: 'Review pending operation',
    description: 'Show the user an inline approval card for an OWNER_APPROVAL_REQUIRED request in this conversation. Does not approve or execute it. Only the user may click the decision buttons; never request or relay private card credentials.',
    inputSchema: { approvalId: id }, outputSchema: { result: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: WORKSPACE_APP_URI, visibility: ['model', 'app'] }, 'openai/outputTemplate': WORKSPACE_APP_URI, 'openai/widgetAccessible': true },
  }, ({ approvalId }, extra) => respond(approvalId, () => {
    const view = approvals.reviewUi(approvalId, principal(extra)); validatePending(view); return view;
  }));
  server.registerTool(DECIDE_APPROVAL_TOOL, {
    title: 'Record user decision',
    description: 'UI-only decision for an already-reviewed exact operation. Requires the private component capability and the original authenticated client/conversation. Not a model authorization tool.',
    inputSchema: { approvalId: id, decisionToken: z.string().min(1).max(128), decision: z.enum(['approve', 'deny']) },
    outputSchema: { result: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    // This private tool handles a click, not template rendering. Associating a
    // hidden action with the shared output template disables that template in ChatGPT.
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private', 'openai/widgetAccessible': true },
  }, ({ approvalId, decisionToken, decision }, extra) => respond(approvalId, () => {
    const identity = principal(extra);
    const view = approvals.decideUi(approvalId, identity, decisionToken, decision === 'approve', validatePending);
    logEvent(config.logging, 'info', 'chat_approval_decided', { approvalId, state: view.state });
    return view;
  }));
}
