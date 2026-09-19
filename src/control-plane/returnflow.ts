export const RETURNFLOW_PHASES = [
  "observe",
  "diagnose",
  "counterfactual",
  "guard",
  "act",
  "verify",
  "anchor",
  "relaunch",
] as const;

export type ReturnFlowPhase = typeof RETURNFLOW_PHASES[number];

export function canRelaunchApproval(state: string): boolean {
  return state === "denied";
}

export interface DeliveryRecoveryPlan {
  phase: Extract<ReturnFlowPhase, "observe" | "anchor">;
  canReadExistingTask: boolean;
  canRepeatExecution: false;
  instruction: string;
}

/**
 * ReturnFlow/RCF recovery rule for an already-claimed provider delivery.
 * Unknown delivery never becomes evidence that repeating execution is safe.
 */
export function deliveryRecoveryPlan(state: string, hasAgentId: boolean): DeliveryRecoveryPlan {
  if (state === "accepted" && hasAgentId) {
    return {
      phase: "anchor",
      canReadExistingTask: true,
      canRepeatExecution: false,
      instruction: "Read the existing task status; do not submit the operation again.",
    };
  }
  return {
    phase: "observe",
    canReadExistingTask: false,
    canRepeatExecution: false,
    instruction: "Previous delivery is pending or uncertain. Reconcile existing tasks before deciding what to do; do not automatically repeat execution.",
  };
}
