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
  "task_resolved", "legacy_imported", "shadow_compared"
]);
const EVENT_FACT_FIELDS = new Map([
  ["contract_projected", new Set()],
  ["generation_opened", new Set(["generation", "purpose"])],
  ["evidence_recorded", new Set(["evidenceClass"])],
  ["review_recorded", new Set(["directionSignal", "failureCount", "severity", "verdict"])],
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
  ["legacy_imported", new Set(["eventCount", "grantCount", "loopCount", "mappingVersion"])],
  ["shadow_compared", new Set()]
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
  "semanticRecommendation"
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
    if (!Object.hasOwn(request, field)) throw coded("invalid_decision_snapshot");
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
        const replayEvent = database.prepare("SELECT * FROM convergence_events WHERE event_uid=?")
          .get(value.eventUid);
        if (replayEvent) {
          let replayFacts;
          try { replayFacts = JSON.parse(replayEvent.facts_json); } catch { throw coded("event_collision"); }
          const replayMatches = replayEvent.task_uid === value.taskUid
            && replayEvent.fingerprint === value.fingerprint
            && Number(replayEvent.generation) === value.generation
            && replayEvent.event_type === "review_recorded"
            && replayEvent.evidence_digest === value.evidenceDigest
            && replayEvent.result_digest === value.decisionBasisDigest
            && replayFacts.directionSignal === value.directionSignal
            && replayFacts.severity === value.severity
            && replayFacts.verdict === value.verdict;
          if (!replayMatches) throw coded("event_collision");
          return loopView(requireLoop(database, value.taskUid, value.fingerprint));
        }
        const candidates = database.prepare(`SELECT * FROM convergence_loops
          WHERE task_uid=? AND boundary_id=?`).all(value.taskUid, value.boundaryId);
        const exact = candidates.find((row) => row.canonical_invariant_id === value.canonicalInvariantId);
        const aliased = exact ?? candidates.find((row) => parseAliases(row.aliases_json)
          .includes(value.canonicalInvariantId));
        const existing = aliased ?? null;
        if (exact && exact.fingerprint !== value.fingerprint) throw coded("fingerprint_collision");
        const byFingerprint = database.prepare("SELECT * FROM convergence_loops WHERE fingerprint=?")
          .get(value.fingerprint);
        if (byFingerprint && (!existing || byFingerprint.fingerprint !== existing.fingerprint)) {
          throw coded("fingerprint_collision");
        }
        const fingerprint = existing?.fingerprint ?? value.fingerprint;
        const historicalEvidence = existing && database.prepare(`SELECT 1 FROM convergence_events
          WHERE task_uid=? AND fingerprint=? AND event_type='review_recorded' AND evidence_digest=?
          LIMIT 1`).get(value.taskUid, fingerprint, value.evidenceDigest);
        const failed = value.verdict === "changes_required" && !historicalEvidence;
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
          sourceDigest: sha256(value.fingerprint),
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
        "outcome", "action", "resultDigest"
      ]), "convergence_probe_completion");
      const eventUid = identifier(value.eventUid, "event_uid");
      const taskUid = identifier(value.taskUid, "task_uid");
      const fingerprint = identifier(value.fingerprint, "fingerprint");
      const ownerId = identifier(value.ownerId, "owner_id");
      const leaseEpoch = integer(value.leaseEpoch, "lease_epoch", 1);
      const outcomes = new Set(["reflection_resolved", "checkpoint_required", "human_decision", "terminal"]);
      const outcome = enumValue(value.outcome, outcomes, "outcome");
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
        validateTransition({ from: loop.status, eventType: "reflection_completed", to: outcome });
        database.prepare(`UPDATE convergence_loops SET status=?, probe_state='completed',
          probe_owner_id=NULL, probe_lease_until=NULL, probe_next_attempt_at=NULL,
          probe_result_digest=?, updated_at=?, version=version+1 WHERE fingerprint=?`).run(
          outcome, resultDigest, currentTime, fingerprint
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
        "eventUid", "sourceDigest", "mappingVersion", "task", "loops", "grants", "mappedEvents"
      ]), "guard_import");
      const eventUid = identifier(value.eventUid, "event_uid");
      const sourceDigest = digest(value.sourceDigest, "source_digest");
      const mappingVersion = identifier(value.mappingVersion, "mapping_version");
      const task = validateTask({
        ...exactObject(value.task, new Set([...TASK_FIELDS].filter((field) => field !== "eventUid")), "import_task"),
        eventUid
      });
      if (!Array.isArray(value.loops) || value.loops.length > 128) throw coded("invalid_import_loops");
      if (!Array.isArray(value.grants) || value.grants.length > 128) throw coded("invalid_import_grants");
      if (!Array.isArray(value.mappedEvents) || value.mappedEvents.length > 512) {
        throw coded("invalid_import_events");
      }
      const loopFields = new Set([
        "fingerprint", "boundaryId", "canonicalInvariantId", "status", "failureCount",
        "fixGeneration", "decisionBasisDigest", "currentDecision", "directionGeneration", "aliases"
      ]);
      const loops = value.loops.map((raw) => {
        const loop = exactObject(raw, loopFields, "import_loop");
        if (!Array.isArray(loop.aliases) || loop.aliases.length > 128) throw coded("invalid_alias_projection");
        const aliases = loop.aliases.map((alias) => identifier(alias, "alias_invariant_id"));
        return Object.freeze({
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
      });
      const identityKeys = new Set();
      const fingerprints = new Set();
      for (const loop of loops) {
        const key = `${loop.boundaryId}\0${loop.canonicalInvariantId}`;
        if (identityKeys.has(key) || fingerprints.has(loop.fingerprint)) throw coded("loop_identity_collision");
        identityKeys.add(key);
        fingerprints.add(loop.fingerprint);
      }
      const mappedEventFields = new Set([
        "eventUid", "fingerprint", "generation", "eventType", "reasonCode", "decision",
        "action", "evidenceDigest", "sourceDigest", "resultDigest", "facts"
      ]);
      const mappedEvents = value.mappedEvents.map((raw) => {
        const event = exactObject(raw, mappedEventFields, "import_event");
        const eventType = enumValue(event.eventType, EVENT_TYPES, "event_type");
        const facts = exactObject(
          event.facts ?? {},
          EVENT_FACT_FIELDS.get(eventType),
          "event_facts"
        );
        for (const factValue of Object.values(facts)) {
          if (!(typeof factValue === "string" || Number.isSafeInteger(factValue))) {
            throw coded("invalid_event_fact");
          }
          if (typeof factValue === "string" && factValue.length > 256) throw coded("invalid_event_fact");
        }
        return Object.freeze({
          eventUid: identifier(event.eventUid, "event_uid"),
          taskUid: task.taskUid,
          fingerprint: event.fingerprint == null ? null : identifier(event.fingerprint, "fingerprint"),
          generation: event.generation == null ? null : integer(event.generation, "generation"),
          eventType,
          reasonCode: optionalString(event.reasonCode, "reason_code"),
          decision: event.decision == null ? null : enumValue(event.decision, DECISION_SET, "decision"),
          action: optionalString(event.action, "action"),
          evidenceDigest: optionalDigest(event.evidenceDigest, "evidence_digest"),
          sourceDigest: optionalDigest(event.sourceDigest, "source_digest"),
          resultDigest: optionalDigest(event.resultDigest, "result_digest"),
          facts
        });
      });
      const grantFields = new Set([
        "grantId", "tokenHash", "fingerprint", "currentGeneration", "nextGeneration",
        "purpose", "scopeDigest", "contractRevision", "policyRevision", "decisionBasisDigest",
        "evidenceDigest", "state", "issuedAt", "expiresAt", "consumedAt", "revokedAt"
      ]);
      const grants = value.grants.map((raw) => {
        const grant = exactObject(raw, grantFields, "import_grant");
        return Object.freeze({
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
      });
      const activeGrantFingerprints = new Set();
      for (const grant of grants) {
        if (grant.state !== "active") continue;
        if (activeGrantFingerprints.has(grant.fingerprint)) throw coded("active_grant_collision");
        activeGrantFingerprints.add(grant.fingerprint);
      }
      const importContentDigest = sha256(canonicalJson({
        eventUid,
        mappingVersion,
        task,
        loops,
        grants,
        mappedEvents
      }));
      return transaction(() => {
        const imported = database.prepare(`SELECT * FROM convergence_events
          WHERE event_type='legacy_imported' AND source_digest=?`).get(sourceDigest);
        if (imported) {
          if (imported.result_digest !== importContentDigest) throw coded("import_collision");
          let facts;
          try { facts = JSON.parse(imported.facts_json); } catch { throw coded("import_collision"); }
          return Object.freeze({
            imported: true,
            sourceDigest,
            taskUid: imported.task_uid,
            loopCount: Number(facts.loopCount),
            grantCount: Number(facts.grantCount),
            eventCount: Number(facts.eventCount)
          });
        }

        appendEvent({
          eventUid, taskUid: task.taskUid, eventType: "legacy_imported", sourceDigest,
          resultDigest: importContentDigest,
          facts: {
            eventCount: mappedEvents.length,
            grantCount: grants.length,
            loopCount: loops.length,
            mappingVersion
          }
        });
        for (const event of mappedEvents) appendEvent(event);
        const currentTime = timestamp(now);
        const existingTask = database.prepare("SELECT * FROM convergence_tasks WHERE task_uid=?")
          .get(task.taskUid);
        if (existingTask && !sameTaskIdentity(existingTask, task)) throw coded("task_identity_collision");
        if (!existingTask) {
          database.prepare(`INSERT INTO convergence_tasks
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
        for (const loop of loops) {
          database.prepare(`INSERT INTO convergence_loops
            (fingerprint, task_uid, boundary_id, canonical_invariant_id, status, failure_count,
             fix_generation, decision_basis_digest, current_decision, direction_generation,
             aliases_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            loop.fingerprint, task.taskUid, loop.boundaryId, loop.canonicalInvariantId,
            loop.status, loop.failureCount, loop.fixGeneration, loop.decisionBasisDigest,
            loop.currentDecision, loop.directionGeneration, canonicalJson(loop.aliases),
            currentTime, currentTime
          );
        }
        for (const grant of grants) {
          database.prepare(`INSERT INTO continuation_grants
            (grant_id, token_hash, task_uid, fingerprint, current_generation, next_generation,
             purpose, scope_digest, contract_revision, policy_revision, decision_basis_digest,
             evidence_digest, state, issued_at, expires_at, consumed_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            grant.grantId, grant.tokenHash, task.taskUid, grant.fingerprint,
            grant.currentGeneration, grant.nextGeneration, grant.purpose, grant.scopeDigest,
            grant.contractRevision, grant.policyRevision, grant.decisionBasisDigest,
            grant.evidenceDigest, grant.state, grant.issuedAt, grant.expiresAt,
            grant.consumedAt, grant.revokedAt
          );
          if (grant.state === "active") {
            database.prepare(`UPDATE convergence_loops SET active_grant_id=?, status='grant_ready'
              WHERE fingerprint=?`).run(grant.grantId, grant.fingerprint);
          }
        }
        return Object.freeze({
          imported: true,
          sourceDigest,
          taskUid: task.taskUid,
          loopCount: loops.length,
          grantCount: grants.length,
          eventCount: mappedEvents.length
        });
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
