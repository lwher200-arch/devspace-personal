---
name: subagents
description: Delegate focused coding, research, review, or verification work to a bounded DevSpace subagent. Use when a task benefits from separate context, a specialist perspective, or a follow-up with the same worker.
---

# DevSpace subagents

Use direct workspace tools for ordinary reads, searches and guarded edits. Delegate only when a separate worker materially helps; one primary executor should own each complex scope.

Use the DevSpace CLI through the shell or process tool. Run commands from the project the subagent should work on.

## Choose a target

Discover usable targets instead of guessing names:

```bash
devspace agents targets --json
```

Configured profiles include a description and may define provider, model, effort, and task instructions. Choose a matching profile when one fits. Use a provider target when no profile fits or a specific provider is needed.

Unprotected manual sessions may use the target's configured model and effort. Protected Codex work launched through MCP instead requires an explicit approved model on every start and continuation. Use `codex_preflight` first; missing version/model evidence or unavailable access must stop that route, not trigger a model or channel fallback. Prefer the dedicated Codex bridge when it is available for the authorized task. DevSpace does not translate model IDs between providers.

## Start work

Give the subagent a self-contained brief. Include the objective, relevant paths, constraints, decisions it needs from the current conversation, and the expected result. The subagent receives the brief and its profile instructions, not the parent conversation.

```bash
devspace agents run <profile-or-provider> "<brief>" --json
devspace agents run <profile-or-provider> --model <model> --effort <effort> "<brief>" --json
```

The result contains a DevSpace agent `id` and its current status. Execution continues independently, so retain the ID for later inspection or follow-up.

## Inspect and continue

```bash
devspace agents show <id> --json
devspace agents continue <id> "<follow-up brief>" --json

devspace agents continue <id> --model <approved-model> "<follow-up brief>" --json
devspace agents ls --json
```

- `show` waits briefly for active work, then returns the current status and any
  available response or error.
- `continue` gives the same subagent another turn with its existing provider
  session and context.
- `ls` returns sessions belonging to the current project.

Run `devspace agents show <id> --json` again later while the status is `running`.
`completed` includes the response. `failed` includes a structured error, and
`stopped` is terminal without a successful response. Continue an agent when its
existing context is useful; start another agent for unrelated work.

## Good uses

- Review a change for correctness, security, or missing tests.
- Investigate a bounded part of a codebase and report findings.
- Implement one isolated change with clear acceptance criteria.
- Run a focused verification pass after other work.
