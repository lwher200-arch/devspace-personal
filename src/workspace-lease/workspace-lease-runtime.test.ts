import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  A2_WORKSPACE_LEASE_POLICY_VERSION,
  WorkspaceLeaseRuntime,
} from "./workspace-lease-runtime.js";
import { WorkspaceLeaseStore } from "./workspace-lease.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devspace-workspace-lease-runtime-"));
  const project = join(root, "project");
  mkdirSync(project);
  const store = new WorkspaceLeaseStore(root);
  return { root, project, store };
}

const identity = {
  clientId: "fixture-client",
  conversationScopeId: "fixture-conversation",
};

function activeLease(store: WorkspaceLeaseStore, project: string, boundaryProfile = "fixture-boundary-v2") {
  return store.activate(store.request({
    ...identity,
    workspaceRoot: project,
    durationSeconds: 14_400,
    policyVersion: A2_WORKSPACE_LEASE_POLICY_VERSION,
    boundaryProfile,
  }).id, { boundaryVerified: true });
}

test("ACTIVE workspace lease is recognized but cannot bypass approval before Candidate Workspace exists", () => {
  const fx = fixture();
  try {
    activeLease(fx.store, fx.project);
    const observed = new WorkspaceLeaseRuntime(fx.store, { boundaryVerified: true }).observe({
      ...identity,
      workspaceRoot: fx.project,
      boundaryProfile: "fixture-boundary-v2",
    });
    assert.equal(observed.lease?.state, "active");
    assert.equal(observed.authorityActive, true);
    assert.equal(observed.executionEligible, false);
    assert.equal(observed.reason, "candidate_workspace_unavailable");
  } finally {
    fx.store.close();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("ACTIVE workspace lease becomes execution-eligible only when verified boundary and Candidate Workspace are both available", () => {
  const fx = fixture();
  try {
    activeLease(fx.store, fx.project);
    const observed = new WorkspaceLeaseRuntime(fx.store, { boundaryVerified: true }).observe({
      ...identity,
      workspaceRoot: fx.project,
      boundaryProfile: "fixture-boundary-v2",
      candidateAvailable: true,
    });
    assert.equal(observed.lease?.state, "active");
    assert.equal(observed.authorityActive, true);
    assert.equal(observed.executionEligible, true);
    assert.equal(observed.reason, "ready");
  } finally {
    fx.store.close();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("runtime recovery suspends an ACTIVE lease when the boundary is not verified", () => {
  const fx = fixture();
  try {
    activeLease(fx.store, fx.project);
    const observed = new WorkspaceLeaseRuntime(fx.store).observe({
      ...identity,
      workspaceRoot: fx.project,
      boundaryProfile: "fixture-boundary-v2",
    });
    assert.equal(observed.lease?.state, "suspended");
    assert.equal(observed.authorityActive, false);
    assert.equal(observed.executionEligible, false);
    assert.equal(observed.reason, "boundary_unverified");
  } finally {
    fx.store.close();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("runtime rechecks a dynamic boundary verification source and fails closed after verification is lost", () => {
  const fx = fixture();
  let verified = true;
  try {
    activeLease(fx.store, fx.project);
    const runtime = new WorkspaceLeaseRuntime(fx.store, {
      boundaryVerified: () => verified,
    });
    const ready = runtime.observe({
      ...identity,
      workspaceRoot: fx.project,
      boundaryProfile: "fixture-boundary-v2",
      candidateAvailable: true,
    });
    assert.equal(ready.executionEligible, true);
    assert.equal(ready.reason, "ready");

    verified = false;
    const suspended = runtime.observe({
      ...identity,
      workspaceRoot: fx.project,
      boundaryProfile: "fixture-boundary-v2",
      candidateAvailable: true,
    });
    assert.equal(suspended.lease?.state, "suspended");
    assert.equal(suspended.executionEligible, false);
    assert.equal(suspended.reason, "boundary_unverified");
  } finally {
    fx.store.close();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("runtime recovery invalidates a lease when the effective boundary profile changes", () => {
  const fx = fixture();
  try {
    activeLease(fx.store, fx.project, "fixture-boundary-v1");
    const observed = new WorkspaceLeaseRuntime(fx.store, { boundaryVerified: true }).observe({
      ...identity,
      workspaceRoot: fx.project,
      boundaryProfile: "fixture-boundary-v2",
    });
    assert.equal(observed.lease?.state, "invalidated");
    assert.equal(observed.authorityActive, false);
    assert.equal(observed.executionEligible, false);
    assert.equal(observed.reason, "boundary_profile_mismatch");
  } finally {
    fx.store.close();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("runtime never borrows a lease from another conversation", () => {
  const fx = fixture();
  try {
    activeLease(fx.store, fx.project);
    const observed = new WorkspaceLeaseRuntime(fx.store, { boundaryVerified: true }).observe({
      clientId: identity.clientId,
      conversationScopeId: "other-conversation",
      workspaceRoot: fx.project,
      boundaryProfile: "fixture-boundary-v2",
    });
    assert.equal(observed.lease, undefined);
    assert.equal(observed.authorityActive, false);
    assert.equal(observed.reason, "no_lease");
  } finally {
    fx.store.close();
    rmSync(fx.root, { recursive: true, force: true });
  }
});
