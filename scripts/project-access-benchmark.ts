import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import {
  projectAccessDiagnosticsForTest,
  projectFiles,
  projectRead,
} from "../src/project-access.js";

const root = resolve(process.cwd());
const textPath = "src/server.ts";
const inventoryRounds = 7;
const textRounds = 15;

async function timed<T>(operation: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await operation();
  return { value, ms: performance.now() - started };
}

function stats(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]!;
  return {
    minMs: Number(sorted[0]!.toFixed(3)),
    medianMs: Number(percentile(0.5).toFixed(3)),
    p95Ms: Number(percentile(0.95).toFixed(3)),
    maxMs: Number(sorted.at(-1)!.toFixed(3)),
  };
}

const inventoryCold: number[] = [];
const inventoryWarm: number[] = [];
let inventoryFileCount = 0;
let inventoryDiagnostics = projectAccessDiagnosticsForTest.snapshot();

for (let round = 0; round < inventoryRounds; round++) {
  projectAccessDiagnosticsForTest.reset();
  const cold = await timed(() => projectFiles(root, { limit: 500 }));
  const warm = await timed(() => projectFiles(root, { limit: 500 }));
  if (cold.value.snapshot !== warm.value.snapshot) {
    throw new Error("Inventory snapshot changed during benchmark.");
  }
  if (cold.value.totalFiles !== warm.value.totalFiles) {
    throw new Error("Inventory file count changed during benchmark.");
  }
  inventoryCold.push(cold.ms);
  inventoryWarm.push(warm.ms);
  inventoryFileCount = cold.value.totalFiles;
  inventoryDiagnostics = projectAccessDiagnosticsForTest.snapshot();
  if (inventoryDiagnostics.inventoryBuilds !== 1 || inventoryDiagnostics.inventoryCacheHits !== 1) {
    throw new Error(`Unexpected inventory diagnostics: ${JSON.stringify(inventoryDiagnostics)}`);
  }
}

const textCold: number[] = [];
const textWarm: number[] = [];
let textBytes = 0;
let textDiagnostics = projectAccessDiagnosticsForTest.snapshot();

for (let round = 0; round < textRounds; round++) {
  projectAccessDiagnosticsForTest.reset();
  const cold = await timed(() => projectRead(root, { path: textPath, limit: 20_000 }));
  const warm = await timed(() => projectRead(root, {
    path: textPath,
    limit: 20_000,
    expectedSha256: cold.value.sha256,
  }));
  if (cold.value.sha256 !== warm.value.sha256) {
    throw new Error("Text SHA-256 changed during benchmark.");
  }
  textCold.push(cold.ms);
  textWarm.push(warm.ms);
  textBytes = cold.value.bytes;
  textDiagnostics = projectAccessDiagnosticsForTest.snapshot();
  if (textDiagnostics.textBodyReads !== 1 || textDiagnostics.textCacheHits !== 1) {
    throw new Error(`Unexpected text diagnostics: ${JSON.stringify(textDiagnostics)}`);
  }
}

const inventoryColdStats = stats(inventoryCold);
const inventoryWarmStats = stats(inventoryWarm);
const textColdStats = stats(textCold);
const textWarmStats = stats(textWarm);

const result = {
  benchmark: "project-access-cache",
  root,
  inventory: {
    rounds: inventoryRounds,
    files: inventoryFileCount,
    cold: inventoryColdStats,
    warm: inventoryWarmStats,
    medianSpeedup: Number((inventoryColdStats.medianMs / inventoryWarmStats.medianMs).toFixed(3)),
    diagnostics: inventoryDiagnostics,
  },
  text: {
    rounds: textRounds,
    path: textPath,
    bytes: textBytes,
    cold: textColdStats,
    warm: textWarmStats,
    medianSpeedup: Number((textColdStats.medianMs / textWarmStats.medianMs).toFixed(3)),
    diagnostics: textDiagnostics,
  },
  note: "Warm paths still perform metadata/signature validation; speedup therefore measures validated cache reuse, not unchecked memory lookup.",
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
