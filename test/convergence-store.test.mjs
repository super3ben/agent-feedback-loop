import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { pathsFor } from "../src/index.mjs";
import { V1_SCHEMA_SQL } from "../src/control-schema.mjs";
import {
  initializeControlStore,
  listUserTables,
  migrateControlSchemaV1ToV2
} from "../src/control-store.mjs";
import { evaluateConvergence } from "../src/convergence-policy.mjs";
import { projectContract } from "../src/convergence-identity.mjs";

const EXPECTED_V2_TABLES = [
  "continuation_grants",
  "convergence_events",
  "convergence_loops",
  "convergence_tasks",
  "event_observations",
  "reflection_emissions",
  "review_job_events",
  "reviewer_jobs",
  "schema_migrations",
  "session_events",
  "sessions",
  "store_meta"
];

function v1Fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "afl-convergence-v1-"));
  const paths = pathsFor(home);
  mkdirSync(path.dirname(paths.controlDatabase), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(paths.controlDatabase);
  database.exec(V1_SCHEMA_SQL);
  database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)")
    .run("2026-07-20T00:00:00.000Z");
  database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)").run(
    "existing-session", "codex", null, 1,
    "2026-07-20T00:00:00.000Z", "2026-07-20T00:00:00.000Z"
  );
  database.prepare(`INSERT INTO session_events
    (event_uid, session_uid, context_epoch, source_provider, source_event_id, source_namespace,
     observation_source_id, source_identity, role, referent_event_uid, native_turn_id,
     content_hash, encrypted_raw_ref, completeness, source_timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "existing-event", "existing-session", 1, "codex", "source-1", "hook",
    "source-1", "existing-identity", "user", null, null,
    "a".repeat(64), null, "prompt_only", null, "2026-07-20T00:00:00.000Z"
  );
  database.prepare(`INSERT INTO reviewer_jobs
    (job_id, source_identity, source_event_uid, state, created_at)
    VALUES (?, ?, ?, 'pending', ?)`).run(
    "existing-job", "review-source", "existing-event", "2026-07-20T00:00:00.000Z"
  );
  database.close();
  chmodSync(paths.controlDatabase, 0o600);
  return paths;
}

const DIGEST = Object.freeze({
  lineage: "1".repeat(64),
  nativeTask: "2".repeat(64),
  contractRef: "3".repeat(64),
  contract: "4".repeat(64),
  policy: "5".repeat(64),
  basis: "6".repeat(64),
  evidence: "7".repeat(64),
  scope: "8".repeat(64)
});

function convergenceFixture(initialNow = "2026-07-21T00:00:00.000Z") {
  const home = mkdtempSync(path.join(tmpdir(), "afl-convergence-"));
  const paths = pathsFor(home);
  let currentNow = new Date(initialNow);
  const store = initializeControlStore({ paths, now: () => new Date(currentNow) });
  return {
    paths,
    store,
    advance(milliseconds) {
      currentNow = new Date(currentNow.getTime() + milliseconds);
    }
  };
}

function taskInput(overrides = {}) {
  return {
    eventUid: "contract-event-1",
    taskUid: "task-1",
    lineageDigest: DIGEST.lineage,
    adapterKind: "sdd",
    adapterCapability: "workflow_gate",
    nativeTaskDigest: DIGEST.nativeTask,
    contractSourceKind: "approved_plan",
    contractSourceRefDigest: DIGEST.contractRef,
    contractRevision: DIGEST.contract,
    policyRevision: DIGEST.policy,
    importance: "routine",
    importanceAuthority: "approved_plan",
    ...overrides
  };
}

function reviewInput(overrides = {}) {
  return {
    eventUid: "review-event-1",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    boundaryId: "task-3",
    canonicalInvariantId: "atomic-store",
    verdict: "changes_required",
    severity: "important",
    directionSignal: "none",
    decisionBasisDigest: DIGEST.basis,
    evidenceDigest: DIGEST.evidence,
    generation: 1,
    ...overrides
  };
}

function seedLoop(store) {
  store.upsertConvergenceTask(taskInput());
  return store.recordConvergenceReview(reviewInput());
}

function grantInput(overrides = {}) {
  return {
    eventUid: "grant-issued-1",
    grantId: "grant-1",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    currentGeneration: 1,
    nextGeneration: 2,
    purpose: "local_fix",
    scopeDigest: DIGEST.scope,
    contractRevision: DIGEST.contract,
    policyRevision: DIGEST.policy,
    decisionBasisDigest: DIGEST.basis,
    evidenceDigest: DIGEST.evidence,
    expiresAt: "2026-07-21T00:05:00.000Z",
    ...overrides
  };
}

function grantBinding(overrides = {}) {
  const { eventUid: _eventUid, grantId: _grantId, expiresAt: _expiresAt, ...binding } = grantInput();
  return { eventUid: "grant-consumed-1", ...binding, ...overrides };
}

function policyRequest(overrides = {}) {
  return {
    adapterCapability: "workflow_gate",
    contract: projectContract({
      sourceKind: "approved_plan",
      sourceRef: "task-3-plan",
      sourceRevision: "plan-rev-1",
      requirements: [],
      exclusions: [],
      importance: "routine",
      importanceAuthority: "approved_plan"
    }),
    previousDecisionBasisDigest: DIGEST.basis,
    decisionBasisDigest: "e".repeat(64),
    currentGeneration: 1,
    requestedGeneration: 2,
    failureCount: 2,
    lastGrantPurpose: "local_fix",
    acceptanceSatisfied: false,
    addsArchitecture: false,
    touchesExplicitExclusion: false,
    oscillationDetected: false,
    sameInvariant: true,
    explorationRequested: false,
    explorationUsed: false,
    riskHypothesis: null,
    falsificationTest: null,
    evidenceQuality: "verified",
    evidenceChanged: true,
    fileSaveCount: 0,
    semanticRecommendation: null,
    ...overrides
  };
}

test("v1 upgrades transactionally to the exact canonical v2 schema", () => {
  const paths = v1Fixture();
  const store = initializeControlStore({
    paths,
    now: () => new Date("2026-07-21T00:00:00.000Z")
  });

  assert.equal(store.database.prepare("SELECT version FROM schema_migrations").get().version, 2);
  assert.deepEqual(listUserTables(store.database), EXPECTED_V2_TABLES);
  assert.equal(store.getReviewJob("existing-job").state, "pending");
  store.close();
});

test("a migration write failure rolls back both new tables and schema version", () => {
  const paths = v1Fixture();
  const database = new DatabaseSync(paths.controlDatabase);
  database.exec(`CREATE TEMP TRIGGER abort_migration_version
    BEFORE DELETE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'forced migration abort'); END`);

  assert.throws(
    () => migrateControlSchemaV1ToV2(database),
    /forced migration abort/iu
  );
  assert.equal(database.prepare("SELECT version FROM schema_migrations").get().version, 1);
  assert.deepEqual(
    listUserTables(database),
    EXPECTED_V2_TABLES.filter((name) => !name.startsWith("convergence_") && name !== "continuation_grants")
  );
  database.close();
});

test("event replay is immutable and a changed digest for the same event id is rejected", () => {
  const { store } = convergenceFixture();
  const input = taskInput();

  assert.deepEqual(store.upsertConvergenceTask(input), store.upsertConvergenceTask(input));
  assert.equal(store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_events WHERE event_uid=?"
  ).get(input.eventUid).count, 1);
  assert.throws(
    () => store.upsertConvergenceTask({ ...input, contractRevision: "9".repeat(64) }),
    /event_collision/u
  );
  assert.equal(store.database.prepare(
    "SELECT contract_revision FROM convergence_tasks WHERE task_uid=?"
  ).get(input.taskUid).contract_revision, DIGEST.contract);
  store.close();
});

test("event insertion failure rolls back the convergence projection", () => {
  const { store } = convergenceFixture();
  store.database.exec(`CREATE TEMP TRIGGER abort_convergence_event
    BEFORE INSERT ON convergence_events BEGIN SELECT RAISE(ABORT, 'forced event abort'); END`);

  assert.throws(() => store.upsertConvergenceTask(taskInput()), /forced event abort/u);
  assert.equal(store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_tasks WHERE task_uid='task-1'"
  ).get().count, 0);
  store.close();
});

test("reviews preserve one fingerprint across replay and closed regression generations", () => {
  const { store } = convergenceFixture();
  const first = seedLoop(store);
  const replay = store.recordConvergenceReview(reviewInput());
  assert.equal(first.failureCount, 1);
  assert.equal(replay.failureCount, 1);

  store.database.prepare(`UPDATE convergence_loops
    SET status='terminal', current_decision='finish' WHERE fingerprint=?`).run("fingerprint-1");
  const regression = store.recordConvergenceReview(reviewInput({ eventUid: "review-event-2" }));
  assert.equal(regression.fingerprint, "fingerprint-1");
  assert.equal(regression.failureCount, 2);
  assert.deepEqual(regression.fixGenerations, [1]);
  assert.equal(regression.decision, "checkpoint_required");
  store.close();
});

test("aliases cannot collide and distinct loops require bounded reason evidence", () => {
  const { store } = convergenceFixture();
  seedLoop(store);
  assert.equal(store.addConvergenceAlias({
    eventUid: "alias-event-1",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    aliasInvariantId: "renamed-atomic-store"
  }).fingerprint, "fingerprint-1");

  assert.throws(() => store.declareConvergenceDistinct({
    eventUid: "distinct-event-missing",
    taskUid: "task-1",
    fingerprint: "fingerprint-2",
    boundaryId: "task-3",
    canonicalInvariantId: "second-store-failure",
    reasonCode: "independent_failure"
  }), /evidence_digest/u);
  store.declareConvergenceDistinct({
    eventUid: "distinct-event-1",
    taskUid: "task-1",
    fingerprint: "fingerprint-2",
    boundaryId: "task-3",
    canonicalInvariantId: "second-store-failure",
    reasonCode: "independent_failure",
    evidenceDigest: "a".repeat(64),
    decisionBasisDigest: DIGEST.basis
  });
  assert.throws(() => store.addConvergenceAlias({
    eventUid: "alias-event-2",
    taskUid: "task-1",
    fingerprint: "fingerprint-2",
    aliasInvariantId: "renamed-atomic-store"
  }), /alias_collision/u);
  assert.throws(() => store.addConvergenceAlias({
    eventUid: "alias-event-extra",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    aliasInvariantId: "safe-alias",
    reviewerBody: "must not persist"
  }), /unknown_/u);
  store.close();
});

test("only trusted evidence changes the decision basis", () => {
  const { store } = convergenceFixture();
  seedLoop(store);
  const advisory = store.recordConvergenceEvidence({
    eventUid: "evidence-event-1",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    evidenceClass: "inferred_advisory",
    evidenceDigest: "b".repeat(64),
    decisionBasisDigest: "c".repeat(64)
  });
  assert.equal(advisory.basisChanged, false);
  const verified = store.recordConvergenceEvidence({
    eventUid: "evidence-event-2",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    evidenceClass: "verified_runtime",
    evidenceDigest: "d".repeat(64),
    decisionBasisDigest: "e".repeat(64)
  });
  assert.equal(verified.basisChanged, true);
  assert.equal(store.getConvergenceStatus({ taskUid: "task-1", fingerprint: "fingerprint-1" })
    .decisionBasisDigest, "e".repeat(64));
  store.close();
});

test("breaker projection accepts only the exact already-evaluated decision and matching target", () => {
  const { store } = convergenceFixture();
  seedLoop(store);
  const request = policyRequest();
  const evaluation = evaluateConvergence(request);
  const result = store.recordConvergenceDecision({
    eventUid: "decision-event-1",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    evaluationRequest: request,
    evaluation,
    targetStatus: "checkpoint_required"
  });
  assert.equal(result.decision, "checkpoint_required");
  assert.equal(result.status, "checkpoint_required");
  assert.throws(() => store.recordConvergenceDecision({
    eventUid: "decision-event-2",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    evaluationRequest: request,
    evaluation: { ...evaluation, decision: "human_decision" },
    targetStatus: "human_decision"
  }), /decision_not_evaluated/u);
  assert.throws(() => store.recordConvergenceDecision({
    eventUid: "decision-event-3",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    evaluationRequest: request,
    evaluation,
    targetStatus: "human_decision"
  }), /decision_target_mismatch/u);
  store.close();
});

test("checkpoint records one direction generation and pass opens only the exact next generation", () => {
  const { store } = convergenceFixture();
  seedLoop(store);
  const request = policyRequest();
  store.recordConvergenceDecision({
    eventUid: "decision-checkpoint",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    evaluationRequest: request,
    evaluation: evaluateConvergence(request),
    targetStatus: "checkpoint_required"
  });
  const checkpoint = store.recordConvergenceCheckpoint({
    eventUid: "checkpoint-event-1",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    checkpointKind: "architecture_direction",
    fileDigest: "f".repeat(64)
  });
  assert.equal(checkpoint.directionGeneration, 1);
  assert.equal(checkpoint.status, "direction_approved");

  const second = convergenceFixture();
  seedLoop(second.store);
  assert.throws(() => second.store.requestConvergenceGeneration({
    eventUid: "generation-event-4",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    requestedGeneration: 4,
    purpose: "pass"
  }), /invalid_generation/u);
  const opened = second.store.requestConvergenceGeneration({
    eventUid: "generation-event-2",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    requestedGeneration: 2,
    purpose: "pass"
  });
  assert.equal(opened.currentGeneration, 2);
  assert.equal(opened.status, "active_generation");
  store.close();
  second.store.close();
});

function requireReflection(store) {
  seedLoop(store);
  const request = policyRequest({
    previousDecisionBasisDigest: DIGEST.basis,
    decisionBasisDigest: DIGEST.basis,
    failureCount: 1,
    lastGrantPurpose: null,
    evidenceChanged: false
  });
  const evaluation = evaluateConvergence(request);
  assert.equal(evaluation.decision, "reflection_required");
  store.recordConvergenceDecision({
    eventUid: "decision-reflection",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    evaluationRequest: request,
    evaluation,
    targetStatus: "reflection_required"
  });
}

test("Probe claims are lease-epoch fenced and completion clears the live owner", () => {
  const fixture = convergenceFixture();
  const { store } = fixture;
  requireReflection(store);
  store.requestConvergenceProbe({
    eventUid: "probe-request-1",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    probeKind: "convergence_reflection",
    dueAt: "2026-07-21T00:00:00.000Z"
  });
  const claimed = store.claimConvergenceProbe({
    eventUid: "probe-claim-1",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    ownerId: "probe-owner-1",
    leaseMs: 30_000
  });
  assert.equal(claimed.probeLeaseEpoch, 1);
  assert.equal(claimed.probeAttempt, 1);
  assert.throws(() => store.completeConvergenceProbe({
    eventUid: "probe-complete-stale",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    ownerId: "probe-owner-1",
    leaseEpoch: 2,
    outcome: "reflection_resolved",
    action: "continue_once",
    resultDigest: "a".repeat(64)
  }), /probe_lease_lost/u);
  const completed = store.completeConvergenceProbe({
    eventUid: "probe-complete-1",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    ownerId: "probe-owner-1",
    leaseEpoch: 1,
    outcome: "reflection_resolved",
    action: "continue_once",
    resultDigest: "a".repeat(64)
  });
  assert.equal(completed.probeState, "completed");
  assert.equal(completed.probeOwnerId, null);
  assert.equal(completed.status, "reflection_resolved");
  store.close();
});

test("Probe failure schedules bounded retry and a new claim fences the old epoch", () => {
  const fixture = convergenceFixture();
  const { store } = fixture;
  requireReflection(store);
  store.requestConvergenceProbe({
    eventUid: "probe-request-retry",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    probeKind: "convergence_reflection",
    dueAt: "2026-07-21T00:00:00.000Z"
  });
  store.claimConvergenceProbe({
    eventUid: "probe-claim-retry-1",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    ownerId: "probe-owner-1",
    leaseMs: 30_000
  });
  const failed = store.failConvergenceProbe({
    eventUid: "probe-fail-1",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    ownerId: "probe-owner-1",
    leaseEpoch: 1,
    reasonCode: "provider_timeout",
    retryable: true,
    backoffMs: 1_000
  });
  assert.equal(failed.probeState, "retryable");
  fixture.advance(1_000);
  const claimed = store.claimConvergenceProbe({
    eventUid: "probe-claim-retry-2",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    ownerId: "probe-owner-2",
    leaseMs: 30_000
  });
  assert.equal(claimed.probeLeaseEpoch, 2);
  assert.equal(claimed.probeAttempt, 2);
  store.close();
});

test("grant consumption and generation open are one atomic single-use transition", () => {
  const { store } = convergenceFixture();
  seedLoop(store);
  const grant = store.issueContinuationGrant(grantInput());
  assert.equal(grant.token.length >= 43, true);
  const first = store.consumeContinuationGrant({ token: grant.token, ...grantBinding() });
  assert.equal(first.generation, 2);
  assert.equal(first.purpose, "local_fix");
  assert.throws(
    () => store.consumeContinuationGrant({
      token: grant.token,
      ...grantBinding({ eventUid: "grant-consumed-2" })
    }),
    /grant_consumed/u
  );
  assert.equal(store.getConvergenceStatus({ taskUid: "task-1", fingerprint: "fingerprint-1" })
    .currentGeneration, 2);
  assert.equal(store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_events WHERE event_type='grant_consumed'"
  ).get().count, 1);
  store.close();
});

test("contract or policy revision change revokes an unconsumed bound grant", () => {
  for (const [field, revision] of [
    ["contractRevision", "9".repeat(64)],
    ["policyRevision", "a".repeat(64)]
  ]) {
    const { store } = convergenceFixture();
    seedLoop(store);
    const grant = store.issueContinuationGrant(grantInput());
    store.upsertConvergenceTask(taskInput({ eventUid: `contract-change-${field}`, [field]: revision }));
    assert.throws(() => store.consumeContinuationGrant({
      token: grant.token,
      ...grantBinding({ eventUid: `consume-stale-${field}` })
    }), /grant_revoked/u);
    assert.equal(store.getConvergenceStatus({ taskUid: "task-1", fingerprint: "fingerprint-1" })
      .activeGrantId, null);
    store.close();
  }
});

test("concurrent grant consumers across SQLite connections have exactly one winner", async () => {
  const { store, paths } = convergenceFixture();
  seedLoop(store);
  const grant = store.issueContinuationGrant(grantInput());
  store.close();
  const moduleUrl = new URL("../src/control-store.mjs", import.meta.url).href;
  const script = `
    import { openControlStore } from ${JSON.stringify(moduleUrl)};
    const [paths, input] = JSON.parse(process.argv[1]);
    const store = openControlStore({ paths, now: () => new Date('2026-07-21T00:00:00.000Z') });
    try { store.consumeContinuationGrant(input); process.stdout.write('won'); }
    catch (error) { process.stdout.write(error.code ?? error.message); process.exitCode = 2; }
    finally { store.close(); }
  `;
  const base = { token: grant.token, ...grantBinding() };
  const run = (eventUid) => {
    const child = spawn(process.execPath, [
      "--input-type=module", "--eval", script,
      JSON.stringify([paths, { ...base, eventUid }])
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    return once(child, "exit").then(([code]) => ({ code, stdout }));
  };
  const results = await Promise.all([run("grant-race-a"), run("grant-race-b")]);
  assert.equal(
    results.filter((result) => result.code === 0 && result.stdout === "won").length,
    1,
    JSON.stringify(results)
  );
  assert.equal(
    results.filter((result) => /grant_consumed/u.test(result.stdout)).length,
    1,
    JSON.stringify(results)
  );
  const reopened = initializeControlStore({ paths });
  assert.equal(reopened.getConvergenceStatus({ taskUid: "task-1", fingerprint: "fingerprint-1" })
    .currentGeneration, 2);
  reopened.close();
});

test("resolve retains loop history and refuses a live grant or Probe", () => {
  const first = convergenceFixture();
  seedLoop(first.store);
  const grant = first.store.issueContinuationGrant(grantInput());
  assert.throws(() => first.store.resolveConvergenceLoop({
    eventUid: "resolve-live-grant",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    resolution: "closed",
    reasonCode: "task_complete"
  }), /loop_has_live_control/u);
  first.store.consumeContinuationGrant({ token: grant.token, ...grantBinding() });
  first.store.recordConvergenceReview(reviewInput({
    eventUid: "review-after-generation-2",
    generation: 2,
    verdict: "approved"
  }));
  const resolved = first.store.resolveConvergenceLoop({
    eventUid: "resolve-closed",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    resolution: "closed",
    reasonCode: "task_complete"
  });
  assert.equal(resolved.status, "terminal");
  assert.equal(resolved.failureCount, 1);
  assert.deepEqual(resolved.fixGenerations, [1, 2]);
  assert.deepEqual(first.store.resolveConvergenceLoop({
    eventUid: "resolve-closed",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    resolution: "closed",
    reasonCode: "task_complete"
  }), resolved);
  first.store.close();

  const second = convergenceFixture();
  requireReflection(second.store);
  second.store.requestConvergenceProbe({
    eventUid: "probe-before-resolve",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    probeKind: "convergence_reflection",
    dueAt: "2026-07-21T00:00:00.000Z"
  });
  assert.throws(() => second.store.resolveConvergenceLoop({
    eventUid: "resolve-live-probe",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    resolution: "closed",
    reasonCode: "task_complete"
  }), /loop_has_live_control/u);
  second.store.close();
});

function importInput(overrides = {}) {
  return {
    eventUid: "legacy-import-1",
    sourceDigest: "b".repeat(64),
    mappingVersion: "guard-v1",
    task: {
      ...taskInput(),
      eventUid: undefined
    },
    loops: [{
      fingerprint: "legacy-fingerprint",
      boundaryId: "legacy-task-3",
      canonicalInvariantId: "legacy-invariant",
      status: "terminal",
      failureCount: 2,
      fixGeneration: 1,
      decisionBasisDigest: DIGEST.basis,
      currentDecision: "finish",
      directionGeneration: 1,
      aliases: ["legacy-alias"]
    }],
    grants: [],
    mappedEvents: [{
      eventUid: "legacy-review-summary",
      fingerprint: "legacy-fingerprint",
      generation: 1,
      eventType: "review_recorded",
      decision: "checkpoint_required",
      evidenceDigest: DIGEST.evidence,
      facts: {
        directionSignal: "none",
        failureCount: 2,
        severity: "important",
        verdict: "changes_required"
      }
    }],
    ...overrides
  };
}

test("transactional Guard import is idempotent by source digest and preserves real mapped history", () => {
  const { store } = convergenceFixture();
  const input = importInput();
  delete input.task.eventUid;
  const first = store.transactionalGuardImport(input);
  const replay = store.transactionalGuardImport(input);
  assert.deepEqual(replay, first);
  assert.equal(first.imported, true);
  assert.equal(first.loopCount, 1);
  const status = store.getConvergenceStatus({
    taskUid: "task-1",
    fingerprint: "legacy-fingerprint"
  });
  assert.equal(status.failureCount, 2);
  assert.equal(status.currentGeneration, 1);
  assert.deepEqual(status.aliases, ["legacy-alias"]);
  assert.equal(store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_events WHERE event_type='legacy_imported'"
  ).get().count, 1);
  assert.equal(store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_events WHERE event_uid='legacy-review-summary'"
  ).get().count, 1);
  store.close();
});

test("failed Guard import rolls back its event task and loop projections together", () => {
  const { store } = convergenceFixture();
  const input = importInput({
    eventUid: "legacy-import-bad",
    sourceDigest: "c".repeat(64),
    loops: [
      importInput().loops[0],
      { ...importInput().loops[0], fingerprint: "legacy-fingerprint-2" }
    ]
  });
  delete input.task.eventUid;
  assert.throws(() => store.transactionalGuardImport(input), /loop_identity_collision/u);
  assert.equal(store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_events WHERE event_uid='legacy-import-bad'"
  ).get().count, 0);
  assert.equal(store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_tasks WHERE task_uid='task-1'"
  ).get().count, 0);
  store.close();
});
