import * as z from 'zod/v4';
import { posix } from 'node:path';
import { PRIVATE_CREDENTIAL_DIRECTORIES } from './roots.js';

export const precisionModels = ['gpt-5.6-sol', 'gpt-6-astra'] as const;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const blockedParts = new Set([...PRIVATE_CREDENTIAL_DIRECTORIES, '.git', '.github', '.devspace', '.agents', '.claude']);
export function isPrecisionPath(path: string): boolean {
  return path.length > 0 && path.length <= 512 && !/[\\\x00-\x1f:]/.test(path) &&
    !posix.isAbsolute(path) && posix.normalize(path) === path && path !== '.' && !path.startsWith('../') &&
    !path.split('/').some(part => blockedParts.has(part.toLowerCase())) &&
    !/^(?:\.env(?:\.|$)|auth\.json$|credentials\.json$|secrets\.json$|id_rsa$|id_ed25519$)|\.(?:pem|key|p12|pfx|sqlite|db)$/i.test(posix.basename(path));
}
const file = z.string().refine(isPrecisionPath, 'Use one normalized workspace-relative non-private file path.');
const codeFile = file.refine(path => /\.(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rs|c|cc|cpp|h|hpp|java|kt|swift|cs|rb|php|sh|sql|css|scss|vue|svelte)$/i.test(path), 'precision_writer accepts explicit code files only.');
const expectedHashes = z.record(file, sha.nullable());
const scope = { allowedFiles: z.array(codeFile).min(1).max(8), expectedHashes };
function validateScope(value: {allowedFiles: string[]; expectedHashes: Record<string,string|null>}, ctx: z.RefinementCtx) {
  if (new Set(value.allowedFiles).size !== value.allowedFiles.length ||
    Object.keys(value.expectedHashes).length !== value.allowedFiles.length ||
    value.allowedFiles.some(path => !Object.hasOwn(value.expectedHashes, path))) {
    ctx.addIssue({ code: 'custom', message: 'allowedFiles must be unique and expectedHashes must cover exactly those files; null explicitly authorizes a new file.' });
  }
}
export const precisionWriterInputSchema = z.object({
  workspaceId: z.string().min(1), requestKey: z.string().min(1).max(160),
  prompt: z.string().trim().min(1).max(16000), model: z.enum(precisionModels).default('gpt-5.6-sol'),
  ...scope,
  contextFiles: z.array(z.object({ path: file, expectedSha256: sha }).strict()).max(8).default([]),
}).strict().superRefine((value, ctx) => {
  validateScope(value, ctx);
  const paths = [...value.allowedFiles, ...value.contextFiles.map(item => item.path)];
  if (new Set(paths).size !== paths.length) ctx.addIssue({ code: 'custom', message: 'Context and writable file paths must be unique and disjoint.' });
});
export const precisionApplyInputSchema = z.object({
  workspaceId: z.string().min(1), requestKey: z.string().min(1).max(160),
  agentId: z.string().min(1).max(160), candidateHash: sha, ...scope,
}).strict().superRefine(validateScope);
export type PrecisionWriterInput = z.output<typeof precisionWriterInputSchema>;
export type PrecisionApplyInput = z.output<typeof precisionApplyInputSchema>;
export const isPrecisionSubmission = (tool: string) => tool === 'precision_writer' || tool === 'precision_writer_apply';
export function parsePrecisionSubmission(tool: string, input: unknown) {
  return tool === 'precision_writer' ? precisionWriterInputSchema.parse(input) : precisionApplyInputSchema.parse(input);
}
