import * as z from "zod/v4";
import { projectFiles, projectRead, projectSearch, readProjectRequest } from "./project-access.js";
import { applyPatch } from "./apply-patch.js";
import { resultOutputSchema, runLoggedToolOperation, textBlock } from "./tool-surfaces/shared.js";
import { workspaceIdDescription, type ToolRegistrationContext } from "./tool-surfaces/types.js";

export function registerProjectTools({ server, config, workspaces }: ToolRegistrationContext): void {
  const scope = { workspaceId: z.string().describe(workspaceIdDescription) };
  const discovery = {
    path: z.string().optional().describe("Workspace-relative directory. Defaults to the whole project; narrow it if coverage is incomplete."),
    cursor: z.string().optional().describe("Opaque nextCursor from the same operation and scope; never invent or edit it."),
    limit: z.number().int().min(1).max(100).optional(),
    includeIgnored: z.boolean().optional().describe("Scan Git-ignored files too. Prefer a narrow path; dependency, credential and symlink exclusions still apply."),
  };
  const response = async (name: string, workspaceId: string, action: (root: string) => Promise<unknown>) => {
    const data = await runLoggedToolOperation(config, { tool: name, workspaceId }, performance.now(),
      () => action(workspaces.getWorkspace(workspaceId).root));
    const result = JSON.stringify(data);
    return { content: [textBlock(result)], structuredContent: { result } };
  };
  server.registerTool("project_files", {
    description: "List the complete eligible project file inventory in bounded pages, including untracked files. Follow nextCursor and check coverage.complete. Dependencies, generated output, likely credential filenames and junctions are excluded and reported. This lists paths, not file contents.",
    inputSchema: { ...scope, ...discovery, limit: z.number().int().min(1).max(500).optional() },
    outputSchema: resultOutputSchema(), annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ workspaceId, ...input }) => response("project_files", workspaceId, root => projectFiles(root, input)));
  server.registerTool("project_search", {
    description: "Search project UTF-8 text using a case-sensitive literal, not a shell or regex. Returns paths, line numbers and bounded snippets. Continue nextCursor even on empty pages; inspect skipped files and coverage before claiming complete coverage.",
    inputSchema: { ...scope, ...discovery, query: z.string().min(1).max(1000) },
    outputSchema: resultOutputSchema(), annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ workspaceId, ...input }) => response("project_search", workspaceId, root => projectSearch(root, input)));
  server.registerTool("project_read", {
    description: "Read exact UTF-8 content in character pages with SHA-256, including very long lines. Follow nextOffset and supply expectedSha256 from the first page to detect changed files. Offset is a zero-based UTF-16 character position, not a line number. Read relevant project instructions first. Binary or over-8-MiB files require a format-specific reader. Use the hash with apply_patch expectedHashes for guarded edits.",
    inputSchema: { ...scope, path: z.string(), offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(2).max(20000).optional(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() },
    outputSchema: resultOutputSchema(), annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ workspaceId, ...input }) => response("project_read", workspaceId, root => projectRead(root, input)));
}

export async function runProjectCommand(root: string, args: string[]): Promise<unknown> {
  const [command, ...flags] = args;
  const values: Record<string, string | number | boolean> = {};
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
  const discovery = z.object({ path: z.string().optional(), cursor: z.string().optional(), limit: z.number().optional(), includeIgnored: z.boolean().optional() });
  if (command === "files") return projectFiles(root, discovery.strict().parse(values));
  if (command === "search") return projectSearch(root, discovery.extend({ query: z.string() }).strict().parse(values));
  if (command === "read") return projectRead(root, z.object({ path: z.string(), offset: z.number().optional(),
    limit: z.number().optional(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(values));
  if (command === "patch") {
    const options = z.object({ requestFile: z.string(), dryRun: z.boolean().optional() }).strict().parse(values);
    const request = z.object({ patch: z.string().min(1), expectedHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/).nullable()) })
      .strict().parse(await readProjectRequest(root, options.requestFile));
    const result = await applyPatch(root, request.patch, { expectedHashes: request.expectedHashes, dryRun: options.dryRun });
    // Keep command output bounded; the full diff is available through show_changes.
    return { files: result.files, additions: result.additions, removals: result.removals, dryRun: result.dryRun };
  }
  throw new Error("Usage: devspace project <files|search|read|patch> [--path relative-path] [--query literal] [--cursor token] [--offset n] [--limit n] [--expected-sha256 hash] [--include-ignored] [--request-file path --dry-run] [--json]");
}
