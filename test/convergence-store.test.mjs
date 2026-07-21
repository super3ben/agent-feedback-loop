import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
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
import {
  canonicalGuardParityValue,
  guardParitySetDigest
} from "../src/convergence-store.mjs";

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
  contract: "f703e687ef7b42b75da2a39b6f8c1572eb7346cef40cf446f9de96cafb6570e7",
  policy: "b81c94b8880ab8fd44714bb82d8c2a6479d512e506a50349ab1601194cadc58f",
  basis: "6".repeat(64),
  evidence: "7".repeat(64),
  scope: "8".repeat(64)
});

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

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

test("task event identity binds every accepted canonical field before projection guards", () => {
  const changes = {
    taskUid: "task-2",
    lineageDigest: "a".repeat(64),
    adapterKind: "generic",
    adapterCapability: "audit_only",
    nativeTaskDigest: "b".repeat(64),
    contractSourceKind: "explicit_user",
    contractSourceRefDigest: "c".repeat(64),
    contractRevision: "d".repeat(64),
    policyRevision: "e".repeat(64),
    importance: "important",
    importanceAuthority: "explicit_user"
  };
  for (const [field, changed] of Object.entries(changes)) {
    const { store } = convergenceFixture();
    store.upsertConvergenceTask(taskInput());
    assert.throws(
      () => store.upsertConvergenceTask(taskInput({ [field]: changed })),
      /event_collision/u,
      field
    );
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM convergence_events").get().count, 1);
    store.close();
  }
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
  const regression = store.recordConvergenceReview(reviewInput({
    eventUid: "review-event-2",
    evidenceDigest: "8".repeat(64)
  }));
  assert.equal(regression.fingerprint, "fingerprint-1");
  assert.equal(regression.failureCount, 2);
  assert.deepEqual(regression.fixGenerations, [1]);
  assert.equal(regression.decision, "checkpoint_required");
  store.close();
});

test("minor changes-required reviews are recorded without consuming a failure generation", () => {
  const { store } = convergenceFixture();
  store.upsertConvergenceTask(taskInput());

  const minor = store.recordConvergenceReview(reviewInput({ severity: "minor" }));
  assert.equal(minor.failureCount, 0);
  assert.equal(minor.currentGeneration, 1);
  const event = store.database.prepare(
    "SELECT facts_json FROM convergence_events WHERE event_uid='review-event-1'"
  ).get();
  assert.deepEqual(JSON.parse(event.facts_json), {
    directionSignal: "none",
    failureCount: 0,
    severity: "minor",
    verdict: "changes_required"
  });

  const important = store.recordConvergenceReview(reviewInput({
    eventUid: "review-event-important",
    severity: "important",
    evidenceDigest: "8".repeat(64)
  }));
  assert.equal(important.failureCount, 1);
  store.close();
});

test("canonical review envelope makes alias replay immutable across every accepted field", () => {
  const { store } = convergenceFixture();
  seedLoop(store);
  store.upsertConvergenceTask(taskInput({
    eventUid: "contract-event-task-2",
    taskUid: "task-2",
    lineageDigest: "a".repeat(64),
    nativeTaskDigest: "b".repeat(64)
  }));
  store.addConvergenceAlias({
    eventUid: "alias-history-declared",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    aliasInvariantId: "renamed-atomic-store"
  });

  const aliasReview = reviewInput({
    eventUid: "review-alias-repeated-evidence",
    fingerprint: "fingerprint-escaped",
    canonicalInvariantId: "renamed-atomic-store"
  });
  const reviewed = store.recordConvergenceReview(aliasReview);

  assert.equal(reviewed.fingerprint, "fingerprint-1");
  assert.equal(reviewed.failureCount, 1);
  assert.equal(reviewed.currentGeneration, 1);
  assert.deepEqual(reviewed.fixGenerations, [1]);
  assert.equal(store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_loops WHERE task_uid='task-1'"
  ).get().count, 1);
  assert.equal(store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_events WHERE event_type='review_recorded'"
  ).get().count, 2);

  const state = () => ({
    eventCount: store.database.prepare(
      "SELECT COUNT(*) AS count FROM convergence_events"
    ).get().count,
    loopCount: store.database.prepare(
      "SELECT COUNT(*) AS count FROM convergence_loops"
    ).get().count,
    reviewEvents: store.database.prepare(
      "SELECT * FROM convergence_events WHERE event_type='review_recorded' ORDER BY id"
    ).all(),
    loop: store.database.prepare(
      "SELECT * FROM convergence_loops WHERE fingerprint='fingerprint-1'"
    ).get()
  });
  const aliasAcceptedState = state();
  const problems = [];
  const recordStateChange = (expected, label) => {
    try {
      assert.deepEqual(state(), expected);
    } catch {
      problems.push(`${label} mutated persisted state`);
    }
  };
  try {
    assert.deepEqual(store.recordConvergenceReview(aliasReview), reviewed);
  } catch (error) {
    problems.push(`exact alias retry: ${error.code ?? error.message}`);
  }
  recordStateChange(aliasAcceptedState, "exact alias retry");

  const canonicalReview = reviewInput({
    eventUid: "review-canonical-envelope-matrix"
  });
  store.recordConvergenceReview(canonicalReview);
  const acceptedState = state();

  const changes = {
    taskUid: "task-2",
    boundaryId: "different-boundary",
    canonicalInvariantId: "renamed-atomic-store",
    fingerprint: "another-submitted-fingerprint",
    verdict: "approved",
    severity: "critical",
    directionSignal: "structural_blocked",
    decisionBasisDigest: "9".repeat(64),
    evidenceDigest: "a".repeat(64),
    generation: 2
  };
  for (const [field, changed] of Object.entries(changes)) {
    try {
      store.recordConvergenceReview({ ...canonicalReview, [field]: changed });
      problems.push(`${field}: changed request was accepted`);
    } catch (error) {
      if (error.code !== "event_collision") {
        problems.push(`${field}: ${error.code ?? error.message}`);
      }
    }
    recordStateChange(acceptedState, `${field}: collision`);
  }
  assert.deepEqual(problems, []);
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

test("decision projection validates an already-evaluated shape without deriving policy in the store", () => {
  const source = readFileSync(new URL("../src/convergence-store.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /evaluateConvergence\s*\(/u);
});

test("breaker projection binds the evaluated snapshot and matching target", () => {
  const { store } = convergenceFixture();
  seedLoop(store);
  store.recordConvergenceReview(reviewInput({
    eventUid: "review-decision-second-failure",
    evidenceDigest: "8".repeat(64)
  }));
  const request = policyRequest({
    previousDecisionBasisDigest: DIGEST.basis,
    decisionBasisDigest: DIGEST.basis,
    evidenceChanged: false
  });
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
    eventUid: "decision-event-3",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    evaluationRequest: request,
    evaluation,
    targetStatus: "human_decision"
  }), /decision_target_mismatch/u);

  const mismatches = [
    { adapterCapability: "audit_only" },
    { contract: { ...request.contract, revision: "a".repeat(64) } },
    { failureCount: 1 },
    { currentGeneration: 2 },
    { requestedGeneration: 4 },
    { decisionBasisDigest: "b".repeat(64), evidenceChanged: true }
  ];
  for (const [index, mismatch] of mismatches.entries()) {
    assert.throws(() => store.recordConvergenceDecision({
      eventUid: `decision-snapshot-mismatch-${index}`,
      taskUid: "task-1",
      fingerprint: "fingerprint-1",
      evaluationRequest: { ...request, ...mismatch },
      evaluation,
      targetStatus: "checkpoint_required"
    }), /decision_snapshot_mismatch/u);
  }
  assert.throws(() => store.recordConvergenceDecision({
    eventUid: "decision-policy-mismatch",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    evaluationRequest: request,
    evaluation: { ...evaluation, policyRevision: "convergence-policy-v3" },
    targetStatus: "checkpoint_required"
  }), /decision_snapshot_mismatch/u);
  store.close();
});

test("checkpoint records one direction generation and pass opens only the exact next generation", () => {
  const { store } = convergenceFixture();
  seedLoop(store);
  store.recordConvergenceReview(reviewInput({
    eventUid: "review-checkpoint-second-failure",
    evidenceDigest: "8".repeat(64)
  }));
  const request = policyRequest({
    decisionBasisDigest: DIGEST.basis,
    evidenceChanged: false
  });
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

test("state-changing checkpoint generation and Probe writes replay before current-state guards", () => {
  const checkpointFixture = convergenceFixture();
  seedLoop(checkpointFixture.store);
  checkpointFixture.store.recordConvergenceReview(reviewInput({
    eventUid: "review-replay-checkpoint-second-failure",
    evidenceDigest: "8".repeat(64)
  }));
  const request = policyRequest({
    decisionBasisDigest: DIGEST.basis,
    evidenceChanged: false
  });
  checkpointFixture.store.recordConvergenceDecision({
    eventUid: "decision-replay-checkpoint",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    evaluationRequest: request,
    evaluation: evaluateConvergence(request),
    targetStatus: "checkpoint_required"
  });
  const checkpointInput = {
    eventUid: "checkpoint-replay",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    checkpointKind: "architecture_direction",
    fileDigest: "f".repeat(64)
  };
  assert.deepEqual(
    checkpointFixture.store.recordConvergenceCheckpoint(checkpointInput),
    checkpointFixture.store.recordConvergenceCheckpoint(checkpointInput)
  );
  checkpointFixture.store.close();

  const generationFixture = convergenceFixture();
  seedLoop(generationFixture.store);
  const generationInput = {
    eventUid: "generation-replay",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    requestedGeneration: 2,
    purpose: "pass"
  };
  assert.deepEqual(
    generationFixture.store.requestConvergenceGeneration(generationInput),
    generationFixture.store.requestConvergenceGeneration(generationInput)
  );
  generationFixture.store.close();

  const probeFixture = convergenceFixture();
  requireReflection(probeFixture.store);
  const probeRequest = {
    eventUid: "probe-request-replay",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    probeKind: "convergence_reflection",
    dueAt: "2026-07-21T00:00:00.000Z"
  };
  assert.deepEqual(
    probeFixture.store.requestConvergenceProbe(probeRequest),
    probeFixture.store.requestConvergenceProbe(probeRequest)
  );
  const claim = {
    eventUid: "probe-claim-replay",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    ownerId: "probe-owner-replay",
    leaseMs: 30_000
  };
  assert.deepEqual(
    probeFixture.store.claimConvergenceProbe(claim),
    probeFixture.store.claimConvergenceProbe(claim)
  );
  const completion = {
    eventUid: "probe-completion-replay",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    ownerId: "probe-owner-replay",
    leaseEpoch: 1,
    action: "continue_once",
    resultDigest: "a".repeat(64)
  };
  assert.deepEqual(
    probeFixture.store.completeConvergenceProbe(completion),
    probeFixture.store.completeConvergenceProbe(completion)
  );
  assert.equal(probeFixture.store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_events WHERE event_uid LIKE '%replay'"
  ).get().count, 3);
  probeFixture.store.close();
});

test("Probe failure replay is idempotent after the lease state changes", () => {
  const fixture = convergenceFixture();
  requireReflection(fixture.store);
  fixture.store.requestConvergenceProbe({
    eventUid: "probe-request-failure-replay",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    probeKind: "convergence_reflection",
    dueAt: "2026-07-21T00:00:00.000Z"
  });
  fixture.store.claimConvergenceProbe({
    eventUid: "probe-claim-failure-replay",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    ownerId: "probe-owner-failure-replay",
    leaseMs: 30_000
  });
  const failure = {
    eventUid: "probe-failure-replay",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    ownerId: "probe-owner-failure-replay",
    leaseEpoch: 1,
    reasonCode: "provider_timeout",
    retryable: true,
    backoffMs: 1_000
  };
  assert.deepEqual(
    fixture.store.failConvergenceProbe(failure),
    fixture.store.failConvergenceProbe(failure)
  );
  fixture.store.close();
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
    action: "continue_once",
    resultDigest: "a".repeat(64)
  }), /probe_lease_lost/u);
  const completed = store.completeConvergenceProbe({
    eventUid: "probe-complete-1",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    ownerId: "probe-owner-1",
    leaseEpoch: 1,
    action: "continue_once",
    resultDigest: "a".repeat(64)
  });
  assert.equal(completed.probeState, "completed");
  assert.equal(completed.probeOwnerId, null);
  assert.equal(completed.status, "reflection_resolved");
  store.close();
});

test("hard-looking Probe advice stays neutral and immutable at the Store authority boundary", () => {
  for (const action of ["direction_checkpoint", "human_decision", "finish_now"]) {
    const fixture = convergenceFixture();
    const { store } = fixture;
    requireReflection(store);
    store.requestConvergenceProbe({
      eventUid: `probe-request-neutral-${action}`,
      taskUid: "task-1",
      fingerprint: "fingerprint-1",
      probeKind: "convergence_reflection",
      dueAt: "2026-07-21T00:00:00.000Z"
    });
    store.claimConvergenceProbe({
      eventUid: `probe-claim-neutral-${action}`,
      taskUid: "task-1",
      fingerprint: "fingerprint-1",
      ownerId: `probe-owner-neutral-${action}`,
      leaseMs: 30_000
    });
    const completion = {
      eventUid: `probe-complete-neutral-${action}`,
      taskUid: "task-1",
      fingerprint: "fingerprint-1",
      ownerId: `probe-owner-neutral-${action}`,
      leaseEpoch: 1,
      action,
      resultDigest: "a".repeat(64)
    };

    const completed = store.completeConvergenceProbe(completion);
    const event = store.database.prepare(`SELECT action, result_digest
      FROM convergence_events WHERE event_uid=?`).get(completion.eventUid);

    assert.equal(completed.status, "reflection_resolved", action);
    assert.equal(completed.probeState, "completed", action);
    assert.equal(completed.probeOwnerId, null, action);
    assert.equal(completed.probeLeaseUntil, null, action);
    assert.equal(completed.probeResultDigest, completion.resultDigest, action);
    assert.equal(event.action, action);
    assert.equal(event.result_digest, completion.resultDigest);
    assert.equal(store.database.prepare(
      "SELECT COUNT(*) AS count FROM continuation_grants WHERE fingerprint=?"
    ).get("fingerprint-1").count, 0, action);
    assert.deepEqual(store.completeConvergenceProbe(completion), completed, action);
    store.close();
  }
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

test("expired running Probe leases are reclaimed and exhausted attempts become terminal", () => {
  const fixture = convergenceFixture();
  const { store } = fixture;
  requireReflection(store);
  store.requestConvergenceProbe({
    eventUid: "probe-request-expired",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    probeKind: "convergence_reflection",
    dueAt: "2026-07-21T00:00:00.000Z"
  });
  const first = store.claimConvergenceProbe({
    eventUid: "probe-claim-expired-1",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    ownerId: "probe-owner-expired-1",
    leaseMs: 1_000
  });
  fixture.advance(1_001);
  const second = store.claimConvergenceProbe({
    eventUid: "probe-claim-expired-2",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    ownerId: "probe-owner-expired-2",
    leaseMs: 1_000
  });
  assert.equal(second.probeAttempt, 2);
  assert.equal(second.probeLeaseEpoch, first.probeLeaseEpoch + 1);
  assert.equal(second.probeOwnerId, "probe-owner-expired-2");
  assert.throws(() => store.completeConvergenceProbe({
    eventUid: "probe-complete-expired-owner",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    ownerId: "probe-owner-expired-1",
    leaseEpoch: first.probeLeaseEpoch,
    action: "continue_once",
    resultDigest: "a".repeat(64)
  }), /probe_lease_lost/u);

  fixture.advance(1_001);
  const third = store.claimConvergenceProbe({
    eventUid: "probe-claim-expired-3",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    ownerId: "probe-owner-expired-3",
    leaseMs: 1_000
  });
  assert.equal(third.probeAttempt, 3);
  assert.equal(third.probeLeaseEpoch, 3);
  fixture.advance(1_001);
  const exhaustedInput = {
    eventUid: "probe-claim-expired-exhausted",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    ownerId: "probe-owner-expired-4",
    leaseMs: 1_000
  };
  const exhausted = store.claimConvergenceProbe(exhaustedInput);
  assert.equal(exhausted.probeAttempt, 3);
  assert.equal(exhausted.probeState, "failed");
  assert.equal(exhausted.status, "checkpoint_required");
  assert.equal(exhausted.probeOwnerId, null);
  assert.deepEqual(store.claimConvergenceProbe(exhaustedInput), exhausted);
  assert.equal(store.database.prepare(`SELECT COUNT(*) AS count FROM convergence_events
    WHERE fingerprint='fingerprint-1' AND event_type='reflection_claimed'`).get().count, 3);
  assert.equal(store.database.prepare(`SELECT COUNT(*) AS count FROM convergence_events
    WHERE event_uid='probe-claim-expired-exhausted' AND event_type='reflection_failed'`).get().count, 1);
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

test("grant issue replay returns no secret and performs zero revocation or issuance mutation", () => {
  const { store } = convergenceFixture();
  seedLoop(store);
  const issued = store.issueContinuationGrant(grantInput());
  const before = {
    events: store.database.prepare("SELECT COUNT(*) AS count FROM convergence_events").get().count,
    grants: store.database.prepare("SELECT COUNT(*) AS count FROM continuation_grants").get().count,
    version: store.getConvergenceStatus({ taskUid: "task-1", fingerprint: "fingerprint-1" }).version
  };

  const replay = store.issueContinuationGrant(grantInput());
  assert.deepEqual(replay, {
    grantId: "grant-1",
    replayed: true,
    tokenAvailable: false
  });
  assert.equal("token" in replay, false);
  assert.deepEqual({
    events: store.database.prepare("SELECT COUNT(*) AS count FROM convergence_events").get().count,
    grants: store.database.prepare("SELECT COUNT(*) AS count FROM continuation_grants").get().count,
    version: store.getConvergenceStatus({ taskUid: "task-1", fingerprint: "fingerprint-1" }).version
  }, before);
  assert.throws(
    () => store.issueContinuationGrant(grantInput({ scopeDigest: "9".repeat(64) })),
    /event_collision/u
  );
  assert.equal(store.database.prepare(
    "SELECT state FROM continuation_grants WHERE grant_id='grant-1'"
  ).get().state, "active");
  assert.equal(typeof issued.token, "string");
  store.close();
});

test("consumed grant replay compares the complete canonical binding", () => {
  const { store } = convergenceFixture();
  seedLoop(store);
  const grant = store.issueContinuationGrant(grantInput());
  const input = { token: grant.token, ...grantBinding() };
  const consumed = store.consumeContinuationGrant(input);
  assert.deepEqual(store.consumeContinuationGrant(input), consumed);
  for (const changed of [
    { nextGeneration: 3 },
    { purpose: "simplify" },
    { scopeDigest: "9".repeat(64) },
    { contractRevision: "a".repeat(64) },
    { policyRevision: "b".repeat(64) },
    { decisionBasisDigest: "c".repeat(64) },
    { evidenceDigest: "d".repeat(64) }
  ]) {
    assert.throws(
      () => store.consumeContinuationGrant({ ...input, ...changed }),
      /event_collision/u,
      JSON.stringify(changed)
    );
  }
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
  const { eventUid: _taskEventUid, ...importedTask } = taskInput();
  const { eventUid: _authorityEventUid, ...authorityTask } = taskInput({
    taskUid: "guard-authority-task",
    adapterKind: "sdd",
    adapterCapability: "workflow_gate",
    nativeTaskDigest: "a".repeat(64),
    contractSourceRefDigest: "b".repeat(64)
  });
  return {
    eventUid: "legacy-import-1",
    authorityTask,
    sourceSha256: "b".repeat(64),
    mappingRevision: "guard-v1",
    tasks: [{
      task: importedTask,
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
      }]
    }],
    ...overrides
  };
}

test("transactional Guard import is idempotent by source digest and preserves real mapped history", () => {
  const { store } = convergenceFixture();
  const input = importInput();
  const first = store.transactionalGuardImport(input);
  const replay = store.transactionalGuardImport(input);
  assert.deepEqual(replay, first);
  assert.equal(first.imported, true);
  assert.equal(first.taskCount, 1);
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

test("Guard import rejects changed canonical content for an existing source digest", () => {
  const { store } = convergenceFixture();
  const input = importInput();
  const first = store.transactionalGuardImport(input);
  assert.throws(() => store.transactionalGuardImport({
    ...input,
    mappingRevision: "guard-v2"
  }), /import_collision/u);
  assert.equal(store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_events WHERE event_type='legacy_imported'"
  ).get().count, 1);
  assert.equal(first.eventCount, 1);
  store.close();
});

test("Guard import facts are event-specific and reject cross-event fields", () => {
  const { store } = convergenceFixture();
  const input = importInput({
    eventUid: "legacy-import-cross-facts",
    sourceSha256: "c".repeat(64),
    tasks: [{
      ...importInput().tasks[0],
      mappedEvents: [{
        ...importInput().tasks[0].mappedEvents[0],
        eventUid: "legacy-review-cross-facts",
        facts: {
          ...importInput().tasks[0].mappedEvents[0].facts,
          aliasId: "not-valid-on-review"
        }
      }]
    }]
  });
  assert.throws(() => store.transactionalGuardImport(input), /unknown_event_facts_field/u);
  assert.equal(store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_events WHERE event_uid='legacy-import-cross-facts'"
  ).get().count, 0);
  store.close();
});

test("Guard import rolls back when one fingerprint has multiple active grants", () => {
  const { store } = convergenceFixture();
  const importedGrant = (grantId, tokenHash) => ({
    grantId,
    tokenHash,
    fingerprint: "legacy-fingerprint",
    currentGeneration: 1,
    nextGeneration: 2,
    purpose: "local_fix",
    scopeDigest: DIGEST.scope,
    contractRevision: DIGEST.contract,
    policyRevision: DIGEST.policy,
    decisionBasisDigest: DIGEST.basis,
    evidenceDigest: DIGEST.evidence,
    state: "active",
    issuedAt: "2026-07-21T00:00:00.000Z",
    expiresAt: "2026-07-21T00:05:00.000Z",
    consumedAt: null,
    revokedAt: null
  });
  const input = importInput({
    eventUid: "legacy-import-active-conflict",
    sourceSha256: "d".repeat(64),
    tasks: [{
      ...importInput().tasks[0],
      grants: [
        importedGrant("legacy-grant-1", "1".repeat(64)),
        importedGrant("legacy-grant-2", "2".repeat(64))
      ]
    }]
  });
  assert.throws(() => store.transactionalGuardImport(input), /active_grant_collision/u);
  assert.equal(store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_events WHERE event_uid='legacy-import-active-conflict'"
  ).get().count, 0);
  assert.equal(store.database.prepare(
    "SELECT COUNT(*) AS count FROM continuation_grants"
  ).get().count, 0);
  assert.equal(store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_tasks"
  ).get().count, 0);
  store.close();
});

test("failed Guard import rolls back its event task and loop projections together", () => {
  const { store } = convergenceFixture();
  const input = importInput({
    eventUid: "legacy-import-bad",
    sourceSha256: "c".repeat(64),
    tasks: [{
      ...importInput().tasks[0],
      loops: [
        importInput().tasks[0].loops[0],
        { ...importInput().tasks[0].loops[0], fingerprint: "legacy-fingerprint-2" }
      ]
    }]
  });
  assert.throws(() => store.transactionalGuardImport(input), /loop_identity_collision/u);
  assert.equal(store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_events WHERE event_uid='legacy-import-bad'"
  ).get().count, 0);
  assert.equal(store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_tasks WHERE task_uid='task-1'"
  ).get().count, 0);
  store.close();
});

const PASSING_GUARD_PARITY = Object.freeze([
  Object.freeze({ field: "decision", legacy: "direction_review_required", kernel: "checkpoint_required" }),
  Object.freeze({ field: "next_required_action", legacy: "direction_review", kernel: "checkpoint" }),
  Object.freeze({ field: "failure_generation", legacy: 2, kernel: 2 }),
  Object.freeze({ field: "authorization_eligibility", legacy: false, kernel: false })
]);

function guardShadowObservation(input, item, index, paritySetDigest, overrides = {}) {
  const canonicalLegacy = canonicalGuardParityValue(item.field, "legacy", item.legacy);
  const canonicalKernel = canonicalGuardParityValue(item.field, "kernel", item.kernel);
  return {
    eventUid: `guard-shadow-${index}`,
    authorityTaskUid: input.authorityTask.taskUid,
    sourceSha256: input.sourceSha256,
    mappingRevision: input.mappingRevision,
    paritySetDigest,
    field: item.field,
    legacyValue: item.legacy,
    kernelValue: item.kernel,
    inputDigest: sha256(canonicalJson({
      field: item.field, legacy: item.legacy, kernel: item.kernel
    })),
    legacyResultDigest: sha256(canonicalJson(canonicalLegacy)),
    kernelResultDigest: sha256(canonicalJson(canonicalKernel)),
    matched: canonicalJson(canonicalLegacy) === canonicalJson(canonicalKernel),
    ...overrides
  };
}

function recordPassingGuardShadow(store, input, paritySetDigest = guardParitySetDigest({
  sourceSha256: input.sourceSha256,
  mappingRevision: input.mappingRevision,
  comparisons: PASSING_GUARD_PARITY
})) {
  const values = {
    decision: ["direction_review_required", "checkpoint_required"],
    next_required_action: ["direction_review", "checkpoint"],
    failure_generation: [2, 2],
    authorization_eligibility: [false, false]
  };
  for (const [index, field] of [
    "decision", "next_required_action", "failure_generation", "authorization_eligibility"
  ].entries()) {
    store.recordGuardShadowComparison(guardShadowObservation(input, {
      field, legacy: values[field][0], kernel: values[field][1]
    }, index, paritySetDigest));
  }
  return paritySetDigest;
}

test("Store owns persisted Guard shadow, cutover, rollback, and authority replay", () => {
  const { store } = convergenceFixture();
  const input = importInput();
  store.transactionalGuardImport(input);
  assert.deepEqual(store.getGuardAuthority({ authorityTaskUid: input.authorityTask.taskUid }), {
    authority: "legacy_guard",
    imported: true,
    sourceSha256: input.sourceSha256,
    mappingRevision: input.mappingRevision,
    paritySetDigest: null,
    snapshotDigest: null,
    snapshotDev: null,
    snapshotIno: null,
    snapshotMode: null,
    snapshotType: null,
    snapshotUid: null,
    cutoverEventUid: null
  });

  const paritySetDigest = recordPassingGuardShadow(store, input);
  const cutover = {
    eventUid: "guard-cutover-1",
    authorityTaskUid: input.authorityTask.taskUid,
    sourceSha256: input.sourceSha256,
    mappingRevision: input.mappingRevision,
    paritySetDigest,
    snapshotDigest: input.sourceSha256,
    snapshotDev: 1,
    snapshotIno: 2,
    snapshotMode: 0o400,
    snapshotType: "regular",
    snapshotUid: typeof process.getuid === "function" ? process.getuid() : 0,
    decisionRefDigest: "e".repeat(64)
  };
  const cutoverResult = store.recordGuardCutover(cutover);
  assert.deepEqual(store.recordGuardCutover(cutover), cutoverResult);
  assert.equal(store.getGuardAuthority({ authorityTaskUid: input.authorityTask.taskUid }).authority,
    "afl_sqlite");

  const rollback = {
    eventUid: "guard-rollback-1",
    authorityTaskUid: input.authorityTask.taskUid,
    cutoverEventUid: cutover.eventUid,
    snapshotDigest: cutover.snapshotDigest,
    snapshotDev: cutover.snapshotDev,
    snapshotIno: cutover.snapshotIno,
    snapshotMode: cutover.snapshotMode,
    snapshotType: cutover.snapshotType,
    snapshotUid: cutover.snapshotUid,
    decisionRefDigest: "f".repeat(64)
  };
  const rollbackResult = store.recordGuardRollback(rollback);
  assert.deepEqual(store.recordGuardRollback(rollback), rollbackResult);
  const restored = store.getGuardAuthority({ authorityTaskUid: input.authorityTask.taskUid });
  assert.equal(restored.authority, "legacy_guard");
  assert.equal(restored.cutoverEventUid, cutover.eventUid);
  assert.equal(store.database.prepare(`SELECT COUNT(*) AS count FROM convergence_events
    WHERE event_type IN ('guard_cutover','guard_rollback')`).get().count, 2);
  store.close();
});

test("Store refuses Guard cutover on incomplete parity or live continuation authority", () => {
  const first = convergenceFixture();
  const input = importInput();
  first.store.transactionalGuardImport(input);
  const mismatchComparison = {
    field: "decision", legacy: "direction_review_required", kernel: "finish"
  };
  const mismatchSet = guardParitySetDigest({
    sourceSha256: input.sourceSha256,
    mappingRevision: input.mappingRevision,
    comparisons: PASSING_GUARD_PARITY.map((item) => item.field === "decision"
      ? mismatchComparison : item)
  });
  first.store.recordGuardShadowComparison(guardShadowObservation(
    input, mismatchComparison, 0, mismatchSet, { eventUid: "guard-shadow-mismatch" }
  ));
  assert.throws(() => first.store.recordGuardCutover({
    eventUid: "guard-cutover-mismatch",
    authorityTaskUid: input.authorityTask.taskUid,
    sourceSha256: input.sourceSha256,
    mappingRevision: input.mappingRevision,
    paritySetDigest: mismatchSet,
    snapshotDigest: input.sourceSha256,
    snapshotDev: 1,
    snapshotIno: 2,
    snapshotMode: 0o400,
    snapshotType: "regular",
    snapshotUid: typeof process.getuid === "function" ? process.getuid() : 0,
    decisionRefDigest: "e".repeat(64)
  }), /shadow_parity_incomplete/u);
  first.store.close();

  const second = convergenceFixture();
  const importedGrant = {
    grantId: "legacy-live-grant",
    tokenHash: "1".repeat(64),
    fingerprint: "legacy-fingerprint",
    currentGeneration: 1,
    nextGeneration: 2,
    purpose: "local_fix",
    scopeDigest: DIGEST.scope,
    contractRevision: DIGEST.contract,
    policyRevision: DIGEST.policy,
    decisionBasisDigest: DIGEST.basis,
    evidenceDigest: DIGEST.evidence,
    state: "active",
    issuedAt: "2026-07-21T00:00:00.000Z",
    expiresAt: "2026-07-21T00:05:00.000Z",
    consumedAt: null,
    revokedAt: null
  };
  const liveInput = importInput({
    tasks: [{ ...importInput().tasks[0], grants: [importedGrant] }]
  });
  second.store.transactionalGuardImport(liveInput);
  const paritySetDigest = recordPassingGuardShadow(second.store, liveInput);
  assert.throws(() => second.store.recordGuardCutover({
    eventUid: "guard-cutover-live",
    authorityTaskUid: liveInput.authorityTask.taskUid,
    sourceSha256: liveInput.sourceSha256,
    mappingRevision: liveInput.mappingRevision,
    paritySetDigest,
    snapshotDigest: liveInput.sourceSha256,
    snapshotDev: 1,
    snapshotIno: 2,
    snapshotMode: 0o400,
    snapshotType: "regular",
    snapshotUid: typeof process.getuid === "function" ? process.getuid() : 0,
    decisionRefDigest: "e".repeat(64)
  }), /guard_live_action/u);
  second.store.close();
});

test("Store cutover requires one typed observation for every field in one bound parity run", () => {
  const duplicate = convergenceFixture();
  const duplicateInput = importInput();
  duplicate.store.transactionalGuardImport(duplicateInput);
  const duplicateDigest = recordPassingGuardShadow(duplicate.store, duplicateInput);
  duplicate.store.recordGuardShadowComparison(guardShadowObservation(
    duplicateInput,
    PASSING_GUARD_PARITY[0],
    9,
    duplicateDigest,
    { eventUid: "guard-shadow-duplicate-decision" }
  ));
  assert.throws(() => duplicate.store.recordGuardCutover({
    eventUid: "guard-cutover-duplicate",
    authorityTaskUid: duplicateInput.authorityTask.taskUid,
    sourceSha256: duplicateInput.sourceSha256,
    mappingRevision: duplicateInput.mappingRevision,
    paritySetDigest: duplicateDigest,
    snapshotDigest: duplicateInput.sourceSha256,
    snapshotDev: 1,
    snapshotIno: 2,
    snapshotMode: 0o400,
    snapshotType: "regular",
    snapshotUid: typeof process.getuid === "function" ? process.getuid() : 0,
    decisionRefDigest: "e".repeat(64)
  }), /shadow_parity_incomplete/u);
  assert.equal(duplicate.store.getGuardAuthority({
    authorityTaskUid: duplicateInput.authorityTask.taskUid
  }).authority, "legacy_guard");
  duplicate.store.close();

  const missing = convergenceFixture();
  const missingInput = importInput();
  missing.store.transactionalGuardImport(missingInput);
  const missingDigest = guardParitySetDigest({
    sourceSha256: missingInput.sourceSha256,
    mappingRevision: missingInput.mappingRevision,
    comparisons: PASSING_GUARD_PARITY
  });
  PASSING_GUARD_PARITY.slice(0, 3).forEach((item, index) => {
    missing.store.recordGuardShadowComparison(guardShadowObservation(
      missingInput, item, index, missingDigest
    ));
  });
  assert.throws(() => missing.store.recordGuardCutover({
    eventUid: "guard-cutover-missing",
    authorityTaskUid: missingInput.authorityTask.taskUid,
    sourceSha256: missingInput.sourceSha256,
    mappingRevision: missingInput.mappingRevision,
    paritySetDigest: missingDigest,
    snapshotDigest: missingInput.sourceSha256,
    snapshotDev: 1,
    snapshotIno: 2,
    snapshotMode: 0o400,
    snapshotType: "regular",
    snapshotUid: typeof process.getuid === "function" ? process.getuid() : 0,
    decisionRefDigest: "e".repeat(64)
  }), /shadow_parity_incomplete/u);
  missing.store.close();

  const invalid = convergenceFixture();
  const invalidInput = importInput();
  invalid.store.transactionalGuardImport(invalidInput);
  assert.throws(() => invalid.store.recordGuardShadowComparison({
    ...guardShadowObservation(invalidInput, PASSING_GUARD_PARITY[0], 0, "c".repeat(64)),
    legacyValue: "not-a-guard-decision",
    kernelValue: "not-a-guard-decision"
  }), /invalid_guard_parity_value/u);
  assert.throws(() => invalid.store.recordGuardShadowComparison({
    ...guardShadowObservation(invalidInput, PASSING_GUARD_PARITY[0], 0, "c".repeat(64)),
    field: "unknown_parity_field"
  }), /invalid_guard_parity_field/u);
  assert.throws(() => invalid.store.recordGuardShadowComparison({
    ...guardShadowObservation(invalidInput, PASSING_GUARD_PARITY[0], 0, "c".repeat(64)),
    sourceSha256: "a".repeat(64)
  }), /guard_import_not_found/u);
  assert.throws(() => invalid.store.recordGuardShadowComparison({
    ...guardShadowObservation(invalidInput, PASSING_GUARD_PARITY[0], 0, "c".repeat(64)),
    mappingRevision: "guard-v1-different-run"
  }), /guard_import_not_found/u);
  assert.equal(invalid.store.getGuardAuthority({
    authorityTaskUid: invalidInput.authorityTask.taskUid
  }).authority, "legacy_guard");
  invalid.store.close();
});
