import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as reserveServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { CodexBridge } from "./codex-bridge.js";
import { loadConfig } from "./config.js";
import { OwnerApprovals } from "./mcp-authorization.js";
import { createServer } from "./server.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "devspace-workspace-http-"));
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "hello.txt"), "current project\n");
  const reserve = reserveServer();
  await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const origin = "http://127.0.0.1:" + port, resource = origin + "/mcp";
  const owner = "fixture-only-workspace-http-owner";
  const config = loadConfig({
    ...writeTestDevspaceConfig(join(root, "config"), {
      server: { host: "127.0.0.1", port, publicBaseUrl: origin },
      storage: { stateDir: join(root, "state") },
      workspaces: { allowedRoots: [project] },
      skills: { enabled: false, agentDir: join(root, "agent") },
      subagents: { enabled: false, providers: [] },
      tools: { mode: "codex", authorization: "owner_approval" },
      ui: { enabled: false },
      bridge: { enabled: true },
      logging: { level: "silent" },
    }),
    DEVSPACE_OAUTH_OWNER_TOKEN: owner,
  });
  let submissions = 0;
  const unexpectedSubmission = async () => {
    submissions++;
    throw new Error("This fixture must never submit a model request.");
  };
  const running = createServer(config, {
    codexBridgeFactory: configuration => new CodexBridge(configuration, {
      start: unexpectedSubmission, continue: unexpectedSubmission,
      get: unexpectedSubmission, list: unexpectedSubmission,
    }, () => ({ executable: "fixture-not-launched", version: "0.153.4" })),
  });
  const listener = running.app.listen(port, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const state = new Database(join(config.stateDir, "devspace.sqlite"));
  t.after(async () => {
    await running.close();
    state.close();
    listener.closeAllConnections();
    await new Promise<void>(resolve => listener.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const registration = await fetch(origin + "/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Workspace error fixture", redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  assert.equal(registration.status, 201);
  const { client_id: clientId } = await registration.json() as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const authorize = await fetch(origin + "/authorize", {
    method: "POST", redirect: "manual",
    body: new URLSearchParams({
      client_id: clientId, redirect_uri: "http://127.0.0.1/callback", response_type: "code",
      scope: "devspace", resource, code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), owner_token: owner,
    }),
  });
  assert.equal(authorize.status, 302);
  const code = new URL(authorize.headers.get("location")!).searchParams.get("code")!;
  const exchanged = await fetch(origin + "/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier,
      redirect_uri: "http://127.0.0.1/callback", resource,
    }),
  });
  assert.equal(exchanged.status, 200);
  const { access_token: accessToken } = await exchanged.json() as { access_token: string };
  let session = "", requestId = 0;
  const rpc = async (method: string, params: unknown) => {
    const id = ++requestId;
    const response = await fetch(resource, {
      method: "POST",
      headers: {
        authorization: "Bearer " + accessToken, "content-type": "application/json",
        accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    session = response.headers.get("mcp-session-id") ?? session;
    const text = await response.text();
    const data = text.startsWith("event:")
      ? text.split("\n").find(line => line.startsWith("data:"))!.slice(5) : text;
    return { status: response.status, id, body: JSON.parse(data) };
  };
  assert.equal((await rpc("initialize", {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" },
  })).status, 200);
  const tool = (name: string, args: Record<string, unknown>) => rpc("tools/call", { name, arguments: args });
  const open = async () => {
    const result = await tool("open_workspace", { path: project });
    assert.equal(result.status, 200);
    assert.notEqual(result.body.result.isError, true);
    return result.body.result.structuredContent.workspaceId as string;
  };
  return { root, project, state, tool, open, submissions: () => submissions };
}

function toolFailure(result: { status: number; id: number; body: any }, code: string) {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.id, result.id);
  assert.equal(result.body.result.isError, true);
  const detail = JSON.parse(result.body.result.content[0].text);
  assert.equal(detail.code, code);
  assert.equal(detail.approvalId, undefined);
  assert.equal(detail.approvalUrl, undefined);
  return detail;
}

test("stale workspace IDs are HTTP 200 tool failures without approval or side effects", async t => {
  const f = await fixture(t);
  const approvals = t.mock.method(OwnerApprovals.prototype, "require");
  for (const workspaceId of ["ws_64a10a5632", "ws_7d3332ed89"]) {
    for (const [name, args] of [
      ["project_read", { path: "hello.txt" }],
      ["project_files", {}],
      ["read", { path: "hello.txt" }],
      ["apply_patch", { patch: "*** Begin Patch\n*** Add File: unexpected.txt\n+bad\n*** End Patch" }],
      ["run_process", { executable: process.execPath, args: ["-e", "require('node:fs').writeFileSync('unexpected.txt','bad')"] }],
    ] as const) {
      const detail = toolFailure(await f.tool(name, { workspaceId, ...args }), "WORKSPACE_NOT_FOUND");
      assert.match(detail.instruction, /open_workspace/);
    }
  }
  assert.equal(approvals.mock.callCount(), 0);
  assert.equal(existsSync(join(f.project, "unexpected.txt")), false);
  assert.equal(f.submissions(), 0);
  assert.equal((f.state.prepare("SELECT count(*) AS n FROM workspace_sessions").get() as { n: number }).n, 0);

  const workspaceId = await f.open();
  const read = await f.tool("project_read", { workspaceId, path: "hello.txt" });
  assert.equal(read.status, 200);
  assert.notEqual(read.body.result.isError, true);
  assert.equal(JSON.parse(read.body.result.content[0].text).text, "current project\n");
  const files = await f.tool("project_files", { workspaceId });
  assert.equal(files.status, 200);
  assert.notEqual(files.body.result.isError, true);
  assert.ok(JSON.parse(files.body.result.content[0].text).files.includes("hello.txt"));
});

test("inactive workspace IDs cannot authorize reads and reopening returns a usable ID", async t => {
  const f = await fixture(t);
  const workspaceId = await f.open();
  f.state.prepare("UPDATE workspace_sessions SET status = 'inactive' WHERE id = ?").run(workspaceId);
  const before = f.state.prepare("SELECT * FROM workspace_sessions WHERE id = ?").get(workspaceId);
  const anchor = f.state.prepare("SELECT * FROM workspace_root_anchors WHERE workspace_id = ?").get(workspaceId);
  const approvals = t.mock.method(OwnerApprovals.prototype, "require");
  for (const name of ["project_read", "project_files"]) {
    const detail = toolFailure(await f.tool(name, { workspaceId, path: "hello.txt" }), "WORKSPACE_INACTIVE");
    assert.match(detail.instruction, /open_workspace/);
  }
  assert.equal(approvals.mock.callCount(), 0);
  assert.deepEqual(f.state.prepare("SELECT * FROM workspace_sessions WHERE id = ?").get(workspaceId), before);
  assert.deepEqual(f.state.prepare("SELECT * FROM workspace_root_anchors WHERE workspace_id = ?").get(workspaceId), anchor);
  const reopened = await f.open();
  assert.notEqual(reopened, workspaceId);
  assert.notEqual((await f.tool("project_read", { workspaceId: reopened, path: "hello.txt" })).body.result.isError, true);
});

test("invalid classifier inputs are tool failures and do not request approval", async t => {
  const f = await fixture(t);
  const workspaceId = await f.open();
  const approvals = t.mock.method(OwnerApprovals.prototype, "require");
  for (const [name, args] of [
    ["project_read_batch", { items: [] }],
    ["project_read_batch", { items: [{ path: "hello.txt", offset: -1 }] }],
    ["project_read_batch", { items: [{ path: "hello.txt" }], maxResultBytes: 1 }],
    ["apply_patch", { patch: 42 }],
    ["apply_patch", { patch: "not a patch" }],
    ["codex_task_start", { requestKey: "invalid", prompt: "" }],
  ] as const) {
    toolFailure(await f.tool(name, { workspaceId, ...args }), "INVALID_TOOL_ARGUMENTS");
  }
  for (const [name, args] of [
    ["project_files", {}],
    ["project_read", { workspaceId, path: 42 }],
    ["open_workspace", { path: 42 }],
  ] as const) {
    const result = await f.tool(name, args);
    assert.equal(result.status, 200);
    assert.equal(result.body.result.isError, true);
    assert.doesNotMatch(JSON.stringify(result.body), /OWNER_APPROVAL_REQUIRED/);
  }
  assert.equal(approvals.mock.callCount(), 0);
  assert.equal(f.submissions(), 0);
  assert.equal(await readFile(join(f.project, "hello.txt"), "utf8"), "current project\n");
});

test("path denials remain closed and unexpected internal failures remain HTTP 500", async t => {
  const f = await fixture(t);
  const workspaceId = await f.open();
  toolFailure(await f.tool("project_read", { workspaceId, path: "../outside.txt" }), "WORKSPACE_ACCESS_DENIED");
  const getWorkspace = t.mock.method(WorkspaceRegistry.prototype, "getWorkspace", () => {
    throw new Error("fixture internal database failure");
  });
  const result = await f.tool("project_files", { workspaceId });
  assert.equal(result.status, 500);
  assert.equal(result.body.error.code, -32603);
  assert.equal(result.body.error.message, "Internal server error");
  assert.doesNotMatch(JSON.stringify(result.body), /fixture internal database failure/);
  getWorkspace.mock.restore();
});
