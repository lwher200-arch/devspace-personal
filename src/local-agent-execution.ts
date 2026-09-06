import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { gte, valid } from "semver";
import * as z from "zod/v4";
import { assertAllowedPath, canonicalAllowedPath } from "./roots.js";

export const executionPolicySchema = z.object({
  requiredModel: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/),
  minimumCliVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
}).strict();
export const executionEvidenceSchema = z.object({
  requestedModel: z.string().min(1),
  sessionModel: z.string().min(1),
  runtimeModel: z.string().min(1),
  cliVersion: z.string().min(1),
  executable: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  source: z.literal("codex-rollout/turn_context"),
  sandbox: z.enum(["readOnly", "workspaceWrite"]),
  approvalPolicy: z.literal("never"),
}).strict();
export type CodexExecutionPolicy = z.infer<typeof executionPolicySchema>;
export type CodexExecutionEvidence = z.infer<typeof executionEvidenceSchema>;

export function assertExecutionSelection(policy: CodexExecutionPolicy, model: string | undefined, version: string | undefined): void {
  executionPolicySchema.parse(policy);
  if (model !== policy.requiredModel) throw new Error(`An explicit model of ${policy.requiredModel} is required; inherited or different models are not accepted.`);
  if (!version || !valid(version) || !gte(version, policy.minimumCliVersion)) {
    throw new Error(`Codex CLI version ${policy.minimumCliVersion} or newer is required; actual version: ${version ?? "unavailable"}.`);
  }
}

export async function readCodexTurnEvidence(home: string, path: string, turnId: string): Promise<string> {
  const roots = [join(home, "sessions"), join(home, "archived_sessions")];
  const absolute = canonicalAllowedPath(assertAllowedPath(path, roots));
  const info = await stat(absolute);
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error("Codex turn evidence is not a bounded regular rollout file.");
  const stream = createReadStream(absolute, { encoding: "utf8", end: Math.max(0, info.size - 1) });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const timer = setTimeout(() => stream.destroy(new Error("Codex turn evidence read timed out.")), 5000);
  let found: string | undefined;
  try {
    for await (const line of lines) {
      if (line.length > 1024 * 1024) throw new Error("Codex turn evidence line exceeded its size limit.");
      if (!/"type"\s*:\s*"turn_context"/.test(line)) continue;
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      if (value.type !== "turn_context" || value.payload?.turn_id !== turnId) continue;
      const model = value.payload?.model;
      if (typeof model !== "string" || !model.trim()) throw new Error("Codex turn evidence has no model.");
      if (found !== undefined && found !== model) throw new Error("Codex turn evidence contains conflicting runtime models.");
      found = model;
    }
    if (canonicalAllowedPath(assertAllowedPath(path, roots)) !== absolute) throw new Error("Codex evidence path changed.");
    if (!found) throw new Error("Codex runtime model evidence is unavailable for the exact completed turn.");
    return found;
  } finally { clearTimeout(timer); lines.close(); stream.destroy(); }
}
