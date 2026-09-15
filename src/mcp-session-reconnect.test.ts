import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as reserveServer } from 'node:net';
import test, { type TestContext } from 'node:test';
import { createServer, createMcpServer } from './server.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WorkspaceRegistry } from './workspaces.js';
import { createReviewCheckpointManager } from './review-checkpoints.js';
import { ProcessSessionManager } from './process-sessions.js';
import { loadConfig } from './config.js';
import { SqliteOAuthStore } from './oauth-store.js';
import { writeTestDevspaceConfig } from './test-support/config.test.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t: TestContext, authorization: 'owner_approval' | 'legacy') {
  const root = await mkdtemp(join(tmpdir(), 'devspace-session-lifecycle-'));
  const project = join(root, 'project'); await mkdir(project); await writeFile(join(project, 'hello.txt'), 'fixture\n');
  const reserve = reserveServer(); await new Promise<void>(r => reserve.listen(0, '127.0.0.1', r));
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>(r => reserve.close(() => r()));
  const origin = `http://127.0.0.1:${port}`, resource = `${origin}/mcp`;
  const owner = 'fixture-owner-not-a-user-credential';
  const config = loadConfig({ ...writeTestDevspaceConfig(join(root, 'config'), {
    server: { port, publicBaseUrl: origin }, workspaces: { allowedRoots: [project] },
    storage: { stateDir: join(root, 'state') }, tools: { authorization },
    skills: { enabled: false, agentDir: join(root, 'agents') }, logging: { level: 'silent' },
  }), DEVSPACE_OAUTH_OWNER_TOKEN: owner });
  const application = createServer(config, { mcpSessions: { maxSessions: 1 } });
  const listener = application.app.listen(port, '127.0.0.1');
  await new Promise<void>(r => listener.once('listening', r));
  t.after(async () => { await application.close(); listener.closeAllConnections(); await new Promise<void>(r => listener.close(() => r())); await rm(root, { recursive: true, force: true }); });
  const token = 'fixture-local-access-token';
  const store = new SqliteOAuthStore(config.stateDir);
  const client = store.registerClient({ client_name: 'isolated lifecycle fixture', redirect_uris: ['http://127.0.0.1/callback'] }, ['127.0.0.1']);
  store.saveAccessToken(createHash('sha256').update(token).digest('base64url'), {
    clientId: client.client_id, scopes: ['devspace'], expiresAt: Math.floor(Date.now() / 1000) + 3600, resource,
  }); store.close();
  let id = 0;
  const headers = (session = '') => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) });
  const request = (session: string, method: string, params: unknown, signal?: AbortSignal, requestId = ++id) => fetch(resource, {
    method: 'POST', headers: headers(session), signal,
    body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
  });
  const parse = async (response: Response) => {
    const body = await response.text();
    return JSON.parse(body.startsWith('event:') ? body.split('\n').find(line => line.startsWith('data:'))!.slice(5) : body);
  };
  const initialize = () => request('', 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
  const connect = async () => { const response = await initialize(); assert.equal(response.status, 200, await (response.status === 200 ? Promise.resolve('') : response.text())); await parse(response); return response.headers.get('mcp-session-id')!; };
  const tool = async (session: string, name: string, args: Record<string, unknown>) => {
    const response = await request(session, 'tools/call', { name, arguments: args, _meta: { 'openai/session': 'same-fixture-conversation' } });
    assert.equal(response.status, 200); return (await parse(response)).result;
  };
  const open = async (session: string) => (await tool(session, 'open_workspace', { path: project })).structuredContent.workspaceId as string;
  return { root, project, origin, resource, owner, headers, request, parse, initialize, connect, tool, open, config };
}

test('capacity eviction preserves workspace, approved Owner grant and an already-started native process', async t => {
  const f = await fixture(t, 'owner_approval');
  const first = await f.connect(), workspaceId = await f.open(first);
  const args = { workspaceId, executable: process.execPath, args: ['-e', "setTimeout(() => console.log('native-complete'), 300)"], yieldTimeMs: 0 };
  const blocked = await f.tool(first, 'run_process', args);
  const approval = JSON.parse(blocked.content[0].text);
  assert.equal(approval.code, 'OWNER_APPROVAL_REQUIRED');
  const page = await fetch(approval.approvalUrl), html = await page.text();
  const nonce = /name="nonce" value="([^"]+)"/.exec(html)![1];
  const cookie = page.headers.get('set-cookie')!.split(';')[0];
  const decision = await fetch(approval.approvalUrl, { method: 'POST', headers: { origin: f.origin, cookie }, body: new URLSearchParams({ nonce, owner_token: f.owner, decision: 'approve' }) });
  assert.equal(decision.status, 200); await decision.text();
  const second = await f.connect();
  const stale = await f.request(first, 'tools/list', {}); assert.equal(stale.status, 404); await stale.text();
  assert.equal(await f.open(second), workspaceId);
  const started = await f.tool(second, 'run_process', args);
  assert.equal(started.isError, false); assert.equal(started.structuredContent.running, true);
  const sessionId = started.structuredContent.sessionId;
  const third = await f.connect(); assert.equal(await f.open(third), workspaceId);
  const completed = await f.tool(third, 'process_status', { workspaceId, sessionId, yieldTimeMs: 3000 });
  assert.equal(completed.structuredContent.exitCode, 0);
  assert.match(completed.structuredContent.output, /native-complete/);
  assert.equal(JSON.parse((await f.tool(third, 'run_process', args)).content[0].text).code, 'OWNER_APPROVAL_REQUIRED', 'grant was consumed exactly once');
  const notifications = await fetch(f.resource, { headers: f.headers(third) });
  assert.equal(notifications.status, 200);
  const fourth = await f.connect(); assert.ok(fourth, 'idle GET SSE does not pin a session');
  await notifications.body?.cancel();
});

for (const disconnect of [true, false]) test(`cancelled POST protects its handler and releases capacity (disconnect=${disconnect})`, async t => {
  const f = await fixture(t, 'legacy');
  const first = await f.connect(), workspaceId = await f.open(first);
  const marker = join(f.project, 'started');
  const controller = new AbortController();
  const pending = f.request(first, 'tools/call', { name: 'run_process', arguments: {
    workspaceId, executable: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'fixture'); setTimeout(() => console.log('done'), 500)`], yieldTimeMs: 3000,
  } }, controller.signal, 5000).then(response => response.text());
  const finishedBody = pending.catch(error => { if (!disconnect) throw error; assert.match(String(error), /abort/i); return ''; });
  let seen = false;
  for (let i = 0; i < 100; i++) { try { await access(marker); seen = true; break; } catch { await pause(5); } }
  assert.ok(seen, 'isolated native handler started');
  const cancellation = await fetch(f.resource, { method: 'POST', headers: f.headers(first), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 5000, reason: 'fixture cancellation' } }) });
  assert.equal(cancellation.status, 202); await cancellation.text();
  if (disconnect) controller.abort();
  await pause(20);
  const busy = await f.initialize(); assert.equal(busy.status, 503); assert.equal(busy.headers.get('retry-after'), '1'); await busy.text();
  await pause(550);
  const reconnected = await f.connect(); assert.equal(await f.open(reconnected), workspaceId, 'cancelled handler released without sending a response');
  await finishedBody;
});


test('cancellation queued after handler completion but before SDK response still settles the HTTP owner', async t => {
  const f = await fixture(t, 'legacy');
  const [client, transport] = InMemoryTransport.createLinkedPair();
  const processes = new ProcessSessionManager();
  let released = false, cancelledAfterRelease = false;
  const replies: unknown[] = [];
  client.onmessage = message => { replies.push(message); };
  const server = createMcpServer(f.config, new WorkspaceRegistry(f.config), createReviewCheckpointManager(), processes, () => [], [], undefined, undefined,
    () => () => {
      released = true;
      // SDK notification handlers run in a microtask. This delivers cancellation
      // after wrapper finally but before the SDK's response .then callback.
      void client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
    },
    id => { assert.equal(id, 7); assert.equal(released, true); cancelledAfterRelease = true; });
  server.registerTool('fixture_race', { inputSchema: {} }, () => ({ content: [{ type: 'text', text: 'fixture' }] }));
  t.after(async () => { await server.close(); await processes.shutdown(); });
  await server.connect(transport); await client.start();
  await client.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'fixture_race', arguments: {} } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelledAfterRelease, true, 'post-handler cancellation must not pin the HTTP lease');
  assert.equal(replies.length, 0, 'SDK suppressed the cancelled response');
});
