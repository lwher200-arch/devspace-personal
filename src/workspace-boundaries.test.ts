import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig } from "./config.js";
import { AccessDeniedError } from "./roots.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "devspace-workspace-boundary-"));
  let store: SqliteWorkspaceStore | undefined;
  t.after(async () => {
    store?.close();
    await rm(root, { recursive: true, force: true });
  });
  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, "worktrees") },
    skills: { enabled: false, agentDir: join(root, "agent") },
    subagents: { enabled: false, providers: [] },
    logging: { level: "silent" },
  }));
  store = new SqliteWorkspaceStore(join(root, "state"));
  return { root, config, store, registry: new WorkspaceRegistry(config, store) };
}

test("foreign Windows workspace paths fail before directory or worktree creation", {
  skip: process.platform === "win32",
}, async t => {
  const { root, registry } = await fixture(t);
  const previousCwd = process.cwd();
  const entries = await readdir(root);
  process.chdir(root);
  try {
    for (const path of [
      "D:\\xm01\\WSL_System\\Eterna_Genesis",
      "d:/xm01/WSL_System/Eterna_Genesis",
      "\\\\old-computer\\projects\\Eterna_Genesis",
      "\\\\?\\D:\\projects\\Eterna_Genesis",
    ]) {
      for (const mode of ["checkout", "worktree"] as const) {
        for (const conversationScopeId of [undefined, "fixture-chat"]) {
          await assert.rejects(
            registry.openWorkspace({ path, mode }, { conversationScopeId }),
            (error: unknown) => error instanceof AccessDeniedError &&
              /Windows absolute paths/.test(error.message) &&
              /path on this computer/.test(error.message),
          );
          assert.deepEqual(await readdir(root), entries, "invalid paths must not create directories");
          assert.equal(registry.cachedWorkspaceCount, 0);
        }
      }
    }
  } finally {
    process.chdir(previousCwd);
  }
});

test("native absolute and relative workspace paths still create checkout roots", async t => {
  const { root, registry } = await fixture(t);
  const previousCwd = process.cwd();
  process.chdir(root);
  try {
    for (const path of [join(root, "absolute", "project"), "relative/project"]) {
      const opened = await registry.openWorkspace(path);
      const expectedRoot = path === "relative/project" ? join(root, "relative", "project") : path;
      assert.equal(opened.workspace.root, expectedRoot);
      assert.equal((await stat(expectedRoot)).isDirectory(), true);
      assert.equal(registry.getWorkspace(opened.workspace.id), opened.workspace);
    }
  } finally {
    process.chdir(previousCwd);
  }
});

for (const status of ["inactive", "closed"]) {
  test(status + " workspace sessions cannot be cached or restored", async t => {
    const { root, config, store, registry } = await fixture(t);
    const workspace = (await registry.openWorkspace(join(root, "project"))).workspace;
    const session = store.getSession(workspace.id)!;
    const anchor = store.getRootAnchor(workspace.id);
    const getSession = store.getSession.bind(store);
    t.mock.method(store, "getSession", (id: string) => {
      const stored = getSession(id);
      return id === workspace.id && stored ? { ...stored, status } : stored;
    });
    const touchSession = t.mock.method(store, "touchSession");

    for (const target of [registry, new WorkspaceRegistry(config, store)]) {
      assert.throws(
        () => target.getWorkspace(workspace.id),
        (error: unknown) => error instanceof AccessDeniedError &&
          /no longer active/.test(error.message) && /open_workspace/.test(error.message),
      );
      assert.equal(target.cachedWorkspaceCount, 0);
    }
    assert.equal(touchSession.mock.callCount(), 0, "rejected sessions must not be touched");
    assert.deepEqual(getSession(workspace.id), session, "session data must remain unchanged");
    assert.equal(store.getRootAnchor(workspace.id), anchor);

    const reopened = (await registry.openWorkspace(workspace.root)).workspace;
    assert.notEqual(reopened.id, workspace.id);
    assert.equal(registry.getWorkspace(reopened.id), reopened);
  });
}
