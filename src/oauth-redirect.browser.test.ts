import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import express from 'express';
import { SingleUserOAuthProvider } from './oauth-provider.js';
import { terminateProcessTree } from './process-platform.js';
import { BrowserProtocol, waitForBrowserEndpoint } from './test-support/browser-protocol.js';

const browserExecutable = process.env.DEVSPACE_TEST_BROWSER;

test('OAuth browser consent reaches its registered cross-origin callback and blocks unrelated form destinations', {
  skip: browserExecutable ? false : 'Set DEVSPACE_TEST_BROWSER to an installed Chromium executable.', timeout: 45000,
}, async t => {
  assert.ok(browserExecutable && existsSync(browserExecutable), 'Configured test browser must exist.');
  const directory = mkdtempSync(join(tmpdir(), 'devspace-oauth-browser-'));
  const profile = join(directory, 'browser-profile');
  const app = express(), server = createServer(app);
  let callback: { method: string | undefined; code: string | null; state: string | null; referer?: string } | undefined;
  let unrelatedSubmissions = 0;
  const receiver = createServer((req, res) => {
    const url = new URL(req.url!, 'http://fixture.invalid');
    if (url.pathname === '/unrelated') unrelatedSubmissions++;
    if (url.pathname === '/callback') callback = { method: req.method, code: url.searchParams.get('code'), state: url.searchParams.get('state'), referer: req.headers.referer };
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Fixture callback received</title><p>Fixture callback received.</p>');
  });
  let provider: SingleUserOAuthProvider | undefined, browser: BrowserProtocol | undefined;
  let child: ReturnType<typeof spawn> | undefined, exited = false, launchError: Error | undefined;
  let completion: Promise<void> = Promise.resolve();
  t.after(async () => {
    await browser?.send('Browser.close').catch(() => {}); browser?.disconnect();
    if (child && !exited && child.pid) {
      await Promise.race([completion, delay(1500)]);
      if (!exited) { terminateProcessTree(child, 'SIGTERM', false); await Promise.race([completion, delay(2000)]); }
    }
    server.closeAllConnections(); receiver.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => receiver.close(() => resolve()))]);
    provider?.close();
    assert.equal(dirname(realpathSync(directory)), realpathSync(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const callbackOrigin = `http://127.0.0.1:${(receiver.address() as { port: number }).port}`;
  // A hostname alias supplies an unrelated origin on the same isolated receiver.
  const unrelatedOrigin = callbackOrigin.replace('127.0.0.1', 'localhost');
  const redirectUri = `${callbackOrigin}/callback`, resource = new URL(`${origin}/mcp`);
  const ownerToken = 'fixture-owner-password-never-a-real-credential';
  provider = new SingleUserOAuthProvider({ ownerToken, ownerSessionTtlSeconds: 43200, accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 2592000, scopes: ['devspace'], allowedRedirectHosts: ['127.0.0.1'] }, resource, join(directory, 'oauth'));
  const client = await provider.clientsStore.registerClient!({ redirect_uris: [redirectUri], client_name: 'Isolated browser fixture', token_endpoint_auth_method: 'none' });
  const verifier = 'fixture-only-pkce-verifier-with-sufficient-characters-123456789';
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let submitted: { status: number; origin?: string; policy: unknown; callbackOrigin: string | null; hasCode: boolean } | undefined;
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.path === '/authorize') res.on('finish', () => {
      const location = res.getHeader('Location'), redirect = typeof location === 'string' ? new URL(location) : undefined;
      submitted = { status: res.statusCode, origin: req.header('origin'), policy: res.getHeader('Content-Security-Policy'),
        callbackOrigin: redirect?.origin ?? null, hasCode: redirect?.searchParams.has('code') ?? false };
    });
    next();
  });
  app.use('/authorize', authorizationHandler({ provider, rateLimit: false }));
  app.use('/token', tokenHandler({ provider, rateLimit: false }));
  const authorizationUrl = new URL('/authorize', origin);
  authorizationUrl.search = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'devspace', state: 'fixture-state', resource: resource.href }).toString();
  child = spawn(browserExecutable!, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-breakpad', '--disable-sync', '--host-resolver-rules=MAP localhost 127.0.0.1', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  completion = new Promise<void>(resolve => child!.once('exit', () => { exited = true; resolve(); }));
  child.once('error', error => { launchError = error; });
  const portFile = join(profile, 'DevToolsActivePort');
  const { port, path } = await waitForBrowserEndpoint(portFile, {
    stopped: () => launchError ?? (exited ? new Error('Test browser exited during startup.') : undefined),
  });
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', () => reject(new Error('Test browser connection failed.')), { once: true }); });
  browser = new BrowserProtocol(socket);
  const cspErrors: string[] = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Log.entryAdded' && /form-action/.test(message.params.entry.text)) {
      cspErrors.push(String(message.params.entry.text).replace(/([?&](?:code|state)=)[^&'\s]+/g, '$1[fixture]'));
    }
  });
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Log.enable', {}, sessionId);
  await browser.send('Page.navigate', { url: authorizationUrl.href }, sessionId);
  let loaded = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await browser.send('Runtime.evaluate', { expression: "Boolean(document.querySelector('input[name=owner_token]'))", returnByValue: true }, sessionId);
    if (result.result.value) { loaded = true; break; } await delay(50);
  }
  assert.ok(loaded, 'The real OAuth consent form must load.');
  // Attempt only a separate dummy form: it never contains the Owner password.
  await browser.send('Runtime.evaluate', { expression: `const unrelated=document.createElement('form');unrelated.method='POST';unrelated.action=${JSON.stringify(`${unrelatedOrigin}/unrelated`)};document.body.append(unrelated);unrelated.submit();`, userGesture: true }, sessionId);
  for (let attempt = 0; attempt < 60 && !cspErrors.some(error => error.includes(unrelatedOrigin)); attempt++) await delay(50);
  assert.ok(cspErrors.some(error => error.includes(unrelatedOrigin)), 'CSP must reject unrelated form destinations.');
  assert.equal(unrelatedSubmissions, 0, 'The unrelated origin must receive no form data.');
  cspErrors.length = 0;
  // Fill only this fixture's dummy secret, using the page's unmodified real form.
  await browser.send('Runtime.evaluate', { expression: `document.querySelector('[name=owner_token]').value=${JSON.stringify(ownerToken)};document.querySelector('button[type=submit]').click();`, userGesture: true }, sessionId);
  for (let attempt = 0; attempt < 100 && !callback && cspErrors.length === 0; attempt++) await delay(50);
  t.diagnostic(JSON.stringify({ submitted, callbackReceived: Boolean(callback), unrelatedSubmissions, cspErrors }));
  assert.equal(submitted?.status, 302, 'Provider must issue the authorization redirect.');
  assert.equal(submitted.origin, origin, 'The real consent submission must keep its Origin.');
  assert.equal(submitted.callbackOrigin, callbackOrigin);
  assert.equal(submitted.hasCode, true, '302 must carry a successful authorization code, not an OAuth error.');
  assert.ok(callback, 'Browser must follow the successful form POST redirect to its registered cross-origin callback.');
  assert.equal(callback.method, 'GET');
  assert.equal(callback.state, 'fixture-state');
  assert.ok(callback.code);
  assert.equal(callback.referer, undefined, 'Callback must not receive the consent URL in a Referer.');
  assert.deepEqual(cspErrors, [], 'Valid OAuth consent must not cause a form-action CSP error.');
  const tokenResponse = await fetch(`${origin}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code',
    client_id: client.client_id, code: callback.code, code_verifier: verifier, redirect_uri: redirectUri, resource: resource.href }) });
  assert.equal(tokenResponse.status, 200, 'The received code must complete its real PKCE token exchange.');
  const tokens = await tokenResponse.json() as { access_token: string };
  assert.equal((await provider.verifyAccessToken(tokens.access_token)).clientId, client.client_id);
});
