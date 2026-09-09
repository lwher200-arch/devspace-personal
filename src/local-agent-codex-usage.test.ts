import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";
import { CodexAppServerRuntime } from "./local-agent-codex.js";
import { localAgentTokenUsageSchema, type LocalAgentTokenUsage } from "./local-agent-usage.js";

// Cross-platform protocol fixture. This never launches a real Codex/model.
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "devspace-codex-usage-"));
  const program = join(root, "fixture.cjs");
  await writeFile(program, `
const {createInterface}=require('node:readline');
const {writeFileSync}=require('node:fs');
const output=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const count=n=>({inputTokens:n,cachedInputTokens:n/2,cacheWriteInputTokens:Math.floor(n/4),outputTokens:20,reasoningOutputTokens:10,totalTokens:n+20});
let sequence=0;
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')output({id:m.id,result:{userAgent:'fixture'}});
 if(m.method==='thread/start'||m.method==='thread/resume')output({id:m.id,result:{thread:{id:'usage-thread'}}});
 if(m.method!=='turn/start')return;
 const turnId='usage-turn-'+(++sequence), prompt=m.params.input[0].text;
 const usage=(n,extra={})=>output({method:'thread/tokenUsage/updated',params:{threadId:'usage-thread',turnId,tokenUsage:{total:count(n),last:count(50),privateData:'must not escape'},...extra}});
 if(prompt==='early') {usage(100);usage(100,{turnId:'foreign-turn'});}
 output({id:m.id,result:{turn:{id:turnId}}});
 setImmediate(()=>{
   if(prompt!=='none') {
     usage(prompt==='reset'?10:100);
     usage(100,{threadId:'foreign-thread'});
     usage(100,{turnId:'foreign-turn'});
     usage(100,{turnId:undefined});
     usage(-1);usage(Number.MAX_SAFE_INTEGER+1);usage(1.5);
     if(prompt!=='reset') {usage(160);usage(160);}
   }
   if(prompt==='crash') {setTimeout(()=>process.exit(7),20);return;}
   if(prompt==='close')return;
   const item={type:'agentMessage',text:'fixture result'};
   const finish=()=>{
     writeFileSync(process.env.DEVSPACE_USAGE_FIXTURE_FINISHED,turnId);
     output({method:'turn/completed',params:{threadId:'usage-thread',turn:{id:turnId,status:prompt==='fail'?'failed':prompt==='interrupt'?'interrupted':'completed',error:prompt==='fail'?{message:'fixture failure'}:undefined,items:[item]}}});
   };
   if(prompt==='delayed')setTimeout(finish,120);else finish();
 });
});
`);
  const command = join(root, process.platform === "win32" ? "fixture.cmd" : "fixture-codex");
  await writeFile(command, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${program}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${program}" "$@"\n`);
  await chmod(command, 0o700);
  const runtime = new CodexAppServerRuntime({ command,
    env: { ...process.env, DEVSPACE_USAGE_FIXTURE_FINISHED: join(root, "finished") }, requestTimeoutMs: 5000 });
  t.after(async () => {
    await runtime.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  await runtime.initialize();
  return { runtime, root };
}

test("Codex usage binds early events, deduplicates snapshots, and exposes response vs thread counters", async t => {
  const { runtime, root } = await fixture(t);
  const receipts: LocalAgentTokenUsage[] = [];
  const result = await runtime.run({ prompt: "early", workspaceRoot: root, model: "gpt-5.6-sol" }, {
    onUsage: async usage => {
      await new Promise(resolve => setTimeout(resolve, 5));
      receipts.push(usage);
    },
  });
  assert.ok(result.isOk());
  assert.equal(receipts.length, 2, "duplicates/invalid/unrelated events never create extra receipts");
  assert.equal(receipts[0].total.totalTokens, 120);
  assert.equal(result.value.usage?.total.totalTokens, 180);
  assert.equal(result.value.usage?.total.cacheWriteInputTokens, 40);
  assert.equal(result.value.usage?.lastModelResponse.totalTokens, 70, "last response is not the whole turn");
  assert.deepEqual(result.value.usage, receipts[1], "async receipt writes finish before return");
  assert.equal(result.value.usage?.turnId, "usage-turn-1");
  assert.equal(result.value.usage?.scope, "provider_thread");
  assert.ok(!JSON.stringify(result.value.usage).includes("privateData"));

  const reset = await runtime.run({ prompt: "reset", workspaceRoot: root, providerSessionId: "usage-thread" });
  assert.ok(reset.isOk());
  assert.equal(reset.value.usage?.total.totalTokens, 30, "provider resets are not summed or converted into negative deltas");
  assert.equal(reset.value.usage?.turnId, "usage-turn-2");
});

for (const prompt of ["fail", "interrupt", "crash", "close"]) {
  test(`Codex preserves observed usage callbacks when a turn ends with ${prompt}`, async t => {
    const { runtime, root } = await fixture(t);
    const receipts: LocalAgentTokenUsage[] = [];
    const result = await runtime.run({ prompt, workspaceRoot: root }, {
      onUsage: async usage => {
        await new Promise(resolve => setTimeout(resolve, 5));
        receipts.push(usage);
        if (prompt === "close" && receipts.length === 2) void runtime.close();
      },
    });
    assert.ok(result.isErr());
    assert.equal(receipts.length, 2);
    assert.equal(receipts.at(-1)?.total.totalTokens, 180);
  });
}

test("Codex missing usage stays absent, and receipt persistence failures are surfaced", async t => {
  const { runtime, root } = await fixture(t);
  const none = await runtime.run({ prompt: "none", workspaceRoot: root });
  assert.ok(none.isOk());
  assert.equal(none.value.usage, undefined);
  const failed = await runtime.run({ prompt: "delayed", workspaceRoot: root }, {
    onUsage: async () => { throw new Error("receipt write failed"); },
  });
  assert.ok(failed.isErr());
  assert.equal(await readFile(join(root, "finished"), "utf8"), "usage-turn-2",
    "a receipt write failure must not release a turn that is still consuming tokens");
});

test("usage schema rejects incomplete or invalid counters without inventing zero", () => {
  assert.equal(localAgentTokenUsageSchema.safeParse({}).success, false);
});
