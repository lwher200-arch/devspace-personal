import { open } from "node:fs/promises";
import { constants } from "node:fs";

const MAX_ROLLOUT_BYTES = 64 * 1024 * 1024;
const counterNames = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens",
  "output_tokens", "reasoning_output_tokens", "total_tokens"] as const;
type Counter = typeof counterNames[number];
type Counters = Record<Counter, number | null>;
type RecordValue = Record<string, unknown>;

export interface TokenUsageReport {
  scope: "controller_turn";
  turnId: string | null;
  sampledAt: string;
  status: "complete" | "partial" | "unavailable";
  complete: boolean;
  responseCount: number;
  duplicateResponseCount: number;
  usage: Counters | null;
  uncachedInputTokens: number | null;
  providerTurnTotalMatches: boolean;
  operations: Array<{ callId: string; tool: string; resultRecorded: boolean; independentTokens: null }>;
  warnings: string[];
}

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function counters(value: unknown): Counters | undefined {
  const obj = record(value);
  if (!obj) return;
  const result = {} as Counters;
  for (const key of counterNames) {
    const n = obj[key];
    if (n === undefined && !["input_tokens", "output_tokens", "total_tokens"].includes(key)) result[key] = null;
    else if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) result[key] = n;
    else return;
  }
  if (result.total_tokens !== result.input_tokens! + result.output_tokens!) return;
  if ((result.cached_input_tokens ?? 0) + (result.cache_write_input_tokens ?? 0) > result.input_tokens! ||
    (result.reasoning_output_tokens ?? 0) > result.output_tokens!) return;
  return result;
}

/** Whitelist receipts and call metadata; never return prompts, arguments or tool outputs. */
export function parseTokenUsageReport(text: string, requestedTurnId?: string): TokenUsageReport {
  const rows: Array<{ line: number; type: unknown; payload: RecordValue }> = [];
  const warnings: string[] = [];
  const lines = text.replace(/^\uFEFF/, "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > 100_000) throw new Error("Select a rollout snapshot with at most 100,000 JSONL records.");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(lines[i]); }
    catch {
      // A writer may still be appending the final JSONL record. Never parse it
      // as a zero receipt or echo its potentially sensitive contents in errors.
      warnings.push(i === lines.length - 1 ? "Incomplete trailing record." : `Malformed JSONL record at line ${i + 1}.`);
      continue;
    }
    const row = record(parsed);
    if (row && record(row.payload)) rows.push({ line: i, type: row.type, payload: record(row.payload)! });
  }
  const starts = rows.filter(r => r.type === "event_msg" && r.payload.type === "task_started" && typeof r.payload.turn_id === "string");
  const receiptRows = rows.filter(r => r.type === "token_usage_record" && typeof r.payload.turn_id === "string");
  const latestId = starts.at(-1)?.payload.turn_id ?? receiptRows.at(-1)?.payload.turn_id;
  const turnId = requestedTurnId ?? (typeof latestId === "string" ? latestId : undefined);
  if (requestedTurnId && !rows.some(r => r.payload.turn_id === requestedTurnId)) throw new Error("Requested turn was not found in the supplied rollout.");
  const start = starts.find(r => r.payload.turn_id === turnId);
  const nextStart = start ? starts.find(r => r.line > start.line) : undefined;
  const completions = rows.filter(r => r.type === "event_msg" && r.payload.type === "task_complete" && r.payload.turn_id === turnId);
  const completed = completions.find(r => start && r.line > start.line && r.line < (nextStart?.line ?? Infinity));
  if (completions.some(r => !start || r.line <= start.line || r.line >= (nextStart?.line ?? Infinity))) warnings.push("Turn completion is outside its lifecycle boundary.");
  const endLine = Math.min(completed?.line ?? Infinity, nextStart?.line ?? Infinity);
  const sessionIds = new Set(rows.filter(r => r.type === "session_meta" && typeof r.payload.id === "string" && r.payload.id).map(r => r.payload.id));
  if (sessionIds.size !== 1) warnings.push("A unique controller session identity is unavailable.");
  const receipts = new Map<string, { usage: Counters; threadId: unknown }>();
  let duplicateResponseCount = 0;
  let providerTotal: Counters | undefined;
  for (const { payload: p, line } of receiptRows.filter(r => r.payload.turn_id === turnId)) {
    if (start && (line <= start.line || line > endLine || line >= (nextStart?.line ?? Infinity))) {
      warnings.push("Response receipt outside the selected turn boundary omitted.");
      continue;
    }
    if (typeof p.thread_id !== "string" || !p.thread_id || (sessionIds.size === 1 && !sessionIds.has(p.thread_id))) {
      warnings.push("Response receipt with missing or mismatched session identity omitted.");
      continue;
    }
    const value = counters(p.usage);
    if (!value || typeof p.response_id !== "string" || !p.response_id) {
      warnings.push("Invalid response receipt omitted.");
      continue;
    }
    const existing = receipts.get(p.response_id);
    if (existing) {
      if (JSON.stringify(existing.usage) !== JSON.stringify(value) || existing.threadId !== p.thread_id) {
        throw new Error("Conflicting duplicate response receipts; no total can be reported safely.");
      }
      duplicateResponseCount++;
      continue;
    }
    receipts.set(p.response_id, { usage: value, threadId: p.thread_id });
    providerTotal = counters(p.turn_token_usage);
  }
  let usage: Counters | null = null;
  if (receipts.size) {
    usage = {} as Counters;
    for (const key of counterNames) {
      const values = [...receipts.values()].map(r => r.usage[key]);
      const sum = values.some(v => v === null) ? null : values.reduce<number>((a, b) => a + b!, 0);
      if (sum !== null && !Number.isSafeInteger(sum)) throw new Error("Token total exceeds the safe integer range.");
      usage[key] = sum;
    }
  }
  const providerTurnTotalMatches = usage !== null && providerTotal !== undefined &&
    counterNames.every(k => usage![k] === providerTotal[k]);
  if (new Set([...receipts.values()].map(r => r.threadId)).size > 1) warnings.push("Selected receipts span multiple provider threads.");
  if (!usage) warnings.push("No canonical response usage receipts; legacy token_count snapshots are not added.");
  else if (!providerTurnTotalMatches) warnings.push("Response sum could not be reconciled with the provider turn total.");
  if (!completed) warnings.push("Turn is not finalized; final-response and unrecorded usage may be missing.");
  if (!start) warnings.push("Turn start boundary unavailable; calls cannot be assigned safely.");
  const calls = new Map<string, TokenUsageReport["operations"][number]>();
  const outputs = new Set<string>();
  for (const row of start ? rows.filter(r => r.line > start.line && r.line <= endLine) : []) {
    if (row.type !== "response_item") continue;
    const p = row.payload;
    if (typeof p.call_id !== "string") continue;
    if ((p.type === "function_call" || p.type === "custom_tool_call") && typeof p.name === "string") {
      calls.set(p.call_id, { callId: p.call_id, tool: p.name, resultRecorded: false, independentTokens: null });
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") outputs.add(p.call_id);
  }
  for (const call of calls.values()) call.resultRecorded = outputs.has(call.callId);
  if ([...calls.values()].some(c => !c.resultRecorded)) warnings.push("Some visible calls have no recorded result at the sampling boundary.");
  const complete = usage !== null && providerTurnTotalMatches && !!start && !!completed && warnings.length === 0;
  return {
    scope: "controller_turn", turnId: turnId ?? null, sampledAt: new Date().toISOString(),
    status: !usage ? "unavailable" : complete ? "complete" : "partial", complete,
    responseCount: receipts.size, duplicateResponseCount, usage,
    uncachedInputTokens: usage && usage.cached_input_tokens !== null && usage.cache_write_input_tokens !== null
      ? usage.input_tokens! - usage.cached_input_tokens - usage.cache_write_input_tokens : null,
    providerTurnTotalMatches, operations: [...calls.values()], warnings: [...new Set(warnings)],
  };
}

export async function readTokenUsageReport(path: string, turnId?: string): Promise<TokenUsageReport> {
  // Do not block on a named pipe before the regular-file check (POSIX).
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_ROLLOUT_BYTES) throw new Error("Select a regular rollout file of at most 64 MiB.");
    // Bound a growing live file to the size observed at open, using one handle.
    const buffer = Buffer.alloc(stat.size);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await file.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)); }
    catch { throw new Error("The supplied rollout is not a complete UTF-8 snapshot; retry after its writer flushes."); }
    return parseTokenUsageReport(text, turnId);
  } finally { await file.close(); }
}

export function formatTokenUsageReport(report: TokenUsageReport): string {
  const n = (value: number | null | undefined) => value === null || value === undefined ? "unavailable" : String(value);
  return [
    `Token usage (${report.status}; controller only)`, `Sampled: ${report.sampledAt}`,
    `Turn: ${report.turnId ?? "unavailable"}; responses: ${report.responseCount}; duplicate receipts: ${report.duplicateResponseCount}`,
    ...report.operations.map(c => `Call ${c.callId} (${c.tool}): result ${c.resultRecorded ? "recorded" : "not recorded"}; independent tokens unavailable`),
    `Input: ${n(report.usage?.input_tokens)}; cached input: ${n(report.usage?.cached_input_tokens)}; cache-write input: ${n(report.usage?.cache_write_input_tokens)}`,
    `Uncached input: ${n(report.uncachedInputTokens)}; output: ${n(report.usage?.output_tokens)}; reasoning output: ${n(report.usage?.reasoning_output_tokens)}`,
    `Total: ${n(report.usage?.total_tokens)}; delegated agents: not included`,
    "Cache/reasoning details are included in their parent counters; do not add them again.",
    ...report.warnings.map(w => `Coverage: ${w}`),
  ].join("\n");
}

export async function runUsageReportCommand(args: string[]): Promise<string> {
  const help = "Usage: devspace usage report --rollout <path> [--turn-id <id>] [--json]";
  if (args[0] !== "report") throw new Error(help);
  const options = new Map<string, string>();
  let json = false;
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (key === "--json" && !json) { json = true; continue; }
    if (!["--rollout", "--turn-id"].includes(key) || options.has(key) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(help);
    options.set(key, args[++i]);
  }
  if (!options.get("--rollout")) throw new Error(help);
  const report = await readTokenUsageReport(options.get("--rollout")!, options.get("--turn-id"));
  return json ? JSON.stringify(report) : formatTokenUsageReport(report);
}
