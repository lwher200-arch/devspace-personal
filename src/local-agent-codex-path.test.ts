import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { codexCommandEnvironment, resolveCodexCommand } from "./local-agent-codex.js";
import { assertLocalAgentProviderAvailable } from "./local-agent-availability.js";

import { normalizeCommandPathEnvironment } from "./local-agent-path.js";

const windowsOnly = { skip: process.platform !== "win32" };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "devspace-codex-path-test-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "codex.cmd"), "@echo codex-cli 9.8.7\r\n");
  await writeFile(join(bin, "codex.bat"), "@echo codex-cli 8.7.6\r\n");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !["PATH", "PATHEXT", "CODEX_COMMAND"].includes(key.toUpperCase())));
  return { root, bin, env, close: () => rm(root, { recursive: true, force: true }) };
}

test("Windows resolves copied PATH/Path/path and PATHEXT variants using the same child environment", windowsOnly, async () => {
  const f = await fixture();
  try {
    for (const pathKey of ["PATH", "Path", "path"]) {
      for (const extensionKey of ["PATHEXT", "PathExt", "pathext"]) {
        const env = { ...f.env, [pathKey]: f.bin, [extensionKey]: ".CMD;.BAT" };
        const before = { ...env };
        assert.deepEqual(resolveCodexCommand(env), {
          executable: join(f.bin, "codex.CMD"), version: "9.8.7",
        }, `${pathKey}/${extensionKey} must preserve custom extension order`);
        assert.doesNotThrow(() => assertLocalAgentProviderAvailable("codex", env));
        assert.deepEqual(env, before, "resolution must not mutate the caller environment");
      }
    }
  } finally { await f.close(); }
});

test("Windows explicit command still bypasses PATH and failed candidates are skipped", windowsOnly, async () => {
  const f = await fixture();
  try {
    const badBin = join(f.root, "bad-bin");
    await mkdir(badBin);
    await writeFile(join(badBin, "codex.cmd"), "@exit /b 1\r\n");
    const env = { ...f.env, Path: [badBin, f.bin].join(delimiter), PathExt: ".CMD" };
    assert.deepEqual(resolveCodexCommand(env), { executable: join(f.bin, "codex.CMD"), version: "9.8.7" });
    const explicit = { ...env, Path: badBin, CODEX_COMMAND: join(f.bin, "codex.cmd") };
    assert.deepEqual(resolveCodexCommand(explicit), { executable: explicit.CODEX_COMMAND, version: "9.8.7" });
    assert.doesNotThrow(() => assertLocalAgentProviderAvailable("codex", explicit));
  } finally { await f.close(); }
});

test("Windows command environment filters DevSpace shadow executables regardless of PATH casing", windowsOnly, async () => {
  const f = await fixture();
  try {
    const project = join(f.root, "devspace");
    const shadow = join(project, "node_modules", ".bin");
    await mkdir(shadow, { recursive: true });
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "@waishnav/devspace" }));
    await writeFile(join(shadow, "codex.cmd"), "@echo codex-cli 0.0.1\r\n");
    const env = { ...f.env, Path: [shadow, f.bin].join(delimiter), PathExt: ".CMD", CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "test" };
    const prepared = codexCommandEnvironment(env);
    assert.equal(prepared.PATH, f.bin);
    assert.equal(prepared.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, undefined);
    assert.deepEqual(resolveCodexCommand(env), { executable: join(f.bin, "codex.CMD"), version: "9.8.7" });
    const explicit = { ...env, CODEX_COMMAND: join(shadow, "codex.cmd") };
    assert.equal(codexCommandEnvironment(explicit).PATH, env.Path, "explicit command preserves the user's PATH");
    assert.deepEqual(resolveCodexCommand(explicit), { executable: explicit.CODEX_COMMAND, version: "0.0.1" });
  } finally { await f.close(); }
});

test("Windows ambiguous PATH aliases follow child_process lexicographic precedence", windowsOnly, async () => {
  const f = await fixture();
  try {
    const env = { ...f.env, path: join(f.root, "missing"), Path: join(f.root, "also-missing"), PATH: f.bin, PathExt: ".BAT", PATHEXT: ".CMD" };
    const prepared = codexCommandEnvironment(env);
    assert.deepEqual(Object.keys(prepared).filter(key => key.toUpperCase() === "PATH"), ["PATH"]);
    assert.deepEqual(Object.keys(prepared).filter(key => key.toUpperCase() === "PATHEXT"), ["PATHEXT"]);
    assert.deepEqual(resolveCodexCommand(env), { executable: join(f.bin, "codex.CMD"), version: "9.8.7" });
  } finally { await f.close(); }
});

test("command path normalization preserves case-sensitive platforms and the input", () => {
  const env = { PATH: "/bin", Path: "/custom", PATHEXT: ".CMD", pathext: ".BAT", unrelated: "keep" };
  const snapshot = { ...env };
  for (const platform of ["linux", "darwin"] as const) {
    const result = normalizeCommandPathEnvironment(env, platform);
    assert.deepEqual(result, env);
    assert.notEqual(result, env);
  }
  assert.deepEqual(env, snapshot);
});

test("Windows normalization follows child-process precedence even for empty or undefined values", () => {
  assert.deepEqual(normalizeCommandPathEnvironment({ Path: "bin", PathExt: ".CMD", other: "value" }, "win32"), {
    PATH: "bin", PATHEXT: ".CMD", other: "value",
  });
  assert.deepEqual(normalizeCommandPathEnvironment({ PATH: undefined, Path: "ignored", PATHEXT: "", PathExt: ".CMD" }, "win32"), {
    PATH: undefined, PATHEXT: "",
  });
  assert.deepEqual(normalizeCommandPathEnvironment({}, "win32"), {});
});
