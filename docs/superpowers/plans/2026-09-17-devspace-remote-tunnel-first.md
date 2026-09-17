# DevSpace Tunnel-First Remote Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `devspace doctor --remote [--json]` flow that deterministically validates DevSpace's tunnel-first remote MCP readiness without managing tunnels, changing configuration, or weakening existing security boundaries.

**Architecture:** Extract one shared public-endpoint contract used by both the HTTP server and diagnostics. Implement remote readiness as a typed module with three static configuration checks and five bounded network/protocol probes, all assembled into one stable eight-check report. Keep `src/cli.ts` limited to argument parsing, existing local-doctor compatibility, presentation, and exit codes.

**Tech Stack:** TypeScript 6, Node.js `>=22.19 <27`, built-in `fetch`/`AbortController`, `@modelcontextprotocol/sdk`, Node `node:test`, existing DevSpace config/test helpers.

**Spec:** `docs/superpowers/specs/2026-09-17-devspace-remote-tunnel-first-design.md`

## Global Constraints

- Tunnel lifecycle, credentials, DNS, certificates, VPN/firewall state, and provider authentication remain user-managed and outside DevSpace.
- `devspace doctor --remote` is observation-only: no config writes, OAuth-state writes, workspace creation, approval creation, process launch, or tunnel management.
- Preserve existing `devspace doctor` output/behavior when no new flags are supplied.
- `devspace doctor --remote` and `devspace doctor --remote --json` are the only new Phase A CLI forms; `doctor --json` without `--remote` and unknown doctor flags exit `2` with usage guidance.
- Stable check order is exactly: `remote.public_origin`, `remote.local_bind`, `remote.host_allowlist`, `remote.local_service`, `remote.public_service`, `remote.oauth_discovery`, `remote.protected_resource`, `remote.mcp_boundary`.
- `warn` is compatible with `ready=true`; any `fail` or `skipped` forces `ready=false`.
- Reports must not contain Owner credentials, OAuth tokens, cookies, Authorization headers, approval private metadata, tunnel credentials, or full local filesystem roots.
- TLS verification stays enabled in production diagnostics; do not add an insecure production switch.
- Reuse/extract the same MCP/OAuth endpoint construction used by `src/server.ts`; do not duplicate route constants in multiple production files.
- No database migration, schema-version change, new runtime dependency, DeviceIdentity, relay, pairing, heartbeat, or multi-device type is introduced in Phase A.
- Implement every production behavior with TDD: failing test first, verify the intended failure, minimal implementation, then regression.
- Final repository gates are `npm run typecheck`, `npm run test:docs`, `npm test`, and `npm run test:deploy`.
- Repository-level success is not sufficient to claim hosted Remote Desktop Commander replacement; a real remote MCP host must complete the spec's nine-step acceptance flow.

---

## File Structure

- Create `src/oauth-endpoints.ts` — canonical public MCP/OAuth URL derivation shared by server and diagnostics.
- Create `src/oauth-endpoints.test.ts` — pure URL-contract tests.
- Create `src/remote-readiness.ts` — report types, static checks, bounded HTTP probes, formatting, and exit-code helper.
- Create `src/remote-readiness.test.ts` — static-policy and protocol-probe tests using injected fetch responses; no real tunnel account.
- Modify `src/server.ts` — consume shared endpoint derivation only; no behavioral expansion.
- Modify `src/cli.ts` — route doctor flags and render report without owning diagnostic logic.
- Modify `src/cli.test.ts` — child-process regression tests for compatibility, output shape, and exit codes.
- Modify `docs/setup.md` — document remote doctor workflow and real-host acceptance boundary.
- Modify `docs/security.md` — document what remote readiness proves and does not prove.
- Modify `CHANGELOG.md` — add one dated engineering entry with verified tests/limits after implementation.

---

### Task 1: Centralize Public MCP/OAuth Endpoint Construction

**Files:**
- Create: `src/oauth-endpoints.ts`
- Create: `src/oauth-endpoints.test.ts`
- Modify: `src/server.ts`
- Test: `src/oauth-endpoints.test.ts`, `src/server.test.ts`

**Interfaces:**
- Consumes: `@modelcontextprotocol/sdk/server/auth/router.js#getOAuthProtectedResourceMetadataUrl`, `@modelcontextprotocol/sdk/shared/auth-utils.js#resourceUrlFromServerUrl`.
- Produces:
  - `PublicMcpEndpoints`
  - `publicMcpEndpoints(publicBaseUrl: string): PublicMcpEndpoints`
- `src/server.ts` must use this helper for `mcpUrl`, `resourceServerUrl`, and `protectedResourceMetadataUrl`.

- [ ] **Step 1: Write the failing endpoint-contract test**

Create `src/oauth-endpoints.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { publicMcpEndpoints } from "./oauth-endpoints.js";

test("publicMcpEndpoints derives one canonical remote origin contract", () => {
  const endpoints = publicMcpEndpoints("https://devspace.example.com");
  assert.equal(endpoints.publicOrigin.toString(), "https://devspace.example.com/");
  assert.equal(endpoints.mcpUrl.toString(), "https://devspace.example.com/mcp");
  assert.equal(
    endpoints.resourceServerUrl.toString(),
    resourceUrlFromServerUrl(endpoints.mcpUrl).toString(),
  );
  assert.equal(
    endpoints.protectedResourceMetadataUrl.toString(),
    getOAuthProtectedResourceMetadataUrl(endpoints.resourceServerUrl).toString(),
  );
  assert.equal(
    endpoints.authorizationServerMetadataUrl.toString(),
    "https://devspace.example.com/.well-known/oauth-authorization-server",
  );
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```sh
pnpm exec tsx --test src/oauth-endpoints.test.ts
```

Expected: FAIL because `./oauth-endpoints.js` does not exist.

- [ ] **Step 3: Implement the minimal shared endpoint helper**

Create `src/oauth-endpoints.ts`:

```ts
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";

export interface PublicMcpEndpoints {
  publicOrigin: URL;
  mcpUrl: URL;
  resourceServerUrl: URL;
  protectedResourceMetadataUrl: URL;
  authorizationServerMetadataUrl: URL;
}

export function publicMcpEndpoints(publicBaseUrl: string): PublicMcpEndpoints {
  const publicOrigin = new URL(publicBaseUrl);
  publicOrigin.pathname = "/";
  publicOrigin.search = "";
  publicOrigin.hash = "";
  const mcpUrl = new URL("/mcp", publicOrigin);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  return {
    publicOrigin,
    mcpUrl,
    resourceServerUrl,
    protectedResourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
    authorizationServerMetadataUrl: new URL("/.well-known/oauth-authorization-server", publicOrigin),
  };
}
```

Modify `src/server.ts` to replace the local construction:

```ts
import { publicMcpEndpoints } from "./oauth-endpoints.js";

const endpoints = publicMcpEndpoints(config.publicBaseUrl);
const { mcpUrl, resourceServerUrl } = endpoints;
```

and use:

```ts
resourceMetadataUrl: endpoints.protectedResourceMetadataUrl,
```

Do not change route behavior, scopes, rate limits, or OAuth provider construction.

- [ ] **Step 4: Verify GREEN and server compatibility**

Run:

```sh
pnpm exec tsx --test src/oauth-endpoints.test.ts src/server.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 5: Commit Task 1**

```sh
git add src/oauth-endpoints.ts src/oauth-endpoints.test.ts src/server.ts
git commit -m "refactor: centralize public MCP endpoints"
```

---

### Task 2: Define the Typed Readiness Report and Static Policy Checks

**Files:**
- Create: `src/remote-readiness.ts`
- Create: `src/remote-readiness.test.ts`

**Interfaces:**
- Consumes: `ServerConfig` fields `host`, `port`, `publicBaseUrl`, `allowedHosts`; `publicMcpEndpoints()` from Task 1.
- Produces:
  - `REMOTE_READINESS_CHECK_IDS`
  - `RemoteReadinessCheckId`
  - `RemoteCheckStatus`
  - `RemoteReadinessCheck`
  - `RemoteReadinessReport`
  - `RemoteReadinessConfig`
  - `evaluateRemoteConfiguration(config)`
  - `finalizeRemoteReadinessReport(config, checks)`
  - `formatRemoteReadinessReport(report)`
  - `remoteReadinessExitCode(report)`

- [ ] **Step 1: Write failing static-policy tests**

Start `src/remote-readiness.test.ts` with:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  REMOTE_READINESS_CHECK_IDS,
  evaluateRemoteConfiguration,
  finalizeRemoteReadinessReport,
  remoteReadinessExitCode,
  type RemoteReadinessCheck,
  type RemoteReadinessConfig,
} from "./remote-readiness.js";

const baseConfig: RemoteReadinessConfig = {
  host: "127.0.0.1",
  port: 7676,
  publicBaseUrl: "https://devspace.example.com",
  allowedHosts: ["localhost", "127.0.0.1", "devspace.example.com"],
};

const networkPasses: RemoteReadinessCheck[] = [
  { id: "remote.local_service", status: "pass", summary: "local service reachable" },
  { id: "remote.public_service", status: "pass", summary: "public service reachable" },
  { id: "remote.oauth_discovery", status: "pass", summary: "oauth metadata coherent" },
  { id: "remote.protected_resource", status: "pass", summary: "resource metadata coherent" },
  { id: "remote.mcp_boundary", status: "pass", summary: "mcp is protected" },
];

test("remote readiness keeps the stable check order and warnings do not fail readiness", () => {
  const staticChecks = evaluateRemoteConfiguration({ ...baseConfig, allowedHosts: ["*"] });
  assert.deepEqual(staticChecks.map(check => check.id), REMOTE_READINESS_CHECK_IDS.slice(0, 3));
  assert.equal(staticChecks[2].status, "warn");
  const report = finalizeRemoteReadinessReport(baseConfig, [...staticChecks, ...networkPasses]);
  assert.deepEqual(report.checks.map(check => check.id), REMOTE_READINESS_CHECK_IDS);
  assert.equal(report.ready, true);
  assert.equal(remoteReadinessExitCode(report), 0);
});

test("invalid tunnel-first configuration fails the correct static checks", () => {
  const checks = evaluateRemoteConfiguration({
    ...baseConfig,
    host: "0.0.0.0",
    publicBaseUrl: "http://127.0.0.1:7676",
    allowedHosts: ["localhost"],
  });
  assert.equal(checks.find(check => check.id === "remote.public_origin")?.status, "fail");
  assert.equal(checks.find(check => check.id === "remote.local_bind")?.status, "fail");
  assert.equal(checks.find(check => check.id === "remote.host_allowlist")?.status, "fail");
});

test("missing or skipped required checks force ready=false", () => {
  const report = finalizeRemoteReadinessReport(baseConfig, evaluateRemoteConfiguration(baseConfig));
  assert.equal(report.ready, false);
  assert.ok(report.checks.slice(3).every(check => check.status === "skipped"));
  assert.equal(remoteReadinessExitCode(report), 1);
});
```

- [ ] **Step 2: Run and verify RED**

```sh
pnpm exec tsx --test src/remote-readiness.test.ts
```

Expected: FAIL because `remote-readiness.ts` does not exist.

- [ ] **Step 3: Implement the report model and static checks**

Create `src/remote-readiness.ts` with these exact exported contracts:

```ts
import type { ServerConfig } from "./config.js";
import { publicMcpEndpoints } from "./oauth-endpoints.js";

export const REMOTE_READINESS_CHECK_IDS = [
  "remote.public_origin",
  "remote.local_bind",
  "remote.host_allowlist",
  "remote.local_service",
  "remote.public_service",
  "remote.oauth_discovery",
  "remote.protected_resource",
  "remote.mcp_boundary",
] as const;

export type RemoteReadinessCheckId = typeof REMOTE_READINESS_CHECK_IDS[number];
export type RemoteCheckStatus = "pass" | "warn" | "fail" | "skipped";
export type RemoteReadinessConfig = Pick<ServerConfig, "host" | "port" | "publicBaseUrl" | "allowedHosts">;

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

Static rules:

```ts
export function evaluateRemoteConfiguration(config: RemoteReadinessConfig): RemoteReadinessCheck[] {
  const publicUrl = new URL(config.publicBaseUrl);
  const publicHost = publicUrl.hostname.toLowerCase();
  const loopbackPublic = publicHost === "localhost" || publicHost === "127.0.0.1" || publicHost === "::1";
  const publicOrigin = publicUrl.protocol === "https:" && !loopbackPublic
    ? pass("remote.public_origin", "public HTTPS origin is configured")
    : fail("remote.public_origin", "configured publicBaseUrl is not a remote HTTPS origin",
        "Set server.publicBaseUrl to the HTTPS origin owned by your tunnel or reverse proxy.");

  const localBind = ["127.0.0.1", "::1", "localhost"].includes(config.host.toLowerCase())
    ? pass("remote.local_bind", "DevSpace is bound to loopback")
    : fail("remote.local_bind", "DevSpace is not bound to loopback",
        "Bind DevSpace to loopback and let the user-managed tunnel provide the public boundary.");

  const hostAllowlist = config.allowedHosts.includes("*")
    ? warn("remote.host_allowlist", "Host allowlist is disabled with '*'",
        "Replace '*' with the public hostname after verifying the tunnel route.")
    : config.allowedHosts.map(value => value.toLowerCase()).includes(publicHost)
      ? pass("remote.host_allowlist", "public hostname is accepted by the Host allowlist")
      : fail("remote.host_allowlist", "public hostname is not accepted by the Host allowlist",
          "Add the configured public hostname to server.allowedHosts or reload effective configuration.");

  return [publicOrigin, localBind, hostAllowlist];
}
```

Implement `finalizeRemoteReadinessReport()` so it creates a map by ID, inserts a `skipped` check for any missing required ID, then emits the eight checks in `REMOTE_READINESS_CHECK_IDS` order. `ready` is `true` only when every status is `pass` or `warn`. Derive `publicBaseUrl`/`mcpUrl` only through `publicMcpEndpoints()`.

Implement presentation from the same report object:

```ts
export function remoteReadinessExitCode(report: RemoteReadinessReport): 0 | 1 {
  return report.ready ? 0 : 1;
}

export function formatRemoteReadinessReport(report: RemoteReadinessReport): string {
  const lines = [
    `Remote readiness: ${report.ready ? "READY" : "NOT READY"}`,
    `Public origin: ${report.publicBaseUrl}`,
    `MCP URL: ${report.mcpUrl}`,
  ];
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.id}: ${check.summary}`);
    if (check.detail) lines.push(`  ${check.detail}`);
    if (check.remediation) lines.push(`  Remediation: ${check.remediation}`);
  }
  return lines.join("\n");
}
```

Private `pass/warn/fail/skipped` helpers must accept only the fields above; do not accept or retain the full config object.

- [ ] **Step 4: Add secret-redaction-by-construction assertion and verify GREEN**

Append:

```ts
test("report serialization contains no unrelated secret-bearing config fields", () => {
  const report = finalizeRemoteReadinessReport(baseConfig, [
    ...evaluateRemoteConfiguration(baseConfig),
    ...networkPasses,
  ]);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("test-owner-token-that-is-long-enough"), false);
  assert.equal(serialized.includes("allowedRoots"), false);
  assert.equal(serialized.includes("Authorization"), false);
});
```

Run:

```sh
pnpm exec tsx --test src/remote-readiness.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```sh
git add src/remote-readiness.ts src/remote-readiness.test.ts
git commit -m "feat: define remote readiness contract"
```

---

### Task 3: Implement Bounded Local/Public/OAuth/MCP Probes

**Files:**
- Modify: `src/remote-readiness.ts`
- Modify: `src/remote-readiness.test.ts`

**Interfaces:**
- Consumes: Task 1 endpoint helper and Task 2 report/static-check contracts.
- Produces:
  - `RemoteReadinessOptions`
  - `runRemoteReadiness(config, options?): Promise<RemoteReadinessReport>`
- Production default uses global `fetch`; tests may inject `fetchImpl`.

- [ ] **Step 1: Write failing success-path and layer-specific probe tests**

Add to `src/remote-readiness.test.ts`:

```ts
import { publicMcpEndpoints } from "./oauth-endpoints.js";
import { runRemoteReadiness } from "./remote-readiness.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function routeFetch(routes: Map<string, Response | Error>): typeof fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const value = routes.get(url);
    if (!value) throw new Error(`unexpected URL ${url}`);
    if (value instanceof Error) throw value;
    return value.clone();
  };
}

test("runRemoteReadiness passes all eight checks for coherent DevSpace endpoints", async () => {
  const endpoints = publicMcpEndpoints(baseConfig.publicBaseUrl);
  const routes = new Map<string, Response | Error>([
    ["http://127.0.0.1:7676/healthz", jsonResponse(200, { ok: true, name: "devspace" })],
    ["https://devspace.example.com/healthz", jsonResponse(200, { ok: true, name: "devspace" })],
    [endpoints.authorizationServerMetadataUrl.toString(), jsonResponse(200, {
      issuer: endpoints.publicOrigin.toString(),
      authorization_endpoint: new URL("/authorize", endpoints.publicOrigin).toString(),
      token_endpoint: new URL("/token", endpoints.publicOrigin).toString(),
    })],
    [endpoints.protectedResourceMetadataUrl.toString(), jsonResponse(200, {
      resource: endpoints.resourceServerUrl.toString(),
      authorization_servers: [endpoints.publicOrigin.toString()],
    })],
    [endpoints.mcpUrl.toString(), new Response("Unauthorized", {
      status: 401,
      headers: { "www-authenticate": "Bearer" },
    })],
  ]);

  const report = await runRemoteReadiness(baseConfig, { fetchImpl: routeFetch(routes), timeoutMs: 50 });
  assert.equal(report.ready, true);
  assert.deepEqual(report.checks.map(check => check.status), Array(8).fill("pass"));
});

test("origin mismatches and an open MCP endpoint fail their own checks", async () => {
  const endpoints = publicMcpEndpoints(baseConfig.publicBaseUrl);
  const routes = new Map<string, Response | Error>([
    ["http://127.0.0.1:7676/healthz", jsonResponse(200, { ok: true, name: "devspace" })],
    ["https://devspace.example.com/healthz", jsonResponse(200, { ok: true, name: "devspace" })],
    [endpoints.authorizationServerMetadataUrl.toString(), jsonResponse(200, {
      issuer: "https://wrong.example/",
      authorization_endpoint: "https://wrong.example/authorize",
      token_endpoint: "https://wrong.example/token",
    })],
    [endpoints.protectedResourceMetadataUrl.toString(), jsonResponse(200, {
      resource: "https://wrong.example/mcp",
    })],
    [endpoints.mcpUrl.toString(), new Response("<html>open</html>", { status: 200 })],
  ]);
  const report = await runRemoteReadiness(baseConfig, { fetchImpl: routeFetch(routes), timeoutMs: 50 });
  assert.equal(report.ready, false);
  assert.equal(report.checks[5].status, "fail");
  assert.equal(report.checks[6].status, "fail");
  assert.equal(report.checks[7].status, "fail");
});
```

Also add one failure-layer test where local health throws, public health returns HTML, and assertions verify `remote.local_service` and `remote.public_service` fail independently instead of collapsing into one generic error.

- [ ] **Step 2: Run and verify RED**

```sh
pnpm exec tsx --test src/remote-readiness.test.ts
```

Expected: FAIL because `runRemoteReadiness` is not exported/implemented.

- [ ] **Step 3: Implement bounded probe orchestration**

Add:

```ts
export interface RemoteReadinessOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_REMOTE_PROBE_TIMEOUT_MS = 2_000;
```

Implement a private timeout wrapper using `AbortController`:

```ts
async function fetchBounded(
  fetchImpl: typeof fetch,
  input: string | URL,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}
```

`runRemoteReadiness()` must:

1. Start with `evaluateRemoteConfiguration(config)`.
2. Probe local `http://<loopback-host>:<port>/healthz`; pass only on `200` JSON `{ ok: true, name: "devspace" }`.
3. Probe public `<public-origin>/healthz` with TLS verification left to native fetch; pass only on the same DevSpace JSON identity.
4. Probe `authorizationServerMetadataUrl`; require `issuer`, `authorization_endpoint`, and `token_endpoint` to resolve to the configured public origin.
5. Probe `protectedResourceMetadataUrl`; require `resource === resourceServerUrl.toString()` and, when `authorization_servers` exists, require it to include the configured public origin.
6. Probe public `/mcp` without Authorization; pass only when status is `401` and the response is not a generic successful HTML/tool response.
7. Preserve each failure at its own check ID with bounded detail and remediation; never include response bodies wholesale.
8. Call `finalizeRemoteReadinessReport(config, checks)` exactly once at the end.

For IPv6 loopback, format the local host as `[::1]`; do not special-case a public wildcard bind into a local probe target.

If `remote.public_origin` fails, still run `remote.local_service`, but mark the four public-dependent checks (`remote.public_service`, `remote.oauth_discovery`, `remote.protected_resource`, `remote.mcp_boundary`) as `skipped` with an explicit invalid-public-origin reason rather than probing a known-invalid remote target.

- [ ] **Step 4: Add timeout/abort regression**

Add a fetch implementation that waits for `signal.abort` and rejects with an `AbortError`; run with `timeoutMs: 10`. Assert the affected check fails (or is skipped only where the spec explicitly allows inability to verify) and the report returns promptly without throwing the raw abort exception.

Run:

```sh
pnpm exec tsx --test src/remote-readiness.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```sh
git add src/remote-readiness.ts src/remote-readiness.test.ts
git commit -m "feat: probe remote MCP readiness"
```

---

### Task 4: Integrate Remote Readiness into `devspace doctor`

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`

**Interfaces:**
- Consumes: `runRemoteReadiness`, `formatRemoteReadinessReport`, `remoteReadinessExitCode`.
- Produces CLI forms:
  - `devspace doctor`
  - `devspace doctor --remote`
  - `devspace doctor --remote --json`
- Invalid doctor invocation returns exit `2`; failed readiness returns exit `1`; ready returns exit `0`.

- [ ] **Step 1: Write child-process CLI regressions first**

Extend `src/cli.test.ts` with an isolated config fixture using `writeTestDevspaceConfig()`:

```ts
const remoteDoctorRoot = mkdtempSync(join(tmpdir(), "devspace-cli-remote-doctor-"));
try {
  const remoteConfigEnv = writeTestDevspaceConfig(join(remoteDoctorRoot, "config"), {
    server: {
      host: "127.0.0.1",
      port: 1,
      publicBaseUrl: "https://127.0.0.1:1",
      allowedHosts: ["127.0.0.1"],
    },
  });

  let jsonFailure: unknown;
  try {
    await execFileAsync("node", ["--import", "tsx", "src/cli.ts", "doctor", "--remote", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, ...remoteConfigEnv },
    });
  } catch (error) {
    jsonFailure = error;
  }
  assert.ok(jsonFailure);
  assert.equal((jsonFailure as { code?: number }).code, 1);
  const report = JSON.parse((jsonFailure as { stdout?: string }).stdout ?? "{}");
  assert.equal(report.ready, false);
  assert.equal(report.checks.length, 8);
  assert.deepEqual(report.checks.map((check: { id: string }) => check.id), [
    "remote.public_origin", "remote.local_bind", "remote.host_allowlist",
    "remote.local_service", "remote.public_service", "remote.oauth_discovery",
    "remote.protected_resource", "remote.mcp_boundary",
  ]);

  await assert.rejects(
    execFileAsync("node", ["--import", "tsx", "src/cli.ts", "doctor", "--json"], {
      cwd: process.cwd(), encoding: "utf8", env: { ...process.env, ...remoteConfigEnv },
    }),
    (error: unknown) => {
      assert.equal((error as { code?: number }).code, 2);
      assert.match((error as { stderr?: string }).stderr ?? "", /doctor --remote \[--json\]/);
      return true;
    },
  );
} finally {
  rmSync(remoteDoctorRoot, { recursive: true, force: true });
}
```

Also add:

- A `doctor --remote` human-output invocation against the same intentionally failing fixture and assert stdout includes `Remote readiness: NOT READY` and at least one stable check ID.
- `doctor --wat` exits `2`.
- Existing `doctor` with no flags still prints existing lines including `Config dir:`, `Local MCP URL:`, `Public MCP URL:`, `Allowed roots:`, and `Allowed hosts:`.

- [ ] **Step 2: Run and verify RED**

```sh
pnpm exec tsx --test src/cli.test.ts
```

Expected: new doctor-flag assertions FAIL because `case "doctor"` currently ignores/does not implement the new contract.

- [ ] **Step 3: Refactor local doctor and add strict doctor-argument routing**

In `src/cli.ts`, change only the doctor branch:

```ts
case "doctor":
  await runDoctor(args);
  return;
```

Keep old output in a separate `runLocalDoctor()` containing the previous no-argument implementation verbatim.

Add:

```ts
interface DoctorOptions { remote: boolean; json: boolean; }

function parseDoctorArgs(args: string[]): DoctorOptions {
  const allowed = new Set(["--remote", "--json"]);
  const unknown = args.find(arg => !allowed.has(arg));
  if (unknown) throw new Error(`Unknown doctor option: ${unknown}`);
  const remote = args.includes("--remote");
  const json = args.includes("--json");
  if (json && !remote) throw new Error("Usage: devspace doctor --remote [--json]");
  return { remote, json };
}
```

Implement `runDoctor(args)` so malformed arguments set `process.exitCode = 2`, print one error to stderr, and return without falling through to global error handling. With no `--remote`, call `runLocalDoctor()` and preserve prior output.

For remote mode:

```ts
try {
  const report = await runRemoteReadiness(loadConfig());
  console.log(options.json ? JSON.stringify(report) : formatRemoteReadinessReport(report));
  process.exitCode = remoteReadinessExitCode(report);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
```

Do not write config or auto-start the server.

- [ ] **Step 4: Verify CLI GREEN plus static/probe regression**

```sh
pnpm exec tsx --test src/cli.test.ts src/remote-readiness.test.ts src/oauth-endpoints.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```sh
git add src/cli.ts src/cli.test.ts
git commit -m "feat: add remote doctor diagnostics"
```

---

### Task 5: Document the Tunnel-First Diagnostic and Record the Engineering Change

**Files:**
- Modify: `docs/setup.md`
- Modify: `docs/security.md`
- Modify: `CHANGELOG.md`
- Test: documentation checker

**Interfaces:**
- Consumes: exact CLI/check semantics from Tasks 1–4.
- Produces: user-facing setup/security guidance; no runtime behavior.

- [ ] **Step 1: Add setup documentation before changing changelog**

In `docs/setup.md`, under `## 接入 ChatGPT 网页`, add a subsection `### 远程就绪诊断` containing these commands and meanings:

```text
# Human-readable diagnostics
node bin/devspace.js doctor --remote

# Machine-readable diagnostics
node bin/devspace.js doctor --remote --json
```

Document:

- Exit `0`: all required checks are `pass` or `warn`.
- Exit `1`: at least one required check is `fail` or `skipped`.
- Exit `2`: invocation/configuration/internal diagnostic could not be evaluated safely.
- The command checks configuration, local listener identity, public HTTPS identity, OAuth metadata, protected-resource metadata, and unauthenticated MCP protection.
- It never creates/restarts/configures a tunnel and never performs OAuth/Owner approval.
- Forward the whole DevSpace service, not only `/mcp`.
- A green result still requires the real-host acceptance flow before claiming ChatGPT/Claude compatibility.

- [ ] **Step 2: Add security-boundary documentation**

In `docs/security.md`, add `## Remote readiness diagnostics` explaining:

```text
Passing `devspace doctor --remote` proves coherence/reachability of the configured transport/auth surface from the diagnostic machine. It does not make Shell sandboxed, expand workspace roots, approve a client, grant Owner approval, prove the host UI refreshed, or make a compromised AI client trustworthy.
```

State that TLS validation remains enabled and that diagnostic output never includes Owner/OAuth/tunnel credentials or full allowed-root lists.

- [ ] **Step 3: Run documentation tests before writing a success log entry**

```sh
npm run test:docs
```

Expected: PASS. If it fails, fix only documentation/link/fence issues caused by this change before proceeding.

- [ ] **Step 4: Add the dated changelog entry using only verified evidence**

Insert at the top of `CHANGELOG.md`, below `# Development Log`:

```markdown
## 2026-09-17 - Add tunnel-first remote readiness diagnostics (L2)

- Current State: DevSpace already supported user-managed HTTPS exposure, OAuth, Host allowlists and remote MCP access, but readiness was distributed across setup guidance and manual checks.
- Changes: Added one shared public MCP/OAuth endpoint contract and a read-only `devspace doctor --remote [--json]` diagnostic with eight stable checks for remote origin, loopback binding, Host allowlist, local/public service identity, OAuth metadata, protected-resource metadata and unauthenticated MCP protection. Tunnel lifecycle remains external.
- Root Cause: A public URL or healthy local listener alone cannot prove that the tunnel, OAuth metadata and MCP resource identity agree on one external origin.
- Impact: Additive CLI diagnostics only. No new MCP tool, database migration, runtime dependency, tunnel control, approval bypass, workspace expansion or agent-routing change.
- Tests: <replace this line during implementation with the exact targeted and full regression commands/results actually observed>.
- Compatibility: Existing `devspace doctor` remains; `--remote` is additive. Remote diagnostics are read-only and do not modify configuration.
- Known Risks: Repository tests do not prove a real ChatGPT/Claude connector or external tunnel. Phase A is not a hosted relay and does not provide device pairing, reconnect or multi-device routing.
- Next Highest-Leverage Step: Complete the real remote-host acceptance flow against a user-managed HTTPS endpoint before deciding whether Phase B needs a self-hosted relay/device agent.
```

Do **not** commit the literal `<replace this line...>` placeholder. Replace it with actual test evidence from Tasks 1–5 before committing.

- [ ] **Step 5: Commit Task 5 after docs verification**

```sh
git add docs/setup.md docs/security.md CHANGELOG.md
git commit -m "docs: document remote readiness workflow"
```

---

### Task 6: Full Regression, Diff Review, and Real-Host Acceptance Gate

**Files:**
- Modify only if verification reveals a defect in files from Tasks 1–5.
- No new Phase B files/types/tables are permitted in this task.

**Interfaces:**
- Consumes: completed Phase A implementation.
- Produces: verified repository candidate plus a separately reported real-host acceptance result.

- [ ] **Step 1: Run focused tests once more from the final code state**

```sh
pnpm exec tsx --test src/oauth-endpoints.test.ts src/remote-readiness.test.ts src/cli.test.ts src/server.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run all repository gates fresh**

```sh
npm run typecheck
npm run test:docs
npm test
npm run test:deploy
```

Record exact pass/fail/skip counts and any existing warnings separately. Do not add overlapping test counts as if they were one total.

- [ ] **Step 3: Inspect the complete branch diff against the base**

```sh
git diff --check
git diff --stat codex/personal...HEAD
git diff codex/personal...HEAD -- src/oauth-endpoints.ts src/remote-readiness.ts src/cli.ts src/server.ts docs/setup.md docs/security.md CHANGELOG.md
```

Verify manually from the diff:

- no config/database/tunnel mutation was added;
- no secret-bearing field is included in report objects;
- the server and diagnostic use the same endpoint helper;
- exactly eight stable check IDs exist and remain ordered;
- no Phase B device/relay type or dependency was introduced;
- existing local doctor body remains intact in `runLocalDoctor()`.

- [ ] **Step 4: Update the changelog Tests line with the fresh evidence**

Replace the Task 5 provisional Tests line with exact observed results only, then rerun:

```sh
npm run test:docs
git diff --check
```

Commit the evidence-only update if needed:

```sh
git add CHANGELOG.md
git commit -m "docs: record remote readiness verification"
```

- [ ] **Step 5: Execute the real-host acceptance gate only when a user-managed HTTPS endpoint is available**

Run:

```sh
node bin/devspace.js doctor --remote
```

Require `Remote readiness: READY`, then complete the spec's nine steps in a real remote MCP host:

1. remote host discovers OAuth metadata from the same public origin;
2. user completes normal OAuth/Owner consent;
3. MCP initialize succeeds;
4. open one allowed workspace;
5. read one known instruction file and verify exact real content;
6. modify one disposable test file using the existing guarded patch/edit contract;
7. read it back and verify hash/content evidence;
8. run one harmless project validation command through existing process tooling;
9. inspect the resulting aggregate review surface.

If any of these cannot be executed, record the exact unverified boundary and describe the result only as **repository-level remote-readiness support**. Do not claim a proven hosted Remote Desktop Commander replacement.

- [ ] **Step 6: Request final code review before integration**

Generate a full branch review package from the base `codex/personal` commit to `HEAD` and run the project's required review workflow. Critical/Important findings must be fixed and reverified before the branch is offered for merge/PR.

---

## Plan Self-Review Checklist

Before execution begins, the controller must verify:

- Every design acceptance criterion maps to Tasks 1–6.
- `PublicMcpEndpoints`, `RemoteReadinessConfig`, check IDs, and CLI forms use the same names in all tasks.
- No task requires a real tunnel until Task 6 real-host acceptance.
- No task adds a database migration, dependency, DeviceIdentity, relay, pairing, heartbeat, or multi-device routing.
- All production changes have an explicit RED test before implementation.
- No changelog completion claim is written before its verification command actually runs.
