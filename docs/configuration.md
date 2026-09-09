# Configuration Reference

DevSpace stores durable settings in `~/.devspace/config.jsonc`. The file accepts
comments and trailing commas and is validated before the server starts. Editor
completion is provided by the versioned [JSON Schema](../schema/v1/devspace.schema.json),
also hosted at the URL in the file's `$schema` property.

Authentication stays separate because it contains a secret:

```text
~/.devspace/config.jsonc
~/.devspace/auth.json
```

Run `devspace init` to create both files. `devspace config set publicBaseUrl
<url|null>` updates the JSONC document without discarding its comments.

## Legacy configuration migration

The legacy `config.json` field `tool_mode` accepts `claude` or `codex` and
migrates to `tools.mode`. If both forms are present, explicit `tools.mode`
wins. Invalid values and unrelated unknown keys are still rejected.

Successful migration preserves the original bytes in `config.json.v1.0.bak`
and leaves `auth.json` unchanged. A failed validation leaves the legacy file
in place without publishing a partial JSONC file. Existing `config.jsonc`
continues to take precedence; `tool_mode` is not a new JSONC field.

## Complete example

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/lwher200-arch/devspace-personal/refs/heads/codex/personal/schema/v1/devspace.schema.json",
  "configVersion": 1,

  "server": {
    "host": "127.0.0.1",
    "port": 7676,
    // Use the public origin only; do not append /mcp.
    "publicBaseUrl": "https://devspace.example.com",
    "allowedHosts": [],
    "trustProxy": false,
  },
  "workspaces": {
    "allowedRoots": ["~/personal", "~/work"],
    "worktreeRoot": "~/.devspace/worktrees",
  },
  "storage": {
    "stateDir": "~/.local/share/devspace",
  },
  "tools": {
    "mode": "codex",
    "authorization": "owner_approval",
    "approvalProfile": "conservative",
    "approvalTtlSeconds": 1800,
    "chatApprovalClientIds": [],
  },
  "ui": {
    "enabled": true,
  },
  "artifacts": {
    "enabled": false,
    "maxFileBytes": 104857600,
  },
  "skills": {
    "enabled": true,
    "paths": [],
    "agentDir": "~/.codex",
  },
  "subagents": {
    "enabled": false,
    "providers": [],
  },
  "logging": {
    "level": "info",
    "format": "json",
    "requests": true,
    "assets": false,
    "toolCalls": true,
    "shellCommands": false,
  },
  "oauth": {
    "ownerSessionTtlSeconds": 43200,
    "accessTokenTtlSeconds": 3600,
    "refreshTokenTtlSeconds": 2592000,
    "scopes": ["devspace"],
    "allowedRedirectHosts": ["chatgpt.com", "localhost", "127.0.0.1"],
  },
  "bridge": {
    "enabled": false,
    "allowWorkspaceWrite": false,
  },
}
```

This example explicitly selects Owner approval and a 12-hour login policy;
it is not a dump of every default. Omitted keys use the JSON Schema defaults:
authorization defaults to `legacy`, the approval profile to `conservative`,
and a fixed Owner login lifetime is opt-in. An empty
`workspaces.allowedRoots` uses the current working directory. Unknown keys are
rejected so spelling mistakes cannot silently alter behavior.

## Tool modes and UI

`tools.approvalTtlSeconds` is the single-use approval window: an integer from
1800 to 7200 seconds (30 minutes to 2 hours), defaulting to 1800. Existing
Owner-gated configurations that omit it use the new 30-minute default instead
of the previous five minutes. Reopening a page or retrying the same pending
operation does not extend its original deadline. The Owner form cookie and
visible expiry share that deadline. This setting does not change the separate
12-hour Owner login policy or the runtime limit of an already submitted task.

`tools.mode` accepts two values:

| Value | Tool surface |
| --- | --- |
| `codex` | Default. `open_workspace`, `read`, `apply_patch`, `exec_command`, `write_stdin`, and `show_changes`. |
| `claude` | `open_workspace`, `read`, `write`, `edit`, `bash`, and `show_changes`. |

Both modes also expose `project_files`, `project_search`, `project_read`,
`project_read_batch`, `run_process`, `process_status` and `process_cancel`.
Bridge tools require `bridge.enabled`; approval tools require Owner approval
and UI. Native download is optional and platform-dependent. See the complete
[tool directory](tool-reference.md) for registration conditions and budgets.

Basic Apps UI metadata accompanies `open_workspace` and `show_changes`; when
approval UI is enabled, `review_approval` also presents its dedicated card.
`decide_approval` is app-only and still verifies its private capability.
Disabling UI does not remove ordinary tools or bypass the Owner-page fallback.

## Skills and subagents

DevSpace discovers standard Agent Skills from `~/.agents/skills`, project
`.agents/skills`, and `~/.devspace/skills`. It also checks
`skills.agentDir/skills` and each path in `skills.paths`. Relative custom paths
are resolved from the active workspace.

Subagent providers are explicit. Omitted providers are disabled:

```jsonc
{
  "configVersion": 1,
  "subagents": {
    "enabled": true,
    "providers": [
      {
        "id": "codex",
        "enabled": true,
        "model": "gpt-5.6-sol",
        "effort": "high",
      },
      {
        "id": "claude",
        "enabled": true,
        "model": "sonnet",
      },
    ],
  },
}
```

Profiles are loaded from `~/.devspace/agents/*.md` and project
`.devspace/agents/*.md`. `devspace agents targets` prints the configured targets
available in the current workspace.

Provider executable discovery remains process-scoped. The supported overrides
are `CODEX_COMMAND`, `CODEX_HOME`, `CLAUDE_COMMAND`, `CURSOR_COMMAND`,
`COPILOT_COMMAND`, `GROK_COMMAND`, and `GROK_AGENT_PROFILE`. DevSpace does not
persist provider credentials.

## Native artifact download

Set `artifacts.enabled` to `true` when a host needs to save a native attached or
generated file into an open workspace. `artifacts.maxFileBytes` limits one
streamed file. The secure publication path is currently available only on
Linux; the tool is not registered on macOS, Windows, or BSD.

## Environment boundary

Only two user-facing DevSpace environment variables remain:

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_CONFIG_DIR` | Bootstrap location for `config.jsonc`, `auth.json`, skills, and profiles. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Optional secret override for the owner token stored in `auth.json`. |

The current configuration loader does not import durable environment settings.
Move old deployment
values to these JSONC keys:

| Removed setting | JSONC key |
| --- | --- |
| `HOST`, `PORT` | `server.host`, `server.port` |
| `DEVSPACE_PUBLIC_BASE_URL` | `server.publicBaseUrl` |
| `DEVSPACE_ALLOWED_HOSTS` | `server.allowedHosts` |
| `DEVSPACE_TRUST_PROXY` | `server.trustProxy` |
| `DEVSPACE_ALLOWED_ROOTS` | `workspaces.allowedRoots` |
| `DEVSPACE_WORKTREE_ROOT` | `workspaces.worktreeRoot` |
| `DEVSPACE_STATE_DIR` | `storage.stateDir` |
| `DEVSPACE_TOOL_MODE`, `DEVSPACE_MINIMAL_TOOLS` | `tools.mode` |
| `DEVSPACE_WIDGETS` | `ui.enabled` |
| `DEVSPACE_ARTIFACTS` | `artifacts.enabled` |
| `DEVSPACE_ARTIFACT_MAX_FILE_BYTES` | `artifacts.maxFileBytes` |
| `DEVSPACE_SKILLS` | `skills.enabled` |
| `DEVSPACE_SKILL_PATHS` | `skills.paths` |
| `DEVSPACE_AGENT_DIR` | `skills.agentDir` |
| `DEVSPACE_SUBAGENTS` | `subagents.enabled` |
| `DEVSPACE_LOG_LEVEL` | `logging.level` |
| `DEVSPACE_LOG_FORMAT` | `logging.format` |
| `DEVSPACE_LOG_REQUESTS` | `logging.requests` |
| `DEVSPACE_LOG_ASSETS` | `logging.assets` |
| `DEVSPACE_LOG_TOOL_CALLS` | `logging.toolCalls` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `logging.shellCommands` |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `oauth.accessTokenTtlSeconds` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `oauth.refreshTokenTtlSeconds` |
| `DEVSPACE_OAUTH_SCOPES` | `oauth.scopes` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `oauth.allowedRedirectHosts` |

These environment values are not read or auto-imported. Environment is
process state, so there is no reliable file DevSpace can migrate on the user's
behalf.

## Legacy JSON file migration

The loader performs one migration when `config.jsonc` is missing and
`config.json` exists:

1. Validate the old JSON document.
2. Translate its known fields into the versioned JSONC structure.
3. Write and validate a temporary `config.jsonc`.
4. Atomically publish it.
5. Rename the old file to `config.json.v1.0.bak`.

If `config.jsonc` exists, DevSpace never reads `config.json`. Invalid JSONC also
never falls back to the old file. Unsupported legacy keys stop migration with an
actionable error instead of being silently discarded.

The persisted fields map as follows:

| Legacy JSON field | Versioned JSONC key |
| --- | --- |
| `host`, `port` | `server.host`, `server.port` |
| `publicBaseUrl`, `allowedHosts` | `server.publicBaseUrl`, `server.allowedHosts` |
| `allowedRoots`, `worktreeRoot` | `workspaces.allowedRoots`, `workspaces.worktreeRoot` |
| `stateDir` | `storage.stateDir` |
| `artifactsEnabled`, `artifactMaxFileBytes` | `artifacts.enabled`, `artifacts.maxFileBytes` |
| `agentDir` | `skills.agentDir` |
| `subagents` | `subagents` |
| `tools.mode`, `ui.enabled` | unchanged nested keys |

`auth.json` is unchanged.
