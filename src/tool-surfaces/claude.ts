import * as z from "zod/v4";
import {
  editFileTool,
  writeFileTool,
} from "../pi-tools.js";
import type { ProcessSnapshot } from "../process-sessions.js";
import {
  candidateGrantFromMetadata,
  type CandidateExecutionEvidence,
  type CandidateExecutionPlan,
} from "../candidate-workspace/candidate-execution-coordinator.js";
import {
  EDIT_TOOL_ANNOTATIONS,
  SHELL_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  toolNames,
  workspaceIdDescription,
  type ToolInstructionContext,
  type ToolRegistrationContext,
} from "./types.js";
import {
  contentText,
  countDiffStats,
  logFailedToolResponse,
  logToolCall,
  resultOutputSchema,
  textBlock,
} from "./shared.js";

const CLAUDE_INSTRUCTIONS = `Use ${toolNames.read} for direct file reads, ${toolNames.edit} for targeted modifications, ${toolNames.write} only for new files or complete rewrites, and ${toolNames.shell} for inspection, tests, builds, and other project commands. Project shell commands use the configured workspace execution boundary when one is available; host maintenance remains a separate host_command capability. Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.`;

export function claudeInstructions({
  agents,
  skills,
}: ToolInstructionContext): string {
  return `${agents}${skills}${CLAUDE_INSTRUCTIONS}`;
}

export function registerClaudeTools(context: ToolRegistrationContext): void {
  registerClaudeMutationTools(context);
  registerShellTool(context);
}

function registerClaudeMutationTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces } = context;

  server.registerTool(
    toolNames.write,
    {
      title: "Write file",
      description: `Create or completely overwrite a file in a workspace. Prefer ${toolNames.edit} for targeted changes to existing files.`,
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
      },
      outputSchema: resultOutputSchema(),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaces.resolvePath(workspace, input.path);
      const response = await writeFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(
          config,
          {
            tool: toolNames.write,
            workspaceId,
            path: input.path,
          },
          response.content,
          startedAt,
        );
        return response;
      }

      logToolCall(config, {
        tool: toolNames.write,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  server.registerTool(
    toolNames.edit,
    {
      title: "Edit file",
      description: `Edit one file in a workspace by replacing exact text blocks. Prefer this over ${toolNames.write} for targeted changes. Each oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit and keep oldText as small as possible while still unique.`,
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
      },
      outputSchema: resultOutputSchema({
        status: z.literal("applied"),
      }),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaces.resolvePath(workspace, input.path);
      const response = await editFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(
          config,
          {
            tool: toolNames.edit,
            workspaceId,
            path: input.path,
          },
          response.content,
          startedAt,
        );
        return response;
      }

      const stats = countDiffStats(
        response.details?.patch ?? response.details?.diff,
      );
      const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
      const editContent = [textBlock(editResultText)];
      logToolCall(config, {
        tool: toolNames.edit,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: editContent,
        structuredContent: {
          status: "applied",
          result: contentText(editContent),
        },
      };
    },
  );
}

function registerShellTool(context: ToolRegistrationContext): void {
  const { server, config, workspaces, processSessions, executionBoundary, candidateExecutionCoordinator } = context;

  server.registerTool(
    toolNames.shell,
    {
      title: "Bash",
      description: executionBoundary
        ? `Run a project shell command through workspace boundary ${executionBoundary.profile}. The host filesystem is read-only and only the selected workspace is writable; PID/UTS/IPC are isolated. Legacy approved execution inherits network; A2 Candidate execution uses the no-network profile. Common credential/control environment variables are filtered when supported by the boundary.`
        : "Run a project shell command. No workspace execution boundary is configured for this server instance, so the shell uses the service OS account authority.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        command: z
          .string()
          .describe("Shell command to execute."),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Optional working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout in seconds. Defaults to 30, max 300."),
      },
      outputSchema: resultOutputSchema({
        exitCode: z.number().int().optional(), signal: z.string().optional(),
        timedOut: z.boolean().optional(), boundaryProfile: z.string().optional(),
        networkProfile: z.enum(["inherit", "none"]).optional(),
        wallTimeMs: z.number().nonnegative().optional(), outputTruncated: z.boolean().optional(),
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
      }),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, workingDirectory, ...input }, extra) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const stableCwd = workspaces.resolveWorkingDirectory(
        workspace,
        workingDirectory,
      );
      const timeoutSeconds = input.timeout === undefined ? 30 : Math.min(input.timeout, 300);
      let snapshot: ProcessSnapshot;
      let candidateExecution: CandidateExecutionEvidence | undefined;
      let plan: CandidateExecutionPlan | undefined;
      try {
        plan = await candidateExecutionCoordinator?.beginGrantedExecution({
          grantToken: candidateGrantFromMetadata(extra._meta),
          workspaceId,
          stableRoot: workspace.root,
          stableCwd,
          tool: "bash",
        });
        snapshot = await processSessions.runToCompletion({
          workspaceId, command: input.command, cwd: plan?.cwd ?? stableCwd,
          workspaceRoot: plan?.workspaceRoot ?? workspace.root,
          timeoutMs: Math.max(1, Math.floor(timeoutSeconds * 1_000)),
          networkProfile: plan?.networkProfile,
          ...(executionBoundary ? { executionBoundary } : {}),
        });
        if (plan) candidateExecution = await candidateExecutionCoordinator!.observeSnapshot(plan, snapshot);
      } catch (error) {
        if (plan) await candidateExecutionCoordinator?.abandon(plan);
        const content = [textBlock(error instanceof Error ? error.message : String(error))];
        logFailedToolResponse(
          config,
          {
            tool: toolNames.shell,
            workspaceId,
            workingDirectory: workingDirectory ?? ".",
            command: input.command,
            commandLength: input.command.length,
          },
          content,
          startedAt,
        );
        return { content, structuredContent: { result: contentText(content) }, isError: true };
      }

      const failed = Boolean(snapshot.timedOut) || snapshot.running ||
        snapshot.signal !== undefined || snapshot.exitCode !== 0;
      const status = snapshot.timedOut
        ? `Command timed out after ${timeoutSeconds} seconds.`
        : snapshot.running ? "Command did not terminate after forced timeout cleanup."
        : snapshot.signal ? `Process exited after signal ${snapshot.signal}.`
        : snapshot.exitCode === 0 ? "" : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
      const result = [snapshot.output.replace(/\n$/, ""), status].filter(Boolean).join("\n");
      const content = [textBlock(result)];
      if (failed) {
        logFailedToolResponse(config, { tool: toolNames.shell, workspaceId,
          workingDirectory: workingDirectory ?? ".", command: input.command,
          commandLength: input.command.length }, content, startedAt);
        return { content, structuredContent: { result, exitCode: snapshot.exitCode,
          signal: snapshot.signal, timedOut: snapshot.timedOut,
          boundaryProfile: snapshot.boundaryProfile, networkProfile: snapshot.networkProfile,
          wallTimeMs: snapshot.wallTimeMs,
          outputTruncated: snapshot.outputTruncated,
          ...(candidateExecution ? { candidateExecution } : {}) }, isError: true };
      }

      logToolCall(config, {
        tool: toolNames.shell,
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: input.command,
        commandLength: input.command.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        structuredContent: {
          result, exitCode: snapshot.exitCode, signal: snapshot.signal,
          timedOut: snapshot.timedOut, boundaryProfile: snapshot.boundaryProfile,
          networkProfile: snapshot.networkProfile, wallTimeMs: snapshot.wallTimeMs,
          outputTruncated: snapshot.outputTruncated,
          ...(candidateExecution ? { candidateExecution } : {}),
        },
      };
    },
  );
}
