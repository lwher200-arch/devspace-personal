import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContextCapsule,
  ContextBudgetExceededError,
  contextStatementSchema,
  type ContextAnchor,
  type ContextDelta,
  type EvidenceRef,
} from "./context-fabric.js";

const now = "2026-09-18T15:00:00.000+00:00";
const digest = "b".repeat(64);
const evidence = (evidenceId: string): EvidenceRef => ({
  version: 1,
  evidenceId,
  kind: "decision",
  locator: `decision://${evidenceId}`,
  digest,
});

test("factual folded statements require evidence while objectives may remain intent-only", () => {
  assert.throws(() => contextStatementSchema.parse({
    statementId: "fact-1",
    role: "state",
    text: "The build passed.",
    estimatedTokens: 4,
  }));
  assert.doesNotThrow(() => contextStatementSchema.parse({
    statementId: "goal-1",
    role: "objective",
    text: "Reduce repeated context.",
    estimatedTokens: 4,
  }));
});

test("Pattern Folding applies deltas and explicit supersession instead of replaying stale state", () => {
  const anchor: ContextAnchor = {
    version: 1,
    anchorId: "anchor-1",
    createdAt: now,
    stateDigest: digest,
    evidenceRefs: [evidence("ev-old"), evidence("ev-new")],
    statements: [{
      statementId: "state-old",
      role: "state",
      text: "Relay contract is pending.",
      evidenceIds: ["ev-old"],
      supersedes: [],
      estimatedTokens: 5,
      priority: 50,
      required: false,
    }],
  };
  const delta: ContextDelta = {
    version: 1,
    deltaId: "delta-1",
    baseAnchorId: "anchor-1",
    sequence: 1,
    createdAt: now,
    evidenceRefs: [evidence("ev-new")],
    changes: [{
      statementId: "state-new",
      role: "change",
      text: "Relay contract tests pass.",
      evidenceIds: ["ev-new"],
      supersedes: ["state-old"],
      estimatedTokens: 5,
      priority: 50,
      required: false,
    }],
    exceptions: [],
  };
  const capsule = buildContextCapsule({
    anchor,
    deltas: [delta],
    objective: "Continue Control Hub work.",
    objectiveEstimatedTokens: 5,
    budget: { maxTokens: 50, reserveTokens: 10, maxStatements: 8 },
  });
  assert.deepEqual(capsule.statements.map(statement => statement.statementId), ["state-new"]);
  assert.deepEqual(capsule.evidenceRefs.map(ref => ref.evidenceId), ["ev-new"]);
});

test("budget selection preserves required context and prefers higher-value optional context", () => {
  const refs = ["ev-required", "ev-low", "ev-high"].map(evidence);
  const anchor: ContextAnchor = {
    version: 1,
    anchorId: "anchor-budget",
    createdAt: now,
    stateDigest: digest,
    evidenceRefs: refs,
    statements: [
      {
        statementId: "required",
        role: "invariant",
        text: "Cloud coordination never grants local execution authority.",
        evidenceIds: ["ev-required"],
        supersedes: [],
        estimatedTokens: 10,
        priority: 100,
        required: true,
      },
      {
        statementId: "low",
        role: "state",
        text: "Low-value historical detail.",
        evidenceIds: ["ev-low"],
        supersedes: [],
        estimatedTokens: 8,
        priority: 10,
        required: false,
      },
      {
        statementId: "high",
        role: "exception",
        text: "Current typecheck transport is unresolved.",
        evidenceIds: ["ev-high"],
        supersedes: [],
        estimatedTokens: 8,
        priority: 90,
        required: false,
      },
    ],
  };
  const capsule = buildContextCapsule({
    anchor,
    objective: "Continue safely.",
    objectiveEstimatedTokens: 4,
    budget: { maxTokens: 30, reserveTokens: 5, maxStatements: 3 },
  });
  assert.deepEqual(capsule.statements.map(statement => statement.statementId), ["required", "high"]);
  assert.deepEqual(capsule.omittedStatementIds, ["low"]);
  assert.equal(capsule.estimatedTokens, 22);
});

test("required context fails closed when it cannot fit the active budget", () => {
  const anchor: ContextAnchor = {
    version: 1,
    anchorId: "anchor-overflow",
    createdAt: now,
    stateDigest: digest,
    evidenceRefs: [evidence("ev-required")],
    statements: [{
      statementId: "required",
      role: "invariant",
      text: "This must never be silently discarded.",
      evidenceIds: ["ev-required"],
      supersedes: [],
      estimatedTokens: 20,
      priority: 100,
      required: true,
    }],
  };
  assert.throws(() => buildContextCapsule({
    anchor,
    objective: "Continue.",
    objectiveEstimatedTokens: 5,
    budget: { maxTokens: 20, reserveTokens: 5, maxStatements: 3 },
  }), ContextBudgetExceededError);
});

test("capsule construction rejects cross-anchor deltas and missing evidence references", () => {
  const anchor: ContextAnchor = {
    version: 1,
    anchorId: "anchor-a",
    createdAt: now,
    stateDigest: digest,
    evidenceRefs: [],
    statements: [],
  };
  const wrongDelta: ContextDelta = {
    version: 1,
    deltaId: "delta-wrong",
    baseAnchorId: "anchor-b",
    sequence: 0,
    createdAt: now,
    changes: [],
    exceptions: [],
    evidenceRefs: [],
  };
  assert.throws(() => buildContextCapsule({
    anchor,
    deltas: [wrongDelta],
    objective: "Continue.",
    objectiveEstimatedTokens: 2,
    budget: { maxTokens: 20, reserveTokens: 5, maxStatements: 3 },
  }));

  const missingEvidenceAnchor: ContextAnchor = {
    ...anchor,
    statements: [{
      statementId: "state-with-missing-ref",
      role: "state",
      text: "Referenced evidence must exist.",
      evidenceIds: ["missing"],
      supersedes: [],
      estimatedTokens: 4,
      priority: 50,
      required: true,
    }],
  };
  assert.throws(() => buildContextCapsule({
    anchor: missingEvidenceAnchor,
    objective: "Continue.",
    objectiveEstimatedTokens: 2,
    budget: { maxTokens: 20, reserveTokens: 5, maxStatements: 3 },
  }), /Missing EvidenceRef/);
});
