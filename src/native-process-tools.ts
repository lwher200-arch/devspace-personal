import * as z from "zod/v4";
import type { NativeProcessSnapshot } from "./process-sessions.js";
import { resultOutputSchema, runLoggedToolOperation, textBlock } from "./tool-surfaces/shared.js";
import { SHELL_TOOL_ANNOTATIONS, workspaceIdDescription, type ToolRegistrationContext } from "./tool-surfaces/types.js";

const waitAndOutput = {
  yieldTimeMs: z.number().int().min(0).max(30_000).optional()
    .describe("Milliseconds to wait for this same execution before returning. This does not extend its total timeout."),
  maxOutputTokens: z.number().int().min(1).max(100_000).optional()
    .describe("Approximate output token budget. Defaults to 10000; omitted output is marked as truncated."),
};

function outputSchema() {
  return resultOutputSchema({
    executionId: z.string(),
    sessionId: z.number().int().optional(),
    cwd: z.string(),
    output: z.string(),
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    timedOut: z.boolean(),
    cancelled: z.boolean(),
    spawnError: z.string().optional(),
    stdinError: z.string().optional(),
    wallTimeMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
  });
}

function response(snapshot: NativeProcessSnapshot) {
  const state = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId}; use process_status for the same execution.`
    : snapshot.spawnError
      ? `Process could not start (${snapshot.spawnError}).`
      : snapshot.signal
        ? `Process exited after signal ${snapshot.signal}.`
        : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  const details = [state,
    ...(snapshot.timedOut ? ["Total runtime timeout reached; process tree termination requested."] : []),
    ...(snapshot.cancelled ? ["Cancellation requested."] : []),
    ...(snapshot.stdinError ? [`Stdin delivery failed (${snapshot.stdinError}).`] : []),
  ].join(" ");
  const result = snapshot.output ? `${snapshot.output.replace(/\n$/, "")}\n${details}` : details;
  return {
    content: [textBlock(result)],
    structuredContent: { result, ...snapshot },
    isError: Boolean(snapshot.spawnError || snapshot.stdinError || snapshot.timedOut || snapshot.cancelled ||
      !snapshot.running && snapshot.exitCode !== 0),
  };
}

/** Shared by both host surfaces; all executions belong to the existing process manager. */
export function registerNativeProcessTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces, processSessions } = context;
  server.registerTool("run_process", {
    title: "Run native process",
    description: "Run a native executable with literal argv and no shell parsing. Windows .cmd/.bat files are rejected. Runs with the service OS account's authority, without a filesystem or network sandbox; workspace validation selects only the initial working directory. Stdin is submitted once and closed, including when omitted. Long work returns a sessionId for process_status/process_cancel; it is the same execution and is not persisted across service restarts. Do not retry a start merely because a response is delayed.",
    inputSchema: {
      workspaceId: z.string().describe(workspaceIdDescription),
      executable: z.string().min(1).max(1_024).describe("Native executable name or path. No shell quoting or expansion is applied."),
      args: z.array(z.string().max(8_192)).max(256).optional()
        .describe("Ordered literal argv values, including empty strings. Executable and arguments together are limited to 16000 UTF-8 bytes including boundaries."),
      stdin: z.string().max(65_536).optional().describe("Initial stdin payload, limited to 65536 UTF-8 bytes; the pipe is then closed."),
      workingDirectory: z.string().optional().describe("Directory relative to the workspace root. Defaults to the root."),
      timeoutMs: z.number().int().min(1).max(3_600_000).optional()
        .describe("Total runtime budget in milliseconds. Defaults to 60000; reaching it requests forced termination of the process tree."),
      ...waitAndOutput,
    },
    outputSchema: outputSchema(),
    annotations: SHELL_TOOL_ANNOTATIONS,
  }, async ({ workspaceId, workingDirectory, ...input }) => {
    const snapshot = await runLoggedToolOperation(config, { tool: "run_process", workspaceId,
      workingDirectory: workingDirectory ?? "." }, performance.now(), async () => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
      return processSessions.startProcess({ ...input, workspaceId, cwd, workspaceRoot: workspace.root });
    });
    return response(snapshot);
  });

  const sessionInput = {
    workspaceId: z.string().describe("Workspace identifier used to start the native process."),
    sessionId: z.number().int().positive().describe("Running session identifier returned by run_process or process_status."),
    ...waitAndOutput,
  };
  server.registerTool("process_status", {
    title: "Read native process status",
    description: "Read and consume incremental output from a run_process session without sending input or restarting work. Defaults to a 5000 ms wait. Only sessions owned by this workspace and started by run_process are accepted. Completed sessions are removed after their final read, or after five minutes unread; service restarts discard sessions.",
    inputSchema: sessionInput,
    outputSchema: outputSchema(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async input => {
    const snapshot = await runLoggedToolOperation(config, { tool: "process_status", workspaceId: input.workspaceId },
      performance.now(), async () => {
        workspaces.getWorkspace(input.workspaceId);
        return processSessions.nativeStatus(input);
      });
    return response(snapshot);
  });

  server.registerTool("process_cancel", {
    title: "Cancel native process",
    description: "Request forced termination of one run_process session and its process tree, then read output and actual completion state. Defaults to a 250 ms wait. Only native sessions owned by this workspace are accepted. If running remains true, continue with process_status; cancellation does not imply the process has already exited.",
    inputSchema: sessionInput,
    outputSchema: outputSchema(),
    annotations: SHELL_TOOL_ANNOTATIONS,
  }, async input => {
    const snapshot = await runLoggedToolOperation(config, { tool: "process_cancel", workspaceId: input.workspaceId },
      performance.now(), async () => {
        workspaces.getWorkspace(input.workspaceId);
        return processSessions.cancelNative(input);
      });
    return response(snapshot);
  });
}
