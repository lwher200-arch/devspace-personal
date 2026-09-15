import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createPiSandboxModeRef, createPiSandboxSessionResources } from "./local-agent-pi-sandbox.js";
import { piToolsForWriteMode } from "./local-agent-pi.js";

for (const mode of ["read_only", "allowed"] as const) {
  test(`actual Pi ${mode} session uses workspace guards and excludes disk resources`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "devspace-pi-session-tools-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace"), agentDir = join(root, "agent"), outside = join(root, "outside");
    await Promise.all([workspace, agentDir, outside].map(path => mkdir(path)));
    await writeFile(join(workspace, "inside.txt"), "inside-fixture");
    await writeFile(join(outside, "outside.txt"), "outside-fixture");
    await symlink(outside, join(workspace, "outside-link"), process.platform === "win32" ? "junction" : "dir");
    const marker = join(root, "extension-executed");
    for (const base of [join(workspace, ".pi"), agentDir]) {
      await mkdir(join(base, "extensions"), { recursive: true });
      await mkdir(join(base, "skills", "untrusted"), { recursive: true });
      await writeFile(join(base, "extensions", "untrusted.mjs"),
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); export default () => {};`);
      await writeFile(join(base, "skills", "untrusted", "SKILL.md"), "---\nname: untrusted\ndescription: fixture\n---\nUNAUTHORIZED_RESOURCE\n");
      await writeFile(join(base, "SYSTEM.md"), "UNAUTHORIZED_RESOURCE");
      await writeFile(join(base, "settings.json"), JSON.stringify({ extensions: ["extensions/untrusted.mjs"] }));
    }
    await writeFile(join(workspace, "AGENTS.md"), "UNAUTHORIZED_RESOURCE");
    await writeFile(join(agentDir, "auth.json"), "{}\n");
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: join(agentDir, "model-cache"), allowModelNetwork: false });
    const modeRef = createPiSandboxModeRef(mode);
    const resources = createPiSandboxSessionResources(workspace, modeRef);
    await resources.resourceLoader.reload();
    assert.deepEqual(resources.resourceLoader.getSkills().skills, []);
    assert.deepEqual(resources.resourceLoader.getAgentsFiles().agentsFiles, []);
    assert.equal(resources.resourceLoader.getSystemPrompt(), undefined);
    const { session } = await createAgentSession({ cwd: workspace, agentDir, modelRuntime, ...resources,
      settingsManager: SettingsManager.create(workspace, agentDir), sessionManager: SessionManager.inMemory(workspace),
      model: { id: "fixture-model", name: "Fixture", provider: "fixture", api: "openai-completions",
        baseUrl: "https://model.invalid", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 },
      tools: [...piToolsForWriteMode(mode)] });
    t.after(() => session.dispose());
    assert.equal(existsSync(marker), false, "project and global extensions must never execute");
    assert.doesNotMatch(session.agent.state.systemPrompt, /UNAUTHORIZED_RESOURCE/);
    const tools = session.agent.state.tools;
    const read = tools.find(tool => tool.name === "read");
    assert.ok(read);
    const result = await read.execute("inside", { path: join(workspace, "inside.txt") });
    assert.match(JSON.stringify(result), /inside-fixture/);
    for (const path of [join(outside, "outside.txt"), join(workspace, "outside-link", "outside.txt")]) {
      await assert.rejects(async () => read.execute("outside", { path }), /outside|not allowed/i);
    }
    if (mode === "allowed") {
      const write = tools.find(tool => tool.name === "write");
      assert.ok(write);
      await write.execute("inside-write", { path: join(workspace, "written.txt"), content: "written" });
      assert.equal(await readFile(join(workspace, "written.txt"), "utf8"), "written");
      await assert.rejects(async () => write.execute("outside-write", { path: join(outside, "blocked.txt"), content: "blocked" }), /outside|not allowed/i);
      assert.equal(existsSync(join(outside, "blocked.txt")), false);
      modeRef.value = "read_only";
      await assert.rejects(async () => write.execute("late-write", { path: join(workspace, "late.txt"), content: "blocked" }), /read.only/i);
    } else {
      assert.equal(tools.some(tool => ["write", "edit", "bash"].includes(tool.name)), false);
    }
    assert.equal(session.messages.length, 0, "direct tool checks do not invoke a model");
  });
}
