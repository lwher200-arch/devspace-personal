import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as reserveServer } from 'node:net';
import test from 'node:test';
import { Result } from 'better-result';
import { CodexBridge } from './codex-bridge.js';
import type { LocalAgentRecord } from './local-agent-store.js';
import { OwnerApprovals, approvalPrincipal, classifyMcpOperation } from './mcp-authorization.js';
import { REVIEW_APPROVAL_CENTER_COMPAT_ID, REVIEW_APPROVAL_CLAIM_COMPAT_PREFIX } from './approval-protocol.js';
import { createServer } from './server.js';
import { loadConfig } from './config.js';
import { writeTestDevspaceConfig } from './test-support/config.test.js';
import { WorkspaceLeaseStore } from './workspace-lease/workspace-lease.js';
import { A2_WORKSPACE_LEASE_POLICY_VERSION } from './workspace-lease/workspace-lease-runtime.js';
import type { WorkspaceExecutionBoundary } from './workspace-execution-boundary.js';

const owner = 'fixture-only-owner-password-long-enough';
const operation = { principal: 'client:session', tool: 'exec_command', args: { cmd: 'echo ok' }, context: { root: 'fixture' }, reason: 'shell' };
test('Chat approval requires a private UI capability bound to the exact principal and request', () => {
  let now = 0; const store = new OwnerApprovals(() => now, 100);
  const pending = store.require(operation); if (pending.allowed) throw Error('unexpected');
  const id = pending.approval.id;
  const view = store.reviewUi(id, operation.principal);
  assert.ok(view.decisionToken);
  assert.throws(() => store.reviewUi(id, 'other-client'), /unavailable/);
  assert.throws(() => store.decideUi(id, operation.principal, 'forged', true), /unavailable/);
  assert.throws(() => store.decideUi(id, 'other-conversation', view.decisionToken!, true), /unavailable/);
  assert.equal(store.inspect(id)?.state, 'pending');
  const other = store.require({ ...operation, args: { cmd: 'different' } }); if (other.allowed) throw Error('unexpected');
  assert.throws(() => store.decideUi(other.approval.id, operation.principal, view.decisionToken!, true), /unavailable/);
  const decided = store.decideUi(id, operation.principal, view.decisionToken!, true);
  assert.equal(decided.state, 'approved');
  assert.equal(store.decideUi(id, operation.principal, view.decisionToken!, false).state, 'approved', 'decision replay cannot change the outcome');
  assert.equal(store.require(operation).allowed, true);
  assert.equal(store.require(operation).allowed, false, 'UI approval remains single-use');
  now = 101;
  assert.throws(() => store.reviewUi(other.approval.id, operation.principal), /unavailable/);
});

test('approval center groups only the current principal and exposes pending decision capabilities privately', () => {
  const store = new OwnerApprovals(() => 0, 1000);
  const first = store.require(operation); if (first.allowed) throw Error('unexpected');
  const second = store.require({ ...operation, args: { cmd: 'echo two' } }); if (second.allowed) throw Error('unexpected');
  store.require({ ...operation, principal: 'other-principal', args: { cmd: 'echo foreign' } });
  const center = store.reviewConversationUi(operation.principal);
  assert.equal(center.approvals.length, 2);
  assert.ok(center.approvals.every(view => view.state !== 'pending' || Boolean(view.decisionToken)));
  assert.equal(center.approvals.some(view => view.args.cmd === 'echo foreign'), false);
});

test('Codex approval submits once without a Chat retry and retains a scoped receipt', async () => {
  const store = new OwnerApprovals(); let calls = 0;
  const task = { ...operation, tool: 'codex_task_start', args: { workspaceId: 'ws-fixture', requestKey: 'one', prompt: 'read only' } };
  const request = store.require(task, async () => { calls++; return { agentId: 'agt-fixture', workspaceId: 'ws-fixture' }; });
  if (request.allowed) throw Error('unexpected');
  const id = request.approval.id, nonce = store.challenge(id);
  assert.equal(calls, 0);
  assert.equal(store.decide(id, nonce, 'wrong', owner, true), false);
  assert.equal(calls, 0);
  assert.equal(store.decide(id, nonce, owner, owner, true), true);
  assert.equal(store.decide(id, nonce, owner, owner, true), false);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 1, 'Owner approval must dispatch without another MCP call');
  const replay = store.require(task); if (replay.allowed) throw Error('must return receipt, not a second execution grant');
  assert.equal(replay.approval.state, 'submitted');
  assert.deepEqual(replay.approval.submission, { agentId: 'agt-fixture', workspaceId: 'ws-fixture' });
  assert.equal(calls, 1);
  for (const changed of [{ ...task, principal: 'another-client' }, { ...task, args: { ...task.args, prompt: 'changed' } }, { ...task, context: { root: 'elsewhere' } }]) {
    const denied = store.require(changed); if (denied.allowed) throw Error('unexpected');
    assert.equal(denied.approval.state, 'pending');
  }
});

test('automatic submission is fail-closed on denial, expiry, shutdown and failure', async () => {
  let now = 0, calls = 0; const store = new OwnerApprovals(() => now, 100);
  const task = { ...operation, tool: 'codex_task_continue' };
  const submit = async () => { calls++; throw Error('fixture submission failure'); };
  const request = store.require(task, submit); if (request.allowed) throw Error('unexpected');
  const id = request.approval.id;
  assert.equal(store.decide(id, store.challenge(id), owner, owner, false), true);
  assert.equal(calls, 0);
  store.clear();
  const expired = store.require(task, submit); if (expired.allowed) throw Error('unexpected');
  const nonce = store.challenge(expired.approval.id); now = 101;
  assert.equal(store.decide(expired.approval.id, nonce, owner, owner, true), false);
  assert.equal(calls, 0);
  const failed = store.require(task, submit); if (failed.allowed) throw Error('unexpected');
  store.decide(failed.approval.id, store.challenge(failed.approval.id), owner, owner, true);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(store.inspect(failed.approval.id)?.state, 'failed');
  store.require(task, submit); assert.equal(calls, 1, 'failed delivery must not automatically retry');
  await store.close();
  assert.throws(() => store.require(task, submit), /closed/);
});

test('approval is principal/argument/context bound, single-use, bounded and fail-closed', () => {
  let now = 0; const store = new OwnerApprovals(() => now, 100);
  const pending = store.require(operation); assert.equal(pending.allowed, false); if (pending.allowed) return;
  const id = pending.approval.id, nonce = store.challenge(id);
  assert.equal(store.decide(id, 'forged', owner, owner, true), false);
  assert.equal(store.decide(id, nonce, 'wrong', owner, true), false);
  assert.equal(store.decide(id, nonce, owner, owner, true), true);
  assert.equal(store.require({ ...operation, principal: 'other' }).allowed, false);
  assert.equal(store.require({ ...operation, args: { cmd: 'different' } }).allowed, false);
  assert.equal(store.require({ ...operation, context: { root: 'changed' } }).allowed, false);
  assert.equal(store.require(operation).allowed, true);
  assert.equal(store.require(operation).allowed, false);
  now = 101; assert.equal(store.inspect(id), undefined);
  const request = store.require(operation); if (request.allowed) throw Error('unexpected');
  assert.equal(store.decide(request.approval.id, store.challenge(request.approval.id), owner, owner, false), true);
  const denied = store.require(operation); assert.equal(denied.allowed, false);
  if (!denied.allowed) {
    assert.equal(denied.approval.state, 'denied');
    assert.throws(() => store.prepareRelaunch(denied.approval.id, 'other-principal'), /unavailable/);
    assert.equal(store.prepareRelaunch(denied.approval.id, operation.principal).state, 'denied');
    const relaunched = store.require(operation); assert.equal(relaunched.allowed, false);
    if (!relaunched.allowed) {
      assert.equal(relaunched.approval.state, 'pending');
      assert.notEqual(relaunched.approval.id, denied.approval.id, 'relaunch creates a fresh decision record instead of rewriting denial');
    }
  }
  store.clear(); assert.equal(store.require(operation).allowed, false);
  for (let i=0;i<19;i++) store.require({ ...operation, args: { cmd: String(i) } });
  assert.throws(() => store.require({ ...operation, args: { cmd: 'overflow' } }), /Too many/);
});

test('conversation approval leases are narrow, principal-bound, fixed-lifetime and revocable', () => {
  let now = 0;
  const store = new OwnerApprovals(() => now, 1000);
  const review = { principal: 'client:chat', tool: 'show_changes', args: { workspaceId: 'ws-fixture' },
    context: { root: '/fixture', targets: [] }, reason: 'review' };
  const pending = store.require(review); if (pending.allowed) throw Error('unexpected');
  const view = store.reviewUi(pending.approval.id, review.principal);
  assert.equal(view.conversationLease?.scope, 'safe reviews/worktrees in this project');
  assert.deepEqual(view.conversationLease?.scopes, ['safe reviews/worktrees in this project', 'worktrees from this project']);
  const decided = store.decideUiForConversation(view.id, review.principal, view.decisionToken!);
  assert.equal(decided.state, 'approved');
  assert.equal(decided.conversationLease?.expiresAt, new Date(1000).toISOString());
  assert.equal(store.require(review).allowed, true, 'the exact reviewed request keeps its single-use grant');
  const repeated = store.require(review); assert.equal(repeated.allowed, true);
  if (!repeated.allowed) throw Error('expected lease');
  assert.equal(repeated.source, 'conversation_lease');
  assert.equal(store.require({ ...review, principal: 'client:other-chat' }).allowed, false);
  assert.equal(store.require({ ...review, args: { workspaceId: 'ws-other' }, context: { root: '/other', targets: [] } }).allowed, false);
  assert.equal(store.revokeConversationLeases(review.principal), 2, 'review approval creates only safe project review/worktree scopes');
  assert.equal(store.require(review).allowed, false, 'revocation restores normal approval');

  const native = { principal: 'client:chat', tool: 'run_process',
    args: { workspaceId: 'ws-fixture', executable: 'node', args: ['--version'], workingDirectory: '.' },
    context: { root: '/fixture', targets: [] }, reason: 'native' };
  const nativePending = store.require(native); if (nativePending.allowed) throw Error('unexpected');
  const nativeView = store.reviewUi(nativePending.approval.id, native.principal);
  store.decideUiForConversation(nativeView.id, native.principal, nativeView.decisionToken!);
  assert.equal(store.require(native).allowed, true);
  assert.equal(store.require(native).allowed, true);
  assert.equal(store.require({ ...native, args: { ...native.args, args: ['-p', 'process.version'] } }).allowed, false,
    'native leases require the complete argument set to remain exact');

  const host = { principal: 'client:host-chat', tool: 'host_command',
    args: { workspaceId: 'ws-fixture', command: 'systemctl --user status fixture', workingDirectory: '.' },
    context: { root: '/fixture', targets: [] }, reason: 'host maintenance' };
  const hostPending = store.require(host); if (hostPending.allowed) throw Error('unexpected');
  const hostView = store.reviewUi(hostPending.approval.id, host.principal);
  assert.equal(hostView.conversationLease?.scope, 'this exact host maintenance command request');
  store.decideUiForConversation(hostView.id, host.principal, hostView.decisionToken!);
  assert.equal(store.require(host).allowed, true, 'the exact host command keeps its one exact grant');
  const repeatedHost = store.require(host); assert.equal(repeatedHost.allowed, true);
  if (!repeatedHost.allowed) throw Error('expected exact host command lease');
  assert.equal(repeatedHost.source, 'conversation_lease');
  assert.equal(store.require({ ...host, args: { ...host.args, command: 'systemctl --user restart fixture' } }).allowed, false,
    'host command leases never broaden command text');

  const shellPending = store.require(operation); if (shellPending.allowed) throw Error('unexpected');
  const shellView = store.reviewUi(shellPending.approval.id, operation.principal);
  assert.equal(shellView.conversationLease?.scope, 'this exact shell command request');
  assert.deepEqual(shellView.conversationLease?.scopes, [
    'this exact shell command request', 'safe reviews/worktrees in this project', 'worktrees from this project',
  ]);
  store.decideUiForConversation(shellView.id, operation.principal, shellView.decisionToken!);
  assert.equal(store.require(operation).allowed, true, 'the explicitly approved shell keeps its one exact grant');
  const repeatedShell = store.require(operation); assert.equal(repeatedShell.allowed, true, 'the same exact shell request may reuse the bounded conversation lease');
  if (!repeatedShell.allowed) throw Error('expected exact shell lease');
  assert.equal(repeatedShell.source, 'conversation_lease');
  const safeReview = store.require({ ...review, principal: operation.principal, context: { root: 'fixture', targets: [] } });
  assert.equal(safeReview.allowed, true, 'the same click may still lease safe review/worktree operations for the project');
  if (!safeReview.allowed) throw Error('expected safe project lease');
  assert.equal(safeReview.source, 'conversation_lease');
  assert.equal(store.require({ ...operation, args: { cmd: 'different' } }).allowed, false, 'the shell lease never broadens command arguments');

  const claudeShell = { ...operation, principal: 'client:claude', tool: 'bash', args: { command: 'echo ok' } };
  const claudeShellPending = store.require(claudeShell); if (claudeShellPending.allowed) throw Error('unexpected');
  const claudeShellView = store.reviewUi(claudeShellPending.approval.id, claudeShell.principal);
  assert.equal(claudeShellView.conversationLease?.scope, 'this exact shell command request');
  store.decideUiForConversation(claudeShellView.id, claudeShell.principal, claudeShellView.decisionToken!);
  assert.equal(store.require(claudeShell).allowed, true);
  const repeatedClaudeShell = store.require(claudeShell); assert.equal(repeatedClaudeShell.allowed, true);
  if (!repeatedClaudeShell.allowed) throw Error('expected exact Claude shell lease');
  assert.equal(repeatedClaudeShell.source, 'conversation_lease');
  assert.equal(store.require({ ...claudeShell, args: { command: 'echo changed' } }).allowed, false,
    'Claude shell leases require the complete command request to remain exact');
  now = 1000;
  assert.equal(store.revokeConversationLeases(native.principal), 0, 'expired leases are pruned without renewal');
});

test('approved receipts can be claimed across host session rotation only within the same OAuth client', () => {
  const store = new OwnerApprovals(() => 0, 1000);
  const first = approvalPrincipal('client-a', { 'openai/session': 'turn-a' });
  const next = approvalPrincipal('client-a', { 'openai/session': 'turn-b' });
  const foreign = approvalPrincipal('client-b', { 'openai/session': 'turn-b' });
  const request = { principal: first, tool: 'run_process',
    args: { workspaceId: 'ws-fixture', executable: 'node', args: ['--version'], workingDirectory: '.' },
    context: { root: '/fixture', targets: [] }, reason: 'native' };
  const pending = store.require(request); if (pending.allowed) throw Error('unexpected');
  const view = store.reviewUi(pending.approval.id, first);
  store.decideUiForConversation(view.id, first, view.decisionToken!);
  const driftedRequest = { ...request, principal: next };
  const driftedPending = store.require(driftedRequest); if (driftedPending.allowed) throw Error('unexpected');
  assert.throws(() => store.claimApproved(view.id, foreign), /authorized/);
  const claimed = store.claimApproved(view.id, next);
  assert.equal(claimed.state, 'approved');
  assert.equal(store.inspect(driftedPending.approval.id), undefined, 'claim removes only the duplicate undecided request created by session drift');
  assert.equal(store.require(driftedRequest).allowed, true, 'the exact approved operation is consumable once after claim');
  const leased = store.require(driftedRequest); assert.equal(leased.allowed, true);
  if (!leased.allowed) throw Error('expected migrated lease');
  assert.equal(leased.source, 'conversation_lease');
  assert.equal(store.require({ ...driftedRequest, args: { ...driftedRequest.args, args: ['-p', 'process.version'] } }).allowed, false,
    'claim never broadens an exact native-process lease');
  const third = approvalPrincipal('client-a', { 'openai/session': 'turn-c' });
  const thirdRequest = { ...request, principal: third };
  const thirdPending = store.require(thirdRequest); if (thirdPending.allowed) throw Error('unexpected');
  const reclaimed = store.claimApproved(view.id, third);
  assert.equal(reclaimed.state, 'approved', 'the active lease lineage survives consumption of the original one-shot grant');
  assert.equal(store.inspect(thirdPending.approval.id), undefined, 'reclaim removes the duplicate pending request from the later session drift');
  const thirdLease = store.require(thirdRequest); assert.equal(thirdLease.allowed, true);
  if (!thirdLease.allowed) throw Error('expected repeatedly migrated lease');
  assert.equal(thirdLease.source, 'conversation_lease');
  assert.equal(store.revokeConversationLeases(third), 3, 'revocation removes project review/worktree and exact native scopes');
  assert.equal(store.inspect(view.id), undefined, 'revocation also removes the consumed lineage receipt');
});

test('processed approvals do not consume the per-principal pending quota', () => {
  const store = new OwnerApprovals(() => 0, 1000);
  for (let i = 0; i < 20; i++) {
    const request = { ...operation, args: { cmd: `echo denied-${i}` } };
    const pending = store.require(request); if (pending.allowed) throw Error('unexpected');
    const view = store.reviewUi(pending.approval.id, request.principal);
    assert.equal(store.decideUi(view.id, request.principal, view.decisionToken!, false).state, 'denied');
  }
  const next = store.require({ ...operation, args: { cmd: 'echo next' } });
  assert.equal(next.allowed, false, 'processed archive entries must not block a new pending request');
  if (next.allowed) throw Error('unexpected');
  assert.equal(next.approval.state, 'pending');
});

test('terminal approval history can be recycled without revoking active authority', () => {
  const store = new OwnerApprovals(() => 0, 1000);
  const denied = store.require(operation); if (denied.allowed) throw Error('unexpected');
  const deniedView = store.reviewUi(denied.approval.id, operation.principal);
  const decided = store.decideUi(deniedView.id, operation.principal, deniedView.decisionToken!, false);
  assert.equal(decided.recyclable, true);
  assert.equal(store.recycleConversationApprovals(operation.principal), 1);
  assert.equal(store.inspect(deniedView.id), undefined);

  const review = { principal: operation.principal, tool: 'show_changes', args: { workspaceId: 'ws-fixture' },
    context: { root: '/fixture', targets: [] }, reason: 'review' };
  const pending = store.require(review); if (pending.allowed) throw Error('unexpected');
  const view = store.reviewUi(pending.approval.id, review.principal);
  const approved = store.decideUiForConversation(view.id, review.principal, view.decisionToken!);
  assert.equal(approved.recyclable, false, 'an active lease lineage is not recyclable');
  assert.equal(store.recycleConversationApprovals(review.principal), 0);
});

test('real OAuth/MCP requires independent Owner approval before command side effects', { timeout: 60000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'devspace-owner-http-'));
  const project = join(root, 'project'); mkdirSync(project);
  writeFileSync(join(project,'hello.txt'),'hello\n');
  const reserve = reserveServer(); await new Promise<void>(r => reserve.listen(0, '127.0.0.1', r));
  const port = (reserve.address() as {port:number}).port; await new Promise<void>(r => reserve.close(() => r()));
  const origin = `http://127.0.0.1:${port}`, resource = `${origin}/mcp`;
  const config = loadConfig({ ...writeTestDevspaceConfig(join(root,'config'), {
    server: { port, publicBaseUrl: origin }, workspaces: { allowedRoots: [project] },
    storage: { stateDir: join(root,'state') }, skills: { enabled: false }, tools: { authorization: 'owner_approval', approvalTtlSeconds: 7200 },
    logging: { level: 'silent' },
  }), DEVSPACE_OAUTH_OWNER_TOKEN: owner });
  const noWorkspace = { getWorkspace:()=>{throw Error('not needed');}, resolveReadPath:()=>{throw Error('not needed');} };
  assert.ok(classifyMcpOperation(config,noWorkspace,'codex_task_start',{writeMode:'read_only',prompt:'read protected files'}).reason);
  assert.ok(classifyMcpOperation(config,noWorkspace,'show_changes',{}).reason);
  assert.match(
    classifyMcpOperation(config, noWorkspace, 'exec_command', { cmd: 'echo bounded' }, 'fixture-boundary-v1').reason ?? '',
    /confined.*fixture-boundary-v1/,
  );
  assert.match(
    classifyMcpOperation(config, noWorkspace, 'run_process', { executable: 'node' }).reason ?? '',
    /no configured workspace execution boundary/,
  );
  const policy = { requiredModel: 'gpt-6-astra', minimumCliVersion: '0.153.0', allowedModels: ['gpt-6-astra', 'gpt-5.6-sol'], routing: { routineModel: 'gpt-5.6-sol', complexModel: 'gpt-6-astra' } };
  config.bridge = { enabled: true, allowWorkspaceWrite: false, executionPolicy: policy };
  const submissions: any[] = [];
  const record: LocalAgentRecord = { id: 'agt-owner-fixture', workspaceRoot: project, profileName: 'codex', provider: 'codex', model: 'gpt-5.6-sol', status: 'running', createdAt: 'now', updatedAt: 'now' };
  const app = createServer(config, { executionBoundary: null, codexBridgeFactory: configuration => new CodexBridge(configuration, {
    start: async input => { submissions.push(input); return Result.ok(record); },
    continue: async (agentId, prompt, overrides) => { submissions.push({ agentId, prompt, ...overrides }); return Result.ok(record); },
    get: async () => Result.ok(record), list: async () => Result.ok([]),
  }, () => ({ executable: 'fixture-cli-not-launched', version: '0.153.4' })) });
  const listener = app.app.listen(port,'127.0.0.1'); await new Promise<void>(r => listener.once('listening', r));
  t.after(async () => { await app.close(); listener.closeAllConnections(); await new Promise<void>(r => listener.close(() => r())); rmSync(root, {recursive:true,force:true}); });
  const clientIds = new Map<string, string>();
  const login = async (name:string) => {
    const registration = await fetch(`${origin}/register`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({
      client_name:name, redirect_uris:['http://127.0.0.1/callback'], token_endpoint_auth_method:'none', grant_types:['authorization_code','refresh_token'], response_types:['code'],
    }) });
    assert.equal(registration.status,201); const client = await registration.json() as {client_id:string};
    const verifier = randomBytes(32).toString('base64url');
    const params = { client_id:client.client_id, redirect_uri:'http://127.0.0.1/callback', response_type:'code', scope:'devspace', resource,
      code_challenge:createHash('sha256').update(verifier).digest('base64url'), code_challenge_method:'S256' };
    const authorize = await fetch(`${origin}/authorize`, { method:'POST', redirect:'manual', body:new URLSearchParams({...params,owner_token:owner}) });
    assert.equal(authorize.status,302); const code = new URL(authorize.headers.get('location')!).searchParams.get('code')!;
    const exchanged = await fetch(`${origin}/token`, {method:'POST',body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code,code_verifier:verifier,redirect_uri:params.redirect_uri,resource})});
    assert.equal(exchanged.status,200);
    const accessToken = (await exchanged.json() as {access_token:string}).access_token;
    clientIds.set(accessToken, client.client_id); return accessToken;
  };
  const access = await login('Owner gate fixture');
  let session='', id=0;
  const notifications: any[] = [];
  const rpc = async (method:string, params:unknown, bearer=access) => {
    const requestId = id + 1;
    const response = await fetch(resource, {method:'POST',headers:{authorization:`Bearer ${bearer}`,'content-type':'application/json',accept:'application/json, text/event-stream',...(session?{'mcp-session-id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
    session = response.headers.get('mcp-session-id') ?? session;
    const text = await response.text();
    assert.equal(response.status,200,text);
    if (!text.startsWith('event:')) return JSON.parse(text);
    const messages = text.split('\n')
      .filter(line=>line.startsWith('data:'))
      .map(line=>JSON.parse(line.slice(5)));
    notifications.push(...messages.filter(message => message?.method));
    const reply = messages.find(message => message?.id === requestId);
    assert.ok(reply, 'missing JSON-RPC response for request ' + requestId + ': ' + text);
    return reply;
  };
  await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'fixture',version:'1'}});
  const hostToolList = await rpc('tools/list', {});
  const hostToolNames = (hostToolList.result.tools as Array<{ name: string }>).map(tool => tool.name);
  assert.ok(hostToolNames.includes('host_command'), 'authenticated MCP tools/list must expose host_command');
  assert.ok(hostToolNames.includes('context_fabric'), 'authenticated MCP tools/list must expose context_fabric');
  assert.ok(hostToolNames.includes('control_hub'), 'authenticated MCP tools/list must expose control_hub');
  const workspaceAppResource = await rpc('resources/read', { uri: 'ui://devspace/workspace-app-v7.html' });
  const workspaceAppContent = workspaceAppResource.result.contents?.[0];
  assert.equal(workspaceAppContent?.uri, 'ui://devspace/workspace-app-v7.html');
  assert.equal(workspaceAppContent?.mimeType, 'text/html;profile=mcp-app');
  assert.match(workspaceAppContent?.text ?? '', /\/mcp-app-assets\/assets\/workspace-app-/);
  assert.deepEqual(workspaceAppContent?._meta?.ui?.csp?.resourceDomains, [origin]);
  const opened=await rpc('tools/call',{name:'open_workspace',arguments:{path:project}});
  const workspaceId=opened.result.structuredContent.workspaceId; assert.ok(workspaceId);
  const conversationMeta={'openai/session':'fixture-logical-chat'};
  const a2LeaseStore = new WorkspaceLeaseStore(config.stateDir);
  const activeA2Lease = a2LeaseStore.activate(a2LeaseStore.request({
    clientId: clientIds.get(access)!,
    conversationScopeId: 'fixture-logical-chat',
    workspaceRoot: project,
    durationSeconds: 14_400,
    policyVersion: A2_WORKSPACE_LEASE_POLICY_VERSION,
    boundaryProfile: 'fixture-boundary-v2',
  }).id, { boundaryVerified: true });
  assert.equal(activeA2Lease.state, 'active');
  a2LeaseStore.close();
  const tool=(name:string,args:Record<string,unknown>)=>rpc('tools/call',{name,arguments:{workspaceId,...args},_meta:conversationMeta});
  assert.notEqual((await tool('project_read',{path:'hello.txt'})).result.isError,true);
  assert.notEqual((await tool('project_read_batch', { items: [{ path: 'hello.txt' }] })).result.isError, true);
  const contextDigest = 'f'.repeat(64);
  const contextAnchor = { version: 1, anchorId: 'oauth-context', createdAt: '2026-09-19T00:00:00.000+00:00', stateDigest: contextDigest,
    evidenceRefs: [], statements: [] };
  const contextStored = await tool('context_fabric', { action: 'put_anchor', anchorJson: JSON.stringify(contextAnchor) });
  assert.notEqual(contextStored.result.isError, true, 'bounded Context Fabric state must not require execution approval');
  assert.doesNotMatch(JSON.stringify(contextStored), /OWNER_APPROVAL_REQUIRED/);
  const contextCapsule = await tool('context_fabric', { action: 'capsule', anchorId: 'oauth-context', objective: 'Continue safely',
    objectiveEstimatedTokens: 2, maxTokens: 20, reserveTokens: 2, maxStatements: 4 });
  assert.notEqual(contextCapsule.result.isError, true);
  assert.equal(JSON.parse(contextCapsule.result.structuredContent.result).anchorId, 'oauth-context');
  const hubStatus = await rpc('tools/call',{name:'control_hub',arguments:{action:'status'},_meta:conversationMeta});
  assert.notEqual(hubStatus.result.isError, true, 'bounded Control Hub status must not require execution approval');
  assert.doesNotMatch(JSON.stringify(hubStatus), /OWNER_APPROVAL_REQUIRED/);
  writeFileSync(join(project, '.env'), 'FIXTURE_BATCH_SECRET_MUST_NOT_LEAK');
  const protectedBatch = await tool('project_read_batch', { items: [{ path: 'hello.txt' }, { path: '.env' }] });
  assert.equal(JSON.parse(protectedBatch.result.content[0].text).code, 'OWNER_APPROVAL_REQUIRED');
  assert.doesNotMatch(JSON.stringify(protectedBatch), /FIXTURE_BATCH_SECRET_MUST_NOT_LEAK/);
  const escapedBatch = await tool('project_read_batch', { items: [{ path: 'hello.txt' }, { path: '../outside.txt' }] });
  assert.equal(escapedBatch.result.isError, true);
  assert.equal(JSON.parse(escapedBatch.result.content[0].text).code, 'WORKSPACE_ACCESS_DENIED');
  const nativeBlocked = await tool('run_process', { executable: process.execPath,
    args: ['-e', "require('node:fs').writeFileSync('native-not-approved.txt','bad')"] });
  assert.equal(JSON.parse(nativeBlocked.result.content[0].text).code, 'OWNER_APPROVAL_REQUIRED');
  assert.equal(existsSync(join(project, 'native-not-approved.txt')), false);
  const hostBlocked = await tool('host_command', { command: "printf blocked > host-not-approved.txt" });
  assert.equal(JSON.parse(hostBlocked.result.content[0].text).code, 'OWNER_APPROVAL_REQUIRED');
  assert.equal(existsSync(join(project, 'host-not-approved.txt')), false);
  const cancelBlocked = await tool('process_cancel', { sessionId: 12345 });
  assert.equal(JSON.parse(cancelBlocked.result.content[0].text).code, 'OWNER_APPROVAL_REQUIRED');
  const absentStatus = await tool('process_status', { sessionId: 12345, yieldTimeMs: 0 });
  assert.equal(absentStatus.result.isError, true);
  assert.doesNotMatch(JSON.stringify(absentStatus), /OWNER_APPROVAL_REQUIRED/);
  const approvalStartedAt = Date.now();
  const args={cmd:'echo approved> approved.txt',yieldTimeMs:10000};
  const blocked=await tool('exec_command',args); assert.equal(blocked.result.isError,true);
  const approval=JSON.parse(blocked.result.content[0].text); assert.equal(approval.code,'OWNER_APPROVAL_REQUIRED');
  assert.deepEqual(approval.a2WorkspaceLease, {
    state: 'suspended',
    reason: 'boundary_unverified',
    expiresAt: activeA2Lease.expiresAt,
    executionEligible: false,
  }, 'ACTIVE persisted A2 authority must fail closed and remain distinct from legacy exact approval');
  assert.ok(Date.parse(approval.expiresAt) >= approvalStartedAt + 7200_000);
  assert.ok(Date.parse(approval.expiresAt) <= Date.now() + 7200_000);
  assert.equal(existsSync(join(project,'approved.txt')),false);
  const forged=await tool('exec_command',{...args,approved:true}); assert.equal(forged.result.isError,true);
  const page=await fetch(approval.approvalUrl); const html=await page.text();
  const nonce=/name="nonce" value="([^"]+)"/.exec(html)![1], cookie=page.headers.get('set-cookie')!.split(';')[0];
  const decide=(originHeader:string|undefined,password:string,extraHeaders:Record<string,string>={})=>fetch(approval.approvalUrl,{method:'POST',headers:{...(originHeader===undefined?{}:{origin:originHeader}),cookie,...extraHeaders},body:new URLSearchParams({nonce,owner_token:password,decision:'approve'})});
  assert.equal((await decide('https://attacker.invalid',owner)).status,403);
  assert.equal((await decide('null',owner)).status,403);
  assert.equal((await decide(undefined,owner)).status,403);
  assert.equal((await decide('https://attacker.invalid',owner,{'x-forwarded-host':new URL(origin).host,'x-forwarded-proto':'http',referer:approval.approvalUrl})).status,403);
  assert.equal((await decide(origin,owner,{cookie:''})).status,403);
  assert.equal((await decide(origin,owner,{cookie:cookie.split('=')[0]+'=forged'})).status,403);
  assert.equal((await fetch(approval.approvalUrl,{method:'POST',headers:{origin,cookie},body:new URLSearchParams({nonce:'forged',owner_token:owner,decision:'approve'})})).status,403);
  assert.equal((await decide(origin,'wrong')).status,403);
  assert.equal((await decide(origin,owner)).status,200);
  assert.equal((await decide(origin,owner)).status,403,'a decided grant cannot be approved twice');
  assert.equal(existsSync(join(project,'approved.txt')),false,'approval alone must not execute');
  const otherClient = await login('Other OAuth client fixture');
  const otherAttempt = await rpc('tools/call',{name:'exec_command',arguments:{workspaceId,...args},_meta:conversationMeta},otherClient);
  assert.equal(JSON.parse(otherAttempt.result.content[0].text).code,'OWNER_APPROVAL_REQUIRED','another authenticated client cannot consume this grant');
  const otherConversation = await rpc('tools/call',{name:'exec_command',arguments:{workspaceId,...args},_meta:{'openai/session':'another-chat'}});
  assert.equal(JSON.parse(otherConversation.result.content[0].text).code,'OWNER_APPROVAL_REQUIRED','another logical conversation cannot consume this grant');
  session = '';
  await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'fixture-reconnected',version:'1'}});
  assert.notEqual((await tool('exec_command',args)).result.isError,true,'the approved client must be able to retry after transport reconnection');
  assert.match(readFileSync(join(project,'approved.txt'),'utf8'),/approved/);
  assert.equal((await tool('exec_command',args)).result.isError,true,'grant must be consumed once');
  const patch='*** Begin Patch\n*** Update File: hello.txt\n@@\n-hello\n+updated\n*** End Patch';
  const expectedHashes={'hello.txt':createHash('sha256').update('hello\n').digest('hex')};
  assert.notEqual((await tool('apply_patch',{patch,expectedHashes})).result.isError,true);
  assert.equal(readFileSync(join(project,'hello.txt'),'utf8'),'updated\n');
  config.approvalProfile = 'high_risk_only';
  const automaticPatch = (before: string, after: string) => `*** Begin Patch\n*** Update File: hello.txt\n@@\n-${before}\n+${after}\n*** End Patch`;
  assert.notEqual((await tool('apply_patch', { patch: automaticPatch('updated', 'automatic') })).result.isError, true, 'ordinary patch does not request per-operation consent in the high-risk-only profile');
  assert.equal(readFileSync(join(project, 'hello.txt'), 'utf8'), 'automatic\n');
  assert.notEqual((await tool('apply_patch', { patch: automaticPatch('automatic', 'updated') })).result.isError, true);
  const protectedWrite = await tool('apply_patch', { patch: '*** Begin Patch\n*** Add File: package.json\n+{}\n*** End Patch' });
  assert.equal(JSON.parse(protectedWrite.result.content[0].text).code, 'OWNER_APPROVAL_REQUIRED');
  assert.equal(existsSync(join(project, 'package.json')), false);
  config.approvalProfile = 'conservative';
  const deletion=await tool('apply_patch',{patch:'*** Begin Patch\n*** Delete File: hello.txt\n*** End Patch',expectedHashes:{'hello.txt':createHash('sha256').update('updated\n').digest('hex')}});
  assert.equal(JSON.parse(deletion.result.content[0].text).code,'OWNER_APPROVAL_REQUIRED');
  assert.equal(existsSync(join(project,'hello.txt')),true);

  const approveTask = async (approvalUrl: string) => {
    const page = await fetch(approvalUrl), html = await page.text();
    assert.match(html, /Approving will automatically submit/);
    const nonce = /name="nonce" value="([^"]+)"/.exec(html)![1];
    const cookie = page.headers.get('set-cookie')!.split(';')[0];
    return fetch(approvalUrl, { method: 'POST', redirect: 'manual', headers: { origin, cookie },
      body: new URLSearchParams({ nonce, owner_token: owner, decision: 'approve' }) });
  };
  const taskArgs = { requestKey: 'owner-auto-one', prompt: ' '.repeat(4001) + 'Read hello.txt', model: ' auto ', writeMode: 'read_only' };
  const automatic = JSON.parse((await tool('codex_task_start', taskArgs)).result.content[0].text);
  assert.equal(automatic.executionMode, 'submit_on_approval'); assert.equal(submissions.length, 0);
  assert.equal((await approveTask(automatic.approvalUrl)).status, 303);
  for (let i = 0; i < 100 && !submissions.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(submissions.length, 1, 'human approval must submit without another tools/call');
  assert.equal(submissions[0].model, 'gpt-5.6-sol'); assert.equal(submissions[0].writeMode, 'read_only');
  assert.equal(submissions[0].prompt, 'Read hello.txt', 'review and execution must share schema normalization');
  const statusPage = await (await fetch(automatic.approvalUrl)).text();
  assert.match(statusPage, /Codex task submitted/); assert.match(statusPage, /agt-owner-fixture/);
  assert.doesNotMatch(statusPage, /owner_token|Read hello.txt/);
  session = '';
  await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'auto-reconnected',version:'1'}});
  const receipt = await tool('codex_task_start', taskArgs);
  assert.notEqual(receipt.result.isError, true);
  assert.equal(JSON.parse(receipt.result.content[0].text).code, 'OWNER_OPERATION_SUBMITTED');
  assert.equal(JSON.parse(receipt.result.content[0].text).agentId, record.id);
  assert.equal(submissions.length, 1, 'old clients retrying after approval must not redeliver');
  const foreign = await rpc('tools/call',{name:'codex_task_start',arguments:{workspaceId,...taskArgs},_meta:conversationMeta},otherClient);
  assert.equal(JSON.parse(foreign.result.content[0].text).code,'OWNER_APPROVAL_REQUIRED');
  const foreignConversation = await rpc('tools/call',{name:'codex_task_start',arguments:{workspaceId,...taskArgs},_meta:{'openai/session':'foreign-chat'}});
  assert.equal(JSON.parse(foreignConversation.result.content[0].text).code,'OWNER_APPROVAL_REQUIRED');

  const followup = JSON.parse((await tool('codex_task_continue', { ...taskArgs, agentId: record.id, requestKey: 'followup' })).result.content[0].text);
  assert.equal((await approveTask(followup.approvalUrl)).status, 303);
  for (let i = 0; i < 100 && submissions.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(submissions.length, 2); assert.equal(submissions[1].agentId, record.id);

  const changed = JSON.parse((await tool('codex_task_start', { ...taskArgs, requestKey: 'changed-model' })).result.content[0].text);
  policy.routing.routineModel = 'gpt-6-astra';
  await approveTask(changed.approvalUrl);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(await (await fetch(changed.approvalUrl)).text(), /Submission could not be confirmed/);
  assert.equal(submissions.length, 2, 'model changes after review invalidate automatic execution');
  policy.routing.routineModel = 'gpt-5.6-sol';

  const removedRoot = JSON.parse((await tool('codex_task_start', { ...taskArgs, requestKey: 'removed-root' })).result.content[0].text);
  config.allowedRoots = [];
  await approveTask(removedRoot.approvalUrl); await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(await (await fetch(removedRoot.approvalUrl)).text(), /Submission could not be confirmed/);
  assert.equal(submissions.length, 2, 'workspace removal after review invalidates automatic execution');
  config.allowedRoots = [project];
  const cardArgs = { ...taskArgs, requestKey: 'chat-card-once' };
  const cardRequest = JSON.parse((await tool('codex_task_start', cardArgs)).result.content[0].text);
  assert.equal(cardRequest.chatApproval.enabled, false, 'Chat approval is opt-in for each authenticated OAuth client');
  assert.equal(cardRequest.chatApproval.clientId, clientIds.get(access));
  assert.equal(cardRequest.chatApproval.reviewTool, 'review_approval', 'approval responses advertise one model-facing approval entry for both center and single-card review');
  assert.equal(cardRequest.chatApproval.singleReviewTool, 'review_approval');
  const reviewArgs = { name: 'review_approval', arguments: { approvalId: cardRequest.approvalId }, _meta: conversationMeta };
  assert.equal((await rpc('tools/call', reviewArgs)).result.isError, true);
  config.chatApprovalClientIds = [clientIds.get(access)!];
  const compatClaimArgs = { cmd: 'echo compat-claimed> compat-claimed.txt', yieldTimeMs: 10000 };
  const compatClaimBlocked = await tool('exec_command', compatClaimArgs);
  const compatClaimApproval = JSON.parse(compatClaimBlocked.result.content[0].text);
  assert.equal(compatClaimApproval.code, 'OWNER_APPROVAL_REQUIRED');
  const compatClaimPage = await fetch(compatClaimApproval.approvalUrl);
  const compatClaimHtml = await compatClaimPage.text();
  const compatClaimNonce = /name="nonce" value="([^"]+)"/.exec(compatClaimHtml)![1];
  const compatClaimCookie = compatClaimPage.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await fetch(compatClaimApproval.approvalUrl, {
    method: 'POST',
    headers: { origin, cookie: compatClaimCookie },
    body: new URLSearchParams({ nonce: compatClaimNonce, owner_token: owner, decision: 'approve' }),
  })).status, 200);
  const driftedConversationMeta = { 'openai/session': 'fixture-logical-chat-drifted' };
  const compatClaimId = `${REVIEW_APPROVAL_CLAIM_COMPAT_PREFIX}${compatClaimApproval.approvalId}`;
  const foreignCompatClaim = await rpc('tools/call', {
    name: 'review_approval',
    arguments: { approvalId: compatClaimId },
    _meta: driftedConversationMeta,
  }, otherClient);
  assert.equal(foreignCompatClaim.result.isError, true, 'cached-host claim compatibility must not cross OAuth clients');
  const compatClaim = await rpc('tools/call', {
    name: 'review_approval',
    arguments: { approvalId: compatClaimId },
    _meta: driftedConversationMeta,
  });
  assert.notEqual(compatClaim.result.isError, true, 'cached hosts can claim an already-approved receipt after logical session drift');
  assert.equal(JSON.parse(compatClaim.result.content[0].text).state, 'approved');
  const compatRetry = await rpc('tools/call', {
    name: 'exec_command',
    arguments: { workspaceId, ...compatClaimArgs },
    _meta: driftedConversationMeta,
  });
  assert.notEqual(compatRetry.result.isError, true, 'claimed approval must authorize exactly the original operation');
  assert.match(readFileSync(join(project, 'compat-claimed.txt'), 'utf8'), /compat-claimed/);
  const scopedCard = JSON.parse((await rpc('tools/call', {
    name: 'codex_task_start',
    arguments: { workspaceId, ...cardArgs },
    _meta: conversationMeta,
  })).result.content[0].text);
  assert.equal(scopedCard.approvalId, cardRequest.approvalId, 'enabling Chat UI must not create a second approval for the same pending request');
  assert.equal(scopedCard.chatApproval.enabled, true);
  assert.match(scopedCard.instruction, /Call review_approval with no approvalId/);
  assert.doesNotMatch(scopedCard.instruction, /Call review_approvals/);
  const unscoped = await rpc('tools/call', { name: 'codex_task_start', arguments: { workspaceId, ...cardArgs, requestKey: 'unscoped-card' } });
  const unscopedId = JSON.parse(unscoped.result.content[0].text).approvalId;
  assert.equal(JSON.parse(unscoped.result.content[0].text).chatApproval.mode, 'owner_page');
  assert.equal(JSON.parse(unscoped.result.content[0].text).chatApproval.fallbackReason, 'CHAT_CONTEXT_REQUIRED');
  const unscopedReview = await rpc('tools/call', { name: 'review_approval', arguments: { approvalId: unscopedId } });
  assert.equal(unscopedReview.result.isError, true, 'Chat UI approval must not bind different conversations to a shared null scope');
  assert.equal(JSON.parse(unscopedReview.result.content[0].text).code, 'CHAT_CONTEXT_REQUIRED');
  const notificationsBeforeReview = notifications.length;
  const reviewed = await rpc('tools/call', reviewArgs);
  assert.notEqual(reviewed.result.isError, true);
  assert.equal(
    notifications.slice(notificationsBeforeReview).filter(message => message.method === 'notifications/tools/list_changed').length,
    1,
    'a successful specific-card review nudges a host that may still cache the older tool contract',
  );
  const view = reviewed.result._meta['devspace/approval'];
  assert.ok(view.decisionToken);
  assert.equal(view.approvalUrl, `${origin}/owner/approvals/${view.id}`);
  const reviewedSummary = JSON.parse(reviewed.result.content[0].text);
  assert.equal(reviewedSummary.approvalUrl, view.approvalUrl,
    'single approval review must preserve an Owner-page fallback when the app card cannot load');
  const modelVisible = JSON.stringify({ content: reviewed.result.content, structuredContent: reviewed.result.structuredContent });
  assert.equal(modelVisible.includes(view.decisionToken), false);
  assert.equal(modelVisible.includes('decisionToken'), false);
  const listed = await rpc('tools/list', {});
  const decisionTool = listed.result.tools.find((item: any) => item.name === 'decide_approval');
  const reviewTool = listed.result.tools.find((item: any) => item.name === 'review_approval');
  const approvalCenterTool = listed.result.tools.find((item: any) => item.name === 'review_approvals');
  const reissueTool = listed.result.tools.find((item: any) => item.name === 'reissue_approval');
  const claimTool = listed.result.tools.find((item: any) => item.name === 'claim_approval');
  const revokeConversationTool = listed.result.tools.find((item: any) => item.name === 'revoke_conversation_approvals');
  const recycleTool = listed.result.tools.find((item: any) => item.name === 'recycle_approvals');
  assert.deepEqual(decisionTool._meta.ui.visibility, ['app']);
  assert.equal(decisionTool._meta['openai/visibility'], 'private');
  assert.equal(decisionTool._meta['openai/widgetAccessible'], true);
  assert.equal(decisionTool.annotations.destructiveHint, true);
  assert.equal(decisionTool.annotations.openWorldHint, true);
  assert.equal(decisionTool._meta.ui.resourceUri, undefined,
    'a hidden action must not own an output template: ChatGPT disables templates associated with hidden tools');
  assert.equal(decisionTool._meta['openai/outputTemplate'], undefined);
  assert.equal(reviewTool._meta.ui.resourceUri, 'ui://devspace/workspace-app-v7.html');
  assert.equal(reviewTool._meta['openai/outputTemplate'], reviewTool._meta.ui.resourceUri);
  assert.deepEqual(reviewTool._meta.ui.visibility, ['model', 'app']);
  const resources = await rpc('resources/list', {});
  const resourceUris = new Set(resources.result.resources.map((item: any) => item.uri));
  for (const uri of [
    'ui://devspace/workspace-app.html',
    'ui://devspace/workspace-app-v2.html',
    'ui://devspace/workspace-app-v3.html',
    'ui://devspace/workspace-app-v4.html',
    'ui://devspace/workspace-app-v5.html',
    'ui://devspace/workspace-app-v6.html',
    'ui://devspace/workspace-app-v7.html',
  ]) assert.equal(resourceUris.has(uri), true, `workspace app resource must remain readable for cached host URI: ${uri}`);
  assert.equal(reviewTool.inputSchema.required?.includes('approvalId') ?? false, false,
    'review_approval without an id must open the current conversation Approval Center');
  assert.deepEqual(approvalCenterTool._meta.ui.visibility, ['app']);
  assert.equal(approvalCenterTool._meta['openai/visibility'], 'private');
  assert.equal(approvalCenterTool._meta.ui.resourceUri, undefined,
    'the compatibility center action must not compete for the model-facing output template');
  assert.equal(approvalCenterTool._meta['openai/outputTemplate'], undefined);
  const centerViaPrimaryTool = await rpc('tools/call', { name: 'review_approval', arguments: {}, _meta: conversationMeta });
  assert.notEqual(centerViaPrimaryTool.result.isError, true);
  assert.ok(centerViaPrimaryTool.result._meta['devspace/approval-center']);
  const centerSummary = JSON.parse(centerViaPrimaryTool.result.content[0].text);
  assert.ok(centerSummary.fallbackApprovals.some((item: any) => item.approvalId === view.id && item.approvalUrl === view.approvalUrl),
    'Approval Center must expose Owner-page fallbacks when the app card cannot load');
  const centerViaCachedSchema = await rpc('tools/call', {
    name: 'review_approval',
    arguments: { approvalId: REVIEW_APPROVAL_CENTER_COMPAT_ID },
    _meta: conversationMeta,
  });
  assert.notEqual(centerViaCachedSchema.result.isError, true);
  assert.ok(centerViaCachedSchema.result._meta['devspace/approval-center'],
    'the reserved compatibility id must let hosts with a cached required approvalId schema open the Approval Center');
  assert.deepEqual(
    JSON.parse(centerViaCachedSchema.result.content[0].text).fallbackApprovals,
    centerSummary.fallbackApprovals,
    'cached-schema compatibility must expose the same bounded Owner-page fallbacks as the normal center entry',
  );
  const centerResult = await rpc('tools/call', { name: 'review_approvals', arguments: {}, _meta: conversationMeta });
  assert.notEqual(centerResult.result.isError, true);
  const centerView = centerResult.result._meta['devspace/approval-center'];
  assert.ok(centerView.approvals.some((item: any) => item.id === view.id));
  assert.equal(JSON.stringify({ content: centerResult.result.content, structuredContent: centerResult.result.structuredContent }).includes('decisionToken'), false);
  assert.equal(reissueTool.annotations.destructiveHint, false);
  assert.equal(reissueTool.annotations.openWorldHint, false);
  assert.deepEqual(reissueTool._meta.ui.visibility, ['model']);
  assert.deepEqual(claimTool._meta.ui.visibility, ['model']);
  assert.equal(claimTool._meta['openai/outputTemplate'], undefined);
  assert.equal(revokeConversationTool.annotations.destructiveHint, false);
  assert.equal(revokeConversationTool.annotations.idempotentHint, true);
  assert.deepEqual(revokeConversationTool._meta.ui.visibility, ['model']);
  assert.deepEqual(recycleTool._meta.ui.visibility, ['app']);
  assert.equal(recycleTool._meta['openai/visibility'], 'private');
  assert.equal(recycleTool.annotations.destructiveHint, false);
  assert.equal(recycleTool.annotations.idempotentHint, true);
  const uiDecision = { name: 'decide_approval', arguments: { approvalId: view.id, decisionToken: view.decisionToken, decision: 'approve' }, _meta: conversationMeta };
  const unreviewed = await rpc('tools/call', { name: 'decide_approval', arguments: { approvalId: view.id, decisionToken: 'forged', decision: 'approve' }, _meta: conversationMeta });
  assert.equal(unreviewed.result.isError, true);
  policy.routing.routineModel = 'gpt-6-astra';
  const staleReview = await rpc('tools/call', reviewArgs);
  assert.equal(staleReview.result.isError, true, 'stale model review must fail before consent');
  assert.equal(JSON.parse(staleReview.result.content[0].text).code, 'APPROVAL_CONTEXT_CHANGED');
  const staleDecision = await rpc('tools/call', uiDecision);
  assert.equal(staleDecision.result.isError, true, 'changed operation must not transition to approved');
  assert.equal(submissions.length, 2);
  policy.routing.routineModel = 'gpt-5.6-sol';
  assert.equal((await rpc('tools/call', { ...uiDecision, arguments: { ...uiDecision.arguments, decisionToken: 'forged' } })).result.isError, true);
  assert.equal((await rpc('tools/call', uiDecision, otherClient)).result.isError, true);
  assert.equal((await rpc('tools/call', { ...uiDecision, _meta: { 'openai/session': 'foreign-chat' } })).result.isError, true);
  assert.equal(submissions.length, 2);
  assert.notEqual((await rpc('tools/call', uiDecision)).result.isError, true);
  assert.notEqual((await rpc('tools/call', uiDecision)).result.isError, true, 'uncertain UI transport retries return the previous decision');
  for (let i = 0; i < 100 && submissions.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(submissions.length, 3, 'a UI click triggers the existing one-turn submission exactly once');
  const cardReceipt = JSON.parse((await tool('codex_task_start', cardArgs)).result.content[0].text);
  assert.equal(cardReceipt.code, 'OWNER_OPERATION_SUBMITTED');
  assert.equal(submissions.length, 3);
  config.chatApprovalClientIds = [];
  assert.equal((await rpc('tools/call', reviewArgs)).result.isError, true, 'removing client trust revokes UI access immediately');
  const revoked = JSON.parse((await tool('codex_task_start', { ...taskArgs, requestKey: 'revoked-token' })).result.content[0].text);
  const revocation = await fetch(`${origin}/revoke`, { method: 'POST', body: new URLSearchParams({ token: access, client_id: clientIds.get(access)! }) });
  assert.equal(revocation.status, 200);
  await approveTask(revoked.approvalUrl); await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(await (await fetch(revoked.approvalUrl)).text(), /Submission could not be confirmed/);
  assert.equal(submissions.length, 3, 'revoked OAuth credentials must not authorize deferred delivery');
});

test('real OAuth/MCP A2 lease executes only in Candidate when boundary is verified', { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'devspace-a2-candidate-http-'));
  const project = join(root, 'project'); mkdirSync(project);
  writeFileSync(join(project, 'hello.txt'), 'hello\n');
  const reserve = reserveServer(); await new Promise<void>(r => reserve.listen(0, '127.0.0.1', r));
  const port = (reserve.address() as {port:number}).port; await new Promise<void>(r => reserve.close(() => r()));
  const origin = `http://127.0.0.1:${port}`, resource = `${origin}/mcp`;
  const config = loadConfig({ ...writeTestDevspaceConfig(join(root, 'config'), {
    server: { port, publicBaseUrl: origin }, workspaces: { allowedRoots: [project] },
    storage: { stateDir: join(root, 'state') }, skills: { enabled: false },
    tools: { authorization: 'owner_approval', approvalTtlSeconds: 7200 },
    logging: { level: 'silent' },
  }), DEVSPACE_OAUTH_OWNER_TOKEN: owner });
  const boundary: WorkspaceExecutionBoundary = {
    profile: 'fixture-boundary-v2',
    prepare(input) {
      return { executable: input.executable, args: input.args, boundaryProfile: this.profile };
    },
  };
  const app = createServer(config, {
    executionBoundary: boundary,
    workspaceExecutionBoundaryVerifier: () => ({
      verified: true,
      profile: boundary.profile,
      reason: 'verified',
      checks: {
        profileMatch: true,
        workspaceWrite: true,
        outsideWriteBlocked: true,
        protectedEnvWriteBlocked: true,
        hostControlSocketsMasked: true,
        sensitiveEnvironmentBlocked: true,
        networkNoneIsolated: true,
      },
    }),
  });
  const listener = app.app.listen(port, '127.0.0.1');
  await new Promise<void>(r => listener.once('listening', r));
  t.after(async () => {
    await app.close();
    listener.closeAllConnections();
    await new Promise<void>(r => listener.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  });

  const registration = await fetch(`${origin}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'A2 candidate fixture',
      redirect_uris: ['http://127.0.0.1/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json() as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const redirectUri = 'http://127.0.0.1/callback';
  const authorize = await fetch(`${origin}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'devspace',
      resource,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      owner_token: owner,
    }),
  });
  assert.equal(authorize.status, 302);
  const code = new URL(authorize.headers.get('location')!).searchParams.get('code')!;
  const exchanged = await fetch(`${origin}/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource,
    }),
  });
  assert.equal(exchanged.status, 200);
  const access = (await exchanged.json() as { access_token: string }).access_token;

  let session = '', id = 0;
  const rpc = async (method: string, params: unknown) => {
    const requestId = id + 1;
    const response = await fetch(resource, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${access}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(session ? { 'mcp-session-id': session } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    session = response.headers.get('mcp-session-id') ?? session;
    const text = await response.text();
    assert.equal(response.status, 200, text);
    if (!text.startsWith('event:')) return JSON.parse(text);
    const messages = text.split('\n').filter(line => line.startsWith('data:'))
      .map(line => JSON.parse(line.slice(5)));
    const reply = messages.find(message => message?.id === requestId);
    assert.ok(reply, 'missing JSON-RPC response for request ' + requestId + ': ' + text);
    return reply;
  };

  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
  const opened = await rpc('tools/call', { name: 'open_workspace', arguments: { path: project } });
  const workspaceId = opened.result.structuredContent.workspaceId;
  const conversationMeta = { 'openai/session': 'fixture-a2-candidate-chat' };
  const leaseStore = new WorkspaceLeaseStore(config.stateDir);
  try {
    const lease = leaseStore.activate(leaseStore.request({
      clientId: client.client_id,
      conversationScopeId: conversationMeta['openai/session'],
      workspaceRoot: project,
      durationSeconds: 14_400,
      policyVersion: A2_WORKSPACE_LEASE_POLICY_VERSION,
      boundaryProfile: boundary.profile,
    }).id, { boundaryVerified: true });
    assert.equal(lease.state, 'active');
  } finally {
    leaseStore.close();
  }

  const executed = await rpc('tools/call', {
    name: 'exec_command',
    arguments: {
      workspaceId,
      cmd: `node -e "require('node:fs').writeFileSync('a2-candidate-only.txt','candidate')"`,
      yieldTimeMs: 10_000,
    },
    _meta: conversationMeta,
  });
  assert.notEqual(executed.result.isError, true);
  assert.equal(existsSync(join(project, 'a2-candidate-only.txt')), false, 'A2 execution must not mutate Stable Workspace');
  const evidence = executed.result.structuredContent.candidateExecution;
  assert.equal(evidence.state, 'completed');
  assert.equal(evidence.mutation.stableChanged, false);
  assert.deepEqual(evidence.mutation.created, ['a2-candidate-only.txt']);
  assert.equal(evidence.mutation.createdCount, 1);
  assert.equal(evidence.mutation.pathListTruncated, false);
  assert.doesNotMatch(JSON.stringify(executed), /OWNER_APPROVAL_REQUIRED/);
});
