import assert from "node:assert/strict";
import type { LocalAgentCatalog } from "./local-agent-catalog.js";
import {
  presentAgentObservation,
  presentAgentReceipt,
  presentAgentSummary,
  presentAgentTargetCatalog,
} from "./local-agent-presentation.js";
import type { LocalAgentRecord } from "./local-agent-store.js";

const usage = {
  source: "codex/thread-token-usage" as const,
  scope: "provider_thread" as const,
  threadId: "thread_usage",
  turnId: "turn_usage",
  observedAt: "2026-09-08T00:00:00.000Z",
  total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 },
  lastModelResponse: { inputTokens: 60, cachedInputTokens: 30, outputTokens: 10, reasoningOutputTokens: 3, totalTokens: 70 },
};

const record: LocalAgentRecord = {
  id: "agt_test",
  workspaceId: "ws_private",
  workspaceRoot: "/private/project",
  profileName: "reviewer",
  provider: "codex",
  model: "gpt-5.4",
  effort: "high",
  providerSessionId: "provider_private",
  status: "running",
  latestResponse: "previous response",
  createdAt: "2026-08-21T10:00:00.000Z",
  updatedAt: "2026-08-21T10:01:00.000Z",
};

assert.deepEqual(presentAgentReceipt({ ...record, status: "starting" }), {
  id: "agt_test",
  status: "running",
});
assert.deepEqual(presentAgentSummary({ ...record, status: "idle" }), {
  id: "agt_test",
  status: "completed",
  target: "reviewer",
});
assert.equal(presentAgentSummary({ ...record, profileName: "profile:codex" }).target, "codex");
assert.equal(presentAgentSummary({ ...record, profileName: "provider:codex" }).target, "provider:codex");
assert.equal(presentAgentSummary({ ...record, profileName: "codex" }).target, "codex");

const completed = presentAgentObservation({
  ...record,
  status: "idle",
  latestResponse: "Found one issue.",
});
assert.deepEqual(completed, {
  id: "agt_test",
  status: "completed",
  response: "Found one issue.",
});

const failed = presentAgentObservation({
  ...record,
  status: "error",
  latestResponse: undefined,
  error: "Provider disconnected.",
  errorCode: "PROVIDER_EXECUTION_ERROR",
  errorRetryable: true,
});
assert.deepEqual(failed, {
  id: "agt_test",
  status: "failed",
  error: {
    code: "PROVIDER_EXECUTION_ERROR",
    message: "Provider disconnected.",
    retryable: true,
  },
});

for (const status of ["running", "idle", "error", "stopped"] as const) {
  assert.deepEqual(presentAgentObservation({ ...record, status, usage }).usage, usage);
}
assert.equal("usage" in completed, false, "missing telemetry is omitted rather than zero");
assert.equal("usage" in failed, false);

const catalog: LocalAgentCatalog = {
  enabled: true,
  providers: [
    { id: "codex", enabled: true, available: true, usable: true, model: "gpt-5.4", effort: "high" },
    {
      id: "claude",
      enabled: true,
      available: false,
      usable: false,
      reason: "credentials missing",
    },
  ],
  profiles: [{
    name: "reviewer",
    description: "Review changes.",
    provider: "codex",
    model: "gpt-5.4",
    effort: "high",
  }],
};
const targetCatalog = presentAgentTargetCatalog(catalog);
assert.deepEqual(targetCatalog, {
  targets: [
    { name: "codex", kind: "provider", model: "gpt-5.4", effort: "high" },
    {
      name: "reviewer",
      kind: "profile",
      provider: "codex",
      description: "Review changes.",
      model: "gpt-5.4",
      effort: "high",
    },
  ],
});
