import * as z from "zod/v4";
import { executionPolicySchema } from "./local-agent-execution.js";
import { subagentsConfigSchema } from "./local-agent-config.js";

export const DEVSPACE_CONFIG_VERSION = 1 as const;
export const DEVSPACE_CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/Waishnav/devspace/main/schema/v1/devspace.schema.json";

const serverConfigSchema = z.object({
  host: z.string().trim().min(1).default("127.0.0.1"),
  port: z.number().int().min(1).max(65_535).default(7676),
  publicBaseUrl: z.string().url().nullable().default(null),
  allowedHosts: z.array(z.string().trim().min(1)).default([]),
  trustProxy: z.union([z.boolean(), z.literal("loopback")]).default(false),
}).strict().prefault({});

const workspacesConfigSchema = z.object({
  allowedRoots: z.array(z.string().trim().min(1)).default([]),
  worktreeRoot: z.string().trim().min(1).default("~/.devspace/worktrees"),
}).strict().prefault({});

const storageConfigSchema = z.object({
  stateDir: z.string().trim().min(1).default("~/.local/share/devspace"),
}).strict().prefault({});

const toolsConfigSchema = z.object({
  mode: z.enum(["claude", "codex"]).default("codex"),
  authorization: z.enum(['legacy', 'owner_approval']).default('legacy'),
  approvalProfile: z.enum(['conservative', 'high_risk_only']).default('conservative'),
  chatApprovalClientIds: z.array(z.string().trim().min(1).max(256)).max(20).default([]),
}).strict().prefault({});

const uiConfigSchema = z.object({
  enabled: z.boolean().default(true),
}).strict().prefault({});

const artifactsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxFileBytes: z.number().int().positive().default(100 * 1024 * 1024),
}).strict().prefault({});

const skillsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  paths: z.array(z.string().trim().min(1)).default([]),
  agentDir: z.string().trim().min(1).default("~/.codex"),
}).strict().prefault({});

const loggingConfigSchema = z.object({
  level: z.enum(["silent", "error", "warn", "info", "debug"]).default("info"),
  format: z.enum(["json", "pretty"]).default("json"),
  requests: z.boolean().default(true),
  assets: z.boolean().default(false),
  toolCalls: z.boolean().default(true),
  shellCommands: z.boolean().default(false),
}).strict().prefault({});

const oauthConfigSchema = z.object({
  ownerSessionTtlSeconds: z.number().int().min(60).max(86400).optional(),
  accessTokenTtlSeconds: z.number().int().positive().default(60 * 60),
  refreshTokenTtlSeconds: z.number().int().positive().default(30 * 24 * 60 * 60),
  scopes: z.array(z.string().trim().min(1)).min(1).default(["devspace"]),
  allowedRedirectHosts: z.array(z.string().trim().min(1)).min(1).default([
    "chatgpt.com",
    "localhost",
    "127.0.0.1",
  ]),
}).strict().prefault({});

const bridgeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  allowWorkspaceWrite: z.boolean().default(false),
  executionPolicy: executionPolicySchema.optional(),
}).strict().prefault({});

export const devspaceConfigSchema = z.object({
  $schema: z.string().url().default(DEVSPACE_CONFIG_SCHEMA_URL),
  configVersion: z.literal(DEVSPACE_CONFIG_VERSION),
  server: serverConfigSchema,
  workspaces: workspacesConfigSchema,
  storage: storageConfigSchema,
  tools: toolsConfigSchema,
  ui: uiConfigSchema,
  artifacts: artifactsConfigSchema,
  skills: skillsConfigSchema,
  subagents: subagentsConfigSchema.default({ enabled: false, providers: [] }),
  logging: loggingConfigSchema,
  oauth: oauthConfigSchema,
  bridge: bridgeConfigSchema,
}).strict();

export type DevspaceConfig = z.output<typeof devspaceConfigSchema>;
export type DevspaceConfigInput = z.input<typeof devspaceConfigSchema>;
export type ToolMode = DevspaceConfig["tools"]["mode"];

export function defaultDevspaceConfig(): DevspaceConfig {
  return devspaceConfigSchema.parse({ configVersion: DEVSPACE_CONFIG_VERSION });
}

export function devspaceConfigJsonSchema(): object {
  return {
    $id: DEVSPACE_CONFIG_SCHEMA_URL,
    title: "DevSpace configuration",
    description: "Versioned configuration for a local DevSpace MCP server.",
    ...z.toJSONSchema(devspaceConfigSchema, {
      target: "draft-2020-12",
      io: "input",
    }),
  };
}
