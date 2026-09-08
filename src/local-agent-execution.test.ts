import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertExecutionSelection, readCodexTurnEvidence, selectExecutionModel, executionPolicySchema, sameExecutionPolicy } from "./local-agent-execution.js";
import { loadConfig } from "./config.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const policy = { requiredModel: "gpt-6-astra", minimumCliVersion: "0.153.0" };
test('dual-model routing is explicit, deterministic and cannot expand its allowlist', () => {
  const routed = { ...policy, allowedModels:['gpt-6-astra','gpt-5.6-sol'], routing:{routineModel:'gpt-5.6-sol',complexModel:'gpt-6-astra'} };
  assert.equal(selectExecutionModel(routed,'auto','Fix a typo').model,'gpt-5.6-sol');
  assert.equal(selectExecutionModel(routed,undefined,'Security architecture review').model,'gpt-6-astra');
  assert.equal(selectExecutionModel(routed,'gpt-5.6-sol','Security review').reason,'explicit');
  assert.throws(()=>selectExecutionModel(routed,'gpt-5.5','test'),/explicit model/);
  assert.throws(()=>selectExecutionModel(policy,'auto','test'),/explicit model/);
  for(const model of routed.allowedModels) assert.doesNotThrow(()=>assertExecutionSelection(routed,model,'0.153.4'));
  assert.equal(sameExecutionPolicy(policy,routed),false);
  assert.throws(()=>executionPolicySchema.parse({...routed,routing:{routineModel:'unapproved',complexModel:'gpt-6-astra'}}),/allowlist/);
});
test("persisted configuration carries the bridge execution policy without changing provider defaults", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-policy-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = loadConfig(writeTestDevspaceConfig(root, {
    bridge: { enabled: true, allowWorkspaceWrite: true, executionPolicy: policy },
    subagents: { enabled: true, providers: [{ id: "codex", enabled: true, model: "gpt-5.6-sol" }] },
  }));
  assert.deepEqual(config.bridge, { enabled: true, allowWorkspaceWrite: true, executionPolicy: policy });
  assert.equal(config.subagents.providers[0].model, "gpt-5.6-sol");
});
test("execution selection fails closed without an approved explicit model and actual version", () => {
  assert.throws(() => assertExecutionSelection(policy, undefined, "0.153.4"), /model/i);
  assert.throws(() => assertExecutionSelection(policy, "gpt-5.6-sol", "0.153.4"), /model/i);
  assert.throws(() => assertExecutionSelection(policy, "gpt-6-astra", undefined), /version/i);
  assert.throws(() => assertExecutionSelection(policy, "gpt-6-astra", "0.152.0"), /version/i);
  assert.throws(() => assertExecutionSelection(policy, "gpt-6-astra", "0.153.0-beta"), /version/i);
  assert.doesNotThrow(() => assertExecutionSelection(policy, "gpt-6-astra", "0.153.4"));
});

test("model evidence is scoped to the exact provider turn, not thread config or prose", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "devspace-execution-evidence-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "sessions"));
  const path = join(home, "sessions", "rollout.jsonl");
  await writeFile(path, [
    { type: "turn_context", payload: { turn_id: "old", model: "gpt-5.6-sol" } },
    { type: "response_item", payload: { text: "I am gpt-6-astra" } },
    { type: "turn_context", payload: { turn_id: "current", model: "gpt-6-astra" } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  assert.equal(await readCodexTurnEvidence(home, path, "current"), "gpt-6-astra");
  await assert.rejects(readCodexTurnEvidence(home, path, "missing"), /evidence/i);
  await assert.rejects(readCodexTurnEvidence(home, join(home, "outside.jsonl"), "current"), /outside/i);
  await writeFile(path, JSON.stringify({ type: "response_item", payload: { text: "gpt-6-astra" } }) + "\n");
  await assert.rejects(readCodexTurnEvidence(home, path, "current"), /evidence/i);
});
