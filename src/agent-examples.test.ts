import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadConfig } from "./config.js";
import { loadLocalAgentProfiles } from "./local-agent-profiles.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

test("bundled review examples enforce readonly authority and Codex examples use approved model IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-example-contract-"));
  try {
    const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
      workspaces: { allowedRoots: [root] }, skills: { enabled: false, agentDir: join(root, "agent") },
      subagents: { enabled: true, providers: [] },
    }));
    config.devspaceAgentsDir = fileURLToPath(new URL('../examples/agents', import.meta.url));
    const profiles = await loadLocalAgentProfiles(config, root);
    for (const name of ['codex-explorer', 'codex-qa-tester', 'copilot-reviewer', 'opencode-explorer', 'pi-reviewer']) {
      const profile = profiles.find(profile => profile.name === name);
      assert.ok(profile, `Missing example ${name}`);
      assert.equal(profile.writeMode, 'read_only', `${name} must not rely on prose for permissions`);
    }
    for (const profile of profiles.filter(profile => profile.provider === 'codex')) {
      assert.ok(['gpt-6-astra', 'gpt-5.6-sol'].includes(profile.model ?? ''), `Unapproved Codex example model in ${profile.name}`);
    }
  } finally {
    assert.equal(dirname(await realpath(root)), await realpath(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});
