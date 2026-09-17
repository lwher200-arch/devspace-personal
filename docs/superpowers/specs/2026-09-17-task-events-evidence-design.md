# Task Events + Evidence Payload Store Design

Date: 2026-09-17
Status: Approved design candidate; implementation not started
Branch: `feat/task-session-kernel`

## Purpose

Phase 2 adds a durable, append-only operational evidence journal above the Phase 1 `task_sessions` kernel. The journal records what actually happened to a task without turning logs, model prose, approval state, or imported files into the task's source of truth.

The design keeps three concepts separate:

- `task_events`: ordered operational facts for one durable task.
- `task_event_payloads`: exact UTF-8 text too large to keep inline with an event.
- external evidence references: pointers to evidence already owned elsewhere, such as a workspace file, DevSpace review ref, process receipt, or imported artifact.

This phase does not add model-facing tools, UI, automatic compaction, semantic handoff, task plans, checkpoint orchestration, browser automation, or approval inheritance.

## Architecture

```text
TaskSession
    |
    +-- task_events                  append-only operational truth
           |
           +-- bounded summary
           +-- bounded inline_text
           +-- optional external_ref
           |
           +-- event_id -------------------+
                                            v
                                   task_event_payloads
                                   exact large UTF-8 evidence
                                   sha256 + byte_count
```

`Logger` remains diagnostics. `TaskEvent` is durable task evidence. Neither is authorization.

## Storage Contract

### Migration v9: `task-event-journal`

Add `task_events` and `task_event_payloads`.

### `task_events`

```sql
create table task_events (
  task_session_id text not null,
  seq integer not null check (seq >= 1),
  event_id text not null unique,
  kind text not null,
  source text not null,
  conversation_scope_id text,
  actor_id text,
  request_id text,
  summary text not null,
  inline_text text,
  text_truncated integer not null default 0 check (text_truncated in (0, 1)),
  payload_sha256 text,
  payload_byte_count integer,
  external_ref_json text,
  created_at text not null,
  primary key (task_session_id, seq),
  foreign key (task_session_id)
    references task_sessions(id)
    on delete cascade,
  check (
    (text_truncated = 0 and payload_sha256 is null and payload_byte_count is null)
    or
    (text_truncated = 1 and payload_sha256 is not null and payload_byte_count is not null and payload_byte_count > 0)
  )
);

create index task_events_kind_idx
  on task_events(task_session_id, kind, seq);

create index task_events_conversation_idx
  on task_events(conversation_scope_id, task_session_id, seq);
```

### `task_event_payloads`

```sql
create table task_event_payloads (
  event_id text primary key,
  sha256 text not null,
  byte_count integer not null check (byte_count > 0),
  encoding text not null default 'utf8' check (encoding = 'utf8'),
  content text not null,
  created_at text not null,
  foreign key (event_id)
    references task_events(event_id)
    on delete cascade
);
```

The payload row belongs to an event, not the reverse. This removes delete-order coupling: deleting a task cascades to events, and deleting an event cascades to its large payload. Phase 2 exposes no event delete API, but the FK direction keeps parent cleanup deterministic.

The payload store is intentionally text-only in Phase 2. Binary evidence remains in its owning system and is referenced externally.

`task_events` has no update/delete API. Event immutability is enforced by the store boundary and tests in Phase 2; SQLite cannot prevent arbitrary direct writers without triggers, which are intentionally deferred unless a concrete bypass appears.

## Event Shape

The store exposes a typed record similar to:

```ts
interface TaskEventRecord {
  taskSessionId: string;
  seq: number;
  eventId: string;
  kind: string;
  source: string;
  conversationScopeId?: string;
  actorId?: string;
  requestId?: string;
  summary: string;
  inlineText?: string;
  textTruncated: boolean;
  payloadSha256?: string;
  payloadByteCount?: number;
  externalRef?: TaskEvidenceRef;
  createdAt: string;
}

interface TaskEvidenceRef {
  type: 'workspace_file' | 'review_ref' | 'artifact' | 'process' | 'agent' | 'other';
  value: string;
  sha256?: string;
}
```

`kind` and `source` remain open strings in Phase 2 so the journal does not force unrelated subsystems into a premature global enum. Store validation applies these bounds:

- kind: non-empty, at most 128 characters.
- source: non-empty, at most 128 characters.
- summary: non-empty UTF-8 text, at most 4 KiB.
- `external_ref_json`: serialized typed reference, at most 4 KiB.
- actor/request/conversation identifiers: non-empty after trimming when supplied; no arbitrary normalization or identity guessing.

A later integration phase may standardize well-known event kinds.

## Payload Policy

Phase 2 uses one bounded inline threshold:

- `MAX_INLINE_EVENT_TEXT_BYTES = 8 * 1024`.
- If exact payload text is at or below the threshold, `inline_text` stores the complete text, `text_truncated = 0`, and no payload row is created.
- If exact payload text exceeds the threshold, `inline_text` stores a UTF-8-safe prefix no larger than the threshold, `text_truncated = 1`, and the complete text is stored in `task_event_payloads` under the same `event_id`.
- SHA-256 and byte count are calculated from the exact UTF-8 bytes before persistence.
- Large-payload integrity is checked on read: event metadata, payload metadata, and recomputed content digest/byte count must agree. Mismatch returns a structured corruption error and is never silently accepted.
- Empty payload is treated as no payload rather than creating an empty payload row.

The 8 KiB threshold is a storage/inspection bound, not a context-window estimate.

## Append Transaction

`appendEvent()` is the only Phase 2 path that allocates sequence numbers.

Within one `better-sqlite3` `BEGIN IMMEDIATE` transaction:

1. Read the `task_sessions` row.
2. Reject missing or closed tasks.
3. Validate event metadata, optional provenance, and external reference structure.
4. Read `next_event_seq` as the new event sequence.
5. Generate one event id and compute bounded inline text plus large-payload digest/bytes when needed.
6. Insert the event row with that sequence and payload metadata.
7. If the text is large, insert its payload row referencing the new `event_id`.
8. Advance `task_sessions.next_event_seq` from `seq` to `seq + 1` using compare-and-set (`where next_event_seq = ?`).
9. If any step fails, event insertion, payload insertion, and sequence advance all roll back together.

No timestamp is used to define event order.

## Read Contract

`readEvents(taskSessionId, options?)` returns ascending sequence order and supports only bounded filters in Phase 2:

- `afterSeq?: number`
- `limit?: number`, default 100, hard maximum 500
- `kinds?: string[]`, bounded list

Payload bodies are not hydrated by default. Event reads return inline text, truncation state, digest/byte count, and external references. Exact large text is retrieved only through `readPayload(eventId)`.

This avoids making an ordinary history read proportional to the largest historical command output.

## Conversation Semantics

A task event may record `conversation_scope_id` from either the current or a superseded conversation because late evidence can legitimately arrive after a rebind. Recording a stale source is not authority to move the task.

The event store follows this rule:

```text
conversation_scope_id = provenance
not attachment authority
```

`appendEvent()` never changes `task_sessions.current_conversation_scope_id`, lineage generation, workspace binding, approval state, or capabilities.

If a conversation id is provided, Phase 2 requires that it already belongs to the same task lineage. An unrelated conversation is rejected. Both current and superseded bindings are valid provenance.

## External Evidence References

External references prevent duplicate storage when exact evidence already has an owner.

Examples:

- `workspace_file`: a workspace-relative path plus optional digest.
- `review_ref`: a DevSpace review checkpoint reference.
- `artifact`: an imported/native artifact identifier or stable path supplied by the owning artifact subsystem.
- `process`: a process/session receipt identifier.
- `agent`: a durable local-agent session/turn identifier.

The event journal stores the reference but does not assert the referenced evidence still exists. A future verification layer may resolve references and mark degraded evidence. Phase 2 does not copy external bytes into `task_event_payloads`.

## Error Model

Add task-event-specific structured errors:

- `TASK_NOT_FOUND`
- `TASK_CLOSED`
- `INVALID_EVENT`
- `SOURCE_NOT_IN_LINEAGE`
- `PAYLOAD_NOT_FOUND`
- `PAYLOAD_CORRUPT`
- `EVENT_SEQUENCE_CONFLICT`

No error path mutates approval or conversation attachment state.

## Invariants

1. Event sequence is strictly increasing per task.
2. `(task_session_id, seq)` is unique.
3. `event_id` is globally unique.
4. Sequence allocation, event insertion, optional payload insertion, and `next_event_seq` advance are one transaction.
5. A failed append consumes no sequence and leaves no orphan event or payload.
6. Existing event rows are immutable through the store API.
7. Large exact payload text is recoverable and digest-verifiable.
8. Small payload text is exact inline evidence and creates no payload row.
9. Event history reads are bounded and do not hydrate large payloads by default.
10. Conversation id is provenance only and cannot rebind a task.
11. A provided conversation id must already belong to the task lineage.
12. External evidence is referenced, not duplicated.
13. Logger output is not treated as TaskEvent evidence automatically.
14. Task events do not transfer or widen authorization.
15. Deleting a workspace cascades to task sessions, events, and payloads.

## TDD / Verification Plan

RED tests are written before production changes for each behavior:

1. v8 -> v9 migration preserves existing task/session/agent records.
2. Fresh v9 schema creates both journal tables with expected constraints.
3. First append gets seq 1 and advances `next_event_seq` to 2.
4. Repeated appends allocate contiguous sequence numbers.
5. Failed payload/event insertion rolls back sequence, event, and payload.
6. Small text stays exact inline and creates no payload row.
7. Large UTF-8 text creates one payload, bounded inline prefix, correct digest, and exact round-trip.
8. Payload digest/byte-count corruption is detected on read.
9. Reads are ascending, `afterSeq` works, and limits are enforced.
10. Current and superseded conversation provenance is accepted; unrelated conversation provenance is rejected.
11. Rebind state is unchanged by event append.
12. Workspace deletion cascades through events and payloads.
13. Restart/reopen preserves events and exact payloads.
14. Direct store API provides no event update/delete path.

Verification priority:

```text
focused migration tests
-> focused task-event store tests
-> existing task-session tests
-> typecheck
-> relevant DB regressions
-> full suite/build when native dependencies are available
```

Proxy/compatibility execution must be labeled as such and never reported as native `better-sqlite3`/Drizzle CI.

## Files Expected to Change During Implementation

- `src/db/migrations.ts`
- `src/db/schema.ts`
- `src/database-migrations.test.ts`
- new `src/task-event-store.ts`
- new `src/task-event-store.test.ts`
- `docs/worklog-2026-09-17-task-session-kernel.md` or a dedicated Phase 2 worklog

Do not modify `artifact-tools.ts`, approval modules, MCP tool surfaces, browser code, or UI as part of Phase 2 unless a failing test proves that boundary is impossible.

## Out of Scope

- Automatic event capture from every tool call.
- UI timeline/history browser.
- Semantic summaries or LLM-generated compaction.
- Task plan persistence.
- Machine checkpoint manifests.
- Cross-chat handoff orchestration.
- Auto-resume or Goal/Loop behavior.
- Binary evidence storage.
- Retention/pruning policy.
- Approval receipt persistence or inheritance.
- Provider token accounting changes.

## Success Criteria

Phase 2 is ready to move forward only when the journal migration and store satisfy the invariants above under focused tests, and no existing TaskSession attachment/authorization behavior regresses. Native dependency verification remains the preferred acceptance gate; if infrastructure blocks it, the exact proxy/static evidence and unverified gaps must be recorded without upgrading their confidence.