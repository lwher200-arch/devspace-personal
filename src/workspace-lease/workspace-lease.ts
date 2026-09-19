import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, type DatabaseHandle } from "../db/client.js";

export const WORKSPACE_LEASE_DURATION_SECONDS = [14_400, 28_800, 43_200, 86_400] as const;
export type WorkspaceLeaseDurationSeconds = typeof WORKSPACE_LEASE_DURATION_SECONDS[number];
export type WorkspaceLeaseState =
  | "requested"
  | "active"
  | "suspended"
  | "invalidated"
  | "revoked"
  | "expired";

export interface WorkspaceLeaseRecord {
  id: string;
  clientId: string;
  conversationScopeId: string;
  workspaceRoot: string;
  durationSeconds: WorkspaceLeaseDurationSeconds;
  policyVersion: string;
  boundaryProfile: string;
  state: WorkspaceLeaseState;
  requestedAt: string;
  issuedAt?: string;
  expiresAt?: string;
  updatedAt: string;
}

export interface WorkspaceLeaseRequest {
  clientId: string;
  conversationScopeId: string;
  workspaceRoot: string;
  durationSeconds: WorkspaceLeaseDurationSeconds;
  policyVersion: string;
  boundaryProfile: string;
}

export interface WorkspaceLeaseIdentity {
  clientId: string;
  conversationScopeId: string;
  workspaceRoot: string;
}

export interface WorkspaceLeaseRecoveryContext {
  clientId: string;
  conversationScopeId: string;
  workspaceRoot: string;
  policyVersion: string;
  boundaryProfile: string;
  boundaryVerified: boolean;
  emergencyFreeze: boolean;
}

export type WorkspaceLeaseRecoveryReason =
  | "verified"
  | "identity_mismatch"
  | "policy_mismatch"
  | "boundary_profile_mismatch"
  | "boundary_unverified"
  | "emergency_freeze"
  | "requested"
  | "revoked"
  | "expired"
  | "invalidated";

interface WorkspaceLeaseRow {
  id: string;
  client_id: string;
  conversation_scope_id: string;
  workspace_root: string;
  duration_seconds: number;
  policy_version: string;
  boundary_profile: string;
  state: WorkspaceLeaseState;
  requested_at: string;
  issued_at: string | null;
  expires_at: string | null;
  updated_at: string;
  integrity: string;
}

export class WorkspaceLeaseIntegrityError extends Error {
  constructor() {
    super("Workspace lease integrity verification failed.");
    this.name = "WorkspaceLeaseIntegrityError";
  }
}

export function workspaceLeaseIntegrityKeyPath(stateDir: string): string {
  return resolve(stateDir, "workspace-lease-integrity.key");
}

function assertDuration(value: number): asserts value is WorkspaceLeaseDurationSeconds {
  if (!(WORKSPACE_LEASE_DURATION_SECONDS as readonly number[]).includes(value)) {
    throw new RangeError("Workspace lease duration must be one of 4h, 8h, 12h or 24h.");
  }
}

function payload(row: Omit<WorkspaceLeaseRow, "integrity">): string {
  return JSON.stringify([
    row.id,
    row.client_id,
    row.conversation_scope_id,
    row.workspace_root,
    row.duration_seconds,
    row.policy_version,
    row.boundary_profile,
    row.state,
    row.requested_at,
    row.issued_at,
    row.expires_at,
    row.updated_at,
  ]);
}

function sign(key: Buffer, row: Omit<WorkspaceLeaseRow, "integrity">): string {
  return createHmac("sha256", key).update(payload(row)).digest("hex");
}

function equalHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function record(row: WorkspaceLeaseRow): WorkspaceLeaseRecord {
  assertDuration(row.duration_seconds);
  return {
    id: row.id,
    clientId: row.client_id,
    conversationScopeId: row.conversation_scope_id,
    workspaceRoot: row.workspace_root,
    durationSeconds: row.duration_seconds,
    policyVersion: row.policy_version,
    boundaryProfile: row.boundary_profile,
    state: row.state,
    requestedAt: row.requested_at,
    ...(row.issued_at ? { issuedAt: row.issued_at } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    updatedAt: row.updated_at,
  };
}

function loadIntegrityKey(stateDir: string): Buffer {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(stateDir, 0o700);
  const path = workspaceLeaseIntegrityKeyPath(stateDir);
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" });
  }
  if (process.platform !== "win32") chmodSync(path, 0o600);
  const key = readFileSync(path);
  if (key.length < 32) throw new WorkspaceLeaseIntegrityError();
  return key;
}

export class WorkspaceLeaseStore {
  private readonly database: DatabaseHandle;
  private readonly key: Buffer;
  private readonly now: () => number;

  constructor(
    private readonly stateDir: string,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.key = loadIntegrityKey(stateDir);
    this.database = openDatabase(stateDir);
  }

  close(): void {
    this.database.close();
  }

  request(input: WorkspaceLeaseRequest): WorkspaceLeaseRecord {
    assertDuration(input.durationSeconds);
    const timestamp = new Date(this.now()).toISOString();
    const row: Omit<WorkspaceLeaseRow, "integrity"> = {
      id: randomUUID(),
      client_id: input.clientId,
      conversation_scope_id: input.conversationScopeId,
      workspace_root: resolve(input.workspaceRoot),
      duration_seconds: input.durationSeconds,
      policy_version: input.policyVersion,
      boundary_profile: input.boundaryProfile,
      state: "requested",
      requested_at: timestamp,
      issued_at: null,
      expires_at: null,
      updated_at: timestamp,
    };
    const integrity = sign(this.key, row);
    this.database.sqlite.prepare(`
      insert into workspace_leases (
        id, client_id, conversation_scope_id, workspace_root, duration_seconds,
        policy_version, boundary_profile, state, requested_at, issued_at,
        expires_at, updated_at, integrity
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.client_id,
      row.conversation_scope_id,
      row.workspace_root,
      row.duration_seconds,
      row.policy_version,
      row.boundary_profile,
      row.state,
      row.requested_at,
      row.issued_at,
      row.expires_at,
      row.updated_at,
      integrity,
    );
    return record({ ...row, integrity });
  }

  get(id: string): WorkspaceLeaseRecord | undefined {
    const row = this.load(id);
    return row ? record(row) : undefined;
  }

  latestForContext(input: WorkspaceLeaseIdentity): WorkspaceLeaseRecord | undefined {
    const row = this.database.sqlite.prepare(`
      select id, client_id, conversation_scope_id, workspace_root, duration_seconds,
             policy_version, boundary_profile, state, requested_at, issued_at,
             expires_at, updated_at, integrity
      from workspace_leases
      where client_id = ? and conversation_scope_id = ? and workspace_root = ?
      order by updated_at desc, requested_at desc
      limit 1
    `).get(
      input.clientId,
      input.conversationScopeId,
      resolve(input.workspaceRoot),
    ) as WorkspaceLeaseRow | undefined;
    return row ? record(this.verify(row)) : undefined;
  }

  activate(id: string, input: { boundaryVerified: boolean }): WorkspaceLeaseRecord {
    if (!input.boundaryVerified) {
      throw new Error("Workspace lease activation requires a verified boundary.");
    }
    const row = this.require(id);
    if (row.state !== "requested") {
      throw new Error("Only a requested workspace lease can be activated.");
    }
    const now = this.now();
    row.state = "active";
    row.issued_at = new Date(now).toISOString();
    row.expires_at = new Date(now + row.duration_seconds * 1000).toISOString();
    row.updated_at = row.issued_at;
    this.persist(row);
    return record(row);
  }

  revoke(id: string): WorkspaceLeaseRecord {
    const row = this.require(id);
    if (!["expired", "invalidated"].includes(row.state)) {
      row.state = "revoked";
      row.updated_at = new Date(this.now()).toISOString();
      this.persist(row);
    }
    return record(row);
  }

  recover(
    id: string,
    context: WorkspaceLeaseRecoveryContext,
  ): { record: WorkspaceLeaseRecord; reason: WorkspaceLeaseRecoveryReason } {
    const row = this.require(id);
    const now = this.now();
    if (row.state === "revoked" || row.state === "invalidated" || row.state === "expired") {
      return { record: record(row), reason: row.state };
    }
    if (row.state === "requested") {
      return { record: record(row), reason: "requested" };
    }
    if (row.expires_at && Date.parse(row.expires_at) <= now) {
      return this.transition(row, "expired", "expired");
    }
    if (
      row.client_id !== context.clientId ||
      row.conversation_scope_id !== context.conversationScopeId ||
      row.workspace_root !== resolve(context.workspaceRoot)
    ) {
      return this.transition(row, "invalidated", "identity_mismatch");
    }
    if (row.policy_version !== context.policyVersion) {
      return this.transition(row, "invalidated", "policy_mismatch");
    }
    if (row.boundary_profile !== context.boundaryProfile) {
      return this.transition(row, "invalidated", "boundary_profile_mismatch");
    }
    if (context.emergencyFreeze) {
      return this.transition(row, "suspended", "emergency_freeze");
    }
    if (!context.boundaryVerified) {
      return this.transition(row, "suspended", "boundary_unverified");
    }
    return this.transition(row, "active", "verified");
  }

  private transition(
    row: WorkspaceLeaseRow,
    state: WorkspaceLeaseState,
    reason: WorkspaceLeaseRecoveryReason,
  ): { record: WorkspaceLeaseRecord; reason: WorkspaceLeaseRecoveryReason } {
    if (row.state !== state) {
      row.state = state;
      row.updated_at = new Date(this.now()).toISOString();
      this.persist(row);
    }
    return { record: record(row), reason };
  }

  private require(id: string): WorkspaceLeaseRow {
    const row = this.load(id);
    if (!row) throw new Error("Workspace lease is unavailable.");
    return row;
  }

  private load(id: string): WorkspaceLeaseRow | undefined {
    const row = this.database.sqlite.prepare(`
      select id, client_id, conversation_scope_id, workspace_root, duration_seconds,
             policy_version, boundary_profile, state, requested_at, issued_at,
             expires_at, updated_at, integrity
      from workspace_leases where id = ?
    `).get(id) as WorkspaceLeaseRow | undefined;
    if (!row) return undefined;
    return this.verify(row);
  }

  private verify(row: WorkspaceLeaseRow): WorkspaceLeaseRow {
    const { integrity, ...unsigned } = row;
    if (!equalHex(integrity, sign(this.key, unsigned))) throw new WorkspaceLeaseIntegrityError();
    return row;
  }

  private persist(row: WorkspaceLeaseRow): void {
    const { integrity: _oldIntegrity, ...unsigned } = row;
    row.integrity = sign(this.key, unsigned);
    this.database.sqlite.prepare(`
      update workspace_leases
      set client_id = ?, conversation_scope_id = ?, workspace_root = ?,
          duration_seconds = ?, policy_version = ?, boundary_profile = ?,
          state = ?, requested_at = ?, issued_at = ?, expires_at = ?,
          updated_at = ?, integrity = ?
      where id = ?
    `).run(
      row.client_id,
      row.conversation_scope_id,
      row.workspace_root,
      row.duration_seconds,
      row.policy_version,
      row.boundary_profile,
      row.state,
      row.requested_at,
      row.issued_at,
      row.expires_at,
      row.updated_at,
      row.integrity,
      row.id,
    );
  }
}
