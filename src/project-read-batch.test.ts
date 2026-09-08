import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { projectRead } from "./project-access.js";
import { projectReadBatch, type ProjectReadBatchInput } from "./project-read-batch.js";
import { runProjectCommand } from "./project-tools.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "devspace-read-batch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("batch reads preserve request order and successful single-read contracts alongside errors", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "unicode.txt"), "\ufefffirst\r\n\u4e2d\ud83d\ude00last");
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
  const item = { path: "unicode.txt", offset: 2, limit: 3 };
  const single = await projectRead(root, item);
  const batch = await projectReadBatch(root, { items: [
    item, { path: "missing.txt" }, { path: "binary.bin" }, { path: "unicode.txt" },
  ] });
  assert.deepEqual(batch.results.map(row => row.index), [0, 1, 2, 3]);
  assert.deepEqual(batch.results[0], { index: 0, status: "ok", ...single });
  assert.equal(batch.results[1].status, "error");
  if (batch.results[1].status === "error") assert.equal(batch.results[1].error.code, "NOT_FOUND");
  assert.equal(batch.results[2].status, "error");
  if (batch.results[2].status === "error") assert.equal(batch.results[2].error.code, "UNSUPPORTED_FILE");
  assert.equal(batch.results[3].status, "ok");
  assert.equal(batch.hasErrors, true);
  assert.equal(batch.complete, false);
  assert.equal(batch.snapshot, "per-file");
  assert.deepEqual(batch.continuation?.items, [{ ...item, offset: single.nextOffset, expectedSha256: single.sha256 }]);
});

test("batch JSON budgets include Unicode, escaping, metadata and continuations without losing text", async t => {
  const root = await fixture(t);
  const expected = new Map<string, string>();
  for (let index = 0; index < 8; index++) {
    const path = `\u6587\u4ef6-${index}.txt`;
    const content = "\ufeff" + `${index}\ud83d\ude00\u4e2d\"\\\t\r\n`.repeat(700) + "end";
    expected.set(path, content);
    await writeFile(join(root, path), content);
  }
  const observed = new Map([...expected.keys()].map(path => [path, ""]));
  const hashes = new Map<string, string>();
  let request: ProjectReadBatchInput | undefined = {
    items: [...expected.keys()].map(path => ({ path })), maxResultBytes: 8192,
  };
  let calls = 0;
  while (request) {
    assert.ok(++calls < 100, "continuation must make progress");
    const batch = await projectReadBatch(root, request);
    assert.ok(Buffer.byteLength(JSON.stringify(batch), "utf8") <= 8192);
    assert.equal(batch.hasErrors, false);
    assert.ok(batch.results.length > 0);
    for (const row of batch.results) {
      assert.equal(row.status, "ok");
      if (row.status !== "ok") continue;
      assert.equal(row.offset, observed.get(row.path)!.length);
      assert.equal(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(row.text), false);
      if (hashes.has(row.path)) assert.equal(row.sha256, hashes.get(row.path));
      else hashes.set(row.path, row.sha256);
      observed.set(row.path, observed.get(row.path)! + row.text);
    }
    for (const item of batch.continuation?.items ?? []) {
      if ((item.offset ?? 0) > 0) assert.equal(item.expectedSha256, hashes.get(item.path));
    }
    request = batch.continuation;
    if (!request) assert.equal(batch.complete, true);
  }
  assert.ok(calls > 1);
  assert.deepEqual(observed, expected);
});

test("batch continuation rejects changed hashes and provides an explicit fresh-read recovery", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "changing.txt"), "original\n".repeat(2000));
  const first = await projectReadBatch(root, { items: [{ path: "changing.txt" }], maxResultBytes: 8192 });
  assert.ok(first.continuation);
  await writeFile(join(root, "changing.txt"), "replacement\n");
  const stale = await projectReadBatch(root, first.continuation!);
  assert.equal(stale.hasErrors, true);
  assert.equal(stale.complete, false);
  assert.equal(stale.continuation, undefined);
  const failure = stale.results[0];
  assert.equal(failure.status, "error");
  if (failure.status !== "error") return;
  assert.equal(failure.error.code, "HASH_MISMATCH");
  assert.equal("text" in failure, false);
  assert.ok(failure.error.recovery);
  assert.equal(failure.error.recovery.expectedSha256, undefined);
  const fresh = await projectReadBatch(root, { items: [failure.error.recovery] });
  assert.equal(fresh.complete, true);
  assert.equal(fresh.results[0].status, "ok");
  if (fresh.results[0].status === "ok") assert.equal(fresh.results[0].text, "replacement\n");
});

test("all batch paths are preflighted and traversal or junction escapes reject the entire request", async t => {
  const temporary = await fixture(t);
  const root = join(temporary, "project");
  const outside = join(temporary, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(root, "ordinary.txt"), "workspace body");
  await writeFile(join(outside, "outside.txt"), "outside body");
  await symlink(outside, join(root, "escape"), "junction");
  for (const path of ["../outside/outside.txt", "escape/outside.txt", join(outside, "outside.txt"), "bad\0path"]) {
    await assert.rejects(projectReadBatch(root, { items: [{ path: "ordinary.txt" }, { path }] }));
  }
});

test("batch validates ranges and item count and handles empty files and invalid offsets", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "empty.txt"), "");
  await writeFile(join(root, "emoji.txt"), "\ud83d\ude00end");
  const batch = await projectReadBatch(root, { items: [{ path: "empty.txt" }, { path: "emoji.txt", offset: 1 }] });
  assert.equal(batch.results[0].status, "ok");
  if (batch.results[0].status === "ok") {
    assert.equal(batch.results[0].text, "");
    assert.equal(batch.results[0].complete, true);
  }
  assert.equal(batch.results[1].status, "error");
  if (batch.results[1].status === "error") assert.equal(batch.results[1].error.code, "INVALID_OFFSET");
  for (const input of [
    { items: [] }, { items: Array.from({ length: 9 }, () => ({ path: "empty.txt" })) },
    { items: [{ path: "empty.txt", limit: 1 }] }, { items: [{ path: "empty.txt", offset: -1 }] },
    { items: [{ path: "empty.txt", expectedSha256: "invalid" }] },
    { items: [{ path: "empty.txt" }], maxResultBytes: 8191 },
    { items: [{ path: "empty.txt" }], maxResultBytes: 262145 },
  ]) await assert.rejects(projectReadBatch(root, input));
});

test("CLI read-batch uses the guarded request-file reader and rejects invalid request fields", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "file.txt"), "cli read\n");
  await writeFile(join(root, "batch.json"), JSON.stringify({ items: [{ path: "file.txt" }], maxResultBytes: 8192 }));
  const result = await runProjectCommand(root, ["read-batch", "--request-file", "batch.json", "--json"]) as Awaited<ReturnType<typeof projectReadBatch>>;
  assert.equal(result.complete, true);
  assert.equal(result.results[0].status, "ok");
  if (result.results[0].status === "ok") assert.equal(result.results[0].text, "cli read\n");
  await assert.rejects(runProjectCommand(root, ["read-batch", "--request-file", "../outside.json"]));
  await assert.rejects(runProjectCommand(root, ["read-batch", "--request-file", "batch.json", "--path", "file.txt"]));
  await writeFile(join(root, "batch.json"), JSON.stringify({ items: [{ path: "file.txt", extra: true }] }));
  await assert.rejects(runProjectCommand(root, ["read-batch", "--request-file", "batch.json"]));
});

test("oversized request and first-result metadata fail with bounded actionable budget errors", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "large.txt"), "x".repeat(15000));
  // Redundant relative components keep the actual filesystem path short while
  // exercising large caller-visible metadata without platform path-size limits.
  const path = "./".repeat(2000) + "large.txt";
  await assert.rejects(projectReadBatch(root, {
    items: [{ path }, { path }, { path }], maxResultBytes: 8192,
  }), /metadata exceeds maxResultBytes/);
  await assert.rejects(projectReadBatch(root, { items: [{ path }], maxResultBytes: 8192 }), /first result cannot fit/);
  const increased = await projectReadBatch(root, { items: [{ path }], maxResultBytes: 16384 });
  assert.ok(Buffer.byteLength(JSON.stringify(increased), "utf8") <= 16384);
  assert.equal(increased.results[0].status, "ok");
  if (increased.results[0].status === "ok") assert.ok(increased.results[0].text.length > 0);
});
