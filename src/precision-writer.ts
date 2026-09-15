import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import type { ServerConfig } from './config.js';
import { openDatabase } from './db/client.js';
import { applyPatch, parsePatch } from './apply-patch.js';
import { assertAllowedPath, canonicalAllowedPath } from './roots.js';
import { approvedModels } from './local-agent-execution.js';
import { precisionWriterInputSchema, precisionApplyInputSchema, isPrecisionPath, type PrecisionWriterInput, type PrecisionApplyInput } from './precision-writer-input.js';
import type { CodexExecutionEvidence } from './local-agent-execution.js';
import type { LocalAgentTokenUsage } from './local-agent-usage.js';

const MAX_FILE_BYTES = 131072, MAX_SNAPSHOT_BYTES = 524288, MAX_PATCH_BYTES = 262144;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k)+':'+stable(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export interface PrecisionFile { path: string; sha256: string | null; text: string | null; writable: boolean }
export interface PrecisionGeneration {
  prompt: string; model: string; files: PrecisionFile[]; signal: AbortSignal;
}
export interface PrecisionCandidate { patch: string; executionEvidence: CodexExecutionEvidence; usage?: LocalAgentTokenUsage }
export type PrecisionGenerator = (input: PrecisionGeneration) => Promise<PrecisionCandidate>;
interface Row {
  id: string; workspace_root: string; request_hash: string; fingerprint: string;
  state: string; input_json: string; snapshot_json: string; candidate_json: string | null;
  candidate_hash: string | null; apply_key: string | null; error: string | null;
}
export interface PrecisionView {
  id: string;
  status: string;
  error?: string;
  candidateHash?: string | null;
  executionEvidence?: CodexExecutionEvidence;
  usage?: LocalAgentTokenUsage;
  candidate?: { patch: string };
  allowedFiles?: string[];
  expectedHashes?: Record<string, string | null>;
  instruction: string;
}

/** No symlink or hard-link sources, including existing ancestors of new files. */
async function readScoped(root: string, path: string, expected: string | null): Promise<string | null> {
  if (!isPrecisionPath(path)) throw new Error('Invalid precision file path.');
  let current = root;
  for (const [index, part] of path.split('/').entries()) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && expected === null) return null;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error('Precision paths cannot traverse symbolic links.');
    if (index < path.split('/').length - 1 && !info.isDirectory()) throw new Error('Precision parent is not a directory.');
    if (index === path.split('/').length - 1 && (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE_BYTES)) throw new Error('Precision source must be a bounded regular file with one link.');
  }
  const bytes = await readFile(current);
  if (bytes.length > MAX_FILE_BYTES || digest(bytes) !== expected) throw new Error(`File hash changed: ${path}; read it again before submitting.`);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
export async function precisionSnapshot(root: string, input: PrecisionWriterInput): Promise<PrecisionFile[]> {
  const files: PrecisionFile[] = [];
  let bytes = 0;
  for (const path of input.allowedFiles) {
    const text = await readScoped(root, path, input.expectedHashes[path]);
    bytes += text === null ? 0 : Buffer.byteLength(text);
    if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('Precision context exceeds its byte budget; narrow the files.');
    files.push({ path, text, sha256: input.expectedHashes[path], writable: true });
  }
  for (const item of input.contextFiles) {
    const text = await readScoped(root, item.path, item.expectedSha256);
    bytes += Buffer.byteLength(text!);
    if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('Precision context exceeds its byte budget; narrow the files.');
    files.push({ path: item.path, text, sha256: item.expectedSha256, writable: false });
  }
  return files;
}
export function validatePrecisionPatch(input: PrecisionWriterInput, patch: string) {
  if (!patch || Buffer.byteLength(patch) > MAX_PATCH_BYTES) throw new Error('Candidate patch is empty or exceeds its byte budget.');
  const seen = new Set<string>();
  const hashes: Record<string,string|null> = {};
  for (const action of parsePatch(patch)) {
    if (!isPrecisionPath(action.path) || !input.allowedFiles.includes(action.path) || seen.has(action.path)) throw new Error('Candidate touched an unapproved or duplicate path.');
    if (action.kind === 'delete' || action.kind === 'update' && action.moveTo) throw new Error('Precision candidates cannot delete or move files.');
    if ((action.kind === 'add') !== (input.expectedHashes[action.path] === null)) throw new Error('Candidate cannot overwrite an existing file with Add File or update a missing file.');
    seen.add(action.path); hashes[action.path] = input.expectedHashes[action.path];
  }
  return hashes;
}

/** Durable one-shot candidate generation and separately approved deterministic application. */
export class PrecisionWriter {
  private readonly database;
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private closing = false;
  constructor(private readonly config: ServerConfig, private readonly generate: PrecisionGenerator) {
    if (config.toolAuthorization !== 'owner_approval' || !config.bridge?.executionPolicy) throw new Error('precision_writer requires Owner approval and an explicit execution policy.');
    this.database = openDatabase(join(config.stateDir, 'precision-writer'), db => db.exec(`CREATE TABLE IF NOT EXISTS precision_writer_tasks (
      id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL, request_hash TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
      state TEXT NOT NULL, input_json TEXT NOT NULL, snapshot_json TEXT NOT NULL, candidate_json TEXT, candidate_hash TEXT,
      apply_key TEXT, error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`));
    this.database.sqlite.prepare("UPDATE precision_writer_tasks SET state='interrupted', error='Previous execution was interrupted; inspect state before a new request.' WHERE state IN ('running','applying')").run();
  }
  private root(root: string) {
    const physical = canonicalAllowedPath(assertAllowedPath(root, this.config.allowedRoots));
    if (physical !== resolve(root)) throw new Error('Open the canonical project directory for precision writing.');
    return physical;
  }
  private row(id: string, root: string): Row {
    const row = this.database.sqlite.prepare('SELECT * FROM precision_writer_tasks WHERE id=? AND workspace_root=?').get(id, this.root(root)) as Row | undefined;
    if (!row) throw new Error('Precision task is unavailable in this workspace.');
    return row;
  }
  private view(row: Row, includeCandidate = false): PrecisionView {
    const candidate = row.candidate_json ? JSON.parse(row.candidate_json) as PrecisionCandidate : undefined;
    return { id: row.id, status: row.state, ...(row.error ? { error: row.error } : {}),
      ...(candidate ? { candidateHash: row.candidate_hash, executionEvidence: candidate.executionEvidence, usage: candidate.usage,
        ...(includeCandidate ? { candidate: { patch: candidate.patch }, allowedFiles: JSON.parse(row.input_json).allowedFiles,
          expectedHashes: JSON.parse(row.input_json).expectedHashes } : {}) } : {}),
      instruction: row.state === 'ready' ? 'Review the candidate patch, then request precision_writer_apply with this candidateHash, original allowedFiles and expectedHashes. Local tools handle reads, searches and tests.' : 'Use precision_writer_status for this same task; never replay generation because polling is delayed.' };
  }
  async start(root: string, raw: unknown): Promise<PrecisionView & { replayed?: boolean }> {
    if (this.closing) throw new Error('Precision writer is closing.');
    root = this.root(root);
    const input = precisionWriterInputSchema.parse(raw);
    if (!approvedModels(this.config.bridge!.executionPolicy!).includes(input.model)) throw new Error('Requested precision model is not in the configured allowlist.');
    const requestHash = digest(stable([root, input.requestKey]));
    const fingerprint = digest(stable(input));
    const previous = this.database.sqlite.prepare('SELECT * FROM precision_writer_tasks WHERE request_hash=?').get(requestHash) as Row | undefined;
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('requestKey was already used for different precision inputs.');
      return { ...this.view(previous), replayed: true };
    }
    if (this.active.size >= 2 || [...this.active.keys()].some(id => this.row(id, root).workspace_root === root)) throw new Error('Precision writer is busy; inspect the existing task before starting another.');
    const files = await precisionSnapshot(root, input);
    if (await realpath(root) !== root) throw new Error('Workspace root changed while preparing precision context.');
    const id = 'pw_' + randomBytes(12).toString('hex');
    const inserted = this.database.sqlite.prepare("INSERT OR IGNORE INTO precision_writer_tasks(id,workspace_root,request_hash,fingerprint,state,input_json,snapshot_json) VALUES(?,?,?,?,'running',?,?)")
      .run(id, root, requestHash, fingerprint, JSON.stringify(input), JSON.stringify(files));
    if (!inserted.changes) return this.start(root, input);
    const controller = new AbortController();
    const done = Promise.resolve().then(async () => {
      try {
        const candidate = await this.generate({ prompt: input.prompt, model: input.model, files, signal: controller.signal });
        const hashes = validatePrecisionPatch(input, candidate.patch);
        await precisionSnapshot(root, input);
        await applyPatch(root, candidate.patch, { expectedHashes: hashes, dryRun: true });
        const candidateHash = digest(stable(candidate));
        this.database.sqlite.prepare("UPDATE precision_writer_tasks SET state='ready',candidate_json=?,candidate_hash=? WHERE id=?").run(JSON.stringify(candidate), candidateHash, id);
      } catch (error) {
        // Do not publish provider stderr, file contents, credentials or prompts.
        const safe = error instanceof Error && /^(Candidate|Precision|File hash changed|Workspace root changed)/.test(error.message) ? error.message.slice(0,300) : 'Precision generation failed; no candidate was applied.';
        this.database.sqlite.prepare("UPDATE precision_writer_tasks SET state='failed',error=? WHERE id=?").run(safe, id);
      } finally { this.active.delete(id); }
    });
    this.active.set(id, { controller, done });
    return this.view(this.row(id, root));
  }
  async status(root: string, id?: string, requestKey?: string, waitSeconds = 0) {
    root = this.root(root);
    if (!id && requestKey) id = (this.database.sqlite.prepare('SELECT id FROM precision_writer_tasks WHERE request_hash=?').get(digest(stable([root, requestKey]))) as {id:string}|undefined)?.id;
    if (!id) return { tasks: (this.database.sqlite.prepare('SELECT * FROM precision_writer_tasks WHERE workspace_root=? ORDER BY created_at DESC,rowid DESC LIMIT 10').all(root) as Row[]).map(row => this.view(row)) };
    const active = this.active.get(id);
    if (active && waitSeconds > 0) await Promise.race([active.done, new Promise(resolve => setTimeout(resolve, Math.min(20, waitSeconds)*1000))]);
    return this.view(this.row(id, root), true);
  }
  async apply(root: string, raw: unknown) {
    if (this.closing) throw new Error('Precision writer is closing.');
    root = this.root(root);
    const input: PrecisionApplyInput = precisionApplyInputSchema.parse(raw), row = this.row(input.agentId, root);
    const original = precisionWriterInputSchema.parse(JSON.parse(row.input_json));
    if (input.candidateHash !== row.candidate_hash || stable(input.allowedFiles) !== stable(original.allowedFiles) || stable(input.expectedHashes) !== stable(original.expectedHashes)) throw new Error('Candidate scope or hash differs from the generated proposal.');
    const applyKey = digest(stable([root,input.requestKey]));
    if (row.state === 'applied' && row.apply_key === applyKey) return { ...this.view(row), replayed: true };
    if (row.state !== 'ready' || !row.candidate_json) throw new Error('Candidate is not ready to apply; inspect its current status.');
    const candidate = JSON.parse(row.candidate_json) as PrecisionCandidate;
    const hashes = validatePrecisionPatch(original, candidate.patch);
    await precisionSnapshot(root, original);
    const claim = this.database.sqlite.prepare("UPDATE precision_writer_tasks SET state='applying',apply_key=? WHERE id=? AND state='ready'").run(applyKey,input.agentId);
    if (!claim.changes) throw new Error('Candidate application is already in progress; query its status.');
    try {
      const result = await applyPatch(root,candidate.patch,{expectedHashes:hashes});
      this.database.sqlite.prepare("UPDATE precision_writer_tasks SET state='applied' WHERE id=?").run(input.agentId);
      return { ...this.view(this.row(input.agentId, root)), files: result.files };
    } catch {
      this.database.sqlite.prepare("UPDATE precision_writer_tasks SET state='apply_failed',error='Candidate application failed; inspect affected files before any new request.' WHERE id=?").run(input.agentId);
      throw new Error('Candidate application failed; inspect affected files before any new request.');
    }
  }
  async close() {
    this.closing = true;
    const active = [...this.active.values()]; for (const task of active) task.controller.abort();
    await Promise.allSettled(active.map(task => task.done)); this.database.close();
  }
}
