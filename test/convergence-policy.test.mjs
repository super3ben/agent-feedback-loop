import assert from "node:assert/strict";
import { test } from "node:test";

import { digestDecisionBasis, projectContract } from "../src/convergence-identity.mjs";
import {
  ADAPTER_CAPABILITIES,
  BREAKER_REASONS,
  DECISIONS,
  GRANT_PURPOSES,
  evaluateConvergence,
  validateTransition
} from "../src/convergence-policy.mjs";

const BASIS_A = digestDecisionBasis({ verifiedEvidence: ["acceptance-1"] });
const BASIS_B = digestDecisionBasis({ verifiedEvidence: ["acceptance-1", "runtime-2"] });

function contract(importance = "routine", importanceAuthority = "explicit_user") {
  return projectContract({
    sourceKind: "approved_task",
    sourceRef: "task-2",
    sourceRevision: "rev-1",
    requirements: [{ id: "deterministic-policy", authority: "approved_plan" }],
    exclusions: [{ id: "no-runtime-integration", authority: "explicit_user" }],
    importance,
    importanceAuthority
  });
}

function request(overrides = {}) {
  const evidenceChanged = overrides.evidenceChanged ?? true;
  return {
    adapterCapability: "workflow_gate",
    contract: contract(),
    previousDecisionBasisDigest: BASIS_A,
    decisionBasisDigest: evidenceChanged ? BASIS_B : BASIS_A,
    currentGeneration: 1,
    requestedGeneration: 1,
    failureCount: 0,
    lastGrantPurpose: null,
    acceptanceSatisfied: false,
    addsArchitecture: false,
    touchesExplicitExclusion: false,
    oscillationDetected: false,
    sameInvariant: false,
    explorationRequested: false,
    explorationUsed: false,
    riskHypothesis: null,
    falsificationTest: null,
    evidenceQuality: "verified",
    evidenceChanged,
    fileSaveCount: 0,
    semanticRecommendation: null,
    ...overrides
  };
}

function routine(overrides = {}) {
  return request(overrides);
}

function sdd(overrides = {}) {
  return request({ adapterCapability: "workflow_gate", ...overrides });
}

function important(overrides = {}) {
  return request({
    contract: contract("important", "approved_spec"),
    explorationRequested: true,
    ...overrides
  });
}

function critical(overrides = {}) {
  return request({
    contract: contract("critical", "verified_runtime"),
    ...overrides
  });
}

function generic(overrides = {}) {
  return request({ adapterCapability: "audit_only", ...overrides });
}

function enforcementFor(decision, capability) {
  if (decision === "pass") return "none";
  if (decision === "warn") return "warn_only";
  return {
    checkpoint_gate: "stop_next_checkpoint",
    workflow_gate: "stop_review_fix_dispatch",
    tool_gate: "stop_pre_mutation"
  }[capability];
}

function expectedDecision(input, decision, reasonCode, requestedDecision = decision) {
  return {
    decision,
    requestedDecision,
    reasonCode,
    enforcement: enforcementFor(decision, input.adapterCapability),
    probeRequired: requestedDecision === "reflection_required",
    policyRevision: "convergence-policy-v1"
  };
}

const cases = [
  [
    "routine first scope expansion",
    routine({ acceptanceSatisfied: true, addsArchitecture: true, evidenceChanged: false }),
    "reflection_required",
    "acceptance_satisfied_scope_expansion"
  ],
  [
    "same basis next generation",
    routine({ currentGeneration: 1, requestedGeneration: 2, evidenceChanged: false }),
    "reflection_required",
    "unchanged_basis_repeated_mutation"
  ],
  [
    "same invariant second failure",
    sdd({ failureCount: 2 }),
    "checkpoint_required",
    "repeated_review_invariant"
  ],
  [
    "architecture failure",
    sdd({ failureCount: 3, lastGrantPurpose: "architecture_fix" }),
    "human_decision",
    "architecture_fix_failed"
  ],
  [
    "important first falsifiable exploration",
    important({
      explorationUsed: false,
      riskHypothesis: "atomic grant consumption may race",
      falsificationTest: "run two consumers"
    }),
    "pass",
    "exploration_grant_available"
  ],
  [
    "important second exploration",
    important({ explorationUsed: true }),
    "checkpoint_required",
    "exploration_budget_exhausted"
  ],
  [
    "critical without new evidence",
    critical({ evidenceChanged: false }),
    "checkpoint_required",
    "critical_evidence_required"
  ],
  [
    "generic weak evidence",
    generic({ addsArchitecture: true, evidenceQuality: "partial" }),
    "warn",
    "unjustified_architecture_expansion"
  ]
];

for (const [name, input, decision, reasonCode] of cases) {
  test(name, () => {
    assert.deepEqual(evaluateConvergence(input), expectedDecision(input, decision, reasonCode));
  });
}

test("evidence-free accepted routine expansion preserves requested reflection across adapter seams", () => {
  const shared = {
    acceptanceSatisfied: true,
    addsArchitecture: true,
    evidenceChanged: false,
    evidenceQuality: "none"
  };
  const workflow = routine(shared);
  const audit = routine({ ...shared, adapterCapability: "audit_only" });

  assert.deepEqual(
    evaluateConvergence(workflow),
    expectedDecision(workflow, "reflection_required", "acceptance_satisfied_scope_expansion")
  );
  assert.deepEqual(
    evaluateConvergence(
      audit
    ), expectedDecision(audit, "warn", "acceptance_satisfied_scope_expansion", "reflection_required"));
});

test("trigger priority is frozen and selects the first matching observable fact", () => {
  const priorityCases = [
    [
      {
        touchesExplicitExclusion: true,
        failureCount: 3,
        lastGrantPurpose: "architecture_fix",
        acceptanceSatisfied: true,
        addsArchitecture: true
      },
      "explicit_exclusion_touched"
    ],
    [
      { failureCount: 3, lastGrantPurpose: "architecture_fix", acceptanceSatisfied: true, addsArchitecture: true },
      "architecture_fix_failed"
    ],
    [{ failureCount: 2, acceptanceSatisfied: true, addsArchitecture: true }, "repeated_review_invariant"],
    [{ acceptanceSatisfied: true, addsArchitecture: true, oscillationDetected: true }, "acceptance_satisfied_scope_expansion"],
    [{ addsArchitecture: true, oscillationDetected: true }, "unjustified_architecture_expansion"],
    [
      { oscillationDetected: true, sameInvariant: true, requestedGeneration: 2, evidenceChanged: false },
      "oscillation"
    ],
    [
      {
        sameInvariant: true,
        requestedGeneration: 2,
        evidenceChanged: false,
        evidenceQuality: "none"
      },
      "evidence_free_same_invariant"
    ]
  ];

  for (const [overrides, reasonCode] of priorityCases) {
    assert.equal(evaluateConvergence(request(overrides)).reasonCode, reasonCode);
  }
});

test("a file save is not a generation and cannot consume convergence budget", () => {
  const input = request({ evidenceChanged: false, fileSaveCount: 14 });
  const result = evaluateConvergence(input);

  assert.equal(result.decision, "pass");
  assert.equal(result.reasonCode, "basis_changed_or_scope_aligned");
  assert.equal(Object.hasOwn(result, "generation"), false);
});

test("new verified evidence changes the basis and permits the requested next generation", () => {
  const input = request({ currentGeneration: 1, requestedGeneration: 2, evidenceChanged: true });

  assert.deepEqual(
    evaluateConvergence(input),
    expectedDecision(input, "pass", "basis_changed_or_scope_aligned")
  );
});

test("reviewer wording changes neither the basis nor repeated-mutation outcome", () => {
  const first = request({
    currentGeneration: 1,
    requestedGeneration: 2,
    evidenceChanged: false,
    semanticRecommendation: { wording: "retry with a wrapper" }
  });
  const second = request({
    currentGeneration: 1,
    requestedGeneration: 2,
    evidenceChanged: false,
    semanticRecommendation: { wording: "add a compatibility layer" }
  });

  assert.deepEqual(evaluateConvergence(first), evaluateConvergence(second));
  assert.equal(evaluateConvergence(first).reasonCode, "unchanged_basis_repeated_mutation");
});

test("semantic recommendations cannot raise importance or clear failure history", () => {
  const noEscalation = request({
    evidenceChanged: false,
    semanticRecommendation: { importance: "critical", failureCount: 0, wording: "critical retry" }
  });
  const retainedHistory = request({
    failureCount: 2,
    semanticRecommendation: { importance: "routine", failureCount: 0, wording: "start over" }
  });

  assert.equal(evaluateConvergence(noEscalation).reasonCode, "basis_changed_or_scope_aligned");
  assert.equal(evaluateConvergence(retainedHistory).reasonCode, "repeated_review_invariant");
});

test("only explicit, approved, or verified authority can preserve elevated importance", () => {
  const advisoryFields = {
    ...contract(),
    importance: "important",
    importanceAuthority: "review_finding"
  };
  delete advisoryFields.revision;
  const advisoryProjection = { ...advisoryFields, revision: digestDecisionBasis(advisoryFields) };
  const input = request({
    contract: advisoryProjection,
    explorationRequested: true,
    explorationUsed: false,
    riskHypothesis: "a semantic guess",
    falsificationTest: "run a bounded check"
  });

  assert.equal(evaluateConvergence(input).reasonCode, "basis_changed_or_scope_aligned");
});

test("important exploration requires both a bounded hypothesis and falsification test", () => {
  for (const partial of [
    { riskHypothesis: null, falsificationTest: "run two consumers" },
    { riskHypothesis: "atomic consumption may race", falsificationTest: null }
  ]) {
    const input = important(partial);
    assert.deepEqual(
      evaluateConvergence(input),
      expectedDecision(input, "checkpoint_required", "exploration_budget_exhausted")
    );
  }
});

test("critical generation requires changed verified evidence", () => {
  for (const overrides of [
    { evidenceChanged: false, evidenceQuality: "verified" },
    { evidenceChanged: true, evidenceQuality: "partial" }
  ]) {
    const input = critical(overrides);
    assert.equal(evaluateConvergence(input).reasonCode, "critical_evidence_required");
  }

  const input = critical({ evidenceChanged: true, evidenceQuality: "verified" });
  assert.equal(evaluateConvergence(input).decision, "pass");
});

test("adapter enforcement never claims authority beyond the real seam", () => {
  const expected = [
    ["audit_only", "warn", "warn_only"],
    ["checkpoint_gate", "reflection_required", "stop_next_checkpoint"],
    ["workflow_gate", "reflection_required", "stop_review_fix_dispatch"],
    ["tool_gate", "reflection_required", "stop_pre_mutation"]
  ];

  for (const [adapterCapability, decision, enforcement] of expected) {
    const input = request({ adapterCapability, acceptanceSatisfied: true, addsArchitecture: true });
    const result = evaluateConvergence(input);
    assert.equal(result.decision, decision);
    assert.equal(result.requestedDecision, "reflection_required");
    assert.equal(result.enforcement, enforcement);
    assert.equal(result.probeRequired, true);
  }
});

test("policy inputs are not mutated and decisions are frozen plain data", () => {
  const input = request({ acceptanceSatisfied: true, addsArchitecture: true });
  const before = structuredClone(input);
  Object.freeze(input);

  const result = evaluateConvergence(input);

  assert.deepEqual(input, before);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.isFrozen(result), true);
  assert.throws(() => {
    result.decision = "pass";
  }, TypeError);
});

test("public enums are frozen and contain the complete approved vocabulary", () => {
  assert.deepEqual(DECISIONS, [
    "pass", "warn", "reflection_required", "checkpoint_required", "hold", "human_decision", "finish"
  ]);
  assert.deepEqual(BREAKER_REASONS, [
    "explicit_exclusion_touched",
    "architecture_fix_failed",
    "repeated_review_invariant",
    "acceptance_satisfied_scope_expansion",
    "unjustified_architecture_expansion",
    "oscillation",
    "evidence_free_same_invariant",
    "unchanged_basis_repeated_mutation",
    "exploration_budget_exhausted",
    "critical_evidence_required",
    "exploration_grant_available",
    "basis_changed_or_scope_aligned"
  ]);
  assert.deepEqual(GRANT_PURPOSES, ["local_fix", "exploration", "simplify", "rollback", "architecture_fix"]);
  assert.deepEqual(ADAPTER_CAPABILITIES, ["audit_only", "checkpoint_gate", "workflow_gate", "tool_gate"]);
  for (const value of [DECISIONS, BREAKER_REASONS, GRANT_PURPOSES, ADAPTER_CAPABILITIES]) {
    assert.equal(Object.isFrozen(value), true);
  }
});

const stateChangingTransitions = [
  ["idle", "generation_opened", "active_generation"],
  ["generation_closed", "generation_opened", "active_generation"],
  ["active_generation", "generation_closed", "generation_closed"],
  ["active_generation", "breaker_triggered", "reflection_required"],
  ["generation_closed", "breaker_triggered", "checkpoint_required"],
  ["active_generation", "breaker_triggered", "human_decision"],
  ["generation_closed", "breaker_triggered", "terminal"],
  ["reflection_required", "reflection_requested", "probe_pending"],
  ["probe_pending", "reflection_claimed", "probe_running"],
  ["probe_pending", "reflection_failed", "reflection_required"],
  ["probe_pending", "reflection_failed", "checkpoint_required"],
  ["probe_pending", "reflection_failed", "human_decision"],
  ["probe_running", "reflection_completed", "reflection_resolved"],
  ["probe_running", "reflection_completed", "checkpoint_required"],
  ["probe_running", "reflection_completed", "human_decision"],
  ["probe_running", "reflection_completed", "terminal"],
  ["probe_running", "reflection_failed", "reflection_required"],
  ["probe_running", "reflection_failed", "checkpoint_required"],
  ["probe_running", "reflection_failed", "human_decision"],
  ["checkpoint_required", "checkpoint_recorded", "direction_approved"],
  ["generation_closed", "grant_issued", "grant_ready"],
  ["reflection_resolved", "grant_issued", "grant_ready"],
  ["direction_approved", "grant_issued", "grant_ready"],
  ["grant_ready", "grant_consumed", "active_generation"],
  ["grant_ready", "grant_revoked", "generation_closed"]
];

test("transition validator accepts every approved state-changing edge", () => {
  for (const [from, eventType, to] of stateChangingTransitions) {
    assert.equal(validateTransition({ from, eventType, to }), true);
  }
});

test("state-preserving events are accepted only in nonterminal states", () => {
  const events = [
    "contract_projected",
    "evidence_recorded",
    "review_recorded",
    "alias_declared",
    "distinct_declared",
    "shadow_compared",
    "legacy_imported"
  ];
  const states = [
    "idle",
    "active_generation",
    "generation_closed",
    "reflection_required",
    "probe_pending",
    "probe_running",
    "reflection_resolved",
    "checkpoint_required",
    "direction_approved",
    "grant_ready",
    "human_decision"
  ];

  for (const eventType of events) {
    for (const state of states) assert.equal(validateTransition({ from: state, eventType, to: state }), true);
    assert.throws(
      () => validateTransition({ from: "terminal", eventType, to: "terminal" }),
      (error) => error?.code === "invalid_transition"
    );
  }
});

test("task resolution reaches terminal from every nonterminal state", () => {
  const states = [
    "idle",
    "active_generation",
    "generation_closed",
    "reflection_required",
    "probe_pending",
    "probe_running",
    "reflection_resolved",
    "checkpoint_required",
    "direction_approved",
    "grant_ready",
    "human_decision"
  ];
  for (const from of states) assert.equal(validateTransition({ from, eventType: "task_resolved", to: "terminal" }), true);
});

test("unknown fields, enums, states, events, and undeclared transitions fail deterministically", () => {
  assert.throws(
    () => evaluateConvergence({ ...request(), surprise: true }),
    (error) => error?.code === "unknown_request_field" && error.message === "unknown_request_field"
  );
  assert.throws(
    () => evaluateConvergence(request({ adapterCapability: "imaginary_gate" })),
    (error) => error?.code === "invalid_adapter_capability"
  );
  assert.throws(
    () => validateTransition({ from: "missing", eventType: "generation_opened", to: "active_generation" }),
    (error) => error?.code === "unknown_transition_state"
  );
  assert.throws(
    () => validateTransition({ from: "idle", eventType: "unknown_event", to: "active_generation" }),
    (error) => error?.code === "unknown_transition_event"
  );
  assert.throws(
    () => validateTransition({ from: "idle", eventType: "generation_opened", to: "active_generation", extra: true }),
    (error) => error?.code === "unknown_transition_field"
  );
  assert.throws(
    () => validateTransition({ from: "idle", eventType: "generation_closed", to: "generation_closed" }),
    (error) => error?.code === "invalid_transition"
  );
});
