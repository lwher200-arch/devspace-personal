import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { access, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import { MemoryStore } from "express-rate-limit";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import {
  isArtifactDownloadSupportedPlatform,
  registerArtifactTools,
} from "./artifact-tools.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { CodexBridge, parseCodexSubmission, registerCodexBridgeTools, submitCodexTool } from "./codex-bridge.js";
import { registerProjectTools } from "./project-tools.js";
import { InvalidToolArgumentsError, OwnerApprovals, approvalPrincipal, classifyMcpOperation, installOwnerApprovalRoutes } from './mcp-authorization.js';
import { registerApprovalTools, isApprovalUiTool, chatApprovalEnabled, chatApprovalMode } from './approval-tools.js';
import { APPROVAL_TTL_SECONDS, REVIEW_APPROVAL_TOOL } from './approval-protocol.js';
import {
  createOpenAIIncomingArtifactAdapter,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import {
  logEvent,
  requestIp,
  requestPath,
  sessionIdPrefix,
} from "./logger.js";
import { readFileTool } from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import {
  McpSessionRegistry,
  type McpSessionCloseResult,
} from "./mcp-sessions.js";
import { ProcessSessionManager } from "./process-sessions.js";
import {
  createWorkspaceExecutionBoundary,
  type WorkspaceExecutionBoundary,
} from "./workspace-execution-boundary.js";
import {
  WorkspaceExecutionBoundaryVerificationCache,
  type WorkspaceExecutionBoundaryVerification,
  type WorkspaceExecutionBoundaryVerifier,
} from "./workspace-execution-boundary-verifier.js";
import {
  WorkspaceLeaseIntegrityError,
  WorkspaceLeaseStore,
} from "./workspace-lease/workspace-lease.js";
import {
  WorkspaceLeaseRuntime,
  type WorkspaceLeaseRuntimeObservation,
} from "./workspace-lease/workspace-lease-runtime.js";
import { createExecutorReadiness, type ExecutorReadiness } from "./runtime-readiness.js";
import { readProductVersion, readRuntimeBuildIdentity, type RuntimeBuildIdentity } from "./runtime-build-identity.js";
import { registerNativeProcessTools } from "./native-process-tools.js";
import { AccessDeniedError } from "./roots.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { openAiConversationScopeId } from "./request-meta.js";
import { closeResourcesInOrder, shutdownHttpServer } from "./server-shutdown.js";
import { formatPathForPrompt } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry, WorkspaceUnavailableError } from "./workspaces.js";
import { InvalidPatchError } from "./apply-patch.js";
import {
  getLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";
import {
  buildLocalAgentCatalog,
  buildLocalAgentProviderStatuses,
  formatLocalAgentProviderStatusSummary,
  type LocalAgentProviderStatus,
} from "./local-agent-catalog.js";
import { getToolSurface } from "./tool-surfaces/index.js";
import { ContextFabricStore, registerContextFabricTool } from "./control-plane/context-fabric-tools.js";
import { registerControlHubTool } from "./control-plane/control-hub-tools.js";
import {
  A2_CANDIDATE_GRANT_META_KEY,
  CandidateExecutionCoordinator,
} from "./candidate-workspace/candidate-execution-coordinator.js";
import {
  FilesystemCandidateWorkspaceProvider,
  type CandidateWorkspaceProvider,
} from "./candidate-workspace/candidate-workspace.js";
import {
  contentText,
  logFailedToolResponse,
  logToolCall,
  resultOutputSchema,
  textBlock,
  workspaceAppDescriptorMeta,
} from "./tool-surfaces/shared.js";
import {
  WORKSPACE_APP_URI,
  toolNames,
  workspaceIdDescription,
  type ToolContent,
  type ToolSurface,
} from "./tool-surfaces/types.js";

type Transport = StreamableHTTPServerTransport;
// MCP clients can reconnect without closing the previous transport. Bound stale
// session retention so abandoned MCP servers do not accumulate for the life of the process.
const MCP_SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;
const MCP_SESSION_CLEANUP_INTERVAL_MS = 30 * 1_000;
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
// Read-only resource aliases for MCP hosts that cached an older outputTemplate
// URI before reconnecting. New tool definitions must continue to publish only
// WORKSPACE_APP_URI. These aliases carry no approval authority or private data.
const LEGACY_WORKSPACE_APP_URIS = [
  "ui://devspace/workspace-app.html",
  "ui://devspace/workspace-app-v2.html",
  "ui://devspace/workspace-app-v3.html",
  "ui://devspace/workspace-app-v4.html",
  "ui://devspace/workspace-app-v5.html",
  "ui://devspace/workspace-app-v6.html",
] as const;

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  localAgentProviders: LocalAgentProviderStatus[];
  close(): Promise<void>;
}

interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

function serverInstructions(
  config: ServerConfig,
  toolSurface: ToolSurface,
): string {
  const artifactInstruction =
    config.artifactsEnabled && isArtifactDownloadSupportedPlatform()
      ? " When the user supplies or generates a file that is not present on the DevSpace host, use download_artifact with its native file value, the existing workspace ID, and a suitable relative destination path chosen from the user's request and project structure. The tool refuses to overwrite an existing destination and returns the normalized workspace-relative path. Use normal workspace tools when explicit inspection, replacement, movement, renaming, or deletion is needed. Do not recreate binary files with write/edit calls or place signed URLs, native file objects, base64 content, or invented host paths in shell commands or logs."
      : "";
  const showChangesInstruction =
    " If the turn successfully modifies files by creating, editing, overwriting, deleting, moving, or applying patches, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual file change.";
  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories. `
    : "";
  const agents = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in availableAgentsFiles, use ${toolNames.read} to inspect that instruction file and follow it. `;
  const common = `Use DevSpace for coding work. Call ${toolNames.openWorkspace} once for each project folder or isolated worktree, then keep using its workspaceId. During continued work, reuse that workspaceId. Use refreshContext=true with the same checkout path only when project rules changed or the earlier bootstrap context is missing. Open another workspace only when changing projects, switching checkout/worktree mode, creating another isolated worktree, or when the current workspaceId is rejected.`;

  const authorization = config.toolAuthorization === 'owner_approval'
    ? ' High-risk operations require user approval. On OWNER_APPROVAL_REQUIRED, if chatApproval.enabled is true call review_approval with no approvalId to show the centralized Approval Center for the current Chat conversation; pass approvalId only when one specific request must be reopened, then wait for the user. Otherwise show approvalUrl and wait. Never ask for passwords, read private card metadata, call the UI decision tool on the user behalf, infer a conversation lease, or evade approval. After a non-Codex approval notification, retry only the exact original operation first. If the host changed the logical Chat session and the existing approval receipt cannot be consumed, call claim_approval with that approvalId. If a cached host tool surface does not expose claim_approval, call review_approval with approvalId "__claim__<approvalId>" to claim that same already-approved receipt without approving anything new, then retry the exact original operation. A conversation safe-operation lease exists only after the user selects that option in the approval UI. Shell/native leases remain exact-request scoped; Codex leases are bounded by project, Codex action, write mode, resolved model and, for continuations, agent ID. Revoke live leases with revoke_conversation_approvals. Recycle only server-marked processed history with recycle_approvals; recycling never grants or revokes authority. Codex approval submits the current turn exactly once; later matching calls may use an active bounded lease, but an approval receipt itself must never be replayed as execution. Routine guarded patches remain available.' : '';
  const nativeWorkflow = ' Use project_read_batch for a bounded group of known files, following per-file hashes and continuation. Prefer run_process when a program and literal arguments express the command. Use host_command only for explicit DevSpace-host maintenance or recovery that requires shell semantics; it is not sandboxed and remains Owner-approval gated. Use process_status for existing native sessions and inspect exitCode, timedOut and spawnError. Do not start a second execution to poll delayed work. A zero exit code is command evidence, not proof that tests were discovered or a product workflow succeeded.';
  return `${common} ${toolSurface.instructions({ agents, skills })}${nativeWorkflow}${artifactInstruction}${showChangesInstruction}${authorization}`;
}

function formatVisibleAgent(agent: {
  name: string;
  provider: string;
  model?: string;
  effort?: string;
}): string {
  const model = agent.model ? `, model ${agent.model}` : "";
  const effort = agent.effort ? `, effort ${agent.effort}` : "";
  return `${agent.name} (${agent.provider}${model}${effort})`;
}

function formatAvailableAgentProvider(provider: {
  id: string;
  model?: string;
  effort?: string;
  note?: string;
}): string {
  const details = [
    provider.model ? `model ${provider.model}` : undefined,
    provider.effort ? `effort ${provider.effort}` : undefined,
    provider.note,
  ].filter(Boolean).join(", ");
  return `${provider.id}${details ? ` (${details})` : ""}`;
}

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceLocalAgentOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
});

const workspaceLocalAgentProviderOutputSchema = z.object({
  id: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  note: z.string().optional(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

function assetBaseUrl(config: ServerConfig): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}

function uiManifestUrl(): URL {
  return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}

function readWorkspaceAppManifest(): WorkspaceAppManifest {
  return JSON.parse(readFileSync(uiManifestUrl(), "utf8")) as WorkspaceAppManifest;
}

function getWorkspaceAppManifestEntry(): WorkspaceAppManifestEntry {
  const manifest = readWorkspaceAppManifest();
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];

  if (!entry?.file) {
    throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  }

  return entry;
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

function workspaceAppHtml(config: ServerConfig): string {
  const baseUrl = assetBaseUrl(config);
  const entry = getWorkspaceAppManifestEntry();
  const stylesheets = (entry.css ?? [])
    .map(
      (stylesheet) =>
        `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevSpace Workspace</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}

function appCsp(config: ServerConfig): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    resourceDomains: [publicBaseUrl],
    connectDomains: [publicBaseUrl],
  };
}

function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

async function assertWorkspaceAppAssets(): Promise<void> {
  const entry = getWorkspaceAppManifestEntry();
  const candidates = [entry.file, ...(entry.css ?? [])].map(
    (assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url),
  );

  for (const candidate of candidates) {
    await access(candidate);
  }
}

function registerWorkspaceAppResources(server: McpServer, config: ServerConfig): void {
  const uris = [WORKSPACE_APP_URI, ...LEGACY_WORKSPACE_APP_URIS];
  for (const [index, uri] of uris.entries()) {
    const current = index === 0;
    registerAppResource(
      server,
      current ? "DevSpace Workspace App" : `DevSpace Workspace App compatibility ${index}`,
      uri,
      {
        description: current
          ? "Interactive DevSpace workspace UI for tool results, file reviews, and user approval workflows."
          : "Compatibility alias for a previously cached DevSpace workspace UI resource. New tool definitions do not publish this URI.",
        _meta: {
          ui: {
            csp: appCsp(config),
          },
        },
      },
      async () => {
        await assertWorkspaceAppAssets();
        const text = workspaceAppHtml(config);
        logEvent(config.logging, "info", "mcp_app_resource_read", {
          uri,
          current,
          bytes: Buffer.byteLength(text),
        });
        return {
          contents: [
            {
              uri,
              mimeType: RESOURCE_MIME_TYPE,
              text,
              _meta: {
                ui: {
                  csp: appCsp(config),
                },
              },
            },
          ],
        };
      },
    );
  }
}

export function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  resolveLocalAgentProviders: () => LocalAgentProviderStatus[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
  codexBridge?: CodexBridge,
  approvals?: OwnerApprovals,
  beginRequest?: () => (() => void) | undefined,
  cancelledRequest?: (requestId: string | number) => void,
  executionBoundary?: WorkspaceExecutionBoundary,
  contextFabricStore = new ContextFabricStore(),
  candidateExecutionCoordinator?: CandidateExecutionCoordinator,
): McpServer {
  const toolSurface = getToolSurface(config.toolMode);
  const server = new McpServer(
    {
      name: "devspace",
      title: "DevSpace",
      version: readProductVersion(),
      description:
        "Coding tools for project workspaces. Open each project or worktree once, then reuse its workspaceId.",
    },
    {
      instructions: serverInstructions(config, toolSurface),
    },
  );

  // Protect actual RPC work even if its HTTP stream is disconnected or cancelled.
  // Install before registering tools/resources; the SDK installs their handlers eagerly.
  if (beginRequest) {
    const setRequestHandler = server.server.setRequestHandler.bind(server.server);
    server.server.setRequestHandler = (schema, handler) => setRequestHandler(schema, async (request, extra) => {
      const release = beginRequest();
      // Cancellation can arrive after the handler settles but before the SDK
      // sends its response. Keep listening for the SDK controller's lifetime.
      // The handler lease still protects work if cancellation arrives earlier.
      const cancelled = () => cancelledRequest?.(extra.requestId);
      extra.signal.addEventListener("abort", cancelled, { once: true });
      if (extra.signal.aborted) cancelled();
      try { return await handler(request, extra); }
      finally { release?.(); }
    });
  }

  registerWorkspaceAppResources(server, config);

  registerAppTool(
    server,
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Start work in a project directory or isolated worktree when no usable workspaceId exists for it. Reuse the workspaceId during continued work. Use refreshContext=true on the same checkout path only to recover changed or missing project context. Defaults to the actual checkout; mode=\"worktree\" creates a new isolated worktree.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path, or a leading-tilde home path such as ~/project, to a project directory inside an allowed root.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Defaults to checkout, which works in the actual directory. Use worktree for isolated or parallel Git work.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
        refreshContext: z.boolean().optional().describe(
          "Return current project instructions and catalogs even when this conversation reuses a checkout. Does not grant authority or change the default checkout reuse behavior. Do not use mode=worktree to refresh an existing worktree; read its instructions with the existing workspaceId.",
        ),
      },
      outputSchema: {
        workspaceId: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        sourceRoot: z.string().optional(),
        worktree: z
          .object({
            path: z.string(),
            baseRef: z.string(),
            baseSha: z.string(),
            dirtySource: z.boolean(),
            detached: z.boolean(),
            managed: z.boolean(),
          })
          .optional(),
        agentsFiles: z.array(workspaceAgentsFileOutputSchema).optional(),
        availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema).optional(),
        contextDiscoveryTruncated: z.boolean().optional(),
        skills: z.array(workspaceSkillOutputSchema).optional(),
        agentProviders: z.array(workspaceLocalAgentProviderOutputSchema).optional(),
        agents: z.array(workspaceLocalAgentOutputSchema).optional(),
        skillDiagnostics: z.array(z.unknown()).optional(),
        review: z.discriminatedUnion("available", [
          z.object({ available: z.literal(true) }),
          z.object({
            available: z.literal(false),
            reason: z.string(),
          }),
        ]),
        instruction: z.string(),
      },
      ...workspaceAppDescriptorMeta(config),
      annotations: { readOnlyHint: true },
    },
    async ({ path, mode, baseRef, refreshContext }, { _meta }) => {
      const startedAt = performance.now();
      const {
        workspace,
        agentsFiles,
        availableAgentsFiles,
        contextDiscoveryTruncated,
        workspaceReused,
        includeBootstrapContext,
      } = await workspaces.openWorkspace(
        { path, mode, baseRef },
        { conversationScopeId: openAiConversationScopeId(_meta), refreshContext },
      );
      const review = await reviewCheckpoints.initializeWorkspace({
        workspaceId: workspace.id,
        root: workspace.root,
      });
      const cardSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: formatPathForPrompt(skill.filePath),
        }));
      const agentCatalog = buildLocalAgentCatalog(
        config.subagents,
        workspace.agentProfiles,
        resolveLocalAgentProviders(),
      );
      const cardAgentProviders = agentCatalog.providers
        .filter((provider) => provider.usable)
        .map((provider) => ({
          id: provider.id,
          model: provider.model,
          effort: provider.effort,
          note: provider.note,
        }));
      const cardAgents = agentCatalog.profiles;
      const cardAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const cardAvailableAgentsFiles = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const visibleSkills = includeBootstrapContext ? cardSkills : [];
      const visibleAgentProviders = includeBootstrapContext ? cardAgentProviders : [];
      const visibleAgents = includeBootstrapContext ? cardAgents : [];
      const loadedAgentsFiles = includeBootstrapContext ? cardAgentsFiles : [];
      const availableAgentsFileOutputs = includeBootstrapContext ? cardAvailableAgentsFiles : [];
      const cardInstruction = config.skillsEnabled
        ? "Use this workspaceId for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
        : "Use this workspaceId for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file.";
      const instruction = workspaceReused && includeBootstrapContext
        ? `Workspace context refreshed for ${workspace.id}. Keep this workspaceId and follow the current instructions and catalogs returned here.`
        : workspaceReused
        ? [
            `Workspace already open as ${workspace.id}.`,
            "Continue with this workspaceId.",
            "Keep following the project instructions, nested instruction files, skills, agent profiles, and diagnostics already provided for this workspace.",
          ].join("\n\n")
        : workspace.mode === "worktree"
          ? "Use this workspaceId for subsequent work in this isolated worktree. Keep reusing it while working in this worktree. Follow the project instructions, nested instruction files, skills, agent profiles, and diagnostics returned for it."
          : cardInstruction;
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            workspaceReused
              ? `Workspace already open as ${workspace.id}.`
              : workspace.mode === "worktree"
                ? `Opened isolated worktree workspace ${workspace.id}.`
                : `Opened workspace ${workspace.id}.`,
            `Root: ${workspace.root}`,
            `Mode: ${workspace.mode}`,
            loadedAgentsFiles.length > 0
              ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
              : undefined,
            availableAgentsFileOutputs.length > 0
              ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
              : undefined,
            contextDiscoveryTruncated
              ? "Nested instruction discovery reached its scan budget. Before editing a target directory, inspect its ancestor AGENTS.md and CLAUDE.md files; absence from this partial list is not proof that none exist."
              : undefined,
            visibleSkills.length > 0
              ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
              : undefined,
            visibleAgentProviders.length > 0
              ? `Available subagent providers: ${visibleAgentProviders.map(formatAvailableAgentProvider).join(", ")}`
              : undefined,
            visibleAgents.length > 0
              ? `Available subagent profiles: ${visibleAgents.map(formatVisibleAgent).join(", ")}`
              : undefined,
            instruction,
          ].filter(Boolean).join("\n"),
        },
      ];
      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: resultContent,
        _meta: {
          card: {
            workspaceId: workspace.id,
            root: workspace.root,
            path: workspace.root,
            mode: workspace.mode,
            workspaceReused,
            includeBootstrapContext,
            sourceRoot: workspace.sourceRoot,
            worktree: workspace.worktree,
            agentsFiles: cardAgentsFiles,
            availableAgentsFiles: cardAvailableAgentsFiles,
            skills: cardSkills,
            agentProviders: cardAgentProviders,
            agents: cardAgents,
            review,
            instruction: cardInstruction,
            summary: {
              mode: workspace.mode,
              agentsFiles: cardAgentsFiles.length,
              availableAgentsFiles: cardAvailableAgentsFiles.length,
              skills: cardSkills.length,
              agentProviders: cardAgentProviders.length,
              agents: cardAgents.length,
            },
          },
        },
        structuredContent: {
          workspaceId: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          review,
          ...(includeBootstrapContext
            ? {
                agentsFiles: loadedAgentsFiles,
                availableAgentsFiles: availableAgentsFileOutputs,
                contextDiscoveryTruncated,
                skills: visibleSkills,
                agentProviders: visibleAgentProviders,
                agents: visibleAgents,
                skillDiagnostics: workspace.skillDiagnostics,
              }
            : {}),
          instruction,
        },
      };
    },
  );

  server.registerTool(
    toolNames.read,
    {
      title: "Read file",
      description:
        [
          "Read a file in a workspace. Use this for file inspection instead of shell commands like cat or sed.",
          "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
          config.skillsEnabled
            ? "If available skills were returned and a task matches one, read that skill's path before proceeding. Skill paths may be outside the workspace; only advertised SKILL.md files and files under already-loaded skill directories are readable."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      inputSchema: {
        workspaceId: z
          .string()
          .describe(workspaceIdDescription),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path to read, relative to the workspace root. May also be an advertised skill path from open_workspace skills."
              : "File path to read, relative to the workspace root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
      },
      outputSchema: resultOutputSchema(),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const readPath = workspaces.resolveReadPath(workspace, input.path);
      const response = await readFileTool(
        { ...input, path: readPath.absolutePath },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: readPath.readRoots,
        },
      );

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }
      workspaces.markReadPathLoaded(workspace, readPath);

      logToolCall(config, {
        tool: toolNames.read,
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

  toolSurface.register({
    server,
    config,
    workspaces,
    processSessions,
    executionBoundary,
    candidateExecutionCoordinator,
  });
  registerProjectTools({ server, config, workspaces, processSessions });
  registerNativeProcessTools({
    server, config, workspaces, processSessions, executionBoundary, candidateExecutionCoordinator,
  });
  registerContextFabricTool(server, config, workspaces, contextFabricStore);
  registerControlHubTool(server, config, { productVersion: readProductVersion() });

  registerAppTool(
    server,
    "show_changes",
    {
      title: "Show changes",
      description:
        "Show the changes made in this turn for an open workspace. Call this once after the final related file change and before your final response so the user can review the combined diff. Do not call it after each individual file change.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
      },
      outputSchema: resultOutputSchema({
        workspaceId: z.string(),
        reviewRef: z.string().regex(/^[0-9a-f]{40,64}$/),
      }),
      ...workspaceAppDescriptorMeta(config),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const reviewRef = typeof _meta?.["devspace/reviewRef"] === "string"
        ? _meta["devspace/reviewRef"]
        : undefined;
      const review = reviewRef
        ? await reviewCheckpoints.reviewByRef({
            workspaceId,
            root: workspace.root,
            reviewRef,
          })
        : await reviewCheckpoints.reviewChanges({
            workspaceId,
            root: workspace.root,
            markReviewed: true,
          });

      const content = [textBlock(review.result)];
      logToolCall(config, {
        tool: "show_changes",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          card: {
            workspaceId,
            summary: review.summary,
            files: review.files,
            preview: {
              complete: !review.patchTruncated,
              includedFiles: review.patchFileCount,
              totalFiles: review.summary.files,
              omittedFiles: Math.max(0, review.summary.files - review.patchFileCount),
            },
            payload: {
              patch: review.patch,
            },
          },
        },
        structuredContent: {
          workspaceId,
          reviewRef: review.reviewRef,
          result: contentText(content),
        },
      };
    },
  );

  if (config.artifactsEnabled && isArtifactDownloadSupportedPlatform()) {
    registerArtifactTools(server, {
      config,
      workspaces,
      incomingArtifactAdapters,
    });
  }

  if (codexBridge) registerCodexBridgeTools(server, workspaces, codexBridge);
  if (approvals && config.uiEnabled) {
    registerApprovalTools(server, config, approvals, workspaces, executionBoundary?.profile);
  }
  return server;
}

export interface CreateServerOptions {
  incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
  codexBridgeFactory?: (config: ServerConfig) => CodexBridge;
  executorReadiness?: () => ExecutorReadiness;
  runtimeBuildIdentity?: () => RuntimeBuildIdentity;
  mcpSessions?: { maxSessions?: number; now?: () => number; idleTimeoutMs?: number; cleanupIntervalMs?: number };
  executionBoundary?: WorkspaceExecutionBoundary | null;
  workspaceExecutionBoundaryVerifier?: WorkspaceExecutionBoundaryVerifier;
  workspaceExecutionBoundaryVerificationTtlMs?: number;
  candidateWorkspaceProvider?: CandidateWorkspaceProvider | null;
}

export function createServer(
  config = loadConfig(),
  options: CreateServerOptions = {},
): RunningServer {
  const rollback: Array<() => void> = [];
  try { return initializeServer(config, options, rollback); }
  catch (error) {
    const errors = [error];
    // Nothing is listening yet. Only synchronously acquired resources need
    // rollback, in reverse ownership order; do not replay setup or erase state.
    for (const close of rollback.reverse()) {
      try { close(); } catch (cleanupError) { errors.push(cleanupError); }
    }
    if (errors.length > 1) throw new AggregateError(errors, `DevSpace startup rollback failed after: ${String(error)}`);
    throw error;
  }
}

function initializeServer(
  config: ServerConfig,
  options: CreateServerOptions,
  rollback: Array<() => void>,
): RunningServer {
  const incomingArtifactAdapters = options.incomingArtifactAdapters
    ?? [createOpenAIIncomingArtifactAdapter()];
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const transports = new McpSessionRegistry<Transport>(options.mcpSessions);
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  rollback.push(() => oauthProvider.close());
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  rollback.push(() => workspaceStore.close?.());
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const processSessions = new ProcessSessionManager();
  const executionBoundary = options.executionBoundary === undefined
    ? createWorkspaceExecutionBoundary()
    : options.executionBoundary ?? undefined;
  const boundaryVerificationCache = new WorkspaceExecutionBoundaryVerificationCache(
    executionBoundary,
    {
      verify: options.workspaceExecutionBoundaryVerifier,
      ttlMs: options.workspaceExecutionBoundaryVerificationTtlMs,
    },
  );
  let lastBoundaryVerificationLog = "";
  const currentBoundaryVerification = (force = false): WorkspaceExecutionBoundaryVerification => {
    const receipt = boundaryVerificationCache.current(force);
    const signature = JSON.stringify(receipt);
    if (signature !== lastBoundaryVerificationLog) {
      lastBoundaryVerificationLog = signature;
      logEvent(
        config.logging,
        receipt.verified ? "info" : "warn",
        "workspace_execution_boundary_verification",
        {
          verified: receipt.verified,
          profile: receipt.profile,
          reason: receipt.reason,
          ...receipt.checks,
        },
      );
    }
    return receipt;
  };
  currentBoundaryVerification(true);
  const workspaceLeaseStore = new WorkspaceLeaseStore(config.stateDir);
  rollback.push(() => workspaceLeaseStore.close());
  const workspaceLeaseRuntime = new WorkspaceLeaseRuntime(workspaceLeaseStore, {
    boundaryVerified: () => currentBoundaryVerification().verified,
  });
  const candidateWorkspaceProvider = options.candidateWorkspaceProvider === undefined
    ? new FilesystemCandidateWorkspaceProvider(join(config.stateDir, "candidate-workspaces"))
    : options.candidateWorkspaceProvider ?? undefined;
  const candidateExecutionCoordinator = candidateWorkspaceProvider
    ? new CandidateExecutionCoordinator(
        workspaceLeaseRuntime,
        candidateWorkspaceProvider,
        executionBoundary?.profile,
      )
    : undefined;
  const executorReadiness = options.executorReadiness ?? createExecutorReadiness();
  const runtimeBuildIdentity = (options.runtimeBuildIdentity ?? readRuntimeBuildIdentity)();
  const contextFabricStore = new ContextFabricStore();
  let shuttingDown = false;
  const approvals = config.toolAuthorization === 'owner_approval'
    ? new OwnerApprovals(undefined, (config.approvalTtlSeconds ?? APPROVAL_TTL_SECONDS.default) * 1000) : undefined;
  if (approvals) installOwnerApprovalRoutes(app, config, approvals);
  const codexBridge = config.bridge?.enabled ? (options.codexBridgeFactory?.(config) ?? new CodexBridge(config)) : undefined;
  if (codexBridge) rollback.push(() => codexBridge.close());
  const localAgentProviders = buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(),
  );
  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(),
  );

  const logSessionCloseResults = (
    reason: "idle_timeout" | "capacity" | "server_shutdown",
    results: McpSessionCloseResult[],
  ) => {
    for (const result of results) {
      if (result.error) {
        logEvent(config.logging, "warn", "mcp_session_close_failed", {
          reason,
          sessionIdPrefix: sessionIdPrefix(result.sessionId),
          error:
            result.error instanceof Error
              ? result.error.message
              : String(result.error),
        });
        continue;
      }

      logEvent(config.logging, "info", "mcp_session_closed", {
        reason,
        sessionIdPrefix: sessionIdPrefix(result.sessionId),
      });
    }
  };

  const sessionCleanupTimer = setInterval(() => {
    void transports
      .closeIdle(options.mcpSessions?.idleTimeoutMs ?? MCP_SESSION_IDLE_TIMEOUT_MS)
      .then((results) => logSessionCloseResults("idle_timeout", results));
  }, options.mcpSessions?.cleanupIntervalMs ?? MCP_SESSION_CLEANUP_INTERVAL_MS);
  rollback.push(() => clearInterval(sessionCleanupTimer));
  sessionCleanupTimer.unref();

  if (config.logging.trustProxy) {
    app.set("trust proxy", config.logging.trustProxy);
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });

    next();
  });

  // Own the SDK middleware's existing stores so setup failure and normal close
  // can stop their timers. Endpoint limits and keying remain SDK defaults.
  const authRateLimitStores = {
    authorization: new MemoryStore(), token: new MemoryStore(),
    registration: new MemoryStore(), revocation: new MemoryStore(),
  };
  const closeAuthRateLimits = Object.values(authRateLimitStores).map(store => () => store.shutdown());
  rollback.push(...closeAuthRateLimits);
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "DevSpace",
      authorizationOptions: { rateLimit: { store: authRateLimitStores.authorization } },
      tokenOptions: { rateLimit: { store: authRateLimitStores.token } },
      clientRegistrationOptions: { rateLimit: { store: authRateLimitStores.registration } },
      revocationOptions: { rateLimit: { store: authRateLimitStores.revocation } },
    }),
  );

  app.options("/mcp-app-assets/{*asset}", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "devspace" });
  });

  app.get("/runtimez", (_req, res) => {
    const ok = runtimeBuildIdentity.freshness !== "mismatch";
    res.setHeader("Cache-Control", "no-store");
    res.status(ok ? 200 : 503).json({ ok, name: "devspace", ...runtimeBuildIdentity });
  });

  app.get("/readyz", (_req, res) => {
    const checks: Record<string, boolean> = { lifecycle: !shuttingDown };
    for (const [name, check] of [
      ["oauthDatabase", () => oauthProvider.checkReady()],
      ["workspaceDatabase", () => workspaceStore.checkReady?.()],
      ...(codexBridge ? [["bridgeDatabase", () => codexBridge.checkReady()]] : []),
    ] as Array<[string, () => void]>) {
      try { check(); checks[name] = true; }
      catch { checks[name] = false; }
    }
    let executors: ExecutorReadiness;
    try { executors = executorReadiness(); }
    catch { executors = { native: false, shell: false, pty: false }; }
    checks.nativeExecutor = executors.native;
    checks.shellExecutor = executors.shell;
    const executionBoundaryVerification = currentBoundaryVerification();
    checks.workspaceExecutionBoundary = executionBoundaryVerification.verified;
    if (runtimeBuildIdentity.freshness !== "unverified") {
      checks.buildFreshness = runtimeBuildIdentity.freshness === "verified";
    }
    const ok = Object.values(checks).every(Boolean);
    res.setHeader("Cache-Control", "no-store");
    res.status(ok ? 200 : 503).json({
      ok, name: "devspace", status: ok ? "ready" : "degraded", checks,
      capabilities: {
        pty: executors.pty,
        executionBoundary: executionBoundaryVerification,
      },
      // Independent agent daemons cannot be counted here without querying/starting them.
      // Unknown activity must never be interpreted as permission to restart their work.
      activityKnown: !config.subagents.enabled && !config.bridge?.enabled,
      activeProcesses: config.subagents.enabled || config.bridge?.enabled ? null : processSessions.activeProcessCount,
      processSessions: processSessions.activeProcessCount,
    });
  });

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (res.headersSent) return;

    if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: "invalid_oauth_resource",
        ...requestLogFields(req, config),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
      sessionIdPresent: Boolean(sessionId),
      sessionIdPrefix: sessionIdPrefix(sessionId),
      isInitialize: initializeRequest,
    });

    let finishHttpRequest: (() => void) | undefined;
    let reservation: Awaited<ReturnType<typeof transports.reserve>>;
    let transport: Transport | undefined;
    let initializedSession = false;
    const requestIds: Array<string | number> = [];
    for (const message of Array.isArray(req.body) ? req.body : [req.body]) {
      if (message && typeof message.method === "string" &&
        (typeof message.id === "string" || typeof message.id === "number")) requestIds.push(message.id);
    }
    try {
      if (shuttingDown) { sendJsonRpcError(res, 503, -32000, "Server is shutting down"); return; }
      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) { sendJsonRpcError(res, 404, -32000, "Unknown MCP session"); return; }
        if (req.method === "POST") finishHttpRequest = transports.beginHttpRequest(sessionId, requestIds);
      }

      if (approvals && Array.isArray(req.body)) { sendJsonRpcError(res, 400, -32600, 'Batch requests are not supported by the approval boundary.'); return; }
      if (approvals && req.method === 'POST' && req.body?.method === 'tools/call') {
        if (!sessionId || !transports.get(sessionId)) { sendJsonRpcError(res, 404, -32000, 'Unknown MCP session'); return; }
        const tool = req.body.params?.name, args = req.body.params?.arguments ?? {};
        if (typeof tool !== 'string' || !args || typeof args !== 'object' || Array.isArray(args) || req.body.id === undefined) { sendJsonRpcError(res, 400, -32600, 'Invalid tool request'); return; }
        const automatic = codexBridge && ['codex_task_start', 'codex_task_continue'].includes(tool);
        // Review the same normalized inputs the MCP schema will execute (for
        // example, whitespace must not route the reviewed and actual models differently).
        let executionArgs: Record<string, unknown>;
        let assessment: { reason?: string; context: unknown };
        let a2WorkspaceLease: WorkspaceLeaseRuntimeObservation | undefined;
        let a2CandidateGrant: string | undefined;
        try {
          try {
            executionArgs = automatic ? parseCodexSubmission(tool, args) : args;
          } catch (error) {
            if (error instanceof z.ZodError) throw new InvalidToolArgumentsError(error.message);
            throw error;
          }
          assessment = isApprovalUiTool(tool)
            ? { reason: undefined, context: {} }
            : classifyMcpOperation(config, workspaces, tool, executionArgs, executionBoundary?.profile);
          if (["exec_command", "bash", "run_process"].includes(tool) &&
              typeof executionArgs.workspaceId === "string") {
            const workspace = workspaces.getWorkspace(executionArgs.workspaceId);
            try {
              if (candidateExecutionCoordinator) {
                const authorization = await candidateExecutionCoordinator.authorizeRequest({
                  clientId: req.auth!.clientId,
                  conversationScopeId: openAiConversationScopeId(req.body.params?._meta),
                  workspaceId: executionArgs.workspaceId,
                  stableRoot: workspace.root,
                  tool: tool as "exec_command" | "bash" | "run_process",
                });
                a2WorkspaceLease = authorization.observation;
                a2CandidateGrant = authorization.grantToken;
                if (a2CandidateGrant) {
                  const metadata = req.body.params?._meta;
                  req.body.params._meta = {
                    ...(metadata && typeof metadata === "object" && !Array.isArray(metadata)
                      ? metadata as Record<string, unknown>
                      : {}),
                    [A2_CANDIDATE_GRANT_META_KEY]: a2CandidateGrant,
                  };
                }
              } else {
                a2WorkspaceLease = workspaceLeaseRuntime.observe({
                  clientId: req.auth!.clientId,
                  conversationScopeId: openAiConversationScopeId(req.body.params?._meta),
                  workspaceRoot: workspace.root,
                  boundaryProfile: executionBoundary?.profile,
                });
              }
            } catch (error) {
              if (!(error instanceof WorkspaceLeaseIntegrityError)) throw error;
              logEvent(config.logging, "error", "workspace_lease_integrity_failed", {
                tool,
                requestId,
                workspaceId: executionArgs.workspaceId,
              });
              const detail = {
                code: "WORKSPACE_LEASE_INTEGRITY_FAILED",
                instruction: "Persisted A2 workspace lease integrity verification failed. Execution is blocked until the lease state is inspected or revoked; a legacy approval does not override corrupted lease state.",
              };
              res.json({ jsonrpc: "2.0", id: req.body.id, result: {
                isError: true,
                content: [textBlock(JSON.stringify(detail))],
              } });
              return;
            }
            if (a2WorkspaceLease.lease) {
              logEvent(config.logging, "info", "workspace_lease_runtime_observed", {
                tool,
                requestId,
                workspaceId: executionArgs.workspaceId,
                state: a2WorkspaceLease.lease.state,
                reason: a2WorkspaceLease.reason,
                authorityActive: a2WorkspaceLease.authorityActive,
                executionEligible: a2WorkspaceLease.executionEligible,
              });
            }
          }
        } catch (error) {
          if (error instanceof WorkspaceUnavailableError || error instanceof InvalidToolArgumentsError || error instanceof InvalidPatchError) {
            const detail = error instanceof WorkspaceUnavailableError
              ? { code: error.code, instruction: error.message }
              : { code: 'INVALID_TOOL_ARGUMENTS', message: error.message,
                instruction: 'Correct the tool arguments before retrying. This request did not execute and does not require Owner approval.' };
            logEvent(config.logging, 'warn', 'tool_request_rejected', { tool, requestId, code: detail.code });
            res.json({ jsonrpc: '2.0', id: req.body.id, result: { isError: true,
              content: [textBlock(JSON.stringify(detail))] } }); return;
          }
          if (!(error instanceof AccessDeniedError)) throw error;
          // A root-boundary rejection is an expected tool failure. Do not expose
          // configured private roots or turn it into a misleading server fault.
          const detail = { code: 'WORKSPACE_ACCESS_DENIED',
            instruction: 'The requested path or workspace is outside its current authorized boundary. Use an allowed workspace-relative path; approval cannot expand that boundary.' };
          logEvent(config.logging, 'warn', 'tool_workspace_access_denied', { tool, requestId });
          res.json({ jsonrpc: '2.0', id: req.body.id, result: { isError: true,
            content: [textBlock(JSON.stringify(detail))] } }); return;
        }
        if (!assessment.reason && !isApprovalUiTool(tool) && config.approvalProfile === 'high_risk_only') {
          logEvent(config.logging, 'info', 'tool_authorization_auto', { tool, requestId });
        }
        if (assessment.reason && !a2CandidateGrant) {
          // Transport sessions can reconnect while the user approves in a browser.
          // Retain the authenticated client and optional logical conversation scope.
          const principal = approvalPrincipal(req.auth!.clientId, req.body.params?._meta);
          const snapshot = structuredClone(executionArgs), originalAssessment = JSON.stringify(assessment);
          const accessToken = req.auth!.token;
          const decision = approvals.require({ principal, tool, args, ...assessment, reason: assessment.reason }, automatic ? async () => {
            // The browser grants exactly the captured request, not a fresh request
            // under a stale token, changed root, changed file or rerouted model.
            try {
              await oauthProvider.verifyAccessToken(accessToken);
              if (JSON.stringify(classifyMcpOperation(
                config, workspaces, tool, snapshot, executionBoundary?.profile,
              )) !== originalAssessment) {
                throw new Error('Approval context changed before dispatch.');
              }
              const result = await submitCodexTool(codexBridge, workspaces, tool, snapshot);
              logEvent(config.logging, 'info', 'owner_approval_submitted', { tool, requestId, agentId: result.id });
              return { agentId: result.id, workspaceId: String(snapshot.workspaceId) };
            } catch (error) {
              logEvent(config.logging, 'warn', 'owner_approval_submission_failed', { tool, requestId });
              throw error;
            }
          } : undefined);
          if (!decision.allowed) {
            const entry = decision.approval;
            if (['submitting', 'submitted', 'failed'].includes(entry.state)) {
              const detail = { code: entry.state === 'submitted' ? 'OWNER_OPERATION_SUBMITTED' : entry.state === 'submitting' ? 'OWNER_OPERATION_SUBMITTING' : 'OWNER_SUBMISSION_UNCONFIRMED',
                approvalId: entry.id, ...entry.submission,
                instruction: entry.submission ? 'Already submitted once. Use codex_task_status with this workspaceId and agentId; do not create another request.' : 'Use codex_tasks for this workspace to reconcile submission; do not automatically resubmit.' };
              res.json({ jsonrpc: '2.0', id: req.body.id, result: { ...(entry.state === 'failed' ? { isError: true } : {}),
                content: [textBlock(JSON.stringify(detail))], structuredContent: { result: JSON.stringify(detail) } } }); return;
            }
            const detail = { code: entry.state === 'denied' ? 'OWNER_DENIED' : 'OWNER_APPROVAL_REQUIRED', approvalId: entry.id,
              approvalProfile: config.approvalProfile ?? 'conservative',
              approvalUrl: new URL(`/owner/approvals/${entry.id}`, config.publicBaseUrl).href, expiresAt: new Date(entry.expires).toISOString(),
              reason: entry.reason, executionMode: automatic ? 'submit_on_approval' : 'retry_after_approval',
              ...(a2WorkspaceLease?.lease ? { a2WorkspaceLease: {
                state: a2WorkspaceLease.lease.state,
                reason: a2WorkspaceLease.reason,
                expiresAt: a2WorkspaceLease.lease.expiresAt,
                executionEligible: a2WorkspaceLease.executionEligible,
              } } : {}),
              ...(config.uiEnabled ? { chatApproval: { ...chatApprovalMode(config, req.auth!.clientId, req.body.params?._meta), clientId: req.auth!.clientId,
                reviewTool: REVIEW_APPROVAL_TOOL, singleReviewTool: REVIEW_APPROVAL_TOOL,
                instruction: 'When enabled, call review_approval with no approvalId to present the centralized Approval Center. Pass approvalId only to reopen this specific approval. Never call the UI decision tool on the user behalf.' } } : {}),
              instruction: `${chatApprovalEnabled(config, req.auth!.clientId, req.body.params?._meta) ? 'Call review_approval with no approvalId to show the centralized Approval Center for this Chat conversation, or pass this approvalId to reopen only this request, then wait for the user decision. If the host cannot show the center/card, use approvalUrl as fallback.' : 'Ask the user to open approvalUrl and approve with their Owner password. Chat UI approval requires a trusted client and a non-empty host conversation context.'} Never ask for the password in Chat or approve on their behalf. ${automatic ? 'Approval automatically submits exactly this Codex turn. Afterwards use codex_tasks and codex_task_status; an identical retry only recovers the submission receipt. Do not create a new request.' : 'Retry only the exact operation after approval.'} Approval grants no additional sandbox or directory access.` };
            res.json({ jsonrpc: '2.0', id: req.body.id, result: { isError: true, content: [textBlock(JSON.stringify(detail))] } }); return;
          }
          logEvent(config.logging, 'info', decision.source === 'conversation_lease' ? 'owner_conversation_lease_used' : 'owner_approval_consumed', {
            tool, requestId, ...(decision.leaseExpiresAt ? { leaseExpiresAt: decision.leaseExpiresAt } : {}),
          });
        } else if (assessment.reason && a2CandidateGrant) {
          logEvent(config.logging, "info", "workspace_lease_candidate_execution_authorized", {
            tool,
            requestId,
            workspaceId: executionArgs.workspaceId,
            leaseState: a2WorkspaceLease?.lease?.state,
            leaseExpiresAt: a2WorkspaceLease?.lease?.expiresAt,
          });
        }
      }

      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
      } else if (initializeRequest) {
        reservation = await transports.reserve();
        if (!reservation) {
          res.setHeader("Retry-After", "1");
          sendJsonRpcError(res, 503, -32000, "MCP session capacity is busy; retry initialization shortly.");
          return;
        }
        logSessionCloseResults("capacity", reservation.closed);
        if (shuttingDown || res.destroyed) {
          if (!res.destroyed) sendJsonRpcError(res, 503, -32000, "Server is shutting down");
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) {
              if (shuttingDown) throw new Error("Server is shutting down");
              reservation!.register(newSessionId, transport);
              initializedSession = true;
              finishHttpRequest = transports.beginHttpRequest(newSessionId, requestIds);
            }
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              ...requestLogFields(req, config),
            });
          },
        });

        const send = transport.send.bind(transport);
        transport.send = async (message, sendOptions) => {
          try { await send(message, sendOptions); }
          finally {
            if (transport?.sessionId && "id" in message && !("method" in message) &&
              (typeof message.id === "string" || typeof message.id === "number")) {
              transports.settleRequest(transport.sessionId, message.id);
            }
          }
        };

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId && transports.remove(closedSessionId)) {
            logEvent(config.logging, "info", "mcp_session_closed", {
              reason: "transport_close",
              sessionIdPrefix: sessionIdPrefix(closedSessionId),
            });
          }
        };

        const server = createMcpServer(
          config,
          workspaces,
          reviewCheckpoints,
          processSessions,
          resolveLocalAgentProviders,
          incomingArtifactAdapters,
          codexBridge,
          approvals,
          () => transport?.sessionId ? transports.beginRequest(transport.sessionId) : undefined,
          (id) => { if (transport?.sessionId) transports.settleRequest(transport.sessionId, id, true); },
          executionBoundary,
          contextFabricStore,
          candidateExecutionCoordinator,
        );
        await server.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    } finally {
      finishHttpRequest?.();
      reservation?.release();
      // A rejected/aborted initialize never reached registry ownership.
      if (reservation && transport && !initializedSession) await transport.close();
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    localAgentProviders,
    close: () => {
      shuttingDown = true;
      closePromise ??= closeResourcesInOrder([
        () => clearInterval(sessionCleanupTimer),
        async () => {
          const results = await transports.closeAll();
          logSessionCloseResults("server_shutdown", results);
        },
        () => processSessions.shutdown(),
        () => candidateExecutionCoordinator?.close(),
        () => approvals?.close(),
        () => workspaceLeaseStore.close(),
        ...closeAuthRateLimits,
        () => oauthProvider.close(),
        () => workspaceStore.close?.(),
        () => codexBridge?.close(),
        () => contextFabricStore.clear(),
      ]);
      return closePromise;
    },
  };
}

export async function startServer(
  config = loadConfig(),
  options: CreateServerOptions = {},
): Promise<RunningServer & { httpServer: HttpServer }> {
  const running = createServer(config, options);
  try {
    const httpServer = createHttpServer(running.app);
    await new Promise<void>((resolve, reject) => {
      const detach = () => {
        httpServer.removeListener("error", failed);
        httpServer.removeListener("listening", ready);
      };
      const failed = (error: unknown) => { detach(); reject(error); };
      const ready = () => { detach(); resolve(); };
      httpServer.once("error", failed);
      httpServer.once("listening", ready);
      try { httpServer.listen(config.port, config.host); }
      catch (error) { failed(error); }
    });
    return { ...running, httpServer };
  } catch (error) {
    try { await running.close(); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `DevSpace listen and cleanup failed: ${String(error)}`);
    }
    throw error;
  }
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { httpServer, config, close, localAgentProviders } = await startServer();
  console.log(`devspace listening on http://${config.host}:${config.port}/mcp`);
  console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
  console.log("auth: oauth owner-token flow required");
  console.log(`logging: ${config.logging.level} ${config.logging.format}`);
  console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
  console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
  console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
  const artifactDownloadStatus = !config.artifactsEnabled
    ? "disabled"
    : isArtifactDownloadSupportedPlatform()
      ? "enabled"
      : `unsupported on ${process.platform}`;
  console.log(`native artifact download: ${artifactDownloadStatus}`);
  console.log(`subagent providers: ${formatLocalAgentProviderStatusSummary(localAgentProviders)}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("devspace shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}
