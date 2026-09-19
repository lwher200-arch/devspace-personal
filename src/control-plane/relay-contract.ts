import * as z from "zod/v4";

const id = z.string().trim().min(1).max(256);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const isoDate = z.iso.datetime({ offset: true });

export const CONTROL_RELAY_PROTOCOL_VERSION = 1 as const;

export const nodeCapabilitySchema = z.enum([
  "status",
  "approvals",
  "tasks",
  "deployment_status",
]);
export type NodeCapability = z.infer<typeof nodeCapabilitySchema>;

export const nodeIdentitySchema = z.object({
  version: z.literal(CONTROL_RELAY_PROTOCOL_VERSION),
  nodeId: id,
  instanceId: id,
  startedAt: isoDate,
  productVersion: id,
  capabilities: z.array(nodeCapabilitySchema).max(16),
}).strict();
export type NodeIdentity = z.infer<typeof nodeIdentitySchema>;

export const controlEventTypeSchema = z.enum([
  "node.online",
  "node.offline",
  "approval.created",
  "approval.changed",
  "task.changed",
  "deployment.changed",
  "delivery.changed",
]);
export type ControlEventType = z.infer<typeof controlEventTypeSchema>;

/**
 * Cloud-facing event metadata. Payloads are intentionally references/digests,
 * not arbitrary local arguments, credentials, file contents, or capabilities.
 */
export const controlEventSchema = z.object({
  version: z.literal(CONTROL_RELAY_PROTOCOL_VERSION),
  eventId: id,
  nodeId: id,
  instanceId: id,
  sequence: z.number().int().nonnegative(),
  createdAt: isoDate,
  type: controlEventTypeSchema,
  requestId: id.optional(),
  subjectId: id.optional(),
  conversationRef: sha256.optional(),
  contextDigest: sha256.optional(),
}).strict();
export type ControlEvent = z.infer<typeof controlEventSchema>;

export const deliveryStateSchema = z.enum([
  "created",
  "hub_received",
  "local_received",
  "accepted",
  "result_ready",
  "chat_delivery_pending",
  "delivered",
  "uncertain",
]);
export type DeliveryState = z.infer<typeof deliveryStateSchema>;

export const deliveryReceiptSchema = z.object({
  version: z.literal(CONTROL_RELAY_PROTOCOL_VERSION),
  requestId: id,
  eventId: id,
  nodeId: id,
  state: deliveryStateSchema,
  observedAt: isoDate,
  agentId: id.optional(),
  workspaceId: id.optional(),
}).strict();
export type DeliveryReceipt = z.infer<typeof deliveryReceiptSchema>;

/**
 * Safe cloud projection of a local approval. It contains no decision token,
 * Owner credential, raw arguments, or reusable execution authority.
 */
export const approvalEnvelopeSchema = z.object({
  version: z.literal(CONTROL_RELAY_PROTOCOL_VERSION),
  approvalId: id,
  nodeId: id,
  requestId: id.optional(),
  state: z.enum(["pending", "approved", "denied", "submitting", "submitted", "failed"]),
  tool: id,
  reason: z.string().max(4096),
  expiresAt: isoDate,
  contextDigest: sha256,
  conversationRef: sha256.optional(),
  automatic: z.boolean(),
  lease: z.object({
    scope: z.string().min(1).max(1024),
    expiresAt: isoDate.optional(),
  }).strict().optional(),
  submission: z.object({
    agentId: id,
    workspaceId: id,
  }).strict().optional(),
}).strict();
export type ApprovalEnvelope = z.infer<typeof approvalEnvelopeSchema>;

export const contextBlobKindSchema = z.enum([
  "chat_input",
  "chat_output",
  "tool_input",
  "tool_output",
  "log",
  "test_output",
  "artifact_summary",
]);
export type ContextBlobKind = z.infer<typeof contextBlobKindSchema>;

export const contextBlobRefSchema = z.object({
  version: z.literal(CONTROL_RELAY_PROTOCOL_VERSION),
  refId: id,
  conversationRef: sha256,
  kind: contextBlobKindSchema,
  digest: sha256,
  bytes: z.number().int().nonnegative().max(32 * 1024 * 1024),
  estimatedTokens: z.number().int().nonnegative().max(10_000_000).optional(),
  createdAt: isoDate,
}).strict();
export type ContextBlobRef = z.infer<typeof contextBlobRefSchema>;

export const coordinationCapabilitySchema = z.enum([
  "context.read",
  "context.write",
  "task.submit",
  "task.receive",
  "permission.observe",
  "notification.receive",
  "notification.publish",
]);
export type CoordinationCapability = z.infer<typeof coordinationCapabilitySchema>;

export const permissionSubjectSchema = z.object({
  kind: z.enum(["node", "conversation", "agent"]),
  id,
}).strict();

export const permissionAssignmentSchema = z.object({
  version: z.literal(CONTROL_RELAY_PROTOCOL_VERSION),
  assignmentId: id,
  subject: permissionSubjectSchema,
  workspaceRef: sha256.optional(),
  capabilities: z.array(coordinationCapabilitySchema).min(1).max(16),
  state: z.enum(["active", "revoked", "expired"]),
  grantedBy: id,
  createdAt: isoDate,
  expiresAt: isoDate.optional(),
}).strict();
export type PermissionAssignment = z.infer<typeof permissionAssignmentSchema>;

export const taskStateSchema = z.enum([
  "queued",
  "blocked",
  "dispatched",
  "accepted",
  "running",
  "result_ready",
  "completed",
  "failed",
  "cancelled",
]);
export type TaskState = z.infer<typeof taskStateSchema>;

export const taskEnvelopeSchema = z.object({
  version: z.literal(CONTROL_RELAY_PROTOCOL_VERSION),
  taskId: id,
  targetNodeId: id,
  state: taskStateSchema,
  priority: z.number().int().min(0).max(100).default(50),
  createdAt: isoDate,
  notBefore: isoDate.optional(),
  deadline: isoDate.optional(),
  conversationRef: sha256.optional(),
  workspaceRef: sha256.optional(),
  contextRef: id.optional(),
  instructionRef: id,
  permissionAssignmentIds: z.array(id).max(32).default([]),
  resultRef: id.optional(),
}).strict();
export type TaskEnvelope = z.infer<typeof taskEnvelopeSchema>;

export const notificationSeveritySchema = z.enum(["info", "warning", "error", "action_required"]);
export const notificationAudienceSchema = z.object({
  kind: z.enum(["admin", "node", "conversation", "agent"]),
  id: id.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.kind !== "admin" && !value.id) {
    ctx.addIssue({ code: "custom", path: ["id"], message: "Non-admin notification audiences require an id." });
  }
});

export const notificationEnvelopeSchema = z.object({
  version: z.literal(CONTROL_RELAY_PROTOCOL_VERSION),
  notificationId: id,
  audience: notificationAudienceSchema,
  type: id,
  severity: notificationSeveritySchema,
  title: z.string().trim().min(1).max(256),
  summary: z.string().trim().min(1).max(1024),
  createdAt: isoDate,
  contextRef: id.optional(),
  taskId: id.optional(),
  permissionAssignmentId: id.optional(),
  requiresAck: z.boolean().default(false),
}).strict();
export type NotificationEnvelope = z.infer<typeof notificationEnvelopeSchema>;

export type SequenceDecision =
  | { accepted: true; nextSequence: number }
  | { accepted: false; reason: "duplicate" | "gap"; expectedSequence: number };

/**
 * Event ordering is node-instance local. A duplicate is safe to acknowledge,
 * but a sequence gap must be reconciled before later events are trusted.
 */
export function acceptControlSequence(lastAccepted: number | undefined, sequence: number): SequenceDecision {
  const expectedSequence = lastAccepted === undefined ? 0 : lastAccepted + 1;
  if (sequence < expectedSequence) return { accepted: false, reason: "duplicate", expectedSequence };
  if (sequence > expectedSequence) return { accepted: false, reason: "gap", expectedSequence };
  return { accepted: true, nextSequence: sequence };
}

/**
 * A cloud receipt records coordination state only. It is never sufficient
 * evidence to authorize or repeat local execution.
 */
export function receiptAuthorizesExecution(_receipt: DeliveryReceipt): false {
  return false;
}

export function cloudAssignmentAuthorizesLocalExecution(_assignment: PermissionAssignment): false {
  return false;
}
