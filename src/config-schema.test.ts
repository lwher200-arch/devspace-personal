import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import {
  DEVSPACE_CONFIG_SCHEMA_URL,
  devspaceConfigJsonSchema,
  devspaceConfigSchema,
} from "./config-schema.js";

const personalSchemaUrl =
  "https://raw.githubusercontent.com/lwher200-arch/devspace-personal/refs/heads/codex/personal/schema/v1/devspace.schema.json";
assert.equal(DEVSPACE_CONFIG_SCHEMA_URL, personalSchemaUrl, "personal configuration must not default to the upstream schema");
assert.equal(devspaceConfigSchema.parse({ configVersion: 1 }).$schema, personalSchemaUrl);
const schemaMetadata = devspaceConfigJsonSchema();
assert.ok("$id" in schemaMetadata);
assert.equal(schemaMetadata.$id, personalSchemaUrl);
const configurationGuide = readFileSync(new URL("../docs/configuration.md", import.meta.url), "utf8");
assert.ok(configurationGuide.includes(`"$schema": "${personalSchemaUrl}"`));
for (const match of configurationGuide.matchAll(/```jsonc\r?\n([\s\S]*?)```/g)) {
  const errors: import("jsonc-parser").ParseError[] = [];
  const example = parse(match[1], errors, { allowTrailingComma: true });
  assert.deepEqual(errors, [], "configuration guide must contain valid JSONC examples");
  devspaceConfigSchema.parse(example);
}
assert.equal(
  devspaceConfigSchema.parse({ configVersion: 1, $schema: "https://example.com/custom.schema.json" }).$schema,
  "https://example.com/custom.schema.json",
  "explicit custom schema metadata remains supported",
);

assert.throws(
  () => devspaceConfigSchema.parse({ configVersion: 1, typo: true }),
  /Unrecognized key/,
);

const generatedSchema = `${JSON.stringify(devspaceConfigJsonSchema(), null, 2)}\n`;
const committedSchema = readFileSync(
  new URL("../schema/v1/devspace.schema.json", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
assert.equal(committedSchema, generatedSchema, "run `npm run schema:config` after changing config-schema.ts");

console.log("config schema tests passed");
