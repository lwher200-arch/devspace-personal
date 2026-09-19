import assert from "node:assert/strict";
import test from "node:test";
import type { DecisionRequest } from "./types.js";
import {
  TypeSafeProvider,
  TypeSafeProviderError,
  TYPESAFE_SYSTEM_ONE_ENDPOINT,
} from "./typesafe-provider.js";

const sampleRequest: DecisionRequest = {
  state: { trace: "safe", expected: ["src/a.ts"], actual: ["src/a.ts"] },
  questions: {
    scope: {
      type: "choice",
      instructions: "Did the mutation stay in scope?",
      criteria: {
        yes: "It stayed in scope.",
        no: "It exceeded scope.",
      },
    },
    concern: {
      type: "noul",
      instructions: "Is there a boundary concern?",
    },
    severity: {
      type: "score",
      instructions: "How severe is the mutation?",
      criteria: ["none", "material"],
    },
  },
};

function validResponse(): Response {
  return Response.json({
    model: "jev-1.13.0",
    answers: {
      scope: {
        type: "choice",
        choice: "yes",
        probabilities: { yes: 0.97, no: 0.03 },
        confidence: 0.94,
      },
      concern: { type: "noul", noul: 0.02 },
      severity: {
        type: "score",
        score: 0.1,
        legend: { "0": "none", "1": "material" },
        probabilities: { "0": 0.9, "1": 0.1 },
        confidence: 0.8,
      },
    },
    usage: { input_tokens: 123, output_tokens: 17 },
  });
}

test("TypeSafeProvider sends the System One HTTP contract and validates typed answers", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const provider = new TypeSafeProvider({
    apiKey: "test-key-never-log",
    fetchImpl: async (input, init) => {
      seenUrl = String(input);
      seenInit = init;
      return validResponse();
    },
  });

  const result = await provider.evaluate(sampleRequest);
  assert.equal(seenUrl, TYPESAFE_SYSTEM_ONE_ENDPOINT);
  assert.equal(seenInit?.method, "POST");
  assert.equal(
    new Headers(seenInit?.headers).get("authorization"),
    "Bearer test-key-never-log",
  );
  const body = JSON.parse(String(seenInit?.body));
  assert.equal(body.model, "jev-latest");
  assert.deepEqual(body.state, sampleRequest.state);
  assert.deepEqual(body.questions, sampleRequest.questions);
  assert.equal(result.provider, "typesafe");
  assert.equal(result.model, "jev-1.13.0");
  assert.deepEqual(result.usage, { inputTokens: 123, outputTokens: 17 });
});

test("TypeSafeProvider redacts outbound credential-like state and reports redacted paths", async () => {
  let body: any;
  const provider = new TypeSafeProvider({
    apiKey: "test-key",
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return validResponse();
    },
  });
  const request: DecisionRequest = {
    ...sampleRequest,
    state: {
      api_key: "not-a-real-key",
      note: "Authorization: Bearer abcdefghijklmnop",
    },
  };
  const result = await provider.evaluate(request);
  assert.equal(body.state.api_key, "[REDACTED]");
  assert.equal(body.state.note.includes("abcdefghijklmnop"), false);
  assert.deepEqual(result.redactedPaths, ["state.api_key", "state.note#inline"]);
});

test("TypeSafeProvider retries connection errors plus 408/429/5xx and never leaks the key", async () => {
  const key = "test-secret-api-key";
  let calls = 0;
  const delays: number[] = [];
  const provider = new TypeSafeProvider({
    apiKey: key,
    maxAttempts: 4,
    sleep: async delay => {
      delays.push(delay);
    },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error("connection dropped");
      if (calls === 2) return new Response("timeout", { status: 408 });
      if (calls === 3) return new Response("overloaded", { status: 503 });
      return new Response("unauthorized", { status: 401 });
    },
  });

  await assert.rejects(
    provider.evaluate(sampleRequest),
    (error: unknown) => {
      assert.ok(error instanceof TypeSafeProviderError);
      assert.equal(error.status, 401);
      assert.equal(error.message.includes(key), false);
      return true;
    },
  );
  assert.equal(calls, 4);
  assert.deepEqual(delays, [500, 1000, 2000]);
});

test("TypeSafeProvider rejects answer/question contract drift", async () => {
  const provider = new TypeSafeProvider({
    apiKey: "test-key",
    fetchImpl: async () =>
      Response.json({
        model: "jev-latest",
        answers: {
          scope: { type: "noul", noul: 0.9 },
          concern: { type: "noul", noul: 0.1 },
          severity: {
            type: "score",
            score: 0,
            legend: { "0": "none", "1": "material" },
            probabilities: { "0": 1, "1": 0 },
            confidence: 1,
          },
        },
        usage: { input_tokens: 10, output_tokens: 3 },
      }),
  });

  await assert.rejects(
    provider.evaluate(sampleRequest),
    /answer type mismatch for question scope/,
  );
});

test("TypeSafeProvider supports structured criteria and validates score API limits", async () => {
  let calls = 0;
  const provider = new TypeSafeProvider({
    apiKey: "test-key",
    fetchImpl: async (_input, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.questions.severity.criteria[0], {
        what: "none",
        examples: ["cosmetic"],
      });
      return Response.json({
        model: "jev-latest",
        answers: {
          severity: {
            type: "score",
            score: 0.2,
            legend: {
              "0": { what: "none", examples: ["cosmetic"] },
              "1": { what: "material", examples: ["blocking"] },
            },
            probabilities: { "0": 0.8, "1": 0.2 },
            confidence: 0.6,
          },
        },
        usage: { input_tokens: 10, output_tokens: 3 },
      });
    },
  });
  const structured: DecisionRequest = {
    state: "state",
    questions: {
      severity: {
        type: "score",
        instructions: "severity",
        criteria: [
          { what: "none", examples: ["cosmetic"] },
          { what: "material", examples: ["blocking"] },
        ],
      },
    },
  };
  const result = await provider.evaluate(structured);
  assert.equal(calls, 1);
  assert.equal(result.answers.severity?.type, "score");

  const tooManyLevels: DecisionRequest = {
    state: "state",
    questions: {
      severity: {
        type: "score",
        instructions: "severity",
        criteria: Array.from({ length: 11 }, (_, index) => "level-" + index) as any,
      },
    },
  };
  await assert.rejects(provider.evaluate(tooManyLevels), /10-level API limit/);
  assert.equal(calls, 1);
});
