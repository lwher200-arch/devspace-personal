import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { satisfies } from "semver";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  engines: { node: string };
};

test("CLI runtime guard agrees with package engines at supported and rejected boundaries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-node-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "absent-config");
  for (const version of ["20.12.0", "22.18.9", "22.19.0", "24.21.0", "27.0.0"]) {
    // Exercise the actual entrypoint's version gate without replacing the installed Node binary.
    const code = `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });
process.argv = [process.execPath, ${JSON.stringify(cli)}, "--version"];
await import(${JSON.stringify(new URL("./cli.ts", import.meta.url).href)});`;
    const invocation = execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      env: { ...process.env, DEVSPACE_CONFIG_DIR: configDir }, timeout: 15_000,
    });
    if (satisfies(version, manifest.engines.node)) {
      const { stdout } = await invocation;
      assert.equal(stdout.trim(), manifest.version, version);
    } else {
      await assert.rejects(invocation, (error: unknown) => {
        const failure = error as { code?: unknown; stderr?: string };
        assert.equal(failure.code, 1, version);
        assert.ok(failure.stderr?.includes(`DevSpace requires Node ${manifest.engines.node}.`), version);
        return true;
      });
    }
  }
  assert.equal(existsSync(configDir), false, "version checks must not initialize configuration");
});

test("doctor reports the same Node engine range as installation and deployment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-node-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { stdout } = await execute(process.execPath, ["--import", "tsx", cli, "doctor"], {
    env: { ...process.env, DEVSPACE_CONFIG_DIR: join(root, "config") }, timeout: 15_000,
  });
  assert.ok(stdout.includes(`Node: ${process.version} (supported ${manifest.engines.node})`));
});
