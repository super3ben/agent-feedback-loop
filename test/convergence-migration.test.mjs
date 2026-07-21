import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { initializeControlStore } from "../src/control-store.mjs";
import { ensureRepositoryLineage } from "../src/convergence-identity.mjs";
import {
  applyGuardImport,
  compareGuardShadow,
  cutoverGuard,
  inspectGuardImport,
  rollbackGuardCutover
} from "../src/convergence-migration.mjs";
import { executeGuardCli } from "../src/convergence-cli.mjs";
import { runGuardCommand } from "../src/convergence-sdd-adapter.mjs";
import { pathsFor } from "../src/index.mjs";

const cleanups = [];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const legacyFingerprint = (taskId, invariantId, boundary) => sha256(
  Buffer.from(JSON.stringify([taskId, invariantId, boundary]), "utf8")
);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function legacyLoop({ taskId, invariantId, boundary, events = [], overrides = {} }) {
  return {
    task_id: taskId,
    canonical_invariant_id: invariantId,
    boundary,
    status: "open",
    failure_count: 1,
    seen_review_run_ids: events.filter((event) => event.action === "review_recorded")
      .map((event) => event.review_run_id),
    local_fix_generations: [],
    architecture_fix_count: 0,
    checkpoint: null,
    active_receipt: null,
    direction_signal: "none",
    last_evidence_sha256: null,
    events,
    ...overrides
  };
}

async function migrationHarness() {
  const root = await mkdtemp(path.join(tmpdir(), "afl-convergence-migration-"));
  cleanups.push(root);
  const repoRoot = path.join(root, "repo");
  const home = path.join(root, "home");
  await mkdir(path.join(repoRoot, ".superpowers", "sdd"), { recursive: true, mode: 0o700 });
  execFileSync("git", ["init", "-q", repoRoot]);
  await ensureRepositoryLineage({ repoRoot });
  const realRepo = await realpath(repoRoot);
  const stateFile = path.join(repoRoot, ".superpowers", "sdd", "review-loop-state.json");
  const review = {
    at: "2026-07-20T00:00:00Z", action: "review_recorded", review_run_id: "review-a-1",
    severity: "Important", verdict: "changes_required", commit: "commit-a",
    review_ref: "review-a.md", receipt_id: null, hypothesis: "single writer required",
    new_evidence: "verified write collision", new_evidence_sha256: sha256("verified write collision"),
    falsification_test: "run concurrent writers", failure_next_action: "direction_review",
    direction_signal: "none"
  };
  const taskA = ["task-a", "single-writer", "state-store"];
  const taskB = ["task-b", "stable-identity", "review-boundary"];
  const fingerprintA = legacyFingerprint(...taskA);
  const fingerprintB = legacyFingerprint(...taskB);
  const receiptId = sha256("receipt-a");
  const events = [
    review,
    { at: "2026-07-20T00:01:00Z", action: "fix_authorized", severity: null,
      verdict: null, commit: null, review_ref: null, receipt_id: receiptId },
    { at: "2026-07-20T00:02:00Z", action: "receipt_consumed", severity: null,
      verdict: null, commit: null, review_ref: null, receipt_id: receiptId },
    { at: "2026-07-20T00:03:00Z", action: "review_recorded", review_run_id: "review-a-2",
      severity: "Important", verdict: "changes_required", commit: "commit-b",
      review_ref: "review-b.md", receipt_id: null, hypothesis: "local seam failed",
      new_evidence: "second verified collision", new_evidence_sha256: sha256("second verified collision"),
      falsification_test: "run isolated transaction", failure_next_action: "direction_review",
      direction_signal: "none" },
    { at: "2026-07-20T00:04:00Z", action: "checkpoint_recorded", severity: null,
      verdict: null, commit: null, review_ref: null, receipt_id: null },
    { at: "2026-07-20T00:05:00Z", action: "review_recorded", review_run_id: "review-a-approved",
      severity: "Important", verdict: "approved", commit: "commit-c",
      review_ref: "review-c.md", receipt_id: null, hypothesis: null, new_evidence: null,
      new_evidence_sha256: null, falsification_test: null, failure_next_action: null,
      direction_signal: "none" }
  ];
  const state = {
    version: 1,
    repository_id: sha256(realRepo),
    updated_at: "2026-07-20T00:06:00Z",
    aliases: { "single-writer-v2": "single-writer" },
    distinct_declarations: [{ task_id: "task-b", boundary: "review-boundary",
      invariant_id: "stable-identity", reason: "independent identity failure",
      declared_at: "2026-07-20T00:00:00Z" }],
    loops: {
      [fingerprintA]: legacyLoop({ taskId: taskA[0], invariantId: taskA[1], boundary: taskA[2],
        events, overrides: { status: "closed", failure_count: 2,
          seen_review_run_ids: ["review-a-1", "review-a-2", "review-a-approved"],
          local_fix_generations: [1], checkpoint: { path: "checkpoint.md",
            sha256: sha256("checkpoint"), recorded_at: "2026-07-20T00:04:00Z", kind: "direction" },
          last_evidence_sha256: sha256("second verified collision") } }),
      [fingerprintB]: legacyLoop({ taskId: taskB[0], invariantId: taskB[1], boundary: taskB[2] })
    }
  };
  await writeFile(stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await chmod(stateFile, 0o600);
  const store = initializeControlStore({
    paths: pathsFor(home),
    now: () => new Date("2026-07-21T00:00:00.000Z")
  });
  return { root, repoRoot, home, stateFile, state, store, fingerprintA, fingerprintB };
}

const PASSING_COMPARISONS = Object.freeze([
  Object.freeze({ field: "decision", legacy: "direction_review_required", kernel: "checkpoint_required" }),
  Object.freeze({ field: "next_required_action", legacy: "direction_review", kernel: "checkpoint" }),
  Object.freeze({ field: "failure_generation", legacy: 2, kernel: 2 }),
  Object.freeze({ field: "authorization_eligibility", legacy: false, kernel: false })
]);

function reviewArgs(event, { commit = event.commit } = {}) {
  const args = [
    "record-review",
    "--task-id", "task-a",
    "--invariant-id", "single-writer",
    "--boundary", "state-store",
    "--review-run-id", event.review_run_id,
    "--severity", event.severity,
    "--verdict", event.verdict,
    "--commit", commit,
    "--review-ref", event.review_ref
  ];
  for (const [flag, field] of [
    ["--hypothesis", "hypothesis"],
    ["--new-evidence", "new_evidence"],
    ["--falsification-test", "falsification_test"],
    ["--failure-next-action", "failure_next_action"],
    ["--direction-signal", "direction_signal"]
  ]) {
    if (event[field] !== null && event[field] !== undefined) args.push(flag, event[field]);
  }
  return args;
}

test("dry-run returns a bounded multi-task plan and performs no Store or source write", async (t) => {
  const h = await migrationHarness();
  t.after(() => h.store.close());
  const beforeBytes = await readFile(h.stateFile);
  const beforeEvents = h.store.database.prepare("SELECT COUNT(*) AS count FROM convergence_events").get().count;

  const plan = await inspectGuardImport({ repoRoot: h.repoRoot, stateFile: h.stateFile, store: h.store });

  assert.deepEqual(plan.counts, { tasks: 2, loops: 2, events: 6, consumedGrants: 1 });
  assert.equal(JSON.stringify(plan).includes(h.repoRoot), false);
  assert.deepEqual(await readFile(h.stateFile), beforeBytes);
  assert.equal(h.store.database.prepare("SELECT COUNT(*) AS count FROM convergence_events").get().count,
    beforeEvents);
});

test("apply atomically preserves both task associations and exactly one provenance event", async (t) => {
  const h = await migrationHarness();
  t.after(() => h.store.close());
  const plan = await inspectGuardImport({ repoRoot: h.repoRoot, stateFile: h.stateFile, store: h.store });

  const imported = await applyGuardImport({ plan, store: h.store });

  assert.equal(imported.taskCount, 2);
  assert.equal(imported.loopCount, 2);
  assert.equal(h.store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_events WHERE event_type='legacy_imported'"
  ).get().count, 1);
  assert.equal(h.store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_events WHERE event_type='review_recorded'"
  ).get().count, 3);
  const associations = h.store.database.prepare(
    "SELECT fingerprint, task_uid FROM convergence_loops ORDER BY fingerprint"
  ).all();
  assert.equal(new Set(associations.map((row) => row.task_uid)).size, 2);
  assert.deepEqual(associations.map((row) => row.fingerprint).sort(),
    [h.fingerprintA, h.fingerprintB].sort());
  assert.deepEqual(await applyGuardImport({ plan, store: h.store }), imported);
});

test("imported real Review-Run-IDs use live replay and collision identity without snapshot fiction", async (t) => {
  const h = await migrationHarness();
  t.after(() => h.store.close());
  h.state.loops[h.fingerprintB].seen_review_run_ids = ["snapshot-only-review"];
  await writeFile(h.stateFile, `${JSON.stringify(h.state)}\n`, { mode: 0o600 });
  const plan = await inspectGuardImport({ repoRoot: h.repoRoot, stateFile: h.stateFile, store: h.store });
  await applyGuardImport({ plan, store: h.store });
  const shadow = await compareGuardShadow({ plan, store: h.store, comparisons: PASSING_COMPARISONS });
  await cutoverGuard({
    repoRoot: h.repoRoot, stateFile: h.stateFile, plan, store: h.store,
    paritySetDigest: shadow.paritySetDigest, decisionRef: "review replay cutover", apply: true
  });

  const before = await runGuardCommand({
    args: ["status", "--task-id", "task-a"], repoRoot: h.repoRoot, store: h.store
  });
  const reviewCount = () => h.store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_events WHERE event_type='review_recorded'"
  ).get().count;
  const baselineCount = reviewCount();
  for (const event of [h.state.loops[h.fingerprintA].events[0], h.state.loops[h.fingerprintA].events[5]]) {
    await runGuardCommand({ args: reviewArgs(event), repoRoot: h.repoRoot, store: h.store });
    const after = await runGuardCommand({
      args: ["status", "--task-id", "task-a"], repoRoot: h.repoRoot, store: h.store
    });
    assert.deepEqual(after, before);
    assert.equal(reviewCount(), baselineCount);
  }
  await assert.rejects(
    runGuardCommand({
      args: reviewArgs(h.state.loops[h.fingerprintA].events[5], { commit: "changed-commit" }),
      repoRoot: h.repoRoot,
      store: h.store
    }),
    (error) => error.code === "event_collision"
  );
  const taskB = await runGuardCommand({
    args: ["status", "--task-id", "task-b"], repoRoot: h.repoRoot, store: h.store
  });
  assert.deepEqual(taskB.loops[0].seen_review_run_ids, []);
  assert.equal(reviewCount(), baselineCount);
});

test("unsupported legacy actions are bounded warnings and never guessed into Kernel history", async (t) => {
  const h = await migrationHarness();
  t.after(() => h.store.close());
  h.state.loops[h.fingerprintB].events.push({
    at: "2026-07-20T00:06:30Z", action: "future_guard_action",
    severity: null, verdict: null, commit: null, review_ref: null, receipt_id: null
  });
  await writeFile(h.stateFile, `${JSON.stringify(h.state)}\n`, { mode: 0o600 });
  const plan = await inspectGuardImport({ repoRoot: h.repoRoot, stateFile: h.stateFile, store: h.store });
  assert.deepEqual(plan.warnings, ["unsupported_legacy_events:1"]);
  const imported = await applyGuardImport({ plan, store: h.store });
  assert.equal(imported.eventCount, 7);
  assert.equal(h.store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_events WHERE event_type<>'legacy_imported'"
  ).get().count, 7);
});

test("import rejects corrupt, permissive, and symlinked legacy state without Store writes", async (t) => {
  const h = await migrationHarness();
  t.after(() => h.store.close());
  const original = await readFile(h.stateFile);
  const eventCount = () => h.store.database.prepare(
    "SELECT COUNT(*) AS count FROM convergence_events"
  ).get().count;

  await chmod(h.stateFile, 0o644);
  await assert.rejects(
    inspectGuardImport({ repoRoot: h.repoRoot, stateFile: h.stateFile, store: h.store }),
    (error) => error.code === "source_unsafe_mode"
  );
  await chmod(h.stateFile, 0o600);
  await writeFile(h.stateFile, "{broken-json\n", { mode: 0o600 });
  await assert.rejects(
    inspectGuardImport({ repoRoot: h.repoRoot, stateFile: h.stateFile, store: h.store }),
    (error) => error.code === "legacy_state_invalid"
  );

  const target = path.join(h.repoRoot, ".superpowers", "sdd", "outside-state.json");
  await writeFile(target, original, { mode: 0o600 });
  await unlink(h.stateFile);
  await symlink(target, h.stateFile);
  await assert.rejects(
    inspectGuardImport({ repoRoot: h.repoRoot, stateFile: h.stateFile, store: h.store }),
    (error) => error.code === "legacy_state_unsafe"
  );
  assert.equal(eventCount(), 0);
});

test("matching shadow parity cuts over once and rollback restores the exact immutable snapshot", async (t) => {
  const h = await migrationHarness();
  t.after(() => h.store.close());
  const original = await readFile(h.stateFile);
  const plan = await inspectGuardImport({ repoRoot: h.repoRoot, stateFile: h.stateFile, store: h.store });
  await applyGuardImport({ plan, store: h.store });
  const beforeCutover = await runGuardCommand({
    args: ["status", "--task-id", "task-a"], repoRoot: h.repoRoot, store: h.store
  });
  assert.equal(beforeCutover.authority, "legacy_guard");
  const shadow = await compareGuardShadow({ plan, store: h.store, comparisons: PASSING_COMPARISONS });
  assert.deepEqual({ matched: shadow.matched, comparisonCount: shadow.comparisonCount,
    mismatchCount: shadow.mismatchCount }, { matched: true, comparisonCount: 4, mismatchCount: 0 });
  await assert.rejects(cutoverGuard({
    repoRoot: h.repoRoot, stateFile: h.stateFile, plan, store: h.store,
    paritySetDigest: shadow.paritySetDigest, decisionRef: "approved task-7 cutover", apply: false
  }), (error) => error.code === "guard_apply_required");

  const cutover = await cutoverGuard({
    repoRoot: h.repoRoot, stateFile: h.stateFile, plan, store: h.store,
    paritySetDigest: shadow.paritySetDigest, decisionRef: "approved task-7 cutover", apply: true
  });
  assert.equal(cutover.authority, "afl_sqlite");
  assert.deepEqual(await readFile(h.stateFile), original);
  const snapshot = path.join(path.dirname(h.stateFile), ".review-loop-state.afl-cutover.snapshot");
  assert.deepEqual(await readFile(snapshot), original);
  assert.equal((await stat(snapshot)).mode & 0o777, 0o400);
  assert.equal(h.store.getGuardAuthority({ authorityTaskUid: plan.authorityTaskUid }).authority,
    "afl_sqlite");
  const afterCutover = await runGuardCommand({
    args: ["status", "--task-id", "task-a"], repoRoot: h.repoRoot, store: h.store
  });
  assert.equal(afterCutover.authority, "afl_sqlite");

  const rollback = await rollbackGuardCutover({
    repoRoot: h.repoRoot, stateFile: h.stateFile, store: h.store,
    authorityTaskUid: plan.authorityTaskUid, cutoverEventUid: cutover.cutoverEventUid,
    decisionRef: "approved task-7 rollback", apply: true
  });
  assert.equal(rollback.authority, "legacy_guard");
  assert.deepEqual(await readFile(h.stateFile), original);
  assert.equal(h.store.getGuardAuthority({ authorityTaskUid: plan.authorityTaskUid }).authority,
    "legacy_guard");
  const afterRollback = await runGuardCommand({
    args: ["status", "--task-id", "task-a"], repoRoot: h.repoRoot, store: h.store
  });
  assert.equal(afterRollback.authority, "legacy_guard");
});

test("shadow mismatch, source drift, and cutover Store failure all leave legacy authority", async (t) => {
  const mismatch = await migrationHarness();
  t.after(() => mismatch.store.close());
  const mismatchPlan = await inspectGuardImport({
    repoRoot: mismatch.repoRoot, stateFile: mismatch.stateFile, store: mismatch.store
  });
  await applyGuardImport({ plan: mismatchPlan, store: mismatch.store });
  const shadow = await compareGuardShadow({
    plan: mismatchPlan,
    store: mismatch.store,
    comparisons: PASSING_COMPARISONS.map((item) => item.field === "decision"
      ? { ...item, kernel: "finish" }
      : item)
  });
  assert.equal(shadow.matched, false);
  await assert.rejects(cutoverGuard({
    repoRoot: mismatch.repoRoot, stateFile: mismatch.stateFile, plan: mismatchPlan,
    store: mismatch.store, paritySetDigest: shadow.paritySetDigest,
    decisionRef: "must not cut over", apply: true
  }), (error) => error.code === "shadow_parity_incomplete");
  assert.equal(mismatch.store.getGuardAuthority({
    authorityTaskUid: mismatchPlan.authorityTaskUid
  }).authority, "legacy_guard");

  const drift = await migrationHarness();
  t.after(() => drift.store.close());
  const driftPlan = await inspectGuardImport({
    repoRoot: drift.repoRoot, stateFile: drift.stateFile, store: drift.store
  });
  await applyGuardImport({ plan: driftPlan, store: drift.store });
  const passing = await compareGuardShadow({
    plan: driftPlan, store: drift.store, comparisons: PASSING_COMPARISONS
  });
  await writeFile(drift.stateFile, `${JSON.stringify({ ...drift.state,
    updated_at: "2026-07-21T00:00:01Z" })}\n`, { mode: 0o600 });
  await assert.rejects(cutoverGuard({
    repoRoot: drift.repoRoot, stateFile: drift.stateFile, plan: driftPlan,
    store: drift.store, paritySetDigest: passing.paritySetDigest,
    decisionRef: "drift blocks cutover", apply: true
  }), (error) => error.code === "source_digest_changed");
  assert.equal(drift.store.getGuardAuthority({
    authorityTaskUid: driftPlan.authorityTaskUid
  }).authority, "legacy_guard");

  const failed = await migrationHarness();
  t.after(() => failed.store.close());
  const failedPlan = await inspectGuardImport({
    repoRoot: failed.repoRoot, stateFile: failed.stateFile, store: failed.store
  });
  await applyGuardImport({ plan: failedPlan, store: failed.store });
  const failedShadow = await compareGuardShadow({
    plan: failedPlan, store: failed.store, comparisons: PASSING_COMPARISONS
  });
  failed.store.database.exec(`CREATE TEMP TRIGGER abort_guard_cutover
    BEFORE INSERT ON convergence_events WHEN NEW.event_type='guard_cutover'
    BEGIN SELECT RAISE(ABORT, 'forced cutover abort'); END`);
  await assert.rejects(cutoverGuard({
    repoRoot: failed.repoRoot, stateFile: failed.stateFile, plan: failedPlan,
    store: failed.store, paritySetDigest: failedShadow.paritySetDigest,
    decisionRef: "injected failure", apply: true
  }), /forced cutover abort/u);
  assert.equal(failed.store.getGuardAuthority({
    authorityTaskUid: failedPlan.authorityTaskUid
  }).authority, "legacy_guard");
});

test("live legacy work, transition lock contention, and post-snapshot TOCTOU fail closed", async (t) => {
  const live = await migrationHarness();
  t.after(() => live.store.close());
  const liveLoop = live.state.loops[live.fingerprintA];
  liveLoop.active_receipt = {
    receipt_id: sha256("live-receipt"),
    mode: "local_fix",
    issued_at: "2026-07-20T00:05:30Z",
    consumed_at: null
  };
  await writeFile(live.stateFile, `${JSON.stringify(live.state)}\n`, { mode: 0o600 });
  const livePlan = await inspectGuardImport({
    repoRoot: live.repoRoot, stateFile: live.stateFile, store: live.store
  });
  await applyGuardImport({ plan: livePlan, store: live.store });
  const liveShadow = await compareGuardShadow({
    plan: livePlan, store: live.store, comparisons: PASSING_COMPARISONS
  });
  await assert.rejects(cutoverGuard({
    repoRoot: live.repoRoot, stateFile: live.stateFile, plan: livePlan, store: live.store,
    paritySetDigest: liveShadow.paritySetDigest, decisionRef: "live action must finish", apply: true
  }), (error) => error.code === "legacy_live_action");

  const locked = await migrationHarness();
  t.after(() => locked.store.close());
  const lockedPlan = await inspectGuardImport({
    repoRoot: locked.repoRoot, stateFile: locked.stateFile, store: locked.store
  });
  await applyGuardImport({ plan: lockedPlan, store: locked.store });
  const lockedShadow = await compareGuardShadow({
    plan: lockedPlan, store: locked.store, comparisons: PASSING_COMPARISONS
  });
  const lock = path.join(path.dirname(locked.stateFile), "review-loop-authority.lock");
  await mkdir(lock, { mode: 0o700 });
  await assert.rejects(cutoverGuard({
    repoRoot: locked.repoRoot, stateFile: locked.stateFile, plan: lockedPlan, store: locked.store,
    paritySetDigest: lockedShadow.paritySetDigest, decisionRef: "lock contention", apply: true
  }), (error) => error.code === "guard_authority_locked");

  const replaced = await migrationHarness();
  t.after(() => replaced.store.close());
  const replacedPlan = await inspectGuardImport({
    repoRoot: replaced.repoRoot, stateFile: replaced.stateFile, store: replaced.store
  });
  await applyGuardImport({ plan: replacedPlan, store: replaced.store });
  const replacedShadow = await compareGuardShadow({
    plan: replacedPlan, store: replaced.store, comparisons: PASSING_COMPARISONS
  });
  await assert.rejects(cutoverGuard({
    repoRoot: replaced.repoRoot, stateFile: replaced.stateFile, plan: replacedPlan,
    store: replaced.store, paritySetDigest: replacedShadow.paritySetDigest,
    decisionRef: "TOCTOU injection", apply: true,
    hooks: { async afterSnapshot() {
      await writeFile(replaced.stateFile, `${JSON.stringify({ ...replaced.state,
        updated_at: "2026-07-21T00:00:02Z" })}\n`, { mode: 0o600 });
    } }
  }), (error) => error.code === "source_digest_changed");
  assert.equal(replaced.store.getGuardAuthority({
    authorityTaskUid: replacedPlan.authorityTaskUid
  }).authority, "legacy_guard");
});

test("rollback rejects snapshot drift and keeps AFL authoritative", async (t) => {
  const h = await migrationHarness();
  t.after(() => h.store.close());
  const plan = await inspectGuardImport({ repoRoot: h.repoRoot, stateFile: h.stateFile, store: h.store });
  await applyGuardImport({ plan, store: h.store });
  const shadow = await compareGuardShadow({ plan, store: h.store, comparisons: PASSING_COMPARISONS });
  const cutover = await cutoverGuard({
    repoRoot: h.repoRoot, stateFile: h.stateFile, plan, store: h.store,
    paritySetDigest: shadow.paritySetDigest, decisionRef: "cutover before drift", apply: true
  });
  const snapshot = path.join(path.dirname(h.stateFile), ".review-loop-state.afl-cutover.snapshot");
  await chmod(snapshot, 0o600);
  await writeFile(snapshot, "snapshot drift\n", { mode: 0o600 });
  await chmod(snapshot, 0o400);
  await assert.rejects(rollbackGuardCutover({
    repoRoot: h.repoRoot, stateFile: h.stateFile, store: h.store,
    authorityTaskUid: plan.authorityTaskUid, cutoverEventUid: cutover.cutoverEventUid,
    decisionRef: "rollback must reject drift", apply: true
  }), (error) => error.code === "snapshot_digest_changed");
  assert.equal(h.store.getGuardAuthority({ authorityTaskUid: plan.authorityTaskUid }).authority,
    "afl_sqlite");
});

test("rollback atomically replaces a safe differing target from the exact snapshot", async (t) => {
  const h = await migrationHarness();
  t.after(() => h.store.close());
  const original = await readFile(h.stateFile);
  const plan = await inspectGuardImport({ repoRoot: h.repoRoot, stateFile: h.stateFile, store: h.store });
  await applyGuardImport({ plan, store: h.store });
  const shadow = await compareGuardShadow({ plan, store: h.store, comparisons: PASSING_COMPARISONS });
  const cutover = await cutoverGuard({
    repoRoot: h.repoRoot, stateFile: h.stateFile, plan, store: h.store,
    paritySetDigest: shadow.paritySetDigest, decisionRef: "cutover before safe drift", apply: true
  });
  await writeFile(h.stateFile, `${JSON.stringify({ ...h.state,
    updated_at: "2026-07-21T00:00:01Z" })}\n`, { mode: 0o600 });

  const rollback = await rollbackGuardCutover({
    repoRoot: h.repoRoot, stateFile: h.stateFile, store: h.store,
    authorityTaskUid: plan.authorityTaskUid, cutoverEventUid: cutover.cutoverEventUid,
    decisionRef: "restore exact snapshot", apply: true
  });

  assert.equal(rollback.authority, "legacy_guard");
  assert.deepEqual(await readFile(h.stateFile), original);
});

test("rollback Store failure is retryable after restoration while AFL remains authoritative", async (t) => {
  const h = await migrationHarness();
  t.after(() => h.store.close());
  const original = await readFile(h.stateFile);
  const plan = await inspectGuardImport({ repoRoot: h.repoRoot, stateFile: h.stateFile, store: h.store });
  await applyGuardImport({ plan, store: h.store });
  const shadow = await compareGuardShadow({ plan, store: h.store, comparisons: PASSING_COMPARISONS });
  const cutover = await cutoverGuard({
    repoRoot: h.repoRoot, stateFile: h.stateFile, plan, store: h.store,
    paritySetDigest: shadow.paritySetDigest, decisionRef: "cutover before retry", apply: true
  });
  await writeFile(h.stateFile, `${JSON.stringify({ ...h.state,
    updated_at: "2026-07-21T00:00:02Z" })}\n`, { mode: 0o600 });
  h.store.database.exec(`CREATE TEMP TRIGGER abort_guard_rollback
    BEFORE INSERT ON convergence_events WHEN NEW.event_type='guard_rollback'
    BEGIN SELECT RAISE(ABORT, 'forced rollback abort'); END`);
  const rollbackInput = {
    repoRoot: h.repoRoot, stateFile: h.stateFile, store: h.store,
    authorityTaskUid: plan.authorityTaskUid, cutoverEventUid: cutover.cutoverEventUid,
    decisionRef: "retry exact rollback", apply: true
  };
  await assert.rejects(rollbackGuardCutover(rollbackInput), /forced rollback abort/u);
  assert.deepEqual(await readFile(h.stateFile), original);
  assert.equal(h.store.getGuardAuthority({ authorityTaskUid: plan.authorityTaskUid }).authority,
    "afl_sqlite");
  h.store.database.exec("DROP TRIGGER abort_guard_rollback");
  assert.equal((await rollbackGuardCutover(rollbackInput)).authority, "legacy_guard");
});

test("rollback rejects target safety violations and exact-snapshot inode replacement", async (t) => {
  const unsafe = await migrationHarness();
  t.after(() => unsafe.store.close());
  const unsafePlan = await inspectGuardImport({
    repoRoot: unsafe.repoRoot, stateFile: unsafe.stateFile, store: unsafe.store
  });
  await applyGuardImport({ plan: unsafePlan, store: unsafe.store });
  const unsafeShadow = await compareGuardShadow({
    plan: unsafePlan, store: unsafe.store, comparisons: PASSING_COMPARISONS
  });
  const unsafeCutover = await cutoverGuard({
    repoRoot: unsafe.repoRoot, stateFile: unsafe.stateFile, plan: unsafePlan, store: unsafe.store,
    paritySetDigest: unsafeShadow.paritySetDigest, decisionRef: "unsafe target cutover", apply: true
  });
  await chmod(unsafe.stateFile, 0o644);
  await assert.rejects(rollbackGuardCutover({
    repoRoot: unsafe.repoRoot, stateFile: unsafe.stateFile, store: unsafe.store,
    authorityTaskUid: unsafePlan.authorityTaskUid, cutoverEventUid: unsafeCutover.cutoverEventUid,
    decisionRef: "unsafe target rollback", apply: true
  }), (error) => error.code === "source_unsafe_mode");
  assert.equal(unsafe.store.getGuardAuthority({
    authorityTaskUid: unsafePlan.authorityTaskUid
  }).authority, "afl_sqlite");

  const replaced = await migrationHarness();
  t.after(() => replaced.store.close());
  const replacedPlan = await inspectGuardImport({
    repoRoot: replaced.repoRoot, stateFile: replaced.stateFile, store: replaced.store
  });
  await applyGuardImport({ plan: replacedPlan, store: replaced.store });
  const replacedShadow = await compareGuardShadow({
    plan: replacedPlan, store: replaced.store, comparisons: PASSING_COMPARISONS
  });
  const replacedCutover = await cutoverGuard({
    repoRoot: replaced.repoRoot, stateFile: replaced.stateFile, plan: replacedPlan, store: replaced.store,
    paritySetDigest: replacedShadow.paritySetDigest, decisionRef: "snapshot inode cutover", apply: true
  });
  const snapshot = path.join(path.dirname(replaced.stateFile), ".review-loop-state.afl-cutover.snapshot");
  const snapshotBytes = await readFile(snapshot);
  await unlink(snapshot);
  await writeFile(snapshot, snapshotBytes, { mode: 0o400 });
  await chmod(snapshot, 0o400);
  await assert.rejects(rollbackGuardCutover({
    repoRoot: replaced.repoRoot, stateFile: replaced.stateFile, store: replaced.store,
    authorityTaskUid: replacedPlan.authorityTaskUid,
    cutoverEventUid: replacedCutover.cutoverEventUid,
    decisionRef: "snapshot inode rollback", apply: true
  }), (error) => error.code === "snapshot_identity_changed");
  assert.equal(replaced.store.getGuardAuthority({
    authorityTaskUid: replacedPlan.authorityTaskUid
  }).authority, "afl_sqlite");
});

test("shadow rejects unsupported decision and action values before authority can change", async (t) => {
  const h = await migrationHarness();
  t.after(() => h.store.close());
  const plan = await inspectGuardImport({ repoRoot: h.repoRoot, stateFile: h.stateFile, store: h.store });
  await applyGuardImport({ plan, store: h.store });

  await assert.rejects(compareGuardShadow({
    plan,
    store: h.store,
    comparisons: PASSING_COMPARISONS.map((item) => item.field === "decision"
      ? { ...item, legacy: "not-a-guard-decision", kernel: "not-a-guard-decision" }
      : item)
  }), (error) => error.code === "shadow_input_invalid");
  await assert.rejects(compareGuardShadow({
    plan,
    store: h.store,
    comparisons: PASSING_COMPARISONS.map((item) => item.field === "next_required_action"
      ? { ...item, legacy: "not-a-next-action", kernel: "not-a-next-action" }
      : item)
  }), (error) => error.code === "shadow_input_invalid");
  assert.equal(h.store.getGuardAuthority({ authorityTaskUid: plan.authorityTaskUid }).authority,
    "legacy_guard");
});

test("Guard migration CLI exposes strict dry-run, apply, shadow, cutover, and rollback commands", async (t) => {
  const dry = await migrationHarness();
  t.after(() => dry.store.close());
  const before = await readFile(dry.stateFile);
  const dryRun = await executeGuardCli([
    "import", "--repo-root", dry.repoRoot, "--state-file", dry.stateFile, "--dry-run"
  ]);
  assert.equal(dryRun.exitCode, 0);
  assert.equal(dryRun.payload.status, "dry_run");
  assert.equal(JSON.stringify(dryRun.payload).includes(dry.repoRoot), false);
  assert.deepEqual(await readFile(dry.stateFile), before);

  const h = await migrationHarness();
  h.store.close();
  const common = ["--repo-root", h.repoRoot, "--home", h.home, "--state-file", h.stateFile];
  const imported = await executeGuardCli(["import", ...common, "--apply"]);
  assert.equal(imported.payload.status, "applied");
  const shadow = await executeGuardCli([
    "shadow", ...common,
    "--legacy-decision", "direction_review_required", "--kernel-decision", "checkpoint_required",
    "--legacy-action", "direction_review", "--kernel-action", "checkpoint",
    "--legacy-generation", "2", "--kernel-generation", "2",
    "--legacy-eligible", "false", "--kernel-eligible", "false"
  ]);
  assert.equal(shadow.payload.matched, true);
  const refused = await executeGuardCli([
    "cutover", ...common, "--parity-set-digest", shadow.payload.paritySetDigest,
    "--decision-ref", "missing apply"
  ]);
  assert.equal(refused.stderrCode, "guard_apply_required");
  const cutover = await executeGuardCli([
    "cutover", ...common, "--parity-set-digest", shadow.payload.paritySetDigest,
    "--decision-ref", "cli cutover", "--apply"
  ]);
  assert.equal(cutover.payload.authority, "afl_sqlite");
  const rollback = await executeGuardCli([
    "rollback", ...common, "--authority-task-uid", imported.payload.authorityTaskUid,
    "--cutover-event-uid", cutover.payload.cutoverEventUid,
    "--decision-ref", "cli rollback", "--apply"
  ]);
  assert.equal(rollback.payload.authority, "legacy_guard");
});
