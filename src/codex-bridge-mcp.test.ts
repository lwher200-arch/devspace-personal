import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Result } from "better-result";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CodexBridge, registerCodexBridgeTools } from "./codex-bridge.js";
import { loadConfig } from "./config.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const usage = {
  source: "codex/thread-token-usage" as const,
  scope: "provider_thread" as const,
  threadId: "thread_usage",
  turnId: "turn_usage",
  observedAt: "2026-09-08T00:00:00.000Z",
  total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 },
  lastModelResponse: { inputTokens: 60, cachedInputTokens: 30, outputTokens: 10, reasoningOutputTokens: 3, totalTokens: 70 },
};

test("MCP advertises explicit model/preflight and returns verified structured evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-policy-mcp-"));
  const policy = { requiredModel: "gpt-6-astra", minimumCliVersion: "0.153.0" };
  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    storage: { stateDir: join(root, "state") }, workspaces: { allowedRoots: [root] },
    bridge: { enabled: true, executionPolicy: policy }, skills: { agentDir: join(root, "agent") },
  }));
  const registry = new WorkspaceRegistry(config);
  const { workspace } = await registry.openWorkspace(root);
  let starts = 0;
  const record: any = { id: "agt_mcp", workspaceRoot: root, model: "gpt-6-astra", provider: "codex", profileName: "codex", status: "idle",
    providerSessionId: "thread", executionPolicy: policy, latestResponse: "done", createdAt: "now", updatedAt: "now",
    executionEvidence: { requestedModel: "gpt-6-astra", sessionModel: "gpt-6-astra", runtimeModel: "gpt-6-astra", cliVersion: "0.153.4",
      executable: "fixture", threadId: "thread", turnId: "turn", source: "codex-rollout/turn_context", sandbox: "readOnly", approvalPolicy: "never" } };
  record.usage = { ...usage, threadId: "thread" };
  const agentClient: any = { start: async (input: any) => { starts++; assert.equal(input.model, "gpt-6-astra"); assert.deepEqual(input.executionPolicy, policy); return Result.ok(record); },
    continue: async () => Result.ok(record), get: async () => Result.ok(record), list: async () => Result.ok([]) };
  const bridge = new CodexBridge(config, agentClient, () => ({ executable: "fixture", version: "0.153.4" }));
  const server = new McpServer({ name: "test", version: "1" });
  registerCodexBridgeTools(server, registry, bridge);
  const client = new Client({ name: "test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); bridge.close(); await rm(root, { recursive: true, force: true }); });
  await server.connect(right);
  await client.connect(left);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 5);
  assert.equal(tools.find(tool => tool.name === "codex_preflight")?.annotations?.readOnlyHint, true);
  assert.ok(tools.find(tool => tool.name === "codex_task_continue")?.inputSchema.properties?.model);
  const args = { workspaceId: workspace.id, requestKey: "one", prompt: "test" };
  assert.equal((await client.callTool({ name: "codex_task_start", arguments: args })).isError, true);
  assert.equal(starts, 0);
  const result = await client.callTool({ name: "codex_task_start", arguments: { ...args, model: "gpt-6-astra" } });
  assert.notEqual(result.isError, true);
  const value = JSON.parse((result.structuredContent as { result: string }).result);
  assert.equal(value.executionEvidence.runtimeModel, "gpt-6-astra");
  assert.equal(value.status, "completed");
  assert.deepEqual(value.usage, record.usage, "the MCP host receives the latest provider usage snapshot");
});
