import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexAppServerRuntime, CodexLocalAgentDriver } from "./local-agent-codex.js";

const policy = { requiredModel: "gpt-6-astra", minimumCliVersion: "0.153.0" };

async function fixture(t: import("node:test").TestContext, scenario = "success") {
  const root = await mkdtemp(join(tmpdir(), "devspace-codex-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await mkdir(join(home, "sessions"), { recursive: true });
  const program = join(root, "fake.mjs");
  await writeFile(program, `import {createInterface} from 'node:readline';
import {appendFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
const scenario=process.env.SCENARIO;
const home=process.env.CODEX_HOME;
const selected=scenario==='sol'?'gpt-5.6-sol':'gpt-6-astra';
const output=value=>process.stdout.write(JSON.stringify(value)+'\\n');
let n=existsSync(join(home,'sessions','rollout.jsonl'))?readFileSync(join(home,'sessions','rollout.jsonl'),'utf8').trim().split('\\n').length:0;
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);
 appendFileSync(join(home,'audit.jsonl'),JSON.stringify(message)+'\\n');
 if(message.method==='initialize') { if(scenario==='init_hang')return; output({id:message.id,result:{userAgent:'devspace/'+(scenario==='old_actual'?'0.152.0':'0.153.4'),codexHome:home}}); }
 if(message.method==='model/list')output({id:message.id,result:{data:scenario==='unavailable'?[]:[{model:selected}]}});
 if(message.method==='thread/start'||message.method==='thread/resume')output({id:message.id,result:{model:scenario==='wrong_session'?'gpt-5.6-sol':selected,cwd:message.params.cwd,approvalPolicy:'never',sandbox:{type:scenario==='wrong_sandbox'?'dangerFullAccess':message.params.sandbox==='read-only'?'readOnly':'workspaceWrite'},thread:{id:'thread-fixture',path:join(home,'sessions','rollout.jsonl')}}});
 if(message.method==='turn/start'){
   const turnId='turn-'+(++n);
   if(scenario==='reroute_before_reply') {output({method:'model/rerouted',params:{threadId:'thread-fixture',turnId,fromModel:'gpt-6-astra',toModel:'gpt-5.6-sol',reason:'test'}});return;}
   output({id:message.id,result:{turn:{id:turnId}}});
   if(scenario==='turn_hang')return;
   setImmediate(()=>{
     if(scenario==='reroute')output({method:'model/rerouted',params:{threadId:'thread-fixture',turnId,fromModel:'gpt-6-astra',toModel:'gpt-5.6-sol',reason:'test'}});
     if(scenario!=='missing_evidence')appendFileSync(join(home,'sessions','rollout.jsonl'),JSON.stringify({type:'turn_context',payload:{turn_id:turnId,model:scenario==='wrong_runtime'?'gpt-5.6-sol':selected}})+'\\n');
     const item={type:'agentMessage',text:'I am gpt-6-astra. done'};
     output({method:'item/completed',params:{threadId:'thread-fixture',turnId,item}});
     output({method:'turn/completed',params:{threadId:'thread-fixture',turn:{id:turnId,status:scenario==='turn_failed'?'failed':'completed',items:[item]}}});
   });
 }
}).on('close',()=>{if(scenario==='delayed_flush')setTimeout(()=>appendFileSync(join(home,'flushed.txt'),'saved'),100);});
`);
  const command = join(root, process.platform === "win32" ? "fake.cmd" : "fake-codex");
  await writeFile(command, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${program}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${program}" "$@"\n`);
  await chmod(command, 0o700);
  const createRuntime = () => {
    const runtime = new CodexAppServerRuntime({ command, version: "0.153.4", model: "gpt-6-astra",
      env: { ...process.env, CODEX_HOME: home, SCENARIO: scenario },
      requestTimeoutMs: scenario === "init_hang" ? 1000 : 5000,
      turnTimeoutMs: scenario === "turn_hang" ? 200 : 2000 });
    t.after(() => runtime.close());
    return runtime;
  };
  return { root, home, command, runtime: createRuntime(), createRuntime };
}

test('dual-model policy verifies Sol execution but rejects an unrequested allowed model', async t => {
  const routed = {...policy,allowedModels:['gpt-6-astra','gpt-5.6-sol']};
  const sol = await fixture(t,'sol'); await sol.runtime.initialize();
  const result = await sol.runtime.run({workspaceRoot:sol.root,prompt:'test',model:'gpt-5.6-sol',executionPolicy:routed,writeMode:'read_only'});
  assert.ok(result.isOk(),result.isErr()?result.error.message:'');
  if(result.isOk()) assert.equal(result.value.executionEvidence?.runtimeModel,'gpt-5.6-sol');
  const mismatch = await fixture(t,'wrong_runtime'); await mismatch.runtime.initialize();
  const wrong = await mismatch.runtime.run({workspaceRoot:mismatch.root,prompt:'test',model:'gpt-6-astra',executionPolicy:routed,writeMode:'read_only'});
  assert.ok(wrong.isErr(),'an allowed but unrequested runtime model must still be rejected');
});

test("guarded Codex start and continuation carry the exact model and persisted turn evidence", async (t) => {
  const { runtime, root, home, createRuntime } = await fixture(t);
  await runtime.initialize();
  const input = { workspaceRoot: root, prompt: "test", model: "gpt-6-astra", executionPolicy: policy, writeMode: "read_only" as const };
  const first = await runtime.run(input);
  assert.ok(first.isOk(), first.isErr() ? first.error.message : "");
  if (first.isErr()) return;
  assert.equal(first.value.executionEvidence?.runtimeModel, "gpt-6-astra");
  assert.equal(first.value.executionEvidence?.source, "codex-rollout/turn_context");
  assert.equal(runtime.isAlive(), false, "guarded turns must close their process to avoid stale resume permissions");
  const next = createRuntime();
  await next.initialize();
  const second = await next.run({ ...input, providerSessionId: first.value.providerSessionId! });
  assert.ok(second.isOk());
  if (second.isErr()) return;
  assert.notEqual(first.value.executionEvidence?.turnId, second.value.executionEvidence?.turnId);
  const requests = (await readFile(join(home, "audit.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  for (const request of requests.filter(value => ["thread/start", "thread/resume", "turn/start"].includes(value.method))) {
    assert.equal(request.params.model, "gpt-6-astra");
    assert.equal(request.params.approvalPolicy, "never");
    if (request.method === "turn/start") assert.equal(request.params.sandboxPolicy.type, "readOnly");
    else assert.equal(request.params.sandbox, "read-only");
  }
});

for (const scenario of ["old_actual", "unavailable", "wrong_session", "wrong_sandbox", "wrong_runtime", "missing_evidence", "reroute", "reroute_before_reply", "turn_hang", "turn_failed"]) {
  test(`guarded Codex rejects ${scenario} without accepting prose as model evidence`, async (t) => {
    const { runtime, root, home } = await fixture(t, scenario);
    await runtime.initialize();
    const result = await runtime.run({ workspaceRoot: root, prompt: "test", model: "gpt-6-astra", executionPolicy: policy, writeMode: "read_only" });
    assert.equal(result.isErr(), true);
    assert.equal(runtime.isAlive(), false);
    if (["old_actual", "unavailable", "wrong_session", "wrong_sandbox"].includes(scenario)) {
      const audit = await readFile(join(home, "audit.jsonl"), "utf8");
      assert.doesNotMatch(audit, /"method":"turn\/start"/);
    }
  });
}

test("request timeout is bounded and strict runtime keys cannot share failure with another agent", async (t) => {
  const { runtime } = await fixture(t, "init_hang");
  await assert.rejects(runtime.initialize(), /timed out/);
  const driver = new CodexLocalAgentDriver(process.env, () => ({ executable: "test", version: "0.153.4" }));
  const context = { agentId: "a", provider: "codex" as const, workspaceRoot: "test", model: "gpt-6-astra", executionPolicy: policy };
  assert.notEqual(driver.runtimeKey(context), driver.runtimeKey({ ...context, agentId: "b" }));
  const old = new CodexLocalAgentDriver(process.env, () => ({ executable: "must-not-start", version: "0.152.0" }));
  const rejected = await old.createRuntime(context);
  assert.equal(rejected.isErr(), true);
});

test("successful guarded turns permit EOF cleanup to flush before process termination", async (t) => {
  const { runtime, root, home } = await fixture(t, "delayed_flush");
  await runtime.initialize();
  const result = await runtime.run({ workspaceRoot: root, prompt: "test", model: "gpt-6-astra", executionPolicy: policy, writeMode: "read_only" });
  assert.ok(result.isOk());
  assert.equal(await readFile(join(home, "flushed.txt"), "utf8"), "saved");
});
