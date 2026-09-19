import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig } from "./config.js";
import { startServer, type CreateServerOptions } from "./server.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { ProcessSessionManager } from "./process-sessions.js";
import type { RuntimeBuildIdentity } from "./runtime-build-identity.js";
import type { WorkspaceExecutionBoundaryVerification } from "./workspace-execution-boundary-verifier.js";

const verifiedRuntime: RuntimeBuildIdentity = {
  productVersion: "fixture",
  buildFingerprint: "a".repeat(64),
  startupSourceFingerprint: "a".repeat(64),
  freshness: "verified",
  buildNode: process.versions.node,
  packageManager: "pnpm@11.25.0",
  uiManifestSha256: "b".repeat(64),
  widgetUri: "ui://devspace/workspace-app-test.html",
};

const verifiedBoundary: WorkspaceExecutionBoundaryVerification = {
  verified: true,
  profile: "fixture-boundary-v2",
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

async function fixture(t: TestContext, options: CreateServerOptions = {}, bridge = false) {
  const root = await mkdtemp(join(tmpdir(), "devspace-readiness-"));
  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    server: { host: "127.0.0.1", port: 7676 },
    storage: { stateDir: join(root, "state") }, workspaces: { allowedRoots: [root] },
    skills: { enabled: false, agentDir: join(root, "agent") },
    subagents: { enabled: false, providers: [] }, bridge: { enabled: bridge }, logging: { level: "silent" },
  }));
  config.port = 0;
  const running = await startServer(config, {
    runtimeBuildIdentity: () => verifiedRuntime,
    workspaceExecutionBoundaryVerifier: () => verifiedBoundary,
    ...options,
  });
  const address = running.httpServer.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    await running.close();
    await new Promise<void>((resolve, reject) => running.httpServer.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const get = (path: string) => fetch(`http://127.0.0.1:${address.port}${path}`);
  return { running, get, root };
}

test("readiness checks owned databases and preserves the liveness contract", async t => {
  const { get, running } = await fixture(t);
  assert.deepEqual(await (await get("/healthz")).json(), { ok: true, name: "devspace" });
  const runtime = await (await get("/runtimez")).json();
  assert.equal(runtime.freshness, "verified");
  assert.equal(runtime.buildFingerprint, verifiedRuntime.buildFingerprint);
  for (let i = 0; i < 3; i++) {
    const response = await get("/readyz");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.checks.oauthDatabase, true);
    assert.equal(result.checks.workspaceDatabase, true);
    assert.equal(result.checks.buildFreshness, true);
    assert.equal(result.checks.workspaceExecutionBoundary, true);
    assert.equal(result.capabilities.executionBoundary.verified, true);
    assert.equal(result.activeProcesses, 0);
    assert.equal(result.activityKnown, true);
  }
  // Close the actual database handles but retain this fixture's HTTP listener.
  await running.close();
  const response = await get("/readyz");
  assert.equal(response.status, 503);
  const failed = await response.json();
  assert.equal(failed.checks.lifecycle, false);
  assert.equal(failed.checks.oauthDatabase, false);
  assert.equal(failed.checks.workspaceDatabase, false);
  assert.equal(failed.status, "degraded");
  assert.equal((await get("/healthz")).status, 200);
});

test("boundary verification is readiness-gating and refreshes at runtime", async t => {
  let receipt: WorkspaceExecutionBoundaryVerification = verifiedBoundary;
  const { get } = await fixture(t, {
    workspaceExecutionBoundaryVerifier: () => receipt,
    workspaceExecutionBoundaryVerificationTtlMs: 0,
  });
  assert.equal((await get("/readyz")).status, 200);
  receipt = {
    ...verifiedBoundary,
    verified: false,
    reason: "outside_write_allowed",
    checks: { ...verifiedBoundary.checks, outsideWriteBlocked: false },
  };
  const response = await get("/readyz");
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.equal(result.checks.workspaceExecutionBoundary, false);
  assert.equal(result.capabilities.executionBoundary.verified, false);
  assert.equal(result.capabilities.executionBoundary.reason, "outside_write_allowed");
});

test("runtime identity mismatch degrades readiness before serving as a fresh build", async t => {
  const { get } = await fixture(t, { runtimeBuildIdentity: () => ({
    ...verifiedRuntime,
    startupSourceFingerprint: "c".repeat(64),
    freshness: "mismatch",
  }) });
  assert.equal((await get("/runtimez")).status, 503);
  const readiness = await get("/readyz");
  assert.equal(readiness.status, 503);
  assert.equal((await readiness.json()).checks.buildFreshness, false);
});

test("missing required executor degrades readiness while optional PTY remains optional", async t => {
  const executors = { native: true, shell: true, pty: false };
  const { get } = await fixture(t, { executorReadiness: () => executors });
  const healthy = await get("/readyz");
  assert.equal(healthy.status, 200);
  assert.equal((await healthy.json()).capabilities.pty, false);
  executors.shell = false;
  const response = await get("/readyz");
  assert.equal(response.status, 503);
  assert.equal((await response.json()).checks.shellExecutor, false);
});

test("agent bridge activity is explicitly unknown and its database is probed", async t => {
  const { get } = await fixture(t, {}, true);
  const response = await get("/readyz");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.checks.bridgeDatabase, true);
  assert.equal(result.activityKnown, false);
  assert.equal(result.activeProcesses, null);
  assert.equal(result.processSessions, 0);
});

test("process activity count includes an actual native process until cancellation", async t => {
  const root = await mkdtemp(join(tmpdir(), "devspace-activity-"));
  const manager = new ProcessSessionManager();
  t.after(async () => { manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  assert.equal(manager.activeProcessCount, 0);
  const result = await manager.startProcess({ workspaceId: "fixture", workspaceRoot: root, cwd: root,
    executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], yieldTimeMs: 0 });
  assert.equal(manager.activeProcessCount, 1);
  await manager.cancelNative({ workspaceId: "fixture", sessionId: result.sessionId!, yieldTimeMs: 3000 });
  assert.equal(manager.activeProcessCount, 0);
});
