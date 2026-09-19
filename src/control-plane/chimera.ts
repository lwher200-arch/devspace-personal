import type { CanonicalIntent } from "./intent.js";

export interface ChimeraDualRoute {
  routineModel: string;
  complexModel: string;
}

export interface ChimeraRouteDecision {
  model: string;
  reason: "routine-task" | "complex-task";
  intentClass: CanonicalIntent["complexity"];
}

/**
 * Chimera Protocol v1: deterministic route selection across approved choices.
 *
 * Routing is intentionally authority-neutral. This function cannot widen an
 * allowlist, grant writes, retry a failed execution, or change sandbox policy.
 */
export function selectChimeraRoute(
  intent: CanonicalIntent,
  route: ChimeraDualRoute,
): ChimeraRouteDecision {
  const complex = intent.complexity === "complex";
  return {
    model: complex ? route.complexModel : route.routineModel,
    reason: complex ? "complex-task" : "routine-task",
    intentClass: intent.complexity,
  };
}
