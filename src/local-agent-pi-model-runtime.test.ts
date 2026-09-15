import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("Pi cold runtime preserves native auth/model files and rejects unknown models without fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-pi-model-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "pi-agent"), workspace = join(root, "project");
  await mkdir(agentDir); await mkdir(workspace);
  const auth = "{}\n", models = '{"providers":{}}\n';
  await writeFile(join(agentDir, "auth.json"), auth);
  await writeFile(join(agentDir, "models.json"), models);
  const code = `import { PiLocalAgentDriver } from ${JSON.stringify(new URL("./local-agent-pi.ts", import.meta.url).href)};
const result = await new PiLocalAgentDriver().createRuntime({ agentId: "model-path-fixture", provider: "pi",
 workspaceRoot: ${JSON.stringify(workspace)}, model: "missing-provider/missing-model", writeMode: "read_only" });
if (result.isOk()) { await result.value.close(); throw new Error("Unknown model unexpectedly selected a fallback"); }
console.log(JSON.stringify({ code: result.error.code, retryable: result.error.retryable, message: result.error.message }));`;
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "LD_LIBRARY_PATH", "LANG"].includes(key)));
  const { stdout } = await execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    env: { ...inherited, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"), CODEX_HOME: join(root, "codex"),
      DEVSPACE_CONFIG_DIR: join(root, "devspace"), PI_CODING_AGENT_DIR: agentDir }, timeout: 30_000,
  });
  const error = JSON.parse(stdout.trim());
  assert.equal(error.code, "PROVIDER_PROTOCOL_ERROR");
  assert.equal(error.retryable, false);
  assert.match(error.message, /missing-provider\/missing-model/);
  assert.equal(await readFile(join(agentDir, "auth.json"), "utf8"), auth);
  assert.equal(await readFile(join(agentDir, "models.json"), "utf8"), models);
});
