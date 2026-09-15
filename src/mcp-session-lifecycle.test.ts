import assert from 'node:assert/strict';
import test from 'node:test';
import { McpSessionRegistry } from './mcp-sessions.js';

const transport = () => ({ closed: 0, async close() { this.closed++; } });

test('registry has a hard count limit even before an idle timeout', () => {
  const sessions = new McpSessionRegistry({ maxSessions: 4 });
  for (let i = 0; i < 4; i++) sessions.register(String(i), transport());
  assert.throws(() => sessions.register('overflow', transport()), /capacity/);
  assert.equal(sessions.size, 4);
});

test('LRU capacity recycling excludes in-flight handlers and counts concurrent reservations', async () => {
  let now = 0;
  const sessions = new McpSessionRegistry({ maxSessions: 2, now: () => now });
  const active = transport(), idle = transport();
  sessions.register('active', active);
  const finish = sessions.beginRequest('active')!;
  now = 1; sessions.register('idle', idle);
  now = 100;
  const slot = await sessions.reserve(); assert.ok(slot);
  assert.deepEqual(slot.closed, [{ sessionId: 'idle' }]);
  assert.equal(idle.closed, 1); assert.equal(active.closed, 0);
  assert.equal(await sessions.reserve(), undefined, 'pending initialization owns the second slot');
  slot.register('new', transport());
  const finishNew = sessions.beginRequest('new')!;
  assert.equal(await sessions.reserve(), undefined, 'all sessions are busy');
  assert.deepEqual(await sessions.closeIdle(1), [], 'busy work survives timeout');
  finish(); finish();
  now = 101;
  assert.deepEqual(await sessions.closeIdle(1), [{ sessionId: 'active' }]);
  finishNew(); await sessions.closeAll();
});

test('failed initialization releases its slot and close errors do not leak reservations', async () => {
  const sessions = new McpSessionRegistry({ maxSessions: 1 });
  const slot = await sessions.reserve(); assert.ok(slot);
  assert.equal(await sessions.reserve(), undefined);
  slot.release(); slot.release();
  const next = await sessions.reserve(); assert.ok(next);
  const error = new Error('fixture close failure');
  next.register('old', { close: async () => { throw error; } });
  const replacement = await sessions.reserve(); assert.ok(replacement);
  assert.equal(replacement.closed[0].error, error);
  replacement.register('replacement', transport());
  assert.equal(sessions.size, 1);
  await sessions.closeAll();
});


test('concurrent reservations count before any server is constructed or registered', async () => {
  const sessions = new McpSessionRegistry({ maxSessions: 2 });
  const slots = await Promise.all(Array.from({ length: 8 }, () => sessions.reserve()));
  assert.equal(slots.filter(Boolean).length, 2);
  slots.forEach((slot, index) => slot?.register(String(index), transport()));
  assert.equal(sessions.size, 2);
  await sessions.closeAll();
});

test('cancellation releases a batch HTTP lease only after its other responses settle', async () => {
  let now = 0;
  const sessions = new McpSessionRegistry({ maxSessions: 1, now: () => now });
  sessions.register('batch', transport());
  const finishHttp = sessions.beginHttpRequest('batch', [1, 2])!;
  const finishTool = sessions.beginRequest('batch')!;
  sessions.settleRequest('batch', 1, true);
  now = 100;
  assert.deepEqual(await sessions.closeIdle(1), []);
  finishTool();
  assert.deepEqual(await sessions.closeIdle(1), [], 'unflushed sibling response still owns HTTP');
  sessions.settleRequest('batch', 2);
  now = 101;
  assert.deepEqual(await sessions.closeIdle(1), [{ sessionId: 'batch' }]);
  finishHttp();
});
