import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { projectFiles, projectRead, projectSearch } from "./project-access.js";

test("Git discovery includes tracked and new code, exposes ignored-file policy, and skips deleted paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-project-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args: string[]) => promisify(execFile)("git", args, { cwd: root, windowsHide: true });
  await git(["init"]);
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(join(root, "tracked.py"), "code\n");
  await writeFile(join(root, "deleted.py"), "code\n");
  await git(["add", "."]);
  await rm(join(root, "deleted.py"));
  await writeFile(join(root, "new.py"), "new\n");
  await writeFile(join(root, "ignored.txt"), "ignored\n");
  const result = await projectFiles(root, {});
  assert.equal(result.coverage.source, "git");
  assert.equal(result.coverage.complete, true);
  assert.deepEqual(result.files, [".gitignore", "new.py", "tracked.py"]);
  assert.ok(result.coverage.exclusions.some(item => item.includes("Git-ignored")));
  const all = await projectFiles(root, { includeIgnored: true });
  assert.ok(all.files.includes("ignored.txt"));
});

test("project file pagination covers Unicode and untracked files without dependencies or secrets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const folder of ["Core", "docs", "node_modules", ".git", ".venv"]) await mkdir(join(root, folder));
  for (const name of ["Core/main.py", "docs/\u4e2d\u6587.md", "new file.txt", ".env.example", ".env", "node_modules/x.js", ".git/config", ".venv/x.py"]) {
    await writeFile(join(root, name), "content\n");
  }
  const first = await projectFiles(root, { limit: 2 });
  const second = await projectFiles(root, { limit: 2, cursor: first.nextCursor });
  assert.equal(first.complete, false);
  assert.equal(second.complete, true);
  assert.deepEqual([...first.files, ...second.files], [".env.example", "Core/main.py", "docs/\u4e2d\u6587.md", "new file.txt"]);
  assert.equal(first.coverage.complete, true);
  await writeFile(join(root, "later.txt"), "new");
  await assert.rejects(projectFiles(root, { cursor: first.nextCursor }), /changed|stale/i);
  await assert.rejects(projectFiles(root, { cursor: "invalid" }), /cursor/i);
});

test("project reads reconstruct long Unicode lines and reject stale pages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-project-read-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = "\ufeff" + "x\ud83d\ude00\u4e2d".repeat(12000) + "\r\nlast";
  await writeFile(join(root, "large.txt"), content);
  let combined = "";
  let offset = 0;
  let sha256: string | undefined;
  while (true) {
    const page = await projectRead(root, { path: "large.txt", offset, limit: 1001, expectedSha256: sha256 });
    sha256 = page.sha256;
    combined += page.text;
    assert.ok(page.text.length <= 1001);
    assert.equal(/^[\uDC00-\uDFFF]/.test(page.text), false);
    if (page.complete) break;
    assert.ok(page.nextOffset! > offset);
    offset = page.nextOffset!;
  }
  assert.equal(combined, content);
  await writeFile(join(root, "large.txt"), "changed");
  await assert.rejects(projectRead(root, { path: "large.txt", expectedSha256: sha256 }), /changed|hash/i);
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
  await assert.rejects(projectRead(root, { path: "binary.bin" }), /binary/i);
});

test("literal search has resumable bounded pages with correct line numbers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-project-search-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "a.py"), "needle\r\nno\r\nneedle\r\n");
  await writeFile(join(root, "b.py"), "needle\n");
  const first = await projectSearch(root, { query: "needle", limit: 1 });
  assert.equal(first.matches[0].line, 1);
  const second = await projectSearch(root, { query: "needle", limit: 1, cursor: first.nextCursor });
  assert.equal(second.matches[0].line, 3);
  const third = await projectSearch(root, { query: "needle", limit: 2, cursor: second.nextCursor });
  assert.equal(third.matches[0].path, "b.py");
  assert.equal(third.complete, true);
  await assert.rejects(projectSearch(root, { query: "different", cursor: first.nextCursor }), /cursor/i);
  await writeFile(join(root, "a.py"), "changed\nneedle\n");
  await assert.rejects(projectSearch(root, { query: "needle", cursor: first.nextCursor }), /changed|stale/i);
});

test("project tools reject traversal and exclude junctions without reading outside files", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "devspace-project-boundary-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, "root");
  await mkdir(root);
  await mkdir(join(temp, "outside"));
  await writeFile(join(temp, "outside", "secret.txt"), "outside secret");
  await symlink(join(temp, "outside"), join(root, "escape"), "junction");
  const files = await projectFiles(root, {});
  assert.deepEqual(files.files, []);
  assert.ok(files.coverage.skipped.some(item => item.reason === "symlink"));
  await assert.rejects(projectRead(root, { path: "../outside/secret.txt" }));
  await assert.rejects(projectRead(root, { path: "escape/secret.txt" }));
  await assert.rejects(projectFiles(root, { path: "escape" }));
  assert.equal(await readFile(join(temp, "outside", "secret.txt"), "utf8"), "outside secret");
});
