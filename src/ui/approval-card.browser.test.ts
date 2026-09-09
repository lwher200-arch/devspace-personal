import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import ts from 'typescript';
import { BrowserProtocol, waitForBrowserEndpoint } from '../test-support/browser-protocol.js';
import { terminateProcessTree } from '../process-platform.js';

const executable = process.env.DEVSPACE_TEST_BROWSER;
test('approval card requires a click, handles failure and denial, and fits mobile without leaking credentials', {
  skip: executable ? false : 'Set DEVSPACE_TEST_BROWSER to an installed Chromium executable.', timeout: 45000,
}, async t => {
  assert.ok(executable && existsSync(executable));
  const directory = mkdtempSync(join(tmpdir(), 'devspace-chat-card-'));
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const buildDirectory = process.env.DEVSPACE_UI_BUILD_DIR ? resolve(process.env.DEVSPACE_UI_BUILD_DIR) : undefined;
  const fixture = { version: 1, id: 'approval-ui-fixture', state: 'pending', tool: 'codex_task_start', reason: 'Review one read-only Codex turn.',
    args: { workspaceId: 'ws-fixture', prompt: 'Read probe.txt. <img src=x onerror=window.pwned=true>', writeMode: 'read_only' },
    context: { root: '/example/project', selectedModel: 'gpt-5.6-sol' }, expiresAt: '2099-01-01T00:00:00Z', automatic: true, decisionToken: 'u'.repeat(43) };
  const scripts = new Map([
    ['/approval-card.js', new URL('./approval-card.ts', import.meta.url)],
    ['/approval-protocol.js', new URL('../approval-protocol.ts', import.meta.url)],
  ].map(([path, url]) => [String(path), ts.transpileModule(readFileSync(url as URL, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText]));
  const server = createServer((req, res) => {
    if (buildDirectory && req.url === '/host-bridge') {
      const entry = JSON.parse(readFileSync(join(buildDirectory, '.vite/manifest.json'), 'utf8'))['workspace-app.html'];
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">${(entry.css ?? []).map((path: string) => `<link rel="stylesheet" href="/built/${path}">`).join('')}<style>body{background:#f6f6f6;padding:12px}</style><main id="app"></main><script>
const initial=${JSON.stringify(fixture)};window.fixture={calls:[],messages:[]};
window.openai={theme:'light',toolOutput:{result:'Awaiting user'},toolResponseMetadata:{'devspace/approval':initial},
 callTool:async(name,args)=>{fixture.calls.push({name,args});return {content:[],_meta:{'devspace/approval':{...initial,state:'submitted',decisionToken:undefined,submission:{agentId:'agt-built-fixture',workspaceId:'ws-fixture'}}}};},
 sendFollowUpMessage:async message=>{fixture.messages.push(message);}};</script><script type="module" src="/built/${entry.file}"></script>`); return;
    }
    if (buildDirectory && req.url?.startsWith('/built/')) {
      const path = resolve(buildDirectory, decodeURIComponent(new URL(req.url, 'http://fixture').pathname.slice('/built/'.length)));
      if (!path.startsWith(buildDirectory + sep) || !existsSync(path)) { res.statusCode = 404; res.end(); return; }
      res.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(readFileSync(path)); return;
    }
    if (scripts.has(req.url!)) { res.setHeader('content-type', 'text/javascript'); res.end(scripts.get(req.url!)); return; }
    if (req.url === '/style.css') { res.setHeader('content-type', 'text/css'); res.end(readFileSync(new URL('./workspace-app.css', import.meta.url))); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/style.css"><style>body{background:#181818;padding:12px}</style><main id="app"></main><script type="module">
import {mountApprovalCard} from '/approval-card.js';
const base=${JSON.stringify(fixture)};
window.fixture={calls:[],messages:[],fail:false}; let unmount;
window.reset=(overrides={})=>{unmount?.();fixture.calls=[];fixture.messages=[];fixture.fail=false;fixture.failNotify=false;fixture.delayed=false;fixture.pending=false;fixture.current={...base,...overrides};unmount=mountApprovalCard(document.querySelector('#app'),fixture.current,{
  review:async(name,args)=>{fixture.calls.push({name,args});if(fixture.fail)throw Error('fixture transport loss');if(name==='decide_approval'&&fixture.delayed){fixture.pending=true;return fixture.current={...base,decisionToken:undefined,state:'submitting'};}if(name==='review_approval'&&fixture.pending){fixture.pending=false;return fixture.current={...base,decisionToken:undefined,state:'submitted',submission:{agentId:'agt-ui-fixture',workspaceId:'ws-fixture'}};}return name==='decide_approval'?fixture.current={...base,decisionToken:undefined,state:args.decision==='deny'?'denied':'submitted',submission:args.decision==='approve'?{agentId:'agt-ui-fixture',workspaceId:'ws-fixture'}:undefined}:fixture.current;},
  notify:async message=>{fixture.messages.push(message);if(fixture.failNotify)throw Error('fixture notification failure');}
});};reset();</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(executable, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${directory}`,
    '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-breakpad', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let exited = false, launchError: Error | undefined, browser: BrowserProtocol | undefined;
  const completion = new Promise<void>(resolve => child.once('exit', () => { exited = true; resolve(); }));
  child.once('error', error => { launchError = error; });
  t.after(async () => {
    await browser?.send('Browser.close').catch(() => {}); browser?.disconnect();
    if (!exited && child.pid) { await Promise.race([completion, delay(1500)]); if (!exited) { terminateProcessTree(child, 'SIGTERM', false); await Promise.race([completion, delay(2000)]); } }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(dirname(realpathSync(directory)), realpathSync(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });
  const portFile = join(directory, 'DevToolsActivePort');
  const { port, path } = await waitForBrowserEndpoint(portFile, {
    timeoutMs: 10000, stopped: () => launchError ?? (exited ? new Error('Test browser exited during startup.') : undefined),
  });
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', () => reject(Error('Browser connection failed')), { once: true }); });
  browser = new BrowserProtocol(socket);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async (expression: string) => { const result = await browser!.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }, sessionId);
  let loaded = false;
  for (let i = 0; i < 100; i++) { if (await evaluate('Boolean(document.querySelector(".approval-primary"))')) { loaded = true; break; } await delay(50); }
  assert.ok(loaded); assert.equal(await evaluate('fixture.calls.length'), 0, 'render must never decide');
  assert.equal(await evaluate(`document.body.innerText.includes(${JSON.stringify(fixture.decisionToken)})`), false);
  assert.equal(await evaluate('Boolean(window.pwned)'), false);
  for (const width of [900, 360]) {
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    if (process.env.DEVSPACE_CAPTURE_UI === '1') {
      const output = join(repository, '.runtime', 'approval-card-screenshots'); mkdirSync(output, { recursive: true });
      const capture = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      writeFileSync(join(output, `pending-${width}.png`), Buffer.from(capture.data, 'base64'));
    }
  }
  await evaluate('document.querySelector(".approval-primary").click()'); await delay(50);
  assert.equal(await evaluate('fixture.calls.length'), 1);
  assert.equal(await evaluate('fixture.calls[0].name'), 'decide_approval');
  assert.equal(await evaluate('fixture.messages.length'), 1);
  assert.equal(await evaluate(`fixture.messages[0].includes(${JSON.stringify(fixture.decisionToken)})`), false);
  assert.equal(await evaluate('document.body.innerText.includes("agt-ui-fixture")'), true);
  await evaluate('reset();fixture.delayed=true;document.querySelector(".approval-primary").click()'); await delay(50);
  assert.equal(await evaluate('fixture.messages.length'), 0, 'do not notify Chat before a submission receipt exists');
  for (let i = 0; i < 60 && !await evaluate('fixture.messages.length'); i++) await delay(50);
  assert.equal(await evaluate('fixture.messages.length'), 1);
  assert.equal(await evaluate('fixture.messages[0].includes("agt-ui-fixture")'), true);
  assert.equal(await evaluate('fixture.calls.filter(call=>call.name==="decide_approval").length'), 1);
  await evaluate('reset(); document.querySelectorAll("button")[1].click()'); await delay(50);
  assert.equal(await evaluate('fixture.calls[0].args.decision'), 'deny');
  assert.equal(await evaluate('document.body.innerText.includes("已拒绝")'), true);
  await evaluate('reset({expiresAt:"2000-01-01T00:00:00Z"});document.querySelector(".approval-primary").click()');
  assert.equal(await evaluate('fixture.calls.length'), 0);
  await evaluate('reset();fixture.fail=true;document.querySelector(".approval-primary").click()'); await delay(100);
  assert.equal(await evaluate('fixture.calls.length'), 1, 'ambiguous delivery must not auto-retry');
  assert.equal(await evaluate('document.querySelector(".approval-primary").disabled'), true);
  await evaluate('reset();fixture.failNotify=true;document.querySelector(".approval-primary").click()'); await delay(50);
  assert.equal(await evaluate('fixture.calls.length'), 1);
  assert.equal(await evaluate('Boolean(document.querySelector(".approval-continue"))'), true);
  await evaluate('fixture.failNotify=false;document.querySelector(".approval-continue").click()'); await delay(50);
  assert.equal(await evaluate('fixture.calls.filter(call=>call.name==="decide_approval").length'), 1, 'notification recovery must not approve or execute again');
  assert.equal(await evaluate('fixture.messages.length'), 2);
  await evaluate('reset({state:"submitted",decisionToken:undefined,submission:{agentId:"agt-restored",workspaceId:"ws-fixture"}})'); await delay(50);
  assert.equal(await evaluate('fixture.messages.length'), 0, 'history restore must not auto-send a message');
  await evaluate('document.querySelector(".approval-continue").click()'); await delay(50);
  assert.equal(await evaluate('fixture.messages[0].includes("agt-restored")'), true);
  assert.equal(await evaluate('fixture.calls[0].name'), 'review_approval');
  await t.test('built entrypoint supports ChatGPT-only bridge, hidden metadata and theme changes', { skip: !buildDirectory }, async () => {
    await browser!.send('Page.navigate', { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/host-bridge` }, sessionId);
    let ready = false;
    for (let i = 0; i < 240; i++) { if (await evaluate('Boolean(document.querySelector(".approval-primary"))')) { ready = true; break; } await delay(50); }
    assert.ok(ready, 'actual bundled boot must recover when only the ChatGPT bridge is provided');
    assert.equal(await evaluate('document.documentElement.dataset.approvalLegacy'), 'true');
    assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
    assert.equal(await evaluate('fixture.calls.length'), 0);
    if (process.env.DEVSPACE_CAPTURE_UI === '1') {
      const output = join(repository, '.runtime', 'approval-card-screenshots'); mkdirSync(output, { recursive: true });
      const capture = await browser!.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      writeFileSync(join(output, 'chat-web-light.png'), Buffer.from(capture.data, 'base64'));
    }
    await evaluate('window.openai.theme="dark";window.dispatchEvent(new CustomEvent("openai:set_globals",{detail:{globals:{theme:"dark"}}}))');
    assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');
    assert.equal(await evaluate('fixture.calls.length'), 0, 'theme changes must not approve or remount a decision');
    await evaluate('document.querySelector(".approval-primary").click()'); await delay(100);
    assert.equal(await evaluate('fixture.calls.length'), 1); assert.equal(await evaluate('fixture.messages.length'), 1);
    assert.equal(await evaluate('fixture.messages[0].prompt.includes("agt-built-fixture")'), true);
    assert.equal(await evaluate(`fixture.messages[0].prompt.includes(${JSON.stringify(fixture.decisionToken)})`), false);
  });
});
