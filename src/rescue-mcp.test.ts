import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createRescueMcpServer,
  createSystemdRescueActions,
  loadRescueServerConfig,
} from "./rescue-server.js";

test("rescue MCP exposes only the fixed recovery surface", async t => {
  const calls: Array<{ action: string; value?: number }> = [];
  const actions = {
    async status() { calls.push({ action: "status" }); return { activeState: "active", subState: "running", mainPid: 42 }; },
    async ready() { calls.push({ action: "ready" }); return { ok: true, status: 200 }; },
    async logs(lines: number) { calls.push({ action: "logs", value: lines }); return { lines, output: "fixture log" }; },
    async restart() { calls.push({ action: "restart" }); return { restarted: true as const, activeState: "active", subState: "running", mainPid: 43 }; },
  };
  const server = createRescueMcpServer(actions);
  const client = new Client({ name: "rescue-fixture", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(right);
  await client.connect(left);

  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    "rescue_logs", "rescue_ready", "rescue_restart", "rescue_status",
  ]);
  assert.equal(tools.find(tool => tool.name === "rescue_status")?.annotations?.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === "rescue_restart")?.annotations?.destructiveHint, true);
  assert.equal(tools.some(tool => /shell|command|exec|file|write/i.test(tool.name)), false);

  assert.notEqual((await client.callTool({ name: "rescue_status", arguments: {} })).isError, true);
  assert.notEqual((await client.callTool({ name: "rescue_ready", arguments: {} })).isError, true);
  assert.notEqual((await client.callTool({ name: "rescue_logs", arguments: { lines: 25 } })).isError, true);
  assert.notEqual((await client.callTool({ name: "rescue_restart", arguments: {} })).isError, true);
  assert.deepEqual(calls, [
    { action: "status" },
    { action: "ready" },
    { action: "logs", value: 25 },
    { action: "restart" },
  ]);
  assert.equal((await client.callTool({ name: "rescue_logs", arguments: { lines: 201 } })).isError, true);
});

test("systemd rescue actions use fixed literal executables and the configured unit", async () => {
  const calls: Array<{ executable: string; args: string[] }> = [];
  const runner = async (executable: string, args: string[]) => {
    calls.push({ executable, args });
    if (executable === "systemctl" && args.includes("show")) {
      return { exitCode: 0, stdout: "ActiveState=active\nSubState=running\nMainPID=91\n", stderr: "" };
    }
    if (executable === "journalctl") return { exitCode: 0, stdout: "fixture journal\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const actions = createSystemdRescueActions({
    unit: "xm001-devspace.service",
    readyUrl: new URL("http://127.0.0.1:7676/readyz"),
  }, {
    run: runner,
    probeReady: async () => ({ ok: true, status: 200 }),
  });

  assert.equal((await actions.status()).mainPid, 91);
  assert.equal((await actions.ready()).ok, true);
  assert.equal((await actions.logs(17)).output, "fixture journal\n");
  assert.equal((await actions.restart()).restarted, true);
  assert.deepEqual(calls, [
    {
      executable: "systemctl",
      args: ["--user", "show", "xm001-devspace.service", "--no-pager",
        "--property=ActiveState", "--property=SubState", "--property=MainPID"],
    },
    {
      executable: "journalctl",
      args: ["--user-unit", "xm001-devspace.service", "-n", "17", "--no-pager", "--output=short-iso"],
    },
    {
      executable: "systemctl",
      args: ["--user", "restart", "xm001-devspace.service"],
    },
    {
      executable: "systemctl",
      args: ["--user", "show", "xm001-devspace.service", "--no-pager",
        "--property=ActiveState", "--property=SubState", "--property=MainPID"],
    },
  ]);
});

test("rescue server configuration fails closed and remains loopback-only", () => {
  assert.throws(() => loadRescueServerConfig({
    DEVSPACE_RESCUE_OWNER_TOKEN: "short",
    DEVSPACE_RESCUE_UNIT: "xm001-devspace.service",
  }), /token/i);
  assert.throws(() => loadRescueServerConfig({
    DEVSPACE_RESCUE_OWNER_TOKEN: "r".repeat(32),
    DEVSPACE_RESCUE_UNIT: "../bad.service",
  }), /unit/i);
  assert.throws(() => loadRescueServerConfig({
    DEVSPACE_RESCUE_OWNER_TOKEN: "r".repeat(32),
    DEVSPACE_RESCUE_UNIT: "xm001-devspace.service",
    DEVSPACE_RESCUE_READY_URL: "https://example.com/readyz",
  }), /loopback/i);

  const config = loadRescueServerConfig({
    DEVSPACE_RESCUE_OWNER_TOKEN: "r".repeat(32),
    DEVSPACE_RESCUE_UNIT: "xm001-devspace.service",
    DEVSPACE_RESCUE_PORT: "7677",
    DEVSPACE_RESCUE_PUBLIC_BASE_URL: "https://rescue.example.test",
    DEVSPACE_RESCUE_READY_URL: "http://127.0.0.1:7676/readyz",
    DEVSPACE_RESCUE_STATE_DIR: "/tmp/devspace-rescue-state",
  });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 7677);
  assert.equal(config.unit, "xm001-devspace.service");
  assert.equal(config.readyUrl.href, "http://127.0.0.1:7676/readyz");
  assert.equal(config.oauth.ownerToken.length, 32);
});
