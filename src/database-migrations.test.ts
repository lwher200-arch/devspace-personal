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

function useVersionSix(sqlite: Database.Database) {
  migrateDatabase(sqlite);
  sqlite.exec("alter table local_agent_sessions drop column execution_json");
  sqlite.exec("delete from devspace_schema_migrations where version = 7");
}

test("fresh migration and repeat startup retain the personal v7 contract", () => {
  const sqlite = new Database(":memory:");
  try {
    migrateDatabase(sqlite);
    const before = journal(sqlite);
    assert.equal(before.length, 7);
    assert.deepEqual(sqlite.prepare("select version, name from devspace_schema_migrations where version = 7").get(),
      { version: 7, name: "local-agent-execution-contract" });
    migrateDatabase(sqlite);
    assert.deepEqual(journal(sqlite), before);
    assert.equal(sqlite.prepare("select execution_json from local_agent_sessions").all().length, 0);
  } finally { sqlite.close(); }
});

test("a recognized v6 database upgrades without replacing stored agent data", () => {
  const sqlite = new Database(":memory:");
  try {
    useVersionSix(sqlite);
    sqlite.exec(`insert into local_agent_sessions
      (id, workspace_root, profile_name, provider, status, created_at, updated_at)
      values ('agt_fixture', 'fixture-root', 'reviewer', 'codex', 'completed', 'before', 'before')`);
    const before = journal(sqlite);
    migrateDatabase(sqlite);
    assert.deepEqual(journal(sqlite).slice(0, 6), before);
    assert.deepEqual(sqlite.prepare("select id, status, execution_json from local_agent_sessions").get(),
      { id: "agt_fixture", status: "completed", execution_json: null });
  } finally { sqlite.close(); }
});

for (const scenario of ["unknown-version", "unknown-low-version", "wrong-name"] as const) {
  test(`migration rejects ${scenario} before applying pending v7`, () => {
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
      create trigger reject_fixture_v7 before insert on devspace_schema_migrations
      when new.version = 7 begin select raise(abort, 'fixture migration failure'); end;`);
    const before = sqlite.serialize();
    assert.throws(() => migrateDatabase(sqlite), /fixture migration failure/);
    assert.deepEqual(sqlite.serialize(), before);
    assert.equal(sqlite.inTransaction, false);
    sqlite.exec("drop trigger reject_fixture_v7");
    migrateDatabase(sqlite);
    assert.equal(journal(sqlite).length, 7);
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

test("backup and reopen retain the v7 execution payload", async () => {
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
  useVersionSix(fixture);
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
      assert.deepEqual(JSON.parse(result.value.stdout), [1, 2, 3, 4, 5, 6, 7]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
