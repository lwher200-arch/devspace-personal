import { z } from "zod";

const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const tokenUsageBreakdownSchema = z.object({
  inputTokens: tokenCount,
  cachedInputTokens: tokenCount,
  // Older providers do not report cache writes; absence is not zero.
  cacheWriteInputTokens: tokenCount.optional(),
  outputTokens: tokenCount,
  reasoningOutputTokens: tokenCount,
  totalTokens: tokenCount,
});

/** Provider-reported counters, not a bill. Cached/reasoning counts are subsets. */
export type TokenUsageBreakdown = z.infer<typeof tokenUsageBreakdownSchema>;

export const localAgentTokenUsageSchema = z.object({
  source: z.literal("codex/thread-token-usage"),
  scope: z.literal("provider_thread"),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  observedAt: z.string().datetime(),
  total: tokenUsageBreakdownSchema,
  lastModelResponse: tokenUsageBreakdownSchema,
});

/**
 * Latest observed thread snapshot. `lastModelResponse` is one model response,
 * not a complete agent turn or an MCP call. Total counters can reset after
 * compaction; snapshots must be replaced, never summed or differenced as bills.
 * A retained snapshot may belong to an earlier turn, as its IDs/time indicate.
 */
export type LocalAgentTokenUsage = z.infer<typeof localAgentTokenUsageSchema>;
