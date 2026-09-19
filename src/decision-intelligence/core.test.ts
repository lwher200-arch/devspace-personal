import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkDecision } from "./benchmark.js";
import { redactForExternalProvider } from "./redaction.js";
import type {
  DecisionIntelligenceProvider,
  DecisionRequest,
} from "./types.js";
import {
  buildAgentTraceObservation,
  buildMutationRiskObservation,
} from "./workflows.js";

test("redaction removes credential-bearing fields and inline secrets without mutating source", () => {
  const source = {
    user: "coldhao",
    nested: {
      api_key: "secret",
      authorization: "Bearer secret",
      note: "Authorization: Bearer abcdefghijklmnop",
    },
    items: [{ client_secret: "secret-2" }, "plain"],
  };
  const redacted = redactForExternalProvider(source);
  assert.deepEqual(redacted.redactedPaths, [
    "nested.api_key",
    "nested.authorization",
    "nested.note#inline",
    "items[0].client_secret",
  ]);
  const value = redacted.value as typeof source;
  assert.equal(value.nested.api_key, "[REDACTED]");
  assert.equal(value.nested.note.includes("abcdefghijklmnop"), false);
  assert.equal(source.nested.api_key, "secret");
});

test("A+B workflow builders remain advisory and expose no authorization action", () => {
  const trace = buildAgentTraceObservation({
    instructions: "read only",
    tool_calls: [],
  });
  const mutation = buildMutationRiskObservation({
    expectedScope: ["src/a.ts"],
    actualScope: ["src/a.ts"],
  });
  assert.deepEqual(Object.keys(trace.questions), [
    "permission_breach",
    "outcome",
    "review_urgency",
  ]);
  assert.deepEqual(Object.keys(mutation.questions), [
    "unexpected_scope",
    "sensitive_target",
    "boundary_integrity_concern",
    "destructive_breadth",
  ]);
  const serialized = JSON.stringify({ trace, mutation });
  assert.equal(serialized.includes('"approve"'), false);
  assert.equal(serialized.includes('"execute"'), false);
});

test("benchmarkDecision reports provider usage and measured latency", async () => {
  const provider: DecisionIntelligenceProvider = {
    id: "stub",
    async evaluate(_request: DecisionRequest) {
      return {
        provider: "stub",
        model: "none",
        answers: {},
        usage: { inputTokens: 7, outputTokens: 2 },
      };
    },
  };
  const clock = [100, 112];
  const sample = await benchmarkDecision(
    provider,
    { state: "state", questions: {} },
    () => clock.shift()!,
  );
  assert.equal(sample.latencyMs, 12);
  assert.equal(sample.inputTokens, 7);
  assert.equal(sample.outputTokens, 2);
});
