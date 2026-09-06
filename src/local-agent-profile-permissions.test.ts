import assert from "node:assert/strict";
import { Result } from "better-result";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { LocalAgentManager } from "./local-agent-manager.js";
import { loadLocalAgentProfiles, type LocalAgentProfile } from "./local-agent-profiles.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import type { LocalAgentDriver, LocalAgentRunInput, LocalAgentRuntimeContext } from "./local-agent-runtime.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

test("profile authority reaches runtime acquisition and every started or continued turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-profile-authority-"));
  const scope = { workspaceRoot: root, workspaceId: "ws_authority" };
  const configDir = join(root, "config");
  const profileDir = join(root, ".devspace", "agents");
  await mkdir(profileDir, { recursive: true });
  const config = loadConfig(writeTestDevspaceConfig(configDir, {
    workspaces: { allowedRoots: [root] },
    subagents: { enabled: true, providers: [{ id: "codex", enabled: true }] },
  }));
  const contexts: LocalAgentRuntimeContext[] = [];
  const inputs: LocalAgentRunInput[] = [];
  const driver: LocalAgentDriver = {
    provider: "codex",
    runtimeKey: (context) => {
      contexts.push({ ...context });
      return context.agentId;
    },
    createRuntime: async () => {
      let alive = true;
      return Result.ok({
        provider: "codex" as const,
        run: async (input: LocalAgentRunInput) => {
          inputs.push({ ...input });
          return Result.ok({
            provider: "codex" as const, providerSessionId: "session-authority",
            finalResponse: "Inspected.", items: [],
          });
        },
        releaseSession: async () => {},
        isAlive: () => alive,
        close: async () => { alive = false; },
      });
    },
  };
  const store = new LocalAgentStore(join(root, "state"));
  const manager = new LocalAgentManager({
    store, drivers: [driver], pool: new LocalAgentRuntimePool(),
    loadProfiles: (workspaceRoot) => loadLocalAgentProfiles(config, workspaceRoot),
    allowedRoots: [root], subagents: config.subagents,
  });
  const modes = [undefined, "read_only", "allowed", "full_access"] as const;
  const policies = [
    { ceiling: undefined, expected: ["allowed", "read_only", "allowed", "full_access"] },
    { ceiling: "read_only", expected: ["read_only", "read_only", "read_only", "read_only"] },
    { ceiling: "allowed", expected: ["allowed", "read_only", "allowed", "allowed"] },
  ] as const;
  const waitForIdle = async (id: string, recordStore = store) => {
    const deadline = Date.now() + 5_000;
    while (recordStore.getById(id)?.status === "running" && Date.now() < deadline) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(recordStore.getById(id)?.status, "idle", recordStore.getById(id)?.error);
  };
  const writeProfile = async (name: string, ceiling?: LocalAgentProfile["writeMode"]) => {
    await writeFile(join(profileDir, `${name}.md`), [
      "---", `name: ${name}`, "description: Inspect project.", "provider: codex",
      ...(ceiling === undefined ? [] : [`writeMode: ${ceiling}`]), "---", "Review only.",
    ].join("\n"));
  };
  try {
    for (const { ceiling, expected } of policies) {
      const name = `reviewer-${ceiling ?? "legacy"}`;
      await writeProfile(name, ceiling);
      for (const [index, requested] of modes.entries()) {
        const started = await manager.start({ target: name, prompt: "inspect", ...scope, writeMode: requested });
        if (started.isErr()) throw started.error;
        const id = started.value.id;
        assert.equal(started.value.profileName, name, "ordinary durable target names remain unchanged");
        await waitForIdle(id);
        assert.equal(inputs.at(-1)?.writeMode, expected[index]);
        assert.equal(contexts.at(-1)?.writeMode, expected[index]);
        for (const [continuedIndex, continuedMode] of modes.entries()) {
          const continued = await manager.continue(id, "inspect again", { writeMode: continuedMode }, scope);
          if (continued.isErr()) throw continued.error;
          await waitForIdle(id);
          assert.equal(inputs.at(-1)?.providerSessionId, "session-authority");
          assert.equal(inputs.at(-1)?.writeMode, expected[continuedIndex]);
          assert.equal(contexts.at(-1)?.writeMode, expected[continuedIndex]);
        }
      }
    }

    // Policy comes from the current profile, not a duplicated persisted mode.
    await writeProfile("tightened", "allowed");
    const initial = await manager.start({ target: "tightened", prompt: "inspect", ...scope });
    if (initial.isErr()) throw initial.error;
    await waitForIdle(initial.value.id);
    await writeProfile("tightened", "read_only");
    const tightened = await manager.continue(initial.value.id, "inspect again", { writeMode: "full_access" }, scope);
    if (tightened.isErr()) throw tightened.error;
    await waitForIdle(initial.value.id);
    assert.equal(inputs.at(-1)?.writeMode, "read_only");

    // Old durable records have no authority field and still receive current policy.
    const old = store.create({ ...scope, provider: "codex", profileName: "tightened" });
    store.update(old.id, { status: "idle", providerSessionId: "old-session" });
    const oldContinued = await manager.continue(old.id, "inspect old session", { writeMode: "allowed" }, scope);
    if (oldContinued.isErr()) throw oldContinued.error;
    await waitForIdle(old.id);
    assert.equal(inputs.at(-1)?.writeMode, "read_only");
    assert.equal(inputs.at(-1)?.providerSessionId, "old-session");

    // A same-named profile must not become the raw provider on start or resume.
    await writeProfile("codex", "read_only");
    const collision = await manager.start({ target: "codex", prompt: "inspect", ...scope, writeMode: "full_access" });
    if (collision.isErr()) throw collision.error;
    assert.equal(collision.value.profileName, "profile:codex");
    await waitForIdle(collision.value.id);
    assert.equal(inputs.at(-1)?.writeMode, "read_only");
    const collisionContinued = await manager.continue(collision.value.id, "inspect again", { writeMode: "allowed" }, scope);
    if (collisionContinued.isErr()) throw collisionContinued.error;
    await waitForIdle(collision.value.id);
    assert.equal(inputs.at(-1)?.writeMode, "read_only");

    const explicit = await manager.start({ target: "provider:codex", prompt: "raw provider", ...scope, writeMode: "allowed" });
    if (explicit.isErr()) throw explicit.error;
    assert.equal(explicit.value.profileName, "provider:codex");
    await waitForIdle(explicit.value.id);
    assert.equal(inputs.at(-1)?.writeMode, "allowed");
    const explicitContinued = await manager.continue(explicit.value.id, "raw again", {}, scope);
    if (explicitContinued.isErr()) throw explicitContinued.error;
    await waitForIdle(explicit.value.id);
    assert.equal(inputs.at(-1)?.writeMode, "allowed");
    assert.equal(inputs.at(-1)?.prompt, "raw again", "explicit provider does not inherit a same-named profile body");

    const ambiguous = store.create({ ...scope, provider: "codex", profileName: "codex" });
    store.update(ambiguous.id, { status: "idle", latestResponse: "Preserved old response." });
    const callCount = inputs.length;
    const rejected = await manager.continue(ambiguous.id, "must not run", { writeMode: "full_access" }, scope);
    assert.equal(rejected.isErr(), true);
    if (rejected.isErr()) assert.equal(rejected.error.code, "TARGET_RESOLUTION_FAILED");
    assert.equal(store.getById(ambiguous.id)?.latestResponse, "Preserved old response.");
    assert.equal(inputs.length, callCount);

    await writeFile(join(profileDir, "reserved-name.md"), [
      "---", "name: profile:codex", "description: Colliding target tag.", "provider: codex",
      "writeMode: read_only", "---", "Inspect only.",
    ].join("\n"));
    const reserved = await manager.start({ target: "profile:codex", prompt: "must not be reinterpreted", ...scope, writeMode: "full_access" });
    if (reserved.isErr()) throw reserved.error;
    const deadline = Date.now() + 5_000;
    while (store.getById(reserved.value.id)?.status === "running" && Date.now() < deadline) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(store.getById(reserved.value.id)?.errorCode, "TARGET_RESOLUTION_FAILED");
    assert.equal(inputs.length, callCount, "a literal profile name must not impersonate an internal target tag");

    await rm(join(profileDir, "reserved-name.md"));
    await rm(join(profileDir, "codex.md"));
    const removed = await manager.continue(collision.value.id, "must not become raw", {}, scope);
    assert.equal(removed.isErr(), true);
    if (removed.isErr()) assert.equal(removed.error.code, "UNKNOWN_TARGET");
    assert.equal(inputs.length, callCount);

    // A live project's actual profile can be checked without committing an absolute path.
    if (process.env.DEVSPACE_TEST_AGENT_PROFILE) {
      const profileText = await readFile(process.env.DEVSPACE_TEST_AGENT_PROFILE, "utf8");
      await writeFile(join(profileDir, "actual-project-reviewer.md"), profileText);
      const projectProfiles = await loadLocalAgentProfiles(config, root);
      const actual = projectProfiles.find((profile) => profile.filePath.endsWith("actual-project-reviewer.md"));
      assert.ok(actual);
      assert.equal(actual.writeMode, "read_only");
      const projectRun = await manager.start({ target: actual.name, prompt: "inspect project contract", ...scope, writeMode: "full_access" });
      if (projectRun.isErr()) throw projectRun.error;
      await waitForIdle(projectRun.value.id);
      assert.equal(inputs.at(-1)?.writeMode, "read_only");
      assert.equal(contexts.at(-1)?.writeMode, "read_only");
      assert.ok(inputs.at(-1)?.prompt.startsWith(actual.body));
    }

    await manager.close();
    const reopenedStore = new LocalAgentStore(join(root, "state"));
    const reopened = new LocalAgentManager({
      store: reopenedStore, drivers: [driver], pool: new LocalAgentRuntimePool(),
      loadProfiles: (workspaceRoot) => loadLocalAgentProfiles(config, workspaceRoot),
      allowedRoots: [root], subagents: config.subagents,
    });
    try {
      const resumed = await reopened.continue(old.id, "after restart", { writeMode: "full_access" }, scope);
      if (resumed.isErr()) throw resumed.error;
      await waitForIdle(old.id, reopenedStore);
      assert.equal(inputs.at(-1)?.writeMode, "read_only");
      assert.equal(inputs.at(-1)?.providerSessionId, "session-authority");
    } finally {
      await reopened.close();
    }
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});
