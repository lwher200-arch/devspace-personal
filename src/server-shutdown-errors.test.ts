import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { setImmediate } from "node:timers/promises";
import { shutdownHttpServer } from "./server-shutdown.js";

const execFileAsync = promisify(execFile);
const moduleUrl = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);

async function isolated(source: string) {
  // Strict child isolation detects unhandled rejections without installing a
  // process-wide handler that could hide failures in the test runner.
  const result = await execFileAsync(process.execPath, [
    "--unhandled-rejections=strict", "--import", import.meta.resolve("tsx"),
    "--input-type=module", "-e", source,
  ], { windowsHide: true, timeout: 30_000, maxBuffer: 256 * 1024 });
  assert.equal(result.stderr, "");
}

test("early HTTP shutdown failure is observed while application cleanup drains", async () => {
  await isolated(`
    import assert from 'node:assert/strict';
    import { setTimeout as delay } from 'node:timers/promises';
    import { shutdownHttpServer } from ${moduleUrl("./server-shutdown.js")};
    const failure = Error('fixture HTTP failure');
    let cleaned = false;
    await assert.rejects(shutdownHttpServer({ close(cb) { cb(failure); } }, async () => {
      await delay(30); cleaned = true;
    }), error => error === failure);
    assert.equal(cleaned, true);
  `);
});

test("application failure does not finish shutdown before HTTP drainage", async () => {
  const failure = Error("fixture application failure");
  let finishHttp!: () => void;
  let settled = false;
  const closing = shutdownHttpServer({ close(cb) { finishHttp = () => cb(); } }, async () => { throw failure; });
  const observed = closing.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
  try {
    await setImmediate();
    assert.equal(settled, false, "failure must not skip the outstanding drain");
  } finally { finishHttp(); }
  assert.equal(await observed, failure);
});

test("simultaneous synchronous close failures preserve both causes without unhandled rejections", async () => {
  await isolated(`
    import assert from 'node:assert/strict';
    import { shutdownHttpServer } from ${moduleUrl("./server-shutdown.js")};
    const httpError = Error('fixture HTTP failure'), appError = Error('fixture application failure');
    let calls = 0;
    await assert.rejects(shutdownHttpServer({ close() { throw httpError; } }, () => {
      calls++; throw appError;
    }), error => error instanceof AggregateError &&
      error.errors.length === 2 && error.errors[0] === httpError && error.errors[1] === appError);
    assert.equal(calls, 1);
  `);
});

test("a real HTTP response drains while application shutdown reports its failure", async () => {
  await isolated(`
    import assert from 'node:assert/strict';
    import { createServer, get } from 'node:http';
    import { once } from 'node:events';
    import { shutdownHttpServer } from ${moduleUrl("./server-shutdown.js")};
    let finishResponse, entered;
    const requestEntered = new Promise(resolve => { entered = resolve; });
    const server = createServer((request, response) => {
      finishResponse = () => response.end('fixture drained'); entered();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const response = new Promise((resolve, reject) => {
      get({ host: '127.0.0.1', port: server.address().port, agent: false }, res => {
        let body = ''; res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve(body)); res.on('error', reject);
      }).on('error', reject);
    });
    const observedResponse = response.then(value => ({ value }), error => ({ error }));
    try {
      await requestEntered;
      const failure = Error('fixture cleanup failure');
      await assert.rejects(shutdownHttpServer(server, async () => {
        finishResponse(); throw failure;
      }), error => error === failure);
      assert.deepEqual(await observedResponse, { value: 'fixture drained' });
      assert.equal(server.listening, false);
    } finally { server.closeAllConnections(); server.close(); }
  `);
});

test("the actual server attempts every cleanup in order and memoizes success or failure", async t => {
  for (const failures of [[], ["transport"], ["process"], ["approval"], ["oauth"], ["workspace"], ["bridge"], ["approval", "oauth"]]) {
    await t.test(failures.join("+") || "success", async () => {
      const root = await mkdtemp(join(tmpdir(), "devspace-shutdown-errors-"));
      try {
        await isolated(`
          import assert from 'node:assert/strict';
          import { mock } from 'node:test';
          import { join } from 'node:path';
          import { createServer } from ${moduleUrl("./server.js")};
          import { loadConfig } from ${moduleUrl("./config.js")};
          import { writeTestDevspaceConfig } from ${moduleUrl("./test-support/config.test.js")};
          import { McpSessionRegistry } from ${moduleUrl("./mcp-sessions.js")};
          import { ProcessSessionManager } from ${moduleUrl("./process-sessions.js")};
          import { OwnerApprovals } from ${moduleUrl("./mcp-authorization.js")};
          import { SingleUserOAuthProvider } from ${moduleUrl("./oauth-provider.js")};
          import { SqliteWorkspaceStore } from ${moduleUrl("./workspace-store.js")};
          import { CodexBridge } from ${moduleUrl("./codex-bridge.js")};
          const root = ${JSON.stringify(root)}, failures = ${JSON.stringify(failures)};
          const expected = ['transport', 'process', 'approval', 'oauth', 'workspace', 'bridge'];
          const errors = new Map(failures.map(name => [name, Error('fixture ' + name + ' failure')]));
          const events = [];
          for (const [name, prototype, method] of [
            ['transport', McpSessionRegistry.prototype, 'closeAll'],
            ['process', ProcessSessionManager.prototype, 'shutdown'],
            ['approval', OwnerApprovals.prototype, 'close'],
            ['oauth', SingleUserOAuthProvider.prototype, 'close'],
            ['workspace', SqliteWorkspaceStore.prototype, 'close'],
            ['bridge', CodexBridge.prototype, 'close'],
          ]) {
            const original = prototype[method];
            mock.method(prototype, method, function (...args) {
              events.push(name);
              const done = value => { if (errors.has(name)) throw errors.get(name); return value; };
              const result = original.apply(this, args);
              return result?.then ? result.then(done) : done(result);
            });
          }
          const config = loadConfig(writeTestDevspaceConfig(join(root, 'config'), {
            storage: { stateDir: join(root, 'state') }, workspaces: { allowedRoots: [root] },
            skills: { enabled: false, agentDir: join(root, 'agent') },
            tools: { authorization: 'owner_approval' }, bridge: { enabled: true }, logging: { level: 'silent' },
          }));
          const server = createServer(config);
          const closing = server.close();
          assert.equal(server.close(), closing);
          const outcome = await closing.then(() => undefined, error => error);
          assert.deepEqual(events, expected);
          if (failures.length === 0) assert.equal(outcome, undefined);
          else if (failures.length === 1) assert.equal(outcome, errors.get(failures[0]));
          else {
            assert.ok(outcome instanceof AggregateError);
            assert.deepEqual(outcome.errors, failures.map(name => errors.get(name)));
          }
          assert.equal(server.close(), closing);
          assert.deepEqual(events, expected, 'a failed close must not replay cleanup');
        `);
      } finally {
        // The child has exited, releasing even resources skipped by a broken build.
        assert.equal(dirname(await realpath(root)), await realpath(tmpdir()));
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
