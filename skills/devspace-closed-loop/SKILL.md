---
name: devspace-closed-loop
description: Use for explicit DevSpace ChatGPT and local Codex handoffs or bidirectional round-trip tests. Keeps task identity, read-only defaults, and bounded delivery. Not a background autonomous relay.
---

# DevSpace Closed Loop

Use one controller and one round trip unless the user asks for more. Transfer a
minimal task brief, not credentials, cookies, unrelated chats, or entire history.

## ChatGPT to Local Codex

1. Open the user-authorized workspace with DevSpace `open_workspace`.
2. Call `codex_preflight` to inspect the actual executable/version and execution
   policy. This does not prove account model availability or completed inference.
   Submit `codex_task_start` with workspaceId, prompt, a unique requestKey, and
   explicit model required by the policy. Do not inherit the Chat model or provider default.
   Default to read_only. Use allowed only for user-authorized code changes and
   only if the server administrator enabled workspace writes.
3. Preserve the returned agentId. Call `codex_task_status` with bounded waits to
   retrieve the result. Report the actual status; never equate submission with completion.
4. Use `codex_task_continue` with the same explicit approved model for follow-ups.
   For guarded tasks require matching executionEvidence, including runtimeModel,
   turnId and source, before accepting a completed result. Model prose is not evidence.
   Preserve requestKey
   and identical arguments on transport retries. Never automatically resubmit an
   uncertain delivery under a new key; inspect `codex_tasks` first.

If using the documented CLI route from an MCP workspace, pass `--model` explicitly
on both `devspace agents run` and `devspace agents continue`. The configured bridge
execution policy applies to that route too. Stop if the host rejects a tool; do not
rename, encode or switch channels to evade it. Do not use old unverified results
as evidence for a newly required model.

## Codex Desktop to ChatGPT

Read `~/.devspace/closed-loop-route.json` for the user-approved test chat. Verify
its ID, exact title, and ChatGPT kind with the native app's list/read task tools.
Use the native app's send-message tool to send only to that approved chat, then
read its result. If the route is missing or the user requests a different chat,
ask which chat to bind. Do not choose an arbitrary recent conversation.

Native desktop tools are not automatically available to standalone Codex CLI
workers. A returned provider thread ID is not proof of a visible desktop task.
Use only supported app tools or a user-selected logged-in browser surface;
never extract cookies or call private ChatGPT backend APIs.

## Stop Conditions

Stop on completion, an approval request, ambiguous delivery, an unavailable
connector, or the agreed wait limit. Do not bounce messages recursively, send
another prompt while a task is running, or create an indefinite polling loop.
This is an on-demand relay, not an always-on browser controller or permission
to send unrelated messages. Summarize the verified result back to the origin.
