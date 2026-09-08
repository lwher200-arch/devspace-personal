import { REVIEW_APPROVAL_TOOL, DECIDE_APPROVAL_TOOL, ApprovalError, type ApprovalErrorCode, type ApprovalView } from '../approval-protocol.js';

export interface ApprovalCardBridge {
  review(name: string, args: Record<string, unknown>): Promise<ApprovalView>;
  notify(message: string): Promise<void>;
}

export function mountApprovalCard(root: HTMLElement, initial: ApprovalView, bridge: ApprovalCardBridge): () => void {
  let view = initial, busy = false, disposed = false, uncertain = false, message = '';
  let timer: ReturnType<typeof setTimeout> | undefined, polls = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let notificationPending = false;
  let notificationDelivered = false;
  let failureCode: ApprovalErrorCode | undefined;
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
      view = next; uncertain = false; failureCode = undefined; message = '';
      render(); await notifyDecision();
    } catch (error) { if (!disposed) failure(error, '无法核验当前状态。请在原对话查询，不要重复提交任务。'); }
    finally { if (!disposed) { busy = false; render(); schedule(); } }
  }
  function schedule() {
    clearTimeout(timer);
    if (!disposed && !uncertain && !failureCode && view.state === 'submitting' && polls++ < 10) timer = setTimeout(() => { void refresh(); }, 1500);
  }
  async function notifyDecision() {
    if (disposed || !notificationPending || view.state === 'submitting') return;
    // Claim before sending. An uncertain host-message reply must not spawn a
    // second follow-up. Restoring an old card never sends a message by itself.
    notificationPending = false;
    const instruction = view.state === 'denied' ? 'The user denied this operation. Do not retry it.' :
      view.state === 'failed' ? 'Submission is unconfirmed. Inspect existing tasks; do not start or approve another operation.' :
        view.automatic ? 'Query codex_task_status for this task. Do not start a new task.' : 'Retry only the exact operation that was just approved.';
    const receipt = JSON.stringify({ approvalId: view.id, state: view.state, ...view.submission });
    try { await bridge.notify(`DevSpace user decision: ${receipt}. ${instruction}`); if (!disposed) notificationDelivered = true; }
    catch { if (!disposed) message = '决定已记录，但继续提示是否送达尚未确认。先查看聊天；如有需要，可点击“通知 Chat 继续”，不会重新执行操作。'; }
  }
  async function continueChat() {
    if (disposed || busy || uncertain || failureCode || notificationDelivered || ['pending', 'submitting'].includes(view.state)) return;
    // A restored or failed-notification card requires a new user click and a
    // fresh server receipt before notifying. It never replays a decision.
    notificationPending = true; await refresh();
  }
  async function decide(decision: 'approve' | 'deny') {
    if (disposed || busy || uncertain || failureCode && !(decision === 'deny' && failureCode === 'APPROVAL_CONTEXT_CHANGED') || view.state !== 'pending' || !view.decisionToken || Date.parse(view.expiresAt) <= Date.now()) return;
    busy = true; message = ''; render();
    try {
      const next = await bridge.review(DECIDE_APPROVAL_TOOL, { approvalId: view.id, decisionToken: view.decisionToken, decision });
      if (disposed) return;
      view = next;
      // The follow-up reports an already-validated user action. It contains no
      // credentials and is not itself evidence that authorizes execution.
      notificationPending = true; render(); await notifyDecision();
    } catch (error) { if (!disposed) failure(error, '决定提交结果未确认。请先刷新状态；不会自动重试批准。'); }
    finally { if (!disposed) { busy = false; render(); schedule(); } }
  }
  function render() {
    if (disposed) return;
    const titles = { pending: '请确认这次操作', approved: '已批准一次', denied: '已拒绝', submitting: '已批准，正在提交 Codex', submitted: 'Codex 任务已提交', failed: '提交结果未确认' };
    const section = node('section', undefined, 'tool-card approval-card');
    section.setAttribute('aria-busy', String(busy));
    const header = node('header', undefined, 'approval-header');
    header.append(node('span', 'DevSpace / 操作审批', 'approval-eyebrow'), node('h2', titles[view.state]));
    section.append(header);
    const body = node('div', undefined, 'approval-body');
    body.append(node('p', view.reason), node('p', `工具：${view.tool}`, 'approval-tool'));
    const context = node('details'); context.open = true;
    context.append(node('summary', '完整参数与操作范围'), node('pre', JSON.stringify({ arguments: view.args, context: view.context }, null, 2), 'approval-parameters'));
    body.append(context);
    const expired = Date.parse(view.expiresAt) <= Date.now();
    clearTimeout(expiryTimer);
    if (view.state === 'pending' && !expired) expiryTimer = setTimeout(render, Math.min(2147483647, Date.parse(view.expiresAt) - Date.now() + 1));
    const note = view.state === 'pending' ? expired ? '请求已过期。请在原对话重新核对操作。' :
      `有效至 ${new Date(view.expiresAt).toLocaleTimeString()}。${view.automatic ? '批准后自动提交这一轮 Codex。' : '仅允许聊天重试这一个操作。'}` :
      view.state === 'submitted' ? '提交不代表完成。聊天将查询任务结果，不会重复启动。' :
        view.state === 'denied' ? '此请求不会执行。' : view.state === 'failed' ? '先查询已有任务与日志，不要自动换模型或重新提交。' : '授权只适用于这一个请求，工作区和沙箱限制不变。';
    body.append(node('p', note, 'approval-note'));
    if (view.submission) body.append(node('pre', JSON.stringify(view.submission, null, 2), 'approval-receipt'));
    const feedback = node('p', message, 'approval-feedback'); feedback.setAttribute('role', 'status'); body.append(feedback);
    const actions = node('div', undefined, 'approval-actions');
    if (view.state === 'pending') {
      const approve = button('批准一次', () => { void decide('approve'); }, true);
      const deny = button('拒绝', () => { void decide('deny'); });
      approve.disabled ||= expired || uncertain || Boolean(failureCode);
      deny.disabled ||= expired || uncertain || Boolean(failureCode && failureCode !== 'APPROVAL_CONTEXT_CHANGED');
      actions.append(approve, deny);
    }
    if (!['pending', 'submitting'].includes(view.state)) {
      const resume = button(notificationDelivered ? '已通知 Chat' : '通知 Chat 继续', () => { void continueChat(); }, true);
      resume.classList.add('approval-continue');
      resume.disabled ||= uncertain || Boolean(failureCode) || notificationDelivered;
      actions.append(resume);
    }
    actions.append(button(busy ? '正在核验…' : '刷新状态', () => { void refresh(); }));
    body.append(actions); section.append(body); root.replaceChildren(section);
  }
  render(); schedule();
  return () => { disposed = true; clearTimeout(timer); clearTimeout(expiryTimer); view = { ...view, decisionToken: undefined }; root.replaceChildren(); };
}
