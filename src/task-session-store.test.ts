import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase } from "./db/client.js";
import { SqliteTaskSessionStore, TaskSessionConflictError } from "./task-session-store.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devspace-task-session-store-"));
  const db = openDatabase(root);
  db.sqlite.prepare(`insert into workspace_sessions
    (id, root, status, mode, managed, created_at, last_used_at)
    values (?, ?, 'active', 'checkout', 'false', ?, ?)`)
    .run("ws_fixture", root, "2026-09-17T00:00:00.000Z", "2026-09-17T00:00:00.000Z");
  db.close();
  let tick = 0;
  const store = new SqliteTaskSessionStore(root, () => `2026-09-17T00:00:0${tick++}.000Z`);
  return {
    root,
    store,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("create binds the first conversation to a durable task identity", () => {
  const ctx = fixture();
  try {
    const created = ctx.store.create({ workspaceSessionId: "ws_fixture", conversationScopeId: "chat_a" });
    assert.match(created.id, /^task_[0-9a-f]{12}$/);
    assert.equal(created.status, "active");
    assert.equal(created.currentConversationScopeId, "chat_a");
    assert.equal(created.lineageVersion, 1);
    assert.equal(created.nextEventSeq, 1);
    assert.deepEqual(ctx.store.listBindings(created.id), [{
      taskSessionId: created.id,
      conversationScopeId: "chat_a",
      state: "current",
      generation: 1,
      boundAt: created.createdAt,
      supersededAt: undefined,
    }]);
    assert.equal(ctx.store.getByConversationScopeId("chat_a")?.id, created.id);
  } finally { ctx.close(); }
});

test("rebind atomically supersedes the source and advances the durable lineage", () => {
  const ctx = fixture();
  try {
    const created = ctx.store.create({ workspaceSessionId: "ws_fixture", conversationScopeId: "chat_a" });
    const rebound = ctx.store.rebind(created.id, "chat_a", "chat_b");
    assert.equal(rebound.currentConversationScopeId, "chat_b");
    assert.equal(rebound.lineageVersion, 2);
    assert.deepEqual(ctx.store.listBindings(created.id).map(binding => ({
      conversationScopeId: binding.conversationScopeId,
      state: binding.state,
      generation: binding.generation,
      superseded: Boolean(binding.supersededAt),
    })), [
      { conversationScopeId: "chat_a", state: "superseded", generation: 1, superseded: true },
      { conversationScopeId: "chat_b", state: "current", generation: 2, superseded: false },
    ]);
    assert.equal(ctx.store.getByConversationScopeId("chat_a"), undefined);
    assert.equal(ctx.store.getByConversationScopeId("chat_b")?.id, created.id);
  } finally { ctx.close(); }
});

test("stale source cannot move or mutate the current task attachment", () => {
  const ctx = fixture();
  try {
    const created = ctx.store.create({ workspaceSessionId: "ws_fixture", conversationScopeId: "chat_a" });
    ctx.store.rebind(created.id, "chat_a", "chat_b");
    assert.throws(
      () => ctx.store.rebind(created.id, "chat_a", "chat_c"),
      (error: unknown) => error instanceof TaskSessionConflictError && error.code === "SOURCE_MISMATCH",
    );
    const after = ctx.store.get(created.id)!;
    assert.equal(after.currentConversationScopeId, "chat_b");
    assert.equal(after.lineageVersion, 2);
    assert.deepEqual(ctx.store.listBindings(created.id).map(binding => binding.conversationScopeId), ["chat_a", "chat_b"]);
  } finally { ctx.close(); }
});

test("a conversation already current for another task cannot be claimed", () => {
  const ctx = fixture();
  try {
    const first = ctx.store.create({ workspaceSessionId: "ws_fixture", conversationScopeId: "chat_a" });
    const second = ctx.store.create({ workspaceSessionId: "ws_fixture", conversationScopeId: "chat_b" });
    assert.throws(
      () => ctx.store.rebind(second.id, "chat_b", "chat_a"),
      (error: unknown) => error instanceof TaskSessionConflictError && error.code === "DESTINATION_OWNED",
    );
    assert.equal(ctx.store.get(first.id)?.currentConversationScopeId, "chat_a");
    assert.equal(ctx.store.get(second.id)?.currentConversationScopeId, "chat_b");
    assert.equal(ctx.store.get(second.id)?.lineageVersion, 1);
  } finally { ctx.close(); }
});

test("a conversation remains owned by its original task after it is superseded", () => {
  const ctx = fixture();
  try {
    const first = ctx.store.create({ workspaceSessionId: "ws_fixture", conversationScopeId: "chat_a" });
    ctx.store.rebind(first.id, "chat_a", "chat_b");
    const second = ctx.store.create({ workspaceSessionId: "ws_fixture" });
    assert.throws(
      () => ctx.store.rebind(second.id, null, "chat_a"),
      (error: unknown) => error instanceof TaskSessionConflictError && error.code === "DESTINATION_OWNED",
    );
    assert.equal(ctx.store.get(first.id)?.currentConversationScopeId, "chat_b");
    assert.equal(ctx.store.get(second.id)?.currentConversationScopeId, undefined);
    assert.equal(ctx.store.get(second.id)?.lineageVersion, 1);
  } finally { ctx.close(); }
});

test("a superseded conversation cannot be revived into the same task", () => {
  const ctx = fixture();
  try {
    const created = ctx.store.create({ workspaceSessionId: "ws_fixture", conversationScopeId: "chat_a" });
    ctx.store.rebind(created.id, "chat_a", "chat_b");
    assert.throws(
      () => ctx.store.rebind(created.id, "chat_b", "chat_a"),
      (error: unknown) => error instanceof TaskSessionConflictError && error.code === "DESTINATION_RETIRED",
    );
    assert.equal(ctx.store.get(created.id)?.currentConversationScopeId, "chat_b");
    assert.equal(ctx.store.get(created.id)?.lineageVersion, 2);
  } finally { ctx.close(); }
});

test("an unbound task may attach its first conversation without changing task identity", () => {
  const ctx = fixture();
  try {
    const created = ctx.store.create({ workspaceSessionId: "ws_fixture" });
    assert.equal(created.currentConversationScopeId, undefined);
    const bound = ctx.store.rebind(created.id, null, "chat_a");
    assert.equal(bound.id, created.id);
    assert.equal(bound.currentConversationScopeId, "chat_a");
    assert.equal(bound.lineageVersion, 1);
    assert.equal(ctx.store.listBindings(created.id)[0]?.generation, 1);
  } finally { ctx.close(); }
});
