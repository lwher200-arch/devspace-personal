import * as z from "zod/v4";
import {
  CONTROL_RELAY_PROTOCOL_VERSION,
  nodeIdentitySchema,
  notificationEnvelopeSchema,
  permissionAssignmentSchema,
  type NodeIdentity,
  type NotificationEnvelope,
  type PermissionAssignment,
} from "./relay-contract.js";

const id = z.string().trim().min(1).max(256);
const isoDate = z.iso.datetime({ offset: true });

const healthSchema = z.object({
  ok: z.literal(true),
  name: z.literal("devspace-control-hub"),
  protocolVersion: z.literal(CONTROL_RELAY_PROTOCOL_VERSION),
}).strict();

const helloResponseSchema = z.object({
  ok: z.literal(true),
  nodeId: id,
  instanceId: id,
  seenAt: isoDate,
}).strict();

const permissionsResponseSchema = z.object({
  ok: z.literal(true),
  assignments: z.array(permissionAssignmentSchema).max(100),
}).strict();

const notificationsResponseSchema = z.object({
  ok: z.literal(true),
  notifications: z.array(notificationEnvelopeSchema).max(100),
}).strict();

export interface ControlHubClientConfig {
  baseUrl: string;
  nodeId?: string;
  clientId: string;
  nodeToken?: string;
  timeoutMs: number;
}

export interface ControlHubClientDescription {
  baseUrl: string;
  nodeId?: string;
  clientId: string;
  authenticatedConfigured: boolean;
}

type FetchLike = typeof fetch;

export class ControlHubClientError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = "ControlHubClientError";
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("Control Hub URL must use HTTPS unless it targets loopback.");
  }
  if (url.username || url.password) throw new Error("Control Hub URL must not contain credentials.");
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function parseTimeout(value: string | undefined): number {
  if (!value?.trim()) return 10_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 60_000) {
    throw new Error("DEVSPACE_CONTROL_HUB_TIMEOUT_MS must be an integer from 1000 to 60000.");
  }
  return parsed;
}

export function controlHubClientConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ControlHubClientConfig | undefined {
  const rawBaseUrl = env.DEVSPACE_CONTROL_HUB_URL?.trim();
  if (!rawBaseUrl) return undefined;
  const nodeId = env.DEVSPACE_CONTROL_HUB_NODE_ID?.trim() || undefined;
  const nodeToken = env.DEVSPACE_CONTROL_HUB_NODE_TOKEN?.trim() || undefined;
  return {
    baseUrl: normalizeBaseUrl(rawBaseUrl),
    ...(nodeId ? { nodeId } : {}),
    clientId: env.DEVSPACE_CONTROL_HUB_CLIENT_ID?.trim() || "devspace-local",
    ...(nodeToken ? { nodeToken } : {}),
    timeoutMs: parseTimeout(env.DEVSPACE_CONTROL_HUB_TIMEOUT_MS),
  };
}

function errorDetail(value: unknown): { code?: string; message?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.code === "string" ? { code: record.code.slice(0, 128) } : {}),
    ...(typeof record.message === "string" ? { message: record.message.slice(0, 1024) } : {}),
  };
}

export class ControlHubClient {
  constructor(
    private readonly config: ControlHubClientConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  describe(): ControlHubClientDescription {
    return {
      baseUrl: this.config.baseUrl,
      ...(this.config.nodeId ? { nodeId: this.config.nodeId } : {}),
      clientId: this.config.clientId,
      authenticatedConfigured: Boolean(this.config.nodeId && this.config.nodeToken),
    };
  }

  async health() {
    return healthSchema.parse(await this.request("/healthz", { method: "GET" }, false));
  }

  async hello(identity: NodeIdentity) {
    const value = nodeIdentitySchema.parse(identity);
    return helloResponseSchema.parse(await this.request("/v1/nodes/hello", {
      method: "POST",
      body: JSON.stringify(value),
    }, true));
  }

  async permissions(): Promise<PermissionAssignment[]> {
    const value = permissionsResponseSchema.parse(
      await this.request("/v1/permissions", { method: "GET" }, true),
    );
    return value.assignments;
  }

  async notifications(): Promise<NotificationEnvelope[]> {
    const value = notificationsResponseSchema.parse(
      await this.request("/v1/notifications", { method: "GET" }, true),
    );
    return value.notifications;
  }

  private async request(
    path: string,
    init: RequestInit,
    authenticated: boolean,
  ): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (authenticated) {
      if (!this.config.nodeId || !this.config.nodeToken) {
        throw new ControlHubClientError(
          "Control Hub node authentication is not configured. Set DEVSPACE_CONTROL_HUB_NODE_ID and DEVSPACE_CONTROL_HUB_NODE_TOKEN.",
        );
      }
      headers.set("authorization", `Bearer ${this.config.nodeToken}`);
      headers.set("x-devspace-node-id", this.config.nodeId);
      headers.set("x-devspace-client-id", this.config.clientId);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, `${this.config.baseUrl}/`), {
        ...init,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new ControlHubClientError(`Control Hub request failed: ${message.slice(0, 512)}`);
    }

    const text = await response.text();
    let decoded: unknown = {};
    if (text) {
      try { decoded = JSON.parse(text); }
      catch { throw new ControlHubClientError(`Control Hub returned non-JSON HTTP ${response.status}.`, response.status); }
    }
    if (!response.ok) {
      const detail = errorDetail(decoded);
      throw new ControlHubClientError(
        `Control Hub HTTP ${response.status}${detail.code ? ` ${detail.code}` : ""}${detail.message ? `: ${detail.message}` : ""}.`,
        response.status,
        detail.code,
      );
    }
    return decoded;
  }
}
