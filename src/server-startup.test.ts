import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer as createListener } from "node:net";
import { Server as HttpServer } from "node:http";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import express from "express";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import * as serverModule from "./server.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const execFileAsync = promisify(execFile);

async function fixture(t: TestContext, port = 7676) {
  const root = await mkdtemp(join(tmpdir(), "devspace-startup-test-"));
  const handles: Database.Database[] = [];
  const timers = new Set<ReturnType<typeof setInterval>>();
  const events: string[] = [];
  const pragma = Database.prototype.pragma, close = Database.prototype.close;
  t.mock.method(Database.prototype, "pragma", function (this: Database.Database, ...args: Parameters<typeof pragma>) {
    if (!handles.includes(this)) handles.push(this);
    return pragma.apply(this, args);
  });
  t.mock.method(Database.prototype, "close", function (this: Database.Database) {
    events.push(`db:${handles.indexOf(this)}`);
    return close.call(this);
  });
  const interval = globalThis.setInterval, clear = globalThis.clearInterval;
  t.mock.method(globalThis, "setInterval", (...args: Parameters<typeof interval>) => {
    const timer = interval(...args); timers.add(timer); return timer;
  });
  t.mock.method(globalThis, "clearInterval", (...args: Parameters<typeof clear>) => {
    if (timers.delete(args[0] as ReturnType<typeof setInterval>)) events.push("timer");
    return clear(...args);
  });
  t.after(async () => {
    // Release deliberately leaked pre-fix fixtures without touching real state.
    for (const timer of timers) clear(timer);
    for (const handle of handles) if (handle.open) close.call(handle);
    assert.equal(dirname(await realpath(root)), await realpath(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const env = writeTestDevspaceConfig(join(root, "config"), {
    server: { host: "127.0.0.1", port }, storage: { stateDir: join(root, "state") },
    workspaces: { allowedRoots: [root] }, skills: { enabled: false, agentDir: join(root, "agent") },
    tools: { authorization: "owner_approval" }, bridge: { enabled: true }, logging: { level: "silent" },
  });
  return { config: loadConfig(env), env, root, handles, timers, events };
}

for (const stage of ["oauth", "workspace", "bridge"] as const) {
  test(`failed ${stage} storage initialization releases every acquired database`, async t => {
    const f = await fixture(t);
    const failure = Error(`fixture ${stage} setup failure`);
    if (stage === "oauth") {
      const prepare = Database.prototype.prepare;
      t.mock.method(Database.prototype, "prepare", function (this: Database.Database, sql: string) {
        if (sql.startsWith("delete from oauth_access_tokens where expires_at")) throw failure;
        return prepare.call(this, sql);
      });
    } else {
      const exec = Database.prototype.exec;
      t.mock.method(Database.prototype, "exec", function (this: Database.Database, sql: string) {
        if (sql.includes(stage === "workspace" ? "CREATE TABLE IF NOT EXISTS workspace_root_anchors" : "CREATE TABLE IF NOT EXISTS bridge_requests")) throw failure;
        return exec.call(this, sql);
      });
    }
    assert.throws(() => serverModule.createServer(f.config), error => error === failure);
    assert.equal(f.handles.length, { oauth: 1, workspace: 2, bridge: 3 }[stage]);
    assert.ok(f.handles.every(handle => !handle.open), "a thrown constructor must not leak its own or earlier handles");
    assert.equal(f.timers.size, 0);
  });
}

test("a failed bridge factory rolls back earlier resources without starting inference", async t => {
  const f = await fixture(t), failure = Error("fixture factory failure");
  assert.throws(() => serverModule.createServer(f.config, { codexBridgeFactory() { throw failure; } }), error => error === failure);
  assert.equal(f.handles.length, 2);
  assert.ok(f.handles.every(handle => !handle.open));
  assert.deepEqual(f.events, ["db:1", "db:0"]);
});

test("late route setup failure clears the timer and rolls back resources in reverse order", async t => {
  const f = await fixture(t), failure = Error("fixture route setup failure");
  const get = express.application.get;
  t.mock.method(express.application, "get", function (this: typeof express.application, ...args: unknown[]) {
    if (args[0] === "/healthz") throw failure;
    return Reflect.apply(get, this, args);
  });
  assert.throws(() => serverModule.createServer(f.config), error => error === failure);
  assert.equal(f.handles.length, 3);
  assert.ok(f.handles.every(handle => !handle.open));
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.events, [...Array(5).fill("timer"), "db:2", "db:1", "db:0"]);
});

test("rollback failure preserves the startup cause and still attempts remaining resources", async t => {
  const f = await fixture(t), startup = Error("fixture startup failure"), cleanup = Error("fixture close failure");
  const close = Database.prototype.close;
  t.mock.method(Database.prototype, "close", function (this: Database.Database) {
    const result = close.call(this);
    if (this === f.handles[1]) throw cleanup;
    return result;
  });
  assert.throws(() => serverModule.createServer(f.config, { codexBridgeFactory() { throw startup; } }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [startup, cleanup]);
    return true;
  });
  assert.ok(f.handles.every(handle => !handle.open));
  assert.deepEqual(f.events, ["db:1", "db:0"]);
});

for (const entry of ["cli", "server"]) {
  test(`${entry} entry reports occupied-port failure without claiming readiness or replacing its owner`, async t => {
    const owner = createListener(socket => socket.end("fixture owner"));
    owner.listen(0, "127.0.0.1");
    await once(owner, "listening");
    t.after(() => new Promise<void>(resolve => owner.close(() => resolve())));
    const address = owner.address();
    assert.ok(address && typeof address !== "string");
    const f = await fixture(t, address.port);
    const source = new URL(`./${entry}.ts`, import.meta.url);
    const path = fileURLToPath(existsSync(source) ? source : new URL(`./${entry}.js`, import.meta.url));
    let outcome: { code?: unknown; killed?: boolean; stdout?: string; stderr?: string };
    try {
      outcome = { code: 0, ...await execFileAsync(process.execPath, [
        "--unhandled-rejections=strict", "--import", import.meta.resolve("tsx"), path, ...(entry === "cli" ? ["serve"] : []),
      ], { windowsHide: true, env: { ...process.env, ...f.env }, timeout: 30_000, maxBuffer: 256 * 1024 }) };
    } catch (error) { outcome = error as typeof outcome; }
    assert.notEqual(outcome.killed, true, "startup must fail on its own, not by fixture timeout");
    assert.equal(outcome.code, 1, `${outcome.stdout}\n${outcome.stderr}`);
    assert.doesNotMatch(outcome.stdout ?? "", /devspace listening on/);
    assert.match(outcome.stderr ?? "", /EADDRINUSE/);
    assert.equal(owner.listening, true);
  });
}

test("start resolves only after real listening and normal close releases every owned timer", async t => {
  const f = await fixture(t);
  f.config.port = 0;
  const running = await serverModule.startServer(f.config);
  try {
    assert.equal(running.httpServer.listening, true);
    const reference = new HttpServer();
    assert.equal(running.httpServer.listenerCount("listening"), reference.listenerCount("listening"));
    assert.equal(running.httpServer.listenerCount("error"), reference.listenerCount("error"));
    assert.equal(f.timers.size, 5);
    const address = running.httpServer.address();
    assert.ok(address && typeof address !== "string");
    const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, name: "devspace" });
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/mcp`)).status, 401);
  } finally { await shutdownHttpServer(running.httpServer, running.close); }
  assert.equal(f.timers.size, 0);
  assert.ok(f.handles.every(handle => !handle.open));
});

test("failed binding releases resources and preserves existing database contents", async t => {
  const owner = createListener();
  owner.listen(0, "127.0.0.1");
  await once(owner, "listening");
  t.after(() => new Promise<void>(resolve => owner.close(() => resolve())));
  const address = owner.address();
  assert.ok(address && typeof address !== "string");
  const f = await fixture(t, address.port);
  const seed = openDatabase(f.config.stateDir);
  seed.sqlite.exec("CREATE TABLE fixture_marker (value TEXT); INSERT INTO fixture_marker VALUES ('retain me')");
  seed.close();
  await assert.rejects(serverModule.startServer(f.config), { code: "EADDRINUSE" });
  assert.equal(f.timers.size, 0);
  assert.ok(f.handles.every(handle => !handle.open));
  const restored = openDatabase(f.config.stateDir);
  try {
    assert.deepEqual(restored.sqlite.prepare("SELECT value FROM fixture_marker").get(), { value: "retain me" });
    assert.equal(restored.sqlite.pragma("integrity_check", { simple: true }), "ok");
  } finally { restored.close(); }
  assert.equal(owner.listening, true);
});

test("synchronous listen validation failure closes the constructed application", async t => {
  const f = await fixture(t);
  f.config.port = -1;
  await assert.rejects(serverModule.startServer(f.config), { code: "ERR_SOCKET_BAD_PORT" });
  assert.equal(f.timers.size, 0);
  assert.ok(f.handles.every(handle => !handle.open));
});

test("database setup and handle-close failures preserve both causes", async t => {
  const f = await fixture(t), setup = Error("fixture database setup"), cleanup = Error("fixture database cleanup");
  const close = Database.prototype.close;
  t.mock.method(Database.prototype, "close", function (this: Database.Database) {
    close.call(this); throw cleanup;
  });
  assert.throws(() => openDatabase(f.config.stateDir, () => { throw setup; }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [setup, cleanup]);
    return true;
  });
  assert.ok(f.handles.every(handle => !handle.open));
});

test("listen and application-close failure retain the original listen diagnostic", async t => {
  const f = await fixture(t), cleanup = Error("fixture database cleanup");
  f.config.port = -1;
  const close = Database.prototype.close;
  t.mock.method(Database.prototype, "close", function (this: Database.Database) {
    const result = close.call(this);
    if (this === f.handles[0]) throw cleanup;
    return result;
  });
  await assert.rejects(serverModule.startServer(f.config), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].code, "ERR_SOCKET_BAD_PORT");
    assert.equal(error.errors[1], cleanup);
    assert.match(error.message, /ERR_SOCKET_BAD_PORT/);
    return true;
  });
  assert.equal(f.timers.size, 0);
  assert.ok(f.handles.every(handle => !handle.open));
});

test("owned OAuth rate-limit stores retain independent SDK thresholds and windows", async t => {
  const f = await fixture(t);
  f.config.port = 0;
  const running = await serverModule.startServer(f.config);
  try {
    const address = running.httpServer.address();
    assert.ok(address && typeof address !== "string");
    for (const [path, limit, window] of [["/authorize", 100, 900], ["/token", 50, 900], ["/register", 20, 3600], ["/revoke", 50, 900]] as const) {
      for (let count = 1; count <= limit + 1; count++) {
        const response: Response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
          method: "POST", headers: { "content-type": path === "/register" ? "application/json" : "application/x-www-form-urlencoded" },
          body: path === "/register" ? "{}" : "grant_type=fixture-invalid",
        });
        await response.text();
        assert.equal(response.headers.get("ratelimit-limit"), String(limit));
        assert.equal(response.headers.get("ratelimit-policy"), `${limit};w=${window}`);
        if (count <= limit) assert.notEqual(response.status, 429, `${path} rejected too early`);
        else assert.equal(response.status, 429, `${path} did not enforce its limit`);
      }
    }
  } finally { await shutdownHttpServer(running.httpServer, running.close); }
  assert.equal(f.timers.size, 0);
});
