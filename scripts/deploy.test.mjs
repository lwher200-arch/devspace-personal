import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import test from 'node:test';
import { deploy, parseOptions, supportedNode, sourceFingerprint, configState, buildCandidate, portBusy, startOwnedService, checkDependencies } from './deploy.mjs';

const required = ['cli.js','config.js','user-config.js','server.js','server-shutdown.js','process-platform.js','ui/.vite/manifest.json'];
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'devspace deploy test-'));
  t.after(() => {
    assert.equal(dirname(realpathSync(root)), realpathSync(tmpdir()));
    assert.ok(basename(root).startsWith('devspace deploy test-'));
    rmSync(root, {recursive:true, force:true});
  });
  for (const dir of ['src','bin','scripts']) mkdirSync(join(root,dir));
  writeFileSync(join(root,'scripts/local-server.mjs'),'// fixture');
  writeFileSync(join(root,'scripts/fix-node-pty-permissions.mjs'),'// fixture');
  writeFileSync(join(root,'src/index.ts'),'export {};');
  writeFileSync(join(root,'bin/devspace.js'),'// fixture');
  writeFileSync(join(root,'package.json'), JSON.stringify({type:'module',engines:{node:'>=22.19 <27'},packageManager:'pnpm@11.25.0'}));
  for (const file of ['pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','tsconfig.build.json','vite.config.ts']) writeFileSync(join(root,file),'fixture');
  return root;
}
function built(root) {
  for (const file of required) { const path=join(root,'dist',file); mkdirSync(dirname(path),{recursive:true}); writeFileSync(path,'// fixture'); }
  writeFileSync(join(root,'dist/.deploy-manifest.json'),JSON.stringify({version:1,fingerprint:sourceFingerprint(root),node:process.versions.node,packageManager:'pnpm@11.25.0'}));
}
function configured(root) {
  const dir=join(root,'config'); mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'config.jsonc'),'{"custom":"preserve"} // fixture\n');
  writeFileSync(join(dir,'auth.json'),'{"ownerToken":"fixture-preserve-this-value"}\n');
  return dir;
}
function effects(root, extra={}) {
  return {root,say:()=>{},interactive:true,env:{KEEP:'original',CODEX_COMMAND:'unchanged'},
    load:async()=>({host:'127.0.0.1',port:19876}),busy:async()=>false,run:async()=>{throw Error('unexpected command')},
    prepare:async()=>{throw Error('unexpected preparation')},start:async()=>({status:'stopped'}),...extra};
}

test('options and runtime versions are explicit and bounded',()=>{
  assert.ok(supportedNode('22.19.0','>=22.19 <27'));
  assert.ok(supportedNode('24.0.0','>=22.19 <27'));
  for(const version of ['22.18.9','20.20.0','27.0.0','unknown']) assert.equal(supportedNode(version,'>=22.19 <27'),false);
  assert.throws(()=>parseOptions(['--unknown']),/Unknown/);
  assert.throws(()=>parseOptions(['--config-dir']),/needs/);
  assert.throws(()=>parseOptions(['--yes','--yes']),/Duplicate/);
  assert.throws(()=>parseOptions(['--check','--rebuild']),/combined/);
  assert.equal(parseOptions(['--config-dir','folder with spaces']).configDir,resolve('folder with spaces'));
  assert.equal(parseOptions(['--config-dir','~/private-config']).configDir,join(homedir(),'private-config'));
  assert.throws(()=>parseOptions(['--prepare-only','--no-start']),/not both/);
});

test('dependency preflight supports import-only package exports in the target checkout',async t=>{
  const root=fixture(t);built(root);
  writeFileSync(join(root,'dist/process-platform.js'),`export const resolveShellCommand=()=>({executable:process.execPath,args:['-e',"process.stdout.write('DEVSPACE_SHELL_READY')"]});`);
  for(const [name,source] of [
    ['@earendil-works/pi-coding-agent','export const createReadTool=()=>({});'],
    ['better-sqlite3','export default class Database {close(){}}'],
  ]) {
    const directory=join(root,'node_modules',name);mkdirSync(directory,{recursive:true});
    writeFileSync(join(directory,'package.json'),JSON.stringify({name,type:'module',exports:{import:'./index.mjs'}}));
    writeFileSync(join(directory,'index.mjs'),source);
  }
  await checkDependencies(root);
});

test('check mode performs no initialization, migration or file writes',async t=>{
  const root=fixture(t),configDir=join(root,'config');
  const before=readdirSync(root).sort();
  const result=await deploy(parseOptions(['--check','--config-dir',configDir]),effects(root,{interactive:false}));
  assert.equal(result.build,'missing'); assert.equal(result.configState,'new'); assert.equal(result.writesPerformed,false);
  assert.deepEqual(readdirSync(root).sort(),before);
});

test('existing configuration and credentials survive reuse byte-for-byte',async t=>{
  const root=fixture(t); built(root); const configDir=configured(root);
  const before=['config.jsonc','auth.json'].map(f=>readFileSync(join(configDir,f),'utf8'));
  let starts=0;
  await deploy(parseOptions(['--config-dir',configDir]),effects(root,{start:async(_r,env)=>{assert.equal(env.KEEP,'original');assert.equal(env.CODEX_COMMAND,'unchanged');starts++;return {status:'stopped'};}}));
  assert.equal(starts,1);assert.deepEqual(['config.jsonc','auth.json'].map(f=>readFileSync(join(configDir,f),'utf8')),before);
  assert.equal(existsSync(join(root,'.devspace-deploy.lock')),false);
});

test('fresh setup invokes the existing local init and verifies completion',async t=>{
  const root=fixture(t);built(root);const configDir=join(root,'config');let starts=0;
  await deploy(parseOptions(['--config-dir',configDir]),effects(root,{run:async(cmd,args,opts)=>{
    assert.equal(cmd,process.execPath);assert.deepEqual(args,[join(root,'bin/devspace.js'),'init','--local']);
    assert.equal(opts.env.DEVSPACE_CONFIG_DIR,configDir);configured(root);
  },start:async()=>{starts++;return {status:'stopped'};}}));
  assert.equal(starts,1);
});

test('cancelled init and noninteractive yes never imply access approval',async t=>{
  const root=fixture(t);built(root);const options=parseOptions(['--yes','--config-dir',join(root,'config')]);
  await assert.rejects(deploy(options,effects(root,{interactive:false})),/interactive/);
  await assert.rejects(deploy(options,effects(root,{run:async()=>{}})),/did not complete/);
  assert.equal(existsSync(join(root,'.devspace-deploy.lock')),false);
});

test('legacy, partial and occupied configurations stop before deployment',async t=>{
  const root=fixture(t);built(root);const configDir=join(root,'config');mkdirSync(configDir);
  writeFileSync(join(configDir,'config.json'),'legacy');
  assert.equal(configState(configDir),'legacy');
  await assert.rejects(deploy(parseOptions(['--config-dir',configDir]),effects(root)),/legacy/);
  writeFileSync(join(configDir,'config.jsonc'),'partial');
  assert.equal(configState(configDir),'partial');
  await assert.rejects(deploy(parseOptions(['--config-dir',configDir]),effects(root)),/incomplete/);
  configured(root);
  await assert.rejects(deploy(parseOptions(['--rebuild','--yes','--config-dir',configDir]),effects(root,{busy:async()=>true})),/Port is occupied/);
});

test('configuration created during preparation is not overwritten',async t=>{
  const root=fixture(t);const configDir=join(root,'config');
  await assert.rejects(deploy(parseOptions(['--yes','--config-dir',configDir]),effects(root,{prepare:async()=>{built(root);configured(root);return {};}})),/changed during preparation/);
});

test('incomplete builds cannot skip the existing-service check',async t=>{
  const root=fixture(t);const configDir=configured(root);
  await assert.rejects(deploy(parseOptions(['--yes','--rebuild','--config-dir',configDir]),effects(root)),/cannot safely inspect/);
  mkdirSync(join(root,'dist'));writeFileSync(join(root,'dist/config.js'),'// inspectable fixture');
  await assert.rejects(deploy(parseOptions(['--yes','--rebuild','--config-dir',configDir]),effects(root,{busy:async()=>true})),/Port is occupied/);
});

test('stale builds require explicit rebuild and deployment is single-flight',async t=>{
  const root=fixture(t);built(root);const configDir=configured(root);
  writeFileSync(join(root,'src/index.ts'),'export const changed = true;');
  await assert.rejects(deploy(parseOptions(['--config-dir',configDir]),effects(root)),/stale/);
  let entered,release;const started=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
  const options=parseOptions(['--rebuild','--yes','--prepare-only','--config-dir',configDir]);
  const first=deploy(options,effects(root,{prepare:async()=>{entered();await hold;return {};}}));
  await started;
  await assert.rejects(deploy(options,effects(root)),/lock unavailable/);
  release();assert.equal((await first).status,'prepared');
});

test('check and launch agree on Node freshness and corrupt markers support explicit rebuild',async t=>{
  const root=fixture(t);built(root);const configDir=configured(root);
  const marker=join(root,'dist/.deploy-manifest.json');
  const value=JSON.parse(readFileSync(marker,'utf8'));value.node='0.0.0';writeFileSync(marker,JSON.stringify(value));
  assert.equal((await deploy(parseOptions(['--check','--config-dir',configDir]),effects(root))).build,'stale');
  writeFileSync(marker,'{"version":');
  assert.equal((await deploy(parseOptions(['--check','--config-dir',configDir]),effects(root))).build,'invalid');
  await assert.rejects(deploy(parseOptions(['--prepare-only','--config-dir',configDir]),effects(root)),/stale/);
  let prepared=false;
  await deploy(parseOptions(['--rebuild','--yes','--prepare-only','--config-dir',configDir]),effects(root,{prepare:async()=>{prepared=true;built(root);return {};}}));
  assert.ok(prepared);
});

test('a listener appearing during build prevents actual dist promotion',async t=>{
  const root=fixture(t);built(root);const configDir=configured(root);writeFileSync(join(root,'dist/old.txt'),'old');
  const listener=createServer(socket=>socket.end());await new Promise(r=>listener.listen(0,'127.0.0.1',r));
  const config={host:'127.0.0.1',port:listener.address().port};await new Promise(r=>listener.close(r));
  let calls=0;
  const run=async(_cmd,args)=>{
    if(++calls===1)await new Promise(r=>listener.listen(config.port,config.host,r));
    if(args.includes('--outDir')){const output=args[args.indexOf('--outDir')+1];
      if(args.includes('build')){mkdirSync(join(output,'.vite'),{recursive:true});writeFileSync(join(output,'.vite/manifest.json'),'{}');}
      else for(const file of required.filter(f=>!f.startsWith('ui/')))writeFileSync(join(output,file),'// new');}
  };
  try {
    await assert.rejects(deploy(parseOptions(['--rebuild','--yes','--config-dir',configDir]),effects(root,{load:async()=>config,busy:portBusy,run,
      prepare:(r,p,e,run,_verify,before)=>buildCandidate(r,p,e,run,async()=>{},before)})),/became occupied/);
    assert.equal(readFileSync(join(root,'dist/old.txt'),'utf8'),'old');assert.equal(await portBusy(config),true);
  } finally {if(listener.listening)await new Promise(r=>listener.close(r));}
});

test('failed build retains old dist, successful candidate has a rollback directory',async t=>{
  const root=fixture(t);built(root);writeFileSync(join(root,'dist/old.txt'),'old-build');
  await assert.rejects(buildCandidate(root,'pnpm@11.25.0',{},async()=>{throw Error('install failed')},async()=>{}),/install failed/);
  assert.equal(readFileSync(join(root,'dist/old.txt'),'utf8'),'old-build');
  const result=await buildCandidate(root,'pnpm@11.25.0',{},async(_cmd,args)=>{
    if (args.includes('--outDir')) {
      const output=args[args.indexOf('--outDir')+1];
      if (args.includes('build')) {mkdirSync(join(output,'.vite'),{recursive:true});writeFileSync(join(output,'.vite/manifest.json'),'{}');}
      else for(const file of required.filter(f=>!f.startsWith('ui/'))) writeFileSync(join(output,file),'// built');
    }
  },async()=>{});
  assert.equal(readFileSync(join(result.backup,'old.txt'),'utf8'),'old-build');
  assert.equal(existsSync(join(root,'dist/old.txt')),false);
  assert.equal(JSON.parse(readFileSync(join(root,'dist/.deploy-manifest.json'),'utf8')).fingerprint,sourceFingerprint(root));
});

test('actual occupied TCP endpoint is detected without terminating it',async()=>{
  const server=createServer(socket=>socket.end());await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const config={host:'127.0.0.1',port:server.address().port};
  try {assert.equal(await portBusy(config),true);} finally {await new Promise(r=>server.close(r));}
  assert.equal(await portBusy(config),false);
});

test('owned service requires IPC readiness and stops only its child',async t=>{
  const root=fixture(t);
  const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  writeFileSync(join(root,'scripts/local-server.mjs'),`import http from 'node:http';const s=http.createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({ok:true,name:'devspace'}))});s.listen(${port},'127.0.0.1',()=>process.send({type:'devspace.ready',host:'127.0.0.1',port:${port}}));process.on('message',()=>s.close(()=>process.exit(0)));`);
  const controller=new AbortController();let ready=false;
  const result=await startOwnedService(root,process.env,{host:'127.0.0.1',port},{say:line=>{if(line.startsWith('[5/5]')){ready=true;controller.abort();}},signal:controller.signal,timeoutMs:5000});
  assert.ok(ready);assert.equal(result.status,'stopped');assert.equal(await portBusy({host:'127.0.0.1',port}),false);
});

test('startup failure and readiness timeout never report ready',async t=>{
  const root=fixture(t);const script=join(root,'scripts/local-server.mjs');
  writeFileSync(script,'process.exit(2);');
  // Keep exit and timeout coverage distinct: OS scheduling can exceed one second
  // before this child runs. The exit case uses the production startup budget.
  await assert.rejects(startOwnedService(root,process.env,{host:'127.0.0.1',port:19876},{say:()=>{throw Error('unexpected ready')}}),/before readiness/);
  writeFileSync(script,"process.on('message',()=>process.exit(0));setInterval(()=>{},1000);");
  await assert.rejects(startOwnedService(root,process.env,{host:'127.0.0.1',port:19876},{timeoutMs:500}),/timed out/);
});
