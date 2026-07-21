import { createHash, randomBytes } from "node:crypto";

import {
  ADAPTER_CAPABILITIES,
  BREAKER_REASONS,
  DECISIONS,
  GRANT_PURPOSES,
  validateTransition
} from "./convergence-policy.mjs";

const DIGEST = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const ADAPTERS = new Set(["sdd", "openspec", "comet", "generic", "tool"]);
const CAPABILITIES = new Set(ADAPTER_CAPABILITIES);
const IMPORTANCE = new Set(["routine", "important", "critical"]);
const AUTHORITIES = new Set([
  "explicit_user", "approved_spec", "approved_plan", "verified_runtime",
  "review_finding", "inferred_advisory"
]);
const VERDICTS = new Set(["approved", "changes_required"]);
const SEVERITIES = new Set(["minor", "important", "critical"]);
const DIRECTION_SIGNALS = new Set(["none", "structural_blocked", "no_local_seam"]);
const EVIDENCE_CLASSES = new Set([
  "explicit_user", "approved_spec", "approved_plan", "verified_runtime",
  "review_finding", "inferred_advisory"
]);
const TRUSTED_EVIDENCE_CLASSES = new Set([
  "explicit_user", "approved_spec", "approved_plan", "verified_runtime"
]);
const DECISION_SET = new Set(DECISIONS);
const REASON_SET = new Set(BREAKER_REASONS);
const GRANT_PURPOSE_SET = new Set(GRANT_PURPOSES);
const MAX_PROBE_ATTEMPTS = 3;
const ENFORCEMENTS = new Set([
  "none", "warn_only", "stop_next_checkpoint", "stop_review_fix_dispatch", "stop_pre_mutation"
]);
const LOOP_STATUSES = new Set([
  "idle", "active_generation", "generation_closed", "reflection_required",
  "probe_pending", "probe_running", "reflection_resolved", "checkpoint_required",
  "direction_approved", "grant_ready", "human_decision", "terminal"
]);
const EVENT_TYPES = new Set([
  "contract_projected", "generation_opened", "evidence_recorded", "review_recorded",
  "alias_declared", "distinct_declared", "breaker_triggered", "reflection_requested",
  "reflection_claimed", "reflection_completed", "reflection_failed", "checkpoint_recorded",
  "grant_issued", "grant_consumed", "grant_revoked", "generation_closed",
  "task_resolved", "legacy_imported", "shadow_compared", "guard_cutover", "guard_rollback"
]);
const EVENT_FACT_FIELDS = new Map([
  ["contract_projected", new Set()],
  ["generation_opened", new Set(["generation", "purpose"])],
  ["evidence_recorded", new Set(["evidenceClass"])],
  ["review_recorded", new Set([
    "directionSignal", "failureCount", "legacyImported", "severity", "verdict"
  ])],
  ["alias_declared", new Set(["aliasId"])],
  ["distinct_declared", new Set(["reasonCode"])],
  ["breaker_triggered", new Set()],
  ["reflection_requested", new Set(["kind"])],
  ["reflection_claimed", new Set(["attempt", "kind"])],
  ["reflection_completed", new Set(["attempt", "kind"])],
  ["reflection_failed", new Set(["attempt", "kind"])],
  ["checkpoint_recorded", new Set(["fileDigest", "kind"])],
  ["grant_issued", new Set(["generation", "purpose"])],
  ["grant_consumed", new Set(["generation", "purpose"])],
  ["grant_revoked", new Set(["generation", "purpose"])],
  ["generation_closed", new Set()],
  ["task_resolved", new Set()],
  ["legacy_imported", new Set([
    "consumedGrantCount", "eventCount", "grantCount", "loopCount", "mappingVersion", "taskCount"
  ])],
  ["shadow_compared", new Set([
    "field", "kernelValue", "legacyValue", "mappingRevision", "matched",
    "paritySetDigest", "sourceSha256"
  ])],
  ["guard_cutover", new Set([
    "mappingRevision", "paritySetDigest", "snapshotDev", "snapshotIno",
    "snapshotMode", "snapshotType", "snapshotUid"
  ])],
  ["guard_rollback", new Set(["cutoverEventUid"])]
]);

const GUARD_PARITY_FIELDS = Object.freeze([
  "authorization_eligibility", "decision", "failure_generation", "next_required_action"
]);
const LEGACY_GUARD_DECISIONS = new Map([
  ["open", "pass"],
  ["closed", "finish"],
  ["blocked_direction_review", "checkpoint_required"],
  ["blocked_architecture_review", "checkpoint_required"],
  ["architecture_fix_ready", "checkpoint_required"],
  ["architecture_fix_in_progress", "pass"],
  ["blocked_human_decision", "human_decision"],
  ["review_recorded", "pass"],
  ["local_fix_allowed", "pass"],
  ["direction_review_required", "checkpoint_required"],
  ["architecture_review_required", "checkpoint_required"],
  ["human_decision_required", "human_decision"]
]);
const LEGACY_GUARD_ACTIONS = new Map([
  ["local_fix", "local_fix"],
  ["architecture_fix", "architecture_fix"],
  ["direction_review", "checkpoint"],
  ["architecture_review", "checkpoint"],
  ["human_decision", "human_decision"],
  ["finish", "finish"],
  ["none", "none"]
]);
const KERNEL_GUARD_ACTIONS = new Set([
  "local_fix", "architecture_fix", "checkpoint", "human_decision", "finish", "none"
]);

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function exactObject(input, fields, code) {
  if (input === null || typeof input !== "object" || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype) throw coded(code);
  for (const key of Object.keys(input)) if (!fields.has(key)) throw coded(`unknown_${code}_field`);
  return input;
}

function string(value, field, maximum = 256) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw coded(`invalid_${field}`);
  }
  return value;
}

function identifier(value, field) {
  const result = string(value, field);
  if (!ID.test(result)) throw coded(`invalid_${field}`);
  return result;
}

function digest(value, field) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw coded(`invalid_${field}`);
  return value;
}

function enumValue(value, allowed, field) {
  if (!allowed.has(value)) throw coded(`invalid_${field}`);
  return value;
}

function integer(value, field, minimum = 0, maximum = 1_000_000) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw coded(`invalid_${field}`);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function canonicalGuardParityValue(field, side, value) {
  if (!GUARD_PARITY_FIELDS.includes(field) || !new Set(["legacy", "kernel"]).has(side)) {
    throw coded("invalid_guard_parity_field");
  }
  if (field === "failure_generation") return integer(value, "guard_parity_value", 0, 3);
  if (field === "authorization_eligibility") return boolean(value, "guard_parity_value");
  if (typeof value !== "string") throw coded("invalid_guard_parity_value");
  if (field === "decision") {
    if (side === "legacy") {
      if (!LEGACY_GUARD_DECISIONS.has(value)) throw coded("invalid_guard_parity_value");
      return LEGACY_GUARD_DECISIONS.get(value);
    }
    return enumValue(value, DECISION_SET, "guard_parity_value");
  }
  if (side === "legacy") {
    if (!LEGACY_GUARD_ACTIONS.has(value)) throw coded("invalid_guard_parity_value");
    return LEGACY_GUARD_ACTIONS.get(value);
  }
  return enumValue(value, KERNEL_GUARD_ACTIONS, "guard_parity_value");
}

function parityFactValue(field, value) {
  if (field === "authorization_eligibility") return value ? "true" : "false";
  return String(value);
}

function parityValueFromFact(field, value) {
  if (field === "failure_generation") {
    if (!/^[0-3]$/u.test(value)) throw coded("shadow_parity_invalid");
    return Number(value);
  }
  if (field === "authorization_eligibility") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw coded("shadow_parity_invalid");
  }
  return value;
}

function guardParityDigest({ sourceSha256, mappingRevision, comparisons }) {
  return sha256(canonicalJson({
    sourceSha256,
    mappingRevision,
    comparisons: [...comparisons]
      .sort((left, right) => left.field.localeCompare(right.field))
      .map(({ field, legacy, kernel }) => ({ field, legacy, kernel }))
  }));
}

export function guardParitySetDigest({ sourceSha256, mappingRevision, comparisons }) {
  digest(sourceSha256, "source_sha256");
  identifier(mappingRevision, "mapping_revision");
  if (!Array.isArray(comparisons) || comparisons.length !== GUARD_PARITY_FIELDS.length) {
    throw coded("invalid_guard_parity_set");
  }
  const fields = new Set();
  const validated = comparisons.map((item) => {
    const value = exactObject(item, new Set(["field", "legacy", "kernel"]), "guard_parity_item");
    if (fields.has(value.field)) throw coded("invalid_guard_parity_set");
    fields.add(value.field);
    canonicalGuardParityValue(value.field, "legacy", value.legacy);
    canonicalGuardParityValue(value.field, "kernel", value.kernel);
    return Object.freeze({ field: value.field, legacy: value.legacy, kernel: value.kernel });
  });
  if (GUARD_PARITY_FIELDS.some((field) => !fields.has(field))) throw coded("invalid_guard_parity_set");
  return guardParityDigest({ sourceSha256, mappingRevision, comparisons: validated });
}

function timestamp(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw coded("invalid_now");
  return value.toISOString();
}

function isoTimestamp(value, field) {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw coded(`invalid_${field}`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw coded(`invalid_${field}`);
  return new Date(milliseconds).toISOString();
}

function boolean(value, field) {
  if (typeof value !== "boolean") throw coded(`invalid_${field}`);
  return value;
}

function optionalString(value, field, maximum = 256) {
  return value === null || value === undefined ? null : string(value, field, maximum);
}

function optionalDigest(value, field) {
  return value === null || value === undefined ? null : digest(value, field);
}

const EVALUATION_FIELDS = new Set([
  "decision", "requestedDecision", "reasonCode", "enforcement", "probeRequired", "policyRevision"
]);
const EVALUATION_REQUEST_FIELDS = new Set([
  "adapterCapability", "contract", "previousDecisionBasisDigest", "decisionBasisDigest",
  "currentGeneration", "requestedGeneration", "failureCount", "lastGrantPurpose",
  "acceptanceSatisfied", "addsArchitecture", "touchesExplicitExclusion", "oscillationDetected",
  "sameInvariant", "explorationRequested", "explorationUsed", "riskHypothesis",
  "falsificationTest", "evidenceQuality", "evidenceChanged", "fileSaveCount",
  "semanticRecommendation", "probeAction"
]);
const EVALUATION_CONTRACT_FIELDS = new Set([
  "sourceKind", "sourceRefDigest", "sourceRevision", "requirements", "exclusions",
  "importance", "importanceAuthority", "revision"
]);

function validateDecisionProjection(evaluationRequest, evaluation) {
  const request = exactObject(
    evaluationRequest,
    EVALUATION_REQUEST_FIELDS,
    "decision_snapshot"
  );
  for (const field of EVALUATION_REQUEST_FIELDS) {
    if (field !== "probeAction" && !Object.hasOwn(request, field)) {
      throw coded("invalid_decision_snapshot");
    }
  }
  const contract = exactObject(
    request.contract,
    EVALUATION_CONTRACT_FIELDS,
    "decision_contract_snapshot"
  );
  const snapshot = Object.freeze({
    adapterCapability: enumValue(request.adapterCapability, CAPABILITIES, "adapter_capability"),
    contractRevision: digest(contract.revision, "contract_revision"),
    previousDecisionBasisDigest: digest(
      request.previousDecisionBasisDigest,
      "previous_decision_basis_digest"
    ),
    decisionBasisDigest: digest(request.decisionBasisDigest, "decision_basis_digest"),
    currentGeneration: integer(request.currentGeneration, "current_generation"),
    requestedGeneration: integer(request.requestedGeneration, "requested_generation"),
    failureCount: integer(request.failureCount, "failure_count")
  });
  const supplied = exactObject(evaluation, EVALUATION_FIELDS, "convergence_evaluation");
  const decision = enumValue(supplied.decision, DECISION_SET, "decision");
  const requestedDecision = enumValue(
    supplied.requestedDecision,
    DECISION_SET,
    "requested_decision"
  );
  const reasonCode = enumValue(supplied.reasonCode, REASON_SET, "reason_code");
  const enforcement = enumValue(supplied.enforcement, ENFORCEMENTS, "enforcement");
  const probeRequired = boolean(supplied.probeRequired, "probe_required");
  const policyRevision = identifier(supplied.policyRevision, "policy_revision");
  const decisionShapeMatches = decision === requestedDecision
    || (decision === "warn" && requestedDecision !== "pass" && requestedDecision !== "warn");
  const enforcementShapeMatches = decision === "pass"
    ? enforcement === "none"
    : decision === "warn"
      ? enforcement === "warn_only"
      : enforcement.startsWith("stop_");
  if (!decisionShapeMatches
      || !enforcementShapeMatches
      || probeRequired !== (requestedDecision === "reflection_required")) {
    throw coded("invalid_convergence_evaluation");
  }
  return Object.freeze({
    request: snapshot,
    evaluation: Object.freeze({
      decision, requestedDecision, reasonCode, enforcement, probeRequired, policyRevision
    })
  });
}

const TASK_FIELDS = new Set([
  "eventUid", "taskUid", "lineageDigest", "adapterKind", "adapterCapability",
  "nativeTaskDigest", "contractSourceKind", "contractSourceRefDigest",
  "contractRevision", "policyRevision", "importance", "importanceAuthority"
]);

function validateTask(input) {
  const value = exactObject(input, TASK_FIELDS, "convergence_task");
  return Object.freeze({
    eventUid: identifier(value.eventUid, "event_uid"),
    taskUid: identifier(value.taskUid, "task_uid"),
    lineageDigest: digest(value.lineageDigest, "lineage_digest"),
    adapterKind: enumValue(value.adapterKind, ADAPTERS, "adapter_kind"),
    adapterCapability: enumValue(value.adapterCapability, CAPABILITIES, "adapter_capability"),
    nativeTaskDigest: digest(value.nativeTaskDigest, "native_task_digest"),
    contractSourceKind: identifier(value.contractSourceKind, "contract_source_kind"),
    contractSourceRefDigest: digest(value.contractSourceRefDigest, "contract_source_ref_digest"),
    contractRevision: digest(value.contractRevision, "contract_revision"),
    policyRevision: digest(value.policyRevision, "policy_revision"),
    importance: enumValue(value.importance, IMPORTANCE, "importance"),
    importanceAuthority: enumValue(value.importanceAuthority, AUTHORITIES, "importance_authority")
  });
}

function taskView(row) {
  return Object.freeze({
    taskUid: row.task_uid,
    lineageDigest: row.lineage_digest,
    adapterKind: row.adapter_kind,
    adapterCapability: row.adapter_capability,
    nativeTaskDigest: row.native_task_digest,
    contractSourceKind: row.contract_source_kind,
    contractSourceRefDigest: row.contract_source_ref_digest,
    contractRevision: row.contract_revision,
    policyRevision: row.policy_revision,
    importance: row.importance,
    importanceAuthority: row.importance_authority,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function sameTaskIdentity(row, value) {
  return row.lineage_digest === value.lineageDigest
    && row.adapter_kind === value.adapterKind
    && row.adapter_capability === value.adapterCapability
    && row.native_task_digest === value.nativeTaskDigest
    && row.contract_source_kind === value.contractSourceKind
    && row.contract_source_ref_digest === value.contractSourceRefDigest;
}

const REVIEW_FIELDS = new Set([
  "eventUid", "taskUid", "fingerprint", "boundaryId", "canonicalInvariantId",
  "verdict", "severity", "directionSignal", "decisionBasisDigest",
  "evidenceDigest", "generation"
]);

function validateReview(input) {
  const value = exactObject(input, REVIEW_FIELDS, "convergence_review");
  return Object.freeze({
    eventUid: identifier(value.eventUid, "event_uid"),
    taskUid: identifier(value.taskUid, "task_uid"),
    fingerprint: identifier(value.fingerprint, "fingerprint"),
    boundaryId: identifier(value.boundaryId, "boundary_id"),
    canonicalInvariantId: identifier(value.canonicalInvariantId, "canonical_invariant_id"),
    verdict: enumValue(value.verdict, VERDICTS, "verdict"),
    severity: enumValue(value.severity, SEVERITIES, "severity"),
    directionSignal: enumValue(value.directionSignal, DIRECTION_SIGNALS, "direction_signal"),
    decisionBasisDigest: digest(value.decisionBasisDigest, "decision_basis_digest"),
    evidenceDigest: digest(value.evidenceDigest, "evidence_digest"),
    generation: integer(value.generation, "generation", 0)
  });
}

function canonicalReviewEnvelope(value, canonicalLoop) {
  return Object.freeze({
    eventUid: value.eventUid,
    taskUid: value.taskUid,
    boundaryId: value.boundaryId,
    submittedIdentity: Object.freeze({
      fingerprint: value.fingerprint,
      invariantId: value.canonicalInvariantId
    }),
    canonicalIdentity: Object.freeze({
      fingerprint: canonicalLoop?.fingerprint ?? value.fingerprint,
      invariantId: canonicalLoop?.canonical_invariant_id ?? value.canonicalInvariantId
    }),
    generation: value.generation,
    severity: value.severity,
    verdict: value.verdict,
    directionSignal: value.directionSignal,
    evidenceDigest: value.evidenceDigest,
    decisionBasisDigest: value.decisionBasisDigest
  });
}

function parseAliases(value) {
  let aliases;
  try { aliases = JSON.parse(value); } catch { throw coded("invalid_alias_projection"); }
  if (!Array.isArray(aliases) || aliases.length > 128
      || aliases.some((alias) => typeof alias !== "string" || !ID.test(alias))) {
    throw coded("invalid_alias_projection");
  }
  return aliases;
}

function loopView(row) {
  const fixGenerations = Array.from({ length: Number(row.fix_generation) }, (_, index) => index + 1);
  return Object.freeze({
    taskUid: row.task_uid,
    fingerprint: row.fingerprint,
    boundaryId: row.boundary_id,
    canonicalInvariantId: row.canonical_invariant_id,
    status: row.status,
    failureCount: Number(row.failure_count),
    currentGeneration: Number(row.fix_generation),
    fixGenerations: Object.freeze(fixGenerations),
    decisionBasisDigest: row.decision_basis_digest,
    decision: row.current_decision,
    directionGeneration: Number(row.direction_generation),
    aliases: Object.freeze(parseAliases(row.aliases_json)),
    activeGrantId: row.active_grant_id,
    probeKind: row.probe_kind,
    probeState: row.probe_state,
    probeAttempt: Number(row.probe_attempt),
    probeOwnerId: row.probe_owner_id,
    probeLeaseEpoch: Number(row.probe_lease_epoch),
    probeLeaseUntil: row.probe_lease_until,
    probeNextAttemptAt: row.probe_next_attempt_at,
    probeResultDigest: row.probe_result_digest,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function requireTask(database, taskUid) {
  const row = database.prepare("SELECT * FROM convergence_tasks WHERE task_uid=?").get(taskUid);
  if (!row) throw coded("task_not_found");
  return row;
}

function requireLoop(database, taskUid, fingerprint) {
  const row = database.prepare(`SELECT * FROM convergence_loops
    WHERE task_uid=? AND fingerprint=?`).get(taskUid, fingerprint);
  if (!row) throw coded("loop_not_found");
  return row;
}

const GRANT_FIELDS = new Set([
  "eventUid", "grantId", "taskUid", "fingerprint", "currentGeneration",
  "nextGeneration", "purpose", "scopeDigest", "contractRevision", "policyRevision",
  "decisionBasisDigest", "evidenceDigest", "expiresAt"
]);

function validateGrant(input) {
  const value = exactObject(input, GRANT_FIELDS, "continuation_grant");
  const currentGeneration = integer(value.currentGeneration, "current_generation", 0);
  const nextGeneration = integer(value.nextGeneration, "next_generation", 1);
  if (nextGeneration !== currentGeneration + 1) throw coded("invalid_generation");
  return Object.freeze({
    eventUid: identifier(value.eventUid, "event_uid"),
    grantId: identifier(value.grantId, "grant_id"),
    taskUid: identifier(value.taskUid, "task_uid"),
    fingerprint: identifier(value.fingerprint, "fingerprint"),
    currentGeneration,
    nextGeneration,
    purpose: enumValue(value.purpose, GRANT_PURPOSE_SET, "purpose"),
    scopeDigest: digest(value.scopeDigest, "scope_digest"),
    contractRevision: digest(value.contractRevision, "contract_revision"),
    policyRevision: digest(value.policyRevision, "policy_revision"),
    decisionBasisDigest: digest(value.decisionBasisDigest, "decision_basis_digest"),
    evidenceDigest: digest(value.evidenceDigest, "evidence_digest"),
    expiresAt: isoTimestamp(value.expiresAt, "expires_at")
  });
}

function publicGrant(value, token) {
  return Object.freeze({
    grantId: value.grantId,
    token,
    taskUid: value.taskUid,
    fingerprint: value.fingerprint,
    currentGeneration: value.currentGeneration,
    nextGeneration: value.nextGeneration,
    purpose: value.purpose,
    scopeDigest: value.scopeDigest,
    contractRevision: value.contractRevision,
    policyRevision: value.policyRevision,
    decisionBasisDigest: value.decisionBasisDigest,
    evidenceDigest: value.evidenceDigest,
    expiresAt: value.expiresAt
  });
}

export function createConvergenceStoreApi({ database, transaction, now, randomBytesImpl = randomBytes }) {
  if (!database || typeof transaction !== "function" || typeof now !== "function"
      || typeof randomBytesImpl !== "function") throw new TypeError("invalid convergence store dependencies");

  const appendEvent = (input) => {
    const factsJson = canonicalJson(input.facts ?? {});
    const eventDigest = sha256(canonicalJson({ ...input, facts: JSON.parse(factsJson) }));
    const existing = database.prepare("SELECT * FROM convergence_events WHERE event_uid=?")
      .get(input.eventUid);
    if (existing) {
      if (existing.event_digest !== eventDigest) throw coded("event_collision");
      return { row: existing, replay: true };
    }
    const previous = database.prepare(`SELECT event_digest FROM convergence_events
      WHERE task_uid=? ORDER BY id DESC LIMIT 1`).get(input.taskUid);
    database.prepare(`INSERT INTO convergence_events
      (event_uid, task_uid, fingerprint, generation, event_type, reason_code, decision,
       action, evidence_digest, source_digest, result_digest, facts_json,
       previous_event_digest, event_digest, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.eventUid, input.taskUid, input.fingerprint ?? null, input.generation ?? null,
      input.eventType, input.reasonCode ?? null, input.decision ?? null,
      input.action ?? null, input.evidenceDigest ?? null, input.sourceDigest ?? null,
      input.resultDigest ?? null, factsJson, previous?.event_digest ?? null,
      eventDigest, timestamp(now)
    );
    return {
      row: database.prepare("SELECT * FROM convergence_events WHERE event_uid=?").get(input.eventUid),
      replay: false
    };
  };

  return Object.freeze({
    upsertConvergenceTask(input) {
      const value = validateTask(input);
      return transaction(() => {
        const eventInput = {
          eventUid: value.eventUid,
          taskUid: value.taskUid,
          eventType: "contract_projected",
          sourceDigest: sha256(canonicalJson(value)),
          resultDigest: value.contractRevision,
          facts: {}
        };
        const replayEvent = database.prepare("SELECT 1 FROM convergence_events WHERE event_uid=?")
          .get(value.eventUid);
        if (replayEvent) {
          const replay = appendEvent(eventInput);
          if (replay.replay) {
            const replayedTask = database.prepare("SELECT * FROM convergence_tasks WHERE task_uid=?")
              .get(value.taskUid);
            if (!replayedTask) throw coded("event_collision");
            return taskView(replayedTask);
          }
        }
        const existing = database.prepare("SELECT * FROM convergence_tasks WHERE task_uid=?")
          .get(value.taskUid);
        if (existing && !sameTaskIdentity(existing, value)) throw coded("task_identity_collision");
        const changed = !existing
          || existing.contract_revision !== value.contractRevision
          || existing.policy_revision !== value.policyRevision
          || existing.importance !== value.importance
          || existing.importance_authority !== value.importanceAuthority;
        if (!changed) return taskView(existing);

        const appended = appendEvent(eventInput);
        if (appended.replay && existing) return taskView(existing);
        const currentTime = timestamp(now);
        if (existing) {
          const staleGrants = database.prepare(`SELECT * FROM continuation_grants
            WHERE task_uid=? AND state='active'`).all(value.taskUid);
          for (const grant of staleGrants) {
            appendEvent({
              eventUid: `${value.eventUid}:revoke:${grant.grant_id}`,
              taskUid: value.taskUid,
              fingerprint: grant.fingerprint,
              generation: Number(grant.current_generation),
              eventType: "grant_revoked",
              reasonCode: "revision_changed",
              facts: { generation: Number(grant.next_generation), purpose: grant.purpose }
            });
            database.prepare(`UPDATE continuation_grants SET state='revoked', revoked_at=?
              WHERE grant_id=? AND state='active'`).run(currentTime, grant.grant_id);
            database.prepare(`UPDATE convergence_loops SET active_grant_id=NULL,
              status='generation_closed', updated_at=?, version=version+1
              WHERE fingerprint=? AND active_grant_id=?`).run(
              currentTime, grant.fingerprint, grant.grant_id
            );
          }
        }
        database.prepare(`INSERT INTO convergence_tasks
          (task_uid, lineage_digest, adapter_kind, adapter_capability, native_task_digest,
           contract_source_kind, contract_source_ref_digest, contract_revision, policy_revision,
           importance, importance_authority, state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)
          ON CONFLICT(task_uid) DO UPDATE SET
            contract_revision=excluded.contract_revision,
            policy_revision=excluded.policy_revision,
            importance=excluded.importance,
            importance_authority=excluded.importance_authority,
            updated_at=excluded.updated_at`).run(
          value.taskUid, value.lineageDigest, value.adapterKind, value.adapterCapability,
          value.nativeTaskDigest, value.contractSourceKind, value.contractSourceRefDigest,
          value.contractRevision, value.policyRevision, value.importance,
          value.importanceAuthority, currentTime, currentTime
        );
        return taskView(database.prepare("SELECT * FROM convergence_tasks WHERE task_uid=?")
          .get(value.taskUid));
      });
    },

    recordConvergenceReview(input) {
      const value = validateReview(input);
      return transaction(() => {
        requireTask(database, value.taskUid);
        const candidates = database.prepare(`SELECT * FROM convergence_loops
          WHERE task_uid=? AND boundary_id=?`).all(value.taskUid, value.boundaryId);
        const exact = candidates.find((row) => row.canonical_invariant_id === value.canonicalInvariantId);
        const aliased = exact ?? candidates.find((row) => parseAliases(row.aliases_json)
          .includes(value.canonicalInvariantId));
        const existing = aliased ?? null;
        const envelope = canonicalReviewEnvelope(value, existing);
        const fingerprint = envelope.canonicalIdentity.fingerprint;
        const envelopeDigest = sha256(canonicalJson(envelope));
        const replayEvent = database.prepare("SELECT * FROM convergence_events WHERE event_uid=?")
          .get(value.eventUid);
        if (replayEvent) {
          if (replayEvent.task_uid !== value.taskUid
              || replayEvent.event_type !== "review_recorded"
              || replayEvent.fingerprint !== fingerprint
              || replayEvent.source_digest !== envelopeDigest) {
            throw coded("event_collision");
          }
          return loopView(requireLoop(database, value.taskUid, fingerprint));
        }
        if (exact && exact.fingerprint !== value.fingerprint) throw coded("fingerprint_collision");
        const byFingerprint = database.prepare("SELECT * FROM convergence_loops WHERE fingerprint=?")
          .get(value.fingerprint);
        if (byFingerprint && (!existing || byFingerprint.fingerprint !== existing.fingerprint)) {
          throw coded("fingerprint_collision");
        }
        const historicalEvidence = existing && database.prepare(`SELECT 1 FROM convergence_events
          WHERE task_uid=? AND fingerprint=? AND event_type='review_recorded' AND evidence_digest=?
          LIMIT 1`).get(value.taskUid, fingerprint, value.evidenceDigest);
        const failed = value.verdict === "changes_required"
          && (value.severity === "important" || value.severity === "critical")
          && !historicalEvidence;
        const failureCount = Number(existing?.failure_count ?? 0) + (failed ? 1 : 0);
        const decision = failed && (failureCount >= 2 || value.directionSignal !== "none")
          ? "checkpoint_required"
          : existing?.current_decision ?? "pass";
        const appended = appendEvent({
          eventUid: value.eventUid,
          taskUid: value.taskUid,
          fingerprint,
          generation: value.generation,
          eventType: "review_recorded",
          decision,
          evidenceDigest: value.evidenceDigest,
          sourceDigest: envelopeDigest,
          resultDigest: value.decisionBasisDigest,
          facts: {
            directionSignal: value.directionSignal,
            failureCount,
            severity: value.severity,
            verdict: value.verdict
          }
        });
        if (appended.replay) return loopView(requireLoop(database, value.taskUid, fingerprint));
        const currentTime = timestamp(now);
        if (!existing) {
          database.prepare(`INSERT INTO convergence_loops
            (fingerprint, task_uid, boundary_id, canonical_invariant_id, status,
             failure_count, fix_generation, decision_basis_digest, current_decision,
             created_at, updated_at)
            VALUES (?, ?, ?, ?, 'generation_closed', ?, ?, ?, ?, ?, ?)`).run(
            fingerprint, value.taskUid, value.boundaryId, value.canonicalInvariantId,
            failureCount, value.generation, value.decisionBasisDigest, decision,
            currentTime, currentTime
          );
        } else {
          database.prepare(`UPDATE convergence_loops SET
            status='generation_closed', failure_count=?, current_decision=?,
            decision_basis_digest=?, updated_at=?, version=version+1 WHERE fingerprint=?`).run(
            failureCount, decision, value.decisionBasisDigest, currentTime, fingerprint
          );
        }
        return loopView(requireLoop(database, value.taskUid, fingerprint));
      });
    },

    addConvergenceAlias(input) {
      const value = exactObject(input, new Set([
        "eventUid", "taskUid", "fingerprint", "aliasInvariantId"
      ]), "convergence_alias");
      const eventUid = identifier(value.eventUid, "event_uid");
      const taskUid = identifier(value.taskUid, "task_uid");
      const fingerprint = identifier(value.fingerprint, "fingerprint");
      const alias = identifier(value.aliasInvariantId, "alias_invariant_id");
      return transaction(() => {
        const loop = requireLoop(database, taskUid, fingerprint);
        const collision = database.prepare(`SELECT fingerprint, canonical_invariant_id, aliases_json
          FROM convergence_loops WHERE task_uid=? AND fingerprint<>?`).all(taskUid, fingerprint)
          .some((row) => row.canonical_invariant_id === alias || parseAliases(row.aliases_json).includes(alias));
        if (collision) throw coded("alias_collision");
        const aliases = parseAliases(loop.aliases_json);
        const appended = appendEvent({
          eventUid, taskUid, fingerprint, eventType: "alias_declared", facts: { aliasId: alias }
        });
        if (appended.replay) return Object.freeze({ fingerprint });
        if (loop.canonical_invariant_id === alias || aliases.includes(alias)) return { fingerprint };
        if (aliases.length >= 128) throw coded("alias_limit");
        if (!appended.replay) {
          database.prepare(`UPDATE convergence_loops SET aliases_json=?, updated_at=?, version=version+1
            WHERE fingerprint=?`).run(canonicalJson([...aliases, alias].sort()), timestamp(now), fingerprint);
        }
        return Object.freeze({ fingerprint });
      });
    },

    declareConvergenceDistinct(input) {
      const value = exactObject(input, new Set([
        "eventUid", "taskUid", "fingerprint", "boundaryId", "canonicalInvariantId",
        "reasonCode", "evidenceDigest", "decisionBasisDigest"
      ]), "convergence_distinct");
      const eventUid = identifier(value.eventUid, "event_uid");
      const taskUid = identifier(value.taskUid, "task_uid");
      const fingerprint = identifier(value.fingerprint, "fingerprint");
      const boundaryId = identifier(value.boundaryId, "boundary_id");
      const invariant = identifier(value.canonicalInvariantId, "canonical_invariant_id");
      const reasonCode = identifier(value.reasonCode, "reason_code");
      const evidenceDigest = digest(value.evidenceDigest, "evidence_digest");
      const basis = digest(value.decisionBasisDigest, "decision_basis_digest");
      return transaction(() => {
        requireTask(database, taskUid);
        const appended = appendEvent({
          eventUid, taskUid, fingerprint, eventType: "distinct_declared", reasonCode,
          evidenceDigest, resultDigest: basis, facts: { reasonCode }
        });
        if (!appended.replay) {
          const currentTime = timestamp(now);
          database.prepare(`INSERT INTO convergence_loops
            (fingerprint, task_uid, boundary_id, canonical_invariant_id, status,
             decision_basis_digest, current_decision, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'generation_closed', ?, 'pass', ?, ?)`).run(
            fingerprint, taskUid, boundaryId, invariant, basis, currentTime, currentTime
          );
        }
        return loopView(requireLoop(database, taskUid, fingerprint));
      });
    },

    recordConvergenceEvidence(input) {
      const value = exactObject(input, new Set([
        "eventUid", "taskUid", "fingerprint", "evidenceClass", "evidenceDigest",
        "decisionBasisDigest"
      ]), "convergence_evidence");
      const eventUid = identifier(value.eventUid, "event_uid");
      const taskUid = identifier(value.taskUid, "task_uid");
      const fingerprint = identifier(value.fingerprint, "fingerprint");
      const evidenceClass = enumValue(value.evidenceClass, EVIDENCE_CLASSES, "evidence_class");
      const evidenceDigest = digest(value.evidenceDigest, "evidence_digest");
      const basis = digest(value.decisionBasisDigest, "decision_basis_digest");
      return transaction(() => {
        const loop = requireLoop(database, taskUid, fingerprint);
        const basisChanged = TRUSTED_EVIDENCE_CLASSES.has(evidenceClass)
          && loop.decision_basis_digest !== basis;
        const appended = appendEvent({
          eventUid, taskUid, fingerprint, eventType: "evidence_recorded",
          evidenceDigest, resultDigest: basis, facts: { evidenceClass }
        });
        if (!appended.replay && basisChanged) {
          database.prepare(`UPDATE convergence_loops SET decision_basis_digest=?, updated_at=?,
            version=version+1 WHERE fingerprint=?`).run(basis, timestamp(now), fingerprint);
        }
        return Object.freeze({ fingerprint, basisChanged: appended.replay ? false : basisChanged });
      });
    },

    recordConvergenceDecision(input) {
      const value = exactObject(input, new Set([
        "eventUid", "taskUid", "fingerprint", "evaluationRequest", "evaluation", "targetStatus"
      ]), "convergence_decision");
      const eventUid = identifier(value.eventUid, "event_uid");
      const taskUid = identifier(value.taskUid, "task_uid");
      const fingerprint = identifier(value.fingerprint, "fingerprint");
      const projection = validateDecisionProjection(value.evaluationRequest, value.evaluation);
      const { decision, reasonCode, policyRevision } = projection.evaluation;
      const expectedTarget = {
        pass: "generation_closed",
        warn: "generation_closed",
        reflection_required: "reflection_required",
        checkpoint_required: "checkpoint_required",
        hold: "checkpoint_required",
        human_decision: "human_decision",
        finish: "terminal"
      }[decision];
      if (value.targetStatus !== expectedTarget) throw coded("decision_target_mismatch");
      return transaction(() => {
        const task = requireTask(database, taskUid);
        const loop = requireLoop(database, taskUid, fingerprint);
        const appended = appendEvent({
          eventUid, taskUid, fingerprint, generation: projection.request.currentGeneration,
          eventType: "breaker_triggered", reasonCode, decision,
          sourceDigest: sha256(canonicalJson({
            evaluationRequest: value.evaluationRequest,
            evaluation: value.evaluation
          })),
          facts: {}
        });
        if (appended.replay) return loopView(loop);
        if (task.adapter_capability !== projection.request.adapterCapability
            || task.contract_revision !== projection.request.contractRevision
            || task.policy_revision !== sha256(policyRevision)
            || Number(loop.failure_count) !== projection.request.failureCount
            || Number(loop.fix_generation) !== projection.request.currentGeneration
            || projection.request.requestedGeneration !== Number(loop.fix_generation) + 1
            || loop.decision_basis_digest !== projection.request.decisionBasisDigest) {
          throw coded("decision_snapshot_mismatch");
        }
        validateTransition({ from: loop.status, eventType: "breaker_triggered", to: expectedTarget });
        if (!appended.replay) {
          database.prepare(`UPDATE convergence_loops SET status=?, current_decision=?,
            updated_at=?, version=version+1 WHERE fingerprint=?`).run(
            expectedTarget, decision, timestamp(now), fingerprint
          );
        }
        return loopView(requireLoop(database, taskUid, fingerprint));
      });
    },

    recordConvergenceCheckpoint(input) {
      const value = exactObject(input, new Set([
        "eventUid", "taskUid", "fingerprint", "checkpointKind", "fileDigest"
      ]), "convergence_checkpoint");
      const eventUid = identifier(value.eventUid, "event_uid");
      const taskUid = identifier(value.taskUid, "task_uid");
      const fingerprint = identifier(value.fingerprint, "fingerprint");
      const checkpointKind = identifier(value.checkpointKind, "checkpoint_kind");
      const fileDigest = digest(value.fileDigest, "file_digest");
      return transaction(() => {
        const loop = requireLoop(database, taskUid, fingerprint);
        const appended = appendEvent({
          eventUid, taskUid, fingerprint, generation: Number(loop.fix_generation),
          eventType: "checkpoint_recorded", resultDigest: fileDigest,
          facts: { fileDigest, kind: checkpointKind }
        });
        if (appended.replay) return loopView(loop);
        if (loop.status !== "checkpoint_required") throw coded("checkpoint_not_required");
        validateTransition({
          from: loop.status, eventType: "checkpoint_recorded", to: "direction_approved"
        });
        if (!appended.replay) {
          database.prepare(`UPDATE convergence_loops SET status='direction_approved',
            direction_generation=direction_generation+1, updated_at=?, version=version+1
            WHERE fingerprint=?`).run(timestamp(now), fingerprint);
        }
        return loopView(requireLoop(database, taskUid, fingerprint));
      });
    },

    requestConvergenceGeneration(input) {
      const value = exactObject(input, new Set([
        "eventUid", "taskUid", "fingerprint", "requestedGeneration", "purpose"
      ]), "convergence_generation");
      const eventUid = identifier(value.eventUid, "event_uid");
      const taskUid = identifier(value.taskUid, "task_uid");
      const fingerprint = identifier(value.fingerprint, "fingerprint");
      const requestedGeneration = integer(value.requestedGeneration, "generation", 1);
      if (value.purpose !== "pass") throw coded("generation_grant_required");
      return transaction(() => {
        const loop = requireLoop(database, taskUid, fingerprint);
        const appended = appendEvent({
          eventUid, taskUid, fingerprint, generation: requestedGeneration,
          eventType: "generation_opened", action: "pass",
          facts: { generation: requestedGeneration, purpose: "pass" }
        });
        if (appended.replay) return loopView(loop);
        if (loop.current_decision !== "pass" || loop.status !== "generation_closed") {
          throw coded("generation_grant_required");
        }
        if (requestedGeneration !== Number(loop.fix_generation) + 1) {
          throw coded("invalid_generation");
        }
        validateTransition({
          from: loop.status, eventType: "generation_opened", to: "active_generation"
        });
        if (!appended.replay) {
          database.prepare(`UPDATE convergence_loops SET status='active_generation',
            fix_generation=?, updated_at=?, version=version+1 WHERE fingerprint=?`).run(
            requestedGeneration, timestamp(now), fingerprint
          );
        }
        return loopView(requireLoop(database, taskUid, fingerprint));
      });
    },

    requestConvergenceProbe(input) {
      const value = exactObject(input, new Set([
        "eventUid", "taskUid", "fingerprint", "probeKind", "dueAt"
      ]), "convergence_probe_request");
      const eventUid = identifier(value.eventUid, "event_uid");
      const taskUid = identifier(value.taskUid, "task_uid");
      const fingerprint = identifier(value.fingerprint, "fingerprint");
      const probeKind = identifier(value.probeKind, "probe_kind");
      const dueAt = isoTimestamp(value.dueAt, "due_at");
      return transaction(() => {
        const loop = requireLoop(database, taskUid, fingerprint);
        const appended = appendEvent({
          eventUid, taskUid, fingerprint, generation: Number(loop.fix_generation),
          eventType: "reflection_requested",
          sourceDigest: sha256(canonicalJson({ dueAt, probeKind })),
          facts: { kind: probeKind }
        });
        if (appended.replay) return loopView(loop);
        if (loop.status !== "reflection_required") throw coded("reflection_not_required");
        if (["pending", "retryable", "running"].includes(loop.probe_state)) {
          throw coded("probe_already_live");
        }
        validateTransition({
          from: loop.status, eventType: "reflection_requested", to: "probe_pending"
        });
        if (!appended.replay) {
          database.prepare(`UPDATE convergence_loops SET status='probe_pending', probe_kind=?,
            probe_state='pending', probe_owner_id=NULL, probe_lease_until=NULL,
            probe_next_attempt_at=?, updated_at=?, version=version+1 WHERE fingerprint=?`).run(
            probeKind, dueAt, timestamp(now), fingerprint
          );
        }
        return loopView(requireLoop(database, taskUid, fingerprint));
      });
    },

    claimConvergenceProbe(input) {
      const value = exactObject(input, new Set([
        "eventUid", "taskUid", "fingerprint", "ownerId", "leaseMs"
      ]), "convergence_probe_claim");
      const eventUid = identifier(value.eventUid, "event_uid");
      const taskUid = identifier(value.taskUid, "task_uid");
      const fingerprint = identifier(value.fingerprint, "fingerprint");
      const ownerId = identifier(value.ownerId, "owner_id");
      const leaseMs = integer(value.leaseMs, "lease_ms", 1, 300_000);
      return transaction(() => {
        const loop = requireLoop(database, taskUid, fingerprint);
        const currentTime = timestamp(now);
        const currentMilliseconds = Date.parse(currentTime);
        const expiredRunning = loop.probe_state === "running"
          && loop.probe_lease_until !== null
          && Date.parse(loop.probe_lease_until) <= currentMilliseconds;
        const prior = database.prepare("SELECT * FROM convergence_events WHERE event_uid=?").get(eventUid);
        const priorIsExhausted = prior?.event_type === "reflection_failed"
          && prior.reason_code === "probe_attempts_exhausted";
        const exhausted = priorIsExhausted
          || (prior === undefined && expiredRunning
            && Number(loop.probe_attempt) >= MAX_PROBE_ATTEMPTS);
        const priorFacts = prior?.event_type === "reflection_claimed"
          || priorIsExhausted ? JSON.parse(prior.facts_json) : null;
        const attempt = priorFacts === null
          ? Number(loop.probe_attempt) + 1
          : Number(priorFacts.attempt);
        const appended = appendEvent({
          eventUid, taskUid, fingerprint, generation: Number(loop.fix_generation),
          eventType: exhausted ? "reflection_failed" : "reflection_claimed",
          reasonCode: exhausted ? "probe_attempts_exhausted" : null,
          sourceDigest: sha256(canonicalJson({ leaseMs, ownerId })),
          facts: {
            attempt: exhausted ? Number(loop.probe_attempt) : attempt,
            kind: loop.probe_kind
          }
        });
        if (appended.replay) return loopView(loop);
        if (exhausted) {
          validateTransition({
            from: loop.status,
            eventType: "reflection_failed",
            to: "checkpoint_required"
          });
          database.prepare(`UPDATE convergence_loops SET status='checkpoint_required',
            probe_state='failed', probe_owner_id=NULL, probe_lease_until=NULL,
            probe_next_attempt_at=NULL, updated_at=?, version=version+1
            WHERE fingerprint=?`).run(currentTime, fingerprint);
          return loopView(requireLoop(database, taskUid, fingerprint));
        }
        const scheduledAndDue = ["pending", "retryable"].includes(loop.probe_state)
          && loop.probe_next_attempt_at !== null
          && Date.parse(loop.probe_next_attempt_at) <= currentMilliseconds;
        if (!scheduledAndDue && !expiredRunning) {
          throw coded("probe_not_due");
        }
        if (loop.probe_state === "pending") {
          validateTransition({
            from: loop.status, eventType: "reflection_claimed", to: "probe_running"
          });
        }
        const leaseEpoch = Number(loop.probe_lease_epoch) + 1;
        if (!appended.replay) {
          database.prepare(`UPDATE convergence_loops SET status='probe_running',
            probe_state='running', probe_attempt=?, probe_owner_id=?, probe_lease_epoch=?,
            probe_lease_until=?, probe_next_attempt_at=NULL, updated_at=?, version=version+1
            WHERE fingerprint=?`).run(
            attempt, ownerId, leaseEpoch,
            new Date(currentMilliseconds + leaseMs).toISOString(), currentTime, fingerprint
          );
        }
        return loopView(requireLoop(database, taskUid, fingerprint));
      });
    },

    completeConvergenceProbe(input) {
      const value = exactObject(input, new Set([
        "eventUid", "taskUid", "fingerprint", "ownerId", "leaseEpoch",
        "action", "resultDigest"
      ]), "convergence_probe_completion");
      const eventUid = identifier(value.eventUid, "event_uid");
      const taskUid = identifier(value.taskUid, "task_uid");
      const fingerprint = identifier(value.fingerprint, "fingerprint");
      const ownerId = identifier(value.ownerId, "owner_id");
      const leaseEpoch = integer(value.leaseEpoch, "lease_epoch", 1);
      const action = identifier(value.action, "action");
      const resultDigest = digest(value.resultDigest, "result_digest");
      return transaction(() => {
        const loop = requireLoop(database, taskUid, fingerprint);
        const currentTime = timestamp(now);
        const appended = appendEvent({
          eventUid, taskUid, fingerprint, generation: Number(loop.fix_generation),
          eventType: "reflection_completed", action, resultDigest,
          sourceDigest: sha256(canonicalJson({ leaseEpoch, ownerId })),
          facts: { attempt: Number(loop.probe_attempt), kind: loop.probe_kind }
        });
        if (appended.replay) return loopView(loop);
        if (loop.probe_state !== "running" || loop.probe_owner_id !== ownerId
            || Number(loop.probe_lease_epoch) !== leaseEpoch
            || loop.probe_lease_until === null
            || Date.parse(loop.probe_lease_until) <= Date.parse(currentTime)) {
          throw coded("probe_lease_lost");
        }
        validateTransition({
          from: loop.status, eventType: "reflection_completed", to: "reflection_resolved"
        });
        database.prepare(`UPDATE convergence_loops SET status='reflection_resolved',
          probe_state='completed',
          probe_owner_id=NULL, probe_lease_until=NULL, probe_next_attempt_at=NULL,
          probe_result_digest=?, updated_at=?, version=version+1 WHERE fingerprint=?`).run(
          resultDigest, currentTime, fingerprint
        );
        return loopView(requireLoop(database, taskUid, fingerprint));
      });
    },

    failConvergenceProbe(input) {
      const value = exactObject(input, new Set([
        "eventUid", "taskUid", "fingerprint", "ownerId", "leaseEpoch",
        "reasonCode", "retryable", "backoffMs"
      ]), "convergence_probe_failure");
      const eventUid = identifier(value.eventUid, "event_uid");
      const taskUid = identifier(value.taskUid, "task_uid");
      const fingerprint = identifier(value.fingerprint, "fingerprint");
      const ownerId = identifier(value.ownerId, "owner_id");
      const leaseEpoch = integer(value.leaseEpoch, "lease_epoch", 1);
      const reasonCode = identifier(value.reasonCode, "reason_code");
      const retryable = boolean(value.retryable, "retryable");
      const backoffMs = integer(value.backoffMs, "backoff_ms", 0, 3_600_000);
      return transaction(() => {
        const loop = requireLoop(database, taskUid, fingerprint);
        const currentTime = timestamp(now);
        const appended = appendEvent({
          eventUid, taskUid, fingerprint, generation: Number(loop.fix_generation),
          eventType: "reflection_failed", reasonCode,
          sourceDigest: sha256(canonicalJson({ backoffMs, leaseEpoch, ownerId, retryable })),
          facts: { attempt: Number(loop.probe_attempt), kind: loop.probe_kind }
        });
        if (appended.replay) return loopView(loop);
        if (loop.probe_state !== "running" || loop.probe_owner_id !== ownerId
            || Number(loop.probe_lease_epoch) !== leaseEpoch
            || loop.probe_lease_until === null
            || Date.parse(loop.probe_lease_until) <= Date.parse(currentTime)) {
          throw coded("probe_lease_lost");
        }
        const canRetry = retryable && Number(loop.probe_attempt) < 3;
        const target = canRetry ? "reflection_required" : "checkpoint_required";
        validateTransition({ from: loop.status, eventType: "reflection_failed", to: target });
        database.prepare(`UPDATE convergence_loops SET status=?, probe_state=?,
          probe_owner_id=NULL, probe_lease_until=NULL, probe_next_attempt_at=?,
          updated_at=?, version=version+1 WHERE fingerprint=?`).run(
          target, canRetry ? "retryable" : "failed",
          canRetry ? new Date(Date.parse(currentTime) + backoffMs).toISOString() : null,
          currentTime, fingerprint
        );
        return loopView(requireLoop(database, taskUid, fingerprint));
      });
    },

    issueContinuationGrant(input) {
      const value = validateGrant(input);
      return transaction(() => {
        const eventInput = {
          eventUid: value.eventUid,
          taskUid: value.taskUid,
          fingerprint: value.fingerprint,
          generation: value.currentGeneration,
          eventType: "grant_issued",
          action: value.purpose,
          evidenceDigest: value.evidenceDigest,
          sourceDigest: sha256(canonicalJson(value)),
          resultDigest: value.scopeDigest,
          facts: { generation: value.nextGeneration, purpose: value.purpose }
        };
        if (database.prepare("SELECT 1 FROM convergence_events WHERE event_uid=?").get(value.eventUid)) {
          const replay = appendEvent(eventInput);
          if (replay.replay) {
            return Object.freeze({ grantId: value.grantId, replayed: true, tokenAvailable: false });
          }
        }
        const task = requireTask(database, value.taskUid);
        const loop = requireLoop(database, value.taskUid, value.fingerprint);
        const currentTime = timestamp(now);
        if (task.contract_revision !== value.contractRevision
            || task.policy_revision !== value.policyRevision
            || loop.decision_basis_digest !== value.decisionBasisDigest) {
          throw coded("grant_binding_mismatch");
        }
        if (Number(loop.fix_generation) !== value.currentGeneration) throw coded("invalid_generation");
        if (Date.parse(value.expiresAt) <= Date.parse(currentTime)) throw coded("grant_expired");
        validateTransition({ from: loop.status, eventType: "grant_issued", to: "grant_ready" });

        const active = loop.active_grant_id === null ? null : database.prepare(
          "SELECT * FROM continuation_grants WHERE grant_id=?"
        ).get(loop.active_grant_id);
        if (active?.state === "active") {
          appendEvent({
            eventUid: `${value.eventUid}:revoke:${active.grant_id}`,
            taskUid: value.taskUid,
            fingerprint: value.fingerprint,
            generation: value.currentGeneration,
            eventType: "grant_revoked",
            reasonCode: "superseded",
            facts: { generation: Number(active.next_generation), purpose: active.purpose }
          });
          database.prepare(`UPDATE continuation_grants SET state='revoked', revoked_at=?
            WHERE grant_id=? AND state='active'`).run(currentTime, active.grant_id);
        }

        const tokenBytes = randomBytesImpl(32);
        if (!Buffer.isBuffer(tokenBytes) || tokenBytes.length < 32) throw coded("invalid_random_token");
        const token = tokenBytes.toString("base64url");
        appendEvent(eventInput);
        database.prepare(`INSERT INTO continuation_grants
          (grant_id, token_hash, task_uid, fingerprint, current_generation, next_generation,
           purpose, scope_digest, contract_revision, policy_revision, decision_basis_digest,
           evidence_digest, state, issued_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`).run(
          value.grantId, sha256(token), value.taskUid, value.fingerprint,
          value.currentGeneration, value.nextGeneration, value.purpose, value.scopeDigest,
          value.contractRevision, value.policyRevision, value.decisionBasisDigest,
          value.evidenceDigest, currentTime, value.expiresAt
        );
        database.prepare(`UPDATE convergence_loops SET status='grant_ready', active_grant_id=?,
          updated_at=?, version=version+1 WHERE fingerprint=?`).run(
          value.grantId, currentTime, value.fingerprint
        );
        return publicGrant(value, token);
      });
    },

    consumeContinuationGrant(input) {
      const value = exactObject(input, new Set([
        "eventUid", "token", "taskUid", "fingerprint", "currentGeneration",
        "nextGeneration", "purpose", "scopeDigest", "contractRevision", "policyRevision",
        "decisionBasisDigest", "evidenceDigest"
      ]), "grant_consumption");
      const eventUid = identifier(value.eventUid, "event_uid");
      const token = string(value.token, "token", 256);
      const taskUid = identifier(value.taskUid, "task_uid");
      const fingerprint = identifier(value.fingerprint, "fingerprint");
      const currentGeneration = integer(value.currentGeneration, "current_generation", 0);
      const nextGeneration = integer(value.nextGeneration, "next_generation", 1);
      const purpose = enumValue(value.purpose, GRANT_PURPOSE_SET, "purpose");
      const scopeDigest = digest(value.scopeDigest, "scope_digest");
      const contractRevision = digest(value.contractRevision, "contract_revision");
      const policyRevision = digest(value.policyRevision, "policy_revision");
      const decisionBasisDigest = digest(value.decisionBasisDigest, "decision_basis_digest");
      const evidenceDigest = digest(value.evidenceDigest, "evidence_digest");
      return transaction(() => {
        const eventInput = {
          eventUid, taskUid, fingerprint, generation: nextGeneration,
          eventType: "grant_consumed", action: purpose,
          evidenceDigest,
          sourceDigest: sha256(canonicalJson({
            contractRevision,
            currentGeneration,
            decisionBasisDigest,
            evidenceDigest,
            nextGeneration,
            policyRevision,
            purpose,
            scopeDigest,
            tokenHash: sha256(token)
          })),
          resultDigest: scopeDigest,
          facts: { generation: nextGeneration, purpose }
        };
        if (database.prepare("SELECT 1 FROM convergence_events WHERE event_uid=?").get(eventUid)) {
          const replay = appendEvent(eventInput);
          if (replay.replay) return Object.freeze({ fingerprint, generation: nextGeneration, purpose });
        }
        const grant = database.prepare("SELECT * FROM continuation_grants WHERE token_hash=?")
          .get(sha256(token));
        if (!grant) throw coded("grant_not_found");
        if (grant.state === "consumed") {
          throw coded("grant_consumed");
        }
        if (grant.state === "revoked") throw coded("grant_revoked");
        const task = requireTask(database, taskUid);
        const loop = requireLoop(database, taskUid, fingerprint);
        const bindingMatches = grant.task_uid === taskUid
          && grant.fingerprint === fingerprint
          && Number(grant.current_generation) === currentGeneration
          && Number(grant.next_generation) === nextGeneration
          && grant.purpose === purpose
          && grant.scope_digest === scopeDigest
          && grant.contract_revision === contractRevision
          && grant.policy_revision === policyRevision
          && grant.decision_basis_digest === decisionBasisDigest
          && grant.evidence_digest === evidenceDigest
          && task.contract_revision === contractRevision
          && task.policy_revision === policyRevision
          && loop.decision_basis_digest === decisionBasisDigest
          && loop.active_grant_id === grant.grant_id
          && Number(loop.fix_generation) === currentGeneration;
        if (!bindingMatches) throw coded("grant_binding_mismatch");
        const currentTime = timestamp(now);
        if (Date.parse(grant.expires_at) <= Date.parse(currentTime)) throw coded("grant_expired");
        validateTransition({ from: loop.status, eventType: "grant_consumed", to: "active_generation" });
        appendEvent(eventInput);
        const consumed = database.prepare(`UPDATE continuation_grants SET state='consumed',
          consumed_at=? WHERE grant_id=? AND state='active'`).run(currentTime, grant.grant_id);
        if (Number(consumed.changes) !== 1) throw coded("grant_consumed");
        database.prepare(`UPDATE convergence_loops SET status='active_generation',
          fix_generation=?, active_grant_id=NULL, updated_at=?, version=version+1
          WHERE fingerprint=? AND active_grant_id=?`).run(
          nextGeneration, currentTime, fingerprint, grant.grant_id
        );
        return Object.freeze({ fingerprint, generation: nextGeneration, purpose });
      });
    },

    resolveConvergenceLoop(input) {
      const value = exactObject(input, new Set([
        "eventUid", "taskUid", "fingerprint", "resolution", "reasonCode"
      ]), "convergence_resolution");
      const eventUid = identifier(value.eventUid, "event_uid");
      const taskUid = identifier(value.taskUid, "task_uid");
      const fingerprint = identifier(value.fingerprint, "fingerprint");
      const resolution = enumValue(value.resolution, new Set(["closed", "human_decision"]), "resolution");
      const reasonCode = identifier(value.reasonCode, "reason_code");
      return transaction(() => {
        const loop = requireLoop(database, taskUid, fingerprint);
        const decision = resolution === "closed" ? "finish" : "human_decision";
        const appended = appendEvent({
          eventUid, taskUid, fingerprint, generation: Number(loop.fix_generation),
          eventType: "task_resolved", reasonCode, decision, action: resolution, facts: {}
        });
        if (appended.replay) return loopView(loop);
        if (loop.active_grant_id !== null
            || ["pending", "retryable", "running"].includes(loop.probe_state)) {
          throw coded("loop_has_live_control");
        }
        validateTransition({ from: loop.status, eventType: "task_resolved", to: "terminal" });
        const currentTime = timestamp(now);
        database.prepare(`UPDATE convergence_loops SET status='terminal', current_decision=?,
          updated_at=?, version=version+1 WHERE fingerprint=?`).run(
          decision, currentTime, fingerprint
        );
        const remaining = database.prepare(`SELECT COUNT(*) AS count FROM convergence_loops
          WHERE task_uid=? AND status<>'terminal'`).get(taskUid);
        if (Number(remaining.count) === 0) {
          database.prepare(`UPDATE convergence_tasks SET state='terminal', updated_at=?
            WHERE task_uid=?`).run(currentTime, taskUid);
        }
        return loopView(requireLoop(database, taskUid, fingerprint));
      });
    },

    transactionalGuardImport(input) {
      const value = exactObject(input, new Set([
        "eventUid", "authorityTask", "sourceSha256", "mappingRevision", "tasks"
      ]), "guard_import");
      const eventUid = identifier(value.eventUid, "event_uid");
      const sourceSha256 = digest(value.sourceSha256, "source_sha256");
      const mappingRevision = identifier(value.mappingRevision, "mapping_revision");
      const taskFields = new Set([...TASK_FIELDS].filter((field) => field !== "eventUid"));
      const authorityTask = validateTask({
        ...exactObject(value.authorityTask, taskFields, "authority_task"), eventUid
      });
      if (!Array.isArray(value.tasks) || value.tasks.length > 128) throw coded("invalid_import_tasks");
      const loopFields = new Set([
        "fingerprint", "boundaryId", "canonicalInvariantId", "status", "failureCount",
        "fixGeneration", "decisionBasisDigest", "currentDecision", "directionGeneration", "aliases"
      ]);
      const eventFields = new Set([
        "eventUid", "fingerprint", "generation", "eventType", "reasonCode", "decision",
        "action", "evidenceDigest", "sourceDigest", "resultDigest", "facts"
      ]);
      const grantFields = new Set([
        "grantId", "tokenHash", "fingerprint", "currentGeneration", "nextGeneration",
        "purpose", "scopeDigest", "contractRevision", "policyRevision", "decisionBasisDigest",
        "evidenceDigest", "state", "issuedAt", "expiresAt", "consumedAt", "revokedAt"
      ]);
      const seenTaskUids = new Set([authorityTask.taskUid]);
      const seenFingerprints = new Set();
      const seenEventUids = new Set([eventUid]);
      const seenGrantIds = new Set();
      const seenTokenHashes = new Set();
      const groups = value.tasks.map((rawGroup) => {
        const group = exactObject(rawGroup, new Set(["task", "loops", "grants", "mappedEvents"]), "import_group");
        const task = validateTask({ ...exactObject(group.task, taskFields, "import_task"), eventUid });
        if (task.lineageDigest !== authorityTask.lineageDigest) throw coded("import_lineage_mismatch");
        if (seenTaskUids.has(task.taskUid)) throw coded("task_identity_collision");
        seenTaskUids.add(task.taskUid);
        if (!Array.isArray(group.loops) || group.loops.length > 128) throw coded("invalid_import_loops");
        if (!Array.isArray(group.grants) || group.grants.length > 128) throw coded("invalid_import_grants");
        if (!Array.isArray(group.mappedEvents) || group.mappedEvents.length > 512) {
          throw coded("invalid_import_events");
        }
        const identities = new Set();
        const loops = group.loops.map((raw) => {
          const loop = exactObject(raw, loopFields, "import_loop");
          if (!Array.isArray(loop.aliases) || loop.aliases.length > 128) throw coded("invalid_alias_projection");
          const aliases = loop.aliases.map((alias) => identifier(alias, "alias_invariant_id"));
          const mapped = Object.freeze({
            fingerprint: identifier(loop.fingerprint, "fingerprint"),
            boundaryId: identifier(loop.boundaryId, "boundary_id"),
            canonicalInvariantId: identifier(loop.canonicalInvariantId, "canonical_invariant_id"),
            status: enumValue(loop.status, LOOP_STATUSES, "loop_status"),
            failureCount: integer(loop.failureCount, "failure_count"),
            fixGeneration: integer(loop.fixGeneration, "fix_generation"),
            decisionBasisDigest: digest(loop.decisionBasisDigest, "decision_basis_digest"),
            currentDecision: enumValue(loop.currentDecision, DECISION_SET, "decision"),
            directionGeneration: integer(loop.directionGeneration, "direction_generation"),
            aliases: Object.freeze([...new Set(aliases)].sort())
          });
          const identity = `${mapped.boundaryId}\0${mapped.canonicalInvariantId}`;
          if (identities.has(identity) || seenFingerprints.has(mapped.fingerprint)) {
            throw coded("loop_identity_collision");
          }
          identities.add(identity);
          seenFingerprints.add(mapped.fingerprint);
          return mapped;
        });
        const groupFingerprints = new Set(loops.map((loop) => loop.fingerprint));
        const mappedEvents = group.mappedEvents.map((raw) => {
          const event = exactObject(raw, eventFields, "import_event");
          const eventType = enumValue(event.eventType, EVENT_TYPES, "event_type");
          if (["legacy_imported", "shadow_compared", "guard_cutover", "guard_rollback"].includes(eventType)) {
            throw coded("invalid_import_event_type");
          }
          const facts = exactObject(event.facts ?? {}, EVENT_FACT_FIELDS.get(eventType), "event_facts");
          for (const factValue of Object.values(facts)) {
            if (!(typeof factValue === "string" || Number.isSafeInteger(factValue))
                || (typeof factValue === "string" && factValue.length > 256)) {
              throw coded("invalid_event_fact");
            }
          }
          const fingerprint = event.fingerprint == null ? null : identifier(event.fingerprint, "fingerprint");
          if (fingerprint !== null && !groupFingerprints.has(fingerprint)) throw coded("import_reference_mismatch");
          const mapped = Object.freeze({
            eventUid: identifier(event.eventUid, "event_uid"), taskUid: task.taskUid, fingerprint,
            generation: event.generation == null ? null : integer(event.generation, "generation"),
            eventType,
            reasonCode: optionalString(event.reasonCode, "reason_code"),
            decision: event.decision == null ? null : enumValue(event.decision, DECISION_SET, "decision"),
            action: optionalString(event.action, "action"),
            evidenceDigest: optionalDigest(event.evidenceDigest, "evidence_digest"),
            sourceDigest: optionalDigest(event.sourceDigest, "source_digest"),
            resultDigest: optionalDigest(event.resultDigest, "result_digest"), facts
          });
          if (seenEventUids.has(mapped.eventUid)) throw coded("event_identity_collision");
          seenEventUids.add(mapped.eventUid);
          return mapped;
        });
        const grants = group.grants.map((raw) => {
          const grant = exactObject(raw, grantFields, "import_grant");
          const mapped = Object.freeze({
            grantId: identifier(grant.grantId, "grant_id"),
            tokenHash: digest(grant.tokenHash, "token_hash"),
            fingerprint: identifier(grant.fingerprint, "fingerprint"),
            currentGeneration: integer(grant.currentGeneration, "current_generation"),
            nextGeneration: integer(grant.nextGeneration, "next_generation", 1),
            purpose: enumValue(grant.purpose, GRANT_PURPOSE_SET, "purpose"),
            scopeDigest: digest(grant.scopeDigest, "scope_digest"),
            contractRevision: digest(grant.contractRevision, "contract_revision"),
            policyRevision: digest(grant.policyRevision, "policy_revision"),
            decisionBasisDigest: digest(grant.decisionBasisDigest, "decision_basis_digest"),
            evidenceDigest: digest(grant.evidenceDigest, "evidence_digest"),
            state: enumValue(grant.state, new Set(["active", "consumed", "revoked"]), "grant_state"),
            issuedAt: isoTimestamp(grant.issuedAt, "issued_at"),
            expiresAt: isoTimestamp(grant.expiresAt, "expires_at"),
            consumedAt: grant.consumedAt == null ? null : isoTimestamp(grant.consumedAt, "consumed_at"),
            revokedAt: grant.revokedAt == null ? null : isoTimestamp(grant.revokedAt, "revoked_at")
          });
          if (!groupFingerprints.has(mapped.fingerprint)) throw coded("import_reference_mismatch");
          if (seenGrantIds.has(mapped.grantId) || seenTokenHashes.has(mapped.tokenHash)) {
            throw coded("grant_identity_collision");
          }
          seenGrantIds.add(mapped.grantId);
          seenTokenHashes.add(mapped.tokenHash);
          return mapped;
        });
        const active = new Set();
        for (const grant of grants.filter((candidate) => candidate.state === "active")) {
          if (active.has(grant.fingerprint)) throw coded("active_grant_collision");
          active.add(grant.fingerprint);
        }
        return Object.freeze({ task, loops, grants, mappedEvents });
      });
      const counts = Object.freeze({
        taskCount: groups.length,
        loopCount: groups.reduce((sum, group) => sum + group.loops.length, 0),
        grantCount: groups.reduce((sum, group) => sum + group.grants.length, 0),
        consumedGrantCount: groups.reduce((sum, group) => sum
          + group.grants.filter((grant) => grant.state === "consumed").length, 0),
        eventCount: groups.reduce((sum, group) => sum + group.mappedEvents.length, 0)
      });
      const importContentDigest = sha256(canonicalJson({
        eventUid, authorityTask, sourceSha256, mappingRevision, groups
      }));
      const result = () => Object.freeze({
        imported: true,
        authorityTaskUid: authorityTask.taskUid,
        sourceSha256,
        mappingRevision,
        ...counts
      });
      return transaction(() => {
        const imported = database.prepare(`SELECT * FROM convergence_events
          WHERE task_uid=? AND event_type='legacy_imported' AND source_digest=?`).get(
            authorityTask.taskUid, sourceSha256
          );
        if (imported) {
          let facts;
          try { facts = JSON.parse(imported.facts_json); } catch { throw coded("import_collision"); }
          if (imported.result_digest !== importContentDigest
              || facts.mappingVersion !== mappingRevision) throw coded("import_collision");
          return result();
        }
        appendEvent({
          eventUid, taskUid: authorityTask.taskUid, eventType: "legacy_imported",
          sourceDigest: sourceSha256, resultDigest: importContentDigest,
          facts: { ...counts, mappingVersion: mappingRevision }
        });
        for (const group of groups) for (const event of group.mappedEvents) appendEvent(event);
        const currentTime = timestamp(now);
        for (const task of [authorityTask, ...groups.map((group) => group.task)]) {
          const existing = database.prepare("SELECT * FROM convergence_tasks WHERE task_uid=?").get(task.taskUid);
          if (existing && !sameTaskIdentity(existing, task)) throw coded("task_identity_collision");
          if (!existing) database.prepare(`INSERT INTO convergence_tasks
            (task_uid, lineage_digest, adapter_kind, adapter_capability, native_task_digest,
             contract_source_kind, contract_source_ref_digest, contract_revision, policy_revision,
             importance, importance_authority, state, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`).run(
            task.taskUid, task.lineageDigest, task.adapterKind, task.adapterCapability,
            task.nativeTaskDigest, task.contractSourceKind, task.contractSourceRefDigest,
            task.contractRevision, task.policyRevision, task.importance,
            task.importanceAuthority, currentTime, currentTime
          );
        }
        for (const group of groups) {
          for (const loop of group.loops) database.prepare(`INSERT INTO convergence_loops
            (fingerprint, task_uid, boundary_id, canonical_invariant_id, status, failure_count,
             fix_generation, decision_basis_digest, current_decision, direction_generation,
             aliases_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            loop.fingerprint, group.task.taskUid, loop.boundaryId, loop.canonicalInvariantId,
            loop.status, loop.failureCount, loop.fixGeneration, loop.decisionBasisDigest,
            loop.currentDecision, loop.directionGeneration, canonicalJson(loop.aliases),
            currentTime, currentTime
          );
          for (const grant of group.grants) {
            database.prepare(`INSERT INTO continuation_grants
              (grant_id, token_hash, task_uid, fingerprint, current_generation, next_generation,
               purpose, scope_digest, contract_revision, policy_revision, decision_basis_digest,
               evidence_digest, state, issued_at, expires_at, consumed_at, revoked_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
              grant.grantId, grant.tokenHash, group.task.taskUid, grant.fingerprint,
              grant.currentGeneration, grant.nextGeneration, grant.purpose, grant.scopeDigest,
              grant.contractRevision, grant.policyRevision, grant.decisionBasisDigest,
              grant.evidenceDigest, grant.state, grant.issuedAt, grant.expiresAt,
              grant.consumedAt, grant.revokedAt
            );
            if (grant.state === "active") database.prepare(`UPDATE convergence_loops
              SET active_grant_id=?, status='grant_ready' WHERE fingerprint=?`).run(
              grant.grantId, grant.fingerprint
            );
          }
        }
        return result();
      });
    },

    recordGuardShadowComparison(input) {
      const value = exactObject(input, new Set([
        "eventUid", "authorityTaskUid", "sourceSha256", "mappingRevision", "paritySetDigest",
        "field", "legacyValue", "kernelValue", "inputDigest", "legacyResultDigest",
        "kernelResultDigest", "matched"
      ]), "guard_shadow");
      const eventUid = identifier(value.eventUid, "event_uid");
      const authorityTaskUid = identifier(value.authorityTaskUid, "authority_task_uid");
      const sourceSha256 = digest(value.sourceSha256, "source_sha256");
      const mappingRevision = identifier(value.mappingRevision, "mapping_revision");
      const paritySetDigest = digest(value.paritySetDigest, "parity_set_digest");
      const field = enumValue(value.field, new Set(GUARD_PARITY_FIELDS), "guard_parity_field");
      const legacyValue = value.legacyValue;
      const kernelValue = value.kernelValue;
      const canonicalLegacy = canonicalGuardParityValue(field, "legacy", legacyValue);
      const canonicalKernel = canonicalGuardParityValue(field, "kernel", kernelValue);
      const inputDigest = digest(value.inputDigest, "input_digest");
      const legacyResultDigest = digest(value.legacyResultDigest, "legacy_result_digest");
      const kernelResultDigest = digest(value.kernelResultDigest, "kernel_result_digest");
      const matched = boolean(value.matched, "matched");
      const expectedInputDigest = sha256(canonicalJson({ field, legacy: legacyValue, kernel: kernelValue }));
      const expectedLegacyDigest = sha256(canonicalJson(canonicalLegacy));
      const expectedKernelDigest = sha256(canonicalJson(canonicalKernel));
      const expectedMatched = canonicalJson(canonicalLegacy) === canonicalJson(canonicalKernel);
      if (inputDigest !== expectedInputDigest || legacyResultDigest !== expectedLegacyDigest
          || kernelResultDigest !== expectedKernelDigest || matched !== expectedMatched) {
        throw coded("shadow_comparison_invalid");
      }
      return transaction(() => {
        const authority = requireTask(database, authorityTaskUid);
        const imported = database.prepare(`SELECT facts_json FROM convergence_events
          WHERE task_uid=? AND event_type='legacy_imported' AND source_digest=?
          ORDER BY id DESC LIMIT 1`).get(authorityTaskUid, sourceSha256);
        if (!imported || JSON.parse(imported.facts_json).mappingVersion !== mappingRevision) {
          throw coded("guard_import_not_found");
        }
        appendEvent({
          eventUid, taskUid: authorityTaskUid, eventType: "shadow_compared",
          evidenceDigest: inputDigest, sourceDigest: legacyResultDigest,
          resultDigest: kernelResultDigest, action: matched ? "matched" : "mismatch",
          facts: {
            field,
            legacyValue: parityFactValue(field, legacyValue),
            kernelValue: parityFactValue(field, kernelValue),
            mappingRevision,
            matched: matched ? 1 : 0,
            paritySetDigest,
            sourceSha256
          }
        });
        const rows = database.prepare(`SELECT facts_json FROM convergence_events
          WHERE task_uid=? AND event_type='shadow_compared' ORDER BY id`).all(authorityTaskUid)
          .map((row) => JSON.parse(row.facts_json))
          .filter((facts) => facts.paritySetDigest === paritySetDigest);
        return Object.freeze({
          matched,
          paritySetDigest,
          comparisonCount: rows.length,
          mismatchCount: rows.filter((facts) => Number(facts.matched) !== 1).length,
          lineageDigest: authority.lineage_digest
        });
      });
    },

    recordGuardCutover(input) {
      const value = exactObject(input, new Set([
        "eventUid", "authorityTaskUid", "sourceSha256", "mappingRevision", "paritySetDigest",
        "snapshotDigest", "snapshotDev", "snapshotIno", "snapshotMode", "snapshotType",
        "snapshotUid", "decisionRefDigest"
      ]), "guard_cutover");
      const eventUid = identifier(value.eventUid, "event_uid");
      const authorityTaskUid = identifier(value.authorityTaskUid, "authority_task_uid");
      const sourceSha256 = digest(value.sourceSha256, "source_sha256");
      const mappingRevision = identifier(value.mappingRevision, "mapping_revision");
      const paritySetDigest = digest(value.paritySetDigest, "parity_set_digest");
      const snapshotDigest = digest(value.snapshotDigest, "snapshot_digest");
      const snapshotDev = integer(value.snapshotDev, "snapshot_dev", 0, Number.MAX_SAFE_INTEGER);
      const snapshotIno = integer(value.snapshotIno, "snapshot_ino", 1, Number.MAX_SAFE_INTEGER);
      const snapshotMode = integer(value.snapshotMode, "snapshot_mode", 0, 0o777);
      const snapshotType = enumValue(value.snapshotType, new Set(["regular"]), "snapshot_type");
      const snapshotUid = integer(value.snapshotUid, "snapshot_uid", 0, Number.MAX_SAFE_INTEGER);
      const decisionRefDigest = digest(value.decisionRefDigest, "decision_ref_digest");
      if (snapshotDigest !== sourceSha256) throw coded("cutover_snapshot_mismatch");
      if (snapshotMode !== 0o400) throw coded("cutover_snapshot_unsafe");
      return transaction(() => {
        const eventInput = {
          eventUid, taskUid: authorityTaskUid, eventType: "guard_cutover",
          action: "afl_sqlite", evidenceDigest: decisionRefDigest,
          sourceDigest: sourceSha256, resultDigest: snapshotDigest,
          facts: {
            mappingRevision, paritySetDigest, snapshotDev, snapshotIno, snapshotMode,
            snapshotType, snapshotUid
          }
        };
        const prior = database.prepare("SELECT 1 FROM convergence_events WHERE event_uid=?").get(eventUid);
        const authority = requireTask(database, authorityTaskUid);
        const imported = database.prepare(`SELECT facts_json FROM convergence_events
          WHERE task_uid=? AND event_type='legacy_imported' AND source_digest=?
          ORDER BY id DESC LIMIT 1`).get(authorityTaskUid, sourceSha256);
        if (!imported || JSON.parse(imported.facts_json).mappingVersion !== mappingRevision) {
          throw coded("guard_import_not_found");
        }
        const latest = database.prepare(`SELECT event_uid, event_type FROM convergence_events
          WHERE task_uid=? AND event_type IN ('guard_cutover','guard_rollback')
          ORDER BY id DESC LIMIT 1`).get(authorityTaskUid);
        if (prior) {
          appendEvent(eventInput);
          if (latest?.event_uid !== eventUid || latest.event_type !== "guard_cutover") {
            throw coded("guard_cutover_superseded");
          }
          return Object.freeze({ authority: "afl_sqlite", cutoverEventUid: eventUid, snapshotDigest });
        }
        if (latest?.event_type === "guard_cutover") throw coded("guard_already_cut_over");
        const comparisons = database.prepare(`SELECT facts_json FROM convergence_events
          WHERE task_uid=? AND event_type='shadow_compared' ORDER BY id`).all(authorityTaskUid)
          .map((row) => JSON.parse(row.facts_json))
          .filter((facts) => facts.paritySetDigest === paritySetDigest);
        const fields = new Set(comparisons.map((facts) => facts.field));
        if (comparisons.length !== GUARD_PARITY_FIELDS.length
            || fields.size !== GUARD_PARITY_FIELDS.length
            || GUARD_PARITY_FIELDS.some((field) => !fields.has(field))
            || comparisons.some((facts) => Number(facts.matched) !== 1
              || facts.sourceSha256 !== sourceSha256
              || facts.mappingRevision !== mappingRevision)) {
          throw coded("shadow_parity_incomplete");
        }
        let reconstructedDigest;
        try {
          reconstructedDigest = guardParityDigest({
            sourceSha256,
            mappingRevision,
            comparisons: comparisons.map((facts) => ({
              field: facts.field,
              legacy: parityValueFromFact(facts.field, facts.legacyValue),
              kernel: parityValueFromFact(facts.field, facts.kernelValue)
            }))
          });
          for (const facts of comparisons) {
            const legacy = parityValueFromFact(facts.field, facts.legacyValue);
            const kernel = parityValueFromFact(facts.field, facts.kernelValue);
            if (canonicalJson(canonicalGuardParityValue(facts.field, "legacy", legacy))
                !== canonicalJson(canonicalGuardParityValue(facts.field, "kernel", kernel))) {
              throw coded("shadow_parity_incomplete");
            }
          }
        } catch {
          throw coded("shadow_parity_incomplete");
        }
        if (reconstructedDigest !== paritySetDigest) throw coded("shadow_parity_incomplete");
        const liveGrant = database.prepare(`SELECT 1 FROM continuation_grants g
          JOIN convergence_tasks t ON t.task_uid=g.task_uid
          WHERE t.lineage_digest=? AND g.state='active' LIMIT 1`).get(authority.lineage_digest);
        const liveProbe = database.prepare(`SELECT 1 FROM convergence_loops l
          JOIN convergence_tasks t ON t.task_uid=l.task_uid
          WHERE t.lineage_digest=? AND l.probe_state IN ('pending','retryable','running') LIMIT 1`)
          .get(authority.lineage_digest);
        if (liveGrant || liveProbe) throw coded("guard_live_action");
        appendEvent(eventInput);
        return Object.freeze({ authority: "afl_sqlite", cutoverEventUid: eventUid, snapshotDigest });
      });
    },

    recordGuardRollback(input) {
      const value = exactObject(input, new Set([
        "eventUid", "authorityTaskUid", "cutoverEventUid", "snapshotDigest", "snapshotDev",
        "snapshotIno", "snapshotMode", "snapshotType", "snapshotUid", "decisionRefDigest"
      ]), "guard_rollback");
      const eventUid = identifier(value.eventUid, "event_uid");
      const authorityTaskUid = identifier(value.authorityTaskUid, "authority_task_uid");
      const cutoverEventUid = identifier(value.cutoverEventUid, "cutover_event_uid");
      const snapshotDigest = digest(value.snapshotDigest, "snapshot_digest");
      const snapshotDev = integer(value.snapshotDev, "snapshot_dev", 0, Number.MAX_SAFE_INTEGER);
      const snapshotIno = integer(value.snapshotIno, "snapshot_ino", 1, Number.MAX_SAFE_INTEGER);
      const snapshotMode = integer(value.snapshotMode, "snapshot_mode", 0, 0o777);
      const snapshotType = enumValue(value.snapshotType, new Set(["regular"]), "snapshot_type");
      const snapshotUid = integer(value.snapshotUid, "snapshot_uid", 0, Number.MAX_SAFE_INTEGER);
      const decisionRefDigest = digest(value.decisionRefDigest, "decision_ref_digest");
      return transaction(() => {
        const eventInput = {
          eventUid, taskUid: authorityTaskUid, eventType: "guard_rollback",
          action: "legacy_guard", evidenceDigest: decisionRefDigest,
          resultDigest: snapshotDigest, facts: { cutoverEventUid }
        };
        const prior = database.prepare("SELECT 1 FROM convergence_events WHERE event_uid=?").get(eventUid);
        requireTask(database, authorityTaskUid);
        const cutover = database.prepare(`SELECT * FROM convergence_events
          WHERE task_uid=? AND event_uid=? AND event_type='guard_cutover'`).get(
            authorityTaskUid, cutoverEventUid
          );
        let cutoverFacts;
        try { cutoverFacts = JSON.parse(cutover?.facts_json ?? "null"); } catch {
          throw coded("cutover_snapshot_mismatch");
        }
        if (!cutover || cutover.result_digest !== snapshotDigest
            || cutoverFacts.snapshotDev !== snapshotDev
            || cutoverFacts.snapshotIno !== snapshotIno
            || cutoverFacts.snapshotMode !== snapshotMode
            || cutoverFacts.snapshotType !== snapshotType
            || cutoverFacts.snapshotUid !== snapshotUid) throw coded("cutover_snapshot_mismatch");
        const latest = database.prepare(`SELECT event_uid, event_type FROM convergence_events
          WHERE task_uid=? AND event_type IN ('guard_cutover','guard_rollback')
          ORDER BY id DESC LIMIT 1`).get(authorityTaskUid);
        if (prior) {
          appendEvent(eventInput);
          if (latest?.event_uid !== eventUid || latest.event_type !== "guard_rollback") {
            throw coded("guard_rollback_superseded");
          }
          return Object.freeze({ authority: "legacy_guard", rollbackEventUid: eventUid, snapshotDigest });
        }
        if (latest?.event_uid !== cutoverEventUid || latest.event_type !== "guard_cutover") {
          throw coded("guard_not_cut_over");
        }
        appendEvent(eventInput);
        return Object.freeze({ authority: "legacy_guard", rollbackEventUid: eventUid, snapshotDigest });
      });
    },

    getGuardAuthority(input) {
      const value = exactObject(input, new Set(["authorityTaskUid"]), "guard_authority");
      const authorityTaskUid = identifier(value.authorityTaskUid, "authority_task_uid");
      const task = database.prepare("SELECT * FROM convergence_tasks WHERE task_uid=?").get(authorityTaskUid);
      if (!task) return Object.freeze({
        authority: "afl_sqlite", imported: false, sourceSha256: null,
        mappingRevision: null, paritySetDigest: null, snapshotDigest: null,
        snapshotDev: null, snapshotIno: null, snapshotMode: null, snapshotType: null,
        snapshotUid: null, cutoverEventUid: null
      });
      const imported = database.prepare(`SELECT * FROM convergence_events
        WHERE task_uid=? AND event_type='legacy_imported' ORDER BY id DESC LIMIT 1`).get(authorityTaskUid);
      if (!imported) throw coded("guard_authority_invalid");
      const importFacts = JSON.parse(imported.facts_json);
      const latest = database.prepare(`SELECT * FROM convergence_events
        WHERE task_uid=? AND event_type IN ('guard_cutover','guard_rollback')
        ORDER BY id DESC LIMIT 1`).get(authorityTaskUid);
      if (!latest) return Object.freeze({
        authority: "legacy_guard", imported: true, sourceSha256: imported.source_digest,
        mappingRevision: importFacts.mappingVersion, paritySetDigest: null,
        snapshotDigest: null, snapshotDev: null, snapshotIno: null, snapshotMode: null,
        snapshotType: null, snapshotUid: null, cutoverEventUid: null
      });
      if (latest.event_type === "guard_cutover") {
        const facts = JSON.parse(latest.facts_json);
        return Object.freeze({
          authority: "afl_sqlite", imported: true, sourceSha256: latest.source_digest,
          mappingRevision: facts.mappingRevision, paritySetDigest: facts.paritySetDigest,
          snapshotDigest: latest.result_digest, snapshotDev: facts.snapshotDev,
          snapshotIno: facts.snapshotIno, snapshotMode: facts.snapshotMode,
          snapshotType: facts.snapshotType, snapshotUid: facts.snapshotUid,
          cutoverEventUid: latest.event_uid
        });
      }
      const facts = JSON.parse(latest.facts_json);
      const cutover = database.prepare("SELECT * FROM convergence_events WHERE event_uid=?")
        .get(facts.cutoverEventUid);
      const cutoverFacts = cutover ? JSON.parse(cutover.facts_json) : {};
      return Object.freeze({
        authority: "legacy_guard", imported: true, sourceSha256: imported.source_digest,
        mappingRevision: importFacts.mappingVersion, paritySetDigest: cutoverFacts.paritySetDigest ?? null,
        snapshotDigest: latest.result_digest, snapshotDev: cutoverFacts.snapshotDev ?? null,
        snapshotIno: cutoverFacts.snapshotIno ?? null, snapshotMode: cutoverFacts.snapshotMode ?? null,
        snapshotType: cutoverFacts.snapshotType ?? null, snapshotUid: cutoverFacts.snapshotUid ?? null,
        cutoverEventUid: facts.cutoverEventUid
      });
    },

    getConvergenceStatus(input) {
      const value = exactObject(input, new Set(["taskUid", "fingerprint"]), "convergence_status");
      return loopView(requireLoop(
        database,
        identifier(value.taskUid, "task_uid"),
        identifier(value.fingerprint, "fingerprint")
      ));
    }
  });
}
