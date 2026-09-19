import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BubblewrapWorkspaceExecutionBoundary,
  LINUX_BWRAP_WORKSPACE_PROFILE,
} from "./workspace-execution-boundary.js";

test("bubblewrap boundary preserves literal argv and binds only the workspace writable", (t) => {
  if (process.platform !== "linux") {
    t.skip("Bubblewrap boundary is Linux-only.");
    return;
  }
  const probe = spawnSync("bwrap", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    t.skip("bubblewrap is unavailable in this environment.");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "devspace-boundary-"));
  const workspace = join(root, "workspace");
  const nested = join(workspace, "nested");
  const outside = join(root, "outside.txt");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(workspace, ".env"), "before\n");
  const boundary = new BubblewrapWorkspaceExecutionBoundary("bwrap");

  try {
    const code = [
      "const fs=require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(join(workspace, "inside.txt"))}, 'inside');`,
      `try { fs.writeFileSync(${JSON.stringify(outside)}, 'outside'); } catch (e) { console.log('outside:' + e.code); }`,
      `try { fs.writeFileSync(${JSON.stringify(join(workspace, ".env"))}, 'after'); } catch (e) { console.log('env:' + e.code); }`,
      "console.log(JSON.stringify(process.argv.slice(1)));",
    ].join("");
    const literal = ["two words", "&not-shell", "$HOME", "中文🙂"];
    const prepared = boundary.prepare({
      workspaceRoot: workspace,
      cwd: nested,
      executable: process.execPath,
      args: ["-e", code, "--", ...literal],
    });
    assert.equal(prepared.boundaryProfile, LINUX_BWRAP_WORKSPACE_PROFILE);
    assert.equal(prepared.networkProfile, "inherit");
    assert.equal(prepared.args.includes("--unshare-net"), false);
    assert.equal(prepared.executable, "bwrap");
    const runtimeDirectory = join("/run/user", String(process.getuid?.() ?? -1));
    if (process.getuid && existsSync(runtimeDirectory)) {
      const runtimeMask = prepared.args.findIndex((value, index) =>
        value === "--tmpfs" && prepared.args[index + 1] === runtimeDirectory);
      assert.notEqual(runtimeMask, -1, "user runtime/control sockets must be hidden");
    }
    const result = spawnSync(prepared.executable, prepared.args, { encoding: "utf8" });
    if (result.status !== 0 && /namespace|permission|operation not permitted/i.test(result.stderr)) {
      t.skip(`bubblewrap namespaces unavailable: ${result.stderr.trim()}`);
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(workspace, "inside.txt"), "utf8"), "inside");
    assert.equal(existsSync(outside), false);
    assert.equal(readFileSync(join(workspace, ".env"), "utf8"), "before\n");
    assert.match(result.stdout, /outside:(?:EROFS|EACCES|EPERM)/);
    assert.match(result.stdout, /env:(?:EROFS|EACCES|EPERM)/);
    assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)!), literal);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bubblewrap boundary adds a private network namespace only for the explicit none profile", () => {
  if (process.platform !== "linux") return;
  const root = mkdtempSync(join(tmpdir(), "devspace-boundary-net-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  try {
    const boundary = new BubblewrapWorkspaceExecutionBoundary("bwrap");
    const prepared = boundary.prepare({
      workspaceRoot: workspace,
      cwd: workspace,
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      networkProfile: "none",
    });
    assert.equal(prepared.networkProfile, "none");
    assert.equal(prepared.args.includes("--unshare-net"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bubblewrap boundary rejects a working directory outside the selected workspace", (t) => {
  if (process.platform !== "linux") {
    t.skip("Bubblewrap boundary is Linux-only.");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "devspace-boundary-path-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  try {
    const boundary = new BubblewrapWorkspaceExecutionBoundary("bwrap");
    assert.throws(() => boundary.prepare({
      workspaceRoot: workspace,
      cwd: outside,
      executable: process.execPath,
      args: [],
    }), /outside the workspace boundary/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bubblewrap boundary filters host credentials and control-plane environment without removing normal development variables", () => {
  const boundary = new BubblewrapWorkspaceExecutionBoundary("bwrap");
  const input = {
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/example",
    LANG: "C.UTF-8",
    OPENAI_API_KEY: "secret",
    GH_TOKEN: "secret",
    AWS_SECRET_ACCESS_KEY: "secret",
    SSH_AUTH_SOCK: "/run/user/1000/ssh-agent.socket",
    DOCKER_HOST: "tcp://127.0.0.1:2375",
    KUBECONFIG: "/home/example/.kube/config",
    DATABASE_URL: "postgres://user:secret@example/db",
  };
  const filtered = boundary.filterEnvironment(input);
  assert.equal(filtered.PATH, input.PATH);
  assert.equal(filtered.HOME, input.HOME);
  assert.equal(filtered.LANG, input.LANG);
  for (const name of [
    "OPENAI_API_KEY",
    "GH_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "SSH_AUTH_SOCK",
    "DOCKER_HOST",
    "KUBECONFIG",
    "DATABASE_URL",
  ]) {
    assert.equal(filtered[name], undefined, `${name} must not cross the project boundary`);
  }
});
