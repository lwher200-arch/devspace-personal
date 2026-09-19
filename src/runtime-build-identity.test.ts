import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readProductVersion, readRuntimeBuildIdentity } from "./runtime-build-identity.js";

test("runtime build identity exposes a verifiable build/UI contract without local paths", t => {
  const root = mkdtempSync(join(tmpdir(), "devspace-runtime-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "dist/ui/.vite"), { recursive: true });
  const fingerprint = "a".repeat(64);
  const uiManifest = '{"workspace-app.html":{"file":"assets/app.js"}}';
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
  writeFileSync(join(root, "dist/.deploy-manifest.json"), JSON.stringify({ version: 1, fingerprint, node: "24.1.0", packageManager: "pnpm@11.25.0" }));
  writeFileSync(join(root, "dist/ui/.vite/manifest.json"), uiManifest);
  assert.equal(readProductVersion(root), "9.9.9");
  const verified = readRuntimeBuildIdentity({ root, startupSourceFingerprint: fingerprint });
  assert.equal(verified.productVersion, "9.9.9");
  assert.equal(verified.buildFingerprint, fingerprint);
  assert.equal(verified.startupSourceFingerprint, fingerprint);
  assert.equal(verified.freshness, "verified");
  assert.equal(verified.uiManifestSha256, createHash("sha256").update(uiManifest).digest("hex"));
  assert.match(verified.widgetUri, /^ui:\/\/devspace\//);
  assert.equal(JSON.stringify(verified).includes(root), false, "runtime identity must not disclose the checkout path");
  assert.equal(readRuntimeBuildIdentity({ root, startupSourceFingerprint: "b".repeat(64) }).freshness, "mismatch");
  assert.equal(readRuntimeBuildIdentity({ root }).freshness, "unverified");
});
