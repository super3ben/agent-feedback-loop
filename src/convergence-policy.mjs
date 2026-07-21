import { types } from "node:util";

import { digestDecisionBasis } from "./convergence-identity.mjs";

export const DECISIONS = Object.freeze([
  "pass",
  "warn",
  "reflection_required",
  "checkpoint_required",
  "hold",
  "human_decision",
  "finish"
]);

export const BREAKER_REASONS = Object.freeze([
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
  "probe_direction_checkpoint",
  "probe_human_decision",
  "verified_acceptance_complete",
  "basis_changed_or_scope_aligned"
]);

export const GRANT_PURPOSES = Object.freeze([
  "local_fix",
  "exploration",
  "simplify",
  "rollback",
  "architecture_fix"
]);

export const ADAPTER_CAPABILITIES = Object.freeze([
  "audit_only",
  "checkpoint_gate",
  "workflow_gate",
  "tool_gate"
]);

const POLICY_REVISION = "convergence-policy-v2";
const MAX_COLLECTION_LENGTH = 128;
const MAX_TEXT_LENGTH = 2_048;
const MAX_COUNTER = 1_000_000;
const IDENTIFIER = /^[a-z][a-z0-9_-]{0,127}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

const IMPORTANCE = new Set(["routine", "important", "critical"]);
const AUTHORITIES = new Set([
  "explicit_user",
  "approved_spec",
  "approved_plan",
  "verified_runtime",
  "review_finding",
  "inferred_advisory"
]);
const HARD_AUTHORITIES = new Set(["explicit_user", "approved_spec", "approved_plan", "verified_runtime"]);
const EVIDENCE_QUALITIES = new Set(["none", "partial", "verified"]);
const CAPABILITIES = new Set(ADAPTER_CAPABILITIES);
const PURPOSES = new Set(GRANT_PURPOSES);
const PROBE_ACTIONS = new Set([
  "continue_once", "simplify_current_generation", "rollback_to_generation",
  "direction_checkpoint", "human_decision", "finish_now"
]);

const REQUEST_FIELDS = new Set([
  "adapterCapability",
  "contract",
  "previousDecisionBasisDigest",
  "decisionBasisDigest",
  "currentGeneration",
  "requestedGeneration",
  "failureCount",
  "lastGrantPurpose",
  "acceptanceSatisfied",
  "addsArchitecture",
  "touchesExplicitExclusion",
  "oscillationDetected",
  "sameInvariant",
  "explorationRequested",
  "explorationUsed",
  "riskHypothesis",
  "falsificationTest",
  "evidenceQuality",
  "evidenceChanged",
  "fileSaveCount",
  "semanticRecommendation",
  "probeAction"
]);

const CONTRACT_FIELDS = new Set([
  "sourceKind",
  "sourceRefDigest",
  "sourceRevision",
  "requirements",
  "exclusions",
  "importance",
  "importanceAuthority",
  "revision"
]);
const CLAUSE_FIELDS = new Set(["id", "authority", "hard"]);
const SEMANTIC_FIELDS = new Set(["importance", "failureCount", "wording"]);

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function recordValues(value, allowedFields, invalidCode, unknownCode) {
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw coded(invalidCode);
  }

  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedFields.has(key)) throw coded(unknownCode);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined
      || !Object.hasOwn(descriptor, "value")
      || Object.hasOwn(descriptor, "get")
      || Object.hasOwn(descriptor, "set")
      || !descriptor.enumerable) {
      throw coded(invalidCode);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function arrayValues(value, invalidCode) {
  if (!Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > MAX_COLLECTION_LENGTH) {
    throw coded(invalidCode);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) throw coded(invalidCode);
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
      throw coded(invalidCode);
    }
    result.push(descriptor.value);
  }
  return result;
}

function required(record, field, code = "missing_request_field") {
  if (!Object.hasOwn(record, field)) throw coded(code);
  return record[field];
}

function boundedIdentifier(value, code) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw coded(code);
  return value;
}

function boundedDigest(value, code = "invalid_decision_basis_digest") {
  if (typeof value !== "string" || !DIGEST.test(value)) throw coded(code);
  return value;
}

function boundedCounter(value, code) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_COUNTER) throw coded(code);
  return value;
}

function booleanValue(value, code) {
  if (typeof value !== "boolean") throw coded(code);
  return value;
}

function optionalText(value, code) {
  if (value === null) return null;
  if (typeof value !== "string" || value.includes("\0") || value.length > MAX_TEXT_LENGTH) throw coded(code);
  return value;
}

function enumValue(value, values, code) {
  if (typeof value !== "string" || !values.has(value)) throw coded(code);
  return value;
}

function validateClause(input) {
  const value = recordValues(input, CLAUSE_FIELDS, "invalid_contract_clause", "unknown_contract_clause_field");
  const id = boundedIdentifier(required(value, "id", "missing_contract_clause_field"), "invalid_contract_clause_id");
  const authority = enumValue(
    required(value, "authority", "missing_contract_clause_field"),
    AUTHORITIES,
    "invalid_importance_authority"
  );
  const hard = booleanValue(required(value, "hard", "missing_contract_clause_field"), "invalid_contract_clause_hard");
  if (hard !== HARD_AUTHORITIES.has(authority)) throw coded("invalid_contract_clause_hard");
  return Object.freeze({ id, authority, hard });
}

function validateContract(input) {
  const value = recordValues(input, CONTRACT_FIELDS, "invalid_contract_projection", "unknown_contract_field");
  const requirements = Object.freeze(arrayValues(
    required(value, "requirements", "missing_contract_field"),
    "invalid_contract_requirements"
  ).map(validateClause));
  const exclusions = Object.freeze(arrayValues(
    required(value, "exclusions", "missing_contract_field"),
    "invalid_contract_exclusions"
  ).map(validateClause));
  const importanceAuthority = enumValue(
    required(value, "importanceAuthority", "missing_contract_field"),
    AUTHORITIES,
    "invalid_importance_authority"
  );
  const declaredImportance = enumValue(
    required(value, "importance", "missing_contract_field"),
    IMPORTANCE,
    "invalid_importance"
  );
  const canonical = Object.freeze({
    sourceKind: boundedIdentifier(required(value, "sourceKind", "missing_contract_field"), "invalid_contract_source_kind"),
    sourceRefDigest: boundedDigest(required(value, "sourceRefDigest", "missing_contract_field"), "invalid_contract_source_digest"),
    sourceRevision: boundedIdentifier(
      required(value, "sourceRevision", "missing_contract_field"),
      "invalid_contract_source_revision"
    ),
    requirements,
    exclusions,
    importance: declaredImportance,
    importanceAuthority
  });
  const revision = boundedDigest(required(value, "revision", "missing_contract_field"), "invalid_contract_revision");
  if (digestDecisionBasis(canonical) !== revision) throw coded("contract_revision_mismatch");

  return Object.freeze({
    ...canonical,
    importance: HARD_AUTHORITIES.has(importanceAuthority) ? declaredImportance : "routine",
    revision
  });
}

function validateSemanticRecommendation(input) {
  if (input === null) return null;
  const value = recordValues(
    input,
    SEMANTIC_FIELDS,
    "invalid_semantic_recommendation",
    "unknown_semantic_recommendation_field"
  );
  const result = {};
  if (Object.hasOwn(value, "importance")) {
    result.importance = enumValue(value.importance, IMPORTANCE, "invalid_importance");
  }
  if (Object.hasOwn(value, "failureCount")) {
    result.failureCount = boundedCounter(value.failureCount, "invalid_failure_count");
  }
  if (Object.hasOwn(value, "wording")) {
    result.wording = optionalText(value.wording, "invalid_semantic_wording");
  }
  return Object.freeze(result);
}

function validateRequest(input) {
  const value = recordValues(input, REQUEST_FIELDS, "invalid_convergence_request", "unknown_request_field");
  const adapterCapability = enumValue(
    required(value, "adapterCapability"),
    CAPABILITIES,
    "invalid_adapter_capability"
  );
  const contract = validateContract(required(value, "contract"));
  const previousDecisionBasisDigest = boundedDigest(required(value, "previousDecisionBasisDigest"));
  const decisionBasisDigest = boundedDigest(required(value, "decisionBasisDigest"));
  const evidenceChanged = booleanValue(required(value, "evidenceChanged"), "invalid_evidence_changed");
  if (evidenceChanged !== (previousDecisionBasisDigest !== decisionBasisDigest)) {
    throw coded("inconsistent_evidence_change");
  }

  const currentGeneration = boundedCounter(required(value, "currentGeneration"), "invalid_generation");
  const requestedGeneration = boundedCounter(required(value, "requestedGeneration"), "invalid_generation");
  if (requestedGeneration < currentGeneration || requestedGeneration > currentGeneration + 1) {
    throw coded("invalid_generation_transition");
  }

  const lastGrantPurpose = required(value, "lastGrantPurpose");
  if (lastGrantPurpose !== null) enumValue(lastGrantPurpose, PURPOSES, "invalid_grant_purpose");
  const evidenceQuality = enumValue(
    required(value, "evidenceQuality"),
    EVIDENCE_QUALITIES,
    "invalid_evidence_quality"
  );

  return Object.freeze({
    adapterCapability,
    contract,
    previousDecisionBasisDigest,
    decisionBasisDigest,
    currentGeneration,
    requestedGeneration,
    failureCount: boundedCounter(required(value, "failureCount"), "invalid_failure_count"),
    lastGrantPurpose,
    acceptanceSatisfied: booleanValue(required(value, "acceptanceSatisfied"), "invalid_acceptance_state"),
    addsArchitecture: booleanValue(required(value, "addsArchitecture"), "invalid_architecture_state"),
    touchesExplicitExclusion: booleanValue(
      required(value, "touchesExplicitExclusion"),
      "invalid_exclusion_state"
    ),
    oscillationDetected: booleanValue(required(value, "oscillationDetected"), "invalid_oscillation_state"),
    sameInvariant: booleanValue(required(value, "sameInvariant"), "invalid_invariant_state"),
    explorationRequested: booleanValue(
      required(value, "explorationRequested"),
      "invalid_exploration_state"
    ),
    explorationUsed: booleanValue(required(value, "explorationUsed"), "invalid_exploration_state"),
    riskHypothesis: optionalText(required(value, "riskHypothesis"), "invalid_risk_hypothesis"),
    falsificationTest: optionalText(required(value, "falsificationTest"), "invalid_falsification_test"),
    evidenceQuality,
    evidenceChanged,
    fileSaveCount: boundedCounter(required(value, "fileSaveCount"), "invalid_file_save_count"),
    semanticRecommendation: validateSemanticRecommendation(required(value, "semanticRecommendation")),
    probeAction: value.probeAction === undefined || value.probeAction === null
      ? null
      : enumValue(value.probeAction, PROBE_ACTIONS, "invalid_probe_action")
  });
}

function trigger(decision, reasonCode, evidenceRequired = false) {
  return Object.freeze({ decision, reasonCode, evidenceRequired });
}

function explicitExclusionTouched(value) {
  return value.touchesExplicitExclusion
    ? trigger("reflection_required", "explicit_exclusion_touched", true)
    : null;
}

function architectureFixFailed(value) {
  return value.lastGrantPurpose === "architecture_fix" && value.failureCount >= 3
    ? trigger("human_decision", "architecture_fix_failed")
    : null;
}

function repeatedReviewInvariant(value) {
  return value.failureCount >= 2
    ? trigger("checkpoint_required", "repeated_review_invariant")
    : null;
}

function resolvedProbeDirection(value) {
  if (value.evidenceQuality !== "verified") return null;
  if (value.probeAction === "direction_checkpoint") {
    return trigger("checkpoint_required", "probe_direction_checkpoint");
  }
  if (value.probeAction === "human_decision") {
    return trigger("human_decision", "probe_human_decision");
  }
  if (value.probeAction === "finish_now" && value.acceptanceSatisfied) {
    return trigger("finish", "verified_acceptance_complete");
  }
  return null;
}

function acceptanceSatisfiedScopeExpansion(value) {
  return value.acceptanceSatisfied && value.addsArchitecture
    ? trigger("reflection_required", "acceptance_satisfied_scope_expansion")
    : null;
}

function unjustifiedArchitectureExpansion(value) {
  return value.addsArchitecture
    ? trigger("reflection_required", "unjustified_architecture_expansion", true)
    : null;
}

function oscillation(value) {
  return value.oscillationDetected
    ? trigger("reflection_required", "oscillation", true)
    : null;
}

function evidenceFreeSameInvariant(value) {
  return value.sameInvariant
    && value.requestedGeneration === value.currentGeneration + 1
    && value.evidenceQuality !== "verified"
    ? trigger("reflection_required", "evidence_free_same_invariant")
    : null;
}

function unchangedBasisRepeatedMutation(value) {
  return value.requestedGeneration === value.currentGeneration + 1 && !value.evidenceChanged
    ? trigger("reflection_required", "unchanged_basis_repeated_mutation")
    : null;
}

function explorationBudget(value) {
  if (value.contract.importance !== "important" || !value.explorationRequested) return null;
  const hasHypothesis = typeof value.riskHypothesis === "string" && value.riskHypothesis.trim().length > 0;
  const hasFalsification = typeof value.falsificationTest === "string" && value.falsificationTest.trim().length > 0;
  return !value.explorationUsed && hasHypothesis && hasFalsification
    ? trigger("pass", "exploration_grant_available")
    : trigger("checkpoint_required", "exploration_budget_exhausted");
}

function criticalEvidenceMissing(value) {
  return value.contract.importance === "critical"
    && (!value.evidenceChanged || value.evidenceQuality !== "verified")
    ? trigger("checkpoint_required", "critical_evidence_required")
    : null;
}

function firstTrigger(candidates) {
  return candidates.find((candidate) => candidate !== null) ?? null;
}

function clampDecision(requestedDecision, adapterCapability) {
  if (adapterCapability !== "audit_only") return requestedDecision;
  return requestedDecision === "pass" || requestedDecision === "warn" ? requestedDecision : "warn";
}

function enforcementFor(decision, adapterCapability) {
  if (decision === "pass") return "none";
  if (decision === "warn") return "warn_only";
  return {
    checkpoint_gate: "stop_next_checkpoint",
    workflow_gate: "stop_review_fix_dispatch",
    tool_gate: "stop_pre_mutation"
  }[adapterCapability];
}

function makeDecision(requestedDecision, reasonCode, value) {
  const effectiveDecision = clampDecision(requestedDecision, value.adapterCapability);
  return Object.freeze({
    decision: effectiveDecision,
    requestedDecision,
    reasonCode,
    enforcement: enforcementFor(effectiveDecision, value.adapterCapability),
    probeRequired: requestedDecision === "reflection_required",
    policyRevision: POLICY_REVISION
  });
}

export function evaluateConvergence(request) {
  const value = validateRequest(request);
  const matched = firstTrigger([
    explicitExclusionTouched(value),
    architectureFixFailed(value),
    repeatedReviewInvariant(value),
    resolvedProbeDirection(value),
    acceptanceSatisfiedScopeExpansion(value),
    unjustifiedArchitectureExpansion(value),
    oscillation(value),
    evidenceFreeSameInvariant(value),
    unchangedBasisRepeatedMutation(value),
    explorationBudget(value),
    criticalEvidenceMissing(value)
  ]);
  if (matched === null) return makeDecision("pass", "basis_changed_or_scope_aligned", value);
  const requestedDecision = matched.evidenceRequired && value.evidenceQuality !== "verified"
    ? "warn"
    : matched.decision;
  return makeDecision(requestedDecision, matched.reasonCode, value);
}

const STATES = Object.freeze([
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
  "human_decision",
  "terminal"
]);
const STATE_SET = new Set(STATES);
const PRESERVING_EVENTS = new Set([
  "contract_projected",
  "evidence_recorded",
  "review_recorded",
  "alias_declared",
  "distinct_declared",
  "shadow_compared",
  "legacy_imported"
]);
const STATE_CHANGING_EDGES = Object.freeze([
  ["idle", "generation_opened", "active_generation"],
  ["generation_closed", "generation_opened", "active_generation"],
  ["active_generation", "generation_closed", "generation_closed"],
  ...["active_generation", "generation_closed"].flatMap((from) => [
    [from, "breaker_triggered", "reflection_required"],
    [from, "breaker_triggered", "checkpoint_required"],
    [from, "breaker_triggered", "human_decision"],
    [from, "breaker_triggered", "terminal"]
  ]),
  ...["checkpoint_required", "human_decision", "terminal"].map((to) => [
    "reflection_resolved", "breaker_triggered", to
  ]),
  ["reflection_required", "reflection_requested", "probe_pending"],
  ["probe_pending", "reflection_claimed", "probe_running"],
  ...["probe_pending", "probe_running"].flatMap((from) => [
    [from, "reflection_failed", "reflection_required"],
    [from, "reflection_failed", "checkpoint_required"],
    [from, "reflection_failed", "human_decision"]
  ]),
  ...["reflection_resolved", "checkpoint_required", "human_decision", "terminal"].map((to) => [
    "probe_running", "reflection_completed", to
  ]),
  ["checkpoint_required", "checkpoint_recorded", "direction_approved"],
  ...["generation_closed", "reflection_resolved", "direction_approved"].map((from) => [
    from, "grant_issued", "grant_ready"
  ]),
  ["grant_ready", "grant_consumed", "active_generation"],
  ["grant_ready", "grant_revoked", "generation_closed"]
]);
const EDGE_SET = new Set(STATE_CHANGING_EDGES.map((edge) => edge.join("\0")));
const EVENT_SET = new Set([
  ...PRESERVING_EVENTS,
  ...STATE_CHANGING_EDGES.map(([, eventType]) => eventType),
  "task_resolved"
]);
const TRANSITION_FIELDS = new Set(["from", "eventType", "to"]);

export function validateTransition(input) {
  const value = recordValues(input, TRANSITION_FIELDS, "invalid_transition_request", "unknown_transition_field");
  const from = required(value, "from", "missing_transition_field");
  const eventType = required(value, "eventType", "missing_transition_field");
  const to = required(value, "to", "missing_transition_field");
  if (!STATE_SET.has(from) || !STATE_SET.has(to)) throw coded("unknown_transition_state");
  if (!EVENT_SET.has(eventType)) throw coded("unknown_transition_event");

  const allowed = PRESERVING_EVENTS.has(eventType)
    ? from !== "terminal" && from === to
    : eventType === "task_resolved"
      ? from !== "terminal" && to === "terminal"
      : EDGE_SET.has([from, eventType, to].join("\0"));
  if (!allowed) throw coded("invalid_transition");
  return true;
}
