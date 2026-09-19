import assert from "node:assert/strict";
import test from "node:test";
import type { DecisionBenchmarkReport } from "./benchmark.js";
import {
  buildDecisionNeuronHealthEvidence,
  toRcfDecisionNeuronObservation,
} from "./neuron-health.js";

function report(
  overrides: Partial<DecisionBenchmarkReport["metrics"]> = {},
): DecisionBenchmarkReport {
  return {
    providerId: "fixture-provider",
    models: ["fixture-model"],
    samples: [],
    metrics: {
      caseCount: 20,
      evaluatedAnswers: 40,
      accuracy: 0.9,
      meanBrierScore: 0.08,
      expectedCalibrationError: 0.04,
      falseSafeRate: 0.025,
      falseAlarmRate: 0.05,
      scoreMeanAbsoluteError: 0.2,
      meanLatencyMs: 30,
      p95LatencyMs: 55,
      totalInputTokens: 1_000,
      totalOutputTokens: 200,
      totalCostUsd: 0.01,
      ...overrides,
    },
  };
}

const identity = {
  neuronId: "mutation-risk-observer",
  version: "0.1.0",
  lifecycleState: "candidate" as const,
  observedAt: "2026-09-19T08:00:00.000Z",
};

test("neuron health evidence preserves measured benchmark facts without inventing a health score", () => {
  const evidence = buildDecisionNeuronHealthEvidence(report(), identity);
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.authority, "advisory");
  assert.equal(evidence.coverage.hasSafetyGroundTruth, true);
  assert.equal(evidence.coverage.hasScoreGroundTruth, true);
  assert.equal(evidence.metrics.falseSafeRate, 0.025);
  assert.equal("healthScore" in evidence, false);
  assert.equal("riskLevel" in evidence, false);
  assert.equal("recommendedLifecycleState" in evidence, false);
});

test("missing safety and score labels remain explicit coverage gaps", () => {
  const evidence = buildDecisionNeuronHealthEvidence(
    report({
      falseSafeRate: null,
      falseAlarmRate: null,
      scoreMeanAbsoluteError: null,
    }),
    identity,
  );
  assert.deepEqual(evidence.coverage, {
    hasSafetyGroundTruth: false,
    hasScoreGroundTruth: false,
  });
  assert.equal(evidence.metrics.falseSafeRate, null);
  assert.equal(evidence.metrics.falseAlarmRate, null);
});

test("RCF adapter stays observe-only and cannot grant or override authority", () => {
  const observation = toRcfDecisionNeuronObservation(
    buildDecisionNeuronHealthEvidence(report(), identity),
  );
  assert.equal(observation.phase, "observe");
  assert.equal(observation.authority, "evidence_only");
  assert.deepEqual(observation.constraints, {
    canAuthorize: false,
    canPromote: false,
    canOverrideHold: false,
    canOverrideQuarantine: false,
    canOverrideFreeze: false,
  });
  assert.equal("riskLevel" in observation, false);
});

test("neuron health evidence fails closed on malformed metrics and identity", () => {
  assert.throws(
    () => buildDecisionNeuronHealthEvidence(report({ accuracy: 1.01 }), identity),
    /accuracy must be between 0 and 1/,
  );
  assert.throws(
    () => buildDecisionNeuronHealthEvidence(report(), { ...identity, neuronId: " " }),
    /id must not be blank/,
  );
  assert.throws(
    () => buildDecisionNeuronHealthEvidence(
      report({ evaluatedAnswers: 0 }),
      identity,
    ),
    /evaluated answer count must be a positive integer/,
  );
});
