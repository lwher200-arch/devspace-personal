import { REVIEW_APPROVAL_TOOL, DECIDE_APPROVAL_TOOL, ApprovalError, type ApprovalCenterView, type ApprovalErrorCode, type ApprovalView } from '../approval-protocol.js';

export interface ApprovalCardBridge {
  review(name: string, args: Record<string, unknown>): Promise<ApprovalView>;
  center(): Promise<ApprovalCenterView>;
  revoke(): Promise<number>;
  recycle(): Promise<number>;
  notify(message: string): Promise<void>;
}

export interface ApprovalCardOptions {
  onOpenCenter?: () => void;
  onChanged?: (view: ApprovalView) => void;
  initialCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

export function approvalDecisionInstruction(view: ApprovalView): string {
  if (view.state === 'denied') return 'The user denied this operation. Do not retry it.';
  if (view.state === 'failed') return 'Submission is unconfirmed. Inspect existing tasks; do not start or approve another operation.';
  if (view.automatic) return 'Query codex_task_status for this task. Do not start a new task.';
  const recovery = 'If the exact retry returns OWNER_APPROVAL_REQUIRED with a new approvalId, do not ask the user to approve again. This can happen when the host changed the logical Chat session. Claim the original approvalId with claim_approval; if claim_approval is not exposed by a cached host tool surface, call review_approval with approvalId "__claim__<original approvalId>". A claim never approves or executes anything. After a successful claim, retry the exact original operation once. If claim fails, stop instead of creating another approval loop.';
  return view.conversationLease?.expiresAt
    ? `Retry the exact approved operation first. ${recovery} Operations matching the bounded conversation lease may continue without another approval until it expires or is revoked.`
    : `Retry only the exact operation that was just approved. ${recovery}`;
}

export function mountApprovalCard(root: HTMLElement, initial: ApprovalView, bridge: ApprovalCardBridge, options: ApprovalCardOptions = {}): () => void {
  let view = initial, busy = false, disposed = false, uncertain = false, message = '';
  let collapsed = options.initialCollapsed ?? (!['pending', 'submitting', 'failed'].includes(initial.state));
  let timer: ReturnType<typeof setTimeout> | undefined, polls = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let notificationPending = false;
  let notificationDelivered = false;
  let failureCode: ApprovalErrorCode | undefined;
  function setCollapsed(next: boolean) {
    if (collapsed === next) return;
    collapsed = next;
    options.onCollapsedChange?.(collapsed);
  }
  function adopt(next: ApprovalView) {
    const previousState = view.state;
    view = next;
    if (view.state === 'failed') setCollapsed(false);
    else if (['pending', 'submitting'].includes(previousState) && !['pending', 'submitting'].includes(view.state)) setCollapsed(true);
  }
  function failure(error: unknown, fallback: string) {
    notificationPending = false;
    failureCode = error instanceof ApprovalError ? error.code : undefined;
    uncertain = !failureCode;
    const messages: Record<ApprovalErrorCode, string> = {
      CHAT_CLIENT_NOT_ENABLED: '当前客户端没有卡片审批权限。请使用 Owner 页面，不能自行放宽设置。',
      CHAT_CONTEXT_REQUIRED: '宿主没有提供聊天会话标识。请回到原对话刷新插件，或使用 Owner 页面。',
      APPROVAL_UNAVAILABLE: '请求不可用、已过期或已被使用。请查询已有任务，不要重复提交。',
      APPROVAL_CONTEXT_CHANGED: '操作范围、文件或模型已经变化。不能按旧卡片批准；请重新核对请求，也可以拒绝本次请求。',
      APPROVAL_RESPONSE_MISMATCH: '返回结果不属于这张审批卡片。已停止操作，请在原对话重新核对。',
      CHAT_BRIDGE_UNAVAILABLE: '当前网页不支持此审批交互。请刷新插件工具定义，或使用 Owner 页面。',
    };
    message = failureCode ? messages[failureCode] : fallback;
    setCollapsed(false);
  }
  function safeOwnerApprovalUrl(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
    } catch {
      return undefined;
    }
  }
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const button = (label: string, action: () => void, primary = false) => {
    const element = node('button', label, primary ? 'approval-primary' : 'approval-secondary');
    element.type = 'button'; element.disabled = busy;
    element.addEventListener('click', action); return element;
  };
  async function refresh() {
    if (disposed || busy) return;
    busy = true; render();
    try {
      const next = await bridge.review(REVIEW_APPROVAL_TOOL, { approvalId: view.id });
      if (disposed) return;
      adopt(next); uncertain = false; failureCode = undefined; message = '';
      render(); await notifyDecision(); options.onChanged?.(view);
    } catch (error) { if (!disposed) failure(error, '无法核验当前状态。请在原对话查询，不要重复提交任务。'); }
    finally { if (!disposed) { busy = false; render(); schedule(); } }
  }
  function schedule() {
    clearTimeout(timer);
    if (!disposed && !uncertain && !failureCode && view.state === 'submitting' && polls++ < 10) timer = setTimeout(() => { void refresh(); }, 1500);
  }
  async function notifyDecision() {
    if (disposed || !notificationPending || view.state === 'submitting') return;
    // Notify only after the user's decision is recorded. The same logical Chat
    // should retry the exact operation directly; claim is only a recovery path
    // when the host changed its logical session identifier.
    notificationPending = false;
    const instruction = approvalDecisionInstruction(view);
    const receipt = JSON.stringify({ approvalId: view.id, state: view.state,
      ...(view.conversationLease?.expiresAt ? { conversationLeaseUntil: view.conversationLease.expiresAt } : {}), ...view.submission });
    try { await bridge.notify(`DevSpace user decision: ${receipt}. ${instruction}`); if (!disposed) notificationDelivered = true; }
    catch { if (!disposed) { message = '决定已记录，但继续提示是否送达尚未确认。先查看聊天；如有需要，可点击“通知 Chat 继续”，不会重新执行操作。'; setCollapsed(false); } }
  }
  async function reconcileDecision(): Promise<boolean> {
    if (disposed) return false;
    try {
      const next = await bridge.review(REVIEW_APPROVAL_TOOL, { approvalId: view.id });
      if (disposed || next.state === 'pending') return false;
      adopt(next);
      uncertain = false; failureCode = undefined; message = '';
      notificationPending = true;
      render();
      await notifyDecision(); options.onChanged?.(view);
      return true;
    } catch {
      return false;
    }
  }
  async function continueChat() {
    if (disposed || busy || uncertain || failureCode || notificationDelivered || ['pending', 'submitting'].includes(view.state)) return;
    // A restored or failed-notification card requires a new user click and a
    // fresh server receipt before notifying. It never replays a decision.
    notificationPending = true; await refresh();
  }
  async function decide(decision: 'approve' | 'approve_conversation' | 'deny') {
    if (disposed || busy || uncertain || failureCode && !(decision === 'deny' && failureCode === 'APPROVAL_CONTEXT_CHANGED') || view.state !== 'pending' || !view.decisionToken || Date.parse(view.expiresAt) <= Date.now()) return;
    busy = true; message = ''; render();
    try {
      const next = await bridge.review(DECIDE_APPROVAL_TOOL, { approvalId: view.id, decisionToken: view.decisionToken, decision });
      if (disposed) return;
      adopt(next);
      // The follow-up reports an already-validated user action. It contains no
      // credentials and is not itself evidence that authorizes execution.
      notificationPending = true; render(); await notifyDecision(); options.onChanged?.(view);
    } catch (error) {
      if (!disposed) {
        const reconciled = await reconcileDecision();
        if (!reconciled) failure(error, '决定提交结果未确认。请先刷新状态；不会自动重试批准。');
      }
    }
    finally { if (!disposed) { busy = false; render(); schedule(); } }
  }
  function render() {
    if (disposed) return;
    const titles = { pending: '请确认这次操作', approved: '已批准一次', denied: '已拒绝', submitting: '已批准，正在提交 Codex', submitted: 'Codex 任务已提交', failed: '提交结果未确认' };
    const title = view.state === 'approved' && view.conversationLease?.expiresAt ? '已批准本对话受限范围' : titles[view.state];
    const section = node('section', undefined, 'tool-card approval-card');
    section.setAttribute('aria-busy', String(busy));
    const header = node('header', undefined, 'approval-header');
    const heading = node('div', undefined, 'approval-heading');
    heading.append(node('span', 'DevSpace / 操作审批', 'approval-eyebrow'), node('h2', title));
    const collapse = button(collapsed ? '展开' : '收起', () => { setCollapsed(!collapsed); render(); });
    collapse.className = 'approval-collapse approval-secondary';
    collapse.setAttribute('aria-expanded', String(!collapsed));
    header.append(heading, collapse);
    section.append(header);
    const body = node('div', undefined, 'approval-body');
    body.hidden = collapsed;
    body.append(node('p', view.reason), node('p', `工具：${view.tool}`, 'approval-tool'));
    const context = node('details');
    context.className = 'approval-context';
    context.open = view.state === 'pending';
    context.append(node('summary', '完整参数与操作范围'), node('pre', JSON.stringify({ arguments: view.args, context: view.context }, null, 2), 'approval-parameters'));
    body.append(context);
    const expired = Date.parse(view.expiresAt) <= Date.now();
    clearTimeout(expiryTimer);
    if (view.state === 'pending' && !expired) expiryTimer = setTimeout(render, Math.min(2147483647, Date.parse(view.expiresAt) - Date.now() + 1));
    const note = view.state === 'pending' ? expired ? '请求已过期。请在原对话重新核对操作。' :
      `有效至 ${new Date(view.expiresAt).toLocaleTimeString()}。${view.automatic ? '批准后自动提交这一轮 Codex。' : view.conversationLease ? '可单次批准，或在当前对话中持续批准卡片所示受限范围；命令类授权只匹配完全相同的参数。' : '仅允许聊天重试这一个操作。'}` :
      view.state === 'submitted' ? '提交不代表完成。聊天将查询任务结果，不会重复启动。' :
        view.state === 'denied' ? '此请求不会执行。' : view.state === 'failed' ? '先查询已有任务与日志，不要自动换模型或重新提交。' : '授权只适用于这一个请求，工作区和沙箱限制不变。';
    body.append(node('p', note, 'approval-note'));
    if (view.conversationLease) {
      const scopes = view.conversationLease.scopes?.length ? view.conversationLease.scopes : [view.conversationLease.scope];
      body.append(node('p', `本对话持续批准范围：${scopes.join('；')}。`, 'approval-note approval-lease-scopes'));
    }
    if (view.conversationLease?.expiresAt) {
      body.append(node('p', `本对话受限授权有效至 ${new Date(view.conversationLease.expiresAt).toLocaleTimeString()}；仅匹配卡片所示范围，不会扩大到其他命令或参数，不会续期，服务重启或主动撤销会提前失效。`, 'approval-note'));
    }
    if (view.submission) body.append(node('pre', JSON.stringify(view.submission, null, 2), 'approval-receipt'));
    const feedback = node('p', message, 'approval-feedback'); feedback.setAttribute('role', 'status'); body.append(feedback);
    const actions = node('div', undefined, 'approval-actions');
    if (view.state === 'pending') {
      const approve = button('批准一次', () => { void decide('approve'); }, true);
      const deny = button('拒绝', () => { void decide('deny'); });
      approve.disabled ||= expired || uncertain || Boolean(failureCode);
      deny.disabled ||= expired || uncertain || Boolean(failureCode && failureCode !== 'APPROVAL_CONTEXT_CHANGED');
      actions.append(approve, deny);
      if (view.conversationLease) {
        const approveConversation = button('本对话始终批准（受限范围）', () => { void decide('approve_conversation'); });
        approveConversation.classList.add('approval-conversation');
        approveConversation.disabled ||= expired || uncertain || Boolean(failureCode);
        actions.append(approveConversation);
      }
      const ownerApprovalUrl = safeOwnerApprovalUrl(view.approvalUrl);
      if (ownerApprovalUrl) {
        const ownerLink = node('a', '打开 Owner 审批页面', 'approval-owner-link');
        ownerLink.href = ownerApprovalUrl;
        ownerLink.target = '_blank';
        ownerLink.rel = 'noreferrer';
        ownerLink.referrerPolicy = 'no-referrer';
        actions.append(ownerLink);
      }
    }
    if (!['pending', 'submitting'].includes(view.state)) {
      const resume = button(notificationDelivered ? '已通知 Chat' : '通知 Chat 继续', () => { void continueChat(); }, true);
      resume.classList.add('approval-continue');
      resume.disabled ||= uncertain || Boolean(failureCode) || notificationDelivered;
      actions.append(resume);
    }
    if (options.onOpenCenter) actions.append(button('审批中心', options.onOpenCenter));
    actions.append(button(busy ? '正在核验…' : '刷新状态', () => { void refresh(); }));
    body.append(actions); section.append(body); root.replaceChildren(section);
  }
  render(); schedule();
  return () => { disposed = true; clearTimeout(timer); clearTimeout(expiryTimer); view = { ...view, decisionToken: undefined }; root.replaceChildren(); };
}
