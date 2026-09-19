import * as z from "zod/v4";

const id = z.string().trim().min(1).max(256);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const isoDate = z.iso.datetime({ offset: true });

export const CONTEXT_FABRIC_VERSION = 1 as const;

export const evidenceKindSchema = z.enum([
  "file",
  "decision",
  "test",
  "log",
  "artifact",
  "conversation",
  "runtime",
]);

export const evidenceRefSchema = z.object({
  version: z.literal(CONTEXT_FABRIC_VERSION),
  evidenceId: id,
  kind: evidenceKindSchema,
  locator: z.string().trim().min(1).max(4096),
  digest: sha256.optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.startLine === undefined) !== (value.endLine === undefined)) {
    ctx.addIssue({ code: "custom", message: "Evidence line ranges require both startLine and endLine." });
  } else if (value.startLine !== undefined && value.endLine! < value.startLine) {
    ctx.addIssue({ code: "custom", message: "Evidence endLine must not precede startLine." });
  }
});
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

export const contextRoleSchema = z.enum([
  "invariant",
  "objective",
  "decision",
  "state",
  "change",
  "exception",
  "open_question",
]);
export type ContextRole = z.infer<typeof contextRoleSchema>;

const factualRoles = new Set<ContextRole>([
  "invariant",
  "decision",
  "state",
  "change",
  "exception",
]);

export const contextStatementSchema = z.object({
  statementId: id,
  role: contextRoleSchema,
  text: z.string().trim().min(1).max(8192),
  evidenceIds: z.array(id).max(32).default([]),
  supersedes: z.array(id).max(32).default([]),
  estimatedTokens: z.number().int().positive().max(1_000_000),
  priority: z.number().int().min(0).max(100).default(50),
  required: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  if (factualRoles.has(value.role) && value.evidenceIds.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "Factual context statements require at least one EvidenceRef.",
      path: ["evidenceIds"],
    });
  }
});
export type ContextStatement = z.infer<typeof contextStatementSchema>;

export const contextAnchorSchema = z.object({
  version: z.literal(CONTEXT_FABRIC_VERSION),
  anchorId: id,
  createdAt: isoDate,
  stateDigest: sha256,
  statements: z.array(contextStatementSchema).max(512),
  evidenceRefs: z.array(evidenceRefSchema).max(1024),
}).strict();
export type ContextAnchor = z.infer<typeof contextAnchorSchema>;

export const contextDeltaSchema = z.object({
  version: z.literal(CONTEXT_FABRIC_VERSION),
  deltaId: id,
  baseAnchorId: id,
  sequence: z.number().int().nonnegative(),
  createdAt: isoDate,
  changes: z.array(contextStatementSchema).max(512),
  exceptions: z.array(contextStatementSchema).max(512),
  evidenceRefs: z.array(evidenceRefSchema).max(1024),
}).strict().superRefine((value, ctx) => {
  for (const [index, statement] of value.exceptions.entries()) {
    if (statement.role !== "exception") {
      ctx.addIssue({
        code: "custom",
        message: "ContextDelta exceptions must use role=exception.",
        path: ["exceptions", index, "role"],
      });
    }
  }
});
export type ContextDelta = z.infer<typeof contextDeltaSchema>;

export const contextBudgetSchema = z.object({
  maxTokens: z.number().int().positive().max(1_000_000),
  reserveTokens: z.number().int().nonnegative().max(1_000_000).default(0),
  maxStatements: z.number().int().positive().max(2048).default(256),
}).strict().superRefine((value, ctx) => {
  if (value.reserveTokens >= value.maxTokens) {
    ctx.addIssue({
      code: "custom",
      message: "reserveTokens must be smaller than maxTokens.",
      path: ["reserveTokens"],
    });
  }
});
export type ContextBudget = z.infer<typeof contextBudgetSchema>;

export const contextCapsuleSchema = z.object({
  version: z.literal(CONTEXT_FABRIC_VERSION),
  anchorId: id,
  deltaIds: z.array(id).max(2048),
  objective: z.string().trim().min(1).max(8192),
  statements: z.array(contextStatementSchema).max(2048),
  evidenceRefs: z.array(evidenceRefSchema).max(4096),
  estimatedTokens: z.number().int().nonnegative(),
  budget: contextBudgetSchema,
  omittedStatementIds: z.array(id).max(8192),
}).strict();
export type ContextCapsule = z.infer<typeof contextCapsuleSchema>;

export class ContextBudgetExceededError extends Error {
  constructor(readonly requiredTokens: number, readonly availableTokens: number) {
    super(`Required context needs ${requiredTokens} estimated tokens but only ${availableTokens} are available.`);
    this.name = "ContextBudgetExceededError";
  }
}

interface BuildContextCapsuleInput {
  anchor: ContextAnchor;
  deltas?: readonly ContextDelta[];
  objective: string;
  objectiveEstimatedTokens: number;
  budget: ContextBudget;
}

function roleWeight(role: ContextRole): number {
  switch (role) {
    case "invariant": return 7;
    case "exception": return 6;
    case "decision": return 5;
    case "change": return 4;
    case "state": return 3;
    case "open_question": return 2;
    case "objective": return 1;
  }
}

function currentStatements(anchor: ContextAnchor, deltas: readonly ContextDelta[]): ContextStatement[] {
  const state = new Map<string, ContextStatement>();
  const ordered = [
    ...anchor.statements,
    ...[...deltas]
      .sort((left, right) => left.sequence - right.sequence || left.deltaId.localeCompare(right.deltaId))
      .flatMap(delta => [...delta.changes, ...delta.exceptions]),
  ];
  for (const statement of ordered) {
    for (const replaced of statement.supersedes) state.delete(replaced);
    state.set(statement.statementId, statement);
  }
  return [...state.values()];
}

function evidenceIndex(anchor: ContextAnchor, deltas: readonly ContextDelta[]): Map<string, EvidenceRef> {
  const index = new Map<string, EvidenceRef>();
  for (const ref of [...anchor.evidenceRefs, ...deltas.flatMap(delta => delta.evidenceRefs)]) {
    index.set(ref.evidenceId, ref);
  }
  return index;
}

/**
 * Pattern Folding v0.1:
 *   Context = Anchor + relevant Deltas + Exceptions + References.
 *
 * Token estimates are supplied by the caller; this layer never pretends its
 * own character count is a tokenizer. Required statements fail closed rather
 * than being silently truncated. Facts remain linked to external evidence.
 */
export function buildContextCapsule(input: BuildContextCapsuleInput): ContextCapsule {
  const anchor = contextAnchorSchema.parse(input.anchor);
  const deltas = (input.deltas ?? []).map(delta => contextDeltaSchema.parse(delta));
  const budget = contextBudgetSchema.parse(input.budget);
  if (!Number.isSafeInteger(input.objectiveEstimatedTokens) || input.objectiveEstimatedTokens < 0) {
    throw new RangeError("objectiveEstimatedTokens must be a non-negative safe integer.");
  }
  for (const delta of deltas) {
    if (delta.baseAnchorId !== anchor.anchorId) {
      throw new Error(`Delta ${delta.deltaId} does not belong to anchor ${anchor.anchorId}.`);
    }
  }

  const available = budget.maxTokens - budget.reserveTokens - input.objectiveEstimatedTokens;
  if (available < 0) {
    throw new ContextBudgetExceededError(input.objectiveEstimatedTokens, budget.maxTokens - budget.reserveTokens);
  }

  const statements = currentStatements(anchor, deltas);
  const required = statements.filter(statement => statement.required);
  const requiredTokens = required.reduce((total, statement) => total + statement.estimatedTokens, 0);
  if (requiredTokens > available || required.length > budget.maxStatements) {
    throw new ContextBudgetExceededError(requiredTokens, available);
  }

  let remaining = available - requiredTokens;
  let remainingSlots = budget.maxStatements - required.length;
  const selected = new Set(required.map(statement => statement.statementId));
  const optional = statements
    .filter(statement => !statement.required)
    .map((statement, index) => ({ statement, index }))
    .sort((left, right) =>
      right.statement.priority - left.statement.priority ||
      roleWeight(right.statement.role) - roleWeight(left.statement.role) ||
      left.index - right.index);

  for (const { statement } of optional) {
    if (remainingSlots <= 0) break;
    if (statement.estimatedTokens > remaining) continue;
    selected.add(statement.statementId);
    remaining -= statement.estimatedTokens;
    remainingSlots -= 1;
  }

  const included = statements.filter(statement => selected.has(statement.statementId));
  const evidence = evidenceIndex(anchor, deltas);
  const evidenceIds = new Set(included.flatMap(statement => statement.evidenceIds));
  const evidenceRefs = [...evidenceIds].map(evidenceId => {
    const ref = evidence.get(evidenceId);
    if (!ref) throw new Error(`Missing EvidenceRef ${evidenceId} required by selected context.`);
    return ref;
  });
  const estimatedTokens = input.objectiveEstimatedTokens +
    included.reduce((total, statement) => total + statement.estimatedTokens, 0);

  return contextCapsuleSchema.parse({
    version: CONTEXT_FABRIC_VERSION,
    anchorId: anchor.anchorId,
    deltaIds: deltas
      .sort((left, right) => left.sequence - right.sequence || left.deltaId.localeCompare(right.deltaId))
      .map(delta => delta.deltaId),
    objective: input.objective,
    statements: included,
    evidenceRefs,
    estimatedTokens,
    budget,
    omittedStatementIds: statements
      .filter(statement => !selected.has(statement.statementId))
      .map(statement => statement.statementId),
  });
}
