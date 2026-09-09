# Observing Codex token usage

DevSpace can expose the latest token counters reported by a delegated Codex
thread. Direct project reads, searches and patches do not start Codex inference;
the host still uses its own model to request tools and interpret their results.
Commands that explicitly invoke a model or agent have their own usage.

Use direct tools for scoped file operations and deterministic checks. Give a
complex task one primary executor, continue the same task when appropriate, and
pass paths, acceptance criteria and concise evidence instead of full histories.
Keep required tests, permission boundaries and complete pagination intact.

## Where to read the counters

After updating both the DevSpace server and agent daemon, task observations from
`codex_task_status` and `codex_tasks` may include an optional `usage` object. The
same object is available from `devspace agents show <id> --json` in its workspace.
Read an existing task; polling does not start inference or add to the counters.
The human-readable CLI summary remains concise; use JSON for usage details.

The object identifies `source: "codex/thread-token-usage"`,
`scope: "provider_thread"`, `threadId`, `turnId` and `observedAt` (UTC).

- `total` is the latest provider-reported cumulative thread snapshot.
- `lastModelResponse` is the provider's last model response, not the entire
  agent turn, an individual MCP call, or the response from the Chat host.
- Each breakdown reports `inputTokens`, `cachedInputTokens`, `outputTokens`,
  `reasoningOutputTokens` and `totalTokens`. `cacheWriteInputTokens` is preserved
  when reported; older providers may omit it. Missing is not zero.
- Cached input, cache-write input and reasoning output are details of their
  parent counters. Do not add them to input/output again.

Malformed or unrelated thread/turn notifications are ignored. Duplicate
snapshots are not added together. Counters may reset after compaction or provider
recovery, so DevSpace replaces snapshots rather than computing billing deltas.

## Failure, continuation and storage

Observed snapshots are persisted while a turn is running, including before a
later failure, interruption or provider disconnect. Restarting DevSpace preserves
the last stored snapshot. A continuation that reports no new usage retains the
old snapshot with its original turn ID and time; it is not that continuation's
bill. Changing the provider thread clears the previous thread's snapshot.

No `usage` means no usable receipt has been observed. It does not mean zero cost.
This is latest-observation telemetry, not a complete historical ledger: snapshots
can be incomplete when a process dies or an event is never delivered. Replaying
an old request key observes the task's latest state, not an immutable bill for
the original request. Execution/model verification remains separate from usage.

The optional field uses the existing `execution_json` metadata; no database
migration is needed. New code reads old records. An older binary can omit the
field or discard it when updating a record, so downgrading does not preserve
this telemetry reliably. Existing credentials and model policies are unchanged.

## Comparing development cost

Compare tasks from the same code snapshot with the same acceptance criteria,
record model and billing mode, and include both the host and delegated usage,
failures, retries, elapsed time and rework. Apply the actual provider's rates to
each applicable input/cache/output category. A subscription allowance is not an
API invoice. This field alone does not establish total cost or a savings rate.

Protocol reference: [Codex App Server turn events](https://learn.chatgpt.com/docs/app-server#turn-events).
The adapter was checked against locally generated Codex CLI 0.153.4 bindings;
fixture tests do not establish real model billing or live ChatGPT acceptance.
