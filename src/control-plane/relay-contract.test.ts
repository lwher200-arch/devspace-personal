import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptControlSequence,
  approvalEnvelopeSchema,
  controlEventSchema,
  deliveryReceiptSchema,
  cloudAssignmentAuthorizesLocalExecution,
  contextBlobRefSchema,
  notificationEnvelopeSchema,
  nodeIdentitySchema,
  permissionAssignmentSchema,
  receiptAuthorizesExecution,
  taskEnvelopeSchema,
} from "./relay-contract.js";

const now = "2026-09-18T14:30:00.000+00:00";
const digest = "a".repeat(64);

test("relay node identity is explicit and capability-bounded", () => {
  const node = nodeIdentitySchema.parse({
    version: 1,
    nodeId: "coldhao-devspace",
    instanceId: "boot-1",
    startedAt: now,
    productVersion: "1.0.8",
    capabilities: ["status", "approvals"],
  });
  assert.deepEqual(node.capabilities, ["status", "approvals"]);
  assert.throws(() => nodeIdentitySchema.parse({ ...node, capabilities: ["shell"] }));
});

test("control events carry references and digests but reject undeclared authority fields", () => {
  const event = controlEventSchema.parse({
    version: 1,
    eventId: "evt-1",
    nodeId: "coldhao-devspace",
    instanceId: "boot-1",
    sequence: 0,
    createdAt: now,
    type: "approval.created",
    subjectId: "approval-1",
    conversationRef: digest,
    contextDigest: digest,
  });
  assert.equal(event.sequence, 0);
  assert.throws(() => controlEventSchema.parse({ ...event, ownerToken: "secret" }));
});

test("approval envelope is a non-authoritative cloud projection", () => {
  const envelope = approvalEnvelopeSchema.parse({
    version: 1,
    approvalId: "approval-1",
    nodeId: "coldhao-devspace",
    state: "pending",
    tool: "run_process",
    reason: "Owner review required.",
    expiresAt: now,
    contextDigest: digest,
    conversationRef: digest,
    automatic: false,
  });
  assert.equal(envelope.state, "pending");
  assert.throws(() => approvalEnvelopeSchema.parse({ ...envelope, decisionToken: "capability" }));
  assert.throws(() => approvalEnvelopeSchema.parse({ ...envelope, args: { executable: "bash" } }));
});

test("event sequence handling is idempotent and detects gaps", () => {
  assert.deepEqual(acceptControlSequence(undefined, 0), { accepted: true, nextSequence: 0 });
  assert.deepEqual(acceptControlSequence(0, 0), { accepted: false, reason: "duplicate", expectedSequence: 1 });
  assert.deepEqual(acceptControlSequence(0, 2), { accepted: false, reason: "gap", expectedSequence: 1 });
  assert.deepEqual(acceptControlSequence(0, 1), { accepted: true, nextSequence: 1 });
});

test("delivery receipts never grant execution or replay authority", () => {
  const receipt = deliveryReceiptSchema.parse({
    version: 1,
    requestId: "req-1",
    eventId: "evt-2",
    nodeId: "coldhao-devspace",
    state: "accepted",
    observedAt: now,
    agentId: "agent-1",
    workspaceId: "ws-1",
  });
  assert.equal(receiptAuthorizesExecution(receipt), false);
});

test("cloud coordination permissions remain bounded and non-authoritative locally", () => {
  const assignment = permissionAssignmentSchema.parse({
    version: 1,
    assignmentId: "perm-1",
    subject: { kind: "node", id: "coldhao-devspace" },
    workspaceRef: digest,
    capabilities: ["context.read", "task.receive", "notification.receive"],
    state: "active",
    grantedBy: "owner",
    createdAt: now,
  });
  assert.equal(cloudAssignmentAuthorizesLocalExecution(assignment), false);
  assert.throws(() => permissionAssignmentSchema.parse({ ...assignment, capabilities: ["shell"] }));
});

test("task and notification envelopes carry references instead of arbitrary execution payloads", () => {
  const task = taskEnvelopeSchema.parse({
    version: 1,
    taskId: "task-1",
    targetNodeId: "coldhao-devspace",
    state: "queued",
    priority: 80,
    createdAt: now,
    conversationRef: digest,
    workspaceRef: digest,
    instructionRef: "ctx-instruction-1",
    permissionAssignmentIds: ["perm-1"],
  });
  assert.equal(task.state, "queued");
  assert.throws(() => taskEnvelopeSchema.parse({ ...task, command: "rm -rf /" }));

  const notification = notificationEnvelopeSchema.parse({
    version: 1,
    notificationId: "notice-1",
    audience: { kind: "node", id: "coldhao-devspace" },
    type: "task.ready",
    severity: "action_required",
    title: "Task ready",
    summary: "A queued task is ready for local reconciliation.",
    createdAt: now,
    taskId: "task-1",
    requiresAck: true,
  });
  assert.equal(notification.requiresAck, true);
});

test("context blob references externalize bulk model IO without embedding content", () => {
  const ref = contextBlobRefSchema.parse({
    version: 1,
    refId: "ctx-1",
    conversationRef: digest,
    kind: "tool_output",
    digest,
    bytes: 120000,
    estimatedTokens: 24000,
    createdAt: now,
  });
  assert.equal(ref.kind, "tool_output");
  assert.throws(() => contextBlobRefSchema.parse({ ...ref, content: "large raw output" }));
});
