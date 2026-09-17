# DevSpace Tunnel-First Remote Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `devspace doctor --remote [--json]` flow that validates DevSpace's tunnel-first remote MCP readiness without managing tunnels, changing configuration, or weakening existing security boundaries.

**Architecture:** Extract one shared public-endpoint contract used by both the HTTP server and diagnostics. Implement remote readiness as a typed module with three static configuration checks and five bounded network/protocol probes, assembled into one stable eight-check report. Keep `src/cli.ts` limited to argument parsing, existing local-doctor compatibility, presentation, and exit codes.

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
- Modify `CHANGELOG.md` only after final verification evidence exists.

---

### Task 1: Centralize Public MCP/OAuth Endpoint Construction

**Files:**
- Create: `src/oauth-endpoints.ts`
- Create: `src/oauth-endpoints.test.ts`
- Modify: `src/server.ts`
- Test: `src/oauth-endpoints.test.ts`, `src/server.test.ts`

**Interfaces:**
- Consumes: `getOAuthProtectedResourceMetadataUrl`, `resourceUrlFromServerUrl` from the current MCP SDK.
- Produces: `PublicMcpEndpoints` and `publicMcpEndpoints(publicBaseUrl: string): PublicMcpEndpoints`.

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

Modify `src/server.ts` to import `publicMcpEndpoints`, construct it once from `config.publicBaseUrl`, reuse `mcpUrl` and `resourceServerUrl`, and pass `endpoints.protectedResourceMetadataUrl` to bearer auth. Do not change scopes, rate limits, OAuth provider construction, route order, or authorization behavior.

- [ ] **Step 4: Verify GREEN and server compatibility**

```sh
pnpm exec tsx --test src/oauth-endpoints.test.ts src/server.test.ts
```

Expected: PASS.

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
- Consumes: `ServerConfig` fields `host`, `port`, `publicBaseUrl`, `allowedHosts`; `publicMcpEndpoints()`.
- Produces: `REMOTE_READINESS_CHECK_IDS`, `RemoteReadinessCheckId`, `RemoteCheckStatus`, `RemoteReadinessCheck`, `RemoteReadinessReport`, `RemoteReadinessConfig`, `evaluateRemoteConfiguration`, `finalizeRemoteReadinessReport`, `formatRemoteReadinessReport`, `remoteReadinessExitCode`.

- [ ] **Step 1: Write failing static-policy tests**

Create `src/remote-readiness.test.ts` with:

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

test("warnings preserve ready when all required checks are observed", () => {
  const staticChecks = evaluateRemoteConfiguration({ ...baseConfig, allowedHosts: ["*"] });
  assert.deepEqual(staticChecks.map(check => check.id), REMOTE_READINESS_CHECK_IDS.slice(0, 3));
  assert.equal(staticChecks[2].status, "warn");
  const report = finalizeRemoteReadinessReport(baseConfig, [...staticChecks, ...networkPasses]);
  assert.deepEqual(report.checks.map(check => check.id), REMOTE_READINESS_CHECK_IDS);
  assert.equal(report.ready, true);
  assert.equal(remoteReadinessExitCode(report), 0);
});

test("invalid tunnel-first config fails the corresponding static checks", () => {
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

test("missing required observations become skipped and block readiness", () => {
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

Expected: FAIL because `src/remote-readiness.ts` does not exist.

- [ ] **Step 3: Implement the report model and static checks**

Create these exact contracts in `src/remote-readiness.ts`:

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

Implement `evaluateRemoteConfiguration()` with these exact rules:

```ts
const publicUrl = new URL(config.publicBaseUrl);
const publicHost = publicUrl.hostname.toLowerCase();
const loopbackPublic = ["localhost", "127.0.0.1", "::1"].includes(publicHost);
```

- `remote.public_origin`: pass only for `https:` and non-loopback host.
- `remote.local_bind`: pass only for `127.0.0.1`, `::1`, or `localhost`.
- `remote.host_allowlist`: `*` => `warn`; exact normalized public hostname => `pass`; otherwise `fail`.

Implement `finalizeRemoteReadinessReport()` by mapping checks by ID, inserting `skipped` entries for every absent ID, emitting exactly `REMOTE_READINESS_CHECK_IDS` order, and setting `ready=true` only when all statuses are `pass` or `warn`. Derive `publicBaseUrl` and `mcpUrl` only through `publicMcpEndpoints()`.

Implement:

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

Keep private result-construction helpers limited to `id`, `summary`, bounded `detail`, and `remediation`; never pass a complete auth/config object into a report helper.

- [ ] **Step 4: Add redaction-by-construction regression and verify GREEN**

Append:

```ts
test("report serialization exposes no unrelated security fields", () => {
  const report = finalizeRemoteReadinessReport(baseConfig, [
    ...evaluateRemoteConfiguration(baseConfig),
    ...networkPasses,
  ]);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("ownerToken"), false);
  assert.equal(serialized.includes("allowedRoots"), false);
  assert.equal(serialized.includes("Authorization"), false);
  assert.equal(serialized.includes("cookie"), false);
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
- Consumes: endpoint helper and Task 2 contracts.
- Produces: `RemoteReadinessOptions` and `runRemoteReadiness(config, options?): Promise<RemoteReadinessReport>`.

- [ ] **Step 1: Write failing success-path and mismatch tests**

Add to `src/remote-readiness.test.ts`:

```ts
import { publicMcpEndpoints } from "./oauth-endpoints.js";
import { runRemoteReadiness } from "./remote-readiness.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
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

test("coherent endpoints pass all eight readiness checks", async () => {
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

test("metadata origin mismatch and open MCP endpoint fail independently", async () => {
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

Add one more test where local health throws a connection error and public health returns HTML; assert `remote.local_service` and `remote.public_service` each fail with their own IDs.

- [ ] **Step 2: Run and verify RED**

```sh
pnpm exec tsx --test src/remote-readiness.test.ts
```

Expected: FAIL because `runRemoteReadiness` is not implemented.

- [ ] **Step 3: Implement bounded probe orchestration**

Add:

```ts
export interface RemoteReadinessOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_REMOTE_PROBE_TIMEOUT_MS = 2_000;
```

Implement bounded fetch:

```ts
async function fetchBounded(fetchImpl: typeof fetch, input: string | URL, timeoutMs: number): Promise<Response> {
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

1. start with `evaluateRemoteConfiguration(config)`;
2. probe local `http://<loopback-host>:<port>/healthz`, requiring `200` JSON `{ ok: true, name: "devspace" }`;
3. probe public `<public-origin>/healthz`, requiring the same DevSpace identity;
4. probe authorization-server metadata, requiring `issuer`, `authorization_endpoint`, and `token_endpoint` to resolve to the configured public origin;
5. probe protected-resource metadata, requiring `resource === resourceServerUrl.toString()` and, when `authorization_servers` exists, inclusion of the configured public origin;
6. probe public `/mcp` with no Authorization header, requiring status `401` and a Bearer challenge or equivalent protected-resource response rather than generic successful HTML;
7. retain each failure under its own check ID and only bounded error details; never include full response bodies;
8. call `finalizeRemoteReadinessReport(config, checks)` once at the end.

For `::1`, construct the local URL using `[::1]`. A non-loopback configured bind still fails `remote.local_bind`; do not invent a different local target that hides the misconfiguration.

If `remote.public_origin` fails, continue the local service probe but create `skipped` results for `remote.public_service`, `remote.oauth_discovery`, `remote.protected_resource`, and `remote.mcp_boundary` instead of probing the invalid public target.

- [ ] **Step 4: Add timeout/abort regression and verify GREEN**

Add an injected fetch that waits for `signal.abort` and rejects with an `AbortError`; run with `timeoutMs: 10`. Assert the relevant check is bounded, returns `fail` or the spec-defined `skipped`, and `runRemoteReadiness()` resolves a report rather than throwing the raw abort.

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
- Produces: `devspace doctor`, `devspace doctor --remote`, `devspace doctor --remote --json`.

- [ ] **Step 1: Write child-process CLI regressions first**

Extend `src/cli.test.ts` with an isolated config created via `writeTestDevspaceConfig()` and assertions for:

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
      cwd: process.cwd(), encoding: "utf8", env: { ...process.env, ...remoteConfigEnv },
    });
  } catch (error) {
    jsonFailure = error;
  }
  assert.ok(jsonFailure);
  assert.equal((jsonFailure as { code?: number }).code, 1);
  const report = JSON.parse((jsonFailure as { stdout?: string }).stdout ?? "{}");
  assert.equal(report.ready, false);
  assert.equal(report.checks.length, 8);

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

Also assert:

- `doctor --remote` on the failing fixture writes `Remote readiness: NOT READY` and stable check IDs to stdout and exits `1`;
- `doctor --wat` exits `2` with one usage/unknown-option error;
- plain `doctor` still prints its existing local fields including `Config dir:`, `Local MCP URL:`, `Public MCP URL:`, `Allowed roots:`, and `Allowed hosts:`.

- [ ] **Step 2: Run and verify RED**

```sh
pnpm exec tsx --test src/cli.test.ts
```

Expected: new doctor flag tests FAIL.

- [ ] **Step 3: Implement strict doctor argument routing without changing local doctor**

Change the switch to:

```ts
case "doctor":
  await runDoctor(args);
  return;
```

Move the existing no-argument body verbatim into `runLocalDoctor()`.

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

`runDoctor(args)` must catch only its own invocation/diagnostic boundary so exit code `2` is distinguishable from readiness failure. With no `--remote`, call `runLocalDoctor()` unchanged. In remote mode:

```ts
const report = await runRemoteReadiness(loadConfig());
console.log(options.json ? JSON.stringify(report) : formatRemoteReadinessReport(report));
process.exitCode = remoteReadinessExitCode(report);
```

On doctor argument/internal diagnostic failure, print one bounded error to stderr and set `process.exitCode = 2`. Do not write configuration or start/restart a server.

- [ ] **Step 4: Verify CLI GREEN plus related regression**

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

### Task 5: Document the Tunnel-First Diagnostic

**Files:**
- Modify: `docs/setup.md`
- Modify: `docs/security.md`

**Interfaces:**
- Consumes: exact CLI/check semantics from Tasks 1–4.
- Produces: user-facing setup/security guidance only.

- [ ] **Step 1: Add setup documentation**

Under `## 接入 ChatGPT 网页` in `docs/setup.md`, add `### 远程就绪诊断` and document these exact commands:

```sh
node bin/devspace.js doctor --remote
node bin/devspace.js doctor --remote --json
```

State:

- exit `0`: every required check is `pass` or `warn`;
- exit `1`: at least one required check is `fail` or `skipped`;
- exit `2`: invocation/configuration/internal diagnostic could not be evaluated safely;
- the diagnostic checks configuration, local listener identity, public HTTPS identity, OAuth metadata, protected-resource metadata, and unauthenticated MCP protection;
- it never creates/restarts/configures a tunnel and never performs OAuth or Owner approval;
- the tunnel/reverse proxy must forward the whole DevSpace service, not only `/mcp`;
- a green result still requires real-host acceptance before claiming ChatGPT/Claude compatibility.

- [ ] **Step 2: Add security-boundary documentation**

Add `## Remote readiness diagnostics` to `docs/security.md` with this contract:

```text
Passing `devspace doctor --remote` proves coherence and reachability of the configured transport/auth surface from the diagnostic machine. It does not make Shell sandboxed, expand workspace roots, approve a client, grant Owner approval, prove the host UI refreshed, or make a compromised AI client trustworthy.
```

Also state that TLS validation remains enabled and that diagnostic output excludes Owner/OAuth/tunnel credentials and full allowed-root lists.

- [ ] **Step 3: Verify documentation before commit**

```sh
npm run test:docs
```

Expected: PASS.

- [ ] **Step 4: Commit Task 5**

```sh
git add docs/setup.md docs/security.md
git commit -m "docs: document remote readiness workflow"
```

---

### Task 6: Full Regression, Evidence Log, Diff Review, and Real-Host Acceptance Gate

**Files:**
- Modify: `CHANGELOG.md` after verification only.
- Modify other Phase A files only if verification exposes a defect.
- Do not add any Phase B file/type/table/dependency.

**Interfaces:**
- Consumes: completed Phase A implementation.
- Produces: verified repository candidate and separately reported real-host acceptance status.

- [ ] **Step 1: Run focused tests fresh from final code state**

```sh
pnpm exec tsx --test src/oauth-endpoints.test.ts src/remote-readiness.test.ts src/cli.test.ts src/server.test.ts
```

Record the exact command result and test counts shown by the runner.

- [ ] **Step 2: Run all repository gates fresh**

```sh
npm run typecheck
npm run test:docs
npm test
npm run test:deploy
```

Record each command's exit status and any pass/fail/skip counts it actually reports. Keep overlapping suites separate rather than summing them into a synthetic total.

- [ ] **Step 3: Inspect the complete branch diff against `codex/personal`**

```sh
git diff --check
git diff --stat codex/personal...HEAD
git diff codex/personal...HEAD -- src/oauth-endpoints.ts src/remote-readiness.ts src/cli.ts src/server.ts docs/setup.md docs/security.md
```

Verify from the diff:

- no config/database/tunnel mutation exists;
- no secret-bearing field enters report objects;
- server and diagnostic share one endpoint helper;
- exactly eight stable check IDs remain ordered;
- no Phase B device/relay type or dependency exists;
- the original local doctor body remains intact under `runLocalDoctor()`.

- [ ] **Step 4: Create the changelog entry from observed evidence**

Only after Steps 1–3 have completed, insert a new entry immediately below `# Development Log` with this fixed structure and factual content:

```markdown
## 2026-09-17 - Add tunnel-first remote readiness diagnostics (L2)

- Current State: DevSpace already supported user-managed HTTPS exposure, OAuth, Host allowlists and remote MCP access, but readiness was distributed across setup guidance and manual checks.
- Changes: Added one shared public MCP/OAuth endpoint contract and a read-only `devspace doctor --remote [--json]` diagnostic with eight stable checks for remote origin, loopback binding, Host allowlist, local/public service identity, OAuth metadata, protected-resource metadata and unauthenticated MCP protection. Tunnel lifecycle remains external.
- Root Cause: A public URL or healthy local listener alone cannot prove that the tunnel, OAuth metadata and MCP resource identity agree on one external origin.
- Impact: Additive CLI diagnostics only. No new MCP tool, database migration, runtime dependency, tunnel control, approval bypass, workspace expansion or agent-routing change.
- Compatibility: Existing `devspace doctor` remains unchanged without flags; `--remote` is additive and read-only.
- Known Risks: Repository tests do not prove a real ChatGPT/Claude connector or external tunnel. Phase A is not a hosted relay and does not provide device pairing, reconnect or multi-device routing.
- Next Highest-Leverage Step: Complete the real remote-host acceptance flow against a user-managed HTTPS endpoint before deciding whether Phase B needs a self-hosted relay/device agent.
```

Between `Impact` and `Compatibility`, add one `Tests` bullet built only from the outputs recorded in Steps 1–2. Name every command executed. For a command that reports counts, copy those counts exactly; for a command that reports only success, state `exit 0`. Do not infer missing counts or write a success claim for any command that did not finish successfully.

Then run:

```sh
npm run test:docs
git diff --check
```

Commit only after both succeed:

```sh
git add CHANGELOG.md
git commit -m "docs: record remote readiness verification"
```

- [ ] **Step 5: Execute the real-host acceptance gate when a user-managed HTTPS endpoint is available**

Run:

```sh
node bin/devspace.js doctor --remote
```

Require `Remote readiness: READY`, then complete the spec's real-host sequence:

1. remote host discovers OAuth metadata from the same public origin;
2. user completes normal OAuth/Owner consent;
3. MCP initialize succeeds;
4. open one allowed workspace;
5. read one known instruction file and verify its real content;
6. modify one disposable test file using the existing guarded edit/patch contract;
7. read it back and verify hash/content evidence;
8. run one harmless project validation command through existing process tooling;
9. inspect the resulting aggregate review surface.

If any step cannot be executed, record that exact boundary as unverified and describe the result only as **repository-level remote-readiness support**. Do not claim a proven hosted Remote Desktop Commander replacement.

- [ ] **Step 6: Request final code review before integration**

Generate a full branch review package from the `codex/personal` merge base to `HEAD`. Run the required code-review workflow. Fix and reverify every Critical or Important finding before offering the branch for merge or PR.

---

## Plan Self-Review Checklist

Before execution begins, the controller must verify:

- Every design acceptance criterion maps to Tasks 1–6.
- `PublicMcpEndpoints`, `RemoteReadinessConfig`, check IDs, and CLI forms use the same names in all tasks.
- No task requires a real tunnel until Task 6 real-host acceptance.
- No task adds a database migration, runtime dependency, DeviceIdentity, relay, pairing, heartbeat, or multi-device routing.
- All production behaviors have an explicit RED test before implementation.
- Changelog completion claims are created only after fresh verification evidence exists.
- The plan contains no unfinished implementation placeholder or deferred design decision.
