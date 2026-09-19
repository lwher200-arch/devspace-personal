import assert from "node:assert/strict";
import test from "node:test";
import {
  BubblewrapWorkspaceExecutionBoundary,
  type WorkspaceExecutionBoundary,
} from "./workspace-execution-boundary.js";
import {
  WorkspaceExecutionBoundaryVerificationCache,
  verifyWorkspaceExecutionBoundary,
} from "./workspace-execution-boundary-verifier.js";

test("boundary self-test fails closed when no boundary exists", () => {
  const result = verifyWorkspaceExecutionBoundary(undefined);
  assert.equal(result.verified, false);
  assert.equal(result.reason, "boundary_unavailable");
});

test("boundary self-test rejects an unconfined boundary by behavior", () => {
  const boundary: WorkspaceExecutionBoundary = {
    profile: "fixture-unconfined",
    prepare(input) {
      return {
        executable: input.executable,
        args: input.args,
        boundaryProfile: this.profile,
      };
    },
  };
  const result = verifyWorkspaceExecutionBoundary(boundary);
  assert.equal(result.verified, false);
  assert.equal(result.checks.workspaceWrite, true);
  assert.equal(result.checks.outsideWriteBlocked, false);
  assert.equal(result.reason, "outside_write_allowed");
});

test("real bubblewrap self-test is either verified or fails closed with an explicit reason", (t) => {
  if (process.platform !== "linux") {
    t.skip("Bubblewrap boundary is Linux-only.");
    return;
  }
  const result = verifyWorkspaceExecutionBoundary(
    new BubblewrapWorkspaceExecutionBoundary("bwrap"),
  );
  if (result.verified) {
    assert.equal(result.reason, "verified");
    assert.deepEqual(result.checks, {
      profileMatch: true,
      workspaceWrite: true,
      outsideWriteBlocked: true,
      protectedEnvWriteBlocked: true,
      hostControlSocketsMasked: true,
      sensitiveEnvironmentBlocked: true,
      networkNoneIsolated: true,
    });
    return;
  }
  assert.notEqual(result.reason, "verified");
  assert.equal(
    ["spawn_failed", "probe_failed"].includes(result.reason),
    true,
    `unexpected verification failure: ${JSON.stringify(result)}`,
  );
});

test("boundary verification cache refreshes after TTL and converts verifier exceptions to fail-closed receipts", () => {
  let now = 0;
  let calls = 0;
  let throwVerification = false;
  const boundary: WorkspaceExecutionBoundary = {
    profile: "fixture-boundary",
    prepare(input) {
      return { executable: input.executable, args: input.args, boundaryProfile: this.profile };
    },
  };
  const cache = new WorkspaceExecutionBoundaryVerificationCache(boundary, {
    now: () => now,
    ttlMs: 30_000,
    verify: current => {
      calls += 1;
      if (throwVerification) throw new Error("fixture verifier failure");
      return {
        verified: true,
        profile: current?.profile,
        reason: "verified",
        checks: {
          profileMatch: true,
          workspaceWrite: true,
          outsideWriteBlocked: true,
          protectedEnvWriteBlocked: true,
          hostControlSocketsMasked: true,
          sensitiveEnvironmentBlocked: true,
          networkNoneIsolated: true,
        },
      };
    },
  });
  assert.equal(cache.current().verified, true);
  assert.equal(calls, 1);
  now = 29_999;
  assert.equal(cache.current().verified, true);
  assert.equal(calls, 1);
  now = 30_000;
  throwVerification = true;
  const failed = cache.current();
  assert.equal(calls, 2);
  assert.equal(failed.verified, false);
  assert.equal(failed.reason, "verification_error");
});
