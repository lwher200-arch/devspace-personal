import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlHubClient,
  ControlHubClientError,
  controlHubClientConfigFromEnv,
} from "./control-hub-client.js";

const token = "fixture-node-token-that-must-never-appear-in-errors";
const baseConfig = {
  baseUrl: "https://hub.example.test",
  nodeId: "node-a",
  clientId: "fixture-client",
  nodeToken: token,
  timeoutMs: 5_000,
};

test("ControlHubClient keeps health public and authenticates fixed node routes", async () => {
  const requests: Array<{ url: string; headers: Headers; body?: string }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, headers, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (url.endsWith("/healthz")) return Response.json({ ok: true, name: "devspace-control-hub", protocolVersion: 1 });
    if (url.endsWith("/v1/nodes/hello")) return Response.json({
      ok: true, nodeId: "node-a", instanceId: "instance-a", seenAt: "2026-09-19T05:00:00.000+00:00",
    });
    throw new Error("unexpected request");
  };
  const client = new ControlHubClient(baseConfig, fakeFetch);
  assert.equal((await client.health()).ok, true);
  assert.equal(requests[0].headers.has("authorization"), false);
  const hello = await client.hello({
    version: 1,
    nodeId: "node-a",
    instanceId: "instance-a",
    startedAt: "2026-09-19T04:59:00.000+00:00",
    productVersion: "1.0.8",
    capabilities: ["status"],
  });
  assert.equal(hello.nodeId, "node-a");
  assert.equal(requests[1].headers.get("authorization"), `Bearer ${token}`);
  assert.equal(requests[1].headers.get("x-devspace-node-id"), "node-a");
  assert.equal(requests[1].headers.get("x-devspace-client-id"), "fixture-client");
});

test("ControlHubClient validates permission/notification projections and never puts tokens in HTTP errors", async () => {
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/permissions")) return Response.json({ ok: true, assignments: [] });
    if (url.endsWith("/v1/notifications")) return Response.json({ ok: true, notifications: [] });
    return Response.json({ ok: false, code: "DENIED", message: "No access" }, { status: 403 });
  };
  const client = new ControlHubClient(baseConfig, fakeFetch);
  assert.deepEqual(await client.permissions(), []);
  assert.deepEqual(await client.notifications(), []);
  const failing = new ControlHubClient(baseConfig, async () =>
    Response.json({ ok: false, code: "DENIED", message: "No access" }, { status: 403 }));
  await assert.rejects(
    () => failing.hello({
      version: 1, nodeId: "node-a", instanceId: "instance-a",
      startedAt: "2026-09-19T04:59:00.000+00:00", productVersion: "1.0.8", capabilities: ["status"],
    }),
    (error: unknown) => {
      assert.ok(error instanceof ControlHubClientError);
      assert.equal(error.status, 403);
      assert.doesNotMatch(error.message, new RegExp(token));
      return true;
    },
  );
});

test("Control Hub environment config is explicit and keeps the token out of descriptions", () => {
  assert.equal(controlHubClientConfigFromEnv({}), undefined);
  const config = controlHubClientConfigFromEnv({
    DEVSPACE_CONTROL_HUB_URL: "https://hub.example.test/",
    DEVSPACE_CONTROL_HUB_NODE_ID: "node-a",
    DEVSPACE_CONTROL_HUB_CLIENT_ID: "client-a",
    DEVSPACE_CONTROL_HUB_NODE_TOKEN: token,
    DEVSPACE_CONTROL_HUB_TIMEOUT_MS: "4000",
  });
  assert.deepEqual(config, {
    baseUrl: "https://hub.example.test",
    nodeId: "node-a",
    clientId: "client-a",
    nodeToken: token,
    timeoutMs: 4000,
  });
  const client = new ControlHubClient(config!);
  assert.deepEqual(client.describe(), {
    baseUrl: "https://hub.example.test",
    nodeId: "node-a",
    clientId: "client-a",
    authenticatedConfigured: true,
  });
  assert.doesNotMatch(JSON.stringify(client.describe()), new RegExp(token));
});
