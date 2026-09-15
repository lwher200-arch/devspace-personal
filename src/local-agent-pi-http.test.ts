import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";

const fromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { Agent, interceptors, request } = fromPi("undici");

for (const [name, header, cached] of [
  ["empty qualified private directive", 'public, max-age=300, private=""', false],
  ["mixed private directives", 'public, max-age=300, private, private="x-user"', false],
  ["ordinary public response", 'public, max-age=300', true],
] as const) {
  test(`Pi HTTP dependency preserves shared-cache isolation for ${name}`, async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      res.setHeader("cache-control", header);
      res.end(`response-${++requests}`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const dispatcher = new Agent().compose(interceptors.cache());
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const url = `http://127.0.0.1:${address.port}/profile`;
      const first = await request(url, { dispatcher });
      const firstBody = await first.body.text();
      const second = await request(url, { dispatcher });
      const secondBody = await second.body.text();
      if (cached) assert.equal(secondBody, firstBody, "normal public caching remains enabled");
      else assert.notEqual(secondBody, firstBody, "private data must not enter a shared cache");
    } finally {
      await dispatcher.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
