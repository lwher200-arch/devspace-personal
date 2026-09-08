import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { parseLocalSetupPort, parseLocalSetupRoots } from "./onboarding.js";
import { loadConfig } from "./config.js";
import { writeDevspaceConfig, writeDevspaceAuth, acquireInitializationLock } from "./user-config.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const tsx = import.meta.resolve("tsx");

test("local setup validates explicit roots and ports", t => {
  const root = mkdtempSync(join(tmpdir(), "devspace-local-input-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(parseLocalSetupRoots(`${root}, ${root}`), [root]);
  assert.throws(() => parseLocalSetupRoots(""));
  assert.throws(() => parseLocalSetupRoots(join(root, "missing")));
  for (const value of ["0", "65536", "1e3", "abc", ""]) assert.throws(() => parseLocalSetupPort(value));
  assert.equal(parseLocalSetupPort(" 8787 "), 8787);
});

for (const mode of ["fresh", "environment", "invalid-environment", "existing", "cancelled", "partial", "locked"] as const) {
  test(`real CLI local initialization: ${mode}`, async t => {
    const root = mkdtempSync(join(tmpdir(), "devspace-local-init-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const project = join(root, "workspace"); mkdirSync(project);
    const configDir = join(root, "config");
    const env: NodeJS.ProcessEnv = { ...process.env, DEVSPACE_CONFIG_DIR: configDir };
    delete env.DEVSPACE_OAUTH_OWNER_TOKEN;
    if (mode === "environment") env.DEVSPACE_OAUTH_OWNER_TOKEN = "fixture-env-owner-preserve-long-enough";
    if (mode === "invalid-environment") env.DEVSPACE_OAUTH_OWNER_TOKEN = "short";
    const fake = join(root, "prompts.mjs");
    writeFileSync(fake, `const answers=${JSON.stringify(mode === "cancelled" ? ["CANCEL"] : [project, "18767"])};
export const isCancel=x=>x==='CANCEL';export const intro=()=>{};export const outro=()=>{};export const note=()=>{};export const cancel=()=>{};export const log={info:()=>{}};
export const multiselect=()=>{throw Error('Local initialization must not ask for providers or a public URL')};
export const text=async options=>{const value=answers.shift();if(value!=='CANCEL'){const e=options.validate?.(value);if(e)throw Error(e)}return value};`);
    const hook = join(root, "hook.mjs");
    writeFileSync(hook, `import {registerHooks} from 'node:module';registerHooks({resolve(s,c,n){return n(s==='@clack/prompts'?${JSON.stringify(pathToFileURL(fake).href)}:s,c)}});`);
    if (mode === "existing" || mode === "partial") {
      writeDevspaceConfig({ configVersion: 1, server: { port: 17878, publicBaseUrl: "https://devspace.example.com" },
        bridge: { enabled: true, allowWorkspaceWrite: false, executionPolicy: { requiredModel: "gpt-6-astra", minimumCliVersion: "0.153.0" } } }, env);
      if (mode === "existing") writeDevspaceAuth({ ownerToken: "fixture-owner-preserve-long-enough" }, env);
    }
    const before = mode === "existing" || mode === "partial" ? readFileSync(join(configDir, "config.jsonc"), "utf8") : undefined;
    const action = () => exec(process.execPath, ["--import", tsx, "--import", pathToFileURL(hook).href, cli, "init", "--local"], { cwd: project, env, timeout: 30000, windowsHide: true });
    if (mode === 'locked') {
      const release = acquireInitializationLock(env);
      try { await assert.rejects(action,/initialization is locked/); assert.equal(existsSync(join(configDir,'auth.json')),false); }
      finally { release(); }
      await action();
      assert.equal(loadConfig(env).toolAuthorization,'owner_approval');
    } else if (mode === "partial" || mode === "invalid-environment") {
      await assert.rejects(action, mode === "partial" ? /incomplete existing configuration/ : /owner token/i);
      if (mode === "partial") assert.equal(readFileSync(join(configDir, "config.jsonc"), "utf8"), before);
      else assert.equal(existsSync(join(configDir, "config.jsonc")), false);
      assert.equal(existsSync(join(configDir, "auth.json")), false);
    } else {
      await action();
      if (mode === "cancelled") assert.equal(existsSync(join(configDir, "config.jsonc")), false);
      else if (mode === "existing") {
        assert.equal(readFileSync(join(configDir, "config.jsonc"), "utf8"), before);
        assert.equal(JSON.parse(readFileSync(join(configDir, "auth.json"), "utf8")).ownerToken, "fixture-owner-preserve-long-enough");
      } else {
        const config = loadConfig(env);
        assert.equal(config.host, "127.0.0.1"); assert.equal(config.port, 18767);
        assert.deepEqual(config.allowedRoots, [project]);
        assert.equal(config.stateDir, join(configDir, "state"));
        assert.equal(config.subagents.enabled, false); assert.equal(config.bridge?.enabled, false);
        assert.equal(config.publicBaseUrl, "http://127.0.0.1:18767");
        if (mode === "environment") assert.equal(JSON.parse(readFileSync(join(configDir, "auth.json"), "utf8")).ownerToken, env.DEVSPACE_OAUTH_OWNER_TOKEN);
      }
    }
  });
}
