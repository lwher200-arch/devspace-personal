import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { databasePath } from "../db/client.js";
import {
  WORKSPACE_LEASE_DURATION_SECONDS,
  WorkspaceLeaseIntegrityError,
  WorkspaceLeaseStore,
  workspaceLeaseIntegrityKeyPath,
} from "./workspace-lease.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devspace-workspace-lease-test-"));
  const project = join(root, "project");
  mkdirSync(project);
  let now = Date.UTC(2026, 8, 18, 10, 0, 0);
  const store = new WorkspaceLeaseStore(root, { now: () => now });
  return {
    root,
    project,
    store,
    now: () => now,
    advance: (milliseconds: number) => { now += milliseconds; },
  };
}

const identity = {
  clientId: "fixture-client",
  conversationScopeId: "fixture-conversation",
};

test("workspace lease supports only the explicit 4h/8h/12h/24h durations", () => {
  assert.deepEqual(WORKSPACE_LEASE_DURATION_SECONDS, [14_400, 28_800, 43_200, 86_400]);
  const fx = fixture();
  try {
    for (const durationSeconds of WORKSPACE_LEASE_DURATION_SECONDS) {
      const requested = fx.store.request({
        ...identity,
        workspaceRoot: fx.project,
        durationSeconds,
        policyVersion: "a2-v1",
        boundaryProfile: "candidate-linux-v1",
      });
      assert.equal(requested.state, "requested");
      assert.equal(requested.issuedAt, undefined);
      assert.equal(requested.expiresAt, undefined);
    }
    assert.throws(() => fx.store.request({
      ...identity,
      workspaceRoot: fx.project,
      durationSeconds: 3600 as never,
      policyVersion: "a2-v1",
      boundaryProfile: "candidate-linux-v1",
    }), /duration/i);
  } finally {
    fx.store.close();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("activation requires a verified boundary and starts the fixed lease deadline at approval time", () => {
  const fx = fixture();
  try {
    const requested = fx.store.request({
      ...identity,
      workspaceRoot: fx.project,
      durationSeconds: 14_400,
      policyVersion: "a2-v1",
      boundaryProfile: "candidate-linux-v1",
    });
    fx.advance(90_000);
    assert.throws(() => fx.store.activate(requested.id, { boundaryVerified: false }), /verified boundary/i);
    assert.equal(fx.store.get(requested.id)?.state, "requested");
    const active = fx.store.activate(requested.id, { boundaryVerified: true });
    assert.equal(active.state, "active");
    assert.equal(active.issuedAt, new Date(fx.now()).toISOString());
    assert.equal(active.expiresAt, new Date(fx.now() + 14_400_000).toISOString());
    fx.advance(60_000);
    assert.equal(fx.store.get(active.id)?.expiresAt, active.expiresAt, "lease use must not slide the deadline");
  } finally {
    fx.store.close();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("integrity key is stable, private and detects persisted lease tampering", () => {
  const fx = fixture();
  try {
    const requested = fx.store.request({
      ...identity,
      workspaceRoot: fx.project,
      durationSeconds: 28_800,
      policyVersion: "a2-v1",
      boundaryProfile: "candidate-linux-v1",
    });
    const active = fx.store.activate(requested.id, { boundaryVerified: true });
    const keyPath = workspaceLeaseIntegrityKeyPath(fx.root);
    const keyBefore = readFileSync(keyPath);
    if (process.platform !== "win32") assert.equal(statSync(keyPath).mode & 0o777, 0o600);
    fx.store.close();

    const reopened = new WorkspaceLeaseStore(fx.root, { now: fx.now });
    assert.deepEqual(readFileSync(keyPath), keyBefore);
    assert.equal(reopened.get(active.id)?.state, "active");
    reopened.close();

    const raw = new Database(databasePath(fx.root));
    try {
      raw.prepare("update workspace_leases set client_id = ? where id = ?").run("tampered-client", active.id);
    } finally { raw.close(); }
    const tampered = new WorkspaceLeaseStore(fx.root, { now: fx.now });
    try {
      assert.throws(() => tampered.get(active.id), WorkspaceLeaseIntegrityError);
    } finally { tampered.close(); }
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("recovery revalidates identity, policy, boundary and emergency freeze instead of trusting persisted ACTIVE", () => {
  const scenarios = [
    { name: "valid", patch: {}, expected: "active", reason: "verified" },
    { name: "client mismatch", patch: { clientId: "other-client" }, expected: "invalidated", reason: "identity_mismatch" },
    { name: "policy mismatch", patch: { policyVersion: "a2-v2" }, expected: "invalidated", reason: "policy_mismatch" },
    { name: "boundary unavailable", patch: { boundaryVerified: false }, expected: "suspended", reason: "boundary_unverified" },
    { name: "emergency freeze", patch: { emergencyFreeze: true }, expected: "suspended", reason: "emergency_freeze" },
  ] as const;
  for (const scenario of scenarios) {
    const fx = fixture();
    try {
      const active = fx.store.activate(fx.store.request({
        ...identity,
        workspaceRoot: fx.project,
        durationSeconds: 43_200,
        policyVersion: "a2-v1",
        boundaryProfile: "candidate-linux-v1",
      }).id, { boundaryVerified: true });
      fx.store.close();
      const reopened = new WorkspaceLeaseStore(fx.root, { now: fx.now });
      const recovered = reopened.recover(active.id, {
        ...identity,
        workspaceRoot: fx.project,
        policyVersion: "a2-v1",
        boundaryProfile: "candidate-linux-v1",
        boundaryVerified: true,
        emergencyFreeze: false,
        ...scenario.patch,
      });
      assert.equal(recovered.record.state, scenario.expected, scenario.name);
      assert.equal(recovered.reason, scenario.reason, scenario.name);
      assert.equal(reopened.get(active.id)?.state, scenario.expected, `${scenario.name} persists its recovery state`);
      reopened.close();
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }
});

test("expired and revoked leases never recover to ACTIVE", () => {
  const fx = fixture();
  try {
    const expired = fx.store.activate(fx.store.request({
      ...identity,
      workspaceRoot: fx.project,
      durationSeconds: 14_400,
      policyVersion: "a2-v1",
      boundaryProfile: "candidate-linux-v1",
    }).id, { boundaryVerified: true });
    const revoked = fx.store.activate(fx.store.request({
      clientId: identity.clientId,
      conversationScopeId: "revoked-conversation",
      workspaceRoot: fx.project,
      durationSeconds: 86_400,
      policyVersion: "a2-v1",
      boundaryProfile: "candidate-linux-v1",
    }).id, { boundaryVerified: true });
    fx.store.revoke(revoked.id);
    fx.advance(14_400_000);
    assert.equal(fx.store.recover(expired.id, {
      ...identity, workspaceRoot: fx.project, policyVersion: "a2-v1",
      boundaryProfile: "candidate-linux-v1", boundaryVerified: true, emergencyFreeze: false,
    }).record.state, "expired");
    assert.equal(fx.store.recover(revoked.id, {
      clientId: identity.clientId, conversationScopeId: "revoked-conversation",
      workspaceRoot: fx.project, policyVersion: "a2-v1",
      boundaryProfile: "candidate-linux-v1", boundaryVerified: true, emergencyFreeze: false,
    }).record.state, "revoked");
  } finally {
    fx.store.close();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("pre-existing weak integrity-key permissions are corrected before use", () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "devspace-workspace-lease-key-test-"));
  try {
    const keyPath = workspaceLeaseIntegrityKeyPath(root);
    mkdirSync(root, { recursive: true });
    const store = new WorkspaceLeaseStore(root);
    store.close();
    chmodSync(keyPath, 0o644);
    const reopened = new WorkspaceLeaseStore(root);
    reopened.close();
    assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
