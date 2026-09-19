import assert from 'node:assert/strict';
import test from 'node:test';
import { createApprovalBridge } from './approval-bridge.js';
import { ApprovalError, APPROVAL_CENTER_META_KEY, APPROVAL_META_KEY } from '../approval-protocol.js';

const args = { approvalId: 'fixture' };
const view = { version: 1, id: 'fixture', state: 'pending', tool: 'exec_command', reason: 'fixture', args: {}, context: {},
  expiresAt: '2099-01-01T00:00:00Z', automatic: false, decisionToken: 'x'.repeat(43) };
const response = { content: [], _meta: { [APPROVAL_META_KEY]: view } };
test('ChatGPT compatibility bridge supports tool calls and one user follow-up without a standard bridge', async () => {
  let calls = 0, messages = 0;
  const bridge = createApprovalBridge(() => null, () => ({ callTool: async name => { calls++; assert.equal(name, 'review_approval'); return response; },
    sendFollowUpMessage: async input => { messages++; assert.equal(input.scrollToBottom, false); } }));
  assert.equal((await bridge.review('review_approval', args)).id, 'fixture');
  await bridge.notify('approved receipt'); assert.equal(calls, 1); assert.equal(messages, 1);
});
test('standard bridge is preferred and uncertain delivery never falls back or repeats', async () => {
  let standardCalls = 0, legacyCalls = 0;
  const bridge = createApprovalBridge(() => ({ getHostCapabilities: () => ({ serverTools: {}, message: { text: {} } }),
    callServerTool: async () => { standardCalls++; throw Error('delivery unknown'); }, sendMessage: async () => { throw Error('message delivery unknown'); } }),
    () => ({ callTool: async () => { legacyCalls++; return response; }, sendFollowUpMessage: async () => { legacyCalls++; } }));
  await assert.rejects(bridge.review('decide_approval', args), /delivery unknown/);
  await assert.rejects(bridge.notify('receipt'), /delivery unknown/);
  assert.equal(standardCalls, 1); assert.equal(legacyCalls, 0);
});
test('an explicit standard message rejection may fall back once to the ChatGPT compatibility bridge', async () => {
  let standardMessages = 0, legacyMessages = 0;
  const bridge = createApprovalBridge(() => ({
    getHostCapabilities: () => ({ serverTools: {}, message: { text: {} } }),
    callServerTool: async () => response,
    sendMessage: async () => { standardMessages++; return { isError: true, content: [] }; },
  }), () => ({
    sendFollowUpMessage: async input => {
      legacyMessages++;
      assert.equal(input.prompt, 'resume receipt');
      assert.equal(input.scrollToBottom, false);
    },
  }));
  await bridge.notify('resume receipt');
  assert.equal(standardMessages, 1);
  assert.equal(legacyMessages, 1);
});
test('approval bridge rejects mismatched receipts and preserves safe server error codes', async () => {
  const bridge = createApprovalBridge(() => null, () => ({ callTool: async () => response }));
  await assert.rejects(bridge.review('review_approval', { approvalId: 'different' }), (error: unknown) => error instanceof ApprovalError && error.code === 'APPROVAL_RESPONSE_MISMATCH');
  const failed = createApprovalBridge(() => null, () => ({ callTool: async () => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'APPROVAL_CONTEXT_CHANGED' }) }] }) }));
  await assert.rejects(failed.review('review_approval', args), (error: unknown) => error instanceof ApprovalError && error.code === 'APPROVAL_CONTEXT_CHANGED');
  await assert.rejects(bridge.review('exec_command', args), /CHAT_BRIDGE_UNAVAILABLE/);
});
test('approval bridge loads the centralized queue, revokes leases and recycles safe terminal history', async () => {
  const center = { version: 1, approvals: [view], leases: [{ scope: 'fixture', expiresAt: '2099-01-01T00:00:00Z' }] };
  const bridge = createApprovalBridge(() => null, () => ({ callTool: async name => name === 'review_approvals'
    ? { content: [], _meta: { [APPROVAL_CENTER_META_KEY]: center } }
    : { content: [{ type: 'text', text: JSON.stringify(name === 'recycle_approvals' ? { recycled: 3 } : { revoked: 2 }) }] } }));
  assert.equal((await bridge.center()).approvals.length, 1);
  assert.equal(await bridge.revoke(), 2);
  assert.equal(await bridge.recycle(), 3);
});
