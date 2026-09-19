import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApprovalView } from '../approval-protocol.js';
import { approvalDecisionInstruction } from './approval-card.js';

function approvedView(overrides: Partial<ApprovalView> = {}): ApprovalView {
  return {
    version: 1,
    id: 'approval-followup-fixture',
    state: 'approved',
    tool: 'exec_command',
    reason: 'fixture',
    args: { workspaceId: 'ws-fixture', cmd: 'echo ok' },
    context: { root: '/fixture' },
    expiresAt: '2099-01-01T00:00:00.000Z',
    automatic: false,
    ...overrides,
  };
}

test('approved shell follow-up preserves direct retry and exposes cached-host claim recovery', () => {
  const instruction = approvalDecisionInstruction(approvedView());
  assert.match(instruction, /Retry only the exact operation/);
  assert.match(instruction, /OWNER_APPROVAL_REQUIRED/);
  assert.match(instruction, /do not ask the user to approve again/i);
  assert.match(instruction, /original approvalId/);
  assert.match(instruction, /claim_approval/);
  assert.match(instruction, /review_approval/);
  assert.match(instruction, /__claim__/);
  assert.ok(instruction.indexOf('Retry') < instruction.indexOf('claim_approval'));
});

test('conversation lease follow-up exposes the same cached-host recovery without broadening scope', () => {
  const instruction = approvalDecisionInstruction(approvedView({
    conversationLease: {
      eligible: true,
      scope: 'this exact shell command request',
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  }));
  assert.match(instruction, /Retry the exact approved operation first/);
  assert.match(instruction, /OWNER_APPROVAL_REQUIRED/);
  assert.match(instruction, /do not ask the user to approve again/i);
  assert.match(instruction, /review_approval/);
  assert.match(instruction, /__claim__/);
  assert.match(instruction, /matching the bounded conversation lease/);
});
