import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LocalAgentClient } from "./local-agent-client.js";

const root = await mkdtemp(join(tmpdir(), "devspace-daemon-startup-test-"));
const configDir = join(root, "config");
const stateDir = join(root, "state");
const guardPath = join(root, "unavailable-pi.mjs");
let child: ChildProcess | undefined;
let childExit: Promise<unknown> | undefined;
let stderr = "";
let exitTimer: NodeJS.Timeout | undefined;

try {
  await mkdir(configDir);
  await writeFile(join(configDir, "config.jsonc"), JSON.stringify({
    configVersion: 1,
    storage: { stateDir },
    workspaces: { allowedRoots: [root] },
    subagents: { enabled: true, providers: [{ id: "codex", enabled: true }] },
  }));
  // A non-Pi daemon must work even if optional Pi dependencies cannot load.
  // This catches eager imports deterministically without a tight timing test.
  await writeFile(guardPath, `
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === "@earendil-works/pi-coding-agent" || specifier === "@anthropic-ai/sandbox-runtime") {
        throw new Error("Pi dependencies must not load before a Pi session is requested");
      }
      return nextResolve(specifier, context);
    }});
  `);
  const client = new LocalAgentClient({
    configDir,
    stateDir,
    // Source transpilation varies across CI hosts; the dependency guard, not
    // a wall-clock threshold, verifies this startup regression.
    startupTimeoutMs: 30_000,
    spawnDaemon: () => {
      child = spawn(process.execPath, [
        "--import", import.meta.resolve("tsx"),
        "--import", pathToFileURL(guardPath).href,
        fileURLToPath(new URL("./local-agent-daemon-main.ts", import.meta.url)),
      ], {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          DEVSPACE_CONFIG_DIR: configDir,
          DEVSPACE_OAUTH_OWNER_TOKEN: "isolated-daemon-startup-test-only",
          DEVSPACE_AGENTD_IDLE_TIMEOUT_MS: "60000",
        },
      });
      child.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });
      childExit = once(child, "exit");
    },
  });
  const ready = await client.ensureReady();
  assert.equal(ready.isOk(), true, `real daemon failed to start: ${stderr}`);
  if (ready.isErr()) throw ready.error;
  assert.equal(ready.value.state, "ready");
  assert.equal(ready.value.activeTurns, 0);
  assert.equal(ready.value.runtimeCount, 0);
  const records = await client.list({ workspaceId: "ws_startup", workspaceRoot: root });
  assert.equal(records.isOk(), true);
  if (records.isOk()) assert.deepEqual(records.value, []);
  assert.equal((await client.stop()).isOk(), true);
  await Promise.race([
    childExit,
    new Promise<never>((_, reject) => {
      exitTimer = setTimeout(() => reject(new Error("test daemon did not stop")), 10_000);
    }),
  ]);
  assert.equal(child?.exitCode, 0, stderr);
} finally {
  if (exitTimer) clearTimeout(exitTimer);
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await childExit;
  }
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  await rm(root, { recursive: true, force: true });
}
