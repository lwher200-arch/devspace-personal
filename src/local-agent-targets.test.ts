import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseLocalAgentContinueArgs,
  parseLocalAgentRunArgs,
  resolveLocalAgentPrompt,
  resolveLocalAgentTarget,
} from "./local-agent-targets.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";

const profiles: LocalAgentProfile[] = [
  {
    name: "reviewer",
    description: "Review changes.",
    provider: "codex",
    model: "gpt-5-codex",
    effort: "high",
    filePath: "/workspace/.devspace/agents/reviewer.md",
    body: "Review carefully.",
    disabled: false,
  },
  {
    name: "claude",
    description: "A profile that shadows the raw provider.",
    provider: "opencode",
    model: "qwen/custom",
    filePath: "/workspace/.devspace/agents/claude.md",
    body: "Use OpenCode.",
    disabled: false,
  },
];

assert.equal(resolveLocalAgentTarget("provider:claude", profiles)?.provider, "claude");
assert.equal(resolveLocalAgentTarget("provider:claude", profiles)?.kind, "provider");
assert.equal(resolveLocalAgentTarget("provider:codex", [{ ...profiles[0]!, name: "codex", provider: "claude" }])?.provider, "codex");

assert.deepEqual(parseLocalAgentRunArgs(["codex", "hello", "world"]), {
  target: "codex",
  prompt: "hello world",
  model: undefined,
  effort: undefined,
});

assert.deepEqual(parseLocalAgentRunArgs(["codex", "--model", "gpt-5.1", "hello"]), {
  target: "codex",
  prompt: "hello",
  model: "gpt-5.1",
  effort: undefined,
});

assert.deepEqual(parseLocalAgentRunArgs(["codex", "--model=gpt-5.1", "hello"]), {
  target: "codex",
  prompt: "hello",
  model: "gpt-5.1",
  effort: undefined,
});

assert.deepEqual(parseLocalAgentRunArgs(["codex", "--effort", "high", "hello"]), {
  target: "codex",
  prompt: "hello",
  model: undefined,
  effort: "high",
});

assert.deepEqual(parseLocalAgentRunArgs(["codex", "--effort=high", "hello"]), {
  target: "codex",
  prompt: "hello",
  model: undefined,
  effort: "high",
});

assert.throws(
  () => parseLocalAgentRunArgs(["codex", "--model"]),
  /Missing value for --model/,
);

assert.throws(
  () => parseLocalAgentRunArgs(["codex", "--effort"]),
  /Missing value for --effort/,
);

assert.throws(
  () => parseLocalAgentRunArgs(["codex", "--unknown", "hello"]),
  /Unknown option: --unknown/,
);

assert.throws(
  () => parseLocalAgentRunArgs(["codex", "--model", "--unknown", "hello"]),
  /Unknown option: --unknown/,
);

assert.deepEqual(parseLocalAgentRunArgs(["codex", "--", "--json", "literal"]), {
  target: "codex",
  prompt: "--json literal",
  model: undefined,
  effort: undefined,
});

{
  const target = resolveLocalAgentTarget("reviewer", profiles);
  assert.equal(target?.kind, "profile");
  assert.equal(target?.name, "reviewer");
  assert.equal(target?.provider, "codex");
  assert.equal(target?.model, "gpt-5-codex");
  assert.equal(target?.effort, "high");
}

{
  const target = resolveLocalAgentTarget("reviewer", profiles, "gpt-5.2", "xhigh");
  assert.equal(target?.kind, "profile");
  assert.equal(target?.model, "gpt-5.2");
  assert.equal(target?.effort, "xhigh");
}

{
  const target = resolveLocalAgentTarget("opencode", profiles);
  assert.equal(target?.kind, "provider");
  assert.equal(target?.name, "opencode");
  assert.equal(target?.provider, "opencode");
  assert.equal(target?.model, undefined);
  assert.equal(target?.effort, undefined);
}

{
  const target = resolveLocalAgentTarget("opencode", profiles, "kimi-k2", "deep");
  assert.equal(target?.kind, "provider");
  assert.equal(target?.model, "kimi-k2");
  assert.equal(target?.effort, "deep");
}

{
  const providerDefaults = [{
    id: "codex",
    enabled: true,
    model: "gpt-default",
    effort: "medium",
  }] as const;
  const raw = resolveLocalAgentTarget("codex", profiles, undefined, undefined, providerDefaults);
  assert.equal(raw?.model, "gpt-default");
  assert.equal(raw?.effort, "medium");
  const profiled = resolveLocalAgentTarget("reviewer", profiles, undefined, undefined, providerDefaults);
  assert.equal(profiled?.model, "gpt-5-codex");
  assert.equal(profiled?.effort, "high");
  const overridden = resolveLocalAgentTarget("reviewer", profiles, "gpt-run", "xhigh", providerDefaults);
  assert.equal(overridden?.model, "gpt-run");
  assert.equal(overridden?.effort, "xhigh");
}

{
  const target = resolveLocalAgentTarget("claude", profiles);
  assert.equal(target?.kind, "profile");
  assert.equal(target?.provider, "opencode");
}

assert.equal(resolveLocalAgentTarget("missing", profiles), undefined);

for (const parse of [parseLocalAgentRunArgs, parseLocalAgentContinueArgs]) {
  const separate = parse(["target", "--prompt-file", "brief.txt"]);
  assert.equal(separate.promptFile, "brief.txt");
  assert.equal(separate.prompt, "");
  assert.equal(parse(["target", "--prompt-file=brief.txt", "--effort", "high"]).effort, "high");
  assert.equal(parse(["target", "--", "--prompt-file", "literal"]).prompt, "--prompt-file literal");
  assert.throws(() => parse(["target", "--prompt-file"]), /Missing value for --prompt-file/);
  assert.throws(() => parse(["target", "--prompt-file="]), /Missing value for --prompt-file/);
  assert.throws(() => parse(["target", "--prompt-file", "--effort"]), /Unknown option/);
  assert.throws(() => parse(["target", "--prompt-file=a", "--prompt-file", "b"]), /Duplicate option/);
  assert.throws(() => parse(["target", "--prompt-file", "a", "--prompt-file=b"]), /Duplicate option/);
  assert.throws(() => parse(["target", "inline", "--prompt-file=a"]), /either an inline prompt/);
  assert.throws(() => parse(["target", "--prompt-file=a", "--", "literal"]), /either an inline prompt/);
  assert.throws(() => parse(["target", "--prompt-file=a", " "]), /either an inline prompt/);
}

const promptRoot = mkdtempSync(join(tmpdir(), "devspace-prompt-file-test-"));
try {
  const workspace = join(promptRoot, "workspace");
  const outside = join(promptRoot, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  const content = '\uFEFF  请审查 Eterna。\r\n保留 "双引号"、\'单引号\'、`反引号`。\nStability > Speed & echo no | no < no %PATH% $HOME $(no) ^ ! --json\n';
  writeFileSync(join(workspace, "中文 brief.txt"), content, "utf8");
  const readPrompt = (promptFile: string) => resolveLocalAgentPrompt({ prompt: "", promptFile }, workspace);
  assert.equal(await readPrompt("中文 brief.txt"), content);
  assert.equal(await readPrompt(join(workspace, "中文 brief.txt")), content);
  assert.equal(await resolveLocalAgentPrompt({ prompt: "existing inline" }, workspace), "existing inline");

  writeFileSync(join(workspace, "limit.txt"), Buffer.alloc(64 * 1024, 65));
  assert.equal((await readPrompt("limit.txt")).length, 64 * 1024);
  writeFileSync(join(workspace, "oversize.txt"), "中".repeat(22_000));
  await assert.rejects(readPrompt("oversize.txt"), /64 KiB limit/);
  writeFileSync(join(workspace, "blank.txt"), "\uFEFF \t\r\n");
  writeFileSync(join(workspace, "empty.txt"), "");
  await assert.rejects(readPrompt("blank.txt"), /empty or whitespace-only/);
  await assert.rejects(readPrompt("empty.txt"), /empty or whitespace-only/);
  writeFileSync(join(workspace, "invalid.txt"), Buffer.from([0xc3, 0x28]));
  await assert.rejects(readPrompt("invalid.txt"), /valid UTF-8/);
  await assert.rejects(readPrompt("missing.txt"), /Unable to open --prompt-file/);
  await assert.rejects(readPrompt("."), /regular file|Unable to open --prompt-file/);

  writeFileSync(join(outside, "private.txt"), "DO_NOT_DISCLOSE_PROMPT_CONTENT");
  for (const candidate of ["../outside/private.txt", join(outside, "private.txt")]) {
    await assert.rejects(readPrompt(candidate), (error: unknown) => {
      assert.match(String(error), /outside allowed roots/);
      assert.doesNotMatch(String(error), /DO_NOT_DISCLOSE_PROMPT_CONTENT/);
      return true;
    });
  }
  // Junctions exercise the same boundary on Windows without symlink privileges.
  symlinkSync(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readPrompt("escape/private.txt"), /outside allowed roots/);
  symlinkSync(workspace, join(workspace, "inside"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(await readPrompt("inside/中文 brief.txt"), content);
} finally {
  rmSync(promptRoot, { recursive: true, force: true });
}
