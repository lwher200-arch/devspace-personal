import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import type { ServerConfig } from './config.js';
import type { WorkspaceRegistry } from './workspaces.js';
import { assertAllowedPath, canonicalAllowedPath, PRIVATE_CREDENTIAL_DIRECTORIES } from './roots.js';
import { parsePatch } from './apply-patch.js';
import { selectExecutionModel } from './local-agent-execution.js';
import { logEvent } from './logger.js';
import { openAiConversationScopeId } from './request-meta.js';
import type { ApprovalState, ApprovalView } from './approval-protocol.js';
import { readOwnerSession, establishOwnerSession } from './owner-session.js';

type Arguments = Record<string, unknown>;
export interface ApprovalOperation { principal: string; tool: string; args: Arguments; context: unknown; reason: string }
interface SubmissionReceipt { agentId: string; workspaceId: string }
interface Approval extends ApprovalOperation {
  id: string; key: string; bytes: number; expires: number;
  state: ApprovalState;
  uiToken?: string;
  nonce?: string; submit?: () => Promise<SubmissionReceipt>; submission?: SubmissionReceipt;
}
const token = () => randomBytes(32).toString('base64url');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function equal(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Arguments)[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function approvalPrincipal(clientId: string, metadata: unknown): string {
  return JSON.stringify([clientId, openAiConversationScopeId(metadata) ?? null]);
}

export function approvalContextMatches(view: Pick<ApprovalView, 'reason' | 'context'>, current: { reason?: string; context: unknown }): boolean {
  return canonical([view.reason, view.context]) === canonical([current.reason, current.context]);
}

// Grants deliberately expire on restart. Losing a pending approval is fail-closed.
export class OwnerApprovals {
  private readonly entries = new Map<string, Approval>();
  private readonly failures = new Map<string, number>();
  private readonly inFlight = new Set<Promise<void>>();
  private closed = false;
  constructor(private readonly now = Date.now, private readonly ttl = 300_000) {}
  private prune() { for (const [id, value] of this.entries) if (value.expires <= this.now() && value.state !== 'submitting') { this.entries.delete(id); this.failures.delete(id); } }
  inspect(id: string): Approval | undefined { this.prune(); return this.entries.get(id); }
  require(operation: ApprovalOperation, submit?: () => Promise<SubmissionReceipt>): { allowed: true } | { allowed: false; approval: Approval } {
    if (this.closed) throw new Error('Owner approval service is closed.');
    if (submit && !['codex_task_start', 'codex_task_continue'].includes(operation.tool)) throw new Error('Only Codex submissions support execution on approval.');
    this.prune();
    const encoded = canonical(operation);
    const bytes = Buffer.byteLength(encoded);
    if (bytes > 1024 * 1024) throw new Error('Approval request is too large; split the operation.');
    const key = hash(encoded);
    const prior = [...this.entries.values()].find(entry => entry.key === key);
    if (prior) {
      if (prior.state === 'approved') { this.entries.delete(prior.id); this.failures.delete(prior.id); return { allowed: true }; }
      return { allowed: false, approval: prior };
    }
    if (this.entries.size >= 500 || [...this.entries.values()].reduce((total, entry) => total + entry.bytes, bytes) > 16 * 1024 * 1024 ||
        [...this.entries.values()].filter(entry => entry.principal === operation.principal).length >= 20) throw new Error('Too many pending approvals; finish or wait for existing requests to expire.');
    const approval: Approval = { ...structuredClone(operation), id: token(), key, bytes, state: 'pending', expires: this.now() + this.ttl, submit };
    this.entries.set(approval.id, approval);
    return { allowed: false, approval };
  }
  challenge(id: string): string {
    const entry = this.inspect(id);
    if (!entry || entry.state !== 'pending') throw new Error('Approval is absent, expired or already decided.');
    return entry.nonce = token();
  }
  reviewUi(id: string, principal: string): ApprovalView {
    const entry = this.forPrincipal(id, principal);
    // This capability is sent only in component-only result metadata. It must
    // never enter model-visible content, structuredContent, URLs or logs.
    if (entry.state === 'pending') entry.uiToken ??= token();
    return this.uiView(entry);
  }
  decideUi(id: string, principal: string, capability: string, approve: boolean, validate?: (view: ApprovalView) => void): ApprovalView {
    const entry = this.forPrincipal(id, principal);
    if (!entry.uiToken || !equal(entry.uiToken, capability)) throw new Error('Approval unavailable or not authorized.');
    if (entry.state === 'pending') {
      if (approve) validate?.(this.uiView(entry));
      this.transition(entry, approve);
    }
    return this.uiView(entry);
  }
  private forPrincipal(id: string, principal: string): Approval {
    const entry = this.inspect(id);
    if (!entry || this.closed || entry.principal !== principal) throw new Error('Approval unavailable or not authorized.');
    return entry;
  }
  private uiView(entry: Approval): ApprovalView {
    return structuredClone({ version: 1 as const, id: entry.id, state: entry.state,
      tool: entry.tool, reason: entry.reason, args: entry.args, context: entry.context,
      expiresAt: new Date(entry.expires).toISOString(), automatic: Boolean(entry.submit || entry.submission || ['submitting', 'failed'].includes(entry.state)),
      ...(entry.state === 'pending' ? { decisionToken: entry.uiToken } : {}),
      ...(entry.submission ? { submission: entry.submission } : {}) });
  }
  decide(id: string, nonce: string, suppliedOwner: string, owner: string, approve: boolean, verifiedSession = false): boolean {
    const entry = this.inspect(id);
    if (!entry || entry.state !== 'pending' || !entry.nonce || !equal(entry.nonce, nonce)) return false;
    const failures = this.failures.get(id) ?? 0;
    if (failures >= 5) return false;
    // verifiedSession is derived from the signed HttpOnly cookie by our route,
    // never from a request-body flag or a model's claim of prior approval.
    if (!verifiedSession && !equal(suppliedOwner, owner)) { this.failures.set(id, failures + 1); return false; }
    this.transition(entry, approve);
    return true;
  }
  private transition(entry: Approval, approve: boolean): void {
    entry.state = approve ? 'approved' : 'denied'; entry.nonce = undefined;
    if (approve && entry.submit) {
      // Claim synchronously before yielding: form replays and MCP retries cannot
      // dispatch a second turn. CodexBridge owns durable delivery deduplication.
      entry.state = 'submitting';
      const submit = entry.submit; entry.submit = undefined;
      const pending = Promise.resolve().then(submit).then(receipt => {
        entry.submission = receipt; entry.state = 'submitted';
      }, () => {
        // Provider errors can contain private paths or prompts. Inspect the
        // workspace task store for details rather than publishing them here.
        entry.state = 'failed';
      }).finally(() => { entry.expires = this.now() + this.ttl; this.inFlight.delete(pending); });
      this.inFlight.add(pending);
    } else if (!approve) entry.submit = undefined;
  }
  clear() { this.entries.clear(); this.failures.clear(); }
  async close() { this.closed = true; this.clear(); await Promise.allSettled([...this.inFlight]); }
}

function under(path: string, root: string) { const tail = relative(root, path); return tail === '' || !isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`); }
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function sensitive(path: string, config: ServerConfig, mutation: boolean) {
  const parts = path.replaceAll('\\', '/').toLowerCase().split('/');
  const name = parts.at(-1) ?? '';
  if ([config.configDir, config.stateDir].some(dir => under(path, canonicalAllowedPath(dir)))) return true;
  if (parts.some(part => PRIVATE_CREDENTIAL_DIRECTORIES.includes(part))) return true;
  if (/^\.env(?:\.|$)|^(auth|credentials|secrets)\.json$|^id_(rsa|ed25519)|\.(pem|key|p12|pfx|sqlite|db)$/.test(name)) return true;
  return mutation && (under(path, runtimeRoot) || parts.some(part => ['.git', '.github', '.devspace', '.agents', '.claude'].includes(part)) ||
    /^(agents|claude)\.md$|^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|requirements.*\.txt|pyproject\.toml|dockerfile|compose.*\.ya?ml)$/.test(name));
}

export function classifyMcpOperation(config: ServerConfig, workspaces: Pick<WorkspaceRegistry, 'getWorkspace' | 'resolveReadPath'>, tool: string, args: Arguments) {
  const workspace = typeof args.workspaceId === 'string' ? workspaces.getWorkspace(args.workspaceId) : undefined;
  const root = workspace ? canonicalAllowedPath(workspace.root) : undefined;
  const paths: string[] = [];
  let reason: string | undefined;
  const highRiskOnly = config.approvalProfile === 'high_risk_only';
  let mutation = false;
  if (tool === 'exec_command' || tool === 'bash') reason = 'Arbitrary shell executes with the service OS account authority.';
  else if (tool === 'write_stdin') { if (args.chars !== undefined && args.chars !== '') reason = 'Interactive process input can execute additional commands.'; }
  else if (tool === 'codex_task_start' || tool === 'codex_task_continue') {
    reason = 'Authorize one Codex turn. Read-only prevents writes but is not a workspace-only read jail; review the prompt and selected model.';
  } else if (tool === 'show_changes') {
    reason = 'Aggregate differences can include protected file contents and need explicit owner approval.';
  } else if (tool === 'apply_patch') {
    if (typeof args.patch !== 'string') throw new Error('Patch must be a string.');
    const actions = parsePatch(args.patch);
    mutation = args.dryRun !== true;
    for (const action of actions) { paths.push(action.path); if (action.kind === 'update' && action.moveTo) paths.push(action.moveTo); }
    if (mutation && (actions.length > 20 || actions.some(action => action.kind === 'delete' || action.kind === 'update' && action.moveTo))) reason = 'Deletion, move or large batch mutation requires owner approval.';
    if (!highRiskOnly && mutation && (!args.expectedHashes || typeof args.expectedHashes !== 'object' || Array.isArray(args.expectedHashes))) reason = 'Unguarded patch requires approval; prefer expectedHashes and dryRun.';
  } else if (tool === 'write' || tool === 'edit') { mutation = true; if (!highRiskOnly) reason = 'Legacy mutation has no SHA-256 contract; prefer a guarded apply_patch.'; }
  else if (tool === 'open_workspace') { if (args.mode === 'worktree' && !highRiskOnly) reason = 'Creating a worktree changes repository state.'; }
  else if (!['read', 'project_read', 'project_files', 'project_search', 'show_changes', 'codex_preflight', 'codex_task_status', 'codex_tasks'].includes(tool)) reason = 'This capability has not been classified as routine; explicit approval is required.';
  if (typeof args.path === 'string') paths.push(args.path);
  const absolutePaths = paths.map(path => {
    const absolute = canonicalAllowedPath(tool === 'read' && workspace ? workspaces.resolveReadPath(workspace, path).absolutePath :
      assertAllowedPath(resolve(root ?? process.cwd(), path), root ? [root] : config.allowedRoots));
    if (sensitive(absolute, config, mutation)) reason = 'Credentials, service state or execution/security configuration requires owner approval.';
    return absolute;
  });
  if (mutation && [args.content, args.newText, args.patch].some(value => typeof value === 'string' && Buffer.byteLength(value) > 8 * 1024 * 1024)) reason = 'Large file mutation requires explicit approval.';
  const targets = absolutePaths.map(absolute => {
    let fingerprint: string | null = null;
    if (reason && existsSync(absolute)) {
      const info = statSync(absolute);
      fingerprint = info.isFile() && info.size <= 8 * 1024 * 1024 ? hash(readFileSync(absolute)) : `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
    }
    return { path: absolute, fingerprint };
  });
  const selected = ['codex_task_start', 'codex_task_continue'].includes(tool) && config.bridge?.executionPolicy
    ? selectExecutionModel(config.bridge.executionPolicy, typeof args.model === 'string' ? args.model : undefined, String(args.prompt ?? '')) : undefined;
  return { reason, context: { root, targets, ...(selected ? { selectedModel: selected.model } : {}) } };
}

function escape(value: string) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
export function installOwnerApprovalRoutes(app: Express, config: ServerConfig, approvals: OwnerApprovals) {
  const origin = new URL(config.publicBaseUrl).origin, base = '/owner/approvals';
  app.use(base, (_req, res, next) => {
    // no-referrer makes browser navigation POSTs send Origin: null (Fetch Standard).
    // same-origin preserves our CSRF check while hiding approval URLs off-origin.
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" }); next();
  });
  app.get(`${base}/:id`, (req, res) => {
    const entry = approvals.inspect(String(req.params.id));
    if (entry && ['submitting', 'submitted', 'failed'].includes(entry.state)) {
      const waiting = entry.state === 'submitting';
      res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">${waiting ? '<meta http-equiv="refresh" content="2">' : ''}<title>DevSpace submission status</title>
<h1>${waiting ? 'Approved: submitting one Codex turn' : entry.state === 'submitted' ? 'Codex task submitted' : 'Submission could not be confirmed'}</h1>
<p>${waiting ? 'No Chat retry is required. This page refreshes while submission is in progress.' : entry.state === 'submitted' ? 'The approved request has been submitted. Submission is not completion. Chat can now query codex_task_status; do not create another request.' : 'Do not approve or submit again automatically. Ask Chat to inspect codex_tasks for this workspace before deciding how to recover.'}</p>
${entry.submission ? `<pre>${escape(JSON.stringify(entry.submission, null, 2))}</pre>` : ''}
<p>Single-use approval; workspace and provider sandbox restrictions remain unchanged.</p></html>`);
      return;
    }
    if (!entry || entry.state !== 'pending') { res.status(404).send('Request unavailable, expired or already decided.'); return; }
    const nonce = approvals.challenge(entry.id);
    const ownerSession = readOwnerSession(req, config.oauth, origin);
    res.cookie(`devspace_approval_${entry.id}`, nonce, { httpOnly: true, sameSite: 'strict', secure: origin.startsWith('https:'), path: `${base}/${entry.id}`, maxAge: 300_000 });
    res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Approve one DevSpace operation</title>
<style>body{font-family:Georgia,serif;max-width:780px;margin:40px auto;padding:20px;background:#f5f2ec;color:#25231f}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:#fff}input,button{font:inherit;padding:10px;margin:8px 0}button{cursor:pointer}label{display:block}</style>
<h1>Approve one operation</h1><p>${escape(entry.reason)}</p><p>One-use grant, expiring in five minutes. Workspace and provider sandbox restrictions remain. Shell commands may access the service account's files and network. Review the exact operation before approving.</p>
<p>${entry.submit ? 'Approving will automatically submit exactly this Codex turn. No return-to-Chat retry is needed to start it. Chat still needs to query the result.' : 'Approving grants one exact retry from Chat; this page does not execute the operation.'}</p>
<pre>${escape(JSON.stringify({ tool: entry.tool, arguments: entry.args, context: entry.context }, null, 2))}</pre>
<form method="post" action="${base}/${entry.id}"><input type="hidden" name="nonce" value="${nonce}">${ownerSession ? `<p>Owner login verified until ${escape(new Date(ownerSession.expiresAt * 1000).toISOString())}. This still requires your decision for this one operation.</p>` : '<label>Owner password (never send this to Chat)<br><input name="owner_token" type="password" autocomplete="current-password" required maxlength="1024"></label>'}<button name="decision" value="approve">Approve once</button> <button name="decision" value="deny">Deny</button></form></html>`);
  });
  app.post(`${base}/:id`, express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    const requestOrigin = req.header('origin');
    if (requestOrigin !== origin) {
      logEvent(config.logging, 'warn', 'owner_approval_rejected', {
        reason: 'origin_mismatch', originKind: requestOrigin === undefined ? 'missing' : requestOrigin === 'null' ? 'opaque' : 'different',
      });
      res.status(403).send('Origin rejected.'); return;
    }
    const id = String(req.params.id), nonce = String(req.body?.nonce ?? '');
    const suppliedOwner = String(req.body?.owner_token ?? '');
    const verifiedSession = !suppliedOwner && Boolean(readOwnerSession(req, config.oauth, origin));
    const cookie = (req.header('cookie') ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`devspace_approval_${id}=`))?.split('=')[1];
    if (!cookie || !equal(cookie, nonce) || !['approve', 'deny'].includes(req.body?.decision) ||
        !approvals.decide(id, nonce, suppliedOwner, config.oauth.ownerToken, req.body.decision === 'approve', verifiedSession)) {
      res.status(403).send('Approval rejected or expired.'); return;
    }
    if (suppliedOwner) establishOwnerSession(res, config.oauth, origin);
    logEvent(config.logging, 'info', 'owner_approval_decided', { approvalId: id, approved: req.body.decision === 'approve' });
    if (approvals.inspect(id)?.state === 'submitting') { res.redirect(303, `${base}/${id}`); return; }
    res.send(req.body.decision === 'approve' ? 'Approved once. Return to Chat and retry the exact same operation. Nothing has executed yet.' : 'Denied. Nothing has executed.');
  });
}
