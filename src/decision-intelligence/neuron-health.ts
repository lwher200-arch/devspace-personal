import type { DecisionBenchmarkReport } from "./benchmark.js";

export const NEURON_LIFECYCLE_STATES = [
  "candidate",
  "validated",
  "promoted",
  "degraded",
  "quarantined",
  "retired",
] as const;

export type NeuronLifecycleState = typeof NEURON_LIFECYCLE_STATES[number];

export interface DecisionNeuronIdentity {
  neuronId: string;
  version: string;
  lifecycleState: NeuronLifecycleState;
  observedAt: string;
}

export interface DecisionNeuronHealthMetrics {
  accuracy: number;
  meanBrierScore: number;
  expectedCalibrationError: number;
  falseSafeRate: number | null;
  falseAlarmRate: number | null;
  scoreMeanAbsoluteError: number | null;
  meanLatencyMs: number;
  p95LatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number | null;
}

export interface DecisionNeuronHealthEvidence {
  schemaVersion: 1;
  kind: "decision-neuron-health";
  authority: "advisory";
  source: "decision-benchmark";
  neuron: DecisionNeuronIdentity;
  benchmark: {
    providerId: string;
    models: string[];
    caseCount: number;
    evaluatedAnswers: number;
  };
  coverage: {
    hasSafetyGroundTruth: boolean;
    hasScoreGroundTruth: boolean;
  };
  metrics: DecisionNeuronHealthMetrics;
}

export interface RcfDecisionNeuronObservation {
  phase: "observe";
  kind: "decision-neuron-health";
  authority: "evidence_only";
  neuronId: string;
  neuronVersion: string;
  lifecycleState: NeuronLifecycleState;
  observedAt: string;
  benchmark: DecisionNeuronHealthEvidence["benchmark"];
  coverage: DecisionNeuronHealthEvidence["coverage"];
  metrics: DecisionNeuronHealthMetrics;
  constraints: {
    canAuthorize: false;
    canPromote: false;
    canOverrideHold: false;
    canOverrideQuarantine: false;
    canOverrideFreeze: false;
  };
}

export function buildDecisionNeuronHealthEvidence(
  report: DecisionBenchmarkReport,
  neuron: DecisionNeuronIdentity,
): DecisionNeuronHealthEvidence {
  validateNeuronIdentity(neuron);
  validateBenchmarkReport(report);

  return {
    schemaVersion: 1,
    kind: "decision-neuron-health",
    authority: "advisory",
    source: "decision-benchmark",
    neuron: {
      ...neuron,
    },
    benchmark: {
      providerId: report.providerId,
      models: [...report.models],
      caseCount: report.metrics.caseCount,
      evaluatedAnswers: report.metrics.evaluatedAnswers,
    },
    coverage: {
      hasSafetyGroundTruth:
        report.metrics.falseSafeRate !== null ||
        report.metrics.falseAlarmRate !== null,
      hasScoreGroundTruth: report.metrics.scoreMeanAbsoluteError !== null,
    },
    metrics: {
      accuracy: report.metrics.accuracy,
      meanBrierScore: report.metrics.meanBrierScore,
      expectedCalibrationError: report.metrics.expectedCalibrationError,
      falseSafeRate: report.metrics.falseSafeRate,
      falseAlarmRate: report.metrics.falseAlarmRate,
      scoreMeanAbsoluteError: report.metrics.scoreMeanAbsoluteError,
      meanLatencyMs: report.metrics.meanLatencyMs,
      p95LatencyMs: report.metrics.p95LatencyMs,
      totalInputTokens: report.metrics.totalInputTokens,
      totalOutputTokens: report.metrics.totalOutputTokens,
      totalCostUsd: report.metrics.totalCostUsd,
    },
  };
}

export function toRcfDecisionNeuronObservation(
  evidence: DecisionNeuronHealthEvidence,
): RcfDecisionNeuronObservation {
  validateHealthEvidence(evidence);
  return {
    phase: "observe",
    kind: evidence.kind,
    authority: "evidence_only",
    neuronId: evidence.neuron.neuronId,
    neuronVersion: evidence.neuron.version,
    lifecycleState: evidence.neuron.lifecycleState,
    observedAt: evidence.neuron.observedAt,
    benchmark: {
      ...evidence.benchmark,
      models: [...evidence.benchmark.models],
    },
    coverage: { ...evidence.coverage },
    metrics: { ...evidence.metrics },
    constraints: {
      canAuthorize: false,
      canPromote: false,
      canOverrideHold: false,
      canOverrideQuarantine: false,
      canOverrideFreeze: false,
    },
  };
}

function validateNeuronIdentity(neuron: DecisionNeuronIdentity): void {
  if (!neuron.neuronId.trim()) {
    throw new TypeError("Decision neuron id must not be blank.");
  }
  if (!neuron.version.trim()) {
    throw new TypeError("Decision neuron version must not be blank.");
  }
  if (!NEURON_LIFECYCLE_STATES.includes(neuron.lifecycleState)) {
    throw new TypeError("Decision neuron lifecycle state is invalid.");
  }
  if (!neuron.observedAt.trim() || Number.isNaN(Date.parse(neuron.observedAt))) {
    throw new TypeError("Decision neuron observedAt must be a valid date-time.");
  }
}

function validateBenchmarkReport(report: DecisionBenchmarkReport): void {
  if (!report.providerId.trim()) {
    throw new TypeError("Decision neuron benchmark provider id must not be blank.");
  }
  if (!Number.isSafeInteger(report.metrics.caseCount) || report.metrics.caseCount < 1) {
    throw new TypeError("Decision neuron benchmark case count must be a positive integer.");
  }
  if (
    !Number.isSafeInteger(report.metrics.evaluatedAnswers) ||
    report.metrics.evaluatedAnswers < 1
  ) {
    throw new TypeError(
      "Decision neuron benchmark evaluated answer count must be a positive integer.",
    );
  }
  validateUnitInterval(report.metrics.accuracy, "accuracy");
  validateUnitInterval(report.metrics.meanBrierScore, "mean Brier score");
  validateUnitInterval(
    report.metrics.expectedCalibrationError,
    "expected calibration error",
  );
  validateOptionalUnitInterval(report.metrics.falseSafeRate, "false-safe rate");
  validateOptionalUnitInterval(report.metrics.falseAlarmRate, "false-alarm rate");
  validateOptionalNonNegativeFinite(
    report.metrics.scoreMeanAbsoluteError,
    "score mean absolute error",
  );
  validateNonNegativeFinite(report.metrics.meanLatencyMs, "mean latency");
  validateNonNegativeFinite(report.metrics.p95LatencyMs, "p95 latency");
  validateNonNegativeInteger(report.metrics.totalInputTokens, "total input tokens");
  validateNonNegativeInteger(report.metrics.totalOutputTokens, "total output tokens");
  validateOptionalNonNegativeFinite(report.metrics.totalCostUsd, "total cost");
}

function validateHealthEvidence(evidence: DecisionNeuronHealthEvidence): void {
  if (evidence.schemaVersion !== 1) {
    throw new TypeError("Unsupported decision neuron health schema version.");
  }
  if (
    evidence.kind !== "decision-neuron-health" ||
    evidence.authority !== "advisory" ||
    evidence.source !== "decision-benchmark"
  ) {
    throw new TypeError("Decision neuron health evidence provenance is invalid.");
  }
  validateNeuronIdentity(evidence.neuron);
  validateBenchmarkReport({
    providerId: evidence.benchmark.providerId,
    models: evidence.benchmark.models,
    samples: [],
    metrics: {
      ...evidence.metrics,
      caseCount: evidence.benchmark.caseCount,
      evaluatedAnswers: evidence.benchmark.evaluatedAnswers,
    },
  });
}

function validateUnitInterval(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError("Decision neuron " + label + " must be between 0 and 1.");
  }
}

function validateOptionalUnitInterval(value: number | null, label: string): void {
  if (value !== null) validateUnitInterval(value, label);
}

function validateNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError("Decision neuron " + label + " must be non-negative and finite.");
  }
}

function validateOptionalNonNegativeFinite(value: number | null, label: string): void {
  if (value !== null) validateNonNegativeFinite(value, label);
}

function validateNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Decision neuron " + label + " must be a non-negative integer.");
  }
}
