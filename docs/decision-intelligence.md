# Decision Intelligence

DevSpace can use external decision models as an advisory layer without moving
execution authority out of the local control plane.

The first adapter targets the TypeSafe System One HTTP API:

    POST https://api.typesafe.ai/v1/systemone
    Authorization: Bearer <API key>

The adapter supports Noul, Choice and Score, validates the outgoing request
shape, checks the returned answer ids/types/distributions, and follows the
official SDK retry envelope for connection/timeout failures, 408, 429 and
5xx responses.

## Authority boundary

Decision Intelligence never approves or executes an operation.

    evidence/context
          |
          v
    Decision Intelligence ---> advisory probabilities
          |
          v
    deterministic RCF / policy
          |
          v
    human approval when required
          |
          v
    A2 / Candidate execution boundary

RCF L0-L3 rules, approval capabilities, workspace leases, A2 checks,
promotion, rollback and break-glass remain authoritative. External confidence
must not override a deterministic hold, quarantine, freeze or Owner decision.

## Secret boundary

TypeSafeProvider receives its API key at construction time. The transport is
fixed to https://api.typesafe.ai/v1/systemone rather than accepting a
caller-supplied credential destination. DevSpace does not
persist the key in config.jsonc or auth.json, put it in Context Capsules, or
include it in provider errors.

Deployment wiring should obtain the credential from a process secret or secret
manager and pass it directly to the provider constructor. Do not commit it or
put it in task state, R2 context, logs, prompts or approval metadata.

Before transport, TypeSafeProvider automatically applies
redactForExternalProvider() to state and question content. It redacts values
under credential-like object keys and common inline credential forms (Bearer
tokens, API-key/token/secret assignments, TypeSafe-style apikey_ values and
PEM private keys), then returns the affected paths as observability metadata.
This is a bounded best-effort DLP layer, not a proof that arbitrary free-form
text contains no secret; callers should still minimize external state.

## Initial evaluation workflows

Two advisory workflows are provided:

- buildAgentTraceObservation(): permission breach, run outcome, review urgency.
- buildMutationRiskObservation(): scope drift, sensitive targets, boundary
  integrity and destructive breadth.

These outputs are observation evidence. They are not RCF risk levels and do
not grant authority.

benchmarkDecision() records observed call latency plus provider-reported input
and output token counts so Jev can be compared against other providers and
deterministic rules on the same labeled traces.

## Labeled benchmark harness

runDecisionBenchmark() evaluates one provider against explicit labeled cases.
Ground truth comes only from the fixture; provider confidence is never treated
as truth.

The report includes:

- exact decision accuracy;
- normalized per-answer Brier score;
- expected calibration error (ECE) over configurable bins;
- False-Safe and False-Alarm rates when the fixture explicitly labels unsafe
  semantics;
- Score mean absolute error when Score ground truth is present;
- mean and p95 observed latency;
- provider-reported input/output token totals;
- optional estimated USD cost from caller-supplied pricing.

Safety metrics are opt-in. A benchmark case must explicitly define the unsafe
Noul value, Choice labels, or Score threshold. If a relevant ground-truth
population is absent, the corresponding rate is null rather than invented.

For Choice questions, calibration uses the probability assigned to the
provider-selected Choice. For Score questions, exact accuracy and safety
classification use the highest-probability discrete Score level while Score
mean absolute error uses the provider's numeric score.

compareDecisionProviders() runs the same labeled cases across independent
DecisionIntelligenceProvider implementations. It returns one report per
provider and deliberately performs no automatic ranking, promotion or RCF
transition. Pricing is caller-supplied rather than hard-coded because provider
prices can change.
