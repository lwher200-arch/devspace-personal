import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Result } from "better-result";
import { LocalAgentManager } from "./local-agent-manager.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { LocalAgentClient } from "./local-agent-client.js";
import { LocalAgentDaemon } from "./local-agent-daemon.js";
import type { LocalAgentRunInput } from "./local-agent-runtime.js";

const policy = { requiredModel: "gpt-6-astra", minimumCliVersion: "0.153.0" };
test("manager retains policy and evidence across persistence, protects reviewers, and rejects inherited resume models", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-manager-policy-"));
  const store = new LocalAgentStore(join(root, "state"));
  const inputs: LocalAgentRunInput[] = [];
  let withEvidence = true;
  const manager = new LocalAgentManager({ store, pool: new LocalAgentRuntimePool(),
    codexExecutionPolicy: policy,
    subagents: { enabled: true, providers: [{ id: "codex", enabled: true, model: "gpt-5.6-sol" }] },
    loadProfiles: async () => [{ name: "reviewer", description: "test", provider: "codex", body: "Read only.", writeMode: "read_only", filePath: join(root, "reviewer.md"), disabled: false }],
    drivers: [{ provider: "codex", runtimeKey: context => context.agentId, createRuntime: async () => Result.ok({
      provider: "codex", isAlive: () => true, close: async () => {}, releaseSession: async () => {},
      run: async input => { inputs.push(input); return Result.ok({ provider: "codex", providerSessionId: "thread", finalResponse: "done", items: [],
        ...(withEvidence ? { executionEvidence: { requestedModel: input.model!, sessionModel: input.model!, runtimeModel: input.model!,
          cliVersion: "0.153.4", executable: "verified-cli", threadId: "thread", turnId: `turn-${inputs.length}`, source: "codex-rollout/turn_context" as const,
          sandbox: "readOnly" as const, approvalPolicy: "never" as const } } : {}) }); },
    }) }],
  });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const scope = { workspaceRoot: root };
  const wait = async (id: string) => {
    for (let i=0;i<200 && store.get(id)?.status === "running";i++) await new Promise(resolve => setTimeout(resolve, 5));
    return store.get(id)!;
  };
  assert.equal((await manager.start({ target: "reviewer", prompt: "test", ...scope, executionPolicy: policy })).isErr(), true);
  assert.equal(inputs.length, 0);
  const mcpScope = { ...scope, workspaceId: "ws_mcp" };
  assert.equal((await manager.start({ target: "reviewer", prompt: "missing explicit model", ...mcpScope })).isErr(), true);
  const automatic = await manager.start({ target: "reviewer", prompt: "MCP policy", ...mcpScope, model: "gpt-6-astra" });
  assert.ok(automatic.isOk()); if (automatic.isErr()) return;
  assert.deepEqual((await wait(automatic.value.id)).executionPolicy, policy);
  const manual = await manager.start({ target: "codex", prompt: "manual legacy", ...scope, model: "gpt-5.6-sol" });
  assert.ok(manual.isOk()); if (manual.isErr()) return;
  assert.equal((await wait(manual.value.id)).executionPolicy, undefined);
  const started = await manager.start({ target: "reviewer", prompt: "test", ...scope, model: "gpt-6-astra", executionPolicy: policy, writeMode: "allowed" });
  assert.ok(started.isOk()); if (started.isErr()) return;
  const finished = await wait(started.value.id);
  assert.equal(finished.status, "idle");
  assert.equal(finished.executionEvidence?.runtimeModel, "gpt-6-astra");
  assert.equal(inputs[0].writeMode, "read_only");
  const reopened = new LocalAgentStore(join(root, "state"));
  assert.deepEqual(reopened.get(finished.id)?.executionPolicy, policy);
  assert.equal(reopened.get(finished.id)?.executionEvidence?.turnId, finished.executionEvidence?.turnId);
  reopened.close();
  assert.equal((await manager.continue(finished.id, "missing model", {}, scope)).isErr(), true);
  assert.equal((await manager.continue(finished.id, "bad model", { model: "gpt-5.6-sol" }, scope)).isErr(), true);
  assert.equal((await manager.continue(finished.id, "weaken", { model: "gpt-6-astra", executionPolicy: { ...policy, minimumCliVersion: "0.1.0" } }, scope)).isErr(), true);
  withEvidence = false;
  const continued = await manager.continue(finished.id, "no evidence", { model: "gpt-6-astra", writeMode: "allowed" }, scope);
  assert.ok(continued.isOk());
  const failed = await wait(finished.id);
  assert.equal(failed.status, "error");
  assert.equal(failed.executionEvidence, undefined);
  assert.equal(failed.latestResponse, undefined);
  assert.equal(inputs.at(-1)?.writeMode, "read_only");
});

test("client refuses to deliver guarded work to a daemon without policy capability", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-old-policy-daemon-"));
  let calls = 0;
  const manager: any = { activeTurnCount: 0, runtimeCount: 0, evictIdle: async () => {}, close: async () => {},
    start: async () => { calls++; throw new Error("must not be called"); } };
  const daemon = new LocalAgentDaemon({ stateDir: root, manager });
  const status = daemon.status.bind(daemon);
  daemon.status = () => ({ ...status(), executionPolicyVersion: undefined });
  t.after(async () => { await daemon.close(); await rm(root, { recursive: true, force: true }); });
  await daemon.start();
  const client = new LocalAgentClient({ stateDir: root, spawnDaemon: () => { throw new Error("must not spawn"); } });
  const result = await client.start({ target: "codex", workspaceRoot: root, prompt: "test", model: "gpt-6-astra", executionPolicy: policy });
  assert.equal(result.isErr(), true);
  if (result.isErr()) assert.equal(result.error.code, "DAEMON_PROTOCOL_MISMATCH");
  assert.equal(calls, 0);
});
