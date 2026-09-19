import * as z from "zod/v4";
import { applyPatch } from "../apply-patch.js";
import type { ProcessSnapshot } from "../process-sessions.js";
import {
  candidateGrantFromMetadata,
  type CandidateExecutionEvidence,
  type CandidateExecutionPlan,
} from "../candidate-workspace/candidate-execution-coordinator.js";
import {
  EDIT_TOOL_ANNOTATIONS,
  SHELL_TOOL_ANNOTATIONS,
  toolNames,
  workspaceIdDescription,
  type ToolRegistrationContext,
} from "./types.js";
import {
  contentText,
  resultOutputSchema,
  runLoggedToolOperation,
  textBlock,
} from "./shared.js";

type CodexRegistration = (context: ToolRegistrationContext) => void;

const CODEX_INSTRUCTIONS = `Use project_files and project_search for bounded project discovery, ${toolNames.read} for direct file reads, and project_read for exact paginated text with SHA-256. Follow continuation cursors and report coverage exclusions. Use apply_patch for all file modifications; prefer dryRun and expectedHashes covering every affected source and destination when editing shared files. Use exec_command for tests, builds, and other project commands, and write_stdin to poll or interact with running processes. Project shell commands use the configured workspace execution boundary when one is available; host maintenance remains a separate host_command capability. Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.`;

export function codexInstructions(): string {
  return CODEX_INSTRUCTIONS;
}

export function registerCodexTools(context: ToolRegistrationContext): void {
  for (const register of CODEX_REGISTRATIONS) {
    register(context);
  }
}

const CODEX_REGISTRATIONS: readonly CodexRegistration[] = [
  registerApplyPatchTool,
  registerCodexProcessTools,
];

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId}.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return snapshot.output
    ? `${snapshot.output.replace(/\n$/, "")}\n${status}`
    : status;
}

function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    sessionId: z.number().optional(),
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    boundaryProfile: z.string().optional(),
    networkProfile: z.enum(["inherit", "none"]).optional(),
    wallTimeMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
    candidateExecution: candidateExecutionSchema().optional(),
  });
}

function candidateExecutionSchema() {
  return z.object({
    candidateId: z.string(),
    profile: z.string(),
    networkProfile: z.literal("none"),
    state: z.enum(["running", "completed"]),
    mutation: z.object({
      created: z.array(z.string()),
      modified: z.array(z.string()),
      deleted: z.array(z.string()),
      createdCount: z.number().int().nonnegative(),
      modifiedCount: z.number().int().nonnegative(),
      deletedCount: z.number().int().nonnegative(),
      changedBytes: z.number().nonnegative(),
      stableChanged: z.boolean(),
      pathListTruncated: z.boolean(),
    }).optional(),
  });
}

function processToolResponse(snapshot: ProcessSnapshot, candidateExecution?: CandidateExecutionEvidence) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  return {
    content,
    structuredContent: {
      result,
      sessionId: snapshot.sessionId,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      boundaryProfile: snapshot.boundaryProfile,
      networkProfile: snapshot.networkProfile,
      wallTimeMs: snapshot.wallTimeMs,
      outputTruncated: snapshot.outputTruncated,
      ...(candidateExecution ? { candidateExecution } : {}),
    },
  };
}

function processLogFields(snapshot: ProcessSnapshot) {
  const failed = !snapshot.running && (snapshot.signal !== undefined || snapshot.exitCode !== 0);
  return {
    sessionId: snapshot.sessionId,
    running: snapshot.running,
    exitCode: snapshot.exitCode,
    signal: snapshot.signal,
    boundaryProfile: snapshot.boundaryProfile,
    success: !failed,
    error: failed
      ? snapshot.signal
        ? `Process exited after signal ${snapshot.signal}.`
        : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`
      : undefined,
  };
}

function registerApplyPatchTool(context: ToolRegistrationContext): void {
  const { server, config, workspaces } = context;

  server.registerTool(
    "apply_patch",
    {
      title: "Apply patch",
      description:
        "Apply one Codex-style patch in a workspace. Supports adding, overwriting, updating, deleting, and moving files. Use this for all file modifications. Paths must be relative to the workspace. Prefer dryRun and expectedHashes to detect stale content before edits. Preflight is not an OS-atomic multi-file transaction; inspect state if a filesystem write fails.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        patch: z
          .string()
          .describe(
            "Patch text enclosed by *** Begin Patch and *** End Patch markers.",
          ),
        dryRun: z.boolean().optional().describe("Validate and preview the patch without writing. Defaults to false."),
        expectedHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/).nullable()).optional()
          .describe("If provided, cover every affected source and destination. Use SHA-256 from project_read, or null if the path must not exist. Any mismatch rejects before writes."),
      },
      outputSchema: resultOutputSchema({
        additions: z.number(),
        removals: z.number(),
        dryRun: z.boolean(),
        files: z.array(
          z.object({
            path: z.string(),
            previousPath: z.string().optional(),
            operation: z.enum(["add", "update", "delete", "move"]),
          }),
        ),
      }),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, patch, dryRun, expectedHashes }) => {
      const startedAt = performance.now();
      const applied = await runLoggedToolOperation(
        config,
        { tool: "apply_patch", workspaceId },
        startedAt,
        async () => {
          const workspace = workspaces.getWorkspace(workspaceId);
          return applyPatch(workspace.root, patch, { dryRun, expectedHashes });
        },
      );
      const paths = applied.files.map((file) => file.path).join(", ");
      const result = `${applied.dryRun ? "Validated (not applied)" : "Applied"} patch to ${applied.files.length} file(s): ${paths}`;
      const content = [textBlock(result)];

      return {
        content,
        structuredContent: {
          result,
          additions: applied.additions,
          removals: applied.removals,
          dryRun: applied.dryRun,
          files: applied.files,
        },
      };
    },
  );
}

function registerCodexProcessTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces, processSessions, executionBoundary, candidateExecutionCoordinator } = context;

  server.registerTool(
    "exec_command",
    {
      title: "Execute command",
      description: executionBoundary
        ? `Run a project shell command through workspace boundary ${executionBoundary.profile}. The host filesystem is read-only and only the selected workspace is writable; PID/UTS/IPC are isolated. Legacy approved execution inherits network; A2 Candidate execution uses the no-network profile. Common credential/control environment variables are filtered when supported by the boundary. Returns the result when it exits during the yield window, otherwise returns a sessionId for write_stdin.`
        : "Run a project shell command. No workspace execution boundary is configured for this server instance, so the shell uses the service OS account authority. Returns the result when it exits during the yield window, otherwise returns a sessionId for write_stdin.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        cmd: z.string().min(1).describe("Shell command to execute."),
        tty: z
          .boolean()
          .optional()
          .describe(
            "Allocate a pseudo-terminal for interactive commands. Defaults to false.",
          ),
        columns: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Initial PTY width. Defaults to 80."),
        rows: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Initial PTY height. Defaults to 24."),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe(
            "Milliseconds to wait before returning a running session. Defaults to 10000.",
          ),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({
      workspaceId,
      cmd,
      tty,
      columns,
      rows,
      workingDirectory,
      yieldTimeMs,
      maxOutputTokens,
    }, extra) => {
      const startedAt = performance.now();
      const snapshot = await runLoggedToolOperation(
        config,
        {
          tool: "exec_command",
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: cmd,
          commandLength: cmd.length,
        },
        startedAt,
        async () => {
          const workspace = workspaces.getWorkspace(workspaceId);
          const stableCwd = workspaces.resolveWorkingDirectory(
            workspace,
            workingDirectory,
          );
          let plan: CandidateExecutionPlan | undefined;
          try {
            plan = await candidateExecutionCoordinator?.beginGrantedExecution({
              grantToken: candidateGrantFromMetadata(extra._meta),
              workspaceId,
              stableRoot: workspace.root,
              stableCwd,
              tool: "exec_command",
            });
            const snapshot = await processSessions.start({
              workspaceId,
              command: cmd,
              cwd: plan?.cwd ?? stableCwd,
              workspaceRoot: plan?.workspaceRoot ?? workspace.root,
              tty,
              columns,
              rows,
              yieldTimeMs,
              maxOutputTokens,
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
        },
        (value) => processLogFields(value.snapshot),
      );

      return processToolResponse(snapshot.snapshot, snapshot.candidateExecution);
    },
  );

  server.registerTool(
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Poll or write characters to a process returned by exec_command. Omit chars or pass an empty string to poll. Pass \\u0003 to send Ctrl-C.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier used to start the process."),
        sessionId: z
          .number()
          .describe("Process session identifier returned by exec_command."),
        chars: z
          .string()
          .optional()
          .describe(
            "Characters to write. Omit or pass an empty string to poll.",
          ),
        columns: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Resize a PTY to this width."),
        rows: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Resize a PTY to this height."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe(
            "Milliseconds to wait for process output or completion. Defaults to 10000.",
          ),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({
      workspaceId,
      sessionId,
      chars,
      columns,
      rows,
      yieldTimeMs,
      maxOutputTokens,
    }) => {
      const startedAt = performance.now();
      const value = await runLoggedToolOperation(
        config,
        { tool: "write_stdin", workspaceId },
        startedAt,
        async () => {
          workspaces.getWorkspace(workspaceId);
          const snapshot = await processSessions.write({
            workspaceId,
            sessionId,
            chars,
            columns,
            rows,
            yieldTimeMs,
            maxOutputTokens,
          });
          const candidateExecution = await candidateExecutionCoordinator?.observeSession(
            workspaceId,
            sessionId,
            snapshot,
          );
          return { snapshot, candidateExecution };
        },
        (item) => processLogFields(item.snapshot),
      );

      return processToolResponse(value.snapshot, value.candidateExecution);
    },
  );
}
