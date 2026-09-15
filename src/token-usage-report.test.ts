import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { formatTokenUsageReport, parseTokenUsageReport, readTokenUsageReport, runUsageReportCommand } from "./token-usage-report.js";

const usage = { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 10,
  output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 };
const twice = Object.fromEntries(Object.entries(usage).map(([k, v]) => [k, v * 2]));
const event = (type: string, payload: unknown) => ({ type, payload });
const start = (turn_id = "turn-a") => event("event_msg", { type: "task_started", turn_id });
const done = (turn_id = "turn-a") => event("event_msg", { type: "task_complete", turn_id, last_agent_message: "PRIVATE_FINAL" });
const receipt = (response_id = "response-a", counters: unknown = usage, total: unknown = usage, turn_id = "turn-a") =>
  event("token_usage_record", { response_id, thread_id: "thread-a", turn_id, usage: counters, turn_token_usage: total });
const jsonl = (...rows: unknown[]) => [event("session_meta", { id: "thread-a" }), ...rows].map(r => JSON.stringify(r)).join("\n") + "\n";

test("canonical response receipts reconcile without adding duplicates, snapshots, or subset counters", () => {
  const text = jsonl(start(),
    event("response_item", { type: "custom_tool_call", name: "exec", call_id: "call-a", input: "PRIVATE_ARGUMENTS" }),
    receipt(), receipt(), event("event_msg", { type: "token_count", info: { total_token_usage: { total_tokens: 999999 } } }),
    event("response_item", { type: "custom_tool_call_output", call_id: "call-a", output: "PRIVATE_FAILURE" }),
    receipt("response-b", usage, twice), done());
  const report = parseTokenUsageReport(text);
  assert.equal(report.status, "complete");
  assert.equal(report.responseCount, 2);
  assert.equal(report.duplicateResponseCount, 1);
  assert.deepEqual(report.usage, twice);
  assert.equal(report.uncachedInputTokens, 60);
  assert.deepEqual(report.operations, [{ callId: "call-a", tool: "exec", resultRecorded: true, independentTokens: null,
    requestBytes: 17, responseBytes: 15 }]);
  assert.ok(!JSON.stringify(report).includes("PRIVATE"));
  assert.ok(!formatTokenUsageReport(report).includes("PRIVATE"));
});

test("latest turn defaults to active turn and explicit selection excludes later operations", () => {
  const text = jsonl(start(), receipt(), done(), start("turn-b"),
    event("response_item", { type: "function_call", name: "apply_patch", call_id: "call-b", arguments: "PRIVATE" }),
    receipt("response-b", usage, usage, "turn-b"));
  const current = parseTokenUsageReport(text);
  assert.equal(current.turnId, "turn-b");
  assert.equal(current.status, "partial");
  assert.equal(current.operations[0].resultRecorded, false);
  const older = parseTokenUsageReport(text, "turn-a");
  assert.equal(older.status, "complete");
  assert.equal(older.operations.length, 0);
  assert.throws(() => parseTokenUsageReport(text, "missing"), /not found/);
});

test("conflicting duplicate receipts cannot produce a misleading total", () => {
  assert.throws(() => parseTokenUsageReport(jsonl(start(), receipt(), receipt("response-a", twice, twice))), /Conflicting duplicate/);
});

test("missing canonical receipts are unavailable even with legacy token_count", () => {
  const report = parseTokenUsageReport(jsonl(start(), event("event_msg", { type: "token_count", info: { total_token_usage: usage } }), done()));
  assert.equal(report.status, "unavailable");
  assert.equal(report.usage, null);
  assert.equal(report.uncachedInputTokens, null);
  assert.match(formatTokenUsageReport(report), /Total: unavailable/);
});

test("traffic measures UTF-8 payload bytes without exposing contents or claiming wire traffic", () => {
  const report = parseTokenUsageReport(jsonl(start(),
    event("response_item", { type: "custom_tool_call", name: "exec", call_id: "unicode", input: "你好🙂" }),
    event("response_item", { type: "custom_tool_call_output", call_id: "unicode", output: { text: "好" } }),
    receipt(), done()));
  assert.equal(report.traffic.scope, "recorded_tool_payload_utf8");
  assert.equal(report.traffic.requestBytes, 10);
  assert.equal(report.traffic.responseBytes, 14);
  assert.equal(report.traffic.totalBytes, 24);
  assert.equal(report.traffic.networkWireBytes, null);
  assert.equal(report.traffic.status, "complete");
  assert.ok(!JSON.stringify(report).includes("你好"));
  assert.match(formatTokenUsageReport(report), /Network wire traffic: unavailable/);
});

test("traffic counts repeated recorded payloads while token receipts remain deduplicated", () => {
  const report = parseTokenUsageReport(jsonl(start(),
    event("response_item", { type: "function_call", name: "read", call_id: "repeat", arguments: "a" }),
    event("response_item", { type: "function_call", name: "read", call_id: "repeat", arguments: "你" }),
    event("response_item", { type: "function_call_output", call_id: "repeat", output: "ok" }),
    event("response_item", { type: "function_call_output", call_id: "repeat", output: "ok" }),
    receipt(), receipt(), done()));
  assert.equal(report.traffic.requestRecords, 2);
  assert.equal(report.traffic.responseRecords, 2);
  assert.equal(report.traffic.requestBytes, 4);
  assert.equal(report.traffic.responseBytes, 4);
  assert.equal(report.usage?.total_tokens, 120);
});

test("missing, pending and unmatched traffic stays unavailable instead of zero", () => {
  const call = event("response_item", { type: "custom_tool_call", name: "exec", call_id: "call", input: "" });
  const pending = parseTokenUsageReport(jsonl(start(), call, receipt()));
  assert.equal(pending.traffic.requestBytes, 0);
  assert.equal(pending.traffic.responseBytes, null);
  assert.equal(pending.traffic.totalBytes, null);
  assert.equal(pending.traffic.observedTotalBytes, 0, "known empty request is not a claim that the missing response costs zero");
  assert.equal(pending.traffic.status, "partial");
  const missing = parseTokenUsageReport(jsonl(start(), call,
    event("response_item", { type: "custom_tool_call_output", call_id: "call" }), receipt(), done()));
  assert.equal(missing.traffic.missingPayloadRecords, 1);
  assert.equal(missing.traffic.responseBytes, null);
  const orphan = parseTokenUsageReport(jsonl(start(), call,
    event("response_item", { type: "custom_tool_call_output", call_id: "other", output: "private" }), receipt(), done()));
  assert.equal(orphan.traffic.unmatchedResponseRecords, 1);
  assert.equal(orphan.traffic.totalBytes, null);
  assert.equal(orphan.traffic.observedResponseBytes, 0, "orphan payload cannot be charged to a selected call");
  const noIdentity = parseTokenUsageReport(jsonl(start(),
    event("response_item", { type: "custom_tool_call", name: "exec", input: "private" }), receipt(), done()));
  assert.equal(noIdentity.traffic.requestBytes, null);
  assert.equal(noIdentity.status, "partial");
});

test("traffic is bounded to the selected turn and empty observed tool activity is distinct from network zero", () => {
  const report = parseTokenUsageReport(jsonl(start(), receipt(), done(), start("turn-b"),
    event("response_item", { type: "custom_tool_call", name: "exec", call_id: "later", input: "private" })), "turn-a");
  assert.equal(report.traffic.totalBytes, 0);
  assert.equal(report.traffic.networkWireBytes, null);
  assert.equal(parseTokenUsageReport(jsonl(receipt())).traffic.status, "unavailable");
});

test("missing cache details remain unknown instead of zero", () => {
  const basic = { input_tokens: 100, output_tokens: 20, total_tokens: 120 };
  const report = parseTokenUsageReport(jsonl(start(), receipt("response-a", basic, basic), done()));
  assert.equal(report.usage?.cache_write_input_tokens, null);
  assert.equal(report.usage?.cached_input_tokens, null);
  assert.equal(report.uncachedInputTokens, null);
});

test("partial JSONL, invalid counts and unreconciled receipts cannot claim complete coverage", () => {
  for (const text of [jsonl(start(), receipt(), done()) + '{"secret":"PARTIAL',
    jsonl(start(), receipt(), receipt("bad", { ...usage, input_tokens: -1 }), done()),
    jsonl(start(), receipt("response-a", usage, twice), done()),
    jsonl(start(), receipt(), done()) + 'BROKEN_PRIVATE_DATA\n']) {
    const report = parseTokenUsageReport(text);
    assert.equal(report.status, "partial");
    assert.ok(!JSON.stringify(report).includes("PRIVATE_DATA"));
    assert.ok(!JSON.stringify(report).includes("secret"));
  }
  assert.equal(parseTokenUsageReport(jsonl(start(), receipt("bad", { ...usage, total_tokens: 121 }), done())).usage, null);
});

test("mismatched receipt identities and absent boundaries never report complete", () => {
  const second = receipt("response-b", usage, twice);
  (second.payload as { thread_id: string }).thread_id = "thread-b";
  assert.equal(parseTokenUsageReport(jsonl(start(), receipt(), second, done())).status, "partial");
  assert.equal(parseTokenUsageReport(jsonl(receipt(), done())).status, "partial");
  const missing = receipt();
  delete (missing.payload as { thread_id?: string }).thread_id;
  assert.equal(parseTokenUsageReport(jsonl(start(), missing, done())).status, "unavailable");
  assert.equal(parseTokenUsageReport(jsonl(start(), second, done())).status, "unavailable");
  assert.equal(parseTokenUsageReport(jsonl(start(), receipt(), done()).split("\n").slice(1).join("\n")).status, "partial");
});

test("invalid lifecycle order cannot produce a complete turn bill", () => {
  for (const text of [jsonl(receipt(), start(), done()), jsonl(done(), start(), receipt()),
    jsonl(start(), receipt(), start("turn-b"), done()), jsonl(start(), done(), receipt())]) {
    assert.notEqual(parseTokenUsageReport(text, "turn-a").status, "complete");
  }
  assert.throws(() => parseTokenUsageReport("\n".repeat(100_002)), /100,000/);
});

test("report command validates arguments and only reads the selected bounded file", async t => {
  const root = await mkdtemp(join(tmpdir(), "devspace-usage-report-"));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  const file = join(root, "rollout.jsonl");
  const text = jsonl(start(), receipt(), done());
  await writeFile(file, text);
  const output = JSON.parse(await runUsageReportCommand(["report", "--rollout", file, "--json"]));
  assert.equal(output.usage.total_tokens, 120);
  assert.equal(await readFile(file, "utf8"), text);
  for (const args of [[], ["report"], ["report", "--rollout"], ["report", "--rollout", file, "--unknown"],
    ["report", "--rollout", file, "--json", "--json"], ["report", "--rollout", file, "--turn-id", "a", "--turn-id", "b"]]) {
    await assert.rejects(runUsageReportCommand(args), /Usage:/);
  }
  await writeFile(join(root, "large"), "");
  await truncate(join(root, "large"), 64 * 1024 * 1024 + 1);
  await assert.rejects(readTokenUsageReport(join(root, "large")), /64 MiB/);
  await assert.rejects(readTokenUsageReport(root), /regular rollout|EISDIR|EPERM/);
  await writeFile(join(root, "invalid"), Buffer.from([0xff, 0xfe]));
  await assert.rejects(readTokenUsageReport(join(root, "invalid")), /UTF-8/);
});

test("real CLI routing prints JSON without creating configuration or changing the rollout", async t => {
  const root = await mkdtemp(join(tmpdir(), "devspace-usage-cli-"));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  const file = join(root, "rollout.jsonl");
  await writeFile(file, jsonl(start(), receipt(), done()));
  const before = await readFile(file);
  const { stdout } = await promisify(execFile)(process.execPath,
    ["--import", "tsx", "src/cli.ts", "usage", "report", "--rollout", file, "--json"],
    { cwd: process.cwd(), env: { ...process.env, DEVSPACE_CONFIG_DIR: join(root, "absent-config") }, timeout: 15000 });
  assert.equal(JSON.parse(stdout).status, "complete");
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readdir(root), ["rollout.jsonl"], "read-only report must not bootstrap DevSpace state");
});
