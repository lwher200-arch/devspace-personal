import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "../config.js";
import { resultOutputSchema, runLoggedToolOperation, textBlock } from "../tool-surfaces/shared.js";
import {
  ControlHubClient,
  controlHubClientConfigFromEnv,
  type ControlHubClientConfig,
} from "./control-hub-client.js";
import { CONTROL_RELAY_PROTOCOL_VERSION, type NodeIdentity } from "./relay-contract.js";

export const controlHubToolInputShape = {
  action: z.enum(["status", "hello", "permissions", "notifications"]),
} as const;

export const controlHubToolInputSchema = z.object(controlHubToolInputShape).strict();
export type ControlHubToolInput = z.infer<typeof controlHubToolInputSchema>;

interface RegistrationOptions {
  env?: NodeJS.ProcessEnv;
  client?: ControlHubClient;
  clientConfig?: ControlHubClientConfig;
  productVersion: string;
}

export function registerControlHubTool(
  server: McpServer,
  config: ServerConfig,
  options: RegistrationOptions,
): void {
  const clientConfig = options.clientConfig ?? controlHubClientConfigFromEnv(options.env);
  const client = options.client ?? (clientConfig ? new ControlHubClient(clientConfig) : undefined);
  const instanceId = randomUUID();
  const startedAt = new Date().toISOString();

  server.registerTool("control_hub", {
    title: "Control Hub",
    description:
      "Inspect or establish the fixed DevSpace Cloudflare Control Hub relay. Actions are limited to public health, node hello, this node's coordination permissions, and this node's unread notifications. It cannot grant local execution authority.",
    inputSchema: controlHubToolInputShape,
    outputSchema: resultOutputSchema(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async (raw) => {
    const input = controlHubToolInputSchema.parse(raw);
    const result = await runLoggedToolOperation(config, { tool: "control_hub" }, performance.now(), async () => {
      if (!client || !clientConfig) {
        return {
          configured: false,
          localExecutionAuthority: false,
          requiredEnvironment: ["DEVSPACE_CONTROL_HUB_URL"],
        };
      }
      if (input.action === "status") {
        return {
          configured: true,
          ...client.describe(),
          health: await client.health(),
          localExecutionAuthority: false,
        };
      }
      if (!clientConfig.nodeId) {
        throw new Error("DEVSPACE_CONTROL_HUB_NODE_ID is required for authenticated Control Hub actions.");
      }
      if (input.action === "hello") {
        const identity: NodeIdentity = {
          version: CONTROL_RELAY_PROTOCOL_VERSION,
          nodeId: clientConfig.nodeId,
          instanceId,
          startedAt,
          productVersion: options.productVersion,
          capabilities: ["status"],
        };
        return {
          ...(await client.hello(identity)),
          capabilities: identity.capabilities,
          localExecutionAuthority: false,
        };
      }
      if (input.action === "permissions") {
        return {
          nodeId: clientConfig.nodeId,
          assignments: await client.permissions(),
          localExecutionAuthority: false,
        };
      }
      return {
        nodeId: clientConfig.nodeId,
        notifications: await client.notifications(),
        localExecutionAuthority: false,
      };
    });
    const text = JSON.stringify(result);
    return { content: [textBlock(text)], structuredContent: { result: text } };
  });
}
