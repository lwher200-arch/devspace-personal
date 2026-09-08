import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ProcessSessionManager, type NativeProcessSnapshot, type StartProcessInput } from "./process-sessions.js";

async function fixture(t: TestContext, options: ConstructorParameters<typeof ProcessSessionManager>[0] = {}) {
  const root = await mkdtemp(join(tmpdir(), "devspace-native-process-"));
  const manager = new ProcessSessionManager(options);
  t.after(async () => { manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  const run = (code: string, overrides: Partial<StartProcessInput> = {}) => manager.startProcess({
    workspaceId: "workspace-a", workspaceRoot: root, cwd: root, executable: process.execPath,
    args: ["-e", code], yieldTimeMs: 3_000, ...overrides,
  });
  return { root, manager, run };
}

async function completion(manager: ProcessSessionManager, initial: NativeProcessSnapshot) {
  let snapshot = initial;
  let output = initial.output;
  const deadline = Date.now() + 10_000;
  while (snapshot.running && Date.now() < deadline) {
    snapshot = await manager.nativeStatus({ workspaceId: "workspace-a", sessionId: initial.sessionId!, yieldTimeMs: 1_000 });
    assert.equal(snapshot.executionId, initial.executionId);
    output += snapshot.output;
  }
  assert.equal(snapshot.running, false);
  return { ...snapshot, output };
}

test("native argv is literal and stdin is delivered once through EOF", async t => {
  const { root, run } = await fixture(t);
  const argv = ["", "two words", 'a"b', "& echo should-not-run", "%PATH%", "$HOME", "`date`", "中文🙂", "a\\b\\"];
  const code = "let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c=>input+=c); process.stdin.on('end',()=>console.log(JSON.stringify({argv:process.argv.slice(1),input,cwd:process.cwd(),root:process.env.DEVSPACE_WORKSPACE_ROOT,workspace:process.env.DEVSPACE_WORKSPACE_ID})));";
  const result = await run(code, { args: ["-e", code, "--", ...argv], stdin: "秘密 & %PATH% 中文🙂\n" });
  assert.equal(result.exitCode, 0);
  assert.equal(result.running, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.match(result.executionId, /^[0-9a-f-]{36}$/);
  assert.equal(result.cwd, root);
  assert.deepEqual(JSON.parse(result.output), { argv, input: "秘密 & %PATH% 中文🙂\n", cwd: root, root, workspace: "workspace-a" });
});

test("omitted stdin also closes the pipe", async t => {
  const { run } = await fixture(t);
  const result = await run("process.stdin.resume(); process.stdin.on('end',()=>console.log('eof')); ");
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.trim(), "eof");
});

test("all native budgets reject before child side effects", async t => {
  const { root, run } = await fixture(t);
  const marker = join(root, "should-not-exist");
  const code = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'side effect')`;
  const invalid: Array<Partial<StartProcessInput>> = [
    { executable: " " }, { executable: "x\0y" }, { args: Array(257).fill("") },
    { args: ["x".repeat(8_193)] }, { args: ["a\0b"] }, { args: ["汉".repeat(5_400)] },
    { stdin: "汉".repeat(22_000) }, { timeoutMs: 0 }, { timeoutMs: 3_600_001 },
    { timeoutMs: NaN }, { yieldTimeMs: -1 }, { yieldTimeMs: 30_001 }, { maxOutputTokens: 0 },
  ];
  for (const input of invalid) await assert.rejects(run(code, input));
  assert.equal(existsSync(marker), false);
});

test("Windows batch executables are explicitly rejected", { skip: process.platform !== "win32" }, async t => {
  const { run } = await fixture(t);
  for (const executable of ["npm.cmd", "SCRIPT.BAT", "trailing.cmd "]) {
    await assert.rejects(run("", { executable }), /require shell semantics/);
  }
});

test("spawn failure is distinct from a completed nonzero exit", async t => {
  const { root, run } = await fixture(t);
  const missing = await run("", { executable: join(root, "no-such-executable-21987.exe") });
  assert.equal(missing.running, false);
  assert.equal(missing.spawnError, "ENOENT");
  assert.equal(missing.timedOut, false);
  const failure = await run("process.exit(7)");
  assert.equal(failure.running, false);
  assert.equal(failure.exitCode, 7);
  assert.equal(failure.spawnError, undefined);
});

test("yield and polling continue one execution and remove its final consumed session", async t => {
  const { root, run, manager } = await fixture(t);
  const marker = join(root, "starts.txt");
  const code = `require('node:fs').appendFileSync(${JSON.stringify(marker)},${JSON.stringify("started\n")}); console.log('first'); setTimeout(()=>console.log('last'),250);`;
  const first = await run(code, { yieldTimeMs: 0 });
  assert.equal(first.running, true);
  assert.ok(first.sessionId);
  const result = await completion(manager, first);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "first\nlast\n");
  assert.equal(await readFile(marker, "utf8"), "started\n");
  await assert.rejects(manager.nativeStatus({ workspaceId: "workspace-a", sessionId: first.sessionId }), /Unknown process session/);
});

test("native polling and cancellation enforce workspace ownership and reject shell sessions", async t => {
  const { root, run, manager } = await fixture(t);
  const first = await run("setInterval(()=>{},1000)", { yieldTimeMs: 0 });
  for (const method of [manager.nativeStatus.bind(manager), manager.cancelNative.bind(manager)]) {
    await assert.rejects(method({ workspaceId: "workspace-b", sessionId: first.sessionId! }), /does not belong/);
  }
  const shell = await manager.start({ workspaceId: "workspace-a", cwd: root,
    command: `"${process.execPath}" -e "setInterval(()=>{},1000)"`, yieldTimeMs: 0 });
  for (const method of [manager.nativeStatus.bind(manager), manager.cancelNative.bind(manager)]) {
    await assert.rejects(method({ workspaceId: "workspace-a", sessionId: shell.sessionId! }), /was not started by run_process/);
  }
  manager.terminate("workspace-a", shell.sessionId!);
  await manager.cancelNative({ workspaceId: "workspace-a", sessionId: first.sessionId!, yieldTimeMs: 2_000 });
});

test("legacy write_stdin cannot consume native output or send input and Ctrl-C", async t => {
  const { run, manager } = await fixture(t);
  const first = await run("setInterval(()=>{},1000)", { yieldTimeMs: 0 });
  for (const chars of [undefined, "", "extra", "\u0003", "\u0003extra"]) {
    await assert.rejects(manager.write({ workspaceId: "workspace-a", sessionId: first.sessionId!, chars }), /require process_status or process_cancel/);
  }
  const alive = await manager.nativeStatus({ workspaceId: "workspace-a", sessionId: first.sessionId!, yieldTimeMs: 0 });
  assert.equal(alive.running, true);
  assert.equal(alive.cancelled, false);
  const cancelled = await manager.cancelNative({ workspaceId: "workspace-a", sessionId: first.sessionId!, yieldTimeMs: 2_000 });
  assert.equal(cancelled.running, false);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.timedOut, false);
});

test("rejected legacy polling preserves a native timeout result for process_status", async t => {
  const { run, manager } = await fixture(t);
  const first = await run("console.log('before timeout');setInterval(()=>{},1000)", { yieldTimeMs: 0, timeoutMs: 750 });
  await new Promise(resolve => setTimeout(resolve, 1_500));
  await assert.rejects(manager.write({ workspaceId: "workspace-a", sessionId: first.sessionId! }), /require process_status or process_cancel/);
  const last = await completion(manager, { ...first, output: "" });
  assert.equal(last.executionId, first.executionId);
  assert.equal(last.timedOut, true);
  assert.equal(last.running, false);
  assert.match(last.output, /before timeout/);
});

test("status cannot send hidden input and cancel validates limits before stopping", async t => {
  const { run, manager } = await fixture(t);
  const first = await run("setInterval(()=>{},1000)", { yieldTimeMs: 0 });
  const args = { workspaceId: "workspace-a", sessionId: first.sessionId!, chars: "\u0003", yieldTimeMs: 0 };
  assert.equal((await manager.nativeStatus(args)).cancelled, false);
  await assert.rejects(manager.cancelNative({ ...args, maxOutputTokens: 0 }));
  assert.equal((await manager.nativeStatus(args)).cancelled, false);
  const last = await manager.cancelNative({ ...args, yieldTimeMs: 2_000 });
  assert.equal(last.running, false);
  assert.equal(last.cancelled, true);
});

test("total timeout ends a process tree after the initial yield", async t => {
  const { run, manager } = await fixture(t);
  const child = "process.on('SIGTERM',()=>{}); setInterval(()=>console.log('child alive'),50)";
  const code = `process.on('SIGTERM',()=>{}); require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','inherit','inherit']}); setInterval(()=>{},1000);`;
  const first = await run(code, { yieldTimeMs: 0, timeoutMs: 1_500 });
  assert.equal(first.running, true);
  const last = await completion(manager, first);
  assert.equal(last.timedOut, true);
  assert.equal(last.cancelled, false);
  assert.ok(last.wallTimeMs >= 1_500);
  assert.match(last.output, /child alive/);
  assert.equal(last.running, false, "close waits for the child process's inherited output pipe as well");
});

test("UTF-8 output split across chunks is decoded without replacement characters", async t => {
  const { run } = await fixture(t);
  const result = await run("const b=Buffer.from('汉🙂'); process.stdout.write(b.subarray(0,1)); setTimeout(()=>{process.stdout.write(b.subarray(1,4)); setTimeout(()=>process.stdout.write(b.subarray(4)),30)},30)");
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "汉🙂");
});

test("native output remains bounded with honest truncation", async t => {
  const { run } = await fixture(t, { maxBufferCharacters: 1_024 });
  const result = await run("console.log('HEAD'+'中'.repeat(5000)+'TAIL')", { maxOutputTokens: 100 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outputTruncated, true);
  assert.match(result.output, /^HEAD/);
  assert.match(result.output, /TAIL/);
  assert.ok(Array.from(result.output).length <= 400);
});

test("shutdown force-stops native sessions and clears their handles", async t => {
  const { run, manager } = await fixture(t);
  const first = await run("setInterval(()=>{},1000)", { yieldTimeMs: 0 });
  manager.shutdown();
  await assert.rejects(manager.nativeStatus({ workspaceId: "workspace-a", sessionId: first.sessionId! }), /Unknown process session/);
});
