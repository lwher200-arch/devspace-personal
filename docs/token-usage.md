# Observing token usage and recorded tool traffic

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

## Report controller receipts from an explicit rollout

A local Codex controller can report its recorded turn usage without starting
another model or contacting the DevSpace server:

```powershell
devspace usage report --rollout 'C:\authorized\rollout.jsonl'
devspace usage report --rollout 'C:\authorized\rollout.jsonl' --turn-id '<turn-id>' --json
```

Reading existing usage and traffic receipts for the current task and subtasks
it actually invoked has standing user authorization; accounting does not need
another confirmation. Use the identified rollout path for that task. This does
not authorize reading unrelated sessions or credentials, starting additional
execution, or changing a service or its permissions.
The command reads a UTF-8 snapshot of the supplied regular JSONL file, at most
64 MiB and 100,000 JSONL records, using one file handle. It does not search session
folders, load credentials, start inference, or change a project or service.
Run the matching built CLI when testing a source checkout; an older installed
binary may not contain this command. Capture the JSON report outside tracked
files if you need to keep a receipt artifact. Do not commit raw rollout logs.

By default, the report selects the latest `task_started` turn in that file.
Use `--turn-id` to select an earlier known turn. If no start event exists, it
falls back to the latest canonical receipt turn, marks coverage partial and
does not assign tool calls to that turn. It collects canonical
`token_usage_record` receipts and deduplicates them by `response_id` before
summing input and output counters. A provider turn total is a reconciliation
check, not another amount to add. Legacy `token_count` events alone cannot
establish these response receipts: missing accounting remains unavailable.

The report includes visible outer tool-call batches and whether each has a
recorded result (`resultRecorded`). This is an operation inventory, not a
per-tool invoice. `independentTokens` is `null` without independent receipts.
A batch can contain several reads, edits or tests; the report does not inspect
raw arguments or guess those nested operations. A recorded result also does
not prove success. Preserve a concise operation/outcome log, including failed
commands and retries, alongside the report when those details are required.
Do not charge a shared response's full usage to each operation in that batch.

The selected controller turn can be complete only after `task_complete` is
recorded within its start/next-turn boundaries, every accepted receipt belongs
to those boundaries and the unique controller `session_meta.id`, and the
canonical receipt sum reconciles with the provider turn total without warnings.
Missing or mismatched receipt `thread_id` values and receipts outside a known
turn boundary are omitted with coverage warnings. A missing or ambiguous
controller session identity cannot produce a complete report.
An active turn is partial, even when currently observed counters reconcile.
Malformed JSONL, an unfinished final record, missing results or conflicting
thread identities prevent complete coverage. Conflicting duplicate response
receipts are rejected; invalid UTF-8 is rejected rather than silently repaired.
A snapshot taken before the final response excludes any usage recorded later,
including the final response itself. Use the report's sampling time and
coverage status; do not relabel a partial snapshot as the final bill.

The output omits raw prompts, tool arguments and tool output. It is a usage
summary for the supplied controller log, not automatic access to ChatGPT's
web-host billing. If that host exposes no receipt, its usage is unavailable.
The delegated `usage` snapshot described above does not replace a controller
receipt, and the controller report does not automatically read subagent logs.
Apply the same standing authorization to existing receipts from subtasks this
task actually invoked. Label each source separately, identify missing sources
and avoid duplicate token counting across sources.

The JSON report identifies `scope: "controller_turn"`, `turnId`, `sampledAt`,
`status` (`complete`, `partial` or `unavailable`) and `complete`. It includes
`responseCount`, `duplicateResponseCount`, `providerTurnTotalMatches`, `warnings`
and `operations`. Each operation contains `callId`, `tool`, `resultRecorded`,
`requestBytes`, `responseBytes` and `independentTokens: null`. `usage` contains
`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`,
`reasoning_output_tokens` and `total_tokens`; missing detail counters are `null`.
Without usable receipts, `usage` itself is `null`. `uncachedInputTokens` is
available only when both cache counters are known. The text report uses
`unavailable` for missing counters and prints coverage warnings.

## Recorded tool traffic

The same report counts the UTF-8 bytes of request arguments and returned payloads
visible in the selected turn's log. Text uses its UTF-8 byte length; structured
content is JSON-serialized before measuring. Each visible request or response
record contributes once, including duplicates. This describes what the log
records; a duplicate record is not evidence that a network retry occurred.
The report emits counters and identifiers without emitting payload contents.

The `traffic` object uses `scope: "recorded_tool_payload_utf8"` and contains
`requestBytes`, `responseBytes`, `totalBytes`, `observedRequestBytes`,
`observedResponseBytes`, `observedTotalBytes`, `requestRecords`, `responseRecords`,
`missingPayloadRecords`, `unmatchedResponseRecords`, `status` (`complete`,
`partial` or `unavailable`) and `networkWireBytes: null`. Each entry in
`operations` also includes `requestBytes` and `responseBytes`. Missing payload
measurements remain unavailable rather than being assigned zero. Each source
has token and traffic coverage states; measured payload bytes do not establish
token-receipt or network coverage.

A missing payload makes the affected direction's aggregate and total `null`.
An output without a matching call makes the response aggregate and total
`null`; its record still contributes to `responseRecords` and
`unmatchedResponseRecords`. Without a turn start, traffic is unavailable and
calls cannot be assigned. A known empty payload or observed empty call range
can measure zero; that is not a claim that unrecorded traffic was zero.

`observedRequestBytes`, `observedResponseBytes` and `observedTotalBytes` preserve
known subtotals even when a complete direction total is unavailable. They count
only measurable request payloads and measurable responses attributable to calls
in the selected turn. Missing payloads, pending responses and unmatched output
records are excluded from these subtotals; without a turn start all three are
`null`. Label these values as an observed subset, never the complete turn or
network wire traffic. For example, a pending response can make `responseBytes`
`null` while `observedResponseBytes` still shows earlier measured responses.
These are recorded payload bytes, not real network wire bytes. They exclude
unobserved data and cannot establish HTTP or TLS framing, compression, network
retransmissions, model-provider traffic, or overall bandwidth. Real network
traffic remains unavailable without its own measurement. Do not convert byte
counts into token counts or treat them as a provider bill. If independent
network telemetry is available for the task, show its source and scope
separately rather than relabeling this payload measurement.

## End each work report with accounting

Every task turn must end with a traffic and token accounting footer after the
work outcome and validation evidence, even when receipts are unavailable. Give
the sampling time, separate coverage states and one set of counters for each
available source. Use actual values or `unavailable`; never estimate a tool's
token cost from its runtime, response length or the number of tool calls.

```text
Traffic and token accounting (sampled at <UTC timestamp>)
Controller: <partial / complete / unavailable>; <receipt and turn coverage>
  Input: <value>; cached input: <value or unavailable>
  Cache-write input: <value or unavailable>
  Output: <value>; reasoning output: <value or unavailable>; total: <value>
Recorded tool payload traffic: <partial / complete / unavailable>; <record coverage>
  Direction totals: request <bytes or unavailable>; response <bytes or unavailable>; total <bytes or unavailable>
  Observed subset: request <known bytes or unavailable>; response <known bytes or unavailable>; total <known bytes or unavailable>
  Missing payload records: <count>; unmatched responses: <count>
Real network traffic: unavailable unless independently measured
Delegated agents: <separate token/traffic receipts / not invoked / unavailable>
Subagents: <separate token/traffic receipts / not invoked / unavailable>
Operations: <observed calls, failures, retries and result coverage; log path>
Independent per-operation tokens: unavailable unless a separate receipt exists
Missing/excluded usage: <sources and responses not covered, including later final response>
```

Cache counts are already included in input and reasoning counts in output.
Do not sum them again. `Not invoked` requires evidence that no such execution
occurred; it is different from a missing receipt for an invoked agent. A report
may be complete for the selected local controller turn while still lacking
Chat-host or delegated usage, so it is not necessarily a complete workflow bill.
