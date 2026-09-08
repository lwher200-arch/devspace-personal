import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import { registerNativeProcessTools } from "./native-process-tools.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { WorkspaceRegistry } from "./workspaces.js";

async function fixture(t: TestContext, logging = false) {
  const root = await mkdtemp(join(tmpdir(), "devspace-native-tools-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(join(project, "nested"), { recursive: true });
  await mkdir(agentDir);
  const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: { port: 1 },
    workspaces: { allowedRoots: [project], worktreeRoot: join(root, "worktrees") },
    skills: { agentDir },
    logging: { level: logging ? "info" : "silent", toolCalls: true, shellCommands: true },
  }));
  const workspaces = new WorkspaceRegistry(config);
  const workspaceId = (await workspaces.openWorkspace(project)).workspace.id;
  const processSessions = new ProcessSessionManager();
  const server = new McpServer({ name: "native-process-test", version: "1.0.0" });
  registerNativeProcessTools({ server, config, workspaces, processSessions });
  const client = new Client({ name: "native-process-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  t.after(async () => {
    processSessions.shutdown();
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  const invoke = async (name: string, input: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: { workspaceId, ...input } });
    return { ...result, isError: result.isError as boolean | undefined,
      structuredContent: result.structuredContent as Record<string, unknown> | undefined };
  };
  return { client, invoke, project };
}

test("native tools expose literal args, bounded stdin and explicit process outcomes in actual MCP schemas", async t => {
  const { client } = await fixture(t);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), ["process_cancel", "process_status", "run_process"]);
  const run = tools.find(tool => tool.name === "run_process")!;
  const properties = run.inputSchema.properties!;
  assert.deepEqual(run.inputSchema.required, ["workspaceId", "executable"]);
  assert.ok("args" in properties && "stdin" in properties && "timeoutMs" in properties);
  assert.equal("cmd" in properties, false);
  assert.equal(run.annotations?.readOnlyHint, false);
  const poll = tools.find(tool => tool.name === "process_status")!;
  assert.equal(poll.annotations?.readOnlyHint, true);
  assert.equal("chars" in poll.inputSchema.properties!, false);
  assert.equal("executionId" in run.outputSchema!.properties!, true);
  assert.equal("timedOut" in run.outputSchema!.properties!, true);
  assert.equal("spawnError" in run.outputSchema!.properties!, true);
});

test("native MCP invocation preserves argv/stdin and enforces working directory containment before spawn", async t => {
  const { invoke, project } = await fixture(t);
  const code = "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>console.log(JSON.stringify({args:process.argv.slice(1),input,cwd:process.cwd()})))";
  const args = ["", "hello & bye", "%PATH%", 'a"b', "中文"];
  const result = await invoke("run_process", { executable: process.execPath,
    args: ["-e", code, "--", ...args], stdin: "stdin 中文", workingDirectory: "nested", yieldTimeMs: 3_000 });
  assert.equal(result.isError, false);
  const data = result.structuredContent!;
  assert.equal(data.exitCode, 0);
  assert.deepEqual(JSON.parse(data.output as string), { args, input: "stdin 中文", cwd: join(project, "nested") });
  const marker = join(project, "escaped-marker");
  const blocked = await invoke("run_process", { executable: process.execPath,
    args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`], workingDirectory: ".." });
  assert.equal(blocked.isError, true);
  assert.equal(existsSync(marker), false);
});

test("MCP distinguishes launch failure, nonzero exit and timeout without reporting success", async t => {
  const { invoke, project } = await fixture(t);
  const missing = await invoke("run_process", { executable: join(project, "missing.exe"), yieldTimeMs: 3_000 });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent!.spawnError, "ENOENT");
  const failure = await invoke("run_process", { executable: process.execPath, args: ["-e", "process.exit(7)"], yieldTimeMs: 3_000 });
  assert.equal(failure.isError, true);
  assert.equal(failure.structuredContent!.exitCode, 7);
  const timeout = await invoke("run_process", { executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 250, yieldTimeMs: 3_000 });
  assert.equal(timeout.isError, true);
  assert.equal(timeout.structuredContent!.running, false);
  assert.equal(timeout.structuredContent!.timedOut, true);
});

test("MCP polls and cancels the same session while keeping args and stdin out of operation logs", async t => {
  const logs: string[] = [];
  t.mock.method(console, "log", (...values: unknown[]) => logs.push(values.map(String).join(" ")));
  const { invoke } = await fixture(t, true);
  const secret = "ARG_STDIN_MARKER_83726";
  const start = await invoke("run_process", { executable: process.execPath,
    args: ["-e", "process.stdin.resume();setInterval(()=>{},1000)", "--", secret], stdin: secret, yieldTimeMs: 0 });
  assert.equal(start.isError, false);
  const sessionId = start.structuredContent!.sessionId;
  const poll = await invoke("process_status", { sessionId, yieldTimeMs: 0 });
  assert.equal(poll.isError, false);
  assert.equal(poll.structuredContent!.executionId, start.structuredContent!.executionId);
  const cancelled = await invoke("process_cancel", { sessionId, yieldTimeMs: 3_000 });
  assert.equal(cancelled.isError, true);
  assert.equal(cancelled.structuredContent!.running, false);
  assert.equal(cancelled.structuredContent!.cancelled, true);
  assert.equal(cancelled.structuredContent!.executionId, start.structuredContent!.executionId);
  assert.ok(logs.some(line => line.includes('"tool":"run_process"')));
  assert.equal(logs.some(line => line.includes(secret)), false);
  assert.equal(JSON.stringify(cancelled).includes(secret), false);
});
