export type IntentComplexity = "routine" | "complex";

export type IntentDomain =
  | "architecture"
  | "refactor"
  | "security"
  | "concurrency"
  | "migration"
  | "root_cause";

export interface CanonicalIntent {
  objective: string;
  complexity: IntentComplexity;
  domains: IntentDomain[];
  signals: {
    longInput: boolean;
    matchedDomains: IntentDomain[];
  };
}

const DOMAIN_PATTERNS: ReadonlyArray<[IntentDomain, RegExp]> = [
  ["architecture", /architect|architecture|架构/i],
  ["refactor", /refactor|重构/i],
  ["security", /security|secure|安全/i],
  ["concurrency", /concurren|并发/i],
  ["migration", /migrat|迁移/i],
  ["root_cause", /root[\s-]?cause|根因/i],
];

/**
 * Canonical Intent IR v1.
 *
 * This deliberately captures only deterministic routing signals that DevSpace
 * can verify locally. It does not infer permissions, user identity, provider
 * availability, or whether an operation is safe to execute.
 */
export function canonicalizeIntent(objective: string): CanonicalIntent {
  const normalized = objective.trim();
  const matchedDomains = DOMAIN_PATTERNS
    .filter(([, pattern]) => pattern.test(normalized))
    .map(([domain]) => domain);
  const longInput = objective.length > 4_000;
  const complexity: IntentComplexity = longInput || matchedDomains.length > 0
    ? "complex"
    : "routine";

  return {
    objective: normalized,
    complexity,
    domains: [...matchedDomains],
    signals: { longInput, matchedDomains: [...matchedDomains] },
  };
}
