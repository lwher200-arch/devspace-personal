import type { SubagentsConfig } from "./local-agent-config.js";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";

export const SUBAGENT_SKILL_INSTALL_COMMAND =
  "npx skills add Waishnav/devspace --skill subagents --global";

export const ONBOARDING_DESTINATIONS = ["chatgpt", "coding-agents"] as const;
export type OnboardingDestination = typeof ONBOARDING_DESTINATIONS[number];
export type OnboardingUsage = OnboardingDestination | "both";

export function resolveOnboardingUsage(
  destinations: readonly OnboardingDestination[],
): OnboardingUsage {
  const selected = new Set(destinations);
  if (selected.has("chatgpt") && selected.has("coding-agents")) return "both";
  if (selected.has("chatgpt")) return "chatgpt";
  if (selected.has("coding-agents")) return "coding-agents";
  throw new Error("Choose ChatGPT, Coding Agents, or both.");
}

export function usesChatGpt(usage: OnboardingUsage): boolean {
  return usage === "chatgpt" || usage === "both";
}

export function usesCodingAgents(usage: OnboardingUsage): boolean {
  return usage === "coding-agents" || usage === "both";
}

export function parseLocalSetupPort(value: string): number {
  const trimmed = value.trim();
  const port = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("Enter a port number between 1 and 65535.");
  }
  return port;
}

export function parseLocalSetupRoots(value: string): string[] {
  const roots = value.split(",").map(part => part.trim()).filter(Boolean)
    .map(part => resolve(expandHomePath(part)));
  if (!roots.length) throw new Error("Choose at least one existing project directory.");
  for (const root of roots) {
    if (!statSync(root).isDirectory()) throw new Error("Each project root must be an existing directory.");
  }
  return [...new Set(roots)];
}

export function updateOnboardingSubagentsConfig(
  current: SubagentsConfig,
  selectedProviders: readonly LocalAgentProvider[],
): SubagentsConfig {
  const selected = new Set(selectedProviders);
  return {
    enabled: true,
    providers: LOCAL_AGENT_PROVIDERS
      .filter((id) => selected.has(id) || current.providers.some((provider) => provider.id === id))
      .map((id) => {
        const existing = current.providers.find((provider) => provider.id === id);
        return {
          ...existing,
          id,
          enabled: selected.has(id),
        };
      }),
  };
}
