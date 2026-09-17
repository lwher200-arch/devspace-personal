import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { databasePath, openDatabase } from "./db/client.js";
import { migrateDatabase } from "./db/migrations.js";

function journal(sqlite: Database.Database) {
  return sqlite.prepare("select version, name, applied_at from devspace_schema_migrations order by version").all();
}

function useVersionSeven(sqlite: Database.Database) {
  migrateDatabase(sqlite);
  sqlite.exec("drop table task_session_bindings");
  sqlite.exec("drop table task_sessions");
  sqlite.exec("delete from devspace_schema_migrations where version = 8");
}

function useVersionSix(sqlite: Database.Database) {
  useVersionSeven(sqlite);
  sqlite.exec("alter table local_agent_sessions drop column execution_json");
  sqlite.exec("delete from devspace_schema_migrations where version = 7");
}

test("fresh migration and repeat startup retain the personal v8 contract", () => {
  const sqlite = new Database(":memory:");
  try {
    migrateDatabase(sqlite);
    const before = journal(sqlite);
    assert.equal(before.length, 8);
    assert.deepEqual(sqlite.prepare("select version, name from devspace_schema_migrations where version = 8").get(),
      { version: 8, name: "task-session-kernel" });
    migrateDatabase(sqlite);
    assert.deepEqual(journal(sqlite), before);
    assert.equal(sqlite.prepare("select execution_json from local_agent_sessions").all().length, 0);
    assert.deepEqual(sqlite.prepare("select name from sqlite_master where type = 'table' and name in ('task_sessions', 'task_session_bindings') order by name").pluck().all(),
      ["task_session_bindings", "task_sessions"]);
  } finally { sqlite.close(); }
});

test("a recognized v7 database upgrades to task sessions without replacing stored data", () => {
  const sqlite = new Database(":memory:");
  try {
    useVersionSeven(sqlite);
    sqlite.exec(`insert into workspace_sessions
      (id, root, status, mode, managed, created_at, last_used_at)
      values ('ws_fixture', 'fixture-root', 'active', 'checkout', 'false', 'before', 'before')`);
    sqlite.exec(`insert into local_agent_sessions
      (id, workspace_id, workspace_root, profile_name, provider, status, created_at, updated_at)
      values ('agt_fixture', 'ws_fixture', 'fixture-root', 'reviewer', 'codex', 'completed', 'before', 'before')`);
    const before = journal(sqlite);
    migrateDatabase(sqlite);
    assert.deepEqual(journal(sqlite).slice(0, 7), before);
    assert.deepEqual(sqlite.prepare("select id, status, execution_json from local_agent_sessions").get(),
      { id: "agt_fixture", status: "completed", execution_json: null });
    assert.deepEqual(sqlite.prepare("select name from sqlite_master where type = 'table' and name in ('task_sessions', 'task_session_bindings') order by name").pluck().all(),
      ["task_session_bindings", "task_sessions"]);
  } finally { sqlite.close(); }
});

test("task-session migration enforces one current binding per task and conversation", () => {
  const sqlite = new Database(":memory:");
  try {
    sqlite.pragma("foreign_keys = ON");
    migrateDatabase(sqlite);
    sqlite.exec(`insert into workspace_sessions
      (id, root, status, mode, managed, created_at, last_used_at)
      values ('ws_fixture', 'fixture-root', 'active', 'checkout', 'false', 'before', 'before')`);
    sqlite.exec(`insert into task_sessions
      (id, workspace_session_id, created_at, updated_at)
      values ('task_a', 'ws_fixture', 'before', 'before')`);
    assert.deepEqual(sqlite.prepare(`select status, current_conversation_scope_id, lineage_version, next_event_seq
      from task_sessions where id = 'task_a'`).get(), {
      status: "active",
      current_conversation_scope_id: null,
      lineage_version: 1,
      next_event_seq: 1,
    });
    sqlite.exec(`insert into task_session_bindings
      (task_session_id, conversation_scope_id, state, generation, bound_at)
      values ('task_a', 'chat_a', 'current', 1, 'before')`);
    assert.throws(() => sqlite.exec(`insert into task_session_bindings
      (task_session_id, conversation_scope_id, state, generation, bound_at)
      values ('task_a', 'chat_b', 'current', 2, 'after')`), /UNIQUE constraint failed/);
    sqlite.exec(`insert into task_sessions
      (id, workspace_session_id, created_at, updated_at)
      values ('task_b', 'ws_fixture', 'before', 'before')`);
    assert.throws(() => sqlite.exec(`insert into task_session_bindings
      (task_session_id, conversation_scope_id, state, generation, bound_at)
      values ('task_b', 'chat_a', 'current', 1, 'after')`), /UNIQUE constraint failed/);
    assert.throws(() => sqlite.exec(`insert into task_session_bindings
      (task_session_id, conversation_scope_id, state, generation, bound_at)
      values ('task_b', 'chat_bad', 'invented', 1, 'after')`), /CHECK constraint failed/);
    sqlite.exec("delete from workspace_sessions where id = 'ws_fixture'");
    assert.equal(sqlite.prepare("select count(*) from task_sessions").pluck().get(), 0);
    assert.equal(sqlite.prepare("select count(*) from task_session_bindings").pluck().get(), 0);
  } finally { sqlite.close(); }
});

for (const scenario of ["unknown-version", "unknown-low-version", "wrong-name"] as const) {
  test(`migration rejects ${scenario} before applying pending migrations`, () => {
    const sqlite = new Database(":memory:");
    try {
      useVersionSix(sqlite);
      if (scenario === "wrong-name") {
        sqlite.prepare("update devspace_schema_migrations set name = ? where version = 1").run("fixture-other-branch");
      } else {
        sqlite.prepare("insert into devspace_schema_migrations values (?, ?, ?)")
          .run(scenario === "unknown-version" ? 99 : 0, "fixture-unknown", "before");
      }
      const before = sqlite.serialize();
      assert.throws(() => migrateDatabase(sqlite), /Database migration history is incompatible/);
      assert.deepEqual(sqlite.serialize(), before, "rejection must not modify schema, journal or user data");
      assert.equal(sqlite.inTransaction, false);
    } finally { sqlite.close(); }
  });
}

test("a failed migration rolls back all pending schema and journal writes", () => {
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec(`create table devspace_schema_migrations
      (version integer primary key, name text not null, applied_at text not null);
      create trigger reject_fixture_v8 before insert on devspace_schema_migrations
      when new.version = 8 begin select raise(abort, 'fixture migration failure'); end;`);
    const before = sqlite.serialize();
    assert.throws(() => migrateDatabase(sqlite), /fixture migration failure/);
    assert.deepEqual(sqlite.serialize(), before);
    assert.equal(sqlite.inTransaction, false);
    sqlite.exec("drop trigger reject_fixture_v8");
    migrateDatabase(sqlite);
    assert.equal(journal(sqlite).length, 8);
  } finally { sqlite.close(); }
});

test("openDatabase closes its handle when initialization fails", (t) => {
  const root = mkdtempSync(join(tmpdir(), "devspace-db-open-failure-"));
  const fixture = new Database(databasePath(root));
  fixture.exec("create table local_agent_sessions (id text primary key)");
  fixture.close();
  const pragma = t.mock.method(Database.prototype, "pragma");
  try {
    assert.throws(() => openDatabase(root), /no such column/);
    const opened = pragma.mock.calls[0]?.this as Database.Database | undefined;
    assert.ok(opened);
    assert.equal(opened.open, false, "the rejected initialization must release its connection");
  } finally {
    for (const call of pragma.mock.calls) {
      const sqlite = call.this as Database.Database;
      if (sqlite.open) sqlite.close();
    }
    pragma.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup and reopen retain the v8 execution payload", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-db-backup-"));
  const backup = join(root, "backup");
  const source = openDatabase(root);
  const payload = JSON.stringify({ model: "gpt-6-astra", writeMode: "read_only", fixture: true });
  try {
    source.sqlite.prepare(`insert into local_agent_sessions
      (id, workspace_root, profile_name, provider, status, created_at, updated_at, execution_json)
      values ('agt_fixture', 'fixture-root', 'reviewer', 'codex', 'completed', 'before', 'before', ?)`)
      .run(payload);
    const initializedBackup = openDatabase(backup);
    initializedBackup.close();
    await source.sqlite.backup(databasePath(backup));
    const restored = openDatabase(backup);
    try {
      assert.deepEqual(journal(restored.sqlite), journal(source.sqlite));
      assert.equal(restored.sqlite.prepare("select execution_json from local_agent_sessions").pluck().get(), payload);
    } finally { restored.close(); }
  } finally {
    source.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent process startup upgrades an existing WAL database once", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-db-concurrent-"));
  const fixture = new Database(databasePath(root));
  fixture.pragma("journal_mode = WAL");
  useVersionSeven(fixture);
  fixture.close();
  const source = `import { openDatabase } from ${JSON.stringify(new URL("./db/client.ts", import.meta.url).href)};
    const handle = openDatabase(process.argv[1]);
    try { process.stdout.write(JSON.stringify(handle.sqlite.prepare('select version from devspace_schema_migrations order by version').pluck().all())); }
    finally { handle.close(); }`;
  try {
    const results = await Promise.allSettled([0, 1].map(() => promisify(execFile)(process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source, root],
      { timeout: 30000, windowsHide: true })));
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      assert.deepEqual(JSON.parse(result.value.stdout), [1, 2, 3, 4, 5, 6, 7, 8]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
