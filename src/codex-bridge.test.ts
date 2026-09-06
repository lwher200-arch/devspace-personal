import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Result } from "better-result";
import { CodexBridge } from "./codex-bridge.js";
import { loadConfig } from "./config.js";
import type { LocalAgentRecord } from "./local-agent-store.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

test("configured bridge requires explicit models, gates old CLI, and withholds unverified history", async () => {
  const temp = mkdtempSync(join(tmpdir(), "devspace-bridge-policy-"));
  const config = loadConfig(writeTestDevspaceConfig(join(temp, "config"), { storage: { stateDir: join(temp, "state") } }));
  const policy = { requiredModel: "gpt-6-astra", minimumCliVersion: "0.153.0" };
  config.bridge = { enabled: true, allowWorkspaceWrite: false, executionPolicy: policy };
  const scope = { workspaceRoot: temp };
  const record: LocalAgentRecord = { id: "agt_policy", ...scope, profileName: "codex", provider: "codex", model: "gpt-6-astra", status: "running", createdAt: "now", updatedAt: "now" };
  let calls = 0;
  let version = "0.152.0";
  const client = {
    start: async (input: any) => { calls++; assert.equal(input.model, "gpt-6-astra"); assert.deepEqual(input.executionPolicy, policy); return Result.ok(record); },
    continue: async (_id: string, _prompt: string, overrides: any) => { calls++; assert.equal(overrides.model, "gpt-6-astra"); assert.deepEqual(overrides.executionPolicy, policy); return Result.ok(record); },
    get: async () => Result.ok(record), list: async () => Result.ok([]),
  };
  const bridge = new CodexBridge(config, client, () => ({ executable: "verified-cli", version }));
  try {
    const input = { prompt: "test", requestKey: "one", writeMode: "read_only" as const };
    await assert.rejects(bridge.submit(scope, input), /explicit model/);
    await assert.rejects(bridge.submit(scope, { ...input, model: "gpt-5.6-sol" }), /explicit model/);
    await assert.rejects(bridge.submit(scope, { ...input, model: "gpt-6-astra" }), /version/);
    assert.equal(calls, 0);
    version = "0.153.4";
    assert.equal(bridge.preflight().inferenceStarted, false);
    await bridge.submit(scope, { ...input, model: "gpt-6-astra" });
    await bridge.submit(scope, { ...input, model: "gpt-6-astra" });
    assert.equal(calls, 1);
    record.status = "idle";
    record.latestResponse = "unverified old result";
    const history = await bridge.status(scope, record.id);
    assert.equal(history.status, "failed");
    assert.equal("response" in history, false);
    await bridge.submit(scope, { ...input, requestKey: "two", model: "gpt-6-astra", agentId: record.id });
    assert.equal(calls, 2);
  } finally { bridge.close(); rmSync(temp, { recursive: true, force: true }); }
});

test("Codex bridge preserves context, scopes, read-only default and durable deduplication", async () => {
  const temp = mkdtempSync(join(tmpdir(), "devspace-bridge-test-"));
  const config = loadConfig(writeTestDevspaceConfig(join(temp, "config"), { storage: { stateDir: join(temp, "state") } }));
  config.bridge = { enabled: true, allowWorkspaceWrite: false };
  const scope = { workspaceId: "ws-test", workspaceRoot: temp };
  const record: LocalAgentRecord = { id: "agent-test", ...scope, profileName: "codex", provider: "codex", providerSessionId: "thread-test", status: "idle", latestResponse: "result", createdAt: "now", updatedAt: "now" };
  let starts = 0;
  let continues = 0;
  const client = {
    start: async (input: any) => { assert.equal(input.writeMode, "read_only"); assert.equal(input.target, "provider:codex"); starts++; return Result.ok(record); },
    continue: async (id: string, _prompt: string, overrides: any, actualScope: any) => { assert.equal(id, record.id); assert.deepEqual(actualScope, scope); assert.equal(overrides.writeMode, "read_only"); continues++; return Result.ok(record); },
    get: async (id: string, actualScope: any) => { assert.equal(id, record.id); assert.equal(actualScope.workspaceRoot, scope.workspaceRoot); return Result.ok(record); },
    list: async () => Result.ok([] as LocalAgentRecord[]),
  };
  let bridge = new CodexBridge(config, client);
  try {
    const input = { requestKey: "first", prompt: "Only reply", writeMode: "read_only" as const };
    const first = await bridge.submit(scope, input);
    assert.equal(first.codexThreadId, "thread-test");
    assert.equal(first.status, "completed");
    await bridge.submit(scope, input);
    assert.equal(starts, 1);
    await bridge.submit({ ...scope, workspaceId: "reopened" }, input);
    assert.equal(starts, 1);
    await assert.rejects(bridge.submit(scope, { ...input, prompt: "Different" }), /different request/);
    await assert.rejects(bridge.submit(scope, { ...input, requestKey: "write", writeMode: "allowed" }), /writes are disabled/);
    bridge.close();
    bridge = new CodexBridge(config, client);
    await bridge.submit(scope, input);
    assert.equal(starts, 1);
    await bridge.submit(scope, { ...input, requestKey: "follow-up", agentId: record.id });
    assert.equal(continues, 1);
    record.latestResponse = "x".repeat(30000);
    const long = await bridge.status(scope, record.id);
    assert.equal("responseTruncated" in long && long.responseTruncated, true);
  } finally { bridge.close(); rmSync(temp, { recursive: true, force: true }); }
});

test("Codex bridge does not redeliver uncertain requests or submit alongside active tasks", async () => {
  const temp = mkdtempSync(join(tmpdir(), "devspace-bridge-test-"));
  const config = loadConfig(writeTestDevspaceConfig(join(temp, "config"), { storage: { stateDir: join(temp, "state") } }));
  const scope = { workspaceRoot: temp };
  let attempts = 0;
  let running = false;
  const client = {
    start: async (): Promise<any> => { attempts++; throw new Error("Transport disconnected after delivery"); },
    continue: async (): Promise<any> => { throw new Error("not used"); },
    get: async (): Promise<any> => { throw new Error("not used"); },
    list: async (): Promise<any> => Result.ok(running ? [{ status: "running", workspaceRoot: temp, workspaceId: "another-handle" }] : []),
  };
  const bridge = new CodexBridge(config, client);
  try {
    const input = { requestKey: "uncertain", prompt: "Only reply", writeMode: "read_only" as const };
    await assert.rejects(bridge.submit(scope, input), /could not be confirmed/);
    await assert.rejects(bridge.submit(scope, input), /pending or uncertain/);
    assert.equal(attempts, 1);
    running = true;
    await assert.rejects(bridge.submit(scope, { ...input, requestKey: "busy" }), /already running/);
    assert.equal(attempts, 1);
  } finally { bridge.close(); rmSync(temp, { recursive: true, force: true }); }
});
