import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Request, Response } from 'express';
import test from 'node:test';
import { SingleUserOAuthProvider } from './oauth-provider.js';
import { establishOwnerSession, readOwnerSession, ownerSessionFormProof, ownerSessionFormValid } from './owner-session.js';
import { classifyMcpOperation } from './mcp-authorization.js';
import { loadConfig } from './config.js';
import { writeTestDevspaceConfig } from './test-support/config.test.js';

const config = { ownerToken: 'fixture-owner-password-long-enough', ownerSessionTtlSeconds: 43200, accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 2592000, scopes: ['devspace'], allowedRedirectHosts: ['chatgpt.com'] };
function removeFixture(root: string) {
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  rmSync(root, { recursive: true, force: true });
}
function response(method = 'POST', body: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const captured = { status: 200, html: '', redirect: '', cookies: [] as { name: string; value: string; options: any }[] };
  const res = { req: { method, body, headers }, status(code: number) { captured.status = code; return this; }, setHeader() { return this; },
    send(html: string) { captured.html = html; return this; }, redirect(_code: number, location: string) { captured.redirect = location; },
    cookie(name: string, value: string, options: unknown) { captured.cookies.push({ name, value, options }); return this; } } as unknown as Response;
  return { res, captured };
}
test('Owner browser session is signed, absolute, origin-bound and does not approve an operation', () => {
  const now = Date.now(), origin = 'https://fixture.example';
  const { res, captured } = response();
  const session = establishOwnerSession(res, config, origin, now)!;
  const cookie = captured.cookies[0]!;
  assert.equal(cookie.name, '__Host-devspace-owner');
  assert.deepEqual(cookie.options, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 43200000 });
  const req = { headers: { cookie: `${cookie.name}=${cookie.value}` } } as Request;
  assert.equal(readOwnerSession(req, config, origin, now + 43199000)?.issuedAt, session.issuedAt);
  assert.equal(readOwnerSession(req, config, origin, session.expiresAt * 1000), undefined);
  assert.equal(readOwnerSession(req, { ...config, ownerToken: 'different' }, origin, now), undefined);
  assert.equal(readOwnerSession(req, config, 'https://other.example', now), undefined);
  assert.equal(readOwnerSession({ headers: { cookie: `${cookie.name}=${cookie.value}forged` } } as Request, config, origin, now), undefined);
  const fields = { client_id: 'one', state: 'fixture' }, proof = ownerSessionFormProof(session, fields, config);
  assert.ok(ownerSessionFormValid(proof, session, fields, config));
  assert.equal(ownerSessionFormValid(proof, session, { ...fields, client_id: 'two' }, config), false);
});

test('OAuth password verification expires after 12 hours despite refresh, restart and cookie reuse', async t => {
  const root = mkdtempSync(join(tmpdir(), 'devspace-owner-age-'));
  let now = Math.floor(Date.now() / 1000) * 1000;
  const started = now, resource = new URL('https://fixture.example/mcp');
  let provider = new SingleUserOAuthProvider(config, resource, root, () => now);
  t.after(() => { provider.close(); removeFixture(root); });
  const client = await provider.clientsStore.registerClient!({ redirect_uris: ['https://chatgpt.com/callback'], client_name: 'Fixture', token_endpoint_auth_method: 'none' });
  const params = { redirectUri: 'https://chatgpt.com/callback', codeChallenge: 'fixture-challenge', resource, state: 'fixture', scopes: ['devspace'] };
  const login = response('POST', { owner_token: config.ownerToken }, { origin: resource.origin });
  await provider.authorize(client, params, login.res);
  const code = new URL(login.captured.redirect).searchParams.get('code')!;
  const initial = await provider.exchangeAuthorizationCode(client, code, undefined, params.redirectUri, resource);
  assert.ok(initial.access_token.startsWith('ds1.'));
  const owner = login.captured.cookies[0]!, cookie = `${owner.name}=${owner.value}`;
  now += 60000;
  const consent = response('GET', {}, { cookie }); await provider.authorize(client, params, consent.res);
  assert.doesNotMatch(consent.captured.html, /name="owner_token"/);
  const proof = /name="owner_session_proof" value="([^"]+)"/.exec(consent.captured.html)![1];
  const altered = response('POST', { owner_session_proof: proof }, { cookie, origin: resource.origin });
  await provider.authorize(client, { ...params, state: 'different' }, altered.res); assert.equal(altered.captured.status, 401);
  const forged = response('POST', { owner_session_proof: proof }, { cookie, origin: 'https://attacker.example' });
  await provider.authorize(client, params, forged.res); assert.equal(forged.captured.status, 401);
  const repeat = response('POST', { owner_session_proof: proof }, { cookie, origin: resource.origin });
  await provider.authorize(client, params, repeat.res);
  const repeatCode = new URL(repeat.captured.redirect).searchParams.get('code')!;
  const repeatTokens = await provider.exchangeAuthorizationCode(client, repeatCode, undefined, params.redirectUri, resource);
  assert.equal(repeatTokens.access_token.split('.')[1], initial.access_token.split('.')[1], 'cookie activity cannot move the password-verification timestamp');
  now = started + (12 * 3600 - 60) * 1000;
  provider.close(); provider = new SingleUserOAuthProvider(config, resource, root, () => now);
  const refreshed = await provider.exchangeRefreshToken(client, initial.refresh_token!, undefined, resource);
  assert.equal(refreshed.expires_in, 60);
  await provider.verifyAccessToken(refreshed.access_token);
  await assert.rejects(provider.verifyAccessToken(refreshed.access_token.replace(/ds1\.\d+\./, `ds1.${Math.floor(now / 1000)}.`)), /Invalid/);
  now = started + 12 * 3600000;
  await assert.rejects(provider.verifyAccessToken(refreshed.access_token), /expired/);
  await assert.rejects(provider.exchangeRefreshToken(client, refreshed.refresh_token!, undefined, resource), /Invalid|expired/);
  const expired = response('GET', {}, { cookie }); await provider.authorize(client, params, expired.res);
  assert.match(expired.captured.html, /name="owner_token"/);
});

test('enabling the login deadline rejects old tokens without deleting or migrating OAuth state', async t => {
  const root = mkdtempSync(join(tmpdir(), 'devspace-owner-cutover-'));
  let provider = new SingleUserOAuthProvider({ ...config, ownerSessionTtlSeconds: undefined }, new URL('https://fixture.example/mcp'), root);
  t.after(() => { provider.close(); removeFixture(root); });
  const client = await provider.clientsStore.registerClient!({ redirect_uris: ['https://chatgpt.com/callback'] });
  const params = { redirectUri: 'https://chatgpt.com/callback', codeChallenge: 'fixture', resource: new URL('https://fixture.example/mcp'), scopes: ['devspace'] };
  const login = response('POST', { owner_token: config.ownerToken });
  await provider.authorize(client, params, login.res);
  const tokens = await provider.exchangeAuthorizationCode(client, new URL(login.captured.redirect).searchParams.get('code')!, undefined, params.redirectUri, params.resource);
  await provider.verifyAccessToken(tokens.access_token);
  provider.close(); provider = new SingleUserOAuthProvider(config, params.resource, root);
  assert.ok(await provider.clientsStore.getClient(client.client_id));
  await assert.rejects(provider.verifyAccessToken(tokens.access_token), /Owner login expired/);
  await assert.rejects(provider.exchangeRefreshToken(client, tokens.refresh_token!, undefined, params.resource), /predates this policy/);
});

test('high-risk-only profile automatically permits ordinary file edits but retains dangerous capability gates', t => {
  const root = mkdtempSync(join(tmpdir(), 'devspace-risk-profile-')), project = join(root, 'project'); mkdirSync(project);
  t.after(() => removeFixture(root));
  const cfg = loadConfig(writeTestDevspaceConfig(join(root, 'config'), { workspaces: { allowedRoots: [project] }, tools: { approvalProfile: 'high_risk_only' } }));
  const workspaces = { getWorkspace: () => { throw Error('not needed'); }, resolveReadPath: () => { throw Error('not needed'); } };
  assert.equal(classifyMcpOperation(cfg, workspaces, 'write', { path: join(project, 'ordinary.ts'), content: 'ok' }).reason, undefined);
  assert.equal(classifyMcpOperation(cfg, workspaces, 'edit', { path: join(project, 'ordinary.ts'), oldText: 'a', newText: 'b' }).reason, undefined);
  assert.ok(classifyMcpOperation(cfg, workspaces, 'write', { path: join(project, 'package.json'), content: '{}' }).reason);
  assert.ok(classifyMcpOperation(cfg, workspaces, 'read', { path: join(project, '.env') }).reason);
  assert.ok(classifyMcpOperation(cfg, workspaces, 'exec_command', { cmd: 'arbitrary code' }).reason);
  assert.ok(classifyMcpOperation(cfg, workspaces, 'codex_task_start', { prompt: 'arbitrary delegated work', writeMode: 'read_only' }).reason);
  assert.ok(classifyMcpOperation(cfg, workspaces, 'apply_patch', { patch: `*** Begin Patch\n*** Delete File: ${join(project, 'ordinary.ts')}\n*** End Patch` }).reason);
  assert.throws(() => classifyMcpOperation(cfg, workspaces, 'write', { path: join(root, 'outside'), content: 'no' }), /outside/);
});
