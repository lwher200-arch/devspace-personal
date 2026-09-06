import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { unlinkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { assertAllowedPath } from "./roots.js";
import { readFileTool, writeFileTool, editFileTool } from "./pi-tools.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { loadConfig } from "./config.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

test("filesystem boundaries reject junction escapes and retain legitimate reads, edits and images", async () => {
  const temp = await mkdtemp(join(tmpdir(), "devspace-boundary-"));
  const root = join(temp, "root");
  const outside = join(temp, "outside");
  const link = join(root, "escape");
  const internal = join(root, "alias");
  const normalizedLink = join(root, "cafe\u0301");
  await mkdir(root); await mkdir(outside); await mkdir(join(root, "real"));
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(outside, link, "junction");
  await symlink(join(root, "real"), internal, "junction");
  await symlink(outside, normalizedLink, "junction");
  const context = { cwd: root, root };
  try {
    assert.throws(() => assertAllowedPath(join(link, "new", "file"), [root]), /outside allowed/);
    await assert.rejects(readFileTool({ path: "escape/secret.txt" }, context), /outside allowed/);
    await assert.rejects(writeFileTool({ path: "escape/secret.txt", content: "bad" }, context), /outside allowed/);
    await assert.rejects(editFileTool({ path: "escape/secret.txt", edits: [{ oldText: "secret", newText: "bad" }] }, context), /outside allowed/);
    assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "secret");
    const normalizedRead = await readFileTool({ path: "caf\u00e9/secret.txt" }, context);
    assert.equal(normalizedRead.isError, true);
    assert.match(JSON.stringify(normalizedRead), /outside allowed/);
    assert.equal((await writeFileTool({ path: "alias/new/file.txt", content: "hello" }, context)).isError, undefined);
    assert.equal((await editFileTool({ path: "alias/new/file.txt", edits: [{ oldText: "hello", newText: "updated" }] }, context)).isError, undefined);
    assert.match(JSON.stringify(await readFileTool({ path: "alias/new/file.txt" }, context)), /updated/);
    await writeFile(join(root, "tiny.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64"));
    const image = await readFileTool({ path: "tiny.png" }, context);
    assert.match(JSON.stringify(image), /image\/png/);
    assert.notEqual(image.isError, true);
    const original = await createReadTool(root).execute("image-control", { path: "tiny.png" });
    assert.deepEqual(image.content, original.content);
    await rm(outside, { recursive: true });
    assert.throws(() => assertAllowedPath(join(link, "new"), [root]));
  } finally {
    await rm(link, { force: true }); await rm(internal, { force: true });
    await rm(normalizedLink, { force: true });
    await rm(temp, { recursive: true, force: true });
  }
});

test("cached workspaces reject a root junction retargeted after opening", async () => {
  const temp = await mkdtemp(join(tmpdir(), "devspace-root-anchor-"));
  const first = join(temp, "first"); const second = join(temp, "second"); const root = join(temp, "alias");
  await mkdir(first); await mkdir(second); await symlink(first, root, "junction");
  await writeFile(join(first, "data.txt"), "inside");
  await writeFile(join(second, "data.txt"), "outside-marker");
  const store = new SqliteWorkspaceStore(join(temp, "state"));
  try {
    const config = loadConfig(writeTestDevspaceConfig(join(temp, "config"), {
      workspaces: { allowedRoots: [root] }, skills: { agentDir: join(temp, "agent") },
    }));
    const registry = new WorkspaceRegistry(config, store);
    const { workspace } = await registry.openWorkspace(root);
    assert.equal(registry.getWorkspace(workspace.id).root, root);
    const pendingRead = readFileTool({ path: "data.txt" }, { cwd: root, root });
    unlinkSync(root); symlinkSync(second, root, "junction");
    const result = await pendingRead;
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /outside-marker/);
    assert.throws(() => registry.getWorkspace(workspace.id), /changed its filesystem target/);
    assert.throws(() => new WorkspaceRegistry(config, store).getWorkspace(workspace.id), /Stored workspace root/);
  } finally { store.close(); await rm(root, { force: true }); await rm(temp, { recursive: true, force: true }); }
});
