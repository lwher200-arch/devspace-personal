import assert from "node:assert/strict";
import test from "node:test";
import { isExpandableCard, reviewPreviewFileCount, reviewPreviewMessage } from "./card-types.js";

test("aggregate review opens when a patch is available", () => {
  const card = {
    tool: "show_changes" as const,
    files: [{ path: "src/a.ts", type: "change" as const }],
    payload: { patch: "diff --git a/src/a.ts b/src/a.ts" },
  };
  assert.equal(isExpandableCard(card), true);
});

test("workspace details open only when there is useful context", () => {
  assert.equal(isExpandableCard({ tool: "open_workspace" }), false);
  assert.equal(isExpandableCard({
    tool: "open_workspace",
    skills: [{ name: "research" }],
  }), true);
  assert.equal(isExpandableCard({
    tool: "open_workspace",
    review: { available: false, reason: "Not a Git repository." },
  }), true);
});

test("bounded review metadata reports preview coverage without overstating visible files", () => {
  const card = {
    tool: "show_changes" as const,
    files: [{ path: "large.bin" }, { path: "small.txt" }],
    preview: { complete: false, includedFiles: 1, totalFiles: 2, omittedFiles: 1 },
  };
  assert.equal(reviewPreviewFileCount(card), 1);
  assert.equal(
    reviewPreviewMessage(card),
    "Diff preview includes 1 of 2 changed files; 1 file omitted by preview limits. File statistics are complete.",
  );
});
