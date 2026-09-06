# ChatGPT and Local Codex Bridge

This local extension adds five OAuth-protected MCP tools: `codex_preflight`,
`codex_task_start`, `codex_task_continue`, `codex_task_status`, and `codex_tasks`. Enable them with
`bridge.enabled` in the v1 `config.jsonc`. Start/status responses include the
DevSpace agent ID and, when available, the Codex provider thread ID.

## Operating Model

ChatGPT submits one task, polls its bounded status, and reports the result in the
originating conversation. Follow-ups reuse the agent ID and Codex context. Each
new turn uses a unique request key; network retries reuse the same key and input.
Receipts survive service restarts. Uncertain delivery must be reconciled rather
than automatically repeated. Only one bridge task should run per directory.

The bridge starts the official local Codex app-server over stdio. It does not
expose an app-server network listener or take over an arbitrary existing desktop
task. Native Codex desktop tools can send a prompt to the explicitly approved
ChatGPT chat and read its result. Those native tools are not implicitly available
inside a standalone Codex worker. The `devspace-closed-loop` skill and local
`closed-loop-route.json` document the approved routing and stop conditions.

There is no cookie extraction, private ChatGPT API, infinite relay, or unattended
browser control. This is an on-demand, bounded round trip. ChatGPT may need its
connector tools refreshed after deploying the extension.

## Permissions

Default `writeMode` is `read_only`. `allowed` requires both a user-requested edit
and `bridge.allowWorkspaceWrite` enabled by the local administrator. The bridge
never accepts `full_access`. Existing OAuth, allowed roots, and Codex sandbox
settings remain in force. Configured workspace aliases remain supported by file
tools; bridge submissions require the canonical directory path to avoid alias
based concurrent execution. Do not broaden allowed roots to work around a denial.

## Verified Model Policy

An optional `bridge.executionPolicy` pins protected calls without changing
ordinary manual sessions or the machine-wide Codex preferences:

```json
{
  "requiredModel": "gpt-6-astra",
  "minimumCliVersion": "0.153.0"
}
```

Pass `model` explicitly on every protected MCP start and continuation. MCP-launched
`devspace agents run/continue` commands also receive this policy and must specify
`--model`. A protected durable task retains its policy; it cannot be removed or
replaced on continuation. Existing unprotected calls keep their legacy defaults.
An older daemon without `executionPolicyVersion: 1` is rejected before delivery;
stop an idle old daemon explicitly before deploying the updated implementation.

`codex_preflight` reports the actual resolver output, policy and informational
provider default. It does not start inference or prove account model access.
The worker checks the binary version, initialized app-server version/home,
account model catalog, explicit session model, workspace and sandbox before a
turn. Model reroutes, timeouts, failures and missing evidence reject the result.
Never use the model's prose or `thread.model` as execution telemetry.

Completed protected results include `requestedModel` and `executionEvidence`,
containing the exact completed turn ID and model from the provider's `turn_context`
rollout record. Evidence reads are confined to that Codex home's session roots,
bounded to a 64 MiB regular file and five seconds per read. Unsupported/oversized
records fail closed, rather than silently substituting session configuration.
This is provider-reported evidence, not independent attestation of upstream model
internals. Historical results without matching evidence are withheld by the bridge.

Protected turns close their app-server after completion and resume from durable
state next time. Codex 0.153.4 can keep an already-loaded session's previous sandbox
on `thread/resume`; disposable per-turn processes prevent stale permissions and
context. Successful closure allows a bounded EOF flush; failed runs terminate
their isolated process. This adds startup cost, but does not change legacy pooling.
Failure after work begins can leave changed files; inspect them before retrying.

Pin `CODEX_COMMAND` only in the DevSpace supervisor environment to select a
verified binary. The ordinary shell `codex` command may still refer to another
installation. The installer preserves an existing service pin. Do not change
global PATH/model settings as a workaround for an unverified route.

File tools validate logical and physical containment, including normalized paths
and missing suffixes. Workspace root identities persist across restarts. Older
workspace sessions without an anchor must be reopened once. These guards are not
an OS sandbox against every concurrent filesystem mutation; DevSpace shell tools
still run with their configured local process permissions.

## Windows Operations

The public repository does not include the original machine-specific
`scripts/windows` deployment bundle. It contains private routing identifiers and
absolute paths and has not been promoted to a portable installer. Existing local
copies are preserved; the ignore rule prevents accidentally publishing them.

Build this fork from source as described in [FORK.md](../FORK.md), then configure
your own approved roots, credentials, tunnel and verified Codex executable.
Do not reuse another machine's owner credential or ChatGPT conversation binding.
The runtime still requires the upstream-supported dependencies; these extensions
do not claim support for a Windows installation without a compatible shell.

If supervising the service, preserve the original environment and explicitly
validate the command paths. Use a least-privilege user, preserve custom settings
on upgrades, and keep complete private backups of every overwritten artifact.
Logon startup is not connectivity before login or while the computer sleeps.

For rollback, stop all writers and restore a matching code/configuration set.
SQLite restoration must account for WAL/SHM files and must never overwrite an
active database. Restoring ACLs can reintroduce broader historical permissions.

The execution-contract migration adds a nullable column; no existing task or OAuth
row is removed. Keep its online backup private, outside shared project roots.
Before rolling back to code without policy enforcement, disable the Codex bridge
and stop all task writers; do not silently restore an unguarded programming route.

## Verification

- `pnpm typecheck`
- `pnpm test`
- `node node_modules/tsx/dist/cli.mjs --test src/path-boundary.test.ts src/codex-bridge.test.ts`

Source tests use isolated fixtures and mocked providers where appropriate. A
passing unit test is not proof of live ChatGPT linking, a fresh installation or
actual model execution. Perform live handoff tests only with user authorization,
an explicit approved model and matching runtime evidence; keep credentials and
production state outside the public repository.
