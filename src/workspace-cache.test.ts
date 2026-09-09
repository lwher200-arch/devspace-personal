import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig } from "./config.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "devspace-workspace-cache-"));
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "AGENTS.md"), "Cache fixture instructions.\n");
  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    workspaces: { allowedRoots: [root] }, skills: { enabled: false, agentDir: join(root, "agent") },
    logging: { level: "silent" },
  }));
  const store = new SqliteWorkspaceStore(join(root, "state"));
  t.after(async () => {
    store.close();
    assert.equal(dirname(await realpath(root)), await realpath(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, project, config, store, registry: new WorkspaceRegistry(config, store) };
}

test("persistent workspace cache evicts the least recently used entry without deleting its record", async t => {
  const { registry, store, project } = await fixture(t);
  const first = (await registry.openWorkspace(project)).workspace;
  const second = (await registry.openWorkspace(project)).workspace;
  for (let i = 0; i < 30; i++) await registry.openWorkspace(project);
  assert.equal(registry.getWorkspace(first.id), first);
  await registry.openWorkspace(project);
  assert.equal(registry.getWorkspace(first.id), first, "a cache hit must update recency");
  const restored = registry.getWorkspace(second.id);
  assert.notEqual(restored, second, "the least recently used object must have been evicted");
  assert.equal(restored.id, second.id);
  assert.equal(restored.root, second.root);
  assert.ok(store.getSession(second.id));
  assert.ok(store.getRootAnchor(second.id));
  assert.equal(registry.cachedWorkspaceCount, 32);
});

test("evicted conversation context restores the same identity with conservative skill activation", async t => {
  const { registry, project } = await fixture(t);
  const first = await registry.openWorkspace(project, { conversationScopeId: "fixture-chat" });
  first.workspace.activatedSkillDirs.add("fixture-activated-skill");
  for (let i = 0; i < 32; i++) await registry.openWorkspace(project);
  const restored = await registry.openWorkspace(project, { conversationScopeId: "fixture-chat", refreshContext: true });
  assert.notEqual(restored.workspace, first.workspace);
  assert.equal(restored.workspace.id, first.workspace.id);
  assert.equal(restored.workspaceReused, true);
  assert.equal(restored.includeBootstrapContext, true);
  assert.deepEqual(restored.agentsFiles, first.agentsFiles);
  assert.equal(restored.workspace.activatedSkillDirs.size, 0, "restoration must not invent external skill-file access");
  assert.equal(registry.cachedWorkspaceCount, 32);
});

test("eviction cannot re-anchor a retargeted directory junction", async t => {
  const { registry, root, project } = await fixture(t);
  const second = join(root, "second");
  const alias = join(root, "alias");
  await mkdir(second);
  await symlink(project, alias, "junction");
  const first = (await registry.openWorkspace(alias)).workspace;
  for (let i = 0; i < 32; i++) await registry.openWorkspace(project);
  await unlink(alias);
  await symlink(second, alias, "junction");
  assert.throws(() => registry.getWorkspace(first.id), /Stored workspace root/);
  assert.equal(registry.cachedWorkspaceCount, 32);
});

test("failed anchor persistence cannot leave an authoritative cache entry", async t => {
  const { registry, store, project } = await fixture(t);
  let id = "";
  t.mock.method(store, "setRootAnchor", (workspaceId: string) => { id = workspaceId; throw Error("fixture anchor failure"); });
  await assert.rejects(registry.openWorkspace(project), /fixture anchor failure/);
  assert.ok(id);
  assert.throws(() => registry.getWorkspace(id), /no verified anchor/);
  assert.equal(registry.cachedWorkspaceCount, 0);
});

test("a registry without durable anchors retains its existing in-memory behavior", async t => {
  const { config, project } = await fixture(t);
  const registry = new WorkspaceRegistry(config);
  const first = (await registry.openWorkspace(project)).workspace;
  for (let i = 0; i < 33; i++) await registry.openWorkspace(project);
  assert.equal(registry.getWorkspace(first.id), first);
  assert.equal(registry.cachedWorkspaceCount, 34);
});

test("legacy store adapters without anchor methods are not evicted", async t => {
  const { config, project, store } = await fixture(t);
  const legacy = new Proxy(store, {
    get(target, property) {
      if (property === "getRootAnchor" || property === "setRootAnchor") return undefined;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const registry = new WorkspaceRegistry(config, legacy);
  const first = (await registry.openWorkspace(project)).workspace;
  for (let i = 0; i < 33; i++) await registry.openWorkspace(project);
  assert.equal(registry.getWorkspace(first.id), first);
  assert.equal(registry.cachedWorkspaceCount, 34);
});
