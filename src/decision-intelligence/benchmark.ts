import type {
  DecisionAnswer,
  DecisionIntelligenceProvider,
  DecisionRequest,
  DecisionResult,
} from "./types.js";

export interface DecisionBenchmarkSample {
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  result: DecisionResult;
}

export type BenchmarkExpectedAnswer =
  | { type: "noul"; value: boolean; unsafeValue?: boolean }
  | { type: "choice"; value: string; unsafeLabels?: string[] }
  | { type: "score"; value: number; unsafeAtOrAbove?: number };

export interface DecisionBenchmarkCase {
  id: string;
  request: DecisionRequest;
  expected: Record<string, BenchmarkExpectedAnswer>;
}

export interface DecisionBenchmarkPricing {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

export interface DecisionBenchmarkOptions {
  calibrationBins?: number;
  pricing?: DecisionBenchmarkPricing;
}

export interface DecisionBenchmarkPrediction {
  questionId: string;
  type: BenchmarkExpectedAnswer["type"];
  correct: boolean;
  confidence: number;
  brierScore: number;
  expectedUnsafe?: boolean;
  predictedUnsafe?: boolean;
  scoreAbsoluteError?: number;
}

export interface DecisionBenchmarkCaseResult extends DecisionBenchmarkSample {
  caseId: string;
  predictions: DecisionBenchmarkPrediction[];
  costUsd: number | null;
}

export interface DecisionBenchmarkMetrics {
  caseCount: number;
  evaluatedAnswers: number;
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

export interface DecisionBenchmarkReport {
  providerId: string;
  models: string[];
  samples: DecisionBenchmarkCaseResult[];
  metrics: DecisionBenchmarkMetrics;
}

export interface DecisionBenchmarkProviderConfig {
  provider: DecisionIntelligenceProvider;
  pricing?: DecisionBenchmarkPricing;
}

export async function benchmarkDecision(
  provider: DecisionIntelligenceProvider,
  request: DecisionRequest,
  now: () => number = () => performance.now(),
): Promise<DecisionBenchmarkSample> {
  const started = now();
  const result = await provider.evaluate(request);
  const finished = now();
  return {
    latencyMs: Math.max(0, finished - started),
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    result,
  };
}

export async function runDecisionBenchmark(
  provider: DecisionIntelligenceProvider,
  cases: readonly DecisionBenchmarkCase[],
  options: DecisionBenchmarkOptions = {},
): Promise<DecisionBenchmarkReport> {
  if (cases.length === 0) {
    throw new TypeError("Decision benchmark requires at least one case.");
  }
  const calibrationBins = options.calibrationBins ?? 10;
  if (!Number.isSafeInteger(calibrationBins) || calibrationBins < 2 || calibrationBins > 100) {
    throw new RangeError("calibrationBins must be an integer from 2 to 100.");
  }
  if (options.pricing) validatePricing(options.pricing);

  const seen = new Set<string>();
  const samples: DecisionBenchmarkCaseResult[] = [];
  for (const item of cases) {
    if (!item.id.trim()) throw new TypeError("Decision benchmark case ids must not be blank.");
    if (seen.has(item.id)) throw new TypeError("Decision benchmark case ids must be unique.");
    seen.add(item.id);
    if (Object.keys(item.expected).length === 0) {
      throw new TypeError("Decision benchmark cases require at least one expected answer.");
    }
    const sample = await benchmarkDecision(provider, item.request);
    samples.push({
      caseId: item.id,
      ...sample,
      predictions: evaluateExpectedAnswers(item.expected, sample.result.answers),
      costUsd: options.pricing ? estimateCost(sample, options.pricing) : null,
    });
  }

  return {
    providerId: provider.id,
    models: [...new Set(samples.map(sample => sample.result.model))].sort(),
    samples,
    metrics: aggregateMetrics(samples, calibrationBins),
  };
}

export async function compareDecisionProviders(
  providers: readonly DecisionBenchmarkProviderConfig[],
  cases: readonly DecisionBenchmarkCase[],
  options: Omit<DecisionBenchmarkOptions, "pricing"> = {},
): Promise<DecisionBenchmarkReport[]> {
  if (providers.length === 0) {
    throw new TypeError("Decision benchmark comparison requires at least one provider.");
  }
  const seen = new Set<string>();
  const reports: DecisionBenchmarkReport[] = [];
  for (const entry of providers) {
    if (seen.has(entry.provider.id)) {
      throw new TypeError("Decision benchmark provider ids must be unique.");
    }
    seen.add(entry.provider.id);
    reports.push(await runDecisionBenchmark(entry.provider, cases, {
      ...options,
      pricing: entry.pricing,
    }));
  }
  return reports;
}

function evaluateExpectedAnswers(
  expected: Record<string, BenchmarkExpectedAnswer>,
  answers: Record<string, DecisionAnswer>,
): DecisionBenchmarkPrediction[] {
  return Object.entries(expected).map(([questionId, target]) => {
    const answer = answers[questionId];
    if (!answer) {
      throw new Error("Decision benchmark missing answer for question " + questionId + ".");
    }
    if (answer.type !== target.type) {
      throw new Error("Decision benchmark answer type mismatch for question " + questionId + ".");
    }

    switch (target.type) {
      case "noul": {
        if (answer.type !== "noul") throw new Error("Unreachable benchmark noul mismatch.");
        assertProbability(answer.noul, "noul " + questionId);
        const predicted = answer.noul >= 0.5;
        const unsafe = target.unsafeValue;
        return {
          questionId,
          type: target.type,
          correct: predicted === target.value,
          confidence: predicted ? answer.noul : 1 - answer.noul,
          brierScore: (answer.noul - (target.value ? 1 : 0)) ** 2,
          ...(unsafe === undefined ? {} : {
            expectedUnsafe: target.value === unsafe,
            predictedUnsafe: predicted === unsafe,
          }),
        };
      }
      case "choice": {
        if (answer.type !== "choice") throw new Error("Unreachable benchmark choice mismatch.");
        const entries = validatedProbabilityEntries(answer.probabilities, questionId);
        if (!(target.value in answer.probabilities)) {
          throw new Error("Decision benchmark choice probabilities do not cover expected label " + target.value + ".");
        }
        const confidence = answer.probabilities[answer.choice];
        if (confidence === undefined) {
          throw new Error("Decision benchmark choice probabilities do not cover predicted label " + answer.choice + ".");
        }
        const unsafeLabels = target.unsafeLabels;
        return {
          questionId,
          type: target.type,
          correct: answer.choice === target.value,
          confidence,
          brierScore: normalizedCategoricalBrier(entries, target.value),
          ...(unsafeLabels === undefined ? {} : {
            expectedUnsafe: unsafeLabels.includes(target.value),
            predictedUnsafe: unsafeLabels.includes(answer.choice),
          }),
        };
      }
      case "score": {
        if (answer.type !== "score") throw new Error("Unreachable benchmark score mismatch.");
        if (!Number.isSafeInteger(target.value) || target.value < 0) {
          throw new TypeError("Decision benchmark expected score levels must be non-negative integers.");
        }
        const entries = validatedProbabilityEntries(answer.probabilities, questionId);
        if (!(String(target.value) in answer.probabilities)) {
          throw new Error("Decision benchmark score probabilities do not cover expected level " + target.value + ".");
        }
        const [predictedKey, confidence] = entries.reduce((best, current) =>
          current[1] > best[1] ? current : best);
        const predicted = Number(predictedKey);
        if (!Number.isSafeInteger(predicted) || predicted < 0) {
          throw new Error("Decision benchmark score probability keys must be non-negative integers.");
        }
        const threshold = target.unsafeAtOrAbove;
        return {
          questionId,
          type: target.type,
          correct: predicted === target.value,
          confidence,
          brierScore: normalizedCategoricalBrier(entries, String(target.value)),
          scoreAbsoluteError: Math.abs(answer.score - target.value),
          ...(threshold === undefined ? {} : {
            expectedUnsafe: target.value >= threshold,
            predictedUnsafe: predicted >= threshold,
          }),
        };
      }
    }
  });
}

function validatedProbabilityEntries(
  probabilities: Record<string, number>,
  questionId: string,
): Array<[string, number]> {
  const entries = Object.entries(probabilities);
  if (entries.length === 0) {
    throw new Error("Decision benchmark probabilities are empty for question " + questionId + ".");
  }
  for (const [, probability] of entries) {
    assertProbability(probability, "question " + questionId);
  }
  const sum = entries.reduce((total, [, probability]) => total + probability, 0);
  if (Math.abs(sum - 1) > 0.01) {
    throw new Error("Decision benchmark probabilities do not sum to 1 for question " + questionId + ".");
  }
  return entries;
}

function assertProbability(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Decision benchmark " + label + " probability must be between 0 and 1.");
  }
}

function normalizedCategoricalBrier(
  probabilities: Array<[string, number]>,
  expectedLabel: string,
): number {
  return probabilities.reduce((total, [label, probability]) => {
    const expected = label === expectedLabel ? 1 : 0;
    return total + (probability - expected) ** 2;
  }, 0) / probabilities.length;
}

function aggregateMetrics(
  samples: readonly DecisionBenchmarkCaseResult[],
  calibrationBins: number,
): DecisionBenchmarkMetrics {
  const predictions = samples.flatMap(sample => sample.predictions);
  if (predictions.length === 0) {
    throw new Error("Decision benchmark produced no evaluated answers.");
  }
  const correct = predictions.filter(prediction => prediction.correct).length;
  const unsafeExpected = predictions.filter(prediction => prediction.expectedUnsafe === true);
  const safeExpected = predictions.filter(prediction => prediction.expectedUnsafe === false);
  const scoreErrors = predictions.flatMap(prediction =>
    prediction.scoreAbsoluteError === undefined ? [] : [prediction.scoreAbsoluteError]);
  const costs = samples.flatMap(sample => sample.costUsd === null ? [] : [sample.costUsd]);
  const latencies = samples.map(sample => sample.latencyMs);

  return {
    caseCount: samples.length,
    evaluatedAnswers: predictions.length,
    accuracy: correct / predictions.length,
    meanBrierScore: mean(predictions.map(prediction => prediction.brierScore)),
    expectedCalibrationError: calibrationError(predictions, calibrationBins),
    falseSafeRate: unsafeExpected.length === 0
      ? null
      : unsafeExpected.filter(prediction => prediction.predictedUnsafe === false).length /
        unsafeExpected.length,
    falseAlarmRate: safeExpected.length === 0
      ? null
      : safeExpected.filter(prediction => prediction.predictedUnsafe === true).length /
        safeExpected.length,
    scoreMeanAbsoluteError: scoreErrors.length === 0 ? null : mean(scoreErrors),
    meanLatencyMs: mean(latencies),
    p95LatencyMs: percentileNearestRank(latencies, 0.95),
    totalInputTokens: samples.reduce((total, sample) => total + sample.inputTokens, 0),
    totalOutputTokens: samples.reduce((total, sample) => total + sample.outputTokens, 0),
    totalCostUsd: costs.length === 0 ? null : costs.reduce((total, value) => total + value, 0),
  };
}

function calibrationError(
  predictions: readonly DecisionBenchmarkPrediction[],
  bins: number,
): number {
  const buckets = Array.from({ length: bins }, () => ({
    count: 0,
    confidence: 0,
    correct: 0,
  }));
  for (const prediction of predictions) {
    const index = Math.min(bins - 1, Math.floor(prediction.confidence * bins));
    const bucket = buckets[index]!;
    bucket.count += 1;
    bucket.confidence += prediction.confidence;
    bucket.correct += prediction.correct ? 1 : 0;
  }
  return buckets.reduce((total, bucket) => {
    if (bucket.count === 0) return total;
    const averageConfidence = bucket.confidence / bucket.count;
    const averageAccuracy = bucket.correct / bucket.count;
    return total + (bucket.count / predictions.length) *
      Math.abs(averageAccuracy - averageConfidence);
  }, 0);
}

function validatePricing(pricing: DecisionBenchmarkPricing): void {
  for (const [name, value] of Object.entries(pricing)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError("Decision benchmark pricing " + name + " must be a non-negative finite number.");
    }
  }
}

function estimateCost(
  sample: DecisionBenchmarkSample,
  pricing: DecisionBenchmarkPricing,
): number {
  return (sample.inputTokens / 1_000_000) * pricing.inputUsdPerMillionTokens +
    (sample.outputTokens / 1_000_000) * pricing.outputUsdPerMillionTokens;
}

function percentileNearestRank(values: readonly number[], percentile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[rank - 1]!;
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}
