import * as z from "zod/v4";
import { projectFiles, projectRead, projectSearch, readProjectRequest } from "./project-access.js";
import { projectReadBatch, projectReadBatchInputSchema } from "./project-read-batch.js";
import { applyPatch } from "./apply-patch.js";
import { resultOutputSchema, runLoggedToolOperation, textBlock } from "./tool-surfaces/shared.js";
import { workspaceIdDescription, type ToolRegistrationContext } from "./tool-surfaces/types.js";

type CliValues = Record<string, string | number | boolean>;

type ProjectToolDefinition = {
  command: "files" | "search" | "read" | "read-batch";
  toolName: "project_files" | "project_search" | "project_read" | "project_read_batch";
  description: string;
  inputSchema: z.ZodObject;
  cliInput(root: string, values: CliValues): Promise<unknown>;
  execute(root: string, input: unknown): Promise<unknown>;
};

const discoveryInputSchema = z.object({
  path: z.string().optional().describe("Workspace-relative directory. Defaults to the whole project; narrow it if coverage is incomplete."),
  cursor: z.string().optional().describe("Opaque nextCursor from the same operation and scope; never invent or edit it."),
  limit: z.number().int().min(1).max(100).optional(),
  includeIgnored: z.boolean().optional().describe("Scan Git-ignored files too. Prefer a narrow path; dependency, credential and symlink exclusions still apply."),
}).strict();

const projectFilesInputSchema = discoveryInputSchema.extend({
  limit: z.number().int().min(1).max(500).optional(),
}).strict();

const projectSearchInputSchema = discoveryInputSchema.extend({
  query: z.string().min(1).max(1000),
}).strict();

const projectReadInputSchema = z.object({
  path: z.string(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(2).max(20000).optional(),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

const requestFileInputSchema = z.object({ requestFile: z.string() }).strict();
const directCliInput = async (_root: string, values: CliValues): Promise<unknown> => values;

export const projectToolCatalog: readonly ProjectToolDefinition[] = [
  {
    command: "files",
    toolName: "project_files",
    description: "List the complete eligible project file inventory in bounded pages, including untracked files. Follow nextCursor and check coverage.complete. Dependencies, generated output, likely credential filenames and junctions are excluded and reported. This lists paths, not file contents.",
    inputSchema: projectFilesInputSchema,
    cliInput: directCliInput,
    execute: async (root, input) => projectFiles(root, projectFilesInputSchema.parse(input)),
  },
  {
    command: "search",
    toolName: "project_search",
    description: "Search project UTF-8 text using a case-sensitive literal, not a shell or regex. Returns paths, line numbers and bounded snippets. Continue nextCursor even on empty pages; inspect skipped files and coverage before claiming complete coverage.",
    inputSchema: projectSearchInputSchema,
    cliInput: directCliInput,
    execute: async (root, input) => projectSearch(root, projectSearchInputSchema.parse(input)),
  },
  {
    command: "read",
    toolName: "project_read",
    description: "Read exact UTF-8 content in character pages with SHA-256, including very long lines. Follow nextOffset and supply expectedSha256 from the first page to detect changed files. Offset is a zero-based UTF-16 character position, not a line number. Read relevant project instructions first. Binary or over-8-MiB files require a format-specific reader. Use the hash with apply_patch expectedHashes for guarded edits.",
    inputSchema: projectReadInputSchema,
    cliInput: directCliInput,
    execute: async (root, input) => projectRead(root, projectReadInputSchema.parse(input)),
  },
  {
    command: "read-batch",
    toolName: "project_read_batch",
    description: "Read one to eight UTF-8 project files in request order using project_read character offsets and SHA-256. All paths are checked before any body is read. maxResultBytes bounds the complete result JSON in UTF-8, including metadata, escaping and continuation. Follow continuation.items with the supplied hashes; inspect per-item errors separately. Each file is observed separately, not an atomic snapshot. Read applicable project instructions first.",
    inputSchema: projectReadBatchInputSchema,
    cliInput: async (root, values) => {
      const options = requestFileInputSchema.parse(values);
      return readProjectRequest(root, options.requestFile);
    },
    execute: async (root, input) => projectReadBatch(root, projectReadBatchInputSchema.parse(input)),
  },
];

export function registerProjectTools({ server, config, workspaces }: ToolRegistrationContext): void {
  const scope = { workspaceId: z.string().describe(workspaceIdDescription) };
  const response = async (name: string, workspaceId: string, action: (root: string) => Promise<unknown>) => {
    const data = await runLoggedToolOperation(config, { tool: name, workspaceId }, performance.now(),
      () => action(workspaces.getWorkspace(workspaceId).root));
    const result = JSON.stringify(data);
    return { content: [textBlock(result)], structuredContent: { result } };
  };
  for (const tool of projectToolCatalog) {
    server.registerTool(tool.toolName, {
      description: tool.description,
      inputSchema: { ...scope, ...tool.inputSchema.shape },
      outputSchema: resultOutputSchema(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, ({ workspaceId, ...input }) => response(tool.toolName, workspaceId, root => tool.execute(root, input)));
  }
}

export async function runProjectCommand(root: string, args: string[]): Promise<unknown> {
  const [command, ...flags] = args;
  const values: CliValues = {};
  const names: Record<string, string> = { "--path": "path", "--query": "query", "--cursor": "cursor",
    "--offset": "offset", "--limit": "limit", "--expected-sha256": "expectedSha256", "--request-file": "requestFile" };
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--json") continue;
    if (flags[i] === "--include-ignored") { values.includeIgnored = true; continue; }
    if (flags[i] === "--dry-run") { values.dryRun = true; continue; }
    const key = names[flags[i]];
    if (!key || flags[i + 1] === undefined || key in values) throw new Error("Unknown, duplicate, or incomplete project option.");
    const value = flags[++i];
    values[key] = key === "limit" || key === "offset" ? Number(value) : value;
  }
  const tool = projectToolCatalog.find((tool) => tool.command === command);
  if (tool) return tool.execute(root, await tool.cliInput(root, values));
  if (command === "patch") {
    const options = z.object({ requestFile: z.string(), dryRun: z.boolean().optional() }).strict().parse(values);
    const request = z.object({ patch: z.string().min(1), expectedHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/).nullable()) })
      .strict().parse(await readProjectRequest(root, options.requestFile));
    const result = await applyPatch(root, request.patch, { expectedHashes: request.expectedHashes, dryRun: options.dryRun });
    // Keep command output bounded; the full diff is available through show_changes.
    return { files: result.files, additions: result.additions, removals: result.removals, dryRun: result.dryRun };
  }
  throw new Error("Usage: devspace project <files|search|read|read-batch|patch> [--path relative-path] [--query literal] [--cursor token] [--offset n] [--limit n] [--expected-sha256 hash] [--include-ignored] [--request-file path --dry-run] [--json]");
}
