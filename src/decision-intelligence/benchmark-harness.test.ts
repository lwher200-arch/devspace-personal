import assert from "node:assert/strict";
import test from "node:test";
import {
  compareDecisionProviders,
  runDecisionBenchmark,
  type DecisionBenchmarkCase,
} from "./benchmark.js";
import type {
  DecisionIntelligenceProvider,
  DecisionRequest,
  DecisionResult,
} from "./types.js";

class ScriptedProvider implements DecisionIntelligenceProvider {
  constructor(
    readonly id: string,
    private readonly results: Record<string, DecisionResult>,
  ) {}

  async evaluate(request: DecisionRequest): Promise<DecisionResult> {
    const key = typeof request.state === "string"
      ? request.state
      : String((request.state as Record<string, unknown>).caseId);
    const result = this.results[key];
    if (!result) throw new Error("Missing scripted result for " + key);
    return result;
  }
}

const scriptedResults: Record<string, DecisionResult> = {
  "unsafe-detected": {
    provider: "scripted",
    model: "fixture",
    answers: { risk: { type: "noul", noul: 0.9 } },
    usage: { inputTokens: 10, outputTokens: 1 },
  },
  "safe-correct": {
    provider: "scripted",
    model: "fixture",
    answers: { risk: { type: "noul", noul: 0.2 } },
    usage: { inputTokens: 20, outputTokens: 2 },
  },
  "unsafe-missed": {
    provider: "scripted",
    model: "fixture",
    answers: {
      route: {
        type: "choice",
        choice: "promote",
        probabilities: { promote: 0.6, quarantine: 0.4 },
        confidence: 0.2,
      },
    },
    usage: { inputTokens: 30, outputTokens: 3 },
  },
};

const cases: DecisionBenchmarkCase[] = [
  {
    id: "unsafe-detected",
    request: {
      state: "unsafe-detected",
      questions: { risk: { type: "noul", instructions: "unsafe?" } },
    },
    expected: { risk: { type: "noul", value: true, unsafeValue: true } },
  },
  {
    id: "safe-correct",
    request: {
      state: "safe-correct",
      questions: { risk: { type: "noul", instructions: "unsafe?" } },
    },
    expected: { risk: { type: "noul", value: false, unsafeValue: true } },
  },
  {
    id: "unsafe-missed",
    request: {
      state: "unsafe-missed",
      questions: {
        route: {
          type: "choice",
          instructions: "route",
          criteria: { promote: null, quarantine: null },
        },
      },
    },
    expected: {
      route: {
        type: "choice",
        value: "quarantine",
        unsafeLabels: ["quarantine"],
      },
    },
  },
];

test("benchmark harness measures accuracy, calibration, safety errors, tokens and cost", async () => {
  const report = await runDecisionBenchmark(
    new ScriptedProvider("scripted", scriptedResults),
    cases,
    {
      calibrationBins: 5,
      pricing: {
        inputUsdPerMillionTokens: 2,
        outputUsdPerMillionTokens: 4,
      },
    },
  );
  assert.equal(report.providerId, "scripted");
  assert.deepEqual(report.models, ["fixture"]);
  assert.equal(report.metrics.caseCount, 3);
  assert.equal(report.metrics.evaluatedAnswers, 3);
  assert.equal(report.metrics.accuracy, 2 / 3);
  assert.equal(report.metrics.falseSafeRate, 1 / 2);
  assert.equal(report.metrics.falseAlarmRate, 0);
  assert.equal(report.metrics.totalInputTokens, 60);
  assert.equal(report.metrics.totalOutputTokens, 6);
  assert.ok(report.metrics.meanBrierScore >= 0 && report.metrics.meanBrierScore <= 1);
  assert.ok(
    report.metrics.expectedCalibrationError >= 0 &&
    report.metrics.expectedCalibrationError <= 1,
  );
  assert.ok(
    report.metrics.totalCostUsd !== null &&
    Math.abs(report.metrics.totalCostUsd - 0.000144) < 1e-12,
  );
});

test("benchmark harness evaluates score levels and score absolute error", async () => {
  const provider = new ScriptedProvider("score-provider", {
    score: {
      provider: "score-provider",
      model: "fixture",
      answers: {
        severity: {
          type: "score",
          score: 1.25,
          legend: { "0": "low", "1": "medium", "2": "high" },
          probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 },
          confidence: 0.5,
        },
      },
      usage: { inputTokens: 5, outputTokens: 1 },
    },
  });
  const report = await runDecisionBenchmark(provider, [{
    id: "score",
    request: {
      state: "score",
      questions: {
        severity: {
          type: "score",
          instructions: "severity",
          criteria: ["low", "medium", "high"],
        },
      },
    },
    expected: {
      severity: { type: "score", value: 1, unsafeAtOrAbove: 2 },
    },
  }]);
  assert.equal(report.metrics.accuracy, 1);
  assert.equal(report.metrics.scoreMeanAbsoluteError, 0.25);
  assert.equal(report.metrics.falseSafeRate, null);
  assert.equal(report.metrics.falseAlarmRate, 0);
});

test("benchmark harness fails closed on missing answers and compares providers without ranking", async () => {
  const broken = new ScriptedProvider("broken", {
    "unsafe-detected": {
      provider: "broken",
      model: "fixture",
      answers: {},
      usage: { inputTokens: 1, outputTokens: 0 },
    },
  });
  await assert.rejects(
    runDecisionBenchmark(broken, [cases[0]!]),
    /missing answer for question risk/,
  );

  const reports = await compareDecisionProviders([
    { provider: new ScriptedProvider("scripted-a", scriptedResults) },
    { provider: new ScriptedProvider("scripted-b", scriptedResults) },
  ], [cases[0]!]);
  assert.deepEqual(reports.map(report => report.providerId), ["scripted-a", "scripted-b"]);

  await assert.rejects(
    compareDecisionProviders([
      { provider: new ScriptedProvider("duplicate", scriptedResults) },
      { provider: new ScriptedProvider("duplicate", scriptedResults) },
    ], [cases[0]!]),
    /provider ids must be unique/,
  );
});
