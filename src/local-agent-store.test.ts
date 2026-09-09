import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { databasePath } from "./db/client.js";
import { LocalAgentStore } from "./local-agent-store.js";

const usage = {
  source: "codex/thread-token-usage" as const,
  scope: "provider_thread" as const,
  threadId: "thread_usage",
  turnId: "turn_usage",
  observedAt: "2026-09-08T00:00:00.000Z",
  total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 },
  lastModelResponse: { inputTokens: 60, cachedInputTokens: 30, outputTokens: 10, reasoningOutputTokens: 3, totalTokens: 70 },
};

const root = mkdtempSync(join(tmpdir(), "devspace-local-agent-store-test-"));
const stores: LocalAgentStore[] = [];

try {
  const store = new LocalAgentStore(root);
  stores.push(store);
  const created = store.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "reviewer",
    provider: "codex",
    model: "gpt-5.4",
    effort: "high",
  });

  assert.match(created.id, /^agt_[a-f0-9]{8}$/);
  assert.equal(created.status, "starting");
  assert.equal(store.getById(created.id)?.effort, "high");
  assert.equal(store.getById(created.id)?.profileName, "reviewer");
  assert.equal(store.getById(created.id.slice(0, 7)), undefined);

  const updated = store.update(created.id, {
    status: "error",
    latestResponse: "done",
    providerSessionId: "thread_123",
    effort: "medium",
    error: "Codex executable was not found.",
    errorCode: "PROVIDER_UNAVAILABLE",
    errorRetryable: false,
  });

  assert.equal(updated.status, "error");
  assert.equal(updated.effort, "medium");
  assert.equal(updated.errorCode, "PROVIDER_UNAVAILABLE");
  assert.equal(updated.errorRetryable, false);
  assert.equal(store.getById("thread_123"), undefined);
  const storedError = store.getById(created.id);
  assert.equal(storedError?.error, "Codex executable was not found.");
  assert.equal(storedError?.errorCode, "PROVIDER_UNAVAILABLE");
  assert.equal(storedError?.errorRetryable, false);
  assert.equal(store.update(created.id, { latestResponse: undefined }).latestResponse, undefined);
  assert.deepEqual(
    store.list({ workspaceRoot: join(root, "project") }).map((agent) => agent.latestResponse),
    [undefined],
  );
assert.deepEqual(store.list({ workspaceId: "ws_1" }).map((agent) => agent.id), [created.id]);
assert.deepEqual(store.list({ workspaceId: "ws_other" }), []);
assert.deepEqual(store.list({ workspaceId: "ws_1", workspaceRoot: join(root, "other") }), []);
assert.deepEqual(store.list({ workspaceRoot: join(root, "other") }), []);

  const otherStore = new LocalAgentStore(root);
  stores.push(otherStore);
  const createdFromOtherStore = otherStore.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "explorer",
    provider: "claude",
  });

  assert.deepEqual(
    store.list({ workspaceId: "ws_1" }).map((agent) => agent.id).sort(),
    [created.id, createdFromOtherStore.id].sort(),
  );

  const legacyStateDir = join(root, "legacy-state");
  mkdirSync(legacyStateDir, { recursive: true });
  const legacy = new Database(databasePath(legacyStateDir));
  legacy.exec(`
    create table devspace_schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    );
    create table local_agent_sessions (
      id text primary key,
      workspace_id text,
      workspace_root text not null,
      profile_name text not null,
      provider text not null,
      model text,
      thinking text,
      provider_session_id text,
      status text not null,
      latest_response text,
      error text,
      created_at text not null,
      updated_at text not null
    );
  `);
  const migration = legacy.prepare(
    "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
  );
  // Leave migration 3 unapplied to exercise an interrupted legacy upgrade:
  // it adds an empty effort column before migration 6 copies thinking values.
  for (const [version, name] of [[1, "workspace-state"], [2, "oauth-state"], [4, "workspace-conversation-bindings"]] as const) {
    migration.run(version, name, "2026-08-01T00:00:00.000Z");
  }
  legacy.prepare(`
    insert into local_agent_sessions (
      id, workspace_root, profile_name, provider, thinking, status, error, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "agt_legacy",
    join(root, "legacy-project"),
    "reviewer",
    "codex",
    "high",
    "error",
    "old error",
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
  );
  legacy.close();

  const upgradedStore = new LocalAgentStore(legacyStateDir);
  stores.push(upgradedStore);
  const legacyRecord = upgradedStore.getById("agt_legacy");
  assert.equal(legacyRecord?.error, "old error");
  assert.equal(legacyRecord?.usage, undefined, "legacy records do not invent token usage");
  assert.equal(legacyRecord?.effort, "high");
  assert.equal(legacyRecord?.errorCode, undefined);
  assert.equal(legacyRecord?.errorRetryable, undefined);
  const upgradedRecord = upgradedStore.update("agt_legacy", {
    errorCode: "DAEMON_TIMEOUT",
    errorRetryable: true,
  });
  assert.equal(upgradedRecord.errorCode, "DAEMON_TIMEOUT");
  assert.equal(upgradedRecord.errorRetryable, true);
  const reloadedRecord = upgradedStore.getById("agt_legacy");
  assert.equal(reloadedRecord?.error, "old error");
  assert.equal(reloadedRecord?.errorCode, "DAEMON_TIMEOUT");
  assert.equal(reloadedRecord?.errorRetryable, true);

  const metered = store.create({
    workspaceRoot: join(root, "metered-project"), profileName: "codex", provider: "codex",
  });
  assert.equal(metered.usage, undefined);
  store.update(metered.id, { providerSessionId: usage.threadId, usage, status: "running" });
  assert.deepEqual(store.update(metered.id, { usage }).usage, usage, "duplicate snapshots replace, never add");
  const reopened = new LocalAgentStore(root);
  stores.push(reopened);
  assert.deepEqual(reopened.getById(metered.id)?.usage, usage, "usage survives reopening the store");
  assert.deepEqual(store.update(metered.id, { status: "stopped" }).usage, usage);
  store.update(metered.id, { status: "running" });
  store.reconcileActiveRuns();
  assert.equal(store.getById(metered.id)?.status, "error");
  assert.deepEqual(store.getById(metered.id)?.usage, usage, "restart reconciliation preserves the last observation");
  const invalidUsage = { ...usage, total: { ...usage.total, inputTokens: -1 } };
  assert.deepEqual(store.update(metered.id, { usage: invalidUsage }).usage, usage, "invalid telemetry does not erase a valid observation");
  assert.equal(store.update(metered.id, { providerSessionId: "thread_new" }).usage, undefined, "a new provider session clears prior usage");
  assert.equal(store.update(metered.id, { usage }).usage, undefined, "cross-session telemetry is ignored");
  const nextUsage = {
    ...usage, threadId: "thread_new", turnId: "turn_next",
    total: { ...usage.total, cacheWriteInputTokens: 7 },
  };
  assert.deepEqual(store.update(metered.id, { usage: nextUsage }).usage, nextUsage);
  assert.equal(reopened.getById(metered.id)?.usage?.total.cacheWriteInputTokens, 7);
  const compactedUsage = {
    ...nextUsage, turnId: "turn_compacted", total: { ...usage.lastModelResponse },
  };
  assert.deepEqual(store.update(metered.id, { usage: compactedUsage }).usage, compactedUsage,
    "a lower provider total replaces the snapshot without inventing a delta");

  const raw = new Database(databasePath(root));
  try {
    raw.prepare("update local_agent_sessions set execution_json = ? where id = ?")
      .run(JSON.stringify({ usage: invalidUsage }), metered.id);
  } finally { raw.close(); }
  assert.equal(store.getById(metered.id)?.usage, undefined, "malformed telemetry does not make the record unreadable");
} finally {
  for (const store of stores) {
    store.close();
  }
  rmSync(root, { recursive: true, force: true });
}
