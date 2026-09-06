import { open, stat } from "node:fs/promises";
import { canonicalAllowedPath, resolveAllowedPath } from "./roots.js";
import {
  isLocalAgentProvider,
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProfile,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";
import type { SubagentProviderConfig } from "./local-agent-config.js";

export interface ParsedLocalAgentRunArgs {
  target: string;
  prompt: string;
  promptFile?: string;
  model?: string;
  effort?: string;
}

export interface ParsedLocalAgentContinueArgs {
  agentId: string;
  prompt: string;
  promptFile?: string;
  model?: string;
  effort?: string;
}

export type LocalAgentTarget =
  | {
      kind: "profile";
      name: string;
      provider: LocalAgentProvider;
      model?: string;
      effort?: string;
      profile: LocalAgentProfile;
    }
  | {
      kind: "provider";
      name: LocalAgentProvider;
      provider: LocalAgentProvider;
      model?: string;
      effort?: string;
    };

export function parseLocalAgentRunArgs(args: string[]): ParsedLocalAgentRunArgs {
  const parsed = parseAgentPromptArgs(
    args,
    'Usage: devspace agents run <profile-or-provider> [--model <model>] [--effort <level>] ("<prompt>" | --prompt-file <path>)',
  );
  return parsed;
}

export function parseLocalAgentContinueArgs(args: string[]): ParsedLocalAgentContinueArgs {
  const parsed = parseAgentPromptArgs(
    args,
    'Usage: devspace agents continue <id> [--model <model>] [--effort <level>] ("<prompt>" | --prompt-file <path>)',
  );
  const { target, ...options } = parsed;
  return { agentId: target, ...options };
}

function parseAgentPromptArgs(
  args: string[],
  usage: string,
): ParsedLocalAgentRunArgs {
  const [target, ...rest] = args;
  if (!target) {
    throw new Error(usage);
  }

  let model: string | undefined;
  let effort: string | undefined;
  let promptFile: string | undefined;
  const promptParts: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index];
    if (!optionsEnded && part === "--") {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded) {
      promptParts.push(part ?? "");
      continue;
    }
    if (part === "--prompt-file" || part?.startsWith("--prompt-file=")) {
      if (promptFile !== undefined) throw new Error("Duplicate option: --prompt-file.");
      promptFile = part === "--prompt-file"
        ? parseOptionValue(rest[++index], "--prompt-file")
        : parseOptionValue(part.slice("--prompt-file=".length), "--prompt-file");
      continue;
    }
    if (part === "--model") {
      const value = parseOptionValue(rest[index + 1], "--model");
      model = value;
      index += 1;
      continue;
    }
    if (part?.startsWith("--model=")) {
      const value = parseOptionValue(part.slice("--model=".length), "--model");
      model = value;
      continue;
    }
    if (part === "--effort") {
      const value = parseOptionValue(rest[index + 1], "--effort");
      effort = value;
      index += 1;
      continue;
    }
    if (part?.startsWith("--effort=")) {
      const value = parseOptionValue(part.slice("--effort=".length), "--effort");
      effort = value;
      continue;
    }
    if (part?.startsWith("-")) {
      throw unknownOptionError(part);
    }
    promptParts.push(part ?? "");
  }

  const prompt = promptParts.join(" ").trim();
  if (promptFile !== undefined && promptParts.length > 0) {
    throw new Error("Use either an inline prompt or --prompt-file, not both.");
  }
  if (!prompt && promptFile === undefined) {
    throw new Error(usage);
  }

  return { target, prompt, model, effort, ...(promptFile !== undefined ? { promptFile } : {}) };
}

const MAX_PROMPT_FILE_BYTES = 64 * 1024;

/** Read only after the CLI has resolved the workspace that will receive the task. */
export async function resolveLocalAgentPrompt(
  args: Pick<ParsedLocalAgentRunArgs, "prompt" | "promptFile">,
  workspaceRoot: string,
): Promise<string> {
  if (args.promptFile === undefined) return args.prompt;
  const root = canonicalAllowedPath(workspaceRoot);
  const filePath = canonicalAllowedPath(resolveAllowedPath(args.promptFile, root, [root]));
  const entry = await stat(filePath).catch(() => {
    throw new Error("Unable to open --prompt-file as a readable file inside the current workspace.");
  });
  // Do not open special files such as FIFOs, which can block before fstat().
  if (!entry.isFile()) throw new Error("--prompt-file must be a regular file.");
  let file;
  try {
    file = await open(filePath, "r");
  } catch {
    throw new Error("Unable to open --prompt-file as a readable file inside the current workspace.");
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("--prompt-file must be a regular file.");
    if (stat.size > MAX_PROMPT_FILE_BYTES) throw new Error("--prompt-file exceeds the 64 KiB limit.");
    // A bounded read also caps allocations if the file grows after stat().
    const bytes = Buffer.alloc(MAX_PROMPT_FILE_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await file.read(bytes, total, bytes.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_PROMPT_FILE_BYTES) throw new Error("--prompt-file exceeds the 64 KiB limit.");
    let prompt;
    try {
      prompt = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, total));
    } catch {
      throw new Error("--prompt-file must contain valid UTF-8 text.");
    }
    if (!prompt.trim()) throw new Error("--prompt-file must not be empty or whitespace-only.");
    return prompt;
  } finally {
    await file.close();
  }
}

function parseOptionValue(value: string | undefined, option: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`Missing value for ${option}.`);
  if (trimmed.startsWith("-")) throw unknownOptionError(trimmed);
  return trimmed;
}

function unknownOptionError(option: string): Error {
  return new Error(`Unknown option: ${option}. Use -- before prompt text that starts with a dash.`);
}

export function resolveLocalAgentTarget(
  target: string,
  profiles: LocalAgentProfile[],
  modelOverride?: string,
  effortOverride?: string,
  providerConfigs: readonly SubagentProviderConfig[] = [],
): LocalAgentTarget | undefined {
  const explicitProvider = target.startsWith("provider:");
  if (explicitProvider) target = target.slice("provider:".length);
  const profile = explicitProvider ? undefined : profiles.find((candidate) => candidate.name === target);
  if (profile) {
    const providerConfig = providerConfigs.find((entry) => entry.id === profile.provider);
    return {
      kind: "profile",
      name: profile.name,
      provider: profile.provider,
      model: modelOverride ?? profile.model ?? providerConfig?.model,
      effort: effortOverride ?? profile.effort ?? providerConfig?.effort,
      profile,
    };
  }

  if (isLocalAgentProvider(target)) {
    const providerConfig = providerConfigs.find((entry) => entry.id === target);
    return {
      kind: "provider",
      name: target,
      provider: target,
      model: modelOverride ?? providerConfig?.model,
      effort: effortOverride ?? providerConfig?.effort,
    };
  }

  return undefined;
}
