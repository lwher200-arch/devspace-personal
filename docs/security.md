# Security Model

DevSpace exposes local coding capabilities over MCP. Treat it as remote access
to your development machine.

The security model has independent boundaries:

- you choose a narrow filesystem allowlist
- the MCP endpoint requires OAuth approval with your Owner password
- Host headers are allowlisted from the configured public URL
- every coding action happens through explicit MCP tool calls
- Owner-gated high-risk operations require a separate single-use decision
- provider sandbox/model evidence is distinct from local Shell authority

OAuth connection consent does not approve every operation. A read-only tool
annotation or natural-language task description is not an authorization token.

## Filesystem Allowlist

DevSpace only opens workspaces under configured roots.

Good examples:

```text
~/work
~/personal/open-source
```

Avoid broad roots:

```text
~
/
C:\
```

The narrower the root, the easier it is to reason about what the MCP client can
reach.

## Owner Password

`devspace init` generates an Owner password and stores it in:

```text
~/.devspace/auth.json
```

When an MCP client connects, DevSpace shows an approval page. Enter the Owner
password only when you intentionally want that client to access this server.

The optional fixed login lifetime may be set to 12 hours. It does not slide
with token refresh or grant operations automatically. Separately, approval
requests default to 30 minutes and permit configuration from 30 to 120 minutes.
The request, Owner form cookie and card share one deadline; repeated access
does not renew it. Existing approvals are lost on service restart, not restored
from SQLite. Submitted work is not cancelled by approval expiry.

Trusted Chat UI clients may present a decision card without passing the Owner
password to the model. This trusts the host to isolate private result metadata
and convey the user's click. The server still checks client, conversation,
capability, request, expiry and current context. Raw control of that trusted
client is inside the trust boundary; hiding a tool name alone is not security.

For env-driven deployments, set a long random value:

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)"
```

## Public URL And Host Allowlist

DevSpace needs `server.publicBaseUrl` in `config.jsonc` so MCP clients can
discover OAuth metadata and connect to the correct resource.

The value should be the origin only:

```text
https://your-tunnel-host.example.com
```

Do not include `/mcp` in `server.publicBaseUrl`.

By default, DevSpace derives allowed Host headers from the local host and public
URL. Put `"*"` in `server.allowedHosts` only for intentional local debugging.

## Tunnels

DevSpace does not manage tunnels. Your tunnel or reverse proxy should point to:

```text
http://127.0.0.1:7676
```

An additional identity layer may be useful, but verify that the MCP host can
complete it and reach OAuth discovery. Adding an incompatible login wall can
break a connector without strengthening DevSpace's own authorization. The
tunnel URL is not a secret and DevSpace does not configure that outer layer.

## Shell Access

The shell tool is powerful by design. It is meant for tests, builds, git, and
package scripts.

Filesystem path containment applies to DevSpace file tools. Shell commands run
as local commands and can do what your user account can do. This is why the MCP
client must be trusted and the Owner password must stay private.

Native `run_process` uses literal argv and avoids Shell expansion, but is not
a filesystem or network sandbox. Native execution/cancellation and unrestricted
Codex delegation remain gated. The optional `high_risk_only` profile permits
ordinary project edits while retaining sensitive/destructive operations; it
does not reliably classify every effect of arbitrary project code.

## Workspace restoration

Logical containment and physical root anchors are rechecked before returning
workspaces. The persistent-store LRU keeps at most 32 cached entries, each with
its own anchor. Eviction never deletes records, re-anchors a changed directory
or expands allowed roots. Restored skill activation is empty; reread an advertised
skill before accessing its supporting files. Stores without durable anchors
retain their previous instance-local behavior rather than silently losing IDs.

## Worktrees

Managed worktrees reduce accidental edits to your active checkout, but they are
not a security boundary. They are a workflow boundary for isolated coding
sessions.

## State and recovery

OAuth clients/hashed tokens, workspace identity and logical agent tasks are
persistent. Approval grants, transport sessions and native processes are not.
Startup rejects unknown migration versions or mismatched migration names before
pending writes. Do not delete migration records to bypass that check.

Back up active SQLite state using a consistent backup mechanism, not only its
main file while WAL writers remain active. Reverting source, dependencies,
configuration and database state are separate recovery decisions. See
[maintenance](maintenance.md) and [authorization](authorization.md).

## Native File Download

Native file download is an opt-in, one-shot transfer into an already-open
workspace. `download_artifact` accepts the MCP host's native file value, the
`workspaceId` returned by `open_workspace`, and an unused relative destination
path. It returns only the workspace-relative path and does not create a
persistent artifact service or reusable artifact ID.

DevSpace accepts only the documented native-file object and trusted OpenAI
download hosts and redirects. Arbitrary URL strings, local source paths,
credentials, malformed references, and unknown object fields are rejected.

Absolute paths, traversal, symlinked parents, and existing destinations also
fail closed. Downloads stream under the configured per-file limit and are
published without overwrite as owner-only files. DevSpace does not extract or
execute transferred content.

## Logs

By default, DevSpace logs requests and tool calls. Shell command previews are
disabled unless `logging.shellCommands` is `true`.

Do not enable shell command logging if commands may contain secrets.

Artifact tool logs contain bounded workspace ID, validated hostname,
workspace-relative output path, byte count, hash, duration, and status metadata.
`download_artifact` does not log the opaque file value. Raw content, connector
references, native file IDs, bearer credentials, presigned URLs, host paths,
temporary paths, and base64 chunks are never included in tool logs or tool
results.
