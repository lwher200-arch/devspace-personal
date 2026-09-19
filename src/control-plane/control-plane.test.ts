import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeIntent } from "./intent.js";
import { selectChimeraRoute } from "./chimera.js";
import { canRelaunchApproval, deliveryRecoveryPlan, RETURNFLOW_PHASES } from "./returnflow.js";

test("Canonical Intent IR exposes deterministic routing signals without authority inference", () => {
  const routine = canonicalizeIntent("Fix a typo");
  assert.equal(routine.complexity, "routine");
  assert.deepEqual(routine.domains, []);

  const complex = canonicalizeIntent("Security architecture root-cause review");
  assert.equal(complex.complexity, "complex");
  assert.deepEqual(complex.domains, ["architecture", "security", "root_cause"]);
});

test("Chimera routing selects only between supplied choices and carries no permission state", () => {
  const route = { routineModel: "routine", complexModel: "complex" };
  assert.deepEqual(selectChimeraRoute(canonicalizeIntent("Fix a typo"), route), {
    model: "routine", reason: "routine-task", intentClass: "routine",
  });
  assert.deepEqual(selectChimeraRoute(canonicalizeIntent("Refactor architecture"), route), {
    model: "complex", reason: "complex-task", intentClass: "complex",
  });
});

test("ReturnFlow fails closed on uncertain delivery and only relaunches an explicit denial", () => {
  assert.equal(canRelaunchApproval("denied"), true);
  assert.equal(canRelaunchApproval("failed"), false);
  assert.equal(deliveryRecoveryPlan("uncertain", false).canRepeatExecution, false);
  assert.equal(deliveryRecoveryPlan("accepted", true).canReadExistingTask, true);
  assert.deepEqual(RETURNFLOW_PHASES, [
    "observe", "diagnose", "counterfactual", "guard", "act", "verify", "anchor", "relaunch",
  ]);
});
