import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import express from 'express';
import { devspaceConfigSchema } from './config-schema.js';
import { loadConfig } from './config.js';
import { OwnerApprovals, installOwnerApprovalRoutes } from './mcp-authorization.js';
import { writeTestDevspaceConfig } from './test-support/config.test.js';

const operation = { principal: 'fixture-client:chat', tool: 'fixture.noop', args: {}, context: {}, reason: 'Inert lifetime test.' };
const minutes = (value: number) => value * 60_000;

test('approval window defaults to 30 minutes and configuration accepts only 30-120 minutes', () => {
  assert.equal(devspaceConfigSchema.parse({ configVersion: 1 }).tools.approvalTtlSeconds, 1800);
  for (const seconds of [1800, 3600, 7200]) {
    assert.equal(devspaceConfigSchema.parse({ configVersion: 1, tools: { approvalTtlSeconds: seconds } }).tools.approvalTtlSeconds, seconds);
  }
  for (const seconds of [0, -1, 1799, 7201, 1800.5, NaN, Infinity, '1800', null]) {
    assert.throws(() => devspaceConfigSchema.parse({ configVersion: 1, tools: { approvalTtlSeconds: seconds } }));
  }
});

test('loading the approval window does not change the 12-hour Owner login policy', () => {
  const root = mkdtempSync(join(tmpdir(), 'devspace-window-config-'));
  try {
    const config = loadConfig(writeTestDevspaceConfig(root, {
      tools: { approvalTtlSeconds: 7200 }, oauth: { ownerSessionTtlSeconds: 43200 },
    }));
    assert.equal(config.approvalTtlSeconds, 7200);
    assert.equal(config.oauth.ownerSessionTtlSeconds, 43200);
  } finally {
    assert.equal(dirname(realpathSync(root)), realpathSync(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('default approval survives short waits but repeated access never slides its 30-minute deadline', () => {
  let now = Date.UTC(2026, 8, 9);
  const store = new OwnerApprovals(() => now);
  const pending = store.require(operation);
  if (pending.allowed) throw Error('unexpected execution grant');
  const { id, expires } = pending.approval;
  assert.equal(expires - now, minutes(30));
  now += minutes(10);
  assert.equal(store.inspect(id)?.state, 'pending');
  store.challenge(id);
  assert.equal(store.reviewUi(id, operation.principal).expiresAt, new Date(expires).toISOString());
  const repeated = store.require(operation);
  if (repeated.allowed) throw Error('reading a request must not approve it');
  assert.equal(repeated.approval.id, id);
  assert.equal(repeated.approval.expires, expires);
  now = expires - 1;
  assert.ok(store.inspect(id));
  now = expires;
  assert.equal(store.inspect(id), undefined);
  assert.throws(() => store.reviewUi(id, operation.principal), /unavailable/);
});

test('the two-hour window expires exactly and a longer window cannot create a grant', () => {
  let now = 0;
  const store = new OwnerApprovals(() => now, minutes(120));
  const pending = store.require(operation);
  if (pending.allowed) throw Error('unexpected grant');
  now = minutes(120) - 1;
  assert.ok(store.inspect(pending.approval.id));
  now++;
  assert.equal(store.inspect(pending.approval.id), undefined);
  for (const ttl of [0, -1, NaN, Infinity, minutes(120) + 1]) {
    assert.throws(() => new OwnerApprovals(() => now, ttl), /lifetime/i);
  }
});

test('late approval remains principal-bound and consumable exactly once', () => {
  let now = 0;
  const store = new OwnerApprovals(() => now, minutes(120));
  const pending = store.require(operation);
  if (pending.allowed) throw Error('unexpected grant');
  const view = store.reviewUi(pending.approval.id, operation.principal);
  now = minutes(119);
  assert.throws(() => store.decideUi(view.id, 'other-client', view.decisionToken!, true), /unavailable/);
  store.decideUi(view.id, operation.principal, view.decisionToken!, true);
  assert.equal(store.require({ ...operation, args: { changed: true } }).allowed, false);
  assert.equal(store.require(operation).allowed, true);
  assert.equal(store.require(operation).allowed, false);
});

test('a decision does not extend an unconsumed authorization beyond its deadline', () => {
  let now = 0;
  const store = new OwnerApprovals(() => now, minutes(120));
  const pending = store.require(operation);
  if (pending.allowed) throw Error('unexpected grant');
  const view = store.reviewUi(pending.approval.id, operation.principal);
  now = minutes(119);
  store.decideUi(view.id, operation.principal, view.decisionToken!, true);
  assert.equal(store.inspect(view.id)?.expires, minutes(120));
  now = minutes(120);
  assert.equal(store.require(operation).allowed, false);
});

test('Owner form cookie and visible expiry use the original request deadline', async t => {
  const root = mkdtempSync(join(tmpdir(), 'devspace-window-http-'));
  let now = Date.now();
  const store = new OwnerApprovals(() => now, minutes(120));
  const app = express();
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await store.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(dirname(realpathSync(root)), realpathSync(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config = loadConfig(writeTestDevspaceConfig(root, {
    server: { publicBaseUrl: origin }, logging: { level: 'silent' },
  }));
  installOwnerApprovalRoutes(app, config, store);
  const pending = store.require(operation);
  if (pending.allowed) throw Error('unexpected grant');
  const { id, expires } = pending.approval;
  for (const elapsed of [minutes(20), minutes(119)]) {
    now = expires - minutes(120) + elapsed;
    const response = await fetch(`${origin}/owner/approvals/${id}`);
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')!;
    const cookieExpiry = /expires=([^;]+)/i.exec(cookie)?.[1];
    assert.ok(cookieExpiry);
    assert.equal(Date.parse(cookieExpiry), Math.floor(expires / 1000) * 1000);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const html = await response.text();
    assert.ok(html.includes(new Date(expires).toISOString()));
    assert.doesNotMatch(html, /expiring in five minutes/);
    assert.equal(store.inspect(id)?.expires, expires);
  }
  now = expires;
  assert.equal((await fetch(`${origin}/owner/approvals/${id}`)).status, 404);
});

test('approval expiry does not cancel submission or replay a submitted task', async () => {
  let now = 0, calls = 0;
  let finish!: () => void;
  const store = new OwnerApprovals(() => now);
  const task = { ...operation, tool: 'codex_task_start' };
  const pending = store.require(task, async () => {
    calls++;
    await new Promise<void>(resolve => { finish = resolve; });
    return { agentId: 'agt-lifetime-fixture', workspaceId: 'ws-lifetime-fixture' };
  });
  if (pending.allowed) throw Error('unexpected grant');
  const view = store.reviewUi(pending.approval.id, operation.principal);
  store.decideUi(view.id, operation.principal, view.decisionToken!, true);
  await Promise.resolve();
  try {
    now = minutes(121);
    assert.equal(store.inspect(view.id)?.state, 'submitting');
  } finally { finish(); }
  await new Promise<void>(resolve => setImmediate(resolve));
  const receipt = store.require(task);
  if (receipt.allowed) throw Error('submitted work must not receive a new execution grant');
  assert.equal(receipt.approval.state, 'submitted');
  assert.equal(calls, 1);
  await store.close();
});
