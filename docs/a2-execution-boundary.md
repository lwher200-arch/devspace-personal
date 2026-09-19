# A2 Execution Boundary

Status: incremental implementation. Phase 1 native `run_process` workspace isolation is implemented in the default Linux server startup path. Phase 2 routes `exec_command` / `bash` through the same `WorkspaceExecutionBoundary`. Source profile v4 adds explicit network profiles on top of read-only host filesystem containment, credential-path masking, credential/control-environment filtering and PID/UTS/IPC isolation. Persisted Workspace Lease authority is wired into runtime authorization, and startup/runtime boundary self-verification is implemented with a fail-closed TTL cache. Candidate Workspace Provider v0.1 and Candidate Execution Coordinator route eligible A2 shell/native execution into isolated Candidate state, preserve long-running session bindings, apply the A2 no-network profile and return bounded mutation evidence while Stable Workspace remains unchanged. RCF mutation verification/promotion, restart-durable Candidate state and a verified allowlisted egress profile remain incomplete. Lease request/activation has no public MCP or configuration entry point yet, so a fresh instance does not enable A2 Candidate execution for ordinary clients. Runtime deployment must be verified separately from source state.

This document defines the target execution boundary for long-lived DevSpace workspace
authorization. It intentionally separates **authority** (what the user has allowed)
from **guarding** (what DevSpace will actually execute) and from **promotion** (what
candidate changes may become stable workspace state).

The design is fail-closed. Until the boundary, candidate workspace, mutation
verification and recovery contracts below are implemented and verified, existing
conversation leases remain legacy exact-operation leases and must not be presented
as A2 workspace authorization.

## 1. Current-state evidence

The current implementation establishes several facts that this design must preserve.

- Linux source project execution is wrapped by
  `linux-bwrap-workspace-rw-host-ipc-masked-env-filtered-net-profile-v4`: the host filesystem is read-only,
  the selected workspace is writable, common host credential locations are masked,
  current-user runtime/control sockets are hidden, common machine-control sockets
  are masked, PID/UTS/IPC namespaces are isolated, and common credential/control
  environment variables are removed before bounded project execution. Legacy
  explicitly approved execution retains inherited networking; A2 Candidate
  execution sets `networkProfile="none"`, which the Bubblewrap backend implements
  with `--unshare-net`.
- Phase 2 source routes `exec_command` / `bash` through the same configured boundary,
  including pipe and PTY execution. Non-PTY POSIX shell execution retains the
  pre-A2 `-c` contract; PTY execution retains the prior shell-resolution semantics.
- `host_command` remains an explicit Owner-gated, unsandboxed maintenance/recovery
  plane and is not a project execution substitute.
- Current conversation leases are in-memory, exact-scope grants whose lifetime is
  tied to the approval record. `OwnerApprovals` explicitly clears grants on restart.
- A2 `WorkspaceLeaseStore` records are persisted independently from those legacy
  conversation leases. Runtime authorization now observes and recovers the latest
  matching persisted lease for project shell/native requests, but an ACTIVE lease
  remains authority-only: until Candidate Workspace is available,
  `executionEligible=false` and the existing Owner approval path remains in force.
- Persisted lease integrity failure blocks execution instead of falling back to a
  legacy approval. Boundary absence suspends recovery; policy/profile mismatches
  invalidate the lease.
- Candidate Workspace Provider v0.1 creates storage outside Stable Workspace,
  snapshots regular files using reflink-when-supported or independent copy,
  rewrites internal symlinks to Candidate-local targets, rejects escaping/broken
  symlinks and special filesystem nodes, verifies Stable did not drift during
  snapshot creation, and reports created/modified/deleted paths plus Stable drift.
- Candidate Provider v0.1 is not yet an execution authority. Until the execution
  coordinator and runtime authorization both confirm the current request, an ACTIVE
  A2 lease remains `executionEligible=false`.
- Candidate Execution Coordinator now mints a short-lived, single-use in-memory
  execution grant only when the persisted lease is ACTIVE, the configured boundary
  is explicitly verified, and the Candidate provider probe succeeds. That private
  grant is consumed by `exec_command`, `bash` or `run_process` to remap
  `workspaceRoot` and `cwd` to Candidate state.
- Running shell/native sessions keep their Candidate binding across
  `write_stdin`, `process_status` and `process_cancel`. Final responses include
  bounded created/modified/deleted mutation evidence and Stable drift state.
- Eligible A2 Candidate execution bypasses the legacy per-operation Owner approval
  for that project execution request only. `host_command`, file edits, promotion
  and other protected operations retain their existing authorization contracts.
- A2 Candidate execution carries `networkProfile="none"` through
  `exec_command`, `bash` and `run_process` into the process manager. Process
  snapshots and Candidate execution evidence report the effective network profile.
  The A2 lease policy version is `a2-workspace-lease-v2-network-none`, so leases
  created under the earlier policy do not silently inherit the new network semantics.
- Boundary verification is supplied by a trusted startup/runtime self-test and is
  refreshed through a fail-closed verification cache. Workspace Lease runtime
  eligibility reads that live verification result; verification loss suspends
  recovery rather than silently preserving execution authority. Candidate state
  is not promoted automatically and is not yet restart-durable.
- `APPROVAL_TTL_SECONDS` is currently 30 minutes by default and at most two hours.
- Provider-specific sandboxes already exist for some delegated agents. In particular,
  Pi uses `@anthropic-ai/sandbox-runtime` and has tests for workspace write
  containment, symlink escape rejection and protected workspace environment files.
  This remains useful prior art but is not the backend used by the model-facing
  shell/native process tools.
- Worktrees and file-tool root checks are workflow/file-tool boundaries, not an OS
  process boundary.

The A2 design therefore adds a new execution-control plane instead of extending the
meaning of the existing approval map.

## 2. Goals and non-goals

### Goals

1. A user can grant a bounded 4h/8h/12h/24h workspace lease without granting raw
   standing machine-shell authority.
2. Every lease execution remains subject to RCF observation, boundary preflight,
   mutation verification and incident policy.
3. Arbitrary process execution cannot read private host credentials or mutate other
   projects merely because a lease is active.
4. Workspace-internal destructive or unexpectedly broad changes are isolated in a
   candidate view before stable state is changed.
5. Restart recovery never treats persisted authority or incidents as trustworthy
   merely because a row exists on disk.
6. Host-notification failure cannot lose an incident or silently convert it into
   continued execution.

### Non-goals

- A2 is not a VM or protection against a compromised kernel.
- A local user who can modify DevSpace code, its integrity key and its database is
  outside this software-only trust boundary. Signatures provide tamper detection
  against accidental/stale state and processes without the key; they are not hardware
  attestation.
- A2 does not make arbitrary network access safe. Network authority is an independent
  capability and is denied or narrowly profiled until an explicit egress policy is
  verified.
- A2 does not infer safety from command text alone.

## 3. Core invariants

The following invariants are normative.

1. `authority != execution`: an ACTIVE lease allows DevSpace to consider continued
   work; it does not bypass RCF, boundary or mutation policy.
2. `workspace != machine`: workspace identity selects a project; it never implies
   local-user machine authority.
3. `candidate != stable`: mutation-capable lease execution targets a candidate view.
4. `verify != exitCode`: process success is only one input to verification.
5. `unknown != safe`: missing boundary capability, missing mutation evidence,
   ambiguous promotion or recovery mismatch fails closed.
6. `promotion != replay`: DevSpace promotes verified candidate state; it does not
   rerun a non-deterministic command against Stable Workspace.
7. `restart != reset`: unresolved incidents survive restart and dominate lease
   recovery.
8. `break-glass != lease`: a one-time exception never widens or persists the
   workspace lease.

## 4. Target execution flow

```text
Workspace Lease ACTIVE
        |
        v
RCF OBSERVE
        |
        v
Boundary Preflight
        |
        v
RCF ASSESS
        |
        v
Candidate Workspace
        |
        v
Isolated Workspace Executor
        |
        v
Mutation Observer
        |
        v
RCF VERIFY
        |
        +--> PROMOTE
        +--> HOLD
        +--> QUARANTINE
        `--> EMERGENCY_FREEZE
```

The authorization decision and guard decision remain separate:

```text
Authority = the user permits continued bounded work in this workspace.
Guard     = DevSpace decides whether this exact execution may proceed and whether
            its candidate result may become stable state.
```

## 5. Workspace lease

### 5.1 Identity

A lease is valid only for the conjunction:

```text
same verified OAuth client
AND same Chat conversation scope
AND same canonical workspace root
AND lease state permits execution
AND boundary profile is VERIFIED
```

Transport reconnects do not change identity. A different OAuth client, different
logical conversation or different canonical root misses the lease.

### 5.2 Lifetime

Approval request lifetime and workspace lease lifetime are independent:

```text
ApprovalRequestTTL = default 30m, current bounded request window
WorkspaceLeaseTTL  = one of 4h / 8h / 12h / 24h
```

The lease deadline begins when the user approves the workspace lease, not when the
approval request was created. Lease deadlines are fixed and do not slide on use.

### 5.3 State machine

```text
REQUESTED
   |
   v
ACTIVE <-------------------+
   |                        |
   +--> SUSPENDED ----------+
   |
   +--> EXPIRED
   +--> REVOKED
   `--> INVALIDATED

persisted ACTIVE/SUSPENDED
   |
   v
RECOVERING
   +--> ACTIVE or SUSPENDED
   `--> INVALIDATED
```

`SUSPENDED` preserves the unexpired lease record while blocking new execution.
L2/L3 incidents, failed recovery checks and explicit safety holds can suspend it.

Existing exact-command conversation leases are not migrated into this state machine.
They remain legacy behavior until they expire or are revoked.

## 6. WorkspaceExecutionBoundary

The public contract is backend-independent:

```ts
interface WorkspaceExecutionBoundary {
  probe(profile: BoundaryProfile): Promise<BoundaryProbe>;
  execute(request: BoundaryExecutionRequest): Promise<BoundaryExecutionResult>;
}

interface BoundaryProfile {
  version: string;
  workspaceMode: "candidate";
  network: "none" | "allowlisted";
  privateTmp: true;
  hideHostCredentials: true;
  systemRuntime: "read_only";
}
```

The initial Linux profile must make the effective view equivalent to:

```text
/workspace       RW (candidate only)
/usr             RO
/bin             RO
/lib*            RO
required runtime RO
/tmp             private
~/.ssh           invisible
~/.aws           invisible
~/.gnupg         invisible
DevSpace state   invisible
other projects   invisible or non-writable
```

Environment variables are also part of the boundary. Known credential-bearing
variables are removed unless an explicit capability profile provides a narrowly
scoped value.

### 6.1 Backend selection

The policy contract must not depend on one sandbox library.

1. First evaluate whether the already-declared `@anthropic-ai/sandbox-runtime` can
   satisfy the A2 process contract on the supported Linux lane. Existing Pi tests are
   useful prior art but are not sufficient acceptance evidence for `exec_command` or
   `run_process`.
2. A direct Bubblewrap/user-namespace backend may be used when it better satisfies
   the contract or when the reusable runtime cannot provide required mount/process
   semantics.
3. Backend selection is capability-probed at startup/recovery. No backend may silently
   fall back to an unconfined local shell.

If no verified backend is available, A2 lease execution is unavailable. DevSpace
returns to explicit single-operation approval or a separately labelled break-glass
path; it does not claim the workspace is A2-isolated.

### 6.2 Network

Initial A2 lease execution defaults to no general network capability. The current
Bubblewrap implementation applies `--unshare-net` for A2 Candidate execution while
legacy single-operation Owner-approved project execution keeps inherited networking.
The startup/runtime verifier requests the no-network profile and requires the child
process to enter a different Linux network namespace from the DevSpace service
process; failure blocks verified A2 execution.

A verified, versioned allowlist profile for package registries/source hosts remains
future work and must reuse the same fail-closed principle. Unrestricted host network
access is break-glass, not an inherited A2 lease capability.

## 7. CandidateWorkspaceProvider

Arbitrary shell/native execution is treated as mutation-capable. Under an A2 lease
it executes against a candidate view even when the expected command is read-only.

```ts
interface CandidateWorkspaceProvider {
  probe(root: string): Promise<CandidateCapability>;
  create(root: string, executionId: string): Promise<CandidateWorkspace>;
  inspect(candidate: CandidateWorkspace): Promise<CandidateMutationSet>;
  discard(candidate: CandidateWorkspace): Promise<void>;
}
```

Preferred implementations use copy-on-write/overlay semantics. Reflink or other
copy-on-write strategies are acceptable only when their containment, symlink,
metadata and cleanup behavior are verified. A Git worktree alone is not a complete
candidate provider because it does not represent arbitrary uncommitted/untracked
workspace state.

If a safe candidate cannot be created, mutation-capable lease execution fails closed.
The caller may request a one-time explicitly labelled legacy/break-glass execution,
but that exception never changes the lease.

## 8. Mutation Observer

```ts
interface MutationSummary {
  created: string[];
  modified: string[];
  deleted: string[];
  moved: Array<{ from: string; to: string }>;
  changedBytes: number;
  affectedModules: string[];
  sensitiveTargets: string[];
  unexpectedTargets: string[];
  expectedScope: string[];
  actualScope: string[];
  riskLevel: "L0" | "L1" | "L2" | "L3";
}
```

Evidence sources are combined, but they have different authority:

- candidate upper-layer/COW mutation set: primary mutation evidence when available;
- baseline snapshot and Git status/diff: reconciliation and semantic evidence;
- filesystem event stream: acceleration/observability only; event loss cannot make a
  mutation disappear;
- sensitive-path rules and count/byte thresholds: policy inputs.

Large projects must not be fully re-hashed after every command. Baseline hashes are
created lazily for affected paths and promotion preconditions. Directory-level
fingerprints may be used as accelerators but never as the only evidence for a file
that will be promoted.

Example:

```text
Expected: modify 2 files
Actual:   delete 46 files
Result:   scope mismatch -> at least L2 -> QUARANTINE
```

## 9. RCF incident policy

The first implementation uses deterministic rules rather than pseudo-probability.

### L0 — Promote candidate

- boundary evidence complete;
- actual mutation is inside the allowed/expected scope;
- sensitive-path rules are satisfied;
- required targeted verification passes.

### L1 — Hold

- result remains contained but verification is inconclusive or expected tests fail;
- mutation is larger than expected but does not hit a protected/sensitive boundary;
- user review is required before promotion or discard.

New mutation-capable execution is paused for the candidate lineage until the hold is
resolved.

### L2 — Quarantine

- unexpected destructive breadth;
- sensitive workspace targets are modified unexpectedly;
- expected/actual scope diverges materially;
- mutation evidence is inconsistent.

The candidate is retained as evidence. New A2 execution for the workspace is
suspended until the incident is resolved.

### L3 — Emergency Freeze

- attempted or observed boundary escape;
- boundary self-test/integrity failure during an active lease;
- DevSpace lease/incident/promotion state is targeted from inside the sandbox;
- promotion partially fails and rollback cannot be proven complete;
- recovery detects tampered or contradictory incident state.

The workspace lease becomes `SUSPENDED` and the durable incident remains
`EMERGENCY_FREEZE` across restart.

## 10. Promotion

Promotion is based on candidate state, not command replay.

For every promoted path DevSpace records at minimum:

```text
base identity/hash
candidate identity/hash
operation (create/modify/delete/move)
promotion result
rollback material/reference
```

Promotion revalidates the stable preimage immediately before applying each change.
If Stable Workspace changed since candidate creation, promotion stops in HOLD rather
than overwriting concurrent work.

Multi-file promotion is transaction-like but must not be described as OS-atomic.
The implementation uses a mutation journal and rollback material. Any failed apply
triggers rollback; an incomplete or unprovable rollback escalates to L3.

## 11. Persistent lease and incident records

### 11.1 Lease record

Persist only the minimum recovery envelope:

```text
leaseId
OAuth client identity
conversation scope
canonical workspace root
issuedAt
expiresAt
requestedDuration
state
policyVersion
boundaryProfile
integrity
signature
```

Never persist in the lease:

```text
OAuth token
Owner password
approval decision capability/token
shell command allowlist
Chat private metadata credential
```

The integrity key is DevSpace-local and stored with restrictive local permissions.
HMAC-SHA-256 is sufficient for the software integrity goal; the key is not described
as hardware-backed identity.

### 11.2 Recovery

```text
PERSISTED -> RECOVERING
```

Recovery requires all of:

1. same verified OAuth client;
2. same logical conversation scope;
3. same canonical/anchored workspace root;
4. lease has not expired or been revoked;
5. persisted signature and schema are valid;
6. policy/boundary profile is compatible with the running version;
7. boundary self-test passes;
8. no unresolved incident requires suspension.

Only then may recovery enter ACTIVE. Any mismatch enters INVALIDATED or SUSPENDED as
appropriate.

The boundary self-test uses harmless generated sentinels: it proves candidate writes
work, an outside path cannot be read/written, protected state is not visible, private
temp is isolated and the declared network profile matches. It never reads a real
credential merely to prove credentials are hidden.

### 11.3 Incident record

Incidents are durable and independently recoverable from leases:

```text
incidentId
leaseId/workspace identity
executionId
risk level
state
mutation evidence references
createdAt/updatedAt/resolvedAt
resolution action
integrity/signature
```

An unresolved L3 incident forces lease recovery into SUSPENDED. Restart cannot clear
or downgrade it.

## 12. Notification Outbox

Host follow-up delivery is an at-least-once *state machine*, but execution must remain
idempotent with respect to notification retries.

```text
QUEUED -> DELIVERING -> DELIVERED
            |
            `-> PENDING_HOST
```

`PENDING_HOST` is durable. Reconnection may reconcile and deliver it later. A
delivery attempt never approves, promotes or resumes execution by itself.

The UI keeps a persistent unresolved-incident indicator even when follow-up delivery
is impossible. DevSpace does not claim it can wake a ChatGPT conversation when the
host provides no such capability.

## 13. UI contract

The primary card stays status-oriented:

```text
DevSpace
  Workspace lease: ACTIVE · 7h 18m
  RCF state: Stable
```

Contained incident:

```text
Workspace lease: SUSPENDED · 7h 02m remaining
RCF state: Quarantined
Action required
```

L3:

```text
Workspace lease: SUSPENDED
Emergency Freeze
Action required
```

The gear/details surface may expose:

- request/extend 4h, 8h, 12h or 24h lease;
- revoke lease;
- continue/reject/quarantine/accept candidate/discard candidate;
- return to stable point;
- Approval Center and Owner fallback;
- incident evidence and mutation diff;
- processed history and refresh.

The UI must display legacy exact-command conversation leases separately from an A2
workspace lease until the legacy path is retired.

## 14. Break glass

Break glass is single-use, prominently labelled and never stored in a workspace
lease. It is required for capabilities such as:

- host paths outside the workspace boundary;
- unrestricted network;
- host credentials;
- DevSpace state/config mutation;
- an intentionally unconfined command.

The approval view must show the exact requested capability and why A2 cannot satisfy
it. Completion does not mutate the A2 boundary profile or lease policy.

## 15. Implementation seams

Keep the new contracts separate from provider adapters:

```text
src/execution-boundary/
  types.ts
  workspace-execution-boundary.ts
  boundary-probe.ts
  backends/...

src/candidate-workspace/
  types.ts
  provider.ts
  mutation-observer.ts
  promoter.ts

src/workspace-lease/
  types.ts
  store.ts
  recovery.ts

src/incidents/
  types.ts
  store.ts
  policy.ts

src/notifications/
  outbox.ts
```

Exact file names may change during implementation, but the ownership boundaries
should not collapse back into `mcp-authorization.ts` or `process-sessions.ts`.

`ProcessSessionManager` remains process lifecycle plumbing. A2 supplies the prepared
execution environment/candidate cwd and receives process evidence; process-session
code must not become the policy owner.

## 16. Four implementation cuts

### I. Workspace Lease

- introduce independent lease TTL and state machine;
- persist signed recovery envelope;
- add restart recovery tests;
- keep legacy exact-command lease behavior explicitly labelled and separate.

Acceptance gate: no workspace lease can become ACTIVE without a verified boundary
profile identifier, even though Cut III is not yet enabled for execution.

### II. Minimal UI + Notification Outbox

- status-first card and gear/details actions;
- durable outbox;
- suspension/incident presentation;
- no background-wake claim.

Acceptance gate: host delivery failure leaves visible durable pending state.

### III. A2 Execution Boundary + Candidate Workspace

- boundary backend capability probe;
- candidate provider;
- `exec_command` and `run_process` A2 execution path;
- credential/home/state hiding, private tmp and network profile;
- no silent unconfined fallback.

Acceptance gate: containment E2E proves inside candidate writes succeed while
outside write/read, symlink escape and protected host-state access fail.

### IV. RCF Incident / Mutation Journal / Verify / Promote / Rollback

- deterministic mutation summary/risk rules;
- verification hooks;
- promotion journal and preimage checks;
- durable incidents and restart freeze;
- rollback and failure-containment tests.

Acceptance gate: an intentionally broad destructive candidate never modifies Stable
Workspace, and an unresolved L3 remains frozen after process restart.

## 17. Required verification matrix

At minimum:

1. boundary dependency missing -> A2 execution denied, no unconfined fallback;
2. read/write `~/.ssh`, `~/.aws`, `~/.gnupg`, DevSpace state -> denied;
3. symlink from workspace to outside -> cannot escape;
4. other project path -> not writable/visible under the profile;
5. `/tmp` isolation between executions;
6. network none/allowlist profile behaves exactly as declared;
7. candidate `rm -rf src` -> Stable Workspace unchanged before promotion;
8. unexpected 46-file deletion -> L2 quarantine;
9. stable preimage changes before promotion -> HOLD, no overwrite;
10. partial promotion with failed rollback proof -> L3;
11. service restart with valid lease -> RECOVERING -> ACTIVE only after self-test;
12. service restart with policy/root/client/conversation mismatch -> INVALIDATED;
13. service restart with unresolved L3 -> SUSPENDED + EMERGENCY_FREEZE;
14. expired/revoked lease never recovers;
15. notification bridge unavailable -> PENDING_HOST, incident retained;
16. break-glass completion does not create/extend A2 authority.

## 18. Architecture debt deliberately avoided

- Do not add more command-string deny/allow regexes and call them a sandbox.
- Do not overload `Approval.expires` for the 4h-24h workspace lease.
- Do not persist current in-memory conversation leases and rename them workspace
  leases.
- Do not make process session code own authorization, candidate or incident policy.
- Do not rely on filesystem watcher completeness for promotion evidence.
- Do not rerun a candidate command against stable state.
- Do not represent provider-native sandbox evidence as DevSpace A2 evidence.
- Do not silently degrade to local-user shell when a sandbox backend is unsupported.

## 19. Review decisions before implementation

The following are the only material choices that remain open after this document:

1. Which backend satisfies `WorkspaceExecutionBoundary` best on the target Ubuntu
   host: reusable `@anthropic-ai/sandbox-runtime`, direct Bubblewrap, or both behind
   one interface.
2. Which COW candidate provider is available without privileged mounts on the target
   host.
3. The exact deterministic thresholds for L1/L2 (file count, changed bytes and
   sensitive-target rules).
4. Whether the first networked A2 profile ships in Cut III or remains break-glass
   until a later hardening cut.

These choices are implementation decisions, not permission to weaken the invariants
above.
