import type { App } from "@modelcontextprotocol/ext-apps";

export type ToolName = "open_workspace" | "show_changes";
export type HostContext = NonNullable<ReturnType<App["getHostContext"]>>;

export type ReviewFileType =
  | "change"
  | "rename-pure"
  | "rename-changed"
  | "new"
  | "deleted";

export interface ReviewPreview {
  complete?: boolean;
  includedFiles?: number;
  totalFiles?: number;
  omittedFiles?: number;
}

export interface ToolResultCard {
  tool: ToolName;
  workspaceId?: string;
  path?: string;
  root?: string;
  workspaceReused?: boolean;
  includeBootstrapContext?: boolean;
  mode?: "checkout" | "worktree";
  sourceRoot?: string;
  worktree?: {
    path?: string;
    baseRef?: string;
    baseSha?: string;
    dirtySource?: boolean;
    detached?: boolean;
    managed?: boolean;
  };
  review?:
    | { available: true }
    | { available: false; reason: string };
  summary?: Record<string, unknown>;
  files?: Array<{
    path?: string;
    previousPath?: string;
    type?: ReviewFileType;
    additions?: number;
    removals?: number;
  }>;
  preview?: ReviewPreview;
  payload?: { patch?: string };
  agentsFiles?: Array<{
    path?: string;
    content?: string;
  }>;
  availableAgentsFiles?: Array<{
    path?: string;
  }>;
  skills?: Array<{
    name?: string;
    description?: string;
    path?: string;
  }>;
  agentProviders?: Array<{
    id?: string;
    model?: string;
    effort?: string;
    note?: string;
  }>;
  agents?: Array<{
    name?: string;
    description?: string;
    provider?: string;
    model?: string;
    effort?: string;
  }>;
  instruction?: string;
}

export function summaryNumber(
  summary: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = summary?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function reviewPreviewFileCount(card: ToolResultCard): number {
  const fallback = card.files?.length ?? 0;
  const included = card.preview?.includedFiles;
  if (typeof included !== "number" || !Number.isInteger(included) || included < 0) return fallback;
  return Math.min(included, fallback);
}

export function reviewPreviewMessage(card: ToolResultCard): string | undefined {
  if (card.preview?.complete !== false) return undefined;
  const included = reviewPreviewFileCount(card);
  const totalValue = card.preview.totalFiles;
  const total = typeof totalValue === "number" && Number.isInteger(totalValue) && totalValue >= included
    ? totalValue
    : Math.max(included, card.files?.length ?? 0);
  const omittedValue = card.preview.omittedFiles;
  const omitted = typeof omittedValue === "number" && Number.isInteger(omittedValue) && omittedValue >= 0
    ? omittedValue
    : Math.max(0, total - included);
  return `Diff preview includes ${included} of ${total} changed ${total === 1 ? "file" : "files"}; ${omitted} ${omitted === 1 ? "file" : "files"} omitted by preview limits. File statistics are complete.`;
}

export function isExpandableCard(card: ToolResultCard): boolean {
  if (card.tool === "show_changes") {
    return Boolean(card.files?.length || card.payload?.patch);
  }

  return (
    Number(card.summary?.agentsFiles ?? 0) > 0 ||
    Number(card.summary?.skills ?? 0) > 0 ||
    Number(card.summary?.agentProviders ?? 0) > 0 ||
    Number(card.summary?.agents ?? 0) > 0 ||
    Boolean(card.agentsFiles?.length) ||
    Boolean(card.availableAgentsFiles?.length) ||
    Boolean(card.skills?.length) ||
    Boolean(card.agentProviders?.length) ||
    Boolean(card.agents?.length) ||
    Boolean(card.worktree) ||
    Boolean(card.instruction) ||
    card.review?.available === false
  );
}

export function isInitiallyExpandedCard(card: ToolResultCard): boolean {
  return isExpandableCard(card);
}
