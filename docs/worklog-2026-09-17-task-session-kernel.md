# Task Session Kernel — 2026-09-17

## Current State

Phase 1 introduces a durable task identity above workspace and Chat conversation identity. The candidate is isolated on `feat/task-session-kernel` and is not merged or deployed.

The phase is intentionally limited to persistence and the transaction seam. It does not add automatic compaction, browser automation, task events, task plans, checkpoint manifests, approval inheritance, or a new model-facing tool.

## Changes

- Add database migration v8, `task-session-kernel`.
- Add `task_sessions` as the durable task identity scoped to an existing workspace session.
- Add `task_session_bindings` as immutable conversation-lineage membership with one current binding per task.
- Make a conversation scope permanently owned by the first task lineage that records it; superseded conversations cannot be reassigned to another task.
- Add `SqliteTaskSessionStore` with create, lookup, binding history, and atomic rebind operations.
- Fence stale source conversations, destinations owned by another task, and attempts to revive a superseded destination.
- Keep task continuity separate from authorization. No approval receipt, conversation lease, capability, credential, or permission is migrated by this layer.

## Invariants

1. A task has one durable identity even when its current conversation changes.
2. At most one binding for a task is `current`.
3. `(task_session_id, generation)` is unique and monotonically advances on replacement.
4. A conversation scope belongs to only one task lineage for its lifetime in the store.
5. A superseded conversation cannot become current again.
6. Rebind checks the expected source before changing state.
7. Source supersession, destination insertion, and task-pointer update share one `BEGIN IMMEDIATE` transaction through `better-sqlite3` transaction semantics.
8. A failed or stale rebind leaves the prior durable attachment authoritative.
9. Deleting a workspace cascades through task sessions and their bindings.
10. Authorization state is outside this schema and is not inherited through rebind.

## Verification

Test-first contracts were added to `src/database-migrations.test.ts` and `src/task-session-store.test.ts` before or ahead of their matching production changes.

A SQLite 3.46.1 proxy executed the exact Phase 1 table/index constraints and verified defaults, invalid-state CHECK rejection, one-current-task enforcement, permanent conversation ownership, workspace cascade, stale-source rejection, destination-owner rejection, retired-destination rejection, and rollback-preserved state. This is SQL/transaction contract evidence, not a substitute for executing the repository's TypeScript suite.

The repository's `codex/personal` baseline GitHub CI was already failing on all three OS jobs before this candidate. A temporary branch-only targeted workflow was tried, but GitHub returned jobs with no executed steps / no assigned runner, so those workflow failures are not treated as test failures or passes. The temporary workflow was removed from the candidate.

The current execution environment cannot install the repository dependencies because registry DNS access fails, so `pnpm`, `tsx`, the targeted TypeScript tests, full typecheck, and build have not been executed for this candidate yet.

## Known Risks / Debt

- `task_sessions.current_conversation_scope_id` and the binding table are kept consistent by `SqliteTaskSessionStore`; direct database writers can still violate the projection unless future access is centralized behind the store.
- The store is not connected to the MCP/server conversation lifecycle yet. No current production call creates or rebinds a task session.
- No task event log exists yet; `next_event_seq` is reserved for Phase 2 and is intentionally unused.
- No recovery/checkpoint layer exists yet. Rebind here is only the durable local attachment transaction, not cross-chat handoff orchestration.
- Repository-level TypeScript compilation and tests remain unverified until an executable dependency environment or working hosted runner is available.

## Next Highest-Leverage Step

First execute the two focused test files and typecheck in a working repository environment. Fix any concrete compile/runtime failures without expanding scope. Once Phase 1 is green, Phase 2 should add an append-only `task_events` evidence journal with bounded inline payloads and existing artifact references. Do not implement auto-compact, Goal/Loop behavior, browser DOM control, or approval inheritance as part of that phase.
