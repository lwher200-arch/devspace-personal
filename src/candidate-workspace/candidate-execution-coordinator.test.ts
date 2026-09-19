import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProcessSnapshot } from "../process-sessions.js";
import {
  A2_WORKSPACE_LEASE_POLICY_VERSION,
  WorkspaceLeaseRuntime,
} from "../workspace-lease/workspace-lease-runtime.js";
import { WorkspaceLeaseStore } from "../workspace-lease/workspace-lease.js";
import { FilesystemCandidateWorkspaceProvider } from "./candidate-workspace.js";
import {
  CandidateExecutionCoordinator,
  CandidateExecutionError,
} from "./candidate-execution-coordinator.js";

function fixture(boundaryVerified = true, candidateInsideStable = false) {
  const root = mkdtempSync(join(tmpdir(), "devspace-candidate-execution-"));
  const stable = join(root, "stable");
  mkdirSync(stable, { recursive: true });
  writeFileSync(join(stable, "value.txt"), "stable\n");
  const store = new WorkspaceLeaseStore(join(root, "state"));
  const identity = { clientId: "client-a", conversationScopeId: "chat-a" };
  store.activate(store.request({
    ...identity,
    workspaceRoot: stable,
    durationSeconds: 14_400,
    policyVersion: A2_WORKSPACE_LEASE_POLICY_VERSION,
    boundaryProfile: "fixture-boundary-v2",
  }).id, { boundaryVerified: true });
  const runtime = new WorkspaceLeaseRuntime(store, { boundaryVerified });
  const provider = new FilesystemCandidateWorkspaceProvider(
    candidateInsideStable ? join(stable, ".candidate") : join(root, "candidates"),
  );
  const coordinator = new CandidateExecutionCoordinator(
    runtime,
    provider,
    "fixture-boundary-v2",
  );
  return { root, stable, store, identity, coordinator };
}

function snapshot(input: Partial<ProcessSnapshot> = {}): ProcessSnapshot {
  return {
    output: "",
    outputTruncated: false,
    running: false,
    exitCode: 0,
    wallTimeMs: 1,
    ...input,
  };
}

test("eligible lease grants one Candidate execution and Stable Workspace remains unchanged", async t => {
  if (process.platform !== "linux") { t.skip("Candidate execution v0.1 is Linux-only."); return; }
  const fx = fixture();
  try {
    const authorized = await fx.coordinator.authorizeRequest({
      ...fx.identity,
      workspaceId: "ws-a",
      stableRoot: fx.stable,
      tool: "exec_command",
    });
    assert.equal(authorized.observation.executionEligible, true);
    assert.equal(authorized.observation.reason, "ready");
    assert.ok(authorized.grantToken);

    const plan = await fx.coordinator.beginGrantedExecution({
      grantToken: authorized.grantToken,
      workspaceId: "ws-a",
      stableRoot: fx.stable,
      stableCwd: fx.stable,
      tool: "exec_command",
    });
    assert.ok(plan);
    assert.equal(plan.networkProfile, "none");
    writeFileSync(join(plan.workspaceRoot, "value.txt"), "candidate\n");
    writeFileSync(join(plan.workspaceRoot, "created.txt"), "new\n");
    assert.equal(readFileSync(join(fx.stable, "value.txt"), "utf8"), "stable\n");
    assert.equal(existsSync(join(fx.stable, "created.txt")), false);

    const evidence = await fx.coordinator.observeSnapshot(plan, snapshot());
    assert.equal(evidence.state, "completed");
    assert.equal(evidence.networkProfile, "none");
    assert.deepEqual(evidence.mutation?.created, ["created.txt"]);
    assert.deepEqual(evidence.mutation?.modified, ["value.txt"]);
    assert.equal(evidence.mutation?.stableChanged, false);

    await assert.rejects(
      () => fx.coordinator.beginGrantedExecution({
        grantToken: authorized.grantToken,
        workspaceId: "ws-a",
        stableRoot: fx.stable,
        stableCwd: fx.stable,
        tool: "exec_command",
      }),
      CandidateExecutionError,
      "candidate grant is single-use",
    );
  } finally {
    await fx.coordinator.close();
    fx.store.close();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("long-running process keeps Candidate bound until the same session completes", async t => {
  if (process.platform !== "linux") { t.skip("Candidate execution v0.1 is Linux-only."); return; }
  const fx = fixture();
  try {
    const authorized = await fx.coordinator.authorizeRequest({
      ...fx.identity,
      workspaceId: "ws-long",
      stableRoot: fx.stable,
      tool: "run_process",
    });
    const plan = await fx.coordinator.beginGrantedExecution({
      grantToken: authorized.grantToken,
      workspaceId: "ws-long",
      stableRoot: fx.stable,
      stableCwd: fx.stable,
      tool: "run_process",
    });
    assert.ok(plan);
    assert.equal(plan.networkProfile, "none");

    writeFileSync(join(plan.workspaceRoot, "running.txt"), "one\n");
    const running = await fx.coordinator.observeSnapshot(plan, snapshot({ running: true, sessionId: 7 }));
    assert.equal(running.state, "running");
    assert.equal(running.networkProfile, "none");
    assert.equal(running.mutation, undefined);

    writeFileSync(join(plan.workspaceRoot, "running.txt"), "two\n");
    const stillRunning = await fx.coordinator.observeSession(
      "ws-long",
      7,
      snapshot({ running: true, sessionId: 7 }),
    );
    assert.equal(stillRunning?.candidateId, running.candidateId);
    assert.equal(stillRunning?.state, "running");

    const completed = await fx.coordinator.observeSession("ws-long", 7, snapshot());
    assert.equal(completed?.state, "completed");
    assert.deepEqual(completed?.mutation?.created, ["running.txt"]);
    assert.equal(readFileSync(join(fx.stable, "value.txt"), "utf8"), "stable\n");
    assert.equal(await fx.coordinator.observeSession("ws-long", 7, snapshot()), undefined);
  } finally {
    await fx.coordinator.close();
    fx.store.close();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("unverified boundary and unavailable Candidate Provider never mint an execution grant", async t => {
  if (process.platform !== "linux") { t.skip("Candidate execution v0.1 is Linux-only."); return; }
  for (const scenario of [
    { boundaryVerified: false, candidateInsideStable: false, reason: "boundary_unverified" },
    { boundaryVerified: true, candidateInsideStable: true, reason: "candidate_workspace_unavailable" },
  ] as const) {
    const fx = fixture(scenario.boundaryVerified, scenario.candidateInsideStable);
    try {
      const authorization = await fx.coordinator.authorizeRequest({
        ...fx.identity,
        workspaceId: "ws-denied",
        stableRoot: fx.stable,
        tool: "bash",
      });
      assert.equal(authorization.observation.executionEligible, false);
      assert.equal(authorization.observation.reason, scenario.reason);
      assert.equal(authorization.grantToken, undefined);
    } finally {
      await fx.coordinator.close();
      fx.store.close();
      rmSync(fx.root, { recursive: true, force: true });
    }
  }
});
