import { createHash } from "node:crypto";

import { evaluateConvergence } from "./convergence-policy.mjs";
import { validateConvergenceProbeResult } from "./convergence-probe-result.mjs";

const TRUSTED_EVIDENCE = new Set([
  "explicit_user", "approved_spec", "approved_plan", "verified_runtime"
]);
const PROBE_GRANT_PURPOSE = new Map([
  ["continue_once", "local_fix"],
  ["simplify_current_generation", "simplify"],
  ["rollback_to_generation", "rollback"]
]);
const DIGEST = /^[a-f0-9]{64}$/u;

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
    evidenceChanged: previousDecisionBasisDigest !== loop.decisionBasisDigest
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
    const reservationExisted = priorReservation !== undefined;
    const dueAt = priorReservation?.created_at ?? timestamp(now).toISOString();
    const reservation = store.requestConvergenceProbe({
      eventUid: probeEventUid,
      taskUid: task.taskUid,
      fingerprint: current.fingerprint,
      probeKind: "convergence_reflection",
      dueAt
    });
    const launched = reservationExisted
      ? { attempted: false, reason: "reservation_replayed" }
      : probeLaunch(launchProbe, reservation);
    return Object.freeze({
      action: launched.attempted ? "probe_started" : "reflection_required",
      decision,
      loop: reservation,
      launch: Object.freeze(launched)
    });
  }
  const action = decision.decision === "hold" ? "checkpoint_required" : decision.decision;
  return Object.freeze({ action, decision, loop: advanced });
}

function recordVerifiedEvidence({ store, task, loop, verifiedEvidence }) {
  if (verifiedEvidence === null) return loop;
  if (verifiedEvidence === undefined || verifiedEvidence === null
      || typeof verifiedEvidence !== "object" || Array.isArray(verifiedEvidence)
      || Object.getPrototypeOf(verifiedEvidence) !== Object.prototype
      || Object.keys(verifiedEvidence).sort().join(",")
        !== "decisionBasisDigest,evidenceClass,evidenceDigest"
      || !TRUSTED_EVIDENCE.has(verifiedEvidence.evidenceClass)) {
    throw coded("verified_evidence_invalid");
  }
  digest(verifiedEvidence.evidenceDigest, "invalid_evidence_digest");
  digest(verifiedEvidence.decisionBasisDigest, "invalid_decision_basis_digest");
  store.recordConvergenceEvidence({
    eventUid: controllerEvent("evidence", {
      taskUid: task.taskUid,
      fingerprint: loop.fingerprint,
      ...verifiedEvidence
    }),
    taskUid: task.taskUid,
    fingerprint: loop.fingerprint,
    ...verifiedEvidence
  });
  return store.getConvergenceStatus({ taskUid: task.taskUid, fingerprint: loop.fingerprint });
}

export function authorizeAfterProbe({
  store,
  task,
  loop,
  request,
  probeResult,
  verifiedEvidence = null,
  scopeDigest,
  now = () => new Date()
} = {}) {
  const beforeEvidence = assertAuthority({ store, task, loop });
  if (beforeEvidence.status !== "reflection_resolved" || beforeEvidence.probeState !== "completed") {
    throw coded("probe_not_resolved");
  }
  const validatedProbe = validateConvergenceProbeResult(probeResult);
  if (sha256(validatedProbe) !== beforeEvidence.probeResultDigest) throw coded("probe_result_mismatch");
  const current = recordVerifiedEvidence({
    store,
    task,
    loop: beforeEvidence,
    verifiedEvidence
  });
  const evaluationRequest = evaluatedRequest({
    store,
    task,
    loop: current,
    request: {
      ...request,
      previousDecisionBasisDigest: beforeEvidence.decisionBasisDigest
    },
    evidenceQuality: verifiedEvidence === null ? "none" : "verified"
  });
  const decision = evaluateConvergence(evaluationRequest);

  if (validatedProbe.action === "finish_now") {
    if (verifiedEvidence === null || evaluationRequest.acceptanceSatisfied !== true) {
      throw coded("verified_acceptance_required");
    }
    if (decision.decision !== "pass") throw coded("finish_not_authorized");
    const resolved = store.resolveConvergenceLoop({
      eventUid: controllerEvent("finish", {
        taskUid: task.taskUid,
        fingerprint: current.fingerprint,
        evidenceDigest: verifiedEvidence.evidenceDigest
      }),
      taskUid: task.taskUid,
      fingerprint: current.fingerprint,
      resolution: "closed",
      reasonCode: "verified_acceptance"
    });
    return Object.freeze({ action: "finish", decision, loop: resolved });
  }
  if (decision.decision === "checkpoint_required" || decision.decision === "hold") {
    return Object.freeze({ action: "checkpoint_required", decision, loop: current });
  }
  if (decision.decision === "human_decision") {
    return Object.freeze({ action: "human_decision", decision, loop: current });
  }
  const purpose = PROBE_GRANT_PURPOSE.get(validatedProbe.action);
  if (decision.decision !== "pass" || purpose === undefined) {
    throw coded("verified_basis_or_exploration_required");
  }
  return Object.freeze({
    ...issueAuthorizedContinuation({
      store,
      task,
      loop: current,
      purpose,
      scopeDigest,
      evidenceDigest: verifiedEvidence?.evidenceDigest ?? current.decisionBasisDigest,
      policyDecision: decision,
      probeAction: validatedProbe.action,
      now
    }),
    decision
  });
}
