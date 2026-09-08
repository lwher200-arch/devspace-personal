import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import express from 'express';
import { loadConfig } from './config.js';
import { OwnerApprovals, installOwnerApprovalRoutes } from './mcp-authorization.js';
import { terminateProcessTree } from './process-platform.js';
import { writeTestDevspaceConfig } from './test-support/config.test.js';

const browserExecutable = process.env.DEVSPACE_TEST_BROWSER;

// Use an isolated installed Chromium, without another browser automation dependency.
class BrowserProtocol {
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private socket: WebSocket) {
    socket.addEventListener('message', event => {
      const value = JSON.parse(String(event.data));
      const entry = this.pending.get(value.id);
      if (!entry) return;
      this.pending.delete(value.id); clearTimeout(entry.timer);
      if (value.error) entry.reject(new Error(value.error.message)); else entry.resolve(value.result);
    });
    socket.addEventListener('close', () => {
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Test browser closed.')); }
      this.pending.clear();
    });
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Browser timeout: ${method}`)); }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  disconnect() { this.socket.close(); }
}

for (const automatic of [false, true]) test(`browser approval preserves Origin and URL privacy (${automatic ? 'auto submission' : 'manual retry'})`, {
  skip: browserExecutable ? false : 'Set DEVSPACE_TEST_BROWSER to an installed Chromium executable.', timeout: 45000,
}, async t => {
  assert.ok(browserExecutable && existsSync(browserExecutable), 'Configured test browser must exist.');
  const directory = mkdtempSync(join(tmpdir(), 'devspace-approval-browser-'));
  const profile = join(directory, 'browser-profile');
  const app = express(), approvals = new OwnerApprovals();
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config = loadConfig(writeTestDevspaceConfig(join(directory, 'config'), { server: { publicBaseUrl: origin }, logging: { level: 'silent' } }));
  let submitted: { origin?: string; status: number; policy: unknown } | undefined;
  app.use((req, res, next) => {
    if (req.method === 'POST') res.on('finish', () => { submitted = { origin: req.header('origin'), status: res.statusCode, policy: res.getHeader('referrer-policy') }; });
    next();
  });
  installOwnerApprovalRoutes(app, config, approvals);
  const operation = { principal: 'browser-fixture', tool: automatic ? 'codex_task_start' : 'fixture.noop', args: {}, context: {}, reason: 'Inert local browser test.' };
  let dispatched = 0;
  const requested = approvals.require(operation, automatic ? async () => { dispatched++; return { agentId: 'agt-browser-fixture', workspaceId: 'ws-browser-fixture' }; } : undefined);
  assert.equal(requested.allowed, false); if (requested.allowed) return;
  const url = `${origin}/owner/approvals/${requested.approval.id}`;
  let outgoing: { referer?: string } | undefined;
  const receiver = createServer((req, res) => {
    if (req.url === '/outside' && !outgoing) outgoing = { referer: req.headers.referer };
    res.end('Local cross-origin receiver.');
  });
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
  const external = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/outside`;
  const child = spawn(browserExecutable!, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-breakpad', '--disable-sync', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let exited = false, launchError: Error | undefined, browser: BrowserProtocol | undefined;
  const completion = new Promise<void>(resolve => child.once('exit', () => { exited = true; resolve(); }));
  child.once('error', error => { launchError = error; });
  t.after(async () => {
    await browser?.send('Browser.close').catch(() => {}); browser?.disconnect();
    if (!exited && child.pid) {
      await Promise.race([completion, delay(1500)]);
      if (!exited) { terminateProcessTree(child, 'SIGTERM', false); await Promise.race([completion, delay(2000)]); }
    }
    server.closeAllConnections(); receiver.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => receiver.close(() => resolve()))]);
    assert.equal(dirname(realpathSync(directory)), realpathSync(tmpdir()));
    // Browser/crash-report handles may drain after the main process exits on Windows.
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });
  const portFile = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 12000;
  while (!existsSync(portFile) && Date.now() < deadline && !exited && !launchError) await delay(50);
  if (launchError) throw launchError;
  assert.ok(existsSync(portFile), 'Isolated browser must expose its test debugging endpoint.');
  const [port, path] = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', () => reject(new Error('Test browser connection failed.')), { once: true }); });
  browser = new BrowserProtocol(socket);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Page.navigate', { url }, sessionId);
  let loaded = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await browser.send('Runtime.evaluate', { expression: "Boolean(document.querySelector('input[name=owner_token]'))", returnByValue: true }, sessionId);
    if (result.result.value) { loaded = true; break; } await delay(50);
  }
  assert.ok(loaded, 'The real approval form must load.');
  // Fill only this fixture's dummy secret. No request headers or cookies are forged.
  await browser.send('Runtime.evaluate', { expression: `document.querySelector('[name=owner_token]').value=${JSON.stringify(config.oauth.ownerToken)};document.querySelector('[value=approve]').click();`, userGesture: true }, sessionId);
  for (let attempt = 0; attempt < 100 && !submitted; attempt++) await delay(50);
  t.diagnostic(JSON.stringify(submitted));
  assert.equal(submitted?.origin, origin, 'A real form submission must retain its trustworthy Origin.');
  assert.equal(submitted?.status, automatic ? 303 : 200);
  if (automatic) {
    let visible = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await browser.send('Runtime.evaluate', { expression: "document.body.innerText.includes('agt-browser-fixture')", returnByValue: true }, sessionId);
      if (result.result.value) { visible = true; break; } await delay(50);
    }
    assert.ok(visible, 'Approval must redirect to the submitted task receipt, without a Chat retry.');
    assert.equal(dispatched, 1);
    const receipt = approvals.require(operation); if (receipt.allowed) throw Error('no second execution grant');
    assert.equal(receipt.approval.state, 'submitted');
  } else assert.equal(approvals.require(operation).allowed, true);
  await browser.send('Runtime.evaluate', { expression: `const link=document.createElement('a');link.href=${JSON.stringify(external)};document.body.append(link);link.click();`, userGesture: true }, sessionId);
  for (let attempt = 0; attempt < 100 && !outgoing; attempt++) await delay(50);
  assert.ok(outgoing); assert.equal(outgoing.referer, undefined, 'Cross-origin navigation must not disclose the approval URL.');
});
