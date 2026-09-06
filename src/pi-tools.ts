import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type BashToolInput,
  type EditToolInput,
  type EditToolDetails,
  type ReadToolInput,
  type WriteToolInput,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { AccessDeniedError, assertAllowedPath, canonicalAllowedPath, resolveAllowedPath } from "./roots.js";

// Pi's detector is not exported publicly. Keep its pinned image behavior while
// checking the final normalized path at each actual filesystem operation.
const imageDetector = import(new URL("./utils/mime.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as
  Promise<{ detectSupportedImageMimeTypeFromFile(path: string): Promise<string | null> }>;

function pathGuard(roots: string[]): (path: string) => string {
  const pinned = roots.map((root) => ({ root, physical: canonicalAllowedPath(root) }));
  return (path) => {
    const unchanged = pinned.filter(({ root, physical }) => canonicalAllowedPath(root) === physical);
    if (!unchanged.length) throw new AccessDeniedError("Allowed root changed its filesystem target during the request.");
    return canonicalAllowedPath(assertAllowedPath(path, unchanged.map(({ root }) => root)));
  };
}

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResponse<TDetails = unknown> = {
  content: McpContent[];
  details?: TDetails;
  isError?: boolean;
};

interface ToolContext {
  cwd: string;
  root: string;
  readRoots?: string[];
}

function toMcpContent(result: AgentToolResult<unknown>): McpContent[] {
  return result.content.map((content) => {
    if (content.type === "text") {
      return { type: "text", text: content.text };
    }

    return {
      type: "image",
      data: content.data,
      mimeType: content.mimeType,
    };
  });
}

function formatToolError(error: unknown): McpContent[] {
  const message = error instanceof Error ? error.message : String(error);
  return [{ type: "text", text: message }];
}

async function runTool<TInput, TDetails = unknown>(
  execute: (input: TInput) => Promise<AgentToolResult<TDetails>>,
  input: TInput,
  context: ToolContext,
): Promise<ToolResponse<TDetails>> {
  try {
    const result = await execute(input);
    return {
      content: toMcpContent(result),
      details: result.details,
    };
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
}

export async function readFileTool(input: ReadToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, context.readRoots ?? [context.root]);
  const roots = context.readRoots ?? [context.root];
  const guardedPath = pathGuard(roots);
  const tool = createReadTool(context.cwd, { operations: {
    readFile: (file) => readFile(guardedPath(file)),
    access: (file) => access(guardedPath(file), constants.R_OK),
    detectImageMimeType: async (file) => (await imageDetector).detectSupportedImageMimeTypeFromFile(guardedPath(file)),
  } });

  return runTool((params) => tool.execute("read_file", params), {
    path,
    offset: input.offset,
    limit: input.limit,
  }, context);
}

export async function writeFileTool(input: WriteToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
  const guardedPath = pathGuard([context.root]);
  const tool = createWriteTool(context.cwd, { operations: {
    writeFile: (file, content) => writeFile(guardedPath(file), content, "utf8"),
    mkdir: async (directory) => { await mkdir(guardedPath(directory), { recursive: true }); },
  } });

  return runTool((params) => tool.execute("write_file", params), {
    path,
    content: input.content,
  }, context);
}

export async function editFileTool(input: EditToolInput, context: ToolContext): Promise<ToolResponse<EditToolDetails>> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
  const guardedPath = pathGuard([context.root]);
  const tool = createEditTool(context.cwd, { operations: {
    readFile: (file) => readFile(guardedPath(file)),
    writeFile: (file, content) => writeFile(guardedPath(file), content, "utf8"),
    access: (file) => access(guardedPath(file), constants.R_OK | constants.W_OK),
  } });

  return runTool((params) => tool.execute("edit_file", params), {
    path,
    edits: input.edits,
  }, context);
}

export async function runShellTool(input: BashToolInput, context: ToolContext): Promise<ToolResponse> {
  const tool = createBashTool(context.cwd);
  const timeout = input.timeout === undefined ? 30 : Math.min(input.timeout, 300);

  return runTool((params) => tool.execute("run_shell", params), {
    command: input.command,
    timeout,
  }, context);
}
