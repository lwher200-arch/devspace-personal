import { DurableObject } from "cloudflare:workers";
import * as z from "zod/v4";
import {
  acceptControlSequence,
  approvalEnvelopeSchema,
  contextBlobKindSchema,
  contextBlobRefSchema,
  controlEventSchema,
  deliveryReceiptSchema,
  nodeIdentitySchema,
  notificationEnvelopeSchema,
  permissionAssignmentSchema,
  taskEnvelopeSchema,
  type CoordinationCapability,
  type NotificationEnvelope,
  type PermissionAssignment,
  type TaskEnvelope,
} from "../../../src/control-plane/relay-contract.ts";
import {
  buildContextCapsule,
  contextAnchorSchema,
  contextBudgetSchema,
  contextDeltaSchema,
  type ContextAnchor,
  type ContextDelta,
} from "../../../src/control-plane/context-fabric.ts";

const id = z.string().trim().min(1).max(256);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const isoDate = z.iso.datetime({ offset: true });
const MAX_LIST = 100;
const OFFLINE_RETRY_MS = 30000;

const contextIoSchema = z.object({
  version: z.literal(1),
  refId: id.optional(),
  conversationRef: sha256,
  kind: contextBlobKindSchema,
  content: z.string().max(2 * 1024 * 1024),
  estimatedTokens: z.number().int().nonnegative().max(10000000).optional(),
  redacted: z.literal(true),
  createdAt: isoDate,
}).strict();

const capsuleRequestSchema = z.object({
  conversationRef: sha256,
  anchorId: id,
  objective: z.string().trim().min(1).max(8192),
  objectiveEstimatedTokens: z.number().int().nonnegative().max(1000000),
  budget: contextBudgetSchema,
}).strict();

const permissionRevokeSchema = z.object({
  assignmentId: id,
  revokedAt: isoDate,
}).strict();

const taskCreateSchema = taskEnvelopeSchema.superRefine((task, ctx) => {
  if (task.state !== "queued") ctx.addIssue({ code: "custom", path: ["state"], message: "New cloud tasks must start queued." });
});

const taskAckSchema = z.object({
  taskId: id,
  targetNodeId: id,
  state: z.enum(["accepted", "running", "result_ready", "completed", "failed", "cancelled"]),
  observedAt: isoDate,
  resultRef: id.optional(),
}).strict();

const notificationAckSchema = z.object({
  notificationId: id,
  clientId: id,
  ackedAt: isoDate,
}).strict();

const modelEnvelopeSchema = capsuleRequestSchema.extend({
  nodeId: id.optional(),
  maxTasks: z.number().int().positive().max(32).default(8),
  maxNotifications: z.number().int().positive().max(32).default(8),
}).strict();

interface ContextObject { text(): Promise<string> }
interface ContextBucket {
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<ContextObject | null>;
}
interface DurableStub { fetch(input: Request | string, init?: RequestInit): Promise<Response> }
interface DurableNamespace { getByName(name: string): DurableStub }
interface Env {
  CONTROL_HUB: DurableNamespace;
  CONTEXT_BLOBS: ContextBucket;
  HUB_NAME: string;
  DEVSPACE_NODE_TOKEN?: string;
  DEVSPACE_ADMIN_TOKEN?: string;
}
type Role = "admin" | "node";
type Actor = { role: Role; clientId: string; nodeId?: string };
type Row = Record<string, string | number | null>;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
function error(code: string, message: string, status: number): Response {
  return json({ ok: false, code, message }, status);
}
function now(): string { return new Date().toISOString(); }

async function readJson(request: Request, maxBytes = 2162688): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("BODY_TOO_LARGE");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("BODY_TOO_LARGE");
  return JSON.parse(text);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function tokenEqual(left: string, right: string): Promise<boolean> {
  const a = await sha256Hex(left);
  const b = await sha256Hex(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

async function authenticate(request: Request, env: Env): Promise<Actor | Response> {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return error("UNAUTHORIZED", "Bearer token is required.", 401);
  const clientId = (request.headers.get("x-devspace-client-id") || "client").trim().slice(0, 256);
  if (env.DEVSPACE_ADMIN_TOKEN && await tokenEqual(token, env.DEVSPACE_ADMIN_TOKEN)) return { role: "admin", clientId };
  if (env.DEVSPACE_NODE_TOKEN && await tokenEqual(token, env.DEVSPACE_NODE_TOKEN)) {
    const nodeId = (request.headers.get("x-devspace-node-id") || "").trim();
    if (!nodeId || nodeId.length > 256) return error("NODE_ID_REQUIRED", "Node auth requires x-devspace-node-id.", 400);
    return { role: "node", clientId, nodeId };
  }
  return error("UNAUTHORIZED", "Bearer token is invalid.", 401);
}

function adminOnly(path: string, method: string): boolean {
  return path === "/v1/permissions/assign" || path === "/v1/permissions/revoke" || path === "/v1/state" || (path === "/v1/tasks" && method === "POST");
}

function mapPath(path: string): string | undefined {
  const routes: Record<string, string> = {
    "/v1/ws": "/ws",
    "/v1/nodes/hello": "/nodes/hello",
    "/v1/events": "/events",
    "/v1/approvals": "/approvals",
    "/v1/receipts": "/receipts",
    "/v1/context/io": "/context/io",
    "/v1/context/anchor": "/context/anchor",
    "/v1/context/delta": "/context/delta",
    "/v1/context/capsule": "/context/capsule",
    "/v1/permissions/assign": "/permissions/assign",
    "/v1/permissions/revoke": "/permissions/revoke",
    "/v1/permissions": "/permissions",
    "/v1/tasks": "/tasks",
    "/v1/tasks/ack": "/tasks/ack",
    "/v1/notifications": "/notifications",
    "/v1/notifications/ack": "/notifications/ack",
    "/v1/model-envelope": "/model-envelope",
    "/v1/state": "/state",
  };
  if (routes[path]) return routes[path];
  const match = /^\/v1\/context\/blobs\/([^/]+)$/.exec(path);
  return match ? "/context/blob?refId=" + encodeURIComponent(match[1]) : undefined;
}

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS hub_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS nodes (node_id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, product_version TEXT NOT NULL, capabilities_json TEXT NOT NULL, started_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS control_events (event_id TEXT PRIMARY KEY, node_id TEXT NOT NULL, instance_id TEXT NOT NULL, sequence INTEGER NOT NULL, created_at TEXT NOT NULL, type TEXT NOT NULL, request_id TEXT, subject_id TEXT, conversation_ref TEXT, context_digest TEXT, received_at TEXT NOT NULL);",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_event_sequence ON control_events(instance_id, sequence);",
  "CREATE TABLE IF NOT EXISTS approvals (approval_id TEXT PRIMARY KEY, node_id TEXT NOT NULL, state TEXT NOT NULL, tool TEXT NOT NULL, reason TEXT NOT NULL, expires_at TEXT NOT NULL, context_digest TEXT NOT NULL, conversation_ref TEXT, automatic INTEGER NOT NULL, lease_json TEXT, submission_json TEXT, updated_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS delivery_receipts (event_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, node_id TEXT NOT NULL, state TEXT NOT NULL, observed_at TEXT NOT NULL, agent_id TEXT, workspace_id TEXT, received_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS context_blobs (ref_id TEXT PRIMARY KEY, conversation_ref TEXT NOT NULL, kind TEXT NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL, estimated_tokens INTEGER, r2_key TEXT NOT NULL, created_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS context_anchors (conversation_ref TEXT NOT NULL, anchor_id TEXT NOT NULL, anchor_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(conversation_ref, anchor_id));",
  "CREATE TABLE IF NOT EXISTS context_deltas (conversation_ref TEXT NOT NULL, anchor_id TEXT NOT NULL, delta_id TEXT NOT NULL, sequence INTEGER NOT NULL, delta_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(conversation_ref, anchor_id, delta_id), UNIQUE(conversation_ref, anchor_id, sequence));",
  "CREATE TABLE IF NOT EXISTS permission_assignments (assignment_id TEXT PRIMARY KEY, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, workspace_ref TEXT, capabilities_json TEXT NOT NULL, state TEXT NOT NULL, granted_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT, updated_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, target_node_id TEXT NOT NULL, state TEXT NOT NULL, priority INTEGER NOT NULL, created_at TEXT NOT NULL, not_before TEXT, deadline TEXT, conversation_ref TEXT, workspace_ref TEXT, context_ref TEXT, instruction_ref TEXT NOT NULL, permission_ids_json TEXT NOT NULL, result_ref TEXT, attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS notifications (notification_id TEXT PRIMARY KEY, audience_kind TEXT NOT NULL, audience_id TEXT, type TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL, context_ref TEXT, task_id TEXT, permission_assignment_id TEXT, requires_ack INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS notification_deliveries (notification_id TEXT NOT NULL, client_id TEXT NOT NULL, delivered_at TEXT, acked_at TEXT, PRIMARY KEY(notification_id, client_id));"
].join("");

export class ControlHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(SCHEMA);
  }

  private actor(request: Request): Actor {
    const role = request.headers.get("x-devspace-role");
    const clientId = request.headers.get("x-devspace-client-id");
    const nodeId = request.headers.get("x-devspace-node-id") || undefined;
    if ((role !== "admin" && role !== "node") || !clientId || (role === "node" && !nodeId)) throw new Error("INTERNAL_AUTH_CONTEXT");
    return { role, clientId, ...(nodeId ? { nodeId } : {}) };
  }

  private setMeta(key: string, value: unknown): void {
    this.ctx.storage.sql.exec("INSERT INTO hub_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, JSON.stringify(value));
  }

  private getMeta<T>(key: string): T | undefined {
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM hub_meta WHERE key=?", key).toArray()[0];
    return row ? JSON.parse(row.value) as T : undefined;
  }

  private sockets(): Array<{ socket: WebSocket; actor: Actor }> {
    const result: Array<{ socket: WebSocket; actor: Actor }> = [];
    for (const socket of this.ctx.getWebSockets()) {
      const actor = socket.deserializeAttachment() as Actor | null;
      if (actor) result.push({ socket, actor });
    }
    return result;
  }

  private hasCapability(actor: Actor, capability: CoordinationCapability): boolean {
    if (actor.role === "admin") return true;
    if (!actor.nodeId) return false;
    return this.activePermissions("node", actor.nodeId)
      .some(permission => permission.capabilities.includes(capability));
  }

  private capabilityDenied(capability: CoordinationCapability): Response {
    return error("COORDINATION_PERMISSION_REQUIRED", capability + " permission is required.", 403);
  }

  private notificationMatches(actor: Actor, notification: NotificationEnvelope): boolean {
    if (notification.audience.kind === "admin") return actor.role === "admin";
    return notification.audience.kind === "node" && actor.role === "node" &&
      actor.nodeId === notification.audience.id && this.hasCapability(actor, "notification.receive");
  }

  private async publishNotification(notification: NotificationEnvelope): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO notifications(notification_id,audience_kind,audience_id,type,severity,title,summary,created_at,context_ref,task_id,permission_assignment_id,requires_ack) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(notification_id) DO NOTHING",
      notification.notificationId, notification.audience.kind, notification.audience.id || null, notification.type,
      notification.severity, notification.title, notification.summary, notification.createdAt,
      notification.contextRef || null, notification.taskId || null, notification.permissionAssignmentId || null,
      notification.requiresAck ? 1 : 0
    );
    const deliveredAt = now();
    for (const item of this.sockets()) {
      if (!this.notificationMatches(item.actor, notification)) continue;
      try {
        item.socket.send(JSON.stringify({ version: 1, type: "notification.created", observedAt: deliveredAt, payload: notification }));
        this.ctx.storage.sql.exec(
          "INSERT INTO notification_deliveries(notification_id,client_id,delivered_at,acked_at) VALUES(?,?,?,NULL) ON CONFLICT(notification_id,client_id) DO UPDATE SET delivered_at=excluded.delivered_at",
          notification.notificationId, item.actor.clientId, deliveredAt
        );
      } catch {}
    }
  }

  private unread(actor: Actor, limit = 50): NotificationEnvelope[] {
    if (actor.role === "node" && !this.hasCapability(actor, "notification.receive")) return [];
    const rows = actor.role === "admin"
      ? this.ctx.storage.sql.exec<Row>(
          "SELECT n.* FROM notifications n LEFT JOIN notification_deliveries d ON d.notification_id=n.notification_id AND d.client_id=? WHERE n.audience_kind='admin' AND d.acked_at IS NULL ORDER BY n.created_at ASC LIMIT ?",
          actor.clientId, limit
        ).toArray()
      : this.ctx.storage.sql.exec<Row>(
          "SELECT n.* FROM notifications n LEFT JOIN notification_deliveries d ON d.notification_id=n.notification_id AND d.client_id=? WHERE n.audience_kind='node' AND n.audience_id=? AND d.acked_at IS NULL ORDER BY n.created_at ASC LIMIT ?",
          actor.clientId, actor.nodeId, limit
        ).toArray();
    return rows.map(row => notificationEnvelopeSchema.parse({
      version: 1,
      notificationId: row.notification_id,
      audience: { kind: row.audience_kind, ...(row.audience_id ? { id: row.audience_id } : {}) },
      type: row.type,
      severity: row.severity,
      title: row.title,
      summary: row.summary,
      createdAt: row.created_at,
      ...(row.context_ref ? { contextRef: row.context_ref } : {}),
      ...(row.task_id ? { taskId: row.task_id } : {}),
      ...(row.permission_assignment_id ? { permissionAssignmentId: row.permission_assignment_id } : {}),
      requiresAck: Boolean(row.requires_ack)
    }));
  }

  private async websocket(request: Request): Promise<Response> {
    if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") return error("UPGRADE_REQUIRED", "Use WebSocket upgrade.", 426);
    const actor = this.actor(request);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(actor);
    pair[1].send(JSON.stringify({ version: 1, type: "hub.connected", observedAt: now(), payload: { role: actor.role, nodeId: actor.nodeId } }));
    for (const notification of this.unread(actor)) pair[1].send(JSON.stringify({ version: 1, type: "notification.replay", observedAt: now(), payload: notification }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): void {
    const actor = socket.deserializeAttachment() as Actor | null;
    if (!actor || typeof message !== "string") return;
    try {
      const value = JSON.parse(message) as { type?: string; notificationId?: string };
      if (value.type === "ping") socket.send(JSON.stringify({ version: 1, type: "pong", observedAt: now() }));
      if (value.type === "notification.ack" && value.notificationId) {
        this.ctx.storage.sql.exec(
          "INSERT INTO notification_deliveries(notification_id,client_id,delivered_at,acked_at) VALUES(?,?,?,?) ON CONFLICT(notification_id,client_id) DO UPDATE SET acked_at=excluded.acked_at",
          value.notificationId, actor.clientId, now(), now()
        );
      }
    } catch {}
  }

  webSocketClose(): void {}
  webSocketError(): void {}

  private async hello(request: Request): Promise<Response> {
    const actor = this.actor(request);
    const value = nodeIdentitySchema.parse(await readJson(request));
    if (actor.role === "node" && actor.nodeId !== value.nodeId) return error("NODE_MISMATCH", "Node identity mismatch.", 403);
    const seen = now();
    this.ctx.storage.sql.exec(
      "INSERT INTO nodes(node_id,instance_id,product_version,capabilities_json,started_at,last_seen_at) VALUES(?,?,?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET instance_id=excluded.instance_id,product_version=excluded.product_version,capabilities_json=excluded.capabilities_json,started_at=excluded.started_at,last_seen_at=excluded.last_seen_at",
      value.nodeId, value.instanceId, value.productVersion, JSON.stringify(value.capabilities), value.startedAt, seen
    );
    return json({ ok: true, nodeId: value.nodeId, instanceId: value.instanceId, seenAt: seen });
  }

  private async event(request: Request): Promise<Response> {
    const actor = this.actor(request);
    const value = controlEventSchema.parse(await readJson(request));
    if (actor.role === "node" && actor.nodeId !== value.nodeId) return error("NODE_MISMATCH", "Node identity mismatch.", 403);
    const key = "sequence:" + value.nodeId + ":" + value.instanceId;
    const decision = acceptControlSequence(this.getMeta<number>(key), value.sequence);
    if (!decision.accepted) return json({ ok: decision.reason === "duplicate", state: decision.reason, expectedSequence: decision.expectedSequence }, decision.reason === "duplicate" ? 200 : 409);
    this.ctx.storage.sql.exec(
      "INSERT INTO control_events(event_id,node_id,instance_id,sequence,created_at,type,request_id,subject_id,conversation_ref,context_digest,received_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      value.eventId, value.nodeId, value.instanceId, value.sequence, value.createdAt, value.type,
      value.requestId || null, value.subjectId || null, value.conversationRef || null, value.contextDigest || null, now()
    );
    this.setMeta(key, value.sequence);
    return json({ ok: true, state: "accepted", nextSequence: value.sequence + 1 }, 202);
  }

  private async approval(request: Request): Promise<Response> {
    const actor = this.actor(request);
    const value = approvalEnvelopeSchema.parse(await readJson(request));
    if (actor.role === "node" && actor.nodeId !== value.nodeId) return error("NODE_MISMATCH", "Node identity mismatch.", 403);
    this.ctx.storage.sql.exec(
      "INSERT INTO approvals(approval_id,node_id,state,tool,reason,expires_at,context_digest,conversation_ref,automatic,lease_json,submission_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(approval_id) DO UPDATE SET state=excluded.state,tool=excluded.tool,reason=excluded.reason,expires_at=excluded.expires_at,context_digest=excluded.context_digest,conversation_ref=excluded.conversation_ref,automatic=excluded.automatic,lease_json=excluded.lease_json,submission_json=excluded.submission_json,updated_at=excluded.updated_at",
      value.approvalId, value.nodeId, value.state, value.tool, value.reason, value.expiresAt, value.contextDigest,
      value.conversationRef || null, value.automatic ? 1 : 0, value.lease ? JSON.stringify(value.lease) : null,
      value.submission ? JSON.stringify(value.submission) : null, now()
    );
    if (value.state === "pending") {
      await this.publishNotification(notificationEnvelopeSchema.parse({
        version: 1,
        notificationId: "approval-" + value.approvalId,
        audience: { kind: "admin" },
        type: "approval.required",
        severity: "action_required",
        title: "DevSpace approval required",
        summary: (value.tool + ": " + value.reason).slice(0, 1024),
        createdAt: now(),
        requiresAck: true
      }));
    }
    return json({ ok: true, approvalId: value.approvalId, state: value.state }, 202);
  }

  private async receipt(request: Request): Promise<Response> {
    const actor = this.actor(request);
    const value = deliveryReceiptSchema.parse(await readJson(request));
    if (actor.role === "node" && actor.nodeId !== value.nodeId) return error("NODE_MISMATCH", "Node identity mismatch.", 403);
    this.ctx.storage.sql.exec(
      "INSERT INTO delivery_receipts(event_id,request_id,node_id,state,observed_at,agent_id,workspace_id,received_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET state=excluded.state,observed_at=excluded.observed_at,agent_id=excluded.agent_id,workspace_id=excluded.workspace_id,received_at=excluded.received_at",
      value.eventId, value.requestId, value.nodeId, value.state, value.observedAt, value.agentId || null, value.workspaceId || null, now()
    );
    return json({ ok: true, requestId: value.requestId, state: value.state }, 202);
  }

  private async contextIo(request: Request): Promise<Response> {
    const actor = this.actor(request);
    if (!this.hasCapability(actor, "context.write")) return this.capabilityDenied("context.write");
    const value = contextIoSchema.parse(await readJson(request));
    const refId = value.refId || crypto.randomUUID();
    const digest = await sha256Hex(value.content);
    const bytes = new TextEncoder().encode(value.content).byteLength;
    const key = "context/" + value.conversationRef + "/" + refId + "-" + digest + ".txt";
    await this.env.CONTEXT_BLOBS.put(key, value.content, { httpMetadata: { contentType: "text/plain; charset=utf-8" }, customMetadata: { digest, kind: value.kind, conversationRef: value.conversationRef } });
    this.ctx.storage.sql.exec(
      "INSERT INTO context_blobs(ref_id,conversation_ref,kind,digest,bytes,estimated_tokens,r2_key,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(ref_id) DO UPDATE SET conversation_ref=excluded.conversation_ref,kind=excluded.kind,digest=excluded.digest,bytes=excluded.bytes,estimated_tokens=excluded.estimated_tokens,r2_key=excluded.r2_key,created_at=excluded.created_at",
      refId, value.conversationRef, value.kind, digest, bytes, value.estimatedTokens || null, key, value.createdAt
    );
    return json({ ok: true, ref: contextBlobRefSchema.parse({
      version: 1,
      refId,
      conversationRef: value.conversationRef,
      kind: value.kind,
      digest,
      bytes,
      ...(value.estimatedTokens !== undefined ? { estimatedTokens: value.estimatedTokens } : {}),
      createdAt: value.createdAt
    }) }, 201);
  }

  private async contextBlob(request: Request): Promise<Response> {
    const actor = this.actor(request);
    if (!this.hasCapability(actor, "context.read")) return this.capabilityDenied("context.read");
    const url = new URL(request.url);
    const refId = url.searchParams.get("refId");
    if (!refId) return error("INVALID_REQUEST", "refId is required.", 400);
    const row = this.ctx.storage.sql.exec<Row>("SELECT * FROM context_blobs WHERE ref_id=?", refId).toArray()[0];
    if (!row) return error("NOT_FOUND", "Context blob was not found.", 404);
    const ref = contextBlobRefSchema.parse({
      version: 1,
      refId: row.ref_id,
      conversationRef: row.conversation_ref,
      kind: row.kind,
      digest: row.digest,
      bytes: row.bytes,
      ...(row.estimated_tokens !== null ? { estimatedTokens: row.estimated_tokens } : {}),
      createdAt: row.created_at
    });
    if (url.searchParams.get("includeContent") !== "1") return json({ ok: true, ref });
    const object = await this.env.CONTEXT_BLOBS.get(String(row.r2_key));
    return object ? json({ ok: true, ref, content: await object.text() }) : error("BLOB_MISSING", "R2 content is missing.", 503);
  }

  private async anchor(request: Request): Promise<Response> {
    const actor = this.actor(request);
    if (!this.hasCapability(actor, "context.write")) return this.capabilityDenied("context.write");
    const input = z.object({ conversationRef: sha256, anchor: contextAnchorSchema }).strict().parse(await readJson(request));
    this.ctx.storage.sql.exec(
      "INSERT INTO context_anchors(conversation_ref,anchor_id,anchor_json,created_at) VALUES(?,?,?,?) ON CONFLICT(conversation_ref,anchor_id) DO UPDATE SET anchor_json=excluded.anchor_json,created_at=excluded.created_at",
      input.conversationRef, input.anchor.anchorId, JSON.stringify(input.anchor), input.anchor.createdAt
    );
    return json({ ok: true, anchorId: input.anchor.anchorId }, 201);
  }

  private async delta(request: Request): Promise<Response> {
    const actor = this.actor(request);
    if (!this.hasCapability(actor, "context.write")) return this.capabilityDenied("context.write");
    const input = z.object({ conversationRef: sha256, delta: contextDeltaSchema }).strict().parse(await readJson(request));
    const anchor = this.ctx.storage.sql.exec<{ anchor_id: string }>("SELECT anchor_id FROM context_anchors WHERE conversation_ref=? AND anchor_id=?", input.conversationRef, input.delta.baseAnchorId).toArray()[0];
    if (!anchor) return error("ANCHOR_NOT_FOUND", "Delta base anchor is not stored.", 409);
    const latest = this.ctx.storage.sql.exec<{ sequence: number }>("SELECT sequence FROM context_deltas WHERE conversation_ref=? AND anchor_id=? ORDER BY sequence DESC LIMIT 1", input.conversationRef, input.delta.baseAnchorId).toArray()[0];
    if (latest && input.delta.sequence <= latest.sequence) return error("SEQUENCE_CONFLICT", "Delta sequence must increase.", 409);
    this.ctx.storage.sql.exec(
      "INSERT INTO context_deltas(conversation_ref,anchor_id,delta_id,sequence,delta_json,created_at) VALUES(?,?,?,?,?,?)",
      input.conversationRef, input.delta.baseAnchorId, input.delta.deltaId, input.delta.sequence, JSON.stringify(input.delta), input.delta.createdAt
    );
    return json({ ok: true, deltaId: input.delta.deltaId, sequence: input.delta.sequence }, 201);
  }

  private buildCapsule(input: z.infer<typeof capsuleRequestSchema>) {
    const row = this.ctx.storage.sql.exec<{ anchor_json: string }>("SELECT anchor_json FROM context_anchors WHERE conversation_ref=? AND anchor_id=?", input.conversationRef, input.anchorId).toArray()[0];
    if (!row) throw new Error("ANCHOR_NOT_FOUND");
    const anchor = contextAnchorSchema.parse(JSON.parse(row.anchor_json)) as ContextAnchor;
    const deltas = this.ctx.storage.sql.exec<{ delta_json: string }>("SELECT delta_json FROM context_deltas WHERE conversation_ref=? AND anchor_id=? ORDER BY sequence ASC", input.conversationRef, input.anchorId).toArray().map(item => contextDeltaSchema.parse(JSON.parse(item.delta_json)) as ContextDelta);
    return buildContextCapsule({ anchor, deltas, objective: input.objective, objectiveEstimatedTokens: input.objectiveEstimatedTokens, budget: input.budget });
  }

  private activePermissions(kind: string, subjectId: string): PermissionAssignment[] {
    return this.ctx.storage.sql.exec<Row>(
      "SELECT * FROM permission_assignments WHERE subject_kind=? AND subject_id=? AND state='active' AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at DESC LIMIT ?",
      kind, subjectId, now(), MAX_LIST
    ).toArray().map(row => permissionAssignmentSchema.parse({
      version: 1,
      assignmentId: row.assignment_id,
      subject: { kind: row.subject_kind, id: row.subject_id },
      ...(row.workspace_ref ? { workspaceRef: row.workspace_ref } : {}),
      capabilities: JSON.parse(String(row.capabilities_json)),
      state: "active",
      grantedBy: row.granted_by,
      createdAt: row.created_at,
      ...(row.expires_at ? { expiresAt: row.expires_at } : {})
    }));
  }

  private async assignPermission(request: Request): Promise<Response> {
    if (this.actor(request).role !== "admin") return error("FORBIDDEN", "Admin plane required.", 403);
    const value = permissionAssignmentSchema.parse(await readJson(request));
    if (value.state !== "active") return error("INVALID_STATE", "New assignment must be active.", 400);
    this.ctx.storage.sql.exec(
      "INSERT INTO permission_assignments(assignment_id,subject_kind,subject_id,workspace_ref,capabilities_json,state,granted_by,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(assignment_id) DO UPDATE SET subject_kind=excluded.subject_kind,subject_id=excluded.subject_id,workspace_ref=excluded.workspace_ref,capabilities_json=excluded.capabilities_json,state=excluded.state,granted_by=excluded.granted_by,expires_at=excluded.expires_at,updated_at=excluded.updated_at",
      value.assignmentId, value.subject.kind, value.subject.id, value.workspaceRef || null, JSON.stringify(value.capabilities),
      value.state, value.grantedBy, value.createdAt, value.expiresAt || null, now()
    );
    await this.publishNotification(notificationEnvelopeSchema.parse({
      version: 1,
      notificationId: "permission-" + value.assignmentId + "-" + Date.now(),
      audience: value.subject.kind === "node" ? { kind: "node", id: value.subject.id } : { kind: "admin" },
      type: "permission.assigned",
      severity: "info",
      title: "Coordination permission changed",
      summary: value.subject.kind + ":" + value.subject.id + " received " + value.capabilities.join(", "),
      createdAt: now(),
      permissionAssignmentId: value.assignmentId,
      requiresAck: false
    }));
    return json({ ok: true, assignment: value }, 201);
  }

  private async revokePermission(request: Request): Promise<Response> {
    if (this.actor(request).role !== "admin") return error("FORBIDDEN", "Admin plane required.", 403);
    const value = permissionRevokeSchema.parse(await readJson(request));
    this.ctx.storage.sql.exec("UPDATE permission_assignments SET state='revoked',updated_at=? WHERE assignment_id=? AND state='active'", value.revokedAt, value.assignmentId);
    return json({ ok: true, assignmentId: value.assignmentId, state: "revoked" });
  }

  private permissions(request: Request): Response {
    const actor = this.actor(request);
    if (actor.role === "node" && !this.hasCapability(actor, "permission.observe")) {
      return this.capabilityDenied("permission.observe");
    }
    const url = new URL(request.url);
    const kind = url.searchParams.get("subjectKind") || (actor.role === "node" ? "node" : "");
    const subjectId = url.searchParams.get("subjectId") || (actor.role === "node" ? actor.nodeId || "" : "");
    if (!kind || !subjectId) return error("INVALID_REQUEST", "subjectKind and subjectId are required.", 400);
    if (actor.role === "node" && (kind !== "node" || subjectId !== actor.nodeId)) return error("FORBIDDEN", "Node may inspect only its own permissions.", 403);
    return json({ ok: true, assignments: this.activePermissions(kind, subjectId) });
  }

  private taskFromRow(row: Row): TaskEnvelope {
    return taskEnvelopeSchema.parse({
      version: 1,
      taskId: row.task_id,
      targetNodeId: row.target_node_id,
      state: row.state,
      priority: row.priority,
      createdAt: row.created_at,
      ...(row.not_before ? { notBefore: row.not_before } : {}),
      ...(row.deadline ? { deadline: row.deadline } : {}),
      ...(row.conversation_ref ? { conversationRef: row.conversation_ref } : {}),
      ...(row.workspace_ref ? { workspaceRef: row.workspace_ref } : {}),
      ...(row.context_ref ? { contextRef: row.context_ref } : {}),
      instructionRef: row.instruction_ref,
      permissionAssignmentIds: JSON.parse(String(row.permission_ids_json)),
      ...(row.result_ref ? { resultRef: row.result_ref } : {})
    });
  }

  private canReceiveTask(task: TaskEnvelope): boolean {
    const active = this.activePermissions("node", task.targetNodeId);
    if (task.permissionAssignmentIds.length > 0) {
      const required = new Set(task.permissionAssignmentIds);
      return active.some(permission => required.has(permission.assignmentId) && permission.capabilities.includes("task.receive"));
    }
    return active.some(permission => permission.capabilities.includes("task.receive") && (!task.workspaceRef || !permission.workspaceRef || permission.workspaceRef === task.workspaceRef));
  }

  private async schedule(): Promise<void> {
    const row = this.ctx.storage.sql.exec<{ not_before: string | null }>("SELECT not_before FROM tasks WHERE state='queued' ORDER BY COALESCE(not_before,created_at) ASC LIMIT 1").toArray()[0];
    if (row) await this.ctx.storage.setAlarm(row.not_before ? Math.max(Date.parse(row.not_before), Date.now()) : Date.now());
  }

  private async createTask(request: Request): Promise<Response> {
    if (this.actor(request).role !== "admin") return error("FORBIDDEN", "Admin plane required.", 403);
    const task = taskCreateSchema.parse(await readJson(request));
    this.ctx.storage.sql.exec(
      "INSERT INTO tasks(task_id,target_node_id,state,priority,created_at,not_before,deadline,conversation_ref,workspace_ref,context_ref,instruction_ref,permission_ids_json,result_ref,attempts,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)",
      task.taskId, task.targetNodeId, task.state, task.priority, task.createdAt, task.notBefore || null,
      task.deadline || null, task.conversationRef || null, task.workspaceRef || null, task.contextRef || null,
      task.instructionRef, JSON.stringify(task.permissionAssignmentIds), task.resultRef || null, now()
    );
    await this.schedule();
    return json({ ok: true, task }, 201);
  }

  private async ackTask(request: Request): Promise<Response> {
    const actor = this.actor(request);
    const value = taskAckSchema.parse(await readJson(request));
    if (actor.role === "node" && actor.nodeId !== value.targetNodeId) return error("NODE_MISMATCH", "Node may acknowledge only its own tasks.", 403);
    this.ctx.storage.sql.exec("UPDATE tasks SET state=?,result_ref=COALESCE(?,result_ref),updated_at=? WHERE task_id=? AND target_node_id=?", value.state, value.resultRef || null, value.observedAt, value.taskId, value.targetNodeId);
    await this.publishNotification(notificationEnvelopeSchema.parse({
      version: 1,
      notificationId: "task-" + value.taskId + "-" + value.state + "-" + Date.now(),
      audience: { kind: "admin" },
      type: "task." + value.state,
      severity: value.state === "failed" ? "error" : value.state === "result_ready" ? "action_required" : "info",
      title: "Task " + value.state,
      summary: "Node " + value.targetNodeId + " reported " + value.taskId + " as " + value.state,
      createdAt: value.observedAt,
      taskId: value.taskId,
      requiresAck: value.state === "failed" || value.state === "result_ready"
    }));
    return json({ ok: true, ...value });
  }

  private tasks(request: Request): Response {
    const actor = this.actor(request);
    const nodeId = actor.role === "node" ? actor.nodeId : new URL(request.url).searchParams.get("nodeId") || undefined;
    const rows = nodeId
      ? this.ctx.storage.sql.exec<Row>("SELECT * FROM tasks WHERE target_node_id=? ORDER BY updated_at DESC LIMIT ?", nodeId, MAX_LIST).toArray()
      : this.ctx.storage.sql.exec<Row>("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?", MAX_LIST).toArray();
    return json({ ok: true, tasks: rows.map(row => this.taskFromRow(row)) });
  }

  private async notify(request: Request): Promise<Response> {
    const actor = this.actor(request);
    if (actor.role === "node" && !this.hasCapability(actor, "notification.publish")) {
      return this.capabilityDenied("notification.publish");
    }
    const value = notificationEnvelopeSchema.parse(await readJson(request));
    if (actor.role === "node") {
      const allowed = value.audience.kind === "admin" || (value.audience.kind === "node" && value.audience.id === actor.nodeId);
      if (!allowed) return error("FORBIDDEN", "Node notification target is not allowed.", 403);
    }
    await this.publishNotification(value);
    return json({ ok: true, notificationId: value.notificationId }, 201);
  }

  private async modelEnvelope(request: Request): Promise<Response> {
    const actor = this.actor(request);
    if (!this.hasCapability(actor, "context.read")) return this.capabilityDenied("context.read");
    const input = modelEnvelopeSchema.parse(await readJson(request));
    if (actor.role === "node" && input.nodeId && input.nodeId !== actor.nodeId) return error("NODE_MISMATCH", "Node envelope mismatch.", 403);
    let capsule;
    try { capsule = this.buildCapsule(input); }
    catch (cause) { if (cause instanceof Error && cause.message === "ANCHOR_NOT_FOUND") return error("ANCHOR_NOT_FOUND", "Context anchor not found.", 404); throw cause; }
    const nodeId = input.nodeId || actor.nodeId;
    const permissions = nodeId && (actor.role === "admin" || this.hasCapability(actor, "permission.observe"))
      ? this.activePermissions("node", nodeId).slice(0, 16)
      : [];
    const rows = nodeId && (actor.role === "admin" || this.hasCapability(actor, "task.receive"))
      ? this.ctx.storage.sql.exec<Row>("SELECT * FROM tasks WHERE target_node_id=? AND state NOT IN ('completed','failed','cancelled') ORDER BY priority DESC,updated_at DESC LIMIT ?", nodeId, input.maxTasks).toArray()
      : [];
    return json({ ok: true, envelope: {
      version: 1,
      generatedAt: now(),
      conversationRef: input.conversationRef,
      capsule,
      permissionRefs: permissions.map(permission => ({ assignmentId: permission.assignmentId, capabilities: permission.capabilities, expiresAt: permission.expiresAt })),
      taskRefs: rows.map(row => {
        const task = this.taskFromRow(row);
        return { taskId: task.taskId, state: task.state, priority: task.priority, contextRef: task.contextRef, instructionRef: task.instructionRef, resultRef: task.resultRef };
      }),
      notifications: actor.role === "admin" || this.hasCapability(actor, "notification.receive")
        ? this.unread(actor, input.maxNotifications)
        : []
    } });
  }

  async alarm(): Promise<void> {
    const rows = this.ctx.storage.sql.exec<Row>("SELECT * FROM tasks WHERE state='queued' AND (not_before IS NULL OR not_before<=?) ORDER BY priority DESC,created_at ASC LIMIT 32", now()).toArray();
    let retryOffline = false;
    for (const row of rows) {
      const task = this.taskFromRow(row);
      if (task.deadline && Date.parse(task.deadline) <= Date.now()) {
        this.ctx.storage.sql.exec("UPDATE tasks SET state='cancelled',updated_at=? WHERE task_id=?", now(), task.taskId);
        continue;
      }
      if (!this.canReceiveTask(task)) {
        this.ctx.storage.sql.exec("UPDATE tasks SET state='blocked',updated_at=? WHERE task_id=?", now(), task.taskId);
        await this.publishNotification(notificationEnvelopeSchema.parse({
          version: 1,
          notificationId: "task-permission-" + task.taskId,
          audience: { kind: "admin" },
          type: "permission.required",
          severity: "action_required",
          title: "Task blocked by coordination policy",
          summary: "Task " + task.taskId + " needs task.receive permission for " + task.targetNodeId,
          createdAt: now(),
          taskId: task.taskId,
          requiresAck: true
        }));
        continue;
      }
      const online = this.sockets().some(item => item.actor.role === "node" && item.actor.nodeId === task.targetNodeId);
      if (!online) {
        retryOffline = true;
        continue;
      }
      this.ctx.storage.sql.exec("UPDATE tasks SET state='dispatched',attempts=attempts+1,updated_at=? WHERE task_id=?", now(), task.taskId);
      const message = JSON.stringify({ version: 1, type: "task.dispatch", observedAt: now(), payload: task });
      for (const item of this.sockets()) if (item.actor.role === "node" && item.actor.nodeId === task.targetNodeId) try { item.socket.send(message); } catch {}
    }
    await this.schedule();
    if (retryOffline) await this.ctx.storage.setAlarm(Date.now() + OFFLINE_RETRY_MS);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/ws") return await this.websocket(request);
      if (request.method === "POST" && path === "/nodes/hello") return await this.hello(request);
      if (request.method === "POST" && path === "/events") return await this.event(request);
      if (request.method === "POST" && path === "/approvals") return await this.approval(request);
      if (request.method === "POST" && path === "/receipts") return await this.receipt(request);
      if (request.method === "POST" && path === "/context/io") return await this.contextIo(request);
      if (request.method === "GET" && path === "/context/blob") return await this.contextBlob(request);
      if (request.method === "POST" && path === "/context/anchor") return await this.anchor(request);
      if (request.method === "POST" && path === "/context/delta") return await this.delta(request);
      if (request.method === "POST" && path === "/context/capsule") {
        const actor = this.actor(request);
        if (!this.hasCapability(actor, "context.read")) return this.capabilityDenied("context.read");
        const input = capsuleRequestSchema.parse(await readJson(request));
        try { return json({ ok: true, capsule: this.buildCapsule(input) }); }
        catch (cause) { if (cause instanceof Error && cause.message === "ANCHOR_NOT_FOUND") return error("ANCHOR_NOT_FOUND", "Context anchor not found.", 404); throw cause; }
      }
      if (request.method === "POST" && path === "/permissions/assign") return await this.assignPermission(request);
      if (request.method === "POST" && path === "/permissions/revoke") return await this.revokePermission(request);
      if (request.method === "GET" && path === "/permissions") return this.permissions(request);
      if (request.method === "POST" && path === "/tasks") return await this.createTask(request);
      if (request.method === "POST" && path === "/tasks/ack") return await this.ackTask(request);
      if (request.method === "GET" && path === "/tasks") return this.tasks(request);
      if (request.method === "POST" && path === "/notifications") return await this.notify(request);
      if (request.method === "GET" && path === "/notifications") {
        const actor = this.actor(request);
        if (!this.hasCapability(actor, "notification.receive")) return this.capabilityDenied("notification.receive");
        return json({ ok: true, notifications: this.unread(actor, MAX_LIST) });
      }
      if (request.method === "POST" && path === "/notifications/ack") {
        const input = notificationAckSchema.parse(await readJson(request));
        const actor = this.actor(request);
        if (input.clientId !== actor.clientId) return error("FORBIDDEN", "Ack clientId mismatch.", 403);
        this.ctx.storage.sql.exec("INSERT INTO notification_deliveries(notification_id,client_id,delivered_at,acked_at) VALUES(?,?,?,?) ON CONFLICT(notification_id,client_id) DO UPDATE SET acked_at=excluded.acked_at", input.notificationId, input.clientId, input.ackedAt, input.ackedAt);
        return json({ ok: true, notificationId: input.notificationId, ackedAt: input.ackedAt });
      }
      if (request.method === "POST" && path === "/model-envelope") return await this.modelEnvelope(request);
      if (request.method === "GET" && path === "/state") {
        if (this.actor(request).role !== "admin") return error("FORBIDDEN", "Admin plane required.", 403);
        return json({ ok: true, hub: this.ctx.id.name || "unnamed", onlineSockets: this.ctx.getWebSockets().length });
      }
      return error("NOT_FOUND", "Control Hub route not found.", 404);
    } catch (cause) {
      if (cause instanceof SyntaxError) return error("INVALID_JSON", "Request body is not valid JSON.", 400);
      if (cause instanceof Error && cause.message === "BODY_TOO_LARGE") return error("BODY_TOO_LARGE", "Request body exceeds limit.", 413);
      if (cause instanceof Error && cause.message === "INTERNAL_AUTH_CONTEXT") return error("INTERNAL_AUTH_CONTEXT", "Worker auth context missing.", 500);
      if (cause && typeof cause === "object" && "issues" in cause) return error("INVALID_PAYLOAD", "Payload does not match Control Hub contract.", 400);
      console.error("control_hub_error", cause);
      return error("INTERNAL_ERROR", "Control Hub could not process the request.", 500);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return json({ ok: true, name: "devspace-control-hub", protocolVersion: 1 });
    if (request.method === "GET" && url.pathname === "/") return json({ ok: true, name: "devspace-control-hub", role: "context-permission-scheduler-notification-relay", protocolVersion: 1, localExecutionAuthority: false });
    const targetPath = mapPath(url.pathname);
    if (!targetPath) return error("NOT_FOUND", "Control Hub route not found.", 404);
    const actor = await authenticate(request, env);
    if (actor instanceof Response) return actor;
    if (adminOnly(url.pathname, request.method) && actor.role !== "admin") return error("FORBIDDEN", "Admin plane required.", 403);
    const target = new URL(request.url);
    const parts = targetPath.split("?");
    target.pathname = parts[0];
    target.search = parts[1] ? "?" + parts[1] : url.search;
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.set("x-devspace-role", actor.role);
    headers.set("x-devspace-client-id", actor.clientId);
    if (actor.nodeId) headers.set("x-devspace-node-id", actor.nodeId);
    return env.CONTROL_HUB.getByName(env.HUB_NAME || "coldhao-primary").fetch(new Request(target, { method: request.method, headers, body: request.body, redirect: "manual" }));
  }
};
