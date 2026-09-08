import * as z from "zod/v4";
import { projectRead, validateProjectReadPaths } from "./project-access.js";

export const projectReadBatchInputSchema = z.object({
  items: z.array(z.object({
    path: z.string().min(1).describe("Workspace-relative UTF-8 file path."),
    offset: z.number().int().nonnegative().optional().describe("Zero-based UTF-16 character offset, as in project_read."),
    limit: z.number().int().min(2).max(20000).optional().describe("Maximum characters for this file page; defaults to 12000."),
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("SHA-256 from the first page; retain it for continuation."),
  }).strict()).min(1).max(8).describe("One to eight file requests, returned in this order."),
  maxResultBytes: z.number().int().min(8192).max(262144).optional()
    .describe("UTF-8 byte budget for the serialized result object, including metadata and continuation; defaults to 65536. MCP envelope framing is separate."),
}).strict();

export type ProjectReadBatchInput = z.infer<typeof projectReadBatchInputSchema>;
type ReadItem = ProjectReadBatchInput["items"][number];
type ReadPage = Awaited<ReturnType<typeof projectRead>>;
type Success = ReadPage & { index: number; status: "ok" };
type Failure = {
  index: number;
  path: string;
  status: "error";
  error: { code: string; message: string; recovery?: ReadItem };
};
type ReadResult = Success | Failure;

function failedRead(index: number, item: ReadItem, error: unknown): Failure {
  const message = error instanceof Error ? error.message : "File could not be read.";
  const errno = (error as NodeJS.ErrnoException | undefined)?.code;
  const hashChanged = /File hash changed/.test(message);
  const code = hashChanged ? "HASH_MISMATCH"
    : errno === "ENOENT" || errno === "ENOTDIR" ? "NOT_FOUND"
    : errno === "EACCES" || errno === "EPERM" ? "ACCESS_DENIED"
    : /binary|not valid UTF-8|8 MiB|Not a regular file/.test(message) ? "UNSUPPORTED_FILE"
    : /Invalid character offset/.test(message) ? "INVALID_OFFSET"
    : /changed/.test(message) ? "FILE_CHANGED" : "READ_FAILED";
  return {
    index, path: item.path, status: "error",
    error: { code, message: message.slice(0, 500),
      ...(hashChanged ? { recovery: { path: item.path, offset: 0, limit: item.limit } } : {}) },
  };
}

function continuation(item: ReadItem, page: ReadPage): ReadItem[] {
  return page.complete ? [] : [{ ...item, offset: page.nextOffset!, expectedSha256: page.sha256 }];
}

/** The budget covers this complete JSON result, including escapes and continuation requests. */
export async function projectReadBatch(root: string, input: ProjectReadBatchInput) {
  const { items, maxResultBytes = 65536 } = projectReadBatchInputSchema.parse(input);
  // Validate every path before reading any body. MCP authorization separately classifies
  // every item for protected-file approval; batching must not weaken either boundary.
  validateProjectReadPaths(root, items.map(item => item.path));
  const results: ReadResult[] = [];
  const unfinished: ReadItem[] = [];
  const response = (rows: ReadResult[], pending: ReadItem[]) => {
    const hasErrors = rows.some(row => row.status === "error");
    return {
      results: rows,
      complete: pending.length === 0 && !hasErrors,
      hasErrors,
      snapshot: "per-file" as const,
      ...(pending.length ? { continuation: { items: pending, maxResultBytes } } : {}),
      instruction: "Each file is observed separately, not an atomic project snapshot. Follow continuation with its hashes. Errors require separate recovery; HASH_MISMATCH recovery starts a new observation before editing.",
    };
  };
  const fits = (value: ReturnType<typeof response>) => Buffer.byteLength(JSON.stringify(value), "utf8") <= maxResultBytes;
  let current = response([], items);
  if (!fits(current)) throw new Error("Batch request metadata exceeds maxResultBytes; shorten the batch or increase the result budget.");

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    let row: ReadResult;
    try { row = { index, status: "ok", ...await projectRead(root, item) }; }
    catch (error) { row = failedRead(index, item, error); }
    const remaining = items.slice(index + 1);
    const pendingFor = (value: ReadResult) => [...unfinished,
      ...(value.status === "ok" ? continuation(item, value) : []), ...remaining];
    const candidate = response([...results, row], pendingFor(row));
    if (fits(candidate)) {
      results.push(row);
      if (row.status === "ok") unfinished.push(...continuation(item, row));
      current = candidate;
      continue;
    }

    if (row.status === "ok" && row.text.length > 0) {
      // Shrink only the projection, preserving the observed hash and original UTF-16
      // offsets. Binary search includes metadata and JSON escaping in every trial.
      let low = 1;
      let high = row.text.length - 1;
      let best: ReturnType<typeof response> | undefined;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        let length = middle;
        if (/[\uD800-\uDBFF]/.test(row.text[length - 1])) length--;
        const partial: Success = { ...row, text: row.text.slice(0, length), complete: false,
          nextOffset: row.offset + length };
        const projected = response([...results, partial], pendingFor(partial));
        if (fits(projected)) {
          if (length > 0) best = projected;
          low = middle + 1;
        } else high = middle - 1;
      }
      if (best) return best;
    }
    if (results.length > 0) return current;
    throw new Error("The first result cannot fit maxResultBytes; shorten the batch or increase the result budget.");
  }
  return current;
}
