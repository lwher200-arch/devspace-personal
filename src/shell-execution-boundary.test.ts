import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProcessSessionManager } from "./process-sessions.js";
import { BubblewrapWorkspaceExecutionBoundary, LINUX_BWRAP_WORKSPACE_PROFILE } from "./workspace-execution-boundary.js";

function nodeCommand(code: string): string {
  return JSON.stringify(process.execPath) + " -e " + JSON.stringify(code);
}

function requireBubblewrap(t: { skip(message?: string): void }): boolean {
  if (process.platform !== "linux") { t.skip("Bubblewrap shell boundary is Linux-only."); return false; }
  const version = spawnSync("bwrap", ["--version"], { encoding: "utf8" });
  if (version.status !== 0) { t.skip("bubblewrap is unavailable in this environment."); return false; }
  const probe = spawnSync("bwrap", [
    "--ro-bind", "/", "/",
    "--proc", "/proc",
    "--dev", "/dev",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
    "--die-with-parent",
    "/bin/true",
  ], { encoding: "utf8" });
  if (probe.status !== 0) {
    t.skip("bubblewrap namespaces are unavailable in this execution environment.");
    return false;
  }
  return true;
}

test("shell pipe execution uses the workspace boundary and blocks sibling writes", async (t) => {
  if (!requireBubblewrap(t)) return;
  const root = mkdtempSync(join(tmpdir(), "devspace-shell-boundary-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside.txt");
  mkdirSync(workspace);
  const manager = new ProcessSessionManager();
  const boundary = new BubblewrapWorkspaceExecutionBoundary("bwrap");
  try {
    const code = "const fs=require('node:fs');" +
      "fs.writeFileSync(" + JSON.stringify(join(workspace, "inside.txt")) + ",'inside');" +
      "let outsideCode='UNEXPECTED_SUCCESS';try{fs.writeFileSync(" + JSON.stringify(outside) + ",'bad')}catch(e){outsideCode=e.code}" +
      "console.log(JSON.stringify({outsideCode}));";
    const result = await manager.start({ workspaceId: "shell-boundary", workspaceRoot: workspace, cwd: workspace,
      command: nodeCommand(code), executionBoundary: boundary, yieldTimeMs: 2_000 });
    assert.equal(result.running, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.boundaryProfile, LINUX_BWRAP_WORKSPACE_PROFILE);
    assert.equal(JSON.parse(result.output.trim()).outsideCode, "EROFS");
    assert.equal(existsSync(outside), false);
  } finally { manager.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("PTY shell sessions preserve write_stdin and resize inside the workspace boundary", async (t) => {
  if (!requireBubblewrap(t)) return;
  const root = mkdtempSync(join(tmpdir(), "devspace-shell-pty-boundary-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside.txt");
  mkdirSync(workspace);
  const manager = new ProcessSessionManager();
  const boundary = new BubblewrapWorkspaceExecutionBoundary("bwrap");
  try {
    const code = "const fs=require('node:fs');process.stdin.setEncoding('utf8');process.stdin.once('data',data=>{" +
      "let outsideCode='UNEXPECTED_SUCCESS';try{fs.writeFileSync(" + JSON.stringify(outside) + ",'bad')}catch(e){outsideCode=e.code}" +
      "console.log('input:'+data.trim());console.log('outside:'+outsideCode);console.log('columns:'+process.stdout.columns);process.exit(0);});";
    const started = await manager.start({ workspaceId: "shell-pty-boundary", workspaceRoot: workspace, cwd: workspace,
      command: nodeCommand(code), executionBoundary: boundary, tty: true, columns: 80, rows: 24, yieldTimeMs: 50 });
    assert.equal(started.running, true); assert.ok(started.sessionId);
    assert.equal(started.boundaryProfile, LINUX_BWRAP_WORKSPACE_PROFILE);
    const finished = await manager.write({ workspaceId: "shell-pty-boundary", sessionId: started.sessionId,
      chars: "hello\n", columns: 120, rows: 30, yieldTimeMs: 2_000 });
    assert.equal(finished.running, false);
    assert.equal(finished.boundaryProfile, LINUX_BWRAP_WORKSPACE_PROFILE);
    assert.match(finished.output, /input:hello/); assert.match(finished.output, /outside:EROFS/);
    assert.match(finished.output, /columns:120/); assert.equal(existsSync(outside), false);
  } finally { manager.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("synchronous shell execution preserves the timeout contract under the boundary", async (t) => {
  if (!requireBubblewrap(t)) return;
  const root = mkdtempSync(join(tmpdir(), "devspace-shell-timeout-boundary-"));
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const manager = new ProcessSessionManager();
  const boundary = new BubblewrapWorkspaceExecutionBoundary("bwrap");
  try {
    const result = await manager.runToCompletion({ workspaceId: "shell-timeout-boundary", workspaceRoot: workspace, cwd: workspace,
      command: nodeCommand("setInterval(()=>{},1000)"), executionBoundary: boundary, timeoutMs: 250 });
    assert.equal(result.running, false); assert.equal(result.timedOut, true);
    assert.equal(result.boundaryProfile, LINUX_BWRAP_WORKSPACE_PROFILE);
  } finally { manager.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
