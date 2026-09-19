import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { ServerConfig } from './config.js';
import { OwnerApprovals, approvalPrincipal, approvalContextMatches, classifyMcpOperation } from './mcp-authorization.js';
import { APPROVAL_CENTER_META_KEY, APPROVAL_META_KEY, REVIEW_APPROVAL_TOOL, REVIEW_APPROVALS_TOOL, REVIEW_APPROVAL_CENTER_COMPAT_ID, REVIEW_APPROVAL_CLAIM_COMPAT_PREFIX, DECIDE_APPROVAL_TOOL, REISSUE_APPROVAL_TOOL, CLAIM_APPROVAL_TOOL, REVOKE_CONVERSATION_APPROVALS_TOOL, RECYCLE_APPROVALS_TOOL, ApprovalError, type ApprovalCenterView, type ApprovalView } from './approval-protocol.js';
import { openAiConversationScopeId } from './request-meta.js';
import { parseCodexSubmission } from './codex-bridge.js';
import type { WorkspaceRegistry } from './workspaces.js';
import { WORKSPACE_APP_URI } from './tool-surfaces/types.js';
import { logEvent } from './logger.js';

export function isApprovalUiTool(name: string) {
  return name === REVIEW_APPROVAL_TOOL || name === REVIEW_APPROVALS_TOOL || name === DECIDE_APPROVAL_TOOL || name === REISSUE_APPROVAL_TOOL ||
    name === CLAIM_APPROVAL_TOOL || name === REVOKE_CONVERSATION_APPROVALS_TOOL || name === RECYCLE_APPROVALS_TOOL;
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
function componentView(view: ApprovalView, config: ServerConfig): ApprovalView {
  return {
    ...view,
    approvalUrl: new URL(`/owner/approvals/${view.id}`, config.publicBaseUrl).href,
  };
}
function result(view: ApprovalView, config: ServerConfig) {
  const rendered = componentView(view, config);
  const summary = { approvalId: view.id, state: view.state, tool: view.tool, approvalUrl: rendered.approvalUrl, ...view.submission,
    instruction: view.state === 'pending' ? view.conversationLease
      ? 'The user may click Approve once, approve the bounded conversation scope shown in the card, or Deny. If the card fails to load, show approvalUrl as the Owner-page fallback. Never approve on their behalf.'
      : 'The user must click Approve once or Deny in the card. If the card fails to load, show approvalUrl as the Owner-page fallback. Never approve on their behalf.' :
      view.state === 'approved' && view.conversationLease?.expiresAt ? `The user approved one exact retry and a scoped conversation lease until ${view.conversationLease.expiresAt}.` :
      view.state === 'approved' ? 'The user approved one exact retry of the original operation.' :
        view.state === 'denied' ? 'The user denied this operation. Do not retry it.' :
          view.state === 'failed' ? 'Submission is unconfirmed. Inspect existing tasks; do not start another operation.' :
        'Inspect the approved task status; do not submit another operation automatically.' };
  const text = JSON.stringify(summary);
  return { content: [{ type: 'text' as const, text }], structuredContent: { result: text }, _meta: { [APPROVAL_META_KEY]: rendered } };
}
function centerResult(center: ApprovalCenterView, config: ServerConfig) {
  const rendered = { ...center, approvals: center.approvals.map(view => componentView(view, config)) };
  const pending = center.approvals.filter(view => ['pending', 'submitting'].includes(view.state)).length;
  const processed = center.approvals.length - pending;
  const recyclable = center.approvals.filter(view => view.recyclable).length;
  const fallbackApprovals = rendered.approvals
    .filter(view => ['pending', 'submitting'].includes(view.state))
    .map(view => ({ approvalId: view.id, approvalUrl: view.approvalUrl }));
  const text = JSON.stringify({ pending, processed, recyclable, activeLeases: center.leases.length, fallbackApprovals,
    instruction: 'Use the Approval Center shown to the user. If the card fails to load, show fallbackApprovals so the user can use the Owner page. Decisions remain per-operation and only the user may click them.' });
  return { content: [{ type: 'text' as const, text }], structuredContent: { result: text }, _meta: { [APPROVAL_CENTER_META_KEY]: rendered } };
}

export function registerApprovalTools(
  server: McpServer, config: ServerConfig, approvals: OwnerApprovals,
  workspaces: WorkspaceRegistry, executionBoundaryProfile?: string,
) {
  const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
  let hostToolRefreshSent = false;
  const respond = (approvalId: string, run: () => ApprovalView) => {
    try { return result(run(), config); }
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
      if (!approvalContextMatches(view, classifyMcpOperation(
        config, workspaces, view.tool, args, executionBoundaryProfile,
      ))) throw Error('Context changed');
    } catch { throw new ApprovalError('APPROVAL_CONTEXT_CHANGED'); }
  };
  server.registerTool(REVIEW_APPROVALS_TOOL, {
    title: 'Open approval center',
    description: 'Compatibility action for the DevSpace Approval Center. The model-facing review_approval tool owns the shared output template; this app-only action remains available to the widget itself.',
    inputSchema: {}, outputSchema: { result: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private', 'openai/widgetAccessible': true },
  }, (_args, extra) => centerResult(approvals.reviewConversationUi(principal(extra)), config));
  server.registerTool(REVIEW_APPROVAL_TOOL, {
    title: 'Review approvals',
    description: `Show the current conversation Approval Center, or reopen one specific OWNER_APPROVAL_REQUIRED request when approvalId is supplied. Omit approvalId for the center; cached hosts that still require the field may pass the reserved compatibility value ${REVIEW_APPROVAL_CENTER_COMPAT_ID}. Cached hosts that do not expose claim_approval may pass ${REVIEW_APPROVAL_CLAIM_COMPAT_PREFIX}<approvalId> to bind an already-approved, unconsumed receipt to the current logical Chat session. This compatibility path never approves a request. Only the user may click decision buttons.`,
    inputSchema: { approvalId: id.optional() }, outputSchema: { result: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: WORKSPACE_APP_URI, visibility: ['model', 'app'] }, 'openai/outputTemplate': WORKSPACE_APP_URI, 'openai/widgetAccessible': true },
  }, async ({ approvalId }, extra) => {
    if (!approvalId || approvalId === REVIEW_APPROVAL_CENTER_COMPAT_ID) {
      return centerResult(approvals.reviewConversationUi(principal(extra)), config);
    }
    if (approvalId.startsWith(REVIEW_APPROVAL_CLAIM_COMPAT_PREFIX)) {
      const originalId = approvalId.slice(REVIEW_APPROVAL_CLAIM_COMPAT_PREFIX.length);
      const parsed = id.safeParse(originalId);
      if (!parsed.success) {
        return respond(approvalId, () => { throw new ApprovalError('APPROVAL_UNAVAILABLE'); });
      }
      return respond(parsed.data, () => approvals.claimApproved(parsed.data, principal(extra)));
    }
    const reviewed = respond(approvalId, () => {
      const view = approvals.reviewUi(approvalId, principal(extra)); validatePending(view); return view;
    });
    if (!hostToolRefreshSent && !(('isError' in reviewed) && reviewed.isError === true)) {
      try {
        await extra.sendNotification({ method: 'notifications/tools/list_changed' });
        hostToolRefreshSent = true;
        logEvent(config.logging, 'info', 'chat_tool_surface_refresh_notified', { tool: REVIEW_APPROVAL_TOOL });
      } catch (error) {
        logEvent(config.logging, 'warn', 'chat_tool_surface_refresh_failed', {
          tool: REVIEW_APPROVAL_TOOL,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return reviewed;
  });
  server.registerTool(REISSUE_APPROVAL_TOOL, {
    title: 'Request approval again',
    description: 'Use only after the user explicitly asks to request approval again for a previously denied operation. This does not approve or execute anything. It arms one exact re-request; retry the original operation once to receive a fresh pending approval.',
    inputSchema: { approvalId: id }, outputSchema: { result: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['model'] } },
  }, ({ approvalId }, extra) => {
    try {
      const identity = principal(extra);
      const view = approvals.prepareRelaunch(approvalId, identity);
      logEvent(config.logging, 'info', 'chat_approval_relaunch_requested', { approvalId, tool: view.tool });
      const text = JSON.stringify({ approvalId: view.id, state: view.state, tool: view.tool,
        instruction: 'The denied decision is unchanged and nothing executed. Retry the exact original operation once to create a fresh pending approval, then wait for the user to decide again.' });
      return { content: [{ type: 'text' as const, text }], structuredContent: { result: text } };
    } catch (error) {
      const code = error instanceof ApprovalError ? error.code : 'APPROVAL_UNAVAILABLE';
      logEvent(config.logging, 'warn', 'chat_approval_relaunch_rejected', { approvalId, code });
      const text = JSON.stringify({ code, instruction: 'Only the same authenticated client/conversation can request a fresh approval for an existing denied request. Nothing executed.' });
      return { isError: true, content: [{ type: 'text' as const, text }], structuredContent: { result: text } };
    }
  });
  server.registerTool(CLAIM_APPROVAL_TOOL, {
    title: 'Claim approved operation',
    description: 'After the user has already approved an operation, bind that unconsumed approval receipt to the current Chat session when the host changed its logical session identifier. Requires the same trusted OAuth client. Does not approve or execute anything.',
    inputSchema: { approvalId: id }, outputSchema: { result: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['model'] } },
  }, ({ approvalId }, extra) => {
    try {
      const identity = principal(extra);
      const view = approvals.claimApproved(approvalId, identity);
      logEvent(config.logging, 'info', 'chat_approval_claimed', { approvalId, tool: view.tool });
      const text = JSON.stringify({ approvalId: view.id, state: view.state, tool: view.tool,
        ...(view.conversationLease?.expiresAt ? { conversationLeaseUntil: view.conversationLease.expiresAt } : {}),
        instruction: 'The existing user approval is now bound to this Chat session. Retry only the original exact operation; this claim itself executed nothing.' });
      return { content: [{ type: 'text' as const, text }], structuredContent: { result: text } };
    } catch (error) {
      const code = error instanceof ApprovalError ? error.code : 'APPROVAL_UNAVAILABLE';
      logEvent(config.logging, 'warn', 'chat_approval_claim_rejected', { approvalId, code });
      const text = JSON.stringify({ code, instruction: 'The approval could not be claimed. Do not retry execution automatically; request a new approval if the old receipt is unavailable or belongs to another OAuth client.' });
      return { isError: true, content: [{ type: 'text' as const, text }], structuredContent: { result: text } };
    }
  });
  server.registerTool(DECIDE_APPROVAL_TOOL, {
    title: 'Record user decision',
    description: 'UI-only decision for an already-reviewed exact operation. Requires the private component capability and the original authenticated client/conversation. Not a model authorization tool.',
    inputSchema: { approvalId: id, decisionToken: z.string().min(1).max(128), decision: z.enum(['approve', 'approve_conversation', 'deny']) },
    outputSchema: { result: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    // This private tool handles a click, not template rendering. Associating a
    // hidden action with the shared output template disables that template in ChatGPT.
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private', 'openai/widgetAccessible': true },
  }, ({ approvalId, decisionToken, decision }, extra) => respond(approvalId, () => {
    const identity = principal(extra);
    const view = decision === 'approve_conversation'
      ? approvals.decideUiForConversation(approvalId, identity, decisionToken, validatePending)
      : approvals.decideUi(approvalId, identity, decisionToken, decision === 'approve', validatePending);
    logEvent(config.logging, 'info', 'chat_approval_decided', { approvalId, state: view.state });
    return view;
  }));
  server.registerTool(REVOKE_CONVERSATION_APPROVALS_TOOL, {
    title: 'Revoke conversation approvals',
    description: 'Revoke all active scoped approval leases for this authenticated Chat conversation. This only removes authority; it never executes or approves an operation.',
    inputSchema: {}, outputSchema: { result: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['model'] } },
  }, (_args, extra) => {
    const identity = principal(extra);
    const revoked = approvals.revokeConversationLeases(identity);
    logEvent(config.logging, 'info', 'chat_approval_leases_revoked', { revoked });
    const text = JSON.stringify({ revoked, instruction: 'Conversation approval leases are revoked. Future high-risk operations return to normal approval rules.' });
    return { content: [{ type: 'text' as const, text }], structuredContent: { result: text } };
  });
  server.registerTool(RECYCLE_APPROVALS_TOOL, {
    title: 'Recycle processed approvals',
    description: 'UI-only cleanup for processed approval history that the server has marked recyclable. It never removes pending work and never revokes a live conversation lease.',
    inputSchema: {}, outputSchema: { result: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private', 'openai/widgetAccessible': true },
  }, (_args, extra) => {
    const identity = principal(extra);
    const recycled = approvals.recycleConversationApprovals(identity);
    logEvent(config.logging, 'info', 'chat_approval_history_recycled', { recycled });
    const text = JSON.stringify({ recycled, instruction: 'Only server-marked terminal history was removed. Pending approvals and live conversation leases were preserved.' });
    return { content: [{ type: 'text' as const, text }], structuredContent: { result: text } };
  });
}
