import { types } from "node:util";

import { projectContract } from "./convergence-identity.mjs";

const MAX_COLLECTION_LENGTH = 128;
const MAX_SOURCE_REF_BYTES = 16_384;
const IDENTIFIER = /^[a-z][a-z0-9_-]{0,127}$/u;
const IMPORTANCE = new Set(["routine", "important", "critical"]);
const HARD_AUTHORITIES = new Set([
  "explicit_user", "approved_spec", "approved_plan", "verified_runtime"
]);
const OBSERVATION_KINDS = new Set(["prompt", "tool"]);
const CLAUSE_FIELDS = new Set(["id", "authority"]);
const COMMON_FIELDS = [
  "declaredRevision",
  "sourceRef",
  "requirements",
  "exclusions",
  "importance",
  "importanceAuthority"
];
const CHECKPOINT_FIELDS = [
  ...COMMON_FIELDS,
  "activeRevision",
  "approvalState",
  "approvalRevision",
  "approvalAuthority",
  "nativeTaskId"
];
const OPENSPEC_FIELDS = new Set(CHECKPOINT_FIELDS);
const COMET_FIELDS = new Set([...CHECKPOINT_FIELDS, "nativeChangeId"]);
const GENERIC_FIELDS = new Set([...COMMON_FIELDS, "observationKind", "nativeTaskId"]);

function coded(code) {
  return Object.assign(new Error(code), { code });
}

function recordValues(input, allowedFields) {
  if (input === null
      || typeof input !== "object"
      || Array.isArray(input)
      || types.isProxy(input)
      || Object.getPrototypeOf(input) !== Object.prototype) {
    throw coded("adapter_invalid_record");
  }
  const result = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowedFields.has(key)) {
      throw coded("adapter_unknown_field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined
        || !Object.hasOwn(descriptor, "value")
        || Object.hasOwn(descriptor, "get")
        || Object.hasOwn(descriptor, "set")
        || !descriptor.enumerable) {
      throw coded("adapter_invalid_record");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function arrayValues(input) {
  if (!Array.isArray(input)
      || types.isProxy(input)
      || Object.getPrototypeOf(input) !== Array.prototype
      || input.length > MAX_COLLECTION_LENGTH) {
    throw coded("adapter_invalid_collection");
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length !== input.length + 1) throw coded("adapter_invalid_collection");
  const result = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
      throw coded("adapter_invalid_collection");
    }
    result.push(descriptor.value);
  }
  return result;
}

function required(value, field) {
  if (!Object.hasOwn(value, field)) throw coded("adapter_missing_field");
  return value[field];
}

function identifier(value, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw coded("adapter_invalid_identifier");
  }
  return value;
}

function sourceRef(value) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\0")
      || Buffer.byteLength(value, "utf8") > MAX_SOURCE_REF_BYTES) {
    throw coded("adapter_invalid_source_ref");
  }
  return value;
}

function importance(value) {
  if (typeof value !== "string" || !IMPORTANCE.has(value)) {
    throw coded("adapter_invalid_importance");
  }
  return value;
}

function clauses(value) {
  return arrayValues(value).map((input) => {
    const clause = recordValues(input, CLAUSE_FIELDS);
    return {
      id: identifier(required(clause, "id")),
      authority: Object.hasOwn(clause, "authority")
        ? identifier(clause.authority)
        : "inferred_advisory"
    };
  });
}

function commonProjection(value) {
  const requirements = clauses(required(value, "requirements"));
  const exclusions = clauses(required(value, "exclusions"));
  const importanceAuthority = Object.hasOwn(value, "importanceAuthority")
    ? identifier(value.importanceAuthority)
    : "inferred_advisory";
  return Object.freeze({
    declaredRevision: identifier(required(value, "declaredRevision")),
    sourceRef: sourceRef(required(value, "sourceRef")),
    requirements,
    exclusions,
    importance: importance(required(value, "importance")),
    importanceAuthority,
    inferredAuthority: !HARD_AUTHORITIES.has(importanceAuthority)
      || [...requirements, ...exclusions].some((clause) => !HARD_AUTHORITIES.has(clause.authority))
  });
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function checkpointReason(value, common, expectedAuthority) {
  if (value.activeRevision === undefined) return "missing_active_revision";
  if (value.approvalState === undefined) return "missing_approval_state";
  if (value.approvalRevision === undefined) return "missing_approval_revision";
  if (value.approvalAuthority === undefined) return "missing_approval_authority";
  if (value.approvalState !== "approved") return "unapproved_contract";
  if (common.declaredRevision !== value.activeRevision) return "stale_revision";
  if (value.approvalRevision !== common.declaredRevision
      || value.approvalRevision !== value.activeRevision) {
    return "approval_revision_mismatch";
  }
  if (value.approvalAuthority !== expectedAuthority) return "unsupported_approval_authority";
  if (common.inferredAuthority) return "inferred_contract_authority";
  return null;
}

function checkpointProjection({
  input,
  allowedFields,
  adapterKind,
  sourceKind,
  expectedAuthority,
  includeChangeIdentity
}) {
  const value = recordValues(input, allowedFields);
  const common = commonProjection(value);
  const nativeTaskId = identifier(required(value, "nativeTaskId"));
  const nativeChangeId = includeChangeIdentity
    ? identifier(required(value, "nativeChangeId"))
    : null;
  const normalized = {
    ...value,
    activeRevision: identifier(value.activeRevision, { optional: true }),
    approvalState: identifier(value.approvalState, { optional: true }),
    approvalRevision: identifier(value.approvalRevision, { optional: true }),
    approvalAuthority: identifier(value.approvalAuthority, { optional: true })
  };
  const reasonCode = checkpointReason(normalized, common, expectedAuthority);
  const contract = projectContract({
    sourceKind,
    sourceRef: common.sourceRef,
    sourceRevision: common.declaredRevision,
    requirements: common.requirements,
    exclusions: common.exclusions,
    importance: common.importance,
    importanceAuthority: common.importanceAuthority
  });
  const result = {
    adapterKind,
    adapterCapability: reasonCode === null ? "checkpoint_gate" : "audit_only",
    maximumEnforcement: reasonCode === null ? "checkpoint_required" : "warn",
    gateEligible: reasonCode === null,
    reasonCode
  };
  if (includeChangeIdentity) result.nativeChangeId = nativeChangeId;
  result.nativeTaskId = nativeTaskId;
  result.nativeRevision = common.declaredRevision;
  result.contract = contract;
  return deepFreeze(result);
}

export function projectOpenSpecCheckpoint(input) {
  return checkpointProjection({
    input,
    allowedFields: OPENSPEC_FIELDS,
    adapterKind: "openspec",
    sourceKind: "openspec",
    expectedAuthority: "approved_spec",
    includeChangeIdentity: false
  });
}

export function projectCometCheckpoint(input) {
  return checkpointProjection({
    input,
    allowedFields: COMET_FIELDS,
    adapterKind: "comet",
    sourceKind: "comet",
    expectedAuthority: "approved_plan",
    includeChangeIdentity: true
  });
}

export function projectGenericAudit(input) {
  const value = recordValues(input, GENERIC_FIELDS);
  const common = commonProjection(value);
  const observationKind = identifier(required(value, "observationKind"));
  if (!OBSERVATION_KINDS.has(observationKind)) throw coded("adapter_invalid_observation_kind");
  const nativeTaskId = identifier(required(value, "nativeTaskId"));
  const contract = projectContract({
    sourceKind: `generic_${observationKind}`,
    sourceRef: common.sourceRef,
    sourceRevision: common.declaredRevision,
    requirements: common.requirements.map((clause) => ({
      id: clause.id,
      authority: "inferred_advisory"
    })),
    exclusions: common.exclusions.map((clause) => ({
      id: clause.id,
      authority: "inferred_advisory"
    })),
    importance: "routine",
    importanceAuthority: "inferred_advisory"
  });
  return deepFreeze({
    adapterKind: "generic_prompt",
    adapterCapability: "audit_only",
    maximumEnforcement: "warn",
    gateEligible: false,
    reasonCode: "generic_audit_only",
    observationKind,
    nativeTaskId,
    nativeRevision: common.declaredRevision,
    contract
  });
}
