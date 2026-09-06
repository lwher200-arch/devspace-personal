import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runProjectCommand } from "./project-tools.js";

test("CLI project commands provide a guarded workflow for hosts with cached old schemas", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-project-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "a.txt"), "old\n");
  const page = await runProjectCommand(root, ["read", "--path", "a.txt", "--json"]) as { sha256: string };
  const request = { patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch", expectedHashes: { "a.txt": page.sha256 } };
  await writeFile(join(root, "request.json"), JSON.stringify(request));
  const preview = await runProjectCommand(root, ["patch", "--request-file", "request.json", "--dry-run"]) as { dryRun: boolean };
  assert.equal(preview.dryRun, true);
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "old\n");
  await runProjectCommand(root, ["patch", "--request-file", "request.json"]);
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "new\n");
  await assert.rejects(runProjectCommand(root, ["read", "--path", "a.txt", "--offset", "NaN"]));
  await assert.rejects(runProjectCommand(root, ["files", "--query", "invalid"]));
  await assert.rejects(runProjectCommand(root, ["patch", "--request-file", "../outside.json"]));
});
