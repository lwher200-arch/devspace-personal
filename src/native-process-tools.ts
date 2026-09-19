import * as z from "zod/v4";
import type { NativeProcessSnapshot } from "./process-sessions.js";
import {
  candidateGrantFromMetadata,
  type CandidateExecutionEvidence,
  type CandidateExecutionPlan,
} from "./candidate-workspace/candidate-execution-coordinator.js";
import { resolveShellCommand } from "./process-platform.js";
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
    boundaryProfile: z.string().optional(),
    networkProfile: z.enum(["inherit", "none"]).optional(),
    wallTimeMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
    candidateExecution: z.object({
      candidateId: z.string(), profile: z.string(), networkProfile: z.literal("none"),
      state: z.enum(["running", "completed"]),
      mutation: z.object({
        created: z.array(z.string()), modified: z.array(z.string()), deleted: z.array(z.string()),
        createdCount: z.number().int().nonnegative(), modifiedCount: z.number().int().nonnegative(),
        deletedCount: z.number().int().nonnegative(), changedBytes: z.number().nonnegative(),
        stableChanged: z.boolean(), pathListTruncated: z.boolean(),
      }).optional(),
    }).optional(),
  });
}

function response(snapshot: NativeProcessSnapshot, candidateExecution?: CandidateExecutionEvidence) {
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
    structuredContent: { result, ...snapshot, ...(candidateExecution ? { candidateExecution } : {}) },
    isError: Boolean(snapshot.spawnError || snapshot.stdinError || snapshot.timedOut || snapshot.cancelled ||
      !snapshot.running && snapshot.exitCode !== 0),
  };
}

function nativeProcessLogFields(snapshot: NativeProcessSnapshot) {
  const failure = snapshot.spawnError
    ? `Process could not start (${snapshot.spawnError}).`
    : snapshot.stdinError
      ? `Stdin delivery failed (${snapshot.stdinError}).`
      : snapshot.timedOut
        ? "Total runtime timeout reached."
        : snapshot.cancelled
          ? "Cancellation requested."
          : !snapshot.running && snapshot.signal
            ? `Process exited after signal ${snapshot.signal}.`
            : !snapshot.running && snapshot.exitCode !== 0
              ? `Process exited with code ${snapshot.exitCode ?? "unknown"}.`
              : undefined;
  return {
    sessionId: snapshot.sessionId,
    running: snapshot.running,
    exitCode: snapshot.exitCode,
    signal: snapshot.signal,
    success: failure === undefined,
    error: failure,
    boundaryProfile: snapshot.boundaryProfile,
  };
}

/** Shared by both host surfaces; all executions belong to the existing process manager. */
export function registerNativeProcessTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces, processSessions, executionBoundary, candidateExecutionCoordinator } = context;
  server.registerTool("host_command", {
    title: "Run host maintenance command",
    description: "Run one shell command on the DevSpace host with the service OS account's authority. This is intended for explicit host maintenance and recovery such as systemctl, journalctl, ss, ps, networking and service diagnostics. It is not sandboxed; workspace validation selects only the initial working directory. Long work returns a native sessionId for process_status/process_cancel. Do not use this as a substitute for project file tools.",
    inputSchema: {
      workspaceId: z.string().describe(workspaceIdDescription),
      command: z.string().min(1).max(12_000).describe("Shell command to execute on the DevSpace host."),
      workingDirectory: z.string().optional().describe("Initial directory relative to the workspace root. Defaults to the workspace root."),
      timeoutMs: z.number().int().min(1).max(3_600_000).optional()
        .describe("Total runtime budget in milliseconds. Defaults to 60000; reaching it requests forced termination of the process tree."),
      ...waitAndOutput,
    },
    outputSchema: outputSchema(),
    annotations: SHELL_TOOL_ANNOTATIONS,
  }, async ({ workspaceId, command, workingDirectory, timeoutMs, yieldTimeMs, maxOutputTokens }) => {
    const snapshot = await runLoggedToolOperation(config, {
      tool: "host_command",
      workspaceId,
      workingDirectory: workingDirectory ?? ".",
      command,
      commandLength: command.length,
    }, performance.now(), async () => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
      const shell = resolveShellCommand(command);
      return processSessions.startProcess({
        workspaceId,
        executable: shell.executable,
        args: shell.args,
        cwd,
        workspaceRoot: workspace.root,
        timeoutMs,
        yieldTimeMs,
        maxOutputTokens,
      });
    }, nativeProcessLogFields);
    return response(snapshot);
  });

  server.registerTool("run_process", {
    title: "Run native process",
    description: executionBoundary
      ? `Run a native executable with literal argv and no shell parsing. Windows .cmd/.bat files are rejected. Execution is wrapped by workspace boundary ${executionBoundary.profile}: the host filesystem is read-only and only the selected workspace is writable; PID/UTS/IPC are isolated. Legacy approved execution inherits network; A2 Candidate execution uses the no-network profile. ${executionBoundary.filterEnvironment ? "Common credential and host-control environment variables are filtered before bounded execution." : "The configured boundary does not filter the inherited process environment."} Stdin is submitted once and closed, including when omitted. Long work returns a sessionId for process_status/process_cancel; it is the same execution and is not persisted across service restarts. Do not retry a start merely because a response is delayed.`
      : "Run a native executable with literal argv and no shell parsing. Windows .cmd/.bat files are rejected. No workspace execution boundary is configured for this server instance; the process runs with the service OS account's authority. Stdin is submitted once and closed, including when omitted. Long work returns a sessionId for process_status/process_cancel; it is the same execution and is not persisted across service restarts. Do not retry a start merely because a response is delayed.",
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
  }, async ({ workspaceId, workingDirectory, ...input }, extra) => {
    const value = await runLoggedToolOperation(config, { tool: "run_process", workspaceId,
      workingDirectory: workingDirectory ?? "." }, performance.now(), async () => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const stableCwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
      let plan: CandidateExecutionPlan | undefined;
      try {
        plan = await candidateExecutionCoordinator?.beginGrantedExecution({
          grantToken: candidateGrantFromMetadata(extra._meta),
          workspaceId,
          stableRoot: workspace.root,
          stableCwd,
          tool: "run_process",
        });
        const snapshot = await processSessions.startProcess({
          ...input,
          workspaceId,
          cwd: plan?.cwd ?? stableCwd,
          workspaceRoot: plan?.workspaceRoot ?? workspace.root,
          networkProfile: plan?.networkProfile,
          ...(executionBoundary ? { executionBoundary } : {}),
        });
        const candidateExecution = plan
          ? await candidateExecutionCoordinator!.observeSnapshot(plan, snapshot)
          : undefined;
        return { snapshot, candidateExecution };
      } catch (error) {
        if (plan) await candidateExecutionCoordinator?.abandon(plan);
        throw error;
      }
    }, item => nativeProcessLogFields(item.snapshot));
    return response(value.snapshot, value.candidateExecution);
  });

  const sessionInput = {
    workspaceId: z.string().describe("Workspace identifier used to start the native process."),
    sessionId: z.number().int().positive().describe("Running session identifier returned by run_process, host_command or process_status."),
    ...waitAndOutput,
  };
  server.registerTool("process_status", {
    title: "Read native process status",
    description: "Read and consume incremental output from a run_process or host_command session without sending input or restarting work. Defaults to a 5000 ms wait. Only native sessions owned by this workspace are accepted. Completed sessions are removed after their final read, or after five minutes unread; service restarts discard sessions.",
    inputSchema: sessionInput,
    outputSchema: outputSchema(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async input => {
    const value = await runLoggedToolOperation(config, { tool: "process_status", workspaceId: input.workspaceId },
      performance.now(), async () => {
        workspaces.getWorkspace(input.workspaceId);
        const snapshot = await processSessions.nativeStatus(input);
        const candidateExecution = await candidateExecutionCoordinator?.observeSession(
          input.workspaceId, input.sessionId, snapshot);
        return { snapshot, candidateExecution };
      }, item => nativeProcessLogFields(item.snapshot));
    return response(value.snapshot, value.candidateExecution);
  });

  server.registerTool("process_cancel", {
    title: "Cancel native process",
    description: "Request forced termination of one run_process or host_command session and its process tree, then read output and actual completion state. Defaults to a 250 ms wait. Only native sessions owned by this workspace are accepted. If running remains true, continue with process_status; cancellation does not imply the process has already exited.",
    inputSchema: sessionInput,
    outputSchema: outputSchema(),
    annotations: SHELL_TOOL_ANNOTATIONS,
  }, async input => {
    const value = await runLoggedToolOperation(config, { tool: "process_cancel", workspaceId: input.workspaceId },
      performance.now(), async () => {
        workspaces.getWorkspace(input.workspaceId);
        const snapshot = await processSessions.cancelNative(input);
        const candidateExecution = await candidateExecutionCoordinator?.observeSession(
          input.workspaceId, input.sessionId, snapshot);
        return { snapshot, candidateExecution };
      }, item => nativeProcessLogFields(item.snapshot));
    return response(value.snapshot, value.candidateExecution);
  });
}
