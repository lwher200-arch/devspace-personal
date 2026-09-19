import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "../config.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { resultOutputSchema, runLoggedToolOperation, textBlock } from "../tool-surfaces/shared.js";
import { workspaceIdDescription } from "../tool-surfaces/types.js";
import {
  buildContextCapsule,
  contextAnchorSchema,
  contextBudgetSchema,
  contextDeltaSchema,
  type ContextAnchor,
  type ContextCapsule,
  type ContextDelta,
} from "./context-fabric.js";

const payload = z.string().min(2).max(2 * 1024 * 1024);
const anchorId = z.string().trim().min(1).max(256);

export const contextFabricToolInputShape = {
  workspaceId: z.string().describe(workspaceIdDescription),
  action: z.enum(["put_anchor", "append_delta", "capsule"]),
  anchorJson: payload.optional().describe("JSON ContextAnchor for put_anchor."),
  deltaJson: payload.optional().describe("JSON ContextDelta for append_delta."),
  anchorId: anchorId.optional().describe("Stored anchor to materialize for capsule."),
  replace: z.boolean().optional().describe("Explicitly replace an existing anchor and discard its deltas."),
  objective: z.string().trim().min(1).max(8192).optional(),
  objectiveEstimatedTokens: z.number().int().nonnegative().max(1_000_000).optional(),
  maxTokens: z.number().int().positive().max(1_000_000).optional(),
  reserveTokens: z.number().int().nonnegative().max(1_000_000).optional(),
  maxStatements: z.number().int().positive().max(2048).optional(),
} as const;

export const contextFabricToolInputSchema = z.object(contextFabricToolInputShape).strict().superRefine((value, ctx) => {
  const required = (key: keyof typeof contextFabricToolInputShape) => {
    if (value[key] === undefined) ctx.addIssue({ code: "custom", path: [key], message: `${String(key)} is required for ${value.action}.` });
  };
  if (value.action === "put_anchor") required("anchorJson");
  if (value.action === "append_delta") required("deltaJson");
  if (value.action === "capsule") {
    required("anchorId"); required("objective"); required("objectiveEstimatedTokens"); required("maxTokens");
  }
});
export type ContextFabricToolInput = z.infer<typeof contextFabricToolInputSchema>;

type StoredAnchor = { anchor: ContextAnchor; deltas: ContextDelta[]; bytes: number };
const MAX_ANCHORS_PER_WORKSPACE = 64;
const MAX_DELTAS_PER_ANCHOR = 256;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 16 * 1024 * 1024;

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function parseJson<T>(label: string, text: string, schema: z.ZodType<T>): T {
  let decoded: unknown;
  try { decoded = JSON.parse(text); }
  catch { throw new Error(`${label} must be valid JSON.`); }
  return schema.parse(decoded);
}

export class ContextFabricStore {
  private readonly workspaces = new Map<string, Map<string, StoredAnchor>>();

  private workspace(workspaceId: string): Map<string, StoredAnchor> {
    let anchors = this.workspaces.get(workspaceId);
    if (!anchors) { anchors = new Map(); this.workspaces.set(workspaceId, anchors); }
    return anchors;
  }

  private workspaceBytes(workspaceId: string): number {
    return [...(this.workspaces.get(workspaceId)?.values() ?? [])].reduce((total, entry) => total + entry.bytes, 0);
  }

  private assertRecordSize(bytes: number): void {
    if (bytes > MAX_RECORD_BYTES) throw new Error(`Context Fabric record exceeds ${MAX_RECORD_BYTES} bytes.`);
  }

  private assertWorkspaceSize(workspaceId: string, nextBytes: number): void {
    if (nextBytes > MAX_WORKSPACE_BYTES) throw new Error(`Context Fabric workspace state exceeds ${MAX_WORKSPACE_BYTES} bytes.`);
  }

  putAnchor(workspaceId: string, input: unknown, replace = false) {
    const anchor = contextAnchorSchema.parse(input);
    const bytes = encodedBytes(anchor);
    this.assertRecordSize(bytes);
    const anchors = this.workspace(workspaceId);
    const previous = anchors.get(anchor.anchorId);
    if (previous) {
      if (JSON.stringify(previous.anchor) === JSON.stringify(anchor)) {
        return { anchorId: anchor.anchorId, idempotent: true, replaced: false, deltaCount: previous.deltas.length, workspaceBytes: this.workspaceBytes(workspaceId) };
      }
      if (!replace) throw new Error(`Anchor ${anchor.anchorId} already exists; set replace=true to replace it explicitly.`);
    } else if (anchors.size >= MAX_ANCHORS_PER_WORKSPACE) {
      throw new Error(`Context Fabric workspace has reached ${MAX_ANCHORS_PER_WORKSPACE} anchors.`);
    }
    const nextWorkspaceBytes = this.workspaceBytes(workspaceId) - (previous?.bytes ?? 0) + bytes;
    this.assertWorkspaceSize(workspaceId, nextWorkspaceBytes);
    anchors.set(anchor.anchorId, { anchor, deltas: [], bytes });
    return { anchorId: anchor.anchorId, idempotent: false, replaced: Boolean(previous), deltaCount: 0, workspaceBytes: nextWorkspaceBytes };
  }

  appendDelta(workspaceId: string, input: unknown) {
    const delta = contextDeltaSchema.parse(input);
    const anchors = this.workspace(workspaceId);
    const entry = anchors.get(delta.baseAnchorId);
    if (!entry) throw new Error(`Anchor ${delta.baseAnchorId} is not stored in this workspace.`);
    const existing = entry.deltas.find(candidate => candidate.deltaId === delta.deltaId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(delta)) throw new Error(`Delta ${delta.deltaId} already exists with different content.`);
      return { anchorId: delta.baseAnchorId, deltaId: delta.deltaId, sequence: delta.sequence, idempotent: true, deltaCount: entry.deltas.length, workspaceBytes: this.workspaceBytes(workspaceId) };
    }
    if (entry.deltas.length >= MAX_DELTAS_PER_ANCHOR) throw new Error(`Anchor ${delta.baseAnchorId} has reached ${MAX_DELTAS_PER_ANCHOR} deltas; re-anchor before appending more.`);
    const lastSequence = entry.deltas.at(-1)?.sequence;
    if (lastSequence !== undefined && delta.sequence <= lastSequence) throw new Error(`Delta sequence must increase beyond ${lastSequence}; re-anchor or append the next sequence.`);
    const bytes = encodedBytes(delta);
    this.assertRecordSize(bytes);
    const nextWorkspaceBytes = this.workspaceBytes(workspaceId) + bytes;
    this.assertWorkspaceSize(workspaceId, nextWorkspaceBytes);
    entry.deltas.push(delta);
    entry.bytes += bytes;
    return { anchorId: delta.baseAnchorId, deltaId: delta.deltaId, sequence: delta.sequence, idempotent: false, deltaCount: entry.deltas.length, workspaceBytes: nextWorkspaceBytes };
  }

  capsule(workspaceId: string, input: { anchorId: string; objective: string; objectiveEstimatedTokens: number; maxTokens: number; reserveTokens?: number; maxStatements?: number }): ContextCapsule {
    const entry = this.workspace(workspaceId).get(input.anchorId);
    if (!entry) throw new Error(`Anchor ${input.anchorId} is not stored in this workspace.`);
    const budget = contextBudgetSchema.parse({ maxTokens: input.maxTokens, reserveTokens: input.reserveTokens, maxStatements: input.maxStatements });
    return buildContextCapsule({ anchor: entry.anchor, deltas: entry.deltas, objective: input.objective, objectiveEstimatedTokens: input.objectiveEstimatedTokens, budget });
  }

  clear(): void { this.workspaces.clear(); }
}

export function registerContextFabricTool(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  store: ContextFabricStore,
): void {
  server.registerTool("context_fabric", {
    title: "Context Fabric",
    description: "Store a workspace-scoped in-memory ContextAnchor, append validated ContextDelta records, or materialize one evidence-linked ContextCapsule under a token budget. This state never grants execution authority and is lost on service restart.",
    inputSchema: contextFabricToolInputShape,
    outputSchema: resultOutputSchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (raw) => {
    const input = contextFabricToolInputSchema.parse(raw);
    workspaces.getWorkspace(input.workspaceId);
    const result = await runLoggedToolOperation(config, { tool: "context_fabric", workspaceId: input.workspaceId }, performance.now(), async () => {
      if (input.action === "put_anchor") return store.putAnchor(input.workspaceId, parseJson("anchorJson", input.anchorJson!, contextAnchorSchema), input.replace ?? false);
      if (input.action === "append_delta") return store.appendDelta(input.workspaceId, parseJson("deltaJson", input.deltaJson!, contextDeltaSchema));
      return store.capsule(input.workspaceId, {
        anchorId: input.anchorId!, objective: input.objective!, objectiveEstimatedTokens: input.objectiveEstimatedTokens!,
        maxTokens: input.maxTokens!, reserveTokens: input.reserveTokens, maxStatements: input.maxStatements,
      });
    });
    const text = JSON.stringify(result);
    return { content: [textBlock(text)], structuredContent: { result: text } };
  });
}
