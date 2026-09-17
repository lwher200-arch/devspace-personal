# DevSpace Tunnel-First Remote Readiness Design

**Status:** Approved architecture direction; implementation not started.

**Date:** 2026-09-17

## 1. Problem

DevSpace already exposes a Streamable HTTP MCP server with OAuth, workspace scoping, Owner approval, guarded file operations, native process sessions, review checkpoints, and optional agent delegation. It can be placed behind a user-controlled HTTPS tunnel or reverse proxy, but remote readiness is currently distributed across setup documentation, configuration, server startup logs, and manual host testing.

For a user who wants to reach DevSpace from ChatGPT or another remote MCP host without depending on a paid remote-desktop relay, the missing Phase A capability is not another filesystem or terminal implementation. The missing capability is a deterministic, read-only way to answer:

> Is this DevSpace instance correctly configured and reachable through the user's HTTPS endpoint, with OAuth discovery and MCP protection wired to the same public origin?

The design must preserve the repository rule that tunnel ownership, credentials, DNS, certificates, and lifecycle stay outside DevSpace.

## 2. Goals

Phase A adds a **Remote Readiness** diagnostic contract around the existing tunnel-first deployment model.

The implementation must:

1. Keep `devspace doctor` backward-compatible for existing local diagnostics.
2. Add an explicit remote diagnostic mode: `devspace doctor --remote`.
3. Add machine-readable output: `devspace doctor --remote --json`.
4. Validate the effective public origin, local bind assumptions, effective Host allowlist, local service reachability, public HTTPS reachability, OAuth discovery, protected-resource metadata, and the MCP endpoint boundary.
5. Return stable check identifiers and a final readiness verdict without exposing secrets.
6. Distinguish configuration failure, local service failure, tunnel/public-origin failure, OAuth metadata failure, and MCP boundary failure.
7. Provide precise remediation text, but never create, configure, restart, or authenticate a tunnel provider.
8. Preserve existing Owner approval, workspace containment, and shell-risk boundaries unchanged.

## 3. Non-goals

Phase A does **not** implement:

- Cloudflare Tunnel, Tailscale, ngrok, SSH reverse-tunnel, DNS, certificate, firewall, or VPN management.
- A hosted DevSpace relay.
- A persistent outbound device agent.
- Device pairing, device identity, heartbeat, reconnect, multi-device routing, or remote wake-up.
- New filesystem, terminal, process, search, edit, or Codex capabilities.
- Automatic OAuth consent or Owner approval.
- Automatic changes to `publicBaseUrl`, `allowedHosts`, credentials, or project roots.
- A guarantee that an external MCP host UI has refreshed or accepted a connector; the diagnostic proves network/protocol conditions, not host-product state.

Those device/relay concerns belong to Phase B after Phase A is proven in a real remote host.

## 4. Existing Architecture Reused

Phase A reuses the current DevSpace architecture instead of introducing a second remote-control stack:

```text
Remote MCP Host
      |
      | HTTPS
      v
User-managed tunnel / reverse proxy
      |
      v
127.0.0.1:<port>
      |
      v
DevSpace HTTP + OAuth + MCP
      |
      +--> WorkspaceRegistry
      +--> Owner approval
      +--> project/file tools
      +--> native process sessions
      +--> optional agent bridge
```

The public HTTPS endpoint forwards the whole DevSpace service, not only `/mcp`, because OAuth discovery and approval routes must remain reachable under the same public origin.

## 5. Design Principles

### 5.1 Tunnel ownership remains external

DevSpace may diagnose a configured public endpoint. It must not start, stop, install, log in to, refresh, or persist credentials for a tunnel provider.

### 5.2 Diagnostics are observation, not repair

`doctor --remote` is read-only. It may issue HTTP(S) requests and inspect effective configuration, but it must not mutate config, OAuth state, workspaces, approvals, or files.

### 5.3 Public origin is one authority

The effective `publicBaseUrl` is the canonical externally visible origin for OAuth metadata, MCP resource identity, app assets, and remediation output. Remote diagnostics must detect inconsistent origins rather than silently normalizing them into success.

### 5.4 Security boundaries remain independent

Passing remote readiness means only that the transport/authentication surface is coherent. It does not mean:

- Shell commands are sandboxed.
- Owner approval is bypassed.
- A workspace may expand beyond allowed roots.
- Agent delegation becomes safe by implication.

### 5.5 Evidence is structured

A human-readable summary and the JSON form must be produced from the same typed report so the two modes cannot drift into different semantics.

## 6. CLI Contract

Existing behavior remains:

```text
devspace doctor
```

New behavior:

```text
devspace doctor --remote
devspace doctor --remote --json
```

Unknown doctor flags fail with a usage error. `--json` without `--remote` is out of scope for Phase A and must fail rather than silently changing the existing local doctor output.

The command exit status is:

- `0`: no required remote check is `fail` or `skipped`; warnings may exist.
- `1`: at least one required remote check is `fail` or `skipped`.
- `2`: diagnostic invocation/configuration cannot be evaluated safely, for example malformed arguments or an unexpected internal diagnostic error.

The command never writes configuration.

## 7. Report Model

Introduce one canonical report model:

```ts
export type RemoteCheckStatus = "pass" | "warn" | "fail" | "skipped";

export type RemoteReadinessCheckId =
  | "remote.public_origin"
  | "remote.local_bind"
  | "remote.host_allowlist"
  | "remote.local_service"
  | "remote.public_service"
  | "remote.oauth_discovery"
  | "remote.protected_resource"
  | "remote.mcp_boundary";

export interface RemoteReadinessCheck {
  id: RemoteReadinessCheckId;
  status: RemoteCheckStatus;
  summary: string;
  detail?: string;
  remediation?: string;
}

export interface RemoteReadinessReport {
  ready: boolean;
  publicBaseUrl: string;
  mcpUrl: string;
  checks: RemoteReadinessCheck[];
}
```

All eight Phase A checks are required. `ready` is `true` when none of them is `fail` or `skipped`. A `warn` status is compatible with `ready=true`, but must remain visible in both human and JSON output.

The report must never contain:

- Owner passwords/tokens.
- OAuth access or refresh tokens.
- approval-card private metadata.
- full local filesystem roots.
- cookies or Authorization headers.
- tunnel-provider credentials.

## 8. Stable Check Set

Phase A defines these check identifiers in this order:

1. `remote.public_origin`
2. `remote.local_bind`
3. `remote.host_allowlist`
4. `remote.local_service`
5. `remote.public_service`
6. `remote.oauth_discovery`
7. `remote.protected_resource`
8. `remote.mcp_boundary`

### 8.1 `remote.public_origin`

Required. The configured public origin must be an absolute HTTPS URL intended for remote access. Local fallback origins such as `http://127.0.0.1:<port>` are valid for ordinary DevSpace operation but fail this remote check.

The diagnostic reports only the normalized public origin.

### 8.2 `remote.local_bind`

Required. Tunnel-first deployment expects the DevSpace HTTP listener to remain local-only. `127.0.0.1`, `::1`, or equivalent loopback binding passes. A wildcard/public bind is a failure for this Phase A profile because the user-managed tunnel is the intended public boundary.

This check does not change the bind address.

### 8.3 `remote.host_allowlist`

Required. The effective Host allowlist must accept the configured public hostname. `*` is not a readiness failure because it is executable configuration, but it produces a `warn` result because the allowlist protection is disabled.

### 8.4 `remote.local_service`

Required. The configured local HTTP endpoint must answer using the currently running DevSpace instance. A closed port, timeout, connection reset, or incompatible response fails this check.

The check must use a short bounded timeout and must not start a server.

### 8.5 `remote.public_service`

Required. The configured HTTPS public origin must be reachable from the diagnostic machine and must resolve to a DevSpace service response rather than an unrelated web application or tunnel error page.

TLS verification remains enabled. Certificate failures are failures, not warnings. If the diagnostic machine itself is prevented from reaching the public origin by local egress policy or split-network behavior, this check is `skipped` with an explicit "could not verify from this machine" explanation; readiness remains false because the public path was not proven.

### 8.6 `remote.oauth_discovery`

Required. Query the OAuth discovery route(s) registered by the existing MCP SDK router and verify that the advertised issuer/authorization metadata points to the configured public origin where the current DevSpace OAuth contract requires it.

Do not reproduce OAuth route constants in multiple files. The diagnostic must use the same route construction/helper logic as the server or a shared extracted helper.

### 8.7 `remote.protected_resource`

Required. Query the MCP protected-resource metadata produced by the existing SDK route and verify that its resource identity corresponds to the public MCP URL.

A response that is syntactically valid but references a different origin fails.

### 8.8 `remote.mcp_boundary`

Required. Probe the public `/mcp` endpoint without credentials and verify that it behaves as a protected MCP resource rather than an open tool endpoint or generic HTML page. This is a boundary probe only; it must not fabricate an OAuth token, create an MCP session, or approve access.

A full authenticated initialize remains part of the later real-host acceptance test, not the CLI diagnostic.

## 9. Error and Remediation Semantics

Checks must preserve the failing layer. Examples:

```text
remote.public_origin: FAIL
Configured publicBaseUrl is not an HTTPS remote origin.
Remediation: set server.publicBaseUrl to the HTTPS origin owned by your tunnel/reverse proxy.

remote.local_service: FAIL
No DevSpace service answered at 127.0.0.1:7676.
Remediation: start the configured DevSpace service and rerun the diagnostic.

remote.public_service: FAIL
The HTTPS endpoint returned a tunnel/provider error page.
Remediation: inspect the user-managed tunnel or reverse proxy; DevSpace will not reconfigure it.
```

Do not collapse these into a generic `remote unavailable` message.

## 10. Internal Component Boundary

Remote diagnostics should live outside `src/server.ts` so server composition does not absorb deployment probing.

Proposed files:

```text
src/remote-readiness.ts       typed checks + orchestration
src/remote-readiness.test.ts  behavior tests
src/cli.ts                    argument routing + presentation only
```

If OAuth URL construction currently exists only inside server composition, extract the smallest shared pure helper into an existing appropriate auth module or a focused helper module. Do not duplicate SDK path knowledge inside `remote-readiness.ts`.

No database migration is required.

## 11. Testing Strategy

Tests are TDD-first and must not depend on a real Cloudflare/Tailscale/ngrok account.

### Unit tests

Cover:

- HTTPS public origin passes; local HTTP fallback fails remote mode.
- loopback bind passes; wildcard/public bind fails the tunnel-first profile.
- effective public hostname is accepted by the Host allowlist.
- `*` produces a warning while still allowing `ready=true` when every other check passes.
- secret-bearing configuration values never appear in report serialization.
- `ready` calculation is deterministic.
- check ordering is stable.

### HTTP contract tests

Use ephemeral local HTTP(S)-test doubles or the existing server test harness to cover:

- local service reachable/unreachable.
- public endpoint returning expected DevSpace metadata.
- unrelated HTML response.
- TLS/network failure surfaced at the correct check.
- OAuth metadata origin mismatch.
- protected-resource identity mismatch.
- unauthenticated `/mcp` boundary behaves as protected.

### CLI tests

Cover:

- existing `devspace doctor` output remains supported.
- `doctor --remote` human output.
- `doctor --remote --json` schema and exit codes.
- unknown flags fail closed.
- `--json` without `--remote` fails with usage guidance.

### Regression gates

Run:

```text
npm run typecheck
npm run test:docs
npm test
npm run test:deploy
```

A real remote host acceptance test remains separate because repository tests cannot prove ChatGPT/Claude connector UI behavior.

## 12. Real-Host Acceptance

After repository tests pass, Phase A is accepted only when a real remote MCP host completes this sequence against a user-managed HTTPS endpoint:

1. `devspace doctor --remote` reports ready.
2. The remote host discovers OAuth metadata from the same public origin.
3. The user completes the normal OAuth/Owner consent flow.
4. The host performs MCP initialize successfully.
5. The host opens one allowed workspace.
6. A known instruction file is read and matches the real workspace.
7. A disposable test file is modified using the existing guarded edit/patch contract and read back with hash evidence.
8. A harmless project validation command runs through the existing process tooling.
9. The user reviews the resulting change through the existing review surface.

Failure at the host/UI layer must be reported as such; a green CLI diagnostic is not permission to claim the host workflow passed.

## 13. Compatibility and Rollback

- Existing config files remain valid.
- Existing `devspace doctor` behavior remains available.
- No migration or schema version bump is needed for Phase A.
- No new runtime dependency is required unless the current HTTP test infrastructure cannot perform the checks with Node built-ins; adding a dependency requires separate justification.
- Rollback consists of reverting the diagnostic code/docs. It does not require deleting OAuth or workspace state.

## 14. Phase B Handoff

Phase A deliberately leaves one clean boundary for a future self-hosted Remote Fabric:

```text
Remote Host
    |
Gateway / Relay          # Phase B
    |
Outbound Device Agent    # Phase B
    |
DevSpace local MCP       # existing core
```

Phase B may add `DeviceIdentity`, pairing, heartbeat, reconnect, revocation, and multi-device routing. It must route into the existing DevSpace MCP/tool contracts rather than reimplement filesystem/process/Codex behavior.

No Phase B type or database table is added during Phase A merely to reserve future space.

## 15. Prior Art and Reuse

Desktop Commander demonstrates a useful remote-device pattern: OAuth Device Authorization + PKCE, persistent device identity, secure outbound channel, heartbeat/reconnect, and forwarding remote tool calls into a local MCP server. Its MIT-licensed client-side implementation is valid prior art for Phase B.

Phase A does not copy that remote-device implementation because a user-managed HTTPS tunnel already reaches DevSpace directly. The first engineering question is therefore whether the simpler existing DevSpace transport can be made observable and reliably accepted by a real remote host.

## 16. Acceptance Criteria

Phase A is complete only when all of the following are verified:

- The new remote diagnostic is read-only.
- It does not install or manage a tunnel.
- It returns the eight stable checks above.
- It redacts secrets by construction.
- It distinguishes local, public/tunnel, OAuth, protected-resource, and MCP-boundary failures.
- Existing local doctor behavior remains compatible.
- Typecheck, docs tests, unit/behavior tests, and deploy tests pass.
- A real remote MCP host completes the nine-step acceptance flow.

Until the real-host acceptance succeeds, the result must be described as repository-level remote-readiness support, not a proven replacement for a hosted Remote Desktop Commander service.
