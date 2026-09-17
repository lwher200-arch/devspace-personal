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

A SQLite 3.46.1 proxy executed the exact Phase 1 table/index constraints and verified defaults, invalid-state CHECK rejection, one-current-task enforcement, permanent conversation ownership, workspace cascade, stale-source rejection, destination-owner rejection, retired-destination rejection, and rollback-preserved state.

A second bounded verification pass used the actual `src/task-session-store.ts` and `src/db/migrations.ts` source from this branch. Global TypeScript transpilation reported zero syntax diagnostics. The store source was executed through a temporary Node 22 `node:sqlite` compatibility adapter: 6/6 behavior checks passed for create, atomic rebind, stale-source rollback, permanent cross-task conversation ownership, retired-conversation fencing, and first attachment of an unbound task. The migration source was executed through the same adapter: 5/5 checks passed for fresh/idempotent v8 migration, v7 preservation, incompatible-history refusal, rollback when the v8 journal write fails, and lineage/state constraints. A strict `tsc --noEmit` pass over the changed store and migration sources also exited successfully using minimal local declaration stubs for unavailable external packages.

These proxy runs exercise the branch's production store/migration logic, but they are not a substitute for the repository's native `better-sqlite3`, `drizzle-orm`, `tsx`, full typecheck, build, or complete test suite. The adapter intentionally exists only outside the repository and was not committed.

The repository's `codex/personal` baseline GitHub CI was already failing on all three OS jobs before this candidate. A temporary branch-only targeted workflow was tried, but GitHub returned jobs with no executed steps / no assigned runner, so those workflow failures are not treated as test failures or passes. The temporary workflow was removed from the candidate.

The current execution environment cannot install the repository dependencies because DNS access to GitHub/npm is unavailable, and it contains no cached `better-sqlite3`, `drizzle-orm`, `tsx`, or `pnpm`. Therefore the native focused tests, repository-level typecheck, build, and full regression suite remain unexecuted for this candidate.

## Known Risks / Debt

- `task_sessions.current_conversation_scope_id` and the binding table are kept consistent by `SqliteTaskSessionStore`; direct database writers can still violate the projection unless future access is centralized behind the store.
- The store is not connected to the MCP/server conversation lifecycle yet. No current production call creates or rebinds a task session.
- No task event log exists yet; `next_event_seq` is reserved for Phase 2 and is intentionally unused.
- No recovery/checkpoint layer exists yet. Rebind here is only the durable local attachment transaction, not cross-chat handoff orchestration.
- Native repository compilation and tests remain unverified until an executable dependency environment or working hosted runner is available.

## Next Highest-Leverage Step

Run `src/database-migrations.test.ts`, `src/task-session-store.test.ts`, `pnpm typecheck`, and the relevant database/workspace regressions in the real repository dependency environment. Fix only concrete failures. Phase 2 (`task_events` with bounded inline payloads and existing artifact references) should begin only after that native gate is green. Do not implement auto-compact, Goal/Loop behavior, browser DOM control, or approval inheritance as part of that phase.
