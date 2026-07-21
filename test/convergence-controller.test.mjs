import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  authorizeAfterProbe,
  authorizeContinuation,
  evaluateAndAdvance
} from "../src/convergence-controller.mjs";
import { digestDecisionBasis, projectContract } from "../src/convergence-identity.mjs";
import { runConvergenceProbeJob } from "../src/convergence-probe-runner.mjs";
import { initializeControlStore } from "../src/control-store.mjs";
import { pathsFor } from "../src/index.mjs";

const POLICY_REVISION = createHash("sha256").update("convergence-policy-v2").digest("hex");
const BASIS_A = digestDecisionBasis({ basis: "a" });
const BASIS_B = digestDecisionBasis({ basis: "b" });
const BASIS_C = digestDecisionBasis({ basis: "c" });
const BASIS_D = digestDecisionBasis({ basis: "d" });

function probeResult(action = "continue_once", assessment = "aligned_and_necessary") {
  return {
    assessment,
    action,
    unmet_user_value: "The approved acceptance remains the user value",
    wrong_assumption: "Model advice is not controller authority",
    unnecessary_scope: [],
    minimal_next_step: "Use the bounded controller decision",
    falsification_test: "Verify the next generation has a bound grant"
  };
}

function harness({
  importance = "routine",
  importanceAuthority = "approved_plan",
  adapterCapability = "workflow_gate",
  adapterKind = "sdd",
  taskUid = "controller-task-1",
  fingerprint = "controller-fingerprint-1",
  boundaryId = "task-6",
  canonicalInvariantId = "breaker-to-grant"
} = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "afl-controller-"));
  let currentTime = new Date("2026-07-21T00:00:00.000Z");
  let serial = 0;
  const now = () => new Date(currentTime);
  const store = initializeControlStore({ paths: pathsFor(home), now });
  const contract = projectContract({
    sourceKind: "approved_task",
    sourceRef: "controller-task-6",
    sourceRevision: "task-6-v1",
    requirements: [{ id: "bounded-controller", authority: "approved_plan" }],
    exclusions: [{ id: "no-resident-service", authority: "explicit_user" }],
    importance,
    importanceAuthority
  });
  let taskProjection = store.upsertConvergenceTask({
    eventUid: "controller-contract-1",
    taskUid,
    lineageDigest: "1".repeat(64),
    adapterKind,
    adapterCapability,
    nativeTaskDigest: "2".repeat(64),
    contractSourceKind: contract.sourceKind,
    contractSourceRefDigest: contract.sourceRefDigest,
    contractRevision: contract.revision,
    policyRevision: POLICY_REVISION,
    importance: contract.importance,
    importanceAuthority: contract.importanceAuthority
  });

  const eventUid = (kind) => `${kind}-${++serial}`;
  const review = ({
    verdict = "approved",
    severity = "minor",
    basis = BASIS_B,
    evidence = digestDecisionBasis({ evidence: serial + 1 }),
    directionSignal = "none"
  } = {}) => store.recordConvergenceReview({
    eventUid: eventUid("review"),
    taskUid: taskProjection.taskUid,
    fingerprint,
    boundaryId,
    canonicalInvariantId,
    verdict,
    severity,
    directionSignal,
    decisionBasisDigest: basis,
    evidenceDigest: evidence,
    generation: Number(store.database.prepare(
      "SELECT fix_generation FROM convergence_loops WHERE fingerprint=?"
    ).get(fingerprint)?.fix_generation ?? 0)
  });
  review();

  function loop() {
    return store.getConvergenceStatus({
      taskUid: taskProjection.taskUid,
      fingerprint
    });
  }

  function request(overrides = {}) {
    const current = loop();
    return {
      adapterCapability,
      contract,
      previousDecisionBasisDigest: current.decisionBasisDigest,
      decisionBasisDigest: current.decisionBasisDigest,
      currentGeneration: current.currentGeneration,
      requestedGeneration: current.currentGeneration + 1,
      failureCount: current.failureCount,
      lastGrantPurpose: null,
      acceptanceSatisfied: false,
      addsArchitecture: false,
      touchesExplicitExclusion: false,
      oscillationDetected: false,
      sameInvariant: true,
      explorationRequested: false,
      explorationUsed: false,
      riskHypothesis: null,
      falsificationTest: null,
      evidenceQuality: "none",
      evidenceChanged: false,
      fileSaveCount: 0,
      semanticRecommendation: null,
      ...overrides
    };
  }

  function evaluate(overrides = {}, launchProbe = () => ({ attempted: true, reason: "test" })) {
    return evaluateAndAdvance({
      store,
      task: taskProjection,
      loop: loop(),
      request: request(overrides),
      launchProbe,
      now
    });
  }

  async function completeProbe(result) {
    let probeSerial = 0;
    const completed = await runConvergenceProbeJob({
      store,
      taskUid: taskProjection.taskUid,
      fingerprint: loop().fingerprint,
      ownerId: eventUid("probe-owner"),
      provider: async () => result,
      eventUid: () => eventUid(`probe-event-${++probeSerial}`)
    });
    assert.equal(completed.resultDigest, loop().probeResultDigest);
    return completed;
  }

  function verifiedEvidence(basis = BASIS_C) {
    const evidenceDigest = digestDecisionBasis({ verified: serial + 1 });
    const evidenceEventUid = eventUid("verified-evidence");
    store.recordConvergenceEvidence({
      eventUid: evidenceEventUid,
      taskUid: taskProjection.taskUid,
      fingerprint: loop().fingerprint,
      evidenceClass: "verified_runtime",
      evidenceDigest,
      decisionBasisDigest: basis
    });
    return { eventUid: evidenceEventUid, evidenceDigest, decisionBasisDigest: basis };
  }

  function afterProbe(result, {
    evidence = null,
    requestOverrides = {},
    scope = digestDecisionBasis({ scope: serial + 1 })
  } = {}) {
    return authorizeAfterProbe({
      store,
      task: taskProjection,
      loop: loop(),
      request: request(requestOverrides),
      evidenceEventUid: evidence?.eventUid,
      probeResultDigest: loop().probeResultDigest,
      now
    });
  }

  function consume(grant) {
    const { grantId: _grantId, expiresAt: _expiresAt, ...binding } = grant;
    return store.consumeContinuationGrant({ eventUid: eventUid("consume"), ...binding });
  }

  return {
    home,
    store,
    contract,
    now,
    eventUid,
    review,
    loop,
    request,
    evaluate,
    completeProbe,
    verifiedEvidence,
    afterProbe,
    consume,
    task: () => taskProjection,
    replaceTask(value) { taskProjection = value; },
    advance(milliseconds) { currentTime = new Date(currentTime.getTime() + milliseconds); },
    close() { store.close(); rmSync(home, { recursive: true, force: true }); }
  };
}

test("routine evidence-free expansion pauses and starts one Probe without a grant", (t) => {
  const h = harness();
  t.after(() => h.close());
  const launches = [];

  const result = h.evaluate({ acceptanceSatisfied: true, addsArchitecture: true }, (reservation) => {
    launches.push(reservation);
    return { attempted: true, reason: "spawn_attempted" };
  });

  assert.equal(result.action, "probe_started");
  assert.equal(launches.length, 1);
  assert.equal(h.loop().status, "probe_pending");
  h.advance(1_000);
  const replay = evaluateAndAdvance({
    store: h.store,
    task: h.task(),
    loop: h.loop(),
    request: h.request({ acceptanceSatisfied: true, addsArchitecture: true }),
    launchProbe(reservation) {
      launches.push(reservation);
      return { attempted: true, reason: "must-not-relaunch" };
    },
    now: h.now
  });
  assert.equal(replay.action, "probe_started");
  assert.equal(launches.length, 2);
  assert.equal(h.store.database.prepare("SELECT COUNT(*) AS count FROM continuation_grants").get().count, 0);
  assert.throws(() => h.store.requestConvergenceGeneration({
    eventUid: h.eventUid("open"),
    taskUid: h.task().taskUid,
    fingerprint: h.loop().fingerprint,
    requestedGeneration: 1,
    purpose: "pass"
  }), /generation_grant_required/u);
});

test("Probe continue advice alone cannot create a grant", async (t) => {
  const h = harness();
  t.after(() => h.close());
  const result = probeResult("continue_once");
  h.evaluate({ acceptanceSatisfied: true, addsArchitecture: true });
  await h.completeProbe(result);

  assert.throws(
    () => h.afterProbe(result),
    (error) => error.code === "verified_basis_or_exploration_required"
  );
  assert.equal(h.store.database.prepare("SELECT COUNT(*) AS count FROM continuation_grants").get().count, 0);
});

test("ordinary local authorization rejects a caller-selected scope before mutation", (t) => {
  const h = harness();
  t.after(() => h.close());
  h.review({ verdict: "changes_required", severity: "important", basis: BASIS_C });
  const eventCount = h.store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_events"
  ).get().count;

  assert.throws(() => authorizeContinuation({
    store: h.store,
    task: h.task(),
    loop: h.loop(),
    purpose: "local_fix",
    scopeDigest: "a".repeat(64),
    evidenceDigest: h.loop().decisionBasisDigest,
    request: h.request(),
    now: h.now
  }), (error) => error.code === "controller_invalid");

  assert.equal(h.store.database.prepare(
    "SELECT COUNT(*) AS count FROM continuation_grants"
  ).get().count, 0);
  assert.equal(h.store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_events"
  ).get().count, eventCount);
});

test("ordinary local scope is controller-derived, complete, and replay-stable", (t) => {
  const h = harness();
  t.after(() => h.close());
  h.review({ verdict: "changes_required", severity: "important", basis: BASIS_C });
  const before = h.loop();
  const input = {
    store: h.store,
    task: h.task(),
    loop: before,
    purpose: "local_fix",
    request: h.request(),
    now: h.now
  };

  const first = authorizeContinuation(input);
  const replay = authorizeContinuation({ ...input, loop: h.loop() });
  const expected = digestDecisionBasis({
    action: "local_fix",
    boundaryId: before.boundaryId,
    canonicalInvariantId: before.canonicalInvariantId,
    currentGeneration: before.currentGeneration,
    fingerprint: before.fingerprint,
    nextGeneration: before.currentGeneration + 1,
    purpose: "local_fix",
    taskUid: before.taskUid
  });

  assert.equal(first.grant.scopeDigest, expected);
  assert.equal(replay.grant.grantId, first.grant.grantId);
  assert.equal(h.store.database.prepare(
    "SELECT scope_digest FROM continuation_grants WHERE grant_id=?"
  ).get(first.grant.grantId).scope_digest, expected);
  assert.equal(h.store.database.prepare(
    "SELECT COUNT(*) AS count FROM continuation_grants"
  ).get().count, 1);
});

test("canonical local scope changes with every frozen loop identity field", (t) => {
  const variants = [
    {},
    { taskUid: "controller-task-2" },
    { fingerprint: "controller-fingerprint-2" },
    { boundaryId: "task-6-other-boundary" },
    { canonicalInvariantId: "other-invariant" }
  ].map((options) => harness(options));
  t.after(() => variants.forEach((h) => h.close()));

  const scopes = variants.map((h) => {
    h.review({ verdict: "changes_required", severity: "important", basis: BASIS_C });
    return authorizeContinuation({
      store: h.store,
      task: h.task(),
      loop: h.loop(),
      purpose: "local_fix",
      request: h.request(),
      now: h.now
    }).grant.scopeDigest;
  });

  assert.equal(new Set(scopes).size, variants.length);
});

test("important task receives exactly one falsifiable exploration grant", (t) => {
  const h = harness({ importance: "important", importanceAuthority: "approved_spec" });
  t.after(() => h.close());
  assert.throws(() => authorizeContinuation({
    store: h.store,
    task: h.task(),
    loop: h.loop(),
    purpose: "exploration",
    scopeDigest: digestDecisionBasis({ scope: "forged" }),
    evidenceDigest: h.loop().decisionBasisDigest,
    policyDecision: { decision: "pass", reasonCode: "exploration_grant_available" },
    now: h.now
  }), (error) => error.code === "controller_invalid");
  const first = h.evaluate({
    previousDecisionBasisDigest: BASIS_A,
    evidenceQuality: "verified",
    explorationRequested: true,
    riskHypothesis: "grant consumption may race",
    falsificationTest: "run two concurrent consumers"
  });
  assert.equal(first.action, "grant_issued");
  assert.equal(first.grant.purpose, "exploration");
  const explorationBindingDigest = digestDecisionBasis({
    falsificationTest: "run two concurrent consumers",
    riskHypothesis: "grant consumption may race"
  });
  assert.equal(first.grant.scopeDigest, digestDecisionBasis({
    action: "explore_hypothesis",
    boundaryId: h.loop().boundaryId,
    canonicalInvariantId: h.loop().canonicalInvariantId,
    currentGeneration: 0,
    explorationBindingDigest,
    fingerprint: h.loop().fingerprint,
    nextGeneration: 1,
    purpose: "exploration",
    taskUid: h.loop().taskUid
  }));
  h.consume(first.grant);
  h.review({ basis: BASIS_C });

  const second = h.evaluate({
    previousDecisionBasisDigest: BASIS_B,
    evidenceQuality: "verified",
    explorationRequested: true,
    riskHypothesis: "another race may remain",
    falsificationTest: "run three concurrent consumers"
  });
  assert.equal(second.action, "checkpoint_required");
  assert.equal(h.store.database.prepare(
    "SELECT COUNT(*) AS count FROM continuation_grants WHERE purpose='exploration'"
  ).get().count, 1);
});

for (const [advice, purpose, assessment] of [
  ["simplify_current_generation", "simplify", "overdesigned"],
  ["rollback_to_generation", "rollback", "wrong_direction"]
]) {
  test(`${purpose} advice creates only a policy-allowed bounded grant`, async (t) => {
    const h = harness();
    t.after(() => h.close());
    const result = probeResult(advice, assessment);
    h.evaluate({ acceptanceSatisfied: true, addsArchitecture: true });
    await h.completeProbe(result);

    const evidence = h.verifiedEvidence();
    const before = h.loop();
    const authorized = h.afterProbe(result, { evidence });
    assert.equal(authorized.action, "grant_issued");
    assert.equal(authorized.grant.purpose, purpose);
    const scope = {
      action: advice,
      boundaryId: before.boundaryId,
      canonicalInvariantId: before.canonicalInvariantId,
      currentGeneration: before.currentGeneration,
      fingerprint: before.fingerprint,
      nextGeneration: before.currentGeneration + 1,
      purpose,
      taskUid: before.taskUid
    };
    if (purpose === "rollback") {
      scope.rollbackTargetGeneration = Math.max(0, before.currentGeneration - 1);
    }
    assert.equal(authorized.grant.scopeDigest, digestDecisionBasis(scope));
    assert.equal(h.loop().status, "grant_ready");
  });
}

test("verified new evidence changes the authoritative basis before grant issuance", async (t) => {
  const h = harness();
  t.after(() => h.close());
  const result = probeResult();
  h.evaluate({ acceptanceSatisfied: true, addsArchitecture: true });
  await h.completeProbe(result);
  const evidence = h.verifiedEvidence(BASIS_D);

  const authorized = h.afterProbe(result, { evidence });

  assert.equal(authorized.grant.decisionBasisDigest, BASIS_D);
  assert.equal(authorized.grant.evidenceDigest, evidence.evidenceDigest);
  assert.equal(h.loop().decisionBasisDigest, BASIS_D);
});

test("contract revision invalidates an unconsumed controller grant", async (t) => {
  const h = harness();
  t.after(() => h.close());
  const result = probeResult();
  h.evaluate({ acceptanceSatisfied: true, addsArchitecture: true });
  await h.completeProbe(result);
  const issued = h.afterProbe(result, { evidence: h.verifiedEvidence() });
  const revised = projectContract({
    sourceKind: "approved_task",
    sourceRef: "controller-task-6",
    sourceRevision: "task-6-v2",
    requirements: [{ id: "bounded-controller", authority: "approved_plan" }],
    exclusions: [{ id: "no-resident-service", authority: "explicit_user" }],
    importance: "routine",
    importanceAuthority: "approved_plan"
  });
  h.replaceTask(h.store.upsertConvergenceTask({
    eventUid: h.eventUid("contract-revision"),
    taskUid: h.task().taskUid,
    lineageDigest: h.task().lineageDigest,
    adapterKind: h.task().adapterKind,
    adapterCapability: h.task().adapterCapability,
    nativeTaskDigest: h.task().nativeTaskDigest,
    contractSourceKind: revised.sourceKind,
    contractSourceRefDigest: revised.sourceRefDigest,
    contractRevision: revised.revision,
    policyRevision: h.task().policyRevision,
    importance: revised.importance,
    importanceAuthority: revised.importanceAuthority
  }));

  assert.throws(() => h.consume(issued.grant), /grant_revoked|grant_binding_mismatch/u);
});

test("finish-now requires deterministic verified acceptance evidence", async (t) => {
  const h = harness();
  t.after(() => h.close());
  const result = probeResult("finish_now", "acceptance_already_satisfied");
  h.evaluate({ acceptanceSatisfied: true, addsArchitecture: true });
  await h.completeProbe(result);
  assert.throws(
    () => h.afterProbe(result, { requestOverrides: { acceptanceSatisfied: true } }),
    (error) => error.code === "verified_acceptance_required"
  );

  const finished = h.afterProbe(result, {
    evidence: h.verifiedEvidence(),
    requestOverrides: { acceptanceSatisfied: true }
  });
  assert.equal(finished.action, "finish");
  assert.equal(h.loop().status, "terminal");
});

test("Probe launch failure remains reflection-required and issues no grant", (t) => {
  const h = harness();
  t.after(() => h.close());

  const result = h.evaluate({ acceptanceSatisfied: true, addsArchitecture: true }, () => {
    throw new Error("spawn exploded");
  });

  assert.equal(result.action, "reflection_required");
  assert.equal(h.store.database.prepare("SELECT COUNT(*) AS count FROM continuation_grants").get().count, 0);
});

test("fabricated evidence is rejected before any authoritative side effect", async (t) => {
  const h = harness();
  t.after(() => h.close());
  const result = probeResult();
  h.evaluate({ acceptanceSatisfied: true, addsArchitecture: true });
  await h.completeProbe(result);
  const before = h.loop();
  const eventCount = h.store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_events"
  ).get().count;

  assert.throws(() => authorizeAfterProbe({
    store: h.store,
    task: h.task(),
    loop: h.loop(),
    request: h.request(),
    probeResult: result,
    verifiedEvidence: {
      evidenceClass: "verified_runtime",
      evidenceDigest: "e".repeat(64),
      decisionBasisDigest: "f".repeat(64)
    },
    scopeDigest: digestDecisionBasis({ scope: "fabricated" }),
    now: h.now
  }), (error) => error.code === "evidence_provenance_required");

  assert.deepEqual(h.loop(), before);
  assert.equal(h.store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_events"
  ).get().count, eventCount);
  assert.equal(h.store.database.prepare(
    "SELECT COUNT(*) AS count FROM continuation_grants"
  ).get().count, 0);
});

test("completed Probe resumes from the real Store after restart and exact replay is stable", async (t) => {
  const h = harness();
  let reopened = null;
  t.after(() => {
    reopened?.close();
    rmSync(h.home, { recursive: true, force: true });
  });
  const result = probeResult();
  h.evaluate({ acceptanceSatisfied: true, addsArchitecture: true });
  await h.completeProbe(result);
  const task = h.task();
  const request = h.request();
  const completedLoop = h.loop();
  const fingerprint = completedLoop.fingerprint;
  const evidenceEventUid = h.store.database.prepare(`SELECT event_uid FROM convergence_events
    WHERE fingerprint=? AND event_type='review_recorded' ORDER BY id DESC LIMIT 1`
  ).get(fingerprint).event_uid;
  h.store.close();
  reopened = initializeControlStore({ paths: pathsFor(h.home), now: h.now });

  const first = authorizeAfterProbe({
    store: reopened,
    task,
    loop: reopened.getConvergenceStatus({ taskUid: task.taskUid, fingerprint }),
    request,
    evidenceEventUid,
    now: h.now
  });
  const replay = authorizeAfterProbe({
    store: reopened,
    task,
    loop: reopened.getConvergenceStatus({ taskUid: task.taskUid, fingerprint }),
    request,
    evidenceEventUid,
    now: h.now
  });

  assert.equal(first.action, "grant_issued");
  assert.equal(first.grant.purpose, "local_fix");
  assert.equal(first.grant.scopeDigest, digestDecisionBasis({
    action: "continue_once",
    boundaryId: completedLoop.boundaryId,
    canonicalInvariantId: completedLoop.canonicalInvariantId,
    currentGeneration: completedLoop.currentGeneration,
    fingerprint: completedLoop.fingerprint,
    nextGeneration: completedLoop.currentGeneration + 1,
    purpose: "local_fix",
    taskUid: completedLoop.taskUid
  }));
  assert.equal(replay.action, first.action);
  assert.equal(replay.grant.grantId, first.grant.grantId);
  assert.equal(reopened.database.prepare(
    "SELECT scope_digest FROM continuation_grants WHERE grant_id=?"
  ).get(first.grant.grantId).scope_digest, first.grant.scopeDigest);
  assert.equal(reopened.database.prepare(
    "SELECT COUNT(*) AS count FROM continuation_grants"
  ).get().count, 1);
});

test("failed Probe launch is attempted once again by an explicit replay after restart", (t) => {
  const h = harness();
  let reopened = null;
  t.after(() => {
    reopened?.close();
    rmSync(h.home, { recursive: true, force: true });
  });
  const overrides = { acceptanceSatisfied: true, addsArchitecture: true };
  const first = h.evaluate(overrides, () => ({ attempted: false, reason: "spawn_failed" }));
  assert.equal(first.action, "reflection_required");
  const task = h.task();
  const request = h.request(overrides);
  const fingerprint = h.loop().fingerprint;
  h.store.close();
  reopened = initializeControlStore({ paths: pathsFor(h.home), now: h.now });
  let launches = 0;

  const replay = evaluateAndAdvance({
    store: reopened,
    task,
    loop: reopened.getConvergenceStatus({ taskUid: task.taskUid, fingerprint }),
    request,
    launchProbe() {
      launches += 1;
      return { attempted: true, reason: "spawn_attempted" };
    },
    now: h.now
  });

  assert.equal(replay.action, "probe_started");
  assert.equal(launches, 1);
  assert.equal(reopened.database.prepare(
    "SELECT COUNT(*) AS count FROM continuation_grants"
  ).get().count, 0);
});

test("post-Probe cleanup scope rejects caller authority and binds rollback target", async (t) => {
  const rejected = harness();
  const canonical = harness();
  t.after(() => rejected.close());
  t.after(() => canonical.close());
  const rollback = probeResult("rollback_to_generation", "wrong_direction");
  for (const h of [rejected, canonical]) {
    h.evaluate({ acceptanceSatisfied: true, addsArchitecture: true });
    await h.completeProbe(rollback);
  }
  const evidenceEvent = (h) => h.store.database.prepare(`SELECT event_uid FROM convergence_events
    WHERE fingerprint=? AND event_type='review_recorded' ORDER BY id DESC LIMIT 1`
  ).get(h.loop().fingerprint).event_uid;

  assert.throws(() => authorizeAfterProbe({
    store: rejected.store,
    task: rejected.task(),
    loop: rejected.loop(),
    request: rejected.request(),
    probeResult: rollback,
    evidenceEventUid: evidenceEvent(rejected),
    scopeDigest: digestDecisionBasis({ scope: "entire-repository" }),
    now: rejected.now
  }), (error) => error.code === "controller_invalid");
  assert.equal(rejected.store.database.prepare(
    "SELECT COUNT(*) AS count FROM continuation_grants"
  ).get().count, 0);

  const before = canonical.loop();
  const authorized = authorizeAfterProbe({
    store: canonical.store,
    task: canonical.task(),
    loop: before,
    request: canonical.request(),
    evidenceEventUid: evidenceEvent(canonical),
    now: canonical.now
  });
  assert.equal(authorized.grant.scopeDigest, digestDecisionBasis({
    action: "rollback_to_generation",
    boundaryId: before.boundaryId,
    canonicalInvariantId: before.canonicalInvariantId,
    currentGeneration: before.currentGeneration,
    fingerprint: before.fingerprint,
    nextGeneration: before.currentGeneration + 1,
    purpose: "rollback",
    rollbackTargetGeneration: Math.max(0, before.currentGeneration - 1),
    taskUid: before.taskUid
  }));
});

for (const [action, expectedAction, expectedStatus] of [
  ["direction_checkpoint", "checkpoint_required", "checkpoint_required"],
  ["human_decision", "human_decision", "human_decision"]
]) {
  test(`stored ${action} advice reaches ${expectedStatus} only through deterministic policy`, async (t) => {
    const h = harness();
    t.after(() => h.close());
    const result = probeResult(action, action === "human_decision" ? "wrong_direction" : "scope_drift");
    h.evaluate({ acceptanceSatisfied: true, addsArchitecture: true });
    await h.completeProbe(result);
    const evidenceEventUid = h.store.database.prepare(`SELECT event_uid FROM convergence_events
      WHERE fingerprint=? AND event_type='review_recorded' ORDER BY id DESC LIMIT 1`
    ).get(h.loop().fingerprint).event_uid;

    const advanced = authorizeAfterProbe({
      store: h.store,
      task: h.task(),
      loop: h.loop(),
      request: h.request(),
      evidenceEventUid,
      now: h.now
    });
    const replay = authorizeAfterProbe({
      store: h.store,
      task: h.task(),
      loop: h.loop(),
      request: h.request(),
      evidenceEventUid,
      now: h.now
    });

    assert.equal(advanced.action, expectedAction);
    assert.equal(h.loop().status, expectedStatus);
    assert.equal(replay.action, expectedAction);
    assert.equal(h.store.database.prepare(`SELECT COUNT(*) AS count FROM convergence_events
      WHERE event_type='breaker_triggered' AND decision=?`).get(expectedAction).count, 1);
  });
}

test("generic audit downgrades the hard request to warning authority", (t) => {
  const h = harness({ adapterCapability: "audit_only", adapterKind: "generic" });
  t.after(() => h.close());
  let launches = 0;

  const result = h.evaluate({
    acceptanceSatisfied: true,
    addsArchitecture: true,
    evidenceQuality: "verified"
  }, () => {
    launches += 1;
    return { attempted: true };
  });

  assert.equal(result.action, "warn");
  assert.equal(result.decision.requestedDecision, "reflection_required");
  assert.equal(result.decision.enforcement, "warn_only");
  assert.equal(launches, 0);
});

test("second invariant failure requires checkpoint through the deterministic policy", (t) => {
  const h = harness();
  t.after(() => h.close());
  h.review({ verdict: "changes_required", severity: "important", basis: BASIS_C });
  h.review({ verdict: "changes_required", severity: "important", basis: BASIS_D });

  const result = h.evaluate({ previousDecisionBasisDigest: BASIS_C, evidenceQuality: "verified" });

  assert.equal(result.action, "checkpoint_required");
  assert.equal(result.decision.reasonCode, "repeated_review_invariant");
  assert.equal(h.loop().status, "checkpoint_required");
});

test("exploration and architecture bindings change their canonical scopes", (t) => {
  const explorationA = harness({ importance: "important", importanceAuthority: "approved_spec" });
  const explorationB = harness({ importance: "important", importanceAuthority: "approved_spec" });
  const architectureA = harness();
  const architectureB = harness();
  const all = [explorationA, explorationB, architectureA, architectureB];
  t.after(() => all.forEach((h) => h.close()));

  const explore = (h, suffix) => h.evaluate({
    previousDecisionBasisDigest: BASIS_A,
    evidenceQuality: "verified",
    explorationRequested: true,
    riskHypothesis: `grant race ${suffix}`,
    falsificationTest: `concurrent consumers ${suffix}`
  }).grant.scopeDigest;
  assert.notEqual(explore(explorationA, "a"), explore(explorationB, "b"));

  const architecture = (h, checkpointDigest) => {
    h.review({ verdict: "changes_required", severity: "important", basis: BASIS_C });
    h.review({ verdict: "changes_required", severity: "important", basis: BASIS_D });
    h.evaluate({ previousDecisionBasisDigest: BASIS_C, evidenceQuality: "verified" });
    h.store.recordConvergenceCheckpoint({
      eventUid: h.eventUid("checkpoint"),
      taskUid: h.task().taskUid,
      fingerprint: h.loop().fingerprint,
      checkpointKind: "architecture_direction",
      fileDigest: checkpointDigest
    });
    return authorizeContinuation({
      store: h.store,
      task: h.task(),
      loop: h.loop(),
      purpose: "architecture_fix",
      now: h.now
    }).grant.scopeDigest;
  };
  assert.notEqual(
    architecture(architectureA, digestDecisionBasis({ checkpoint: "a" })),
    architecture(architectureB, digestDecisionBasis({ checkpoint: "b" }))
  );
});

test("rollback target generation changes the canonical scope", async (t) => {
  const h = harness();
  t.after(() => h.close());
  h.review({ verdict: "changes_required", severity: "important", basis: BASIS_C });
  const local = authorizeContinuation({
    store: h.store,
    task: h.task(),
    loop: h.loop(),
    purpose: "local_fix",
    request: h.request(),
    now: h.now
  });
  h.consume(local.grant);
  h.review({ verdict: "approved", basis: BASIS_D });

  const rollback = probeResult("rollback_to_generation", "wrong_direction");
  h.evaluate({ acceptanceSatisfied: true, addsArchitecture: true });
  await h.completeProbe(rollback);
  const generationOne = h.loop();
  const first = h.afterProbe(rollback, { evidence: h.verifiedEvidence(BASIS_A) });
  h.consume(first.grant);
  h.review({ verdict: "approved", basis: BASIS_B });

  h.evaluate({ acceptanceSatisfied: true, addsArchitecture: true });
  await h.completeProbe(rollback);
  const generationTwo = h.loop();
  const second = h.afterProbe(rollback, { evidence: h.verifiedEvidence(BASIS_C) });

  assert.equal(generationOne.currentGeneration, 1);
  assert.equal(generationTwo.currentGeneration, 2);
  assert.notEqual(first.grant.scopeDigest, second.grant.scopeDigest);
  assert.equal(second.grant.scopeDigest, digestDecisionBasis({
    action: "rollback_to_generation",
    boundaryId: generationTwo.boundaryId,
    canonicalInvariantId: generationTwo.canonicalInvariantId,
    currentGeneration: 2,
    fingerprint: generationTwo.fingerprint,
    nextGeneration: 3,
    purpose: "rollback",
    rollbackTargetGeneration: 1,
    taskUid: generationTwo.taskUid
  }));
});

test("architecture-fix failure reaches human decision through consumed-grant history", (t) => {
  const h = harness();
  t.after(() => h.close());
  h.review({ verdict: "changes_required", severity: "important", basis: BASIS_C });
  h.review({ verdict: "changes_required", severity: "important", basis: BASIS_D });
  h.evaluate({ previousDecisionBasisDigest: BASIS_C, evidenceQuality: "verified" });
  const checkpointDigest = digestDecisionBasis({ checkpoint: "approved" });
  h.store.recordConvergenceCheckpoint({
    eventUid: h.eventUid("checkpoint"),
    taskUid: h.task().taskUid,
    fingerprint: h.loop().fingerprint,
    checkpointKind: "architecture_direction",
    fileDigest: checkpointDigest
  });
  const beforeArchitecture = h.loop();
  const issued = authorizeContinuation({
    store: h.store,
    task: h.task(),
    loop: beforeArchitecture,
    purpose: "architecture_fix",
    now: h.now
  });
  assert.equal(issued.grant.scopeDigest, digestDecisionBasis({
    action: "architecture_fix",
    boundaryId: beforeArchitecture.boundaryId,
    canonicalInvariantId: beforeArchitecture.canonicalInvariantId,
    checkpointBindingDigest: checkpointDigest,
    currentGeneration: beforeArchitecture.currentGeneration,
    fingerprint: beforeArchitecture.fingerprint,
    nextGeneration: beforeArchitecture.currentGeneration + 1,
    purpose: "architecture_fix",
    taskUid: beforeArchitecture.taskUid
  }));
  h.consume(issued.grant);
  h.review({ verdict: "changes_required", severity: "important", basis: BASIS_A });

  const result = h.evaluate({ previousDecisionBasisDigest: BASIS_D, evidenceQuality: "verified" });

  assert.equal(result.action, "human_decision");
  assert.equal(result.decision.reasonCode, "architecture_fix_failed");
  assert.equal(h.loop().status, "human_decision");
});
