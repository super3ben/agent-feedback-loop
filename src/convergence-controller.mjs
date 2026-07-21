import { createHash } from "node:crypto";

import { evaluateConvergence } from "./convergence-policy.mjs";

const TRUSTED_EVIDENCE_CLASSES = new Set([
  "explicit_user", "approved_spec", "approved_plan", "verified_runtime"
]);
const EVIDENCE_CLASSES = new Set([
  ...TRUSTED_EVIDENCE_CLASSES, "review_finding", "inferred_advisory"
]);
const PROBE_GRANT_PURPOSE = new Map([
  ["continue_once", "local_fix"],
  ["simplify_current_generation", "simplify"],
  ["rollback_to_generation", "rollback"]
]);
const DIGEST = /^[a-f0-9]{64}$/u;
const POST_PROBE_FIELDS = new Set([
  "store", "task", "loop", "request", "evidenceEventUid", "probeResultDigest", "now"
]);

function coded(code) {
  return Object.assign(new Error(code), { code });
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value), "utf8").digest("hex");
}

function digest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw coded(code);
  return value;
}

function timestamp(now) {
  if (typeof now !== "function") throw coded("controller_invalid");
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw coded("controller_invalid");
  return value;
}

function controllerEvent(kind, value) {
  return `controller-${kind}:${sha256(value)}`;
}

function exactInput(input, fields) {
  if (input === null || typeof input !== "object" || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype) throw coded("controller_invalid");
  if (Object.hasOwn(input, "verifiedEvidence")) throw coded("evidence_provenance_required");
  for (const field of Object.keys(input)) {
    if (!fields.has(field)) {
      throw coded("controller_invalid");
    }
  }
  return input;
}

function assertAuthority({ store, task, loop }) {
  if (!store || typeof store.getConvergenceStatus !== "function" || !store.database
      || !task || !loop || task.taskUid !== loop.taskUid) throw coded("controller_invalid");
  return store.getConvergenceStatus({ taskUid: task.taskUid, fingerprint: loop.fingerprint });
}

function assertContract(task, contract) {
  if (!contract || contract.revision !== task.contractRevision
      || contract.importance !== task.importance
      || contract.importanceAuthority !== task.importanceAuthority) {
    throw coded("decision_snapshot_mismatch");
  }
}

function consumedHistory(store, fingerprint) {
  const rows = store.database.prepare(`SELECT action FROM convergence_events
    WHERE fingerprint=? AND event_type='grant_consumed' ORDER BY id`).all(fingerprint);
  return Object.freeze({
    lastGrantPurpose: rows.at(-1)?.action ?? null,
    explorationUsed: rows.some((row) => row.action === "exploration")
  });
}

function evaluatedRequest({
  store,
  task,
  loop,
  request,
  evidenceQuality = request.evidenceQuality,
  previousBasis = request.previousDecisionBasisDigest
}) {
  assertContract(task, request?.contract);
  const history = consumedHistory(store, loop.fingerprint);
  const previousDecisionBasisDigest = previousBasis;
  return {
    ...request,
    adapterCapability: task.adapterCapability,
    previousDecisionBasisDigest,
    decisionBasisDigest: loop.decisionBasisDigest,
    currentGeneration: loop.currentGeneration,
    requestedGeneration: loop.currentGeneration + 1,
    failureCount: loop.failureCount,
    lastGrantPurpose: history.lastGrantPurpose,
    explorationUsed: history.explorationUsed,
    evidenceQuality,
    evidenceChanged: previousDecisionBasisDigest !== loop.decisionBasisDigest,
    probeAction: request.probeAction ?? null
  };
}

function previousReviewBasis(store, loop) {
  const rows = store.database.prepare(`SELECT result_digest FROM convergence_events
    WHERE fingerprint=? AND event_type='review_recorded' ORDER BY id DESC LIMIT 2`).all(loop.fingerprint);
  return rows[1]?.result_digest ?? sha256({
    fingerprint: loop.fingerprint,
    state: "before_first_review"
  });
}

function eventFacts(row) {
  let facts;
  try { facts = JSON.parse(row.facts_json); } catch { throw coded("evidence_provenance_invalid"); }
  if (facts === null || typeof facts !== "object" || Array.isArray(facts)
      || Object.getPrototypeOf(facts) !== Object.prototype) {
    throw coded("evidence_provenance_invalid");
  }
  return facts;
}

function latestReview(store, fingerprint) {
  const row = store.database.prepare(`SELECT * FROM convergence_events
    WHERE fingerprint=? AND event_type='review_recorded' ORDER BY id DESC LIMIT 1`).get(fingerprint);
  if (!row) return null;
  return Object.freeze({ row, facts: Object.freeze(eventFacts(row)) });
}

function assertLocalReviewAuthorization(store, loop) {
  const review = latestReview(store, loop.fingerprint);
  if (!review) throw coded("continuation_not_authorized");
  const counted = review.facts.verdict === "changes_required"
    && (review.facts.severity === "important" || review.facts.severity === "critical");
  const requiresDirection = counted
    && (review.facts.directionSignal !== "none" || Number(review.facts.failureCount) >= 2);
  if (requiresDirection || review.row.decision === "checkpoint_required") {
    throw coded("direction_review_required");
  }
}

function completionEvent(store, loop) {
  const row = store.database.prepare(`SELECT * FROM convergence_events
    WHERE task_uid=? AND fingerprint=? AND event_type='reflection_completed'
    ORDER BY id DESC LIMIT 1`).get(loop.taskUid, loop.fingerprint);
  if (!row || row.generation !== loop.currentGeneration
      || row.result_digest !== loop.probeResultDigest
      || (!PROBE_GRANT_PURPOSE.has(row.action)
        && !["direction_checkpoint", "human_decision", "finish_now"].includes(row.action))) {
    throw coded("probe_result_mismatch");
  }
  return row;
}

function provenanceEvent(store, loop, eventUid) {
  if (eventUid === undefined || eventUid === null) return null;
  if (typeof eventUid !== "string" || eventUid.length === 0) {
    throw coded("evidence_provenance_invalid");
  }
  const row = store.database.prepare(
    "SELECT * FROM convergence_events WHERE event_uid=?"
  ).get(eventUid);
  if (!row || row.task_uid !== loop.taskUid || row.fingerprint !== loop.fingerprint
      || !["review_recorded", "evidence_recorded"].includes(row.event_type)) {
    throw coded("evidence_provenance_invalid");
  }
  const latest = store.database.prepare(`SELECT event_uid FROM convergence_events
    WHERE task_uid=? AND fingerprint=? AND event_type IN ('review_recorded', 'evidence_recorded')
    ORDER BY id DESC LIMIT 1`).get(loop.taskUid, loop.fingerprint);
  if (latest?.event_uid !== row.event_uid || row.result_digest !== loop.decisionBasisDigest) {
    throw coded("evidence_provenance_stale");
  }
  const facts = eventFacts(row);
  const evidenceClass = row.event_type === "review_recorded"
    ? "review_finding"
    : facts.evidenceClass;
  if (!EVIDENCE_CLASSES.has(evidenceClass) || !DIGEST.test(row.evidence_digest ?? "")) {
    throw coded("evidence_provenance_invalid");
  }
  const previous = store.database.prepare(`SELECT result_digest FROM convergence_events
    WHERE task_uid=? AND fingerprint=? AND id<?
      AND event_type IN ('review_recorded', 'evidence_recorded')
    ORDER BY id DESC LIMIT 1`).get(loop.taskUid, loop.fingerprint, row.id);
  return Object.freeze({
    eventUid: row.event_uid,
    evidenceClass,
    evidenceDigest: row.evidence_digest,
    decisionBasisDigest: row.result_digest,
    previousDecisionBasisDigest: previous?.result_digest ?? sha256({
      fingerprint: loop.fingerprint,
      state: "before_first_evidence"
    }),
    trusted: TRUSTED_EVIDENCE_CLASSES.has(evidenceClass)
  });
}

function postProbeScope(loop, action, purpose) {
  const scope = {
    action,
    boundaryId: loop.boundaryId,
    canonicalInvariantId: loop.canonicalInvariantId,
    currentGeneration: loop.currentGeneration,
    fingerprint: loop.fingerprint,
    nextGeneration: loop.currentGeneration + 1,
    purpose,
    taskUid: loop.taskUid
  };
  if (purpose === "rollback") {
    scope.rollbackTargetGeneration = Math.max(0, loop.currentGeneration - 1);
  }
  return sha256(scope);
}

function decisionTarget(decision) {
  return {
    reflection_required: "reflection_required",
    checkpoint_required: "checkpoint_required",
    hold: "checkpoint_required",
    human_decision: "human_decision",
    finish: "terminal"
  }[decision] ?? null;
}

function recordHardDecision({ store, task, loop, request, decision }) {
  const targetStatus = decisionTarget(decision.decision);
  if (targetStatus === null) return loop;
  return store.recordConvergenceDecision({
    eventUid: controllerEvent("decision", {
      taskUid: task.taskUid,
      fingerprint: loop.fingerprint,
      request,
      decision
    }),
    taskUid: task.taskUid,
    fingerprint: loop.fingerprint,
    evaluationRequest: request,
    evaluation: decision,
    targetStatus
  });
}

function probeLaunch(launchProbe, reservation) {
  if (typeof launchProbe !== "function") return { attempted: false, reason: "launch_unavailable" };
  try {
    const launched = launchProbe(Object.freeze({
      taskUid: reservation.taskUid,
      fingerprint: reservation.fingerprint,
      probeKind: reservation.probeKind,
      probeState: reservation.probeState
    }));
    return launched && typeof launched === "object" && launched.attempted === true
      ? { attempted: true, reason: String(launched.reason ?? "spawn_attempted") }
      : { attempted: false, reason: "launch_failed" };
  } catch {
    return { attempted: false, reason: "launch_failed" };
  }
}

function issueAuthorizedContinuation({
  store,
  task,
  loop,
  purpose,
  scopeDigest,
  evidenceDigest,
  policyDecision = null,
  probeAction = null,
  now = () => new Date()
} = {}) {
  const current = assertAuthority({ store, task, loop });
  digest(scopeDigest, "invalid_scope_digest");
  digest(evidenceDigest, "invalid_evidence_digest");
  const policyPass = policyDecision?.decision === "pass";
  const activePurpose = current.activeGrantId === null ? null : store.database.prepare(
    "SELECT purpose FROM continuation_grants WHERE grant_id=? AND state='active'"
  ).get(current.activeGrantId)?.purpose ?? null;
  const sameGrantReplay = current.status === "grant_ready" && activePurpose === purpose;
  const allowed = purpose === "architecture_fix"
    ? current.status === "direction_approved" || sameGrantReplay
    : purpose === "exploration"
      ? (current.status === "generation_closed" || sameGrantReplay)
        && policyPass && policyDecision.reasonCode === "exploration_grant_available"
      : purpose === "local_fix" && (current.status === "generation_closed" || sameGrantReplay)
        ? policyPass
        : current.status === "reflection_resolved"
          && policyPass && PROBE_GRANT_PURPOSE.get(probeAction) === purpose;
  if (!allowed) throw coded("continuation_not_authorized");
  const identity = {
    taskUid: task.taskUid,
    fingerprint: current.fingerprint,
    currentGeneration: current.currentGeneration,
    purpose,
    scopeDigest,
    decisionBasisDigest: current.decisionBasisDigest,
    evidenceDigest
  };
  const eventUid = controllerEvent("grant", identity);
  const grantId = controllerEvent("grant-id", identity);
  const existingGrant = store.database.prepare(
    "SELECT expires_at FROM continuation_grants WHERE grant_id=?"
  ).get(grantId);
  const expiresAt = existingGrant?.expires_at
    ?? new Date(timestamp(now).getTime() + 5 * 60_000).toISOString();
  const grant = store.issueContinuationGrant({
    eventUid,
    grantId,
    taskUid: task.taskUid,
    fingerprint: current.fingerprint,
    currentGeneration: current.currentGeneration,
    nextGeneration: current.currentGeneration + 1,
    purpose,
    scopeDigest,
    contractRevision: task.contractRevision,
    policyRevision: task.policyRevision,
    decisionBasisDigest: current.decisionBasisDigest,
    evidenceDigest,
    expiresAt
  });
  return Object.freeze({ action: "grant_issued", grant });
}

export function authorizeContinuation(input = {}) {
  if (input?.purpose !== "local_fix" && input?.purpose !== "architecture_fix") {
    throw coded("continuation_not_authorized");
  }
  if (input.purpose === "architecture_fix") return issueAuthorizedContinuation(input);
  const current = assertAuthority(input);
  if (!input.request || current.failureCount !== 1) throw coded("continuation_not_authorized");
  assertLocalReviewAuthorization(input.store, current);
  const request = evaluatedRequest({
    store: input.store,
    task: input.task,
    loop: current,
    request: input.request,
    evidenceQuality: "verified",
    previousBasis: previousReviewBasis(input.store, current)
  });
  const policyDecision = evaluateConvergence(request);
  if (policyDecision.decision !== "pass") throw coded("continuation_not_authorized");
  return issueAuthorizedContinuation({ ...input, loop: current, policyDecision });
}

export function evaluateAndAdvance({
  store,
  task,
  loop,
  request,
  launchProbe,
  now = () => new Date()
} = {}) {
  const current = assertAuthority({ store, task, loop });
  const evaluationRequest = evaluatedRequest({ store, task, loop: current, request });
  const decision = evaluateConvergence(evaluationRequest);

  if (decision.decision === "pass" && decision.reasonCode === "exploration_grant_available") {
    const scopeDigest = sha256({
      taskUid: task.taskUid,
      fingerprint: current.fingerprint,
      generation: current.currentGeneration,
      purpose: "exploration",
      riskHypothesis: evaluationRequest.riskHypothesis,
      falsificationTest: evaluationRequest.falsificationTest
    });
    return Object.freeze({
      ...issueAuthorizedContinuation({
        store,
        task,
        loop: current,
        purpose: "exploration",
        scopeDigest,
        evidenceDigest: current.decisionBasisDigest,
        policyDecision: decision,
        now
      }),
      decision
    });
  }

  const advanced = recordHardDecision({
    store,
    task,
    loop: current,
    request: evaluationRequest,
    decision
  });
  if (decision.decision === "reflection_required") {
    const probeEventUid = controllerEvent("probe", {
      taskUid: task.taskUid,
      fingerprint: current.fingerprint,
      reasonCode: decision.reasonCode,
      decisionBasisDigest: current.decisionBasisDigest
    });
    const priorReservation = store.database.prepare(
      "SELECT created_at FROM convergence_events WHERE event_uid=?"
    ).get(probeEventUid);
    const dueAt = priorReservation?.created_at ?? timestamp(now).toISOString();
    const reservation = store.requestConvergenceProbe({
      eventUid: probeEventUid,
      taskUid: task.taskUid,
      fingerprint: current.fingerprint,
      probeKind: "convergence_reflection",
      dueAt
    });
    const currentTime = timestamp(now).getTime();
    const due = ["pending", "retryable"].includes(reservation.probeState)
      && reservation.probeNextAttemptAt !== null
      && Date.parse(reservation.probeNextAttemptAt) <= currentTime;
    const launched = due
      ? probeLaunch(launchProbe, reservation)
      : { attempted: false, reason: ["running", "completed"].includes(reservation.probeState)
          ? `probe_${reservation.probeState}`
          : "probe_not_due" };
    return Object.freeze({
      action: launched.attempted
        ? "probe_started"
        : reservation.probeState === "completed" ? "reflection_resolved" : "reflection_required",
      decision,
      loop: reservation,
      launch: Object.freeze(launched)
    });
  }
  const action = decision.decision === "hold" ? "checkpoint_required" : decision.decision;
  return Object.freeze({ action, decision, loop: advanced });
}

export function authorizeAfterProbe(rawInput = {}) {
  const input = exactInput(rawInput, POST_PROBE_FIELDS);
  const {
    store,
    task,
    loop,
    request,
    evidenceEventUid,
    probeResultDigest,
    now = () => new Date()
  } = input;
  const current = assertAuthority({ store, task, loop });
  if (!["reflection_resolved", "grant_ready", "checkpoint_required", "human_decision", "terminal"]
    .includes(current.status) || current.probeState !== "completed") {
    throw coded("probe_not_resolved");
  }
  const completed = completionEvent(store, current);
  if (probeResultDigest !== undefined
      && digest(probeResultDigest, "invalid_probe_result_digest") !== completed.result_digest) {
    throw coded("probe_result_mismatch");
  }
  const provenance = provenanceEvent(store, current, evidenceEventUid);
  const evaluationRequest = evaluatedRequest({
    store,
    task,
    loop: current,
    request: {
      ...request,
      probeAction: completed.action,
      previousDecisionBasisDigest: provenance?.previousDecisionBasisDigest
        ?? current.decisionBasisDigest
    },
    evidenceQuality: provenance === null ? "none" : "verified",
    previousBasis: provenance?.previousDecisionBasisDigest ?? current.decisionBasisDigest
  });
  const decision = evaluateConvergence(evaluationRequest);

  if (completed.action === "finish_now") {
    if (provenance?.trusted !== true || evaluationRequest.acceptanceSatisfied !== true) {
      throw coded("verified_acceptance_required");
    }
    if (decision.decision !== "finish") throw coded("finish_not_authorized");
    const resolved = recordHardDecision({
      store,
      task,
      loop: current,
      request: evaluationRequest,
      decision
    });
    return Object.freeze({ action: "finish", decision, loop: resolved });
  }
  if (decision.decision === "checkpoint_required" || decision.decision === "hold") {
    const advanced = recordHardDecision({ store, task, loop: current, request: evaluationRequest, decision });
    return Object.freeze({ action: "checkpoint_required", decision, loop: advanced });
  }
  if (decision.decision === "human_decision") {
    const advanced = recordHardDecision({ store, task, loop: current, request: evaluationRequest, decision });
    return Object.freeze({ action: "human_decision", decision, loop: advanced });
  }
  const purpose = PROBE_GRANT_PURPOSE.get(completed.action);
  if (decision.decision !== "pass" || purpose === undefined) {
    throw coded("verified_basis_or_exploration_required");
  }
  return Object.freeze({
    ...issueAuthorizedContinuation({
      store,
      task,
      loop: current,
      purpose,
      scopeDigest: postProbeScope(current, completed.action, purpose),
      evidenceDigest: provenance?.evidenceDigest ?? current.decisionBasisDigest,
      policyDecision: decision,
      probeAction: completed.action,
      now
    }),
    decision,
    purpose
  });
}
