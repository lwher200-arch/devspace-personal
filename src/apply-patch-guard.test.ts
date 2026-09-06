import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyPatch } from "./apply-patch.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** Add File: b.txt\n+created\n*** End Patch";

test("patch dry run validates every action without writing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-dry-patch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "a.txt"), "old\n");
  const result = await applyPatch(root, patch, { dryRun: true, expectedHashes: { "a.txt": sha("old\n"), "b.txt": null } });
  assert.equal(result.dryRun, true);
  assert.equal(result.files.length, 2);
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "old\n");
  await assert.rejects(readFile(join(root, "b.txt")), { code: "ENOENT" });
});

test("stale or incomplete hash guards reject the whole patch without partial writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-stale-patch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "a.txt"), "old\nuser change\n");
  await assert.rejects(applyPatch(root, patch, { expectedHashes: { "a.txt": sha("old\n"), "b.txt": null } }), /changed|hash/i);
  await assert.rejects(applyPatch(root, patch, { expectedHashes: { "a.txt": sha("old\nuser change\n") } }), /missing|every|complete/i);
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "old\nuser change\n");
  await assert.rejects(readFile(join(root, "b.txt")), { code: "ENOENT" });
  const applied = await applyPatch(root, patch, { expectedHashes: { "a.txt": sha("old\nuser change\n"), "b.txt": null } });
  assert.equal(applied.dryRun, false);
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "new\nuser change\n");
});

test("UTF-8 BOM and CRLF survive a first-line patch and hashes use actual file bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-bom-patch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = "\ufeffold\r\nsecond\r\n";
  await writeFile(join(root, "a.txt"), original);
  await applyPatch(root, "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n second\n*** End Patch", { expectedHashes: { "a.txt": sha(original) } });
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "\ufeffnew\r\nsecond\r\n");
});
