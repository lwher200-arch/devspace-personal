import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  createReadStream,
  type Dirent,
} from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const FILESYSTEM_CANDIDATE_WORKSPACE_PROFILE = "filesystem-snapshot-reflink-or-copy-v1";

export interface CandidateWorkspaceCapability {
  available: boolean;
  profile: string;
  reason?: string;
}

export interface CandidateWorkspace {
  id: string;
  executionId: string;
  stableRoot: string;
  root: string;
  profile: string;
  createdAt: string;
}

export interface CandidateMutationSet {
  created: string[];
  modified: string[];
  deleted: string[];
  changedBytes: number;
  stableChanged: boolean;
}

export interface CandidateWorkspaceProvider {
  readonly profile: string;
  probe(stableRoot: string): Promise<CandidateWorkspaceCapability>;
  create(stableRoot: string, executionId: string): Promise<CandidateWorkspace>;
  inspect(candidate: CandidateWorkspace): Promise<CandidateMutationSet>;
  discard(candidate: CandidateWorkspace): Promise<void>;
  close(): Promise<void>;
}

type ManifestEntry =
  | { type: "file"; hash: string; size: number; mode: number }
  | { type: "directory"; mode: number }
  | { type: "symlink"; target: string };

interface ActiveCandidate {
  candidate: CandidateWorkspace;
  baseline: Map<string, ManifestEntry>;
  baselineDigest: string;
}

export class CandidateWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateWorkspaceError";
  }
}

export class FilesystemCandidateWorkspaceProvider implements CandidateWorkspaceProvider {
  readonly profile = FILESYSTEM_CANDIDATE_WORKSPACE_PROFILE;
  private readonly active = new Map<string, ActiveCandidate>();
  private closed = false;

  constructor(private readonly candidateBase: string) {}

  async probe(stableRoot: string): Promise<CandidateWorkspaceCapability> {
    if (process.platform !== "linux") {
      return { available: false, profile: this.profile, reason: "candidate workspace v0.1 is Linux-only" };
    }
    try {
      const stable = await canonicalDirectory(stableRoot, "stable workspace");
      const base = await ensureCandidateBase(this.candidateBase);
      assertCandidateBaseOutsideStable(stable, base);
      const probe = await mkdtemp(join(base, ".probe-"));
      await rm(probe, { recursive: true, force: true });
      return { available: true, profile: this.profile };
    } catch (error) {
      return {
        available: false,
        profile: this.profile,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async create(stableRoot: string, executionId: string): Promise<CandidateWorkspace> {
    if (this.closed) throw new CandidateWorkspaceError("Candidate workspace provider is closed.");
    if (process.platform !== "linux") throw new CandidateWorkspaceError("Candidate workspace v0.1 requires Linux.");
    if (!executionId.trim()) throw new CandidateWorkspaceError("Candidate executionId is required.");

    const stable = await canonicalDirectory(stableRoot, "stable workspace");
    const base = await ensureCandidateBase(this.candidateBase);
    assertCandidateBaseOutsideStable(stable, base);
    const root = await mkdtemp(join(base, "candidate-"));
    await chmod(root, 0o700);

    try {
      const baseline = await buildManifest(stable, stable);
      await copyManifest(stable, root, baseline);
      const stableAfter = await buildManifest(stable, stable);
      const baselineDigest = digestManifest(baseline);
      if (digestManifest(stableAfter) !== baselineDigest) {
        throw new CandidateWorkspaceError("Stable workspace changed while the candidate snapshot was being created.");
      }
      const copied = await buildManifest(root, root);
      if (digestManifest(copied) !== baselineDigest) {
        throw new CandidateWorkspaceError("Candidate snapshot verification did not match the stable workspace baseline.");
      }

      const candidate: CandidateWorkspace = {
        id: randomUUID(),
        executionId,
        stableRoot: stable,
        root,
        profile: this.profile,
        createdAt: new Date().toISOString(),
      };
      this.active.set(candidate.id, { candidate, baseline, baselineDigest });
      return structuredClone(candidate);
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async inspect(candidate: CandidateWorkspace): Promise<CandidateMutationSet> {
    const active = this.requireActive(candidate);
    const current = await buildManifest(active.candidate.root, active.candidate.root);
    const stableCurrent = await buildManifest(active.candidate.stableRoot, active.candidate.stableRoot);
    const created: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    let changedBytes = 0;

    for (const [path, entry] of current) {
      const before = active.baseline.get(path);
      if (!before) {
        created.push(path);
        changedBytes += entryBytes(entry);
      } else if (!sameEntry(before, entry)) {
        modified.push(path);
        changedBytes += Math.max(entryBytes(before), entryBytes(entry));
      }
    }
    for (const [path, entry] of active.baseline) {
      if (current.has(path)) continue;
      deleted.push(path);
      changedBytes += entryBytes(entry);
    }

    created.sort();
    modified.sort();
    deleted.sort();
    return {
      created,
      modified,
      deleted,
      changedBytes,
      stableChanged: digestManifest(stableCurrent) !== active.baselineDigest,
    };
  }

  async discard(candidate: CandidateWorkspace): Promise<void> {
    const active = this.requireActive(candidate);
    this.active.delete(candidate.id);
    await rm(active.candidate.root, { recursive: true, force: true });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const candidates = [...this.active.values()];
    this.active.clear();
    await Promise.allSettled(candidates.map(({ candidate }) =>
      rm(candidate.root, { recursive: true, force: true })));
  }

  private requireActive(candidate: CandidateWorkspace): ActiveCandidate {
    const active = this.active.get(candidate.id);
    if (!active ||
        active.candidate.root !== candidate.root ||
        active.candidate.stableRoot !== candidate.stableRoot ||
        active.candidate.executionId !== candidate.executionId ||
        active.candidate.profile !== candidate.profile) {
      throw new CandidateWorkspaceError("Candidate workspace is unavailable or not owned by this provider.");
    }
    return active;
  }
}

async function ensureCandidateBase(path: string): Promise<string> {
  const absolute = resolve(path);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  await chmod(absolute, 0o700);
  return realpath(absolute);
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const absolute = resolve(path);
  let resolved: string;
  try {
    resolved = await realpath(absolute);
  } catch {
    throw new CandidateWorkspaceError(`Candidate ${label} does not exist: ${path}`);
  }
  const info = await lstat(resolved);
  if (!info.isDirectory()) throw new CandidateWorkspaceError(`Candidate ${label} is not a directory: ${path}`);
  return resolved;
}

function pathInside(root: string, candidate: string): boolean {
  const tail = relative(root, candidate);
  return tail === "" || (!isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${sep}`));
}

function assertCandidateBaseOutsideStable(stableRoot: string, candidateBase: string): void {
  if (pathInside(stableRoot, candidateBase)) {
    throw new CandidateWorkspaceError("Candidate workspace storage must be outside the stable workspace.");
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function buildManifest(root: string, symlinkBoundary: string): Promise<Map<string, ManifestEntry>> {
  const result = new Map<string, ManifestEntry>();
  await walk(root, "");
  return result;

  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? join(prefix, entry.name) : entry.name;
      const absolutePath = join(directory, entry.name);
      await addEntry(entry, absolutePath, relativePath);
    }
  }

  async function addEntry(entry: Dirent, absolutePath: string, relativePath: string): Promise<void> {
    const info = await lstat(absolutePath);
    if (entry.isDirectory()) {
      result.set(relativePath, { type: "directory", mode: info.mode & 0o777 });
      await walk(absolutePath, relativePath);
      return;
    }
    if (entry.isFile()) {
      result.set(relativePath, {
        type: "file",
        hash: await hashFile(absolutePath),
        size: info.size,
        mode: info.mode & 0o777,
      });
      return;
    }
    if (entry.isSymbolicLink()) {
      let resolvedTarget: string;
      try {
        resolvedTarget = await realpath(absolutePath);
      } catch {
        throw new CandidateWorkspaceError(`Candidate snapshot rejects broken symlink: ${relativePath}`);
      }
      if (!pathInside(symlinkBoundary, resolvedTarget)) {
        throw new CandidateWorkspaceError(`Candidate snapshot rejects symlink escaping the workspace: ${relativePath}`);
      }
      result.set(relativePath, {
        type: "symlink",
        target: relative(symlinkBoundary, resolvedTarget),
      });
      return;
    }
    throw new CandidateWorkspaceError(`Candidate snapshot rejects special filesystem entry: ${relativePath}`);
  }
}

async function copyManifest(
  sourceRoot: string,
  candidateRoot: string,
  manifest: Map<string, ManifestEntry>,
): Promise<void> {
  const directories = [...manifest.entries()]
    .filter((entry): entry is [string, Extract<ManifestEntry, { type: "directory" }>] => entry[1].type === "directory")
    .sort((left, right) => depth(left[0]) - depth(right[0]));
  for (const [path, entry] of directories) {
    const destination = join(candidateRoot, path);
    await mkdir(destination, { recursive: false, mode: entry.mode });
    await chmod(destination, entry.mode);
  }

  for (const [path, entry] of manifest) {
    const source = join(sourceRoot, path);
    const destination = join(candidateRoot, path);
    if (entry.type === "file") {
      await copyFile(source, destination, constants.COPYFILE_FICLONE);
      await chmod(destination, entry.mode);
      const info = await lstat(source);
      await utimes(destination, info.atime, info.mtime);
    } else if (entry.type === "symlink") {
      const targetInCandidate = join(candidateRoot, entry.target);
      const relativeTarget = relative(dirname(destination), targetInCandidate) || ".";
      await symlink(relativeTarget, destination);
    }
  }
}

function digestManifest(manifest: Map<string, ManifestEntry>): string {
  const hash = createHash("sha256");
  for (const [path, entry] of [...manifest.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(JSON.stringify([path, entry]));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function sameEntry(left: ManifestEntry, right: ManifestEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function entryBytes(entry: ManifestEntry): number {
  return entry.type === "file" ? entry.size : 0;
}

function depth(path: string): number {
  return path.split(sep).length;
}
