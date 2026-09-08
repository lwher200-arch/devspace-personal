import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { opendir, open, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { assertAllowedPath, canonicalAllowedPath, PRIVATE_CREDENTIAL_DIRECTORIES } from "./roots.js";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", ".next", ".vs", ".claude",
  ".codex_tmp", ".runtime", "uv_cache", "dist", "build", "target",
  ...PRIVATE_CREDENTIAL_DIRECTORIES,
]);
const SKIP_ROOT_DIRS = new Set(["SystemLogs", "logs", "output", "outputs"]);
type Skip = { path: string; reason: string };
type Coverage = { complete: boolean; source: "git" | "filesystem"; fallbackReason?: string; visited: number; skippedCount: number; skipped: Skip[]; exclusions: string[] };
type ScopeInput = { path?: string; cursor?: string; limit?: number; includeIgnored?: boolean };
type Cursor = { version: number; scope: string; snapshot: string; index: number; line?: number; fileHash?: string };

function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function bounded(value: number | undefined, fallback: number, max: number, min = 1): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`Expected integer between ${min} and ${max}.`);
  return result;
}
function guard(root: string) {
  const pinned = canonicalAllowedPath(root);
  return (path: string) => {
    if (!path || path.includes("\0") || isAbsolute(path)) throw new Error("Expected a workspace-relative path.");
    if (canonicalAllowedPath(root) !== pinned) throw new Error("Workspace root changed its filesystem target.");
    return canonicalAllowedPath(assertAllowedPath(resolve(root, path), [root]));
  };
}
function sensitive(name: string): boolean {
  return (/^\.env(?:\.|$)/i.test(name) && !/[.-](example|sample|template)$/i.test(name)) ||
    /\.(pem|key|p12|pfx)$/i.test(name) || /^(auth|credentials|secrets)\.json$/i.test(name) || /^id_(rsa|ed25519)(\.|$)/i.test(name);
}
function skip(coverage: Coverage, path: string, reason: string): void {
  coverage.skippedCount++;
  if (coverage.skipped.length < 40) coverage.skipped.push({ path, reason });
}

async function inventory(root: string, path = ".", includeIgnored = false) {
  const safe = guard(root);
  const scope = safe(path);
  if (!(await stat(scope)).isDirectory()) throw new Error("Project discovery path must be a directory.");
  const files: string[] = [];
  const coverage: Coverage = { complete: true, source: "filesystem", visited: 0, skippedCount: 0, skipped: [],
    exclusions: [...SKIP_DIRS, "root logs/outputs", "likely credential filenames", "symlinks/junctions"] };
  const prefix = relative(canonicalAllowedPath(root), scope).replace(/\\/g, "/");
  const explicitlyExcludedScope = prefix.split("/").some(part => SKIP_DIRS.has(part.toLowerCase()) || SKIP_ROOT_DIRS.has(part));
  if (!includeIgnored && !explicitlyExcludedScope) {
    let candidates: string[] | undefined;
    try {
      const git = promisify(execFile);
      const options = { cwd: root, encoding: "utf8" as const, timeout: 8000, maxBuffer: 16 * 1024 * 1024, windowsHide: true };
      const top = (await git("git", ["rev-parse", "--show-toplevel"], options)).stdout.trim();
      if (canonicalAllowedPath(top) === canonicalAllowedPath(root)) {
        candidates = (await git("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z"], options)).stdout.split("\0").filter(Boolean);
      }
    } catch (error) {
      const message = (error as { stderr?: string }).stderr || (error as Error).message;
      coverage.fallbackReason = message.split("\n")[0].slice(0, 240);
    }
    if (candidates) {
      coverage.source = "git";
      coverage.exclusions.push("Git-ignored untracked files (use includeIgnored on a narrow path when needed)");
      const safeDirectories = new Map<string, boolean>([["", true]]);
      const deadline = Date.now() + 10000;
      for (const name of candidates) {
        if (prefix && !name.startsWith(`${prefix}/`)) continue;
        if (++coverage.visited > 100000 || Date.now() >= deadline) { coverage.complete = false; break; }
        const parts = name.split("/");
        if (parts.slice(0, -1).some((part, index) => SKIP_DIRS.has(part.toLowerCase()) || /^\.venv[-_]/i.test(part) || (index === 0 && SKIP_ROOT_DIRS.has(part)))) {
          skip(coverage, name, "excluded directory"); continue;
        }
        if (sensitive(parts.at(-1)!)) { skip(coverage, name, "likely credential filename"); continue; }
        try {
          let valid = true;
          for (let i = 1; i < parts.length; i++) {
            const directory = parts.slice(0, i).join("/");
            if (!safeDirectories.has(directory)) {
              const metadata = lstatSync(join(root, directory));
              safeDirectories.set(directory, metadata.isDirectory() && !metadata.isSymbolicLink());
            }
            if (!safeDirectories.get(directory)) { valid = false; break; }
          }
          const metadata = valid ? lstatSync(join(root, name)) : undefined;
          if (!valid || metadata?.isSymbolicLink()) { skip(coverage, name, "symlink"); continue; }
          if (!metadata?.isFile()) { skip(coverage, name, "not a regular file"); continue; }
          files.push(name);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") coverage.complete = false;
          skip(coverage, name, code ?? "inaccessible");
        }
      }
      safe(path);
      files.sort();
      return { files, coverage, snapshot: hash(JSON.stringify([scope, files])), scope };
    }
  }
  const deadline = Date.now() + 10000;
  const pending = [path];
  while (pending.length) {
    if (coverage.visited >= 100000 || Date.now() >= deadline) { coverage.complete = false; break; }
    const directory = pending.pop()!;
    try {
      for await (const entry of await opendir(safe(directory))) {
        if (++coverage.visited > 100000 || Date.now() >= deadline) { coverage.complete = false; break; }
        const name = relative(resolve(root), resolve(root, directory, entry.name)).replace(/\\/g, "/");
        if (entry.isSymbolicLink()) { skip(coverage, name, "symlink"); continue; }
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name.toLowerCase()) || /^\.venv[-_]/i.test(entry.name) ||
            (directory === "." && SKIP_ROOT_DIRS.has(entry.name))) { skip(coverage, name, "excluded directory"); continue; }
          pending.push(name);
        } else if (entry.isFile()) {
          if (sensitive(entry.name)) { skip(coverage, name, "likely credential filename"); continue; }
          files.push(name);
        } else { skip(coverage, name, "not a regular file"); }
      }
    } catch (error) {
      coverage.complete = false;
      skip(coverage, directory, (error as NodeJS.ErrnoException).code ?? "directory inaccessible");
    }
  }
  safe(path);
  files.sort();
  return { files, coverage, snapshot: hash(JSON.stringify([scope, files])), scope };
}
function encode(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor)).toString("base64url"); }
function decode(value: string | undefined, scope: string, snapshot: string): Cursor {
  if (!value) return { version: 1, scope, snapshot, index: 0 };
  let cursor: Cursor;
  try {
    if (value.length > 2048) throw new Error();
    cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
    if (cursor.version !== 1 || cursor.scope !== scope || !Number.isSafeInteger(cursor.index) || cursor.index < 0 ||
      (cursor.line !== undefined && (!Number.isSafeInteger(cursor.line) || cursor.line < 0))) throw new Error();
  } catch { throw new Error("Invalid cursor for this request."); }
  if (cursor.snapshot !== snapshot) throw new Error("Project file list changed; cursor is stale. Restart discovery.");
  return cursor;
}

export async function projectFiles(root: string, input: ScopeInput) {
  const limit = bounded(input.limit, 200, 500);
  const catalog = await inventory(root, input.path, input.includeIgnored);
  const scope = hash(JSON.stringify(["files", catalog.scope]));
  const cursor = decode(input.cursor, scope, catalog.snapshot);
  if (cursor.index > catalog.files.length) throw new Error("Invalid cursor offset.");
  const files: string[] = [];
  let bytes = 0;
  for (const path of catalog.files.slice(cursor.index, cursor.index + limit)) {
    if (files.length && bytes + Buffer.byteLength(path) > 20000) break;
    files.push(path); bytes += Buffer.byteLength(path);
  }
  const end = cursor.index + files.length;
  return { files, totalFiles: catalog.files.length, snapshot: catalog.snapshot,
    complete: end === catalog.files.length && catalog.coverage.complete,
    nextCursor: end < catalog.files.length ? encode({ ...cursor, index: end }) : undefined,
    coverage: catalog.coverage,
    instruction: "Follow nextCursor until absent; coverage.complete must also be true. Exclusions are discovery defaults, not extra access rights. Narrow path if scan budget is exceeded." };
}

async function readText(root: string, path: string) {
  const safe = guard(root);
  const absolute = safe(path);
  const handle = await open(absolute, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Not a regular file.");
    if (before.size > MAX_FILE_BYTES) throw new Error("File exceeds the 8 MiB text limit; use a format-specific bounded reader.");
    const buffer = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = await handle.read(buffer, count, buffer.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("File changed during read; retry.");
    if (safe(path) !== absolute) throw new Error("File changed its filesystem target.");
    const bytes = buffer.subarray(0, count);
    if (bytes.includes(0)) throw new Error("File is binary, not UTF-8 text.");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error("File is not valid UTF-8 text; use a format-specific reader."); }
    return { text, sha256: hash(bytes), bytes: count };
  } finally { await handle.close(); }
}

export async function projectRead(root: string, input: { path: string; offset?: number; limit?: number; expectedSha256?: string }) {
  const limit = bounded(input.limit, 12000, 20000, 2);
  const offset = bounded(input.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const file = await readText(root, input.path);
  if (input.expectedSha256 && input.expectedSha256 !== file.sha256) throw new Error("File hash changed; restart reading before editing.");
  if (offset > file.text.length || (offset > 0 && /[\uDC00-\uDFFF]/.test(file.text[offset] ?? ""))) throw new Error("Invalid character offset.");
  let end = Math.min(offset + limit, file.text.length);
  while (Buffer.byteLength(JSON.stringify(file.text.slice(offset, end))) > 16000) {
    end = offset + Math.max(1, Math.floor((end - offset) * 0.8));
  }
  if (end < file.text.length && /[\uD800-\uDBFF]/.test(file.text[end - 1])) end--;
  return { path: input.path, text: file.text.slice(offset, end), sha256: file.sha256, bytes: file.bytes,
    offset, nextOffset: end < file.text.length ? end : undefined, totalCharacters: file.text.length,
    complete: end === file.text.length, encoding: "utf-8", hasBom: file.text.startsWith("\ufeff") };
}

export async function readProjectRequest(root: string, path: string): Promise<unknown> {
  const file = await readText(root, path);
  if (file.bytes > 1024 * 1024) throw new Error("Patch request exceeds 1 MiB; split it into reviewed batches.");
  return JSON.parse(file.text.replace(/^\ufeff/, ""));
}

export async function projectSearch(root: string, input: ScopeInput & { query: string }) {
  if (!input.query || input.query.length > 1000 || /[\r\n\0]/.test(input.query)) throw new Error("Query must be a nonempty single-line literal of at most 1000 characters.");
  const limit = bounded(input.limit, 50, 100);
  const catalog = await inventory(root, input.path, input.includeIgnored);
  const scope = hash(JSON.stringify(["search", catalog.scope, input.query]));
  const cursor = decode(input.cursor, scope, catalog.snapshot);
  if (cursor.index > catalog.files.length) throw new Error("Invalid cursor offset.");
  const matches: Array<{ path: string; line: number; column: number; text: string; textTruncated: boolean; sha256: string }> = [];
  const skipped: Skip[] = [];
  let skippedCount = 0;
  let matchBytes = 0;
  const deadline = Date.now() + 5000;
  let index = cursor.index;
  let scannedFiles = 0;
  let scannedBytes = 0;
  let nextCursor: string | undefined;
  for (; index < catalog.files.length; index++) {
    if (scannedFiles >= 100 || scannedBytes >= 8 * 1024 * 1024 || Date.now() >= deadline) break;
    const path = catalog.files[index];
    scannedFiles++;
    let file;
    try { file = await readText(root, path); }
    catch (error) {
      if (index === cursor.index && cursor.fileHash) throw new Error("Search continuation file changed or became unreadable; cursor is stale.");
      skippedCount++;
      if (skipped.length < 20) skipped.push({ path, reason: error instanceof Error ? error.message : "unreadable" });
      continue;
    }
    scannedBytes += file.bytes;
    if (index === cursor.index && cursor.fileHash && file.sha256 !== cursor.fileHash) throw new Error("Search continuation file changed; cursor is stale.");
    const lines = file.text.split(/\r?\n/);
    if (index === cursor.index && (cursor.line ?? 0) > lines.length) throw new Error("Invalid cursor line offset.");
    for (let line = index === cursor.index ? cursor.line ?? 0 : 0; line < lines.length; line++) {
      const column = lines[line].indexOf(input.query);
      if (column < 0) continue;
      const start = Math.max(0, column - 100);
      const match = { path, line: line + 1, column: column + 1, text: lines[line].slice(start, start + 400),
        textTruncated: start > 0 || lines[line].length > start + 400, sha256: file.sha256 };
      const size = Buffer.byteLength(JSON.stringify(match));
      if (matches.length && matchBytes + size > 16000) {
        nextCursor = encode({ ...cursor, index, line, fileHash: file.sha256 });
        return { matches, nextCursor, complete: false, scannedFiles, skippedCount, skipped, coverage: catalog.coverage };
      }
      matches.push(match);
      matchBytes += size;
      if (matches.length === limit) {
        nextCursor = line + 1 < lines.length
          ? encode({ ...cursor, index, line: line + 1, fileHash: file.sha256 })
          : index + 1 < catalog.files.length ? encode({ version: 1, scope, snapshot: catalog.snapshot, index: index + 1 }) : undefined;
        return { matches, nextCursor, complete: !nextCursor && catalog.coverage.complete, scannedFiles, skippedCount, skipped, coverage: catalog.coverage };
      }
    }
  }
  if (index < catalog.files.length) nextCursor = encode({ version: 1, scope, snapshot: catalog.snapshot, index });
  return { matches, nextCursor, complete: !nextCursor && catalog.coverage.complete, scannedFiles, skippedCount, skipped, coverage: catalog.coverage,
    instruction: "Literal, case-sensitive search; one match per line. Follow nextCursor even when matches is empty. Report skipped files and discovery exclusions; this is not an atomic snapshot of file contents." };
}
