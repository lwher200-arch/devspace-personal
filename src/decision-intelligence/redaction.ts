import type { JsonValue } from "./types.js";

const DEFAULT_SENSITIVE_KEY =
  /(?:^|[_-])(?:api[_-]?key|authorization|bearer|token|secret|password|passwd|cookie|credential|private[_-]?key|client[_-]?secret)(?:$|[_-])/i;

const INLINE_SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}\b/gi,
  /\bapikey_[A-Za-z0-9_-]{20,}\b/gi,
  /\b(?:api[_-]?key|token|secret|password|passwd|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{12,}["']?/gi,
];

export interface RedactionResult {
  value: JsonValue;
  redactedPaths: string[];
}

export interface RedactionOptions {
  replacement?: string;
  sensitiveKey?: RegExp;
}

export function redactForExternalProvider(
  value: JsonValue,
  options: RedactionOptions = {},
): RedactionResult {
  const replacement = options.replacement ?? "[REDACTED]";
  const sensitiveKey = options.sensitiveKey ?? DEFAULT_SENSITIVE_KEY;
  const redactedPaths: string[] = [];

  const visit = (current: JsonValue, path: string): JsonValue => {
    if (Array.isArray(current)) {
      return current.map((item, index) => visit(item, path + "[" + index + "]"));
    }
    if (current !== null && typeof current === "object") {
      const result: Record<string, JsonValue> = {};
      for (const [key, child] of Object.entries(current)) {
        const childPath = path ? path + "." + key : key;
        sensitiveKey.lastIndex = 0;
        if (sensitiveKey.test(key)) {
          result[key] = replacement;
          redactedPaths.push(childPath);
        } else {
          result[key] = visit(child, childPath);
        }
      }
      return result;
    }
    if (typeof current === "string") {
      let redacted = current;
      for (const pattern of INLINE_SECRET_PATTERNS) {
        pattern.lastIndex = 0;
        redacted = redacted.replace(pattern, replacement);
      }
      if (redacted !== current) {
        redactedPaths.push((path || "$") + "#inline");
      }
      return redacted;
    }
    return current;
  };

  return { value: visit(value, ""), redactedPaths };
}
