import * as z from "zod/v4";
import { redactForExternalProvider } from "./redaction.js";
import type {
  ChoiceQuestion,
  DecisionAnswer,
  DecisionIntelligenceProvider,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
  EntryType,
  JsonValue,
  StructuredValue,
} from "./types.js";

export const TYPESAFE_SYSTEM_ONE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Sleep = (milliseconds: number) => Promise<void>;

export interface TypeSafeProviderOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  fetchImpl?: FetchLike;
  sleep?: Sleep;
}

export class TypeSafeProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "TypeSafeProviderError";
  }
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const entryTypeSchema = z.union([
  z.string(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
  z.null(),
]);
const probabilityMapSchema = z.record(z.string(), z.number().min(0).max(1));
const answerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("noul"),
    noul: z.number().min(0).max(1),
  }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: probabilityMapSchema,
    confidence: z.number().min(0).max(1),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number().nonnegative(),
    legend: z.record(z.string(), entryTypeSchema),
    probabilities: probabilityMapSchema,
    confidence: z.number().min(0).max(1),
  }),
]);

const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

export class TypeSafeProvider implements DecisionIntelligenceProvider {
  readonly id = "typesafe";
  readonly #apiKey: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #fetch: FetchLike;
  readonly #sleep: Sleep;

  constructor(options: TypeSafeProviderOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) throw new TypeError("TypeSafe apiKey is required.");

    const timeoutMs = options.timeoutMs ?? 15_000;
    const maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("TypeSafe timeoutMs must be a positive integer.");
    }
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
      throw new RangeError("TypeSafe maxAttempts must be an integer from 1 to 5.");
    }

    this.#apiKey = apiKey;
    this.#model = options.model?.trim() || TYPESAFE_DEFAULT_MODEL;
    this.#timeoutMs = timeoutMs;
    this.#maxAttempts = maxAttempts;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#sleep = options.sleep ?? (milliseconds =>
      new Promise(resolve => setTimeout(resolve, milliseconds)));
  }

  async evaluate(request: DecisionRequest): Promise<DecisionResult> {
    validateRequest(request);
    const model = request.model?.trim() || this.#model;
    const sanitized = sanitizeRequest(request);

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.#fetch(TYPESAFE_SYSTEM_ONE_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: "Bearer " + this.#apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            state: sanitized.state,
            model,
            questions: sanitized.questions,
          }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch {
        if (attempt < this.#maxAttempts) {
          await this.#sleep(backoffDelayMs(attempt));
          continue;
        }
        throw new TypeSafeProviderError(
          "TypeSafe API request failed before a response was received.",
          undefined,
          true,
        );
      }

      if (response.ok) {
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new TypeSafeProviderError(
            "TypeSafe API returned invalid JSON.",
            response.status,
          );
        }

        const parsed = responseSchema.safeParse(payload);
        if (!parsed.success) {
          throw new TypeSafeProviderError(
            "TypeSafe API returned an invalid response shape.",
            response.status,
          );
        }
        assertAnswersMatchQuestions(request.questions, parsed.data.answers);
        return {
          provider: this.id,
          model: parsed.data.model,
          answers: parsed.data.answers,
          usage: {
            inputTokens: parsed.data.usage.input_tokens,
            outputTokens: parsed.data.usage.output_tokens,
          },
          ...(sanitized.redactedPaths.length > 0
            ? { redactedPaths: sanitized.redactedPaths }
            : {}),
        };
      }

      const retryable = isRetryableStatus(response.status);
      if (!retryable || attempt === this.#maxAttempts) {
        throw new TypeSafeProviderError(
          "TypeSafe API request failed with HTTP " + response.status + ".",
          response.status,
          retryable,
        );
      }
      await this.#sleep(retryDelayMs(response, attempt));
    }

    throw new TypeSafeProviderError(
      "TypeSafe API request exhausted its retry budget.",
      undefined,
      true,
    );
  }
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfterMs = response.headers.get("retry-after-ms");
  if (retryAfterMs) {
    const milliseconds = Number(retryAfterMs);
    if (Number.isFinite(milliseconds) && milliseconds >= 0) {
      return Math.min(milliseconds, 60_000);
    }
  }
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 60_000);
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return Math.min(Math.max(0, date - Date.now()), 60_000);
    }
  }
  return backoffDelayMs(attempt);
}

function backoffDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 5_000);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function validateRequest(request: DecisionRequest): void {
  assertStructuredValue(request.state, "state");
  if (request.model !== undefined && !request.model.trim()) {
    throw new TypeError("TypeSafe model must not be blank.");
  }

  const entries = Object.entries(request.questions);
  if (entries.length === 0) {
    throw new TypeError("TypeSafe questions must not be empty.");
  }

  for (const [id, question] of entries) {
    if (!id.trim()) throw new TypeError("TypeSafe question ids must not be blank.");
    assertStructuredValue(question.instructions, "questions." + id + ".instructions");

    switch (question.type) {
      case "noul":
        if (question.criteria !== undefined && question.criteria !== null) {
          if (question.criteria.true !== undefined) {
            assertEntryType(question.criteria.true, "questions." + id + ".criteria.true");
          }
          if (question.criteria.false !== undefined) {
            assertEntryType(question.criteria.false, "questions." + id + ".criteria.false");
          }
        }
        break;
      case "choice":
        validateChoice(question, id);
        break;
      case "score":
        if (question.criteria.length < 2) {
          throw new TypeError(
            "TypeSafe score question " + id + " requires at least two criteria.",
          );
        }
        if (question.criteria.length > 10) {
          throw new TypeError(
            "TypeSafe score question " + id + " exceeds the 10-level API limit.",
          );
        }
        question.criteria.forEach((value, index) =>
          assertEntryType(value, "questions." + id + ".criteria[" + index + "]"));
        break;
      default:
        assertNever(question);
    }
  }
}

function validateChoice(question: ChoiceQuestion, id: string): void {
  const entries = Object.entries(question.criteria);
  if (entries.length === 0) {
    throw new TypeError(
      "TypeSafe choice question " + id + " requires at least one criterion.",
    );
  }
  if (entries.length > 255) {
    throw new TypeError(
      "TypeSafe choice question " + id + " exceeds the 255-option API limit.",
    );
  }
  for (const [option, description] of entries) {
    if (!option.trim()) {
      throw new TypeError(
        "TypeSafe choice question " + id + " has a blank option.",
      );
    }
    assertEntryType(description, "questions." + id + ".criteria." + option);
  }
}

function assertEntryType(value: EntryType, path: string): void {
  if (value === null) return;
  assertStructuredValue(value, path);
}

function assertStructuredValue(value: StructuredValue, path: string): void {
  if (typeof value === "string") return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJsonValue(child, path + "[" + index + "]"));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assertJsonValue(child, path + "." + key);
  }
}

function assertJsonValue(value: JsonValue, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("TypeSafe " + path + " contains a non-finite number.");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJsonValue(child, path + "[" + index + "]"));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assertJsonValue(child, path + "." + key);
  }
}

function assertAnswersMatchQuestions(
  questions: Record<string, DecisionQuestion>,
  answers: Record<string, DecisionAnswer>,
): void {
  const questionIds = Object.keys(questions).sort();
  const answerIds = Object.keys(answers).sort();
  if (
    questionIds.length !== answerIds.length ||
    questionIds.some((id, index) => id !== answerIds[index])
  ) {
    throw new TypeSafeProviderError(
      "TypeSafe API answer ids did not match the request.",
    );
  }

  for (const id of questionIds) {
    const question = questions[id]!;
    const answer = answers[id]!;
    if (answer.type !== question.type) {
      throw new TypeSafeProviderError(
        "TypeSafe API answer type mismatch for question " + id + ".",
      );
    }

    if (answer.type === "choice" && question.type === "choice") {
      const options = Object.keys(question.criteria).sort();
      if (!options.includes(answer.choice)) {
        throw new TypeSafeProviderError(
          "TypeSafe API returned an unknown choice for question " + id + ".",
        );
      }
      assertProbabilityKeys(id, options, answer.probabilities);
    }

    if (answer.type === "score" && question.type === "score") {
      const levels = question.criteria.map((_, index) => String(index));
      if (answer.score > question.criteria.length - 1) {
        throw new TypeSafeProviderError(
          "TypeSafe API score was outside the configured rubric for question " + id + ".",
        );
      }
      assertProbabilityKeys(id, levels, answer.probabilities);
      if (
        Object.keys(answer.legend).length !== levels.length ||
        levels.some((level, index) =>
          !jsonEqual(answer.legend[level], question.criteria[index]))
      ) {
        throw new TypeSafeProviderError(
          "TypeSafe API score legend did not match the request for question " + id + ".",
        );
      }
    }
  }
}

function jsonEqual(left: EntryType | undefined, right: EntryType | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (left === null || right === null) return false;
  if (typeof left === "string" || typeof right === "string") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) =>
      jsonValueEqual(value, right[index] as JsonValue));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key, index) => key !== rightKeys[index])
  ) {
    return false;
  }
  return leftKeys.every(key =>
    jsonValueEqual(left[key] as JsonValue, right[key] as JsonValue));
}

function jsonValueEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => jsonValueEqual(value, right[index]!));
  }
  if (typeof left === "object" || typeof right === "object") {
    if (typeof left !== "object" || typeof right !== "object") return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (
      leftKeys.length !== rightKeys.length ||
      leftKeys.some((key, index) => key !== rightKeys[index])
    ) {
      return false;
    }
    return leftKeys.every(key => jsonValueEqual(left[key]!, right[key]!));
  }
  return false;
}

function sanitizeRequest(request: DecisionRequest): {
  state: StructuredValue;
  questions: Record<string, DecisionQuestion>;
  redactedPaths: string[];
} {
  const state = redactForExternalProvider(request.state);
  const questions: Record<string, DecisionQuestion> = {};
  const redactedPaths = state.redactedPaths.map(path => prefixPath("state", path));

  for (const [id, question] of Object.entries(request.questions)) {
    const instructions = redactForExternalProvider(question.instructions);
    redactedPaths.push(
      ...instructions.redactedPaths.map(path =>
        prefixPath("questions." + id + ".instructions", path)),
    );

    if (question.type === "noul") {
      let criteria = question.criteria;
      if (criteria !== undefined && criteria !== null) {
        const redacted = redactForExternalProvider(criteria as JsonValue);
        criteria = redacted.value as NonNullable<typeof criteria>;
        redactedPaths.push(
          ...redacted.redactedPaths.map(path =>
            prefixPath("questions." + id + ".criteria", path)),
        );
      }
      questions[id] = {
        type: "noul",
        instructions: instructions.value as StructuredValue,
        ...(criteria !== undefined ? { criteria } : {}),
      };
      continue;
    }

    const redacted = redactForExternalProvider(question.criteria as JsonValue);
    redactedPaths.push(
      ...redacted.redactedPaths.map(path =>
        prefixPath("questions." + id + ".criteria", path)),
    );
    questions[id] = question.type === "choice"
      ? {
          type: "choice",
          instructions: instructions.value as StructuredValue,
          criteria: redacted.value as ChoiceQuestion["criteria"],
        }
      : {
          type: "score",
          instructions: instructions.value as StructuredValue,
          criteria: redacted.value as typeof question.criteria,
        };
  }

  return {
    state: state.value as StructuredValue,
    questions,
    redactedPaths,
  };
}

function prefixPath(prefix: string, path: string): string {
  if (!path || path === "$") return prefix;
  if (path.startsWith("[")) return prefix + path;
  if (path.startsWith("#")) return prefix + path;
  return prefix + "." + path;
}

function assertProbabilityKeys(
  id: string,
  expectedKeys: string[],
  probabilities: Record<string, number>,
): void {
  const actualKeys = Object.keys(probabilities).sort();
  const expected = [...expectedKeys].sort();
  if (
    actualKeys.length !== expected.length ||
    expected.some((key, index) => key !== actualKeys[index])
  ) {
    throw new TypeSafeProviderError(
      "TypeSafe API probability keys did not match question " + id + ".",
    );
  }
  const sum = Object.values(probabilities).reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) > 0.01) {
    throw new TypeSafeProviderError(
      "TypeSafe API probabilities did not sum to 1 for question " + id + ".",
    );
  }
}

function assertNever(value: never): never {
  throw new TypeError("Unsupported TypeSafe question: " + String(value));
}
