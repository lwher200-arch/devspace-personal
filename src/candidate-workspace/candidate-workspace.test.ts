import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CandidateWorkspaceError,
  FILESYSTEM_CANDIDATE_WORKSPACE_PROFILE,
  FilesystemCandidateWorkspaceProvider,
} from "./candidate-workspace.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devspace-candidate-workspace-"));
  const stable = join(root, "stable");
  const candidates = join(root, "candidates");
  mkdirSync(join(stable, "src"), { recursive: true });
  writeFileSync(join(stable, "src", "a.txt"), "alpha\n");
  writeFileSync(join(stable, "untracked.txt"), "untracked\n");
  symlinkSync("a.txt", join(stable, "src", "alias.txt"));
  return { root, stable, candidates };
}

test("candidate snapshot preserves project state while isolating mutations from Stable Workspace", async t => {
  if (process.platform !== "linux") { t.skip("Candidate workspace v0.1 is Linux-only."); return; }
  const fx = fixture();
  const provider = new FilesystemCandidateWorkspaceProvider(fx.candidates);
  try {
    const capability = await provider.probe(fx.stable);
    assert.equal(capability.available, true);
    assert.equal(capability.profile, FILESYSTEM_CANDIDATE_WORKSPACE_PROFILE);

    const candidate = await provider.create(fx.stable, "exec-1");
    assert.equal(candidate.profile, FILESYSTEM_CANDIDATE_WORKSPACE_PROFILE);
    assert.equal(readFileSync(join(candidate.root, "src", "a.txt"), "utf8"), "alpha\n");
    assert.equal(readFileSync(join(candidate.root, "src", "alias.txt"), "utf8"), "alpha\n");
    assert.equal(readFileSync(join(candidate.root, "untracked.txt"), "utf8"), "untracked\n");

    writeFileSync(join(candidate.root, "src", "a.txt"), "candidate\n");
    writeFileSync(join(candidate.root, "created.txt"), "created\n");
    rmSync(join(candidate.root, "untracked.txt"));

    assert.equal(readFileSync(join(fx.stable, "src", "a.txt"), "utf8"), "alpha\n");
    assert.equal(readFileSync(join(fx.stable, "untracked.txt"), "utf8"), "untracked\n");
    assert.equal(existsSync(join(fx.stable, "created.txt")), false);

    const mutation = await provider.inspect(candidate);
    assert.deepEqual(mutation.created, ["created.txt"]);
    assert.deepEqual(mutation.modified, ["src/a.txt"]);
    assert.deepEqual(mutation.deleted, ["untracked.txt"]);
    assert.equal(mutation.stableChanged, false);
    assert.ok(mutation.changedBytes >= Buffer.byteLength("candidate\n"));

    await provider.discard(candidate);
    assert.equal(existsSync(candidate.root), false);
  } finally {
    await provider.close();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("candidate snapshot rewrites internal symlinks so they resolve inside Candidate Workspace", async t => {
  if (process.platform !== "linux") { t.skip("Candidate workspace v0.1 is Linux-only."); return; }
  const fx = fixture();
  const provider = new FilesystemCandidateWorkspaceProvider(fx.candidates);
  try {
    const candidate = await provider.create(fx.stable, "exec-symlink");
    writeFileSync(join(candidate.root, "src", "alias.txt"), "via-link\n");
    assert.equal(readFileSync(join(candidate.root, "src", "a.txt"), "utf8"), "via-link\n");
    assert.equal(readFileSync(join(fx.stable, "src", "a.txt"), "utf8"), "alpha\n");
  } finally {
    await provider.close();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("candidate snapshot rejects symlinks that escape Stable Workspace", async t => {
  if (process.platform !== "linux") { t.skip("Candidate workspace v0.1 is Linux-only."); return; }
  const fx = fixture();
  const outside = join(fx.root, "outside.txt");
  writeFileSync(outside, "outside\n");
  symlinkSync(outside, join(fx.stable, "escape.txt"));
  const provider = new FilesystemCandidateWorkspaceProvider(fx.candidates);
  try {
    await assert.rejects(
      () => provider.create(fx.stable, "exec-escape"),
      /symlink escaping the workspace/,
    );
  } finally {
    await provider.close();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("candidate provider rejects storage nested inside Stable Workspace", async t => {
  if (process.platform !== "linux") { t.skip("Candidate workspace v0.1 is Linux-only."); return; }
  const fx = fixture();
  const nestedBase = join(fx.stable, ".candidate-storage");
  const provider = new FilesystemCandidateWorkspaceProvider(nestedBase);
  try {
    const capability = await provider.probe(fx.stable);
    assert.equal(capability.available, false);
    assert.match(capability.reason ?? "", /outside the stable workspace/);
    await assert.rejects(() => provider.create(fx.stable, "exec-nested"), CandidateWorkspaceError);
  } finally {
    await provider.close();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("candidate provider detects Stable Workspace drift after snapshot creation", async t => {
  if (process.platform !== "linux") { t.skip("Candidate workspace v0.1 is Linux-only."); return; }
  const fx = fixture();
  const provider = new FilesystemCandidateWorkspaceProvider(fx.candidates);
  try {
    const candidate = await provider.create(fx.stable, "exec-drift");
    writeFileSync(join(fx.stable, "src", "a.txt"), "stable-drift\n");
    const mutation = await provider.inspect(candidate);
    assert.equal(mutation.stableChanged, true);
  } finally {
    await provider.close();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("candidate discard rejects forged handles and close removes owned candidates", async t => {
  if (process.platform !== "linux") { t.skip("Candidate workspace v0.1 is Linux-only."); return; }
  const fx = fixture();
  const provider = new FilesystemCandidateWorkspaceProvider(fx.candidates);
  try {
    const candidate = await provider.create(fx.stable, "exec-owned");
    await assert.rejects(
      () => provider.discard({ ...candidate, root: fx.stable }),
      /not owned by this provider/,
    );
    assert.equal(existsSync(candidate.root), true);
    await provider.close();
    assert.equal(existsSync(candidate.root), false);
  } finally {
    await provider.close();
    rmSync(fx.root, { recursive: true, force: true });
  }
});
