import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForBrowserEndpoint } from './browser-protocol.js';

test('browser startup waits for transient locks and complete endpoint content', async () => {
  let now = 0, calls = 0;
  const values = [Object.assign(Error('not ready'), { code: 'ENOENT' }), Object.assign(Error('locked'), { code: 'EBUSY' }), '9222\n', '9222\n/devtools/browser/fixture-id\n'];
  const endpoint = await waitForBrowserEndpoint('fixture-only', {
    timeoutMs: 100, now: () => now, wait: async () => { now += 10; },
    read: async () => { const value = values[calls++]; if (value instanceof Error) throw value; return value; },
  });
  assert.deepEqual(endpoint, { port: 9222, path: '/devtools/browser/fixture-id' });
  assert.equal(calls, 4);
});

test('browser startup does not retry access-denied errors', async () => {
  let waits = 0;
  await assert.rejects(waitForBrowserEndpoint('fixture-only', {
    read: async () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); },
    wait: async () => { waits++; },
  }), /denied/);
  assert.equal(waits, 0);
});

test('incomplete endpoint content has a bounded startup deadline', async () => {
  let now = 0;
  await assert.rejects(waitForBrowserEndpoint('fixture-only', {
    timeoutMs: 3, now: () => now, wait: async () => { now++; }, read: async () => '9222\n',
  }), /before the deadline/);
  assert.equal(now, 3);
});

test('a browser launch failure stops before reading its endpoint', async () => {
  await assert.rejects(waitForBrowserEndpoint('fixture-only', {
    stopped: () => Error('fixture browser exited'), read: async () => { throw Error('must not read'); },
  }), /fixture browser exited/);
});
