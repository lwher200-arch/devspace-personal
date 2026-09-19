import type { ApprovalCenterView } from '../approval-protocol.js';
import { mountApprovalCard, type ApprovalCardBridge } from './approval-card.js';

export function mountApprovalCenter(root: HTMLElement, initial: ApprovalCenterView, bridge: ApprovalCardBridge): () => void {
  let view = initial, disposed = false, busy = false, message = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let children: Array<() => void> = [];
  const collapsed = new Map<string, boolean>();
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const button = (label: string, action: () => void) => {
    const element = node('button', label, 'approval-secondary'); element.type = 'button'; element.disabled = busy;
    element.addEventListener('click', action); return element;
  };
  function cleanupChildren() { for (const unmount of children) unmount(); children = []; }
  function schedule() {
    clearTimeout(timer);
    if (!disposed && view.approvals.some(item => ['pending', 'submitting'].includes(item.state))) timer = setTimeout(() => { void refresh(); }, 2500);
  }
  async function refresh() {
    if (disposed || busy) return;
    busy = true; render();
    try { view = await bridge.center(); message = ''; }
    catch { message = '审批中心刷新失败。现有决定不会自动重放；可稍后手动刷新。'; }
    finally { if (!disposed) { busy = false; render(); schedule(); } }
  }
  async function revoke() {
    if (disposed || busy) return;
    busy = true; render();
    try {
      const revoked = await bridge.revoke();
      view = await bridge.center();
      message = revoked ? `已撤销 ${revoked} 个本对话持续授权。` : '当前没有可撤销的本对话持续授权。';
    } catch { message = '撤销结果未确认。请刷新审批中心核验，不会自动扩大权限。'; }
    finally { if (!disposed) { busy = false; render(); schedule(); } }
  }
  async function recycle() {
    if (disposed || busy) return;
    busy = true; render();
    try {
      const recycled = await bridge.recycle();
      view = await bridge.center();
      message = recycled ? `已回收 ${recycled} 条安全的已处理审批记录。` : '当前没有可安全回收的审批记录。';
    } catch { message = '回收结果未确认。请刷新审批中心核验；不会撤销持续授权。'; }
    finally { if (!disposed) { busy = false; render(); schedule(); } }
  }
  function mountItem(container: HTMLElement, approval: ApprovalCenterView['approvals'][number]) {
    children.push(mountApprovalCard(container, approval, bridge, {
      initialCollapsed: collapsed.get(approval.id),
      onCollapsedChange: value => collapsed.set(approval.id, value),
      onChanged: () => setTimeout(() => { void refresh(); }, 0),
    }));
  }
  function render() {
    if (disposed) return;
    cleanupChildren();
    const active = view.approvals.filter(item => ['pending', 'submitting'].includes(item.state));
    const processed = view.approvals.filter(item => !['pending', 'submitting'].includes(item.state));
    const recyclable = processed.filter(item => item.recyclable).length;
    const section = node('section', undefined, 'tool-card approval-center');
    const header = node('header', undefined, 'approval-center-header');
    const title = node('div'); title.append(node('span', 'DevSpace', 'approval-eyebrow'), node('h2', '审批中心'));
    header.append(title, node('span', `${active.length} 待处理 · ${view.leases.length} 持续授权`, 'approval-center-counts'));
    section.append(header, node('p', '决定后自动通知 Chat 继续；已处理项默认折叠。回收只删除服务端明确标记为安全的历史记录，不等于撤销持续授权。', 'approval-center-note'));
    const pending = node('div', undefined, 'approval-center-group');
    pending.append(node('h3', `待审批 / 处理中 (${active.length})`));
    if (!active.length) pending.append(node('p', '当前没有待审批操作。', 'approval-center-empty'));
    for (const approval of active) { const item = node('div', undefined, 'approval-center-item'); pending.append(item); mountItem(item, approval); }
    section.append(pending);
    if (view.leases.length) {
      const leases = node('details', undefined, 'approval-center-leases');
      leases.append(node('summary', `本对话持续授权 (${view.leases.length})`));
      const list = node('ul');
      for (const lease of view.leases) list.append(node('li', `${lease.scope} · 至 ${new Date(lease.expiresAt).toLocaleTimeString()}`));
      leases.append(list); section.append(leases);
    }
    const archive = node('details', undefined, 'approval-center-archive');
    archive.open = false; archive.append(node('summary', `已处理 (${processed.length})`));
    const archivedItems = node('div', undefined, 'approval-center-archive-items');
    if (!processed.length) archivedItems.append(node('p', '暂无已处理审批。', 'approval-center-empty'));
    for (const approval of processed) { const item = node('div', undefined, 'approval-center-item'); archivedItems.append(item); mountItem(item, approval); }
    archive.append(archivedItems); section.append(archive);
    const feedback = node('p', message, 'approval-feedback'); feedback.setAttribute('role', 'status'); section.append(feedback);
    const actions = node('div', undefined, 'approval-center-actions');
    actions.append(button(busy ? '正在刷新…' : '刷新中心', () => { void refresh(); }));
    if (recyclable) actions.append(button(`回收已处理记录 (${recyclable})`, () => { void recycle(); }));
    if (view.leases.length) actions.append(button('撤销本对话持续授权', () => { void revoke(); }));
    section.append(actions); root.replaceChildren(section);
  }
  render(); schedule();
  return () => { disposed = true; clearTimeout(timer); cleanupChildren(); root.replaceChildren(); };
}
