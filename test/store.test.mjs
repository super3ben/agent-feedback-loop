import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { pathsFor } from "../src/index.mjs";
import { containsReceiptMarker, detectReceiptLanguage, receiptNonce, validateReceiptPayload } from "../src/receipt.mjs";
import { selectLessons } from "../src/selector.mjs";
import { CapturePolicyError, LeaseConflictError, RevisionConflictError, openStore } from "../src/store.mjs";

async function storeFixture() {
  const home = await mkdtemp(path.join(tmpdir(), "afl-store-"));
  const paths = pathsFor(home);
  await mkdir(paths.dataRoot, { recursive: true, mode: 0o700 });
  return openStore({ paths });
}

function event(id, revision = 1) {
  return {
    event_uid: id,
    session_uid: "codex:install:session",
    event_seq: 1,
    context_epoch: 1,
    project_id: "project-a",
    source_event_id: id,
    role: "user",
    redacted_text: "user feedback",
    content_hash: `hash-${id}`,
    capture_policy_revision: revision,
    data_class: "normal"
  };
}

test("schema v8 migrates and deduplicates semantic notifications", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-notification-schema-"));
  const paths = pathsFor(home);
  const store = openStore({ paths });
  const captured = {
    event_uid: "notification-event",
    event_seq: 1,
    context_epoch: 1,
    project_id: "project-notification",
    session_uid: "codex:install:session-notification",
    source_event_id: "notification-event",
    role: "user",
    redacted_text: "user feedback",
    content_hash: "hash-notification-event",
    capture_policy_revision: 1,
    data_class: "normal"
  };
  store.captureSessionEvent(captured);
  const input = {
    sessionUid: captured.session_uid,
    contextEpoch: 1,
    kind: "candidate_captured",
    eventUid: captured.event_uid,
    payload: {},
    language: "en"
  };
  const first = store.createNotification(input);
  const second = store.createNotification(input);
  assert.throws(
    () => store.createNotification(Object.assign({}, input, { kind: "review_queued", payload: { prompt: "must-not-persist" } })),
    /forbidden key/
  );
  assert.equal(first.notification_id, second.notification_id);
  assert.equal(store.listNotifications({ sessionUid: captured.session_uid }).length, 1);
  assert.equal(store.capability.schemaVersion, 8);
  store.close();
  const reopened = openStore({ paths });
  assert.equal(reopened.listNotifications({ sessionUid: captured.session_uid }).length, 1);
  reopened.close();
});

test("receipt payload validation and markers reject unbounded content", () => {
  const payload = validateReceiptPayload("review_completed", { severity: "Critical", lesson_count: 2 });
  assert.deepEqual(payload, { severity: "Critical", lesson_count: 2 });
  assert.equal(Object.isFrozen(payload), true);
  assert.throws(() => validateReceiptPayload("review_completed", { severity: "High", lesson_count: 2 }), /severity/);
  assert.throws(() => validateReceiptPayload("review_exhausted", { reason_code: "BAD-REASON" }), /reason_code/);
  assert.equal(detectReceiptLanguage("需要复核"), "zh");
  assert.equal(detectReceiptLanguage("review complete"), "en");
  const notification = { notification_id: "notification-1", kind: "review_completed" };
  const marker = `<!--afl-receipt id=notification-1 nonce=${receiptNonce("notification-1")} state=review_completed-->`;
  assert.equal(containsReceiptMarker(marker, notification), true);
  assert.equal(containsReceiptMarker(marker, { ...notification, notification_id: "notification-2" }), false);
});

test("schema v8 reopens a realistic v7 store idempotently with valid foreign keys", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-notification-migrate-"));
  const paths = pathsFor(home);
  const seeded = openStore({ paths });
  const captured = { ...event("legacy-event"), session_uid: "codex:install:legacy-session", project_id: "legacy-project" };
  seeded.captureSessionEvent(captured);
  const job = seeded.submitDueReview({ projectId: captured.project_id, minEntries: 1, cooldownMs: 0 });
  seeded.recordDelivery({
    application_id: "legacy-application",
    lesson_id: "legacy-lesson",
    revision: 1,
    session_uid: captured.session_uid,
    context_epoch: 1,
    state: "emitted"
  });
  seeded.close();

  const legacy = new DatabaseSync(paths.storeFile);
  legacy.exec(`
    PRAGMA foreign_keys=OFF;
    DROP TABLE notification_outbox;
    DROP TABLE reviewer_job_events;
    ALTER TABLE reviewer_jobs DROP COLUMN reviewer_provider;
    DELETE FROM schema_migrations WHERE version=8;
    INSERT OR IGNORE INTO schema_migrations VALUES (7, '2026-07-14T00:00:00.000Z');
    PRAGMA foreign_keys=ON;
  `);
  legacy.close();

  const migrated = openStore({ paths });
  assert.equal(migrated.capability.schemaVersion, 8);
  assert.equal(migrated.listSessionEvents("legacy-project")[0].event_uid, captured.event_uid);
  assert.equal(migrated.getReviewerJob(job.job_id).job_id, job.job_id);
  assert.equal(migrated.hasDelivery("legacy-application"), true);
  migrated.close();

  const reopened = openStore({ paths });
  assert.equal(reopened.capability.schemaVersion, 8);
  reopened.close();

  const verify = new DatabaseSync(paths.storeFile);
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=8").get().count, 1);
  const notificationColumns = verify.prepare("PRAGMA table_info(notification_outbox)").all().map((row) => row.name);
  assert.equal(notificationColumns.includes("semantic_key"), true);
  assert.equal(notificationColumns.includes("system_lease_epoch"), true);
  assert.deepEqual(verify.prepare("PRAGMA foreign_key_check").all(), []);
  verify.close();
});

test("schema v8 upgrades a pre-fence v8 outbox without losing notifications", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-notification-v8-reopen-"));
  const paths = pathsFor(home);
  const seeded = openStore({ paths });
  const captured = { ...event("pre-fence-v8-event"), session_uid: "pre-fence-v8-session", project_id: "pre-fence-v8-project" };
  seeded.captureSessionEvent(captured);
  seeded.submitReviewerJob({ job_id: "pre-fence-v8-job", project_id: captured.project_id, prompt_version: "v1" });
  const original = seeded.createNotification({
    sessionUid: captured.session_uid,
    contextEpoch: 1,
    kind: "reviewed_no_lesson",
    jobId: "pre-fence-v8-job",
    payload: {},
    language: "en"
  });
  seeded.close();

  const preFence = new DatabaseSync(paths.storeFile);
  preFence.exec(`
    DROP INDEX notification_outbox_semantic_idx;
    ALTER TABLE notification_outbox DROP COLUMN system_lease_epoch;
    ALTER TABLE notification_outbox DROP COLUMN semantic_key;
    CREATE UNIQUE INDEX notification_outbox_semantic_idx
      ON notification_outbox(
        session_uid, context_epoch, kind,
        IFNULL(job_id, ''), IFNULL(event_uid, ''), IFNULL(application_id, '')
      );
  `);
  preFence.close();

  const migrated = openStore({ paths });
  const preserved = migrated.listNotifications({ jobId: "pre-fence-v8-job" });
  assert.equal(preserved.length, 1);
  assert.equal(preserved[0].notification_id, original.notification_id);
  const [claim] = migrated.claimSystemNotifications({ ownerId: "pre-fence-owner", nowMs: 1_000, leaseMs: 30_000, limit: 1 });
  assert.equal(claim.system_lease_epoch, 1);
  assert.equal(migrated.completeSystemNotification({
    notificationId: claim.notification_id,
    ownerId: "pre-fence-owner",
    leaseEpoch: claim.system_lease_epoch
  }), true);
  migrated.close();

  const verify = new DatabaseSync(paths.storeFile);
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=8").get().count, 1);
  assert.deepEqual(verify.prepare("PRAGMA foreign_key_check").all(), []);
  verify.close();
});

test("chat claim and confirm fence one native turn", async () => {
  const store = await storeFixture();
  const captured = event("chat-notification");
  store.captureSessionEvent(captured);
  const notification = store.createNotification({
    sessionUid: captured.session_uid,
    contextEpoch: 1,
    kind: "candidate_captured",
    eventUid: captured.event_uid,
    payload: {},
    language: "en"
  });
  const claimed = store.claimChatNotification({ sessionUid: captured.session_uid, contextEpoch: 1, nativeTurnId: "turn-2" });
  assert.equal(claimed.chat_state, "emitted");
  assert.equal(claimed.chat_emit_attempts, 1);
  assert.equal(store.claimChatNotification({ sessionUid: captured.session_uid, contextEpoch: 1, nativeTurnId: "turn-2" }), null);

  const firstStop = store.confirmChatNotification({
    sessionUid: captured.session_uid,
    contextEpoch: 1,
    nativeTurnId: "turn-2",
    transcriptText: "assistant text without marker"
  });
  assert.equal(firstStop.action, "block");
  const secondStop = store.confirmChatNotification({
    sessionUid: captured.session_uid,
    contextEpoch: 1,
    nativeTurnId: "turn-2",
    transcriptText: "assistant text without marker"
  });
  assert.equal(secondStop.action, "pass_unconfirmed");
  assert.equal(store.listNotifications({ sessionUid: captured.session_uid })[0].chat_state, "emitted_unconfirmed");

  const retry = store.claimChatNotification({ sessionUid: captured.session_uid, contextEpoch: 1, nativeTurnId: "turn-3" });
  assert.equal(retry.chat_emit_attempts, 2);
  const observed = store.confirmChatNotification({
    sessionUid: captured.session_uid,
    contextEpoch: 1,
    nativeTurnId: "turn-3",
    transcriptText: `<!--afl-receipt id=${notification.notification_id} nonce=${receiptNonce(notification.notification_id)} state=${notification.kind}-->`
  });
  assert.equal(observed.action, "observed");
  assert.equal(observed.notification.chat_state, "observed");
  const later = { ...event("chat-notification-later"), event_seq: 2, source_event_id: "chat-notification-later" };
  store.captureSessionEvent(later);
  store.createNotification({ sessionUid: later.session_uid, contextEpoch: 1, kind: "candidate_captured", eventUid: later.event_uid, payload: {}, language: "en" });
  assert.equal(store.claimChatNotification({ sessionUid: captured.session_uid, contextEpoch: 1, nativeTurnId: "turn-3" }), null);
  assert.equal(store.claimChatNotification({ sessionUid: captured.session_uid, contextEpoch: 1, nativeTurnId: "turn-4" }).notification_id.length, 64);
  store.close();
});

test("terminal chat suppression is scoped to the matching reviewer job", async () => {
  const store = await storeFixture();
  const first = event("scope-first");
  const second = { ...event("scope-second"), event_seq: 2, source_event_id: "scope-second" };
  store.captureSessionEvent(first);
  store.captureSessionEvent(second);
  store.submitReviewerJob({ job_id: "scope-job-1", project_id: first.project_id, prompt_version: "v1" });
  store.submitReviewerJob({ job_id: "scope-job-2", project_id: first.project_id, prompt_version: "v1" });
  store.createNotification({ sessionUid: first.session_uid, contextEpoch: 1, kind: "candidate_captured", eventUid: first.event_uid, payload: {}, language: "en" });
  store.createNotification({ sessionUid: first.session_uid, contextEpoch: 1, kind: "review_queued", jobId: "scope-job-1", eventUid: first.event_uid, payload: {}, language: "en" });
  store.createNotification({ sessionUid: second.session_uid, contextEpoch: 1, kind: "review_queued", jobId: "scope-job-2", eventUid: second.event_uid, payload: {}, language: "en" });
  store.createNotification({ sessionUid: second.session_uid, contextEpoch: 1, kind: "candidate_captured", eventUid: second.event_uid, payload: {}, language: "en" });
  store.createNotification({ sessionUid: first.session_uid, contextEpoch: 1, kind: "review_completed", jobId: "scope-job-1", payload: { severity: "Major", lesson_count: 1 }, language: "en" });
  const rows = store.listNotifications({ sessionUid: first.session_uid });
  assert.equal(rows.find((row) => row.event_uid === second.event_uid && row.kind === "candidate_captured").chat_state, "pending");
  assert.equal(rows.find((row) => row.job_id === "scope-job-2" && row.kind === "review_queued").chat_state, "pending");
  store.close();
});

test("system lease expires and owner-fenced transitions persist", async () => {
  const store = await storeFixture();
  const captured = event("system-notification");
  store.captureSessionEvent(captured);
  store.submitReviewerJob({ job_id: "job-system", project_id: captured.project_id, prompt_version: "v1" });
  const notification = store.createNotification({
    sessionUid: captured.session_uid,
    contextEpoch: 1,
    kind: "reviewed_no_lesson",
    jobId: "job-system",
    payload: {},
    language: "en"
  });
  const leased = store.claimSystemNotifications({ ownerId: "notifier-a", nowMs: 1_000, leaseMs: 30_000, limit: 8 });
  assert.equal(leased.length, 1);
  assert.equal(store.claimSystemNotifications({ ownerId: "notifier-b", nowMs: 2_000, leaseMs: 30_000, limit: 8 }).length, 0);
  const reclaimed = store.claimSystemNotifications({ ownerId: "notifier-b", nowMs: 31_001, leaseMs: 30_000, limit: 8 });
  assert.equal(reclaimed.length, 1);
  assert.equal(store.completeSystemNotification({ notificationId: notification.notification_id, ownerId: "notifier-a", leaseEpoch: leased[0].system_lease_epoch, deliveredAt: "2026-07-15T00:00:00.000Z" }), false);
  assert.equal(store.failSystemNotification({ notificationId: notification.notification_id, ownerId: "notifier-b", leaseEpoch: reclaimed[0].system_lease_epoch, reasonCode: "transport_error", nowMs: 31_002 }), true);
  assert.equal(store.listNotifications({ jobId: "job-system" })[0].next_attempt_at, 151_002);
  assert.equal(store.claimSystemNotifications({ ownerId: "notifier-c", nowMs: 151_001, leaseMs: 30_000, limit: 8 }).length, 0);
  const finalLease = store.claimSystemNotifications({ ownerId: "notifier-c", nowMs: 151_002, leaseMs: 30_000, limit: 8 });
  assert.equal(finalLease.length, 1);
  assert.equal(store.markSystemNotificationUnsupported({ notificationId: notification.notification_id, ownerId: "notifier-c", leaseEpoch: finalLease[0].system_lease_epoch, reasonCode: "unsupported_platform" }), true);
  assert.equal(store.listNotifications({ jobId: "job-system" })[0].system_state, "unsupported");
  store.close();
});

test("system lease epoch fences stale transitions when the same owner reclaims", async () => {
  const store = await storeFixture();
  const captured = event("same-owner-system-lease");
  store.captureSessionEvent(captured);
  store.submitReviewerJob({ job_id: "same-owner-system-job", project_id: captured.project_id, prompt_version: "v1" });
  const notifications = [
    store.createNotification({ sessionUid: captured.session_uid, contextEpoch: 1, kind: "review_completed", jobId: "same-owner-system-job", payload: { severity: "Major", lesson_count: 1 }, language: "en" }),
    store.createNotification({ sessionUid: captured.session_uid, contextEpoch: 1, kind: "reviewed_no_lesson", jobId: "same-owner-system-job", payload: {}, language: "en" }),
    store.createNotification({ sessionUid: captured.session_uid, contextEpoch: 1, kind: "review_exhausted", jobId: "same-owner-system-job", payload: { reason_code: "reviewer_failed" }, language: "en" })
  ];
  const first = store.claimSystemNotifications({ ownerId: "reused-owner", nowMs: 1_000, leaseMs: 30_000, limit: 8 });
  const second = store.claimSystemNotifications({ ownerId: "reused-owner", nowMs: 31_001, leaseMs: 30_000, limit: 8 });
  const firstById = new Map(first.map((row) => [row.notification_id, row]));
  const secondById = new Map(second.map((row) => [row.notification_id, row]));
  assert.equal(first.length, 3);
  assert.equal(second.length, 3);
  for (const notification of notifications) {
    assert.equal(secondById.get(notification.notification_id).system_lease_epoch, firstById.get(notification.notification_id).system_lease_epoch + 1);
  }

  const [completion, failure, unsupported] = notifications;
  assert.equal(store.completeSystemNotification({ notificationId: completion.notification_id, ownerId: "reused-owner", leaseEpoch: firstById.get(completion.notification_id).system_lease_epoch }), false);
  assert.equal(store.failSystemNotification({ notificationId: failure.notification_id, ownerId: "reused-owner", leaseEpoch: firstById.get(failure.notification_id).system_lease_epoch, reasonCode: "transport_error", nowMs: 31_002 }), false);
  assert.equal(store.markSystemNotificationUnsupported({ notificationId: unsupported.notification_id, ownerId: "reused-owner", leaseEpoch: firstById.get(unsupported.notification_id).system_lease_epoch, reasonCode: "unsupported_platform" }), false);

  assert.equal(store.completeSystemNotification({ notificationId: completion.notification_id, ownerId: "reused-owner", leaseEpoch: secondById.get(completion.notification_id).system_lease_epoch }), true);
  assert.equal(store.failSystemNotification({ notificationId: failure.notification_id, ownerId: "reused-owner", leaseEpoch: secondById.get(failure.notification_id).system_lease_epoch, reasonCode: "transport_error", nowMs: 31_002 }), true);
  assert.equal(store.markSystemNotificationUnsupported({ notificationId: unsupported.notification_id, ownerId: "reused-owner", leaseEpoch: secondById.get(unsupported.notification_id).system_lease_epoch, reasonCode: "unsupported_platform" }), true);
  store.close();
});

test("disabled receipt channels suppress rather than replay pending rows", async () => {
  const store = await storeFixture();
  const captured = {
    event_uid: "disabled-event",
    session_uid: "codex:install:disabled-session",
    event_seq: 1,
    context_epoch: 1,
    project_id: "disabled-project",
    source_event_id: "disabled-event",
    role: "user",
    redacted_text: "feedback candidate",
    content_hash: "hash-disabled-event",
    capture_policy_revision: 1,
    data_class: "normal"
  };
  store.captureSessionEvent(captured);
  store.createNotification({ sessionUid: captured.session_uid, contextEpoch: 1, kind: "candidate_captured", eventUid: captured.event_uid, payload: {}, language: "en" });
  assert.equal(store.suppressPendingChatNotifications({ sessionUid: captured.session_uid, contextEpoch: 1 }), 1);

  store.submitReviewerJob({ job_id: "job-system-suppressed", project_id: captured.project_id, prompt_version: "v1" });
  store.createNotification({ sessionUid: captured.session_uid, contextEpoch: 1, kind: "reviewed_no_lesson", jobId: "job-system-suppressed", payload: {}, language: "en" });
  assert.equal(store.suppressDueSystemNotifications({ nowMs: 31_001, reasonCode: "disabled_by_config" }), 1);
  assert.deepEqual(store.listNotifications({ sessionUid: captured.session_uid }).map((row) => row.system_state).sort(), ["not_applicable", "suppressed"]);
  store.close();
});

test("store creates transactional schema and rejects duplicate source events", async () => {
  const store = await storeFixture();
  await store.captureSessionEvent(event("event-1"));
  assert.throws(() => store.captureSessionEvent(event("event-1")), /UNIQUE|constraint/i);
  const rows = store.listSessionEvents("project-a");
  assert.equal(rows.length, 1);
  assert.equal((await stat(path.dirname(store.path || ""))).mode & 0o777, 0o700);
  store.close();
});

test("openStore waits for a short concurrent writer instead of failing", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-store-busy-"));
  const paths = pathsFor(home);
  const initialized = openStore({ paths });
  initialized.close();

  const holder = spawn(process.execPath, ["-e", `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.env.AFL_TEST_STORE);
    db.exec("BEGIN IMMEDIATE");
    process.stdout.write("locked\\n");
    setTimeout(() => {
      db.exec("COMMIT");
      db.close();
    }, 300);
  `], {
    env: { ...process.env, AFL_TEST_STORE: paths.storeFile },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const exitPromise = once(holder, "exit");
  const [ready] = await once(holder.stdout, "data");
  assert.match(String(ready), /locked/);

  const startedAt = Date.now();
  const reopened = openStore({ paths });
  const elapsedMs = Date.now() - startedAt;
  reopened.close();

  const [exitCode] = await exitPromise;
  assert.equal(exitCode, 0);
  assert.ok(elapsedMs >= 150, `expected openStore to wait for the writer, waited ${elapsedMs}ms`);
});

test("capture policy revision is checked inside the write transaction", async () => {
  const store = await storeFixture();
  store.setCapturePolicy({ enabled: false, revision: 2 });
  assert.throws(() => store.captureSessionEvent(event("event-off", 1)), CapturePolicyError);
  store.close();
});

test("lesson revisions use compare-and-swap", async () => {
  const store = await storeFixture();
  const first = store.upsertLessonRevision({ lesson_id: "lesson-1", revision: 1, card_json: "{}" }, 0);
  assert.equal(first.revision, 1);
  assert.throws(
    () => store.upsertLessonRevision({ lesson_id: "lesson-1", revision: 2, card_json: "{}" }, 0),
    RevisionConflictError
  );
  store.close();
});

test("reviewer leases fence stale workers", async () => {
  const store = await storeFixture();
  store.submitReviewerJob({ job_id: "job-1", project_id: "project-a", prompt_version: "v1" });
  const first = store.claimReviewerJob("job-1", "worker-a", Date.now() + 100_000, 1);
  assert.equal(first.lease_epoch, 1);
  assert.throws(() => store.claimReviewerJob("job-1", "worker-b", Date.now() + 100_000, 1), LeaseConflictError);
  assert.throws(() => store.completeReviewerJob("job-1", "worker-b", 1, first.lease_epoch, "receipt"), LeaseConflictError);
  store.close();
});

test("store rejects a symlink database path", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-symlink-"));
  const paths = pathsFor(home);
  await mkdir(path.dirname(paths.storeFile), { recursive: true });
  await symlink("/tmp/not-the-store", paths.storeFile);
  assert.throws(() => openStore({ paths }), /symlink/i);
});

test("store rejects a symlink data root", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-data-root-symlink-"));
  const outside = await mkdtemp(path.join(tmpdir(), "afl-data-root-outside-"));
  const paths = pathsFor(home);
  await mkdir(path.dirname(paths.dataRoot), { recursive: true });
  await symlink(outside, paths.dataRoot);
  assert.throws(() => openStore({ paths }), /data root.*symlink/i);
});

test("expired reviewer leases cannot complete", async () => {
  const store = await storeFixture();
  store.submitReviewerJob({ job_id: "job-expired", project_id: "project-a", prompt_version: "v1" });
  const lease = store.claimReviewerJob("job-expired", "worker-a", Date.now() - 1, 1);
  assert.throws(() => store.completeReviewerJob("job-expired", "worker-a", 1, lease.lease_epoch, "receipt"), LeaseConflictError);
  store.close();
});

test("captured events become one due reviewer job without clearing pending evidence", async () => {
  const store = await storeFixture();
  for (const id of ["due-1", "due-2", "due-3"]) {
    store.captureSessionEvent({ ...event(id), project_id: "project-due", session_uid: `codex:install:${id}`, source_event_id: id });
  }
  const first = store.submitDueReview({ projectId: "project-due", minEntries: 3, cooldownMs: 0, promptVersion: "v1" });
  assert.equal(first.status, "pending");
  assert.equal(first.eventCount, 3);
  const second = store.submitDueReview({ projectId: "project-due", minEntries: 3, cooldownMs: 0, promptVersion: "v1" });
  assert.equal(second.job_id, first.job_id);
  assert.equal(store.pendingReviewEventCount("project-due"), 3);
  store.close();
});

test("an immediate event replaces stale bounded evidence in an unprompted pending job", async () => {
  const store = await storeFixture();
  store.captureSessionEvent({ ...event("old-pending"), project_id: "project-immediate", session_uid: "immediate-session", event_seq: 1 });
  const existing = store.submitDueReview({ projectId: "project-immediate", minEntries: 1, maxEntries: 1, cooldownMs: 0 });
  store.captureSessionEvent({ ...event("current-correction"), project_id: "project-immediate", session_uid: "immediate-session", event_seq: 2 });

  const immediate = store.submitDueReview({
    projectId: "project-immediate",
    minEntries: 99,
    maxEntries: 1,
    cooldownMs: 3_600_000,
    immediateEventUid: "current-correction"
  });

  assert.equal(immediate.job_id, existing.job_id);
  assert.equal(immediate.immediate, true);
  assert.deepEqual(store.getReviewerContext(immediate.job_id).queued_event_ids, ["current-correction"]);
  assert.equal(store.pendingReviewEventCount("project-immediate"), 2);
  store.close();
});

test("bounded immediate replacement suppresses stale queue state and routes terminal state to the current session", async () => {
  const store = await storeFixture();
  const first = { ...event("displaced-first"), project_id: "project-displacement", session_uid: "displaced-session", redacted_text: "first correction" };
  const second = { ...event("displaced-second"), project_id: "project-displacement", session_uid: "current-session", redacted_text: "second correction" };
  store.captureSessionEvent(first);
  const existing = store.submitDueReview({ projectId: first.project_id, minEntries: 1, maxEntries: 1, cooldownMs: 0, immediateEventUid: first.event_uid });
  store.captureSessionEvent(second);
  const replacement = store.submitDueReview({ projectId: second.project_id, minEntries: 99, maxEntries: 1, cooldownMs: 3_600_000, immediateEventUid: second.event_uid });
  assert.equal(replacement.job_id, existing.job_id);
  assert.deepEqual(store.getReviewerContext(existing.job_id).queued_event_ids, [second.event_uid]);

  const staleQueue = store.listNotifications({ sessionUid: first.session_uid }).find((row) => row.kind === "review_queued");
  assert.equal(staleQueue.chat_state, "suppressed");

  const lease = store.claimReviewerJob(existing.job_id, "displacement-reviewer", Date.now() + 100_000, 1);
  store.failReviewerJob(existing.job_id, "displacement-reviewer", 1, lease.lease_epoch, false, "reviewer_failed");
  assert.equal(store.listNotifications({ sessionUid: first.session_uid }).some((row) => row.kind === "review_exhausted"), false);
  assert.equal(store.listNotifications({ sessionUid: second.session_uid }).some((row) => row.kind === "review_exhausted"), true);
  store.close();
});

test("an immediate event creates a fresh job when the prior pending job was already prompted", async () => {
  const store = await storeFixture();
  store.captureSessionEvent({ ...event("prompted-old"), project_id: "project-prompted", session_uid: "prompted-session", event_seq: 1 });
  const existing = store.submitDueReview({ projectId: "project-prompted", minEntries: 1, cooldownMs: 0 });
  assert.equal(store.claimReviewerWake({ jobId: existing.job_id, nowMs: 1_000, cooldownMs: 300_000 }).action, "inject");
  store.captureSessionEvent({ ...event("prompted-correction"), project_id: "project-prompted", session_uid: "prompted-session", event_seq: 2 });

  const immediate = store.submitDueReview({
    projectId: "project-prompted",
    minEntries: 99,
    maxEntries: 1,
    cooldownMs: 3_600_000,
    immediateEventUid: "prompted-correction"
  });

  assert.equal(immediate.status, "pending");
  assert.notEqual(immediate.job_id, existing.job_id);
  assert.equal(immediate.immediate, true);
  assert.deepEqual(store.getReviewerContext(immediate.job_id).queued_event_ids, ["prompted-correction"]);
  assert.equal(store.claimReviewerWake({ jobId: immediate.job_id, nowMs: 2_000, cooldownMs: 300_000 }).action, "inject");
  store.close();
});

test("an immediate event bypasses project review cooldown after a completed job", async () => {
  const store = await storeFixture();
  store.captureSessionEvent({ ...event("completed-old"), project_id: "project-force", session_uid: "force-session", event_seq: 1 });
  const completed = store.submitDueReview({ projectId: "project-force", minEntries: 1, cooldownMs: 0 });
  const lease = store.claimReviewerJob(completed.job_id, "force-reviewer", Date.now() + 100_000, 1);
  store.completeReviewerJob(completed.job_id, "force-reviewer", 1, lease.lease_epoch, "force-receipt");
  store.captureSessionEvent({ ...event("force-correction"), project_id: "project-force", session_uid: "force-session", event_seq: 2 });

  const immediate = store.submitDueReview({
    projectId: "project-force",
    minEntries: 99,
    maxEntries: 1,
    cooldownMs: 3_600_000,
    immediateEventUid: "force-correction"
  });

  assert.equal(immediate.status, "pending");
  assert.equal(immediate.immediate, true);
  assert.deepEqual(store.getReviewerContext(immediate.job_id).queued_event_ids, ["force-correction"]);
  store.close();
});

test("review jobs and reviewer context stay bounded without deleting excess pending evidence", async () => {
  const store = await storeFixture();
  for (let index = 1; index <= 8; index += 1) {
    store.captureSessionEvent({
      ...event(`bounded-${index}`),
      project_id: "project-bounded",
      session_uid: "bounded-session",
      source_event_id: `bounded-${index}`,
      event_seq: index,
      redacted_text: index === 3 ? `queued feedback ${"x".repeat(20_000)}` : `event ${index}`,
      tool_args: index === 3 ? { authorization: "token=context-secret", payload: "y".repeat(200_000) } : null,
      file_refs: index === 3 ? ["/tmp/password=file-secret"] : []
    });
  }
  const job = store.submitDueReview({ projectId: "project-bounded", minEntries: 1, maxEntries: 3, cooldownMs: 0 });
  assert.equal(job.eventCount, 3);
  assert.equal(store.pendingReviewEventCount("project-bounded"), 8);
  const context = store.getReviewerContext(job.job_id, { priorEvents: 1, followingEvents: 1, maxEvents: 6, maxEventChars: 256, maxTotalChars: 1024 });
  assert.deepEqual(context.queued_event_ids, ["bounded-1", "bounded-2", "bounded-3"]);
  assert.deepEqual(context.feedback_candidate_event_ids, ["bounded-1", "bounded-2", "bounded-3"]);
  assert.ok(context.events.length <= 4);
  assert.equal(context.events.some((item) => item.event_uid === "bounded-8"), false);
  assert.ok(context.events.every((item) => String(item.redacted_text || "").length <= 256));
  assert.equal(context.truncated_event_ids.includes("bounded-3"), true);
  assert.doesNotMatch(JSON.stringify(context), /context-secret|file-secret/);
  assert.equal(Object.hasOwn(context.events.find((item) => item.event_uid === "bounded-3"), "tool_args_json"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(context), "utf8") < 16 * 1024);
  const tiny = store.getReviewerContext(job.job_id, { priorEvents: 1, followingEvents: 1, maxEvents: 6, maxEventChars: 256, maxTotalChars: 32 });
  assert.ok(tiny.events.reduce((total, item) => total + String(item.redacted_text || "").length, 0) <= 32);
  store.close();
});

test("reviewer wake injects once and retries only after cooldown", async () => {
  const store = await storeFixture();
  store.captureSessionEvent({ ...event("wake-1"), project_id: "project-wake", session_uid: "wake-session" });
  const job = store.submitDueReview({ projectId: "project-wake", minEntries: 1, cooldownMs: 0 });
  const first = store.claimReviewerWake({ jobId: job.job_id, nowMs: 1_000, cooldownMs: 10_000 });
  const duplicate = store.claimReviewerWake({ jobId: job.job_id, nowMs: 2_000, cooldownMs: 10_000 });
  const retry = store.claimReviewerWake({ jobId: job.job_id, nowMs: 11_001, cooldownMs: 10_000 });
  assert.equal(first.action, "inject");
  assert.equal(first.attempt, 1);
  assert.equal(duplicate.action, "suppressed");
  assert.equal(retry.action, "retry");
  assert.equal(retry.attempt, 2);
  store.close();
});

test("prompt-created reviewer can read context and submit a structured receipt", async () => {
  const store = await storeFixture();
  store.captureSessionEvent({ ...event("prompt-review-1"), project_id: "project-prompt", session_uid: "prompt-session", source_event_id: "prompt-review-1", event_seq: 1, role: "user", capture_source: "prompt_hook", capture_completeness: "prompt_only" });
  store.captureSessionEvent({ ...event("prompt-review-a1"), project_id: "project-prompt", session_uid: "prompt-session", source_event_id: "prompt-review-a1", event_seq: 2, role: "assistant", redacted_text: "I completed it without verifying", capture_source: "stop_payload", capture_completeness: "partial" });
  const job = store.submitDueReview({ projectId: "project-prompt", minEntries: 1, cooldownMs: 0 });
  const wake = store.claimReviewerWake({ jobId: job.job_id, nowMs: Date.now(), cooldownMs: 10_000 });
  const context = store.getReviewerContext(job.job_id);
  assert.equal(job.eventCount, 1);
  assert.deepEqual(context.events.map((item) => item.role), ["user", "assistant"]);
  assert.equal(context.events[1].capture_completeness, "partial");
  assert.match(context.events[1].redacted_text, /without verifying/);
  assert.throws(() => store.submitPromptReview(job.job_id, { review_receipt_id: "bad", report_content_id: "bad-report", status: "reviewed_no_lesson", lessons: [], reviewer_capability: "wrong", background_agent_id: "agent-1", mode: "background_subagent" }), /capability/i);
  const result = store.submitPromptReview(job.job_id, { write_complete: true, review_receipt_id: "prompt-r", report_content_id: "prompt-report", report_content: "background 5-why token=report-secret", status: "reviewed_no_lesson", lessons: [], reviewer_capability: wake.capability, background_agent_id: "agent-1", mode: "background_subagent" });
  assert.equal(result.status, "completed");
  assert.equal(store.pendingReviewEventCount("project-prompt"), 0);
  assert.doesNotMatch(store.getReportContent("prompt-report").content_text, /report-secret/);
  const persistedReceipt = store.getReviewReceipt("prompt-r").payload_json;
  assert.doesNotMatch(persistedReceipt, new RegExp(wake.capability.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(persistedReceipt, /report-secret/);
  assert.throws(() => store.submitPromptReview(job.job_id, { write_complete: true, review_receipt_id: "again", report_content_id: "again-report", status: "reviewed_no_lesson", lessons: [], reviewer_capability: wake.capability, background_agent_id: "agent-1", mode: "background_subagent" }), /capability|pending|completed/i);
  store.close();
});

test("an invalid prompt review returns the claimed job to pending without consuming evidence", async () => {
  const store = await storeFixture();
  store.captureSessionEvent({ ...event("prompt-invalid"), project_id: "project-prompt-invalid", session_uid: "prompt-invalid-session" });
  const job = store.submitDueReview({ projectId: "project-prompt-invalid", minEntries: 1, cooldownMs: 0 });
  const wake = store.claimReviewerWake({ jobId: job.job_id, cooldownMs: 1000 });
  assert.throws(() => store.submitPromptReview(job.job_id, {
    write_complete: true,
    review_receipt_id: "invalid-review",
    report_content_id: "invalid-report",
    report_content: "The receipt claims a review but deliberately provides no lesson.",
    status: "reviewed",
    lessons: [],
    reviewer_capability: wake.capability,
    background_agent_id: "agent-invalid",
    mode: "background_subagent"
  }), /status.*lesson/i);
  assert.equal(store.getReviewerJob(job.job_id).status, "pending");
  assert.equal(store.getReviewerJob(job.job_id).capability_consumed_at, null);
  assert.equal(store.pendingReviewEventCount("project-prompt-invalid"), 1);
  store.close();
});

test("a successful retry clears the prior reviewer failure reason", async () => {
  const store = await storeFixture();
  store.captureSessionEvent({ ...event("retry-clean"), project_id: "project-retry-clean", session_uid: "retry-clean-session" });
  const job = store.submitDueReview({ projectId: "project-retry-clean", minEntries: 1, cooldownMs: 0 });
  const first = store.claimReviewerJob(job.job_id, "reviewer-first", Date.now() + 100_000, 1);
  store.failReviewerJob(job.job_id, "reviewer-first", 1, first.lease_epoch, true, "reviewer_failed");
  const second = store.claimReviewerJob(job.job_id, "reviewer-second", Date.now() + 100_000, 2);
  store.commitReview({ jobId: job.job_id, ownerId: "reviewer-second", attempt: 2, leaseEpoch: second.lease_epoch }, {
    write_complete: true,
    review_receipt_id: "retry-clean-receipt",
    report_content_id: "retry-clean-report",
    report_content: "The retry completed with a substantive no-lesson evidence review.",
    status: "reviewed_no_lesson",
    lessons: []
  });

  const completed = store.getReviewerJob(job.job_id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.reason_code, null);
  assert.deepEqual(store.listReviewerJobEvents(job.job_id).map((row) => row.state), ["claimed", "failed", "claimed", "completed"]);
  store.close();
});

test("notification creation is transaction-bound to queue review and delivery writes", async () => {
  const store = await storeFixture();
  store.captureSessionEvent({ ...event("bound-assistant"), project_id: "project-bound", session_uid: "bound-session", source_event_id: "bound-assistant", event_seq: 1, role: "assistant", redacted_text: "I claimed completion" });
  const feedback = { ...event("bound-feedback"), project_id: "project-bound", session_uid: "bound-session", source_event_id: "bound-feedback", event_seq: 2 };
  store.captureSessionEvent(feedback);
  store.createNotification({ sessionUid: feedback.session_uid, contextEpoch: 1, kind: "candidate_captured", eventUid: feedback.event_uid, payload: {}, language: "en" });

  const due = store.submitDueReview({ projectId: feedback.project_id, minEntries: 1, cooldownMs: 0, immediateEventUid: feedback.event_uid });
  assert.equal(store.listNotifications({ jobId: due.job_id }).filter((row) => row.kind === "review_queued").length, 1);
  assert.deepEqual(due.notificationRefs.map((row) => row.kind), ["review_queued"]);
  const lease = store.claimReviewerJob(due.job_id, "reviewer-bound", Date.now() + 100_000, 1);
  const noLessonReview = {
    write_complete: true,
    review_receipt_id: "bound-receipt",
    report_content_id: "bound-report",
    report_content: "The review found no durable lesson after examining the evidence.",
    status: "reviewed_no_lesson",
    lessons: []
  };
  assert.throws(() => store.commitReview({ jobId: due.job_id, ownerId: "reviewer-bound", attempt: 1, leaseEpoch: lease.lease_epoch + 1 }, noLessonReview), /stale reviewer completion/);
  assert.equal(store.listNotifications({ jobId: due.job_id }).some((row) => row.kind === "reviewed_no_lesson"), false);

  const completed = store.commitReview({ jobId: due.job_id, ownerId: "reviewer-bound", attempt: 1, leaseEpoch: lease.lease_epoch }, noLessonReview);
  assert.deepEqual(completed.notificationRefs.map((row) => row.kind), ["reviewed_no_lesson"]);
  assert.deepEqual(store.listReviewerJobEvents(due.job_id).map((row) => row.state), ["claimed", "completed"]);

  const deliveries = store.recordDeliveries({
    deliveries: [
      { application_id: "bound-app-1", lesson_id: "bound-lesson-1", revision: 1, nonce: "bound-nonce-1" },
      { application_id: "bound-app-2", lesson_id: "bound-lesson-2", revision: 1, nonce: "bound-nonce-2" }
    ],
    sessionUid: feedback.session_uid,
    contextEpoch: 1,
    language: "en"
  });
  assert.equal(deliveries.inserted, 2);
  assert.equal(deliveries.notification.kind, "lesson_delivered");
  assert.equal(JSON.parse(deliveries.notification.payload_json).lesson_count, 2);
  assert.equal(store.listNotifications({ sessionUid: feedback.session_uid }).filter((row) => row.kind === "lesson_delivered").length, 1);
  store.close();
});

test("delivery notification identity covers the complete sorted application set", async () => {
  const store = await storeFixture();
  const sessionUid = "delivery-batch-session";
  const deliveries = {
    a: { application_id: "delivery-app-a", lesson_id: "lesson-a", revision: 1 },
    b: { application_id: "delivery-app-b", lesson_id: "lesson-b", revision: 1 },
    c: { application_id: "delivery-app-c", lesson_id: "lesson-c", revision: 1 }
  };
  const first = store.recordDeliveries({ deliveries: [deliveries.b, deliveries.a], sessionUid, contextEpoch: 1, language: "en" });
  const reordered = store.recordDeliveries({ deliveries: [deliveries.a, deliveries.b], sessionUid, contextEpoch: 1, language: "en" });
  const expanded = store.recordDeliveries({ deliveries: [deliveries.c, deliveries.b, deliveries.a], sessionUid, contextEpoch: 1, language: "en" });
  const overlapping = store.recordDeliveries({ deliveries: [deliveries.c, deliveries.a], sessionUid, contextEpoch: 1, language: "en" });

  assert.equal(reordered.notification.notification_id, first.notification.notification_id);
  assert.notEqual(expanded.notification.notification_id, first.notification.notification_id);
  assert.notEqual(overlapping.notification.notification_id, first.notification.notification_id);
  assert.notEqual(overlapping.notification.notification_id, expanded.notification.notification_id);
  assert.equal(JSON.parse(expanded.notification.payload_json).lesson_count, 3);
  assert.equal(store.listNotifications({ sessionUid }).filter((row) => row.kind === "lesson_delivered").length, 3);
  store.close();
});

test("delivery writes roll back when aggregate notification validation fails", async () => {
  const store = await storeFixture();
  assert.throws(() => store.recordDeliveries({
    deliveries: [{ application_id: "rollback-application", lesson_id: "rollback-lesson", revision: 1 }],
    sessionUid: "rollback-session",
    contextEpoch: 1,
    language: "invalid"
  }), /language/i);
  assert.equal(store.hasDelivery("rollback-application"), false);
  assert.equal(store.listNotifications({ sessionUid: "rollback-session" }).length, 0);
  store.close();
});

test("event and terminal notification languages stay scoped to a shared job session", async () => {
  const store = await storeFixture();
  const zh = { ...event("language-zh"), project_id: "project-language", session_uid: "language-session-zh", redacted_text: "需要复核这个问题" };
  const en = { ...event("language-en"), project_id: "project-language", session_uid: "language-session-en", redacted_text: "please review this issue" };
  store.captureSessionEvent(zh);
  store.captureSessionEvent(en);
  const job = store.submitDueReview({ projectId: zh.project_id, minEntries: 2, maxEntries: 2, cooldownMs: 0 });
  const zhQueue = store.createNotification({ sessionUid: zh.session_uid, contextEpoch: 1, jobId: job.job_id, eventUid: zh.event_uid, kind: "review_queued", payload: {} });
  const enQueue = store.createNotification({ sessionUid: en.session_uid, contextEpoch: 1, jobId: job.job_id, eventUid: en.event_uid, kind: "review_queued", payload: {} });
  assert.equal(zhQueue.language, "zh");
  assert.equal(enQueue.language, "en");

  const lease = store.claimReviewerJob(job.job_id, "language-reviewer", Date.now() + 100_000, 1);
  store.commitReview({ jobId: job.job_id, ownerId: "language-reviewer", attempt: 1, leaseEpoch: lease.lease_epoch }, {
    write_complete: true,
    review_receipt_id: "language-receipt",
    report_content_id: "language-report",
    report_content: "The shared review completed with no durable lesson to persist.",
    status: "reviewed_no_lesson",
    lessons: []
  });
  assert.equal(store.listNotifications({ sessionUid: zh.session_uid }).find((row) => row.kind === "reviewed_no_lesson").language, "zh");
  assert.equal(store.listNotifications({ sessionUid: en.session_uid }).find((row) => row.kind === "reviewed_no_lesson").language, "en");
  store.close();
});

test("terminal language follows the assigned candidate without a queued notification", async () => {
  const store = await storeFixture();
  const candidate = {
    ...event("language-assigned-candidate"),
    project_id: "project-assigned-language",
    session_uid: "language-assigned-session",
    event_seq: 1,
    redacted_text: "please review this issue"
  };
  store.captureSessionEvent(candidate);
  store.createNotification({
    sessionUid: candidate.session_uid,
    contextEpoch: 1,
    kind: "candidate_captured",
    eventUid: candidate.event_uid,
    payload: {},
    language: "en"
  });
  const job = store.submitDueReview({ projectId: candidate.project_id, minEntries: 1, cooldownMs: 0 });
  assert.equal(store.listNotifications({ jobId: job.job_id }).some((row) => row.kind === "review_queued"), false);

  store.captureSessionEvent({
    ...event("language-unrelated-later"),
    project_id: candidate.project_id,
    session_uid: candidate.session_uid,
    event_seq: 2,
    redacted_text: "这是之后无关的用户文本"
  });
  const lease = store.claimReviewerJob(job.job_id, "language-assigned-reviewer", Date.now() + 100_000, 1);
  store.commitReview({ jobId: job.job_id, ownerId: "language-assigned-reviewer", attempt: 1, leaseEpoch: lease.lease_epoch }, {
    write_complete: true,
    review_receipt_id: "language-assigned-receipt",
    report_content_id: "language-assigned-report",
    report_content: "The assigned candidate was reviewed without a durable lesson.",
    status: "reviewed_no_lesson",
    lessons: []
  });

  const terminal = store.listNotifications({ sessionUid: candidate.session_uid })
    .find((row) => row.kind === "reviewed_no_lesson");
  assert.equal(terminal.language, "en");
  store.close();
});

test("reviewer provider and retry exhaustion are recorded without private context", async () => {
  const store = await storeFixture();
  const feedback = { ...event("exhausted-feedback"), project_id: "project-exhausted", session_uid: "exhausted-session" };
  store.captureSessionEvent(feedback);
  store.createNotification({ sessionUid: feedback.session_uid, contextEpoch: 1, kind: "candidate_captured", eventUid: feedback.event_uid, payload: {}, language: "en" });
  const due = store.submitDueReview({ projectId: feedback.project_id, minEntries: 1, cooldownMs: 0, immediateEventUid: feedback.event_uid });
  assert.equal(store.setReviewerProvider({ jobId: due.job_id, provider: "codex" }), true);
  assert.throws(() => store.setReviewerProvider({ jobId: due.job_id, provider: "main_conversation" }), /provider/);
  const lease = store.claimReviewerJob(due.job_id, "private-owner", Date.now() - 1, 3);
  const exhausted = store.failExhaustedReviewerJobs({ nowMs: Date.now(), maxAttempts: 3 });
  assert.equal(exhausted.count, 1);
  assert.deepEqual(exhausted.notificationRefs.map((row) => row.kind), ["review_exhausted"]);
  const replay = store.failExhaustedReviewerJobs({ nowMs: Date.now(), maxAttempts: 3 });
  assert.equal(replay.count, 0);
  assert.deepEqual(replay.notificationRefs, []);
  const history = store.listReviewerJobEvents(due.job_id);
  assert.deepEqual(history.map((row) => row.state), ["claimed", "retry_exhausted"]);
  assert.ok(history.every((row) => row.provider === "codex"));
  assert.doesNotMatch(JSON.stringify(history), /private-owner|user feedback/);
  assert.equal(history[0].lease_epoch, lease.lease_epoch);
  store.close();
});

test("structured review commit atomically creates a lesson, receipt, report, and acknowledges its events", async () => {
  const store = await storeFixture();
  store.captureSessionEvent({ ...event("commit-assistant"), project_id: "project-commit", session_uid: "commit-evidence-session", source_event_id: "commit-assistant", event_seq: 1, role: "assistant", redacted_text: "I claimed completion without direct evidence" });
  for (const id of ["commit-1", "commit-2", "commit-3"]) {
    store.captureSessionEvent({ ...event(id), project_id: "project-commit", session_uid: `codex:install:${id}`, source_event_id: id });
  }
  const job = store.submitDueReview({ projectId: "project-commit", minEntries: 3, cooldownMs: 0 });
  const lease = store.claimReviewerJob(job.job_id, "reviewer-a", Date.now() + 100_000, 1);
  const committed = store.commitReview({ jobId: job.job_id, ownerId: "reviewer-a", attempt: 1, leaseEpoch: lease.lease_epoch }, {
    write_complete: true,
    review_receipt_id: "receipt-1",
    report_content_id: "report-1",
    report_content: "5-why report: the reviewer trusted an unverified state.",
    status: "reviewed",
    lessons: [{
      lesson_id: "lesson-commit",
      revision: 1,
      base_revision: 0,
      project_id: "project-commit",
      severity: "Major",
      responsibility: "agent_fault",
      confidence: "high",
      causal_chain: ["claim lacked evidence", "verification was skipped", "completion was inferred", "the workflow had no evidence gate", "the default process optimized speed over observable proof"],
      method_class: "verification-closure",
      class_id: "claim-without-evidence",
      generalizable: true,
      rule_action: "update_project_rule",
      scope: { paths: ["token=scope-secret"] },
      evidence_refs: [{ feedback_event_id: "commit-3", feedback_quote: "user feedback", referent_event_ids: ["commit-assistant"] }],
      card: { when: "working on project-commit", must_do: "verify evidence", must_not: "claim without evidence", verify: "read the artifact", why: "the prior process skipped verification", exception: "none", source_ids: ["report-1"] }
    }]
  });
  assert.deepEqual(committed.notificationRefs.map((row) => row.kind), ["review_completed"]);
  const completionNotification = store.listNotifications({ jobId: job.job_id }).find((row) => row.kind === "review_completed");
  assert.deepEqual(JSON.parse(completionNotification.payload_json), { severity: "Major", lesson_count: 1 });
  assert.equal(store.pendingReviewEventCount("project-commit"), 0);
  const selected = store.selectLessons({ projectId: "project-commit" });
  assert.equal(selected.length, 1);
  assert.doesNotMatch(JSON.stringify(selected[0].scope), /scope-secret/);
  assert.match(store.getReportContent("report-1").content_text, /unverified state/);
  const incidents = store.listIncidents("project-commit");
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].responsibility, "agent_fault");
  assert.equal(incidents[0].severity, "Major");
  assert.deepEqual(incidents[0].event_uids.sort(), ["commit-3", "commit-assistant"]);

  store.recordDelivery({
    application_id: "lesson-commit-cross-session",
    lesson_id: "lesson-commit",
    revision: 1,
    session_uid: "codex:install:later-session",
    context_epoch: 1,
    state: "emitted"
  });
  const unrelatedTrace = store.explainMemory("codex:install:commit-1");
  assert.equal(unrelatedTrace.stages.reviewed, true);
  assert.equal(unrelatedTrace.stages.lesson_compiled, false);
  const originTrace = store.explainMemory("codex:install:commit-3");
  assert.equal(originTrace.stages.lesson_compiled, true);
  assert.equal(originTrace.stages.emitted, true);
  assert.equal(originTrace.stages.delivered_into_session, false);
  assert.equal(originTrace.produced_lessons[0].lesson_id, "lesson-commit");
  assert.equal(originTrace.produced_lesson_deliveries[0].session_uid, "codex:install:later-session");
  store.close();
});

test("structured review rejects shallow lessons and preserves pending evidence", async () => {
  const store = await storeFixture();
  store.captureSessionEvent({ ...event("shallow-1"), project_id: "project-shallow", session_uid: "shallow-session" });
  const job = store.submitDueReview({ projectId: "project-shallow", minEntries: 1, cooldownMs: 0 });
  const lease = store.claimReviewerJob(job.job_id, "reviewer-shallow", Date.now() + 100_000, 1);
  assert.throws(() => store.commitReview({ jobId: job.job_id, ownerId: "reviewer-shallow", attempt: 1, leaseEpoch: lease.lease_epoch }, {
    write_complete: true,
    review_receipt_id: "shallow-r",
    report_content_id: "shallow-report",
    report_content: "The proposed lesson is intentionally shallow for validation.",
    status: "reviewed",
    lessons: [{ lesson_id: "shallow-lesson", revision: 1, base_revision: 0, project_id: "project-shallow", severity: "Major", card: { when: "task", must_do: "be careful", must_not: "guess", verify: "check", why: "mistake", exception: "none", source_ids: ["shallow-report"] } }]
  }), /causal|responsibility|method|quality/i);
  assert.equal(store.pendingReviewEventCount("project-shallow"), 1);
  store.close();
});

test("structured review rejects invented evidence references and preserves pending evidence", async () => {
  const store = await storeFixture();
  store.captureSessionEvent({ ...event("evidence-assistant"), project_id: "project-evidence", session_uid: "evidence-session", source_event_id: "evidence-assistant", event_seq: 1, role: "assistant", redacted_text: "I inferred completion" });
  store.captureSessionEvent({ ...event("evidence-feedback"), project_id: "project-evidence", session_uid: "evidence-session", source_event_id: "evidence-feedback", event_seq: 2, role: "user", redacted_text: "You did not verify it" });
  const job = store.submitDueReview({ projectId: "project-evidence", minEntries: 1, cooldownMs: 0 });
  const lease = store.claimReviewerJob(job.job_id, "reviewer-evidence", Date.now() + 100_000, 1);
  assert.throws(() => store.commitReview({ jobId: job.job_id, ownerId: "reviewer-evidence", attempt: 1, leaseEpoch: lease.lease_epoch }, {
    write_complete: true,
    review_receipt_id: "evidence-receipt",
    report_content_id: "evidence-report",
    report_content: "The completion claim was not grounded in observed evidence.",
    status: "reviewed",
    lessons: [{
      lesson_id: "lesson-evidence", revision: 1, base_revision: 0, project_id: "project-evidence", severity: "Major",
      responsibility: "agent_fault", confidence: "high",
      causal_chain: ["claim lacked evidence", "verification was skipped", "success was inferred", "there was no evidence checkpoint", "the method optimized completion over proof"],
      method_class: "verification-closure", class_id: "claim-without-evidence", generalizable: true,
      rule_action: "update_project_rule",
      evidence_refs: [{ feedback_event_id: "invented-feedback", feedback_quote: "invented complaint", referent_event_ids: ["invented-assistant"] }],
      card: { when: "making a completion claim", must_do: "verify observed evidence", must_not: "infer success", verify: "read the resulting artifact", why: "an unsupported claim caused the complaint", exception: "none", source_ids: ["evidence-report"] }
    }]
  }), /evidence|feedback|referent/i);
  assert.throws(() => store.commitReview({ jobId: job.job_id, ownerId: "reviewer-evidence", attempt: 1, leaseEpoch: lease.lease_epoch }, {
    write_complete: true,
    review_receipt_id: "quote-receipt",
    report_content_id: "quote-report",
    report_content: "The completion claim was not grounded in observed evidence.",
    status: "reviewed",
    lessons: [{
      lesson_id: "lesson-quote", revision: 1, base_revision: 0, project_id: "project-evidence", severity: "Major",
      responsibility: "agent_fault", confidence: "high",
      causal_chain: ["claim lacked evidence", "verification was skipped", "success was inferred", "there was no evidence checkpoint", "the method optimized completion over proof"],
      method_class: "verification-closure", class_id: "claim-without-evidence", generalizable: true,
      rule_action: "update_project_rule",
      evidence_refs: [{ feedback_event_id: "evidence-feedback", feedback_quote: "a quote that the user never said", referent_event_ids: ["evidence-assistant"] }],
      card: { when: "making a completion claim", must_do: "verify observed evidence", must_not: "infer success", verify: "read the resulting artifact", why: "an unsupported claim caused the complaint", exception: "none", source_ids: ["quote-report"] }
    }]
  }), /quote|evidence/i);
  assert.equal(store.pendingReviewEventCount("project-evidence"), 1);
  assert.equal(store.selectLessons({ projectId: "project-evidence" }).length, 0);
  store.close();
});

test("two independent Blocker reviews can promote one lesson family globally", async () => {
  const store = await storeFixture();
  const commitProject = (project, suffix, ruleAction) => {
    const eventId = `global-${suffix}`;
    store.captureSessionEvent({ ...event(`referent-${suffix}`), project_id: project, session_uid: `session-${suffix}`, source_event_id: `referent-${suffix}`, event_seq: 1, role: "assistant", redacted_text: "acted on an inferred destructive target" });
    store.captureSessionEvent({ ...event(eventId), project_id: project, session_uid: `session-${suffix}`, source_event_id: eventId, event_seq: 2 });
    const job = store.submitDueReview({ projectId: project, minEntries: 1, cooldownMs: 0 });
    const lease = store.claimReviewerJob(job.job_id, `reviewer-${suffix}`, Date.now() + 100_000, 1);
    store.commitReview({ jobId: job.job_id, ownerId: `reviewer-${suffix}`, attempt: 1, leaseEpoch: lease.lease_epoch }, {
      write_complete: true,
      review_receipt_id: `receipt-${suffix}`,
      report_content_id: `report-${suffix}`,
      report_content: "independent blocker review",
      status: "reviewed",
      lessons: [{
        lesson_id: `lesson-${suffix}`, revision: 1, base_revision: 0, project_id: project, severity: "Blocker",
        responsibility: "agent_fault", confidence: "high", causal_chain: ["a", "b", "c", "d", "systemic process gap"],
        method_class: "safety-irreversible", class_id: "unverified-destructive-action", generalizable: true,
        rule_action: ruleAction, evidence_refs: [{ feedback_event_id: eventId, feedback_quote: "user feedback", referent_event_ids: [`referent-${suffix}`] }],
        decision_timeline: ["selected an inferred target", "performed the irreversible action"],
        counterfactual_checkpoint: "verify the authoritative target id before action",
        impact_scope: "an irreversible action can affect live project data",
        stop_condition: "stop before the first destructive operation when target identity is unverified",
        rollback_or_isolation: "isolate the target and restore from a verified backup",
        global_promotion_evidence: ["lineage-one", "lineage-two"],
        scope: { repository_lineage_id: `lineage-${suffix}` },
        card: { when: "before destructive work", must_do: "verify the real target", must_not: "act on inferred identity", verify: "read the authoritative target id", why: "wrong-target actions are irreversible", exception: "read-only inspection", source_ids: [`report-${suffix}`] }
      }]
    });
  };
  commitProject("project-one", "one", "update_project_rule");
  assert.equal(store.selectLessons({ projectId: "project-three" }).length, 0);
  commitProject("project-two", "two", "propose_global_rule");
  const global = store.selectLessons({ projectId: "project-three" });
  assert.equal(global.length, 1);
  assert.equal(global[0].project_id, null);
  assert.equal(global[0].promotion_state, "active_global");
  store.close();
});

test("lesson scope supports promotion and delivery observation", async () => {
  const store = await storeFixture();
  store.upsertLessonRevision({ lesson_id: "lesson-scope", revision: 1, project_id: "project-a", scope: { task_types: ["review"] }, card_json: JSON.stringify({ when: "review", must_do: "verify", must_not: "guess", verify: "run check", why: "prior miss", exception: "none", source_ids: ["r"] }) }, 0);
  assert.equal(store.selectLessons({ projectId: "project-a" }).length, 0);
  assert.equal(store.selectLessons({ projectId: "project-b" }).length, 0);
  store.promoteLesson({ lessonId: "lesson-scope", projectId: "project-a" });
  assert.equal(store.selectLessons({ projectId: "project-a" })[0].scope.task_types[0], "review");
  assert.throws(() => store.promoteLesson({ lessonId: "lesson-scope", projectId: null }), /Blocker|evidence|global/i);
  store.recordDelivery({ application_id: "delivery-1", lesson_id: "lesson-scope", revision: 1, session_uid: "s", context_epoch: 1, state: "emitted", nonce: "nonce-123" });
  assert.equal(store.observeDeliveryNonces({ session_uid: "s", context_epoch: 1, transcriptText: "system context nonce=nonce-123" }), 1);
  assert.equal(store.getDelivery("delivery-1").state, "observed");
  store.close();
});

test("a stop without an echoed nonce records emitted_unconfirmed instead of observed", async () => {
  const store = await storeFixture();
  store.recordDelivery({ application_id: "delivery-unconfirmed", lesson_id: "lesson-missing-echo", revision: 1, session_uid: "session-unconfirmed", context_epoch: 1, state: "emitted", nonce: "not-echoed" });
  assert.equal(store.observeDeliveryNonces({ session_uid: "session-unconfirmed", context_epoch: 1, transcriptText: "assistant output only" }), 0);
  assert.equal(store.finalizeUnconfirmedDeliveries({ session_uid: "session-unconfirmed", context_epoch: 1 }), 1);
  assert.equal(store.getDelivery("delivery-unconfirmed").state, "emitted_unconfirmed");
  assert.equal(store.hasDelivery("delivery-unconfirmed"), false);
  store.recordDelivery({ application_id: "delivery-unconfirmed", lesson_id: "lesson-missing-echo", revision: 1, session_uid: "session-unconfirmed", context_epoch: 1, state: "emitted", nonce: "not-echoed" });
  assert.equal(store.observeDeliveryNonces({ session_uid: "session-unconfirmed", context_epoch: 1, transcriptText: "late nonce=not-echoed" }), 1);
  assert.equal(store.hasDelivery("delivery-unconfirmed"), true);
  store.close();
});

test("store preserves severe safety holds for the selector", async () => {
  const store = await storeFixture();
  store.upsertLessonRevision({
    lesson_id: "lesson-hold",
    revision: 1,
    project_id: "project-hold",
    severity: "Critical",
    conflict_state: "safety_hold",
    scope: { task_types: ["deploy"] },
    card_json: JSON.stringify({ when: "deploying", must_do: "verify target", must_not: "continue under conflict", verify: "resolve conflict", why: "safety evidence conflicts", exception: "none", source_ids: ["hold-report"] })
  }, 0);
  store.promoteLesson({ lessonId: "lesson-hold", projectId: "project-hold" });
  const result = selectLessons({
    lessons: store.selectLessons({ projectId: "project-hold" }),
    session: { session_uid: "hold-session", context_epoch: 1 },
    task: { project_id: "project-hold", task_type: "deploy", fingerprint: "hold-task", paths: [], tools: [], prompt: "deploy" }
  });
  assert.equal(result.hold, "safety_hold");
  store.close();
});

test("same-project recurrence requires and stores an effectiveness audit bound to real delivery", async () => {
  const store = await storeFixture();
  store.upsertLessonRevision({
    lesson_id: "lesson-recurrence",
    revision: 1,
    project_id: "project-recurrence",
    scope: {},
    card_json: JSON.stringify({ when: "making a completion claim", must_do: "verify evidence", must_not: "infer success", verify: "read the artifact", why: "prior unsupported claim", exception: "none", source_ids: ["old-report"] })
  }, 0);
  store.recordDelivery({
    application_id: "recurrence-application",
    lesson_id: "lesson-recurrence",
    revision: 1,
    session_uid: "recurrence-session",
    context_epoch: 1,
    state: "emitted",
    nonce: "recurrence-nonce"
  });
  store.observeDeliveryNonces({ session_uid: "recurrence-session", context_epoch: 1, transcriptText: "nonce=recurrence-nonce" });
  store.captureSessionEvent({ ...event("prior-agent-output"), project_id: "project-recurrence", session_uid: "recurrence-session", source_event_id: "prior-agent-output", event_seq: 1, role: "assistant", redacted_text: "claimed completion without checking the lesson" });
  store.captureSessionEvent({ ...event("recurrence-feedback"), project_id: "project-recurrence", session_uid: "recurrence-session", source_event_id: "recurrence-feedback", event_seq: 2 });
  const job = store.submitDueReview({ projectId: "project-recurrence", minEntries: 1, cooldownMs: 0 });
  const lease = store.claimReviewerJob(job.job_id, "reviewer-recurrence", Date.now() + 100_000, 1);
  const baseReview = {
    write_complete: true,
    review_receipt_id: "recurrence-receipt",
    report_content_id: "recurrence-report",
    report_content: "the lesson was observed but not followed",
    status: "reviewed",
    lessons: [{
      lesson_id: "lesson-recurrence", revision: 2, base_revision: 1, project_id: "project-recurrence", severity: "Critical",
      responsibility: "agent_fault", confidence: "high", causal_chain: ["claim recurred", "loaded guard was ignored", "verification was skipped", "no execution gate stopped the claim", "the learned control remained advisory"],
      method_class: "verification-closure", class_id: "claim-without-evidence", generalizable: true,
      rule_action: "update_project_rule", evidence_refs: [{ feedback_event_id: "recurrence-feedback", feedback_quote: "user feedback", referent_event_ids: ["prior-agent-output"] }],
      decision_timeline: ["loaded the lesson", "claimed completion before checking its verify step"],
      counterfactual_checkpoint: "require observed verification evidence before the completion response",
      card: { when: "making a completion claim", must_do: "verify evidence before replying", must_not: "infer success", verify: "attach the observed artifact result", why: "the prior loaded control was ignored", exception: "none", source_ids: ["recurrence-report"] }
    }]
  };
  assert.throws(() => store.commitReview({ jobId: job.job_id, ownerId: "reviewer-recurrence", attempt: 1, leaseEpoch: lease.lease_epoch }, baseReview), /effectiveness/i);
  const review = structuredClone(baseReview);
  review.lessons[0].effectiveness = {
    previous_lesson_id: "lesson-recurrence",
    expected_revision: 1,
    application_id: "recurrence-application",
    delivery_state: "observed",
    was_applicable: true,
    was_followed: false,
    failure_mode: "loaded_not_applied",
    control_owner: "agent_execution",
    corrective_action: "make verified evidence a precondition of the completion response token=corrective-secret"
  };
  const notEscalated = structuredClone(review);
  notEscalated.lessons[0].severity = "Major";
  assert.throws(() => store.commitReview({ jobId: job.job_id, ownerId: "reviewer-recurrence", attempt: 1, leaseEpoch: lease.lease_epoch }, notEscalated), /severity.*escalat/i);
  const result = store.commitReview({ jobId: job.job_id, ownerId: "reviewer-recurrence", attempt: 1, leaseEpoch: lease.lease_epoch }, review);
  assert.equal(result.status, "completed");
  const outcomes = store.listLessonEffectiveness("lesson-recurrence");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].delivery_state, "observed");
  assert.equal(outcomes[0].failure_mode, "loaded_not_applied");
  assert.doesNotMatch(outcomes[0].corrective_action, /corrective-secret/);
  store.close();
});

test("retention GC deletes old evidence but keeps newer evidence", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-gc-"));
  const paths = pathsFor(home);
  const oldStore = openStore({ paths, now: () => new Date("2020-01-01T00:00:00.000Z") });
  const oldEvent = { ...event("old-event"), session_uid: "old-session" };
  oldStore.captureSessionEvent(oldEvent);
  oldStore.createNotification({ sessionUid: oldEvent.session_uid, contextEpoch: 1, kind: "candidate_captured", eventUid: oldEvent.event_uid, payload: {}, language: "en" });
  const oldJob = oldStore.submitDueReview({ projectId: "project-a", minEntries: 1, cooldownMs: 0 });
  const oldLease = oldStore.claimReviewerJob(oldJob.job_id, "gc-reviewer", Date.now() + 100_000, 1);
  oldStore.commitReview({ jobId: oldJob.job_id, ownerId: "gc-reviewer", attempt: 1, leaseEpoch: oldLease.lease_epoch }, { write_complete: true, review_receipt_id: "gc-receipt", report_content_id: "gc-report", report_content: "No durable lesson was proven from this old retention fixture.", status: "reviewed_no_lesson", lessons: [] });
  assert.equal(oldStore.listNotifications({ sessionUid: oldEvent.session_uid }).length, 2);
  oldStore.close();
  const currentStore = openStore({ paths });
  currentStore.captureSessionEvent({ ...event("new-event"), session_uid: "new-session" });
  const result = currentStore.gcExpired({ beforeMs: Date.now() - 24 * 60 * 60 * 1000 });
  assert.equal(result.eventCount, 1);
  assert.equal(result.jobCount, 0);
  assert.ok(currentStore.getReportContent("gc-report"));
  assert.equal(currentStore.listSessionEvents("project-a").length, 1);
  assert.equal(currentStore.listSessionEvents("project-a")[0].event_uid, "new-event");
  assert.equal(currentStore.listNotifications({ sessionUid: oldEvent.session_uid }).length, 0);
  currentStore.close();
  const verify = new DatabaseSync(paths.storeFile);
  assert.deepEqual(verify.prepare("PRAGMA foreign_key_check").all(), []);
  verify.close();
});

test("retention GC removes event-bound notifications before deleting multiple old events in a retained session", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-gc-event-notifications-"));
  const paths = pathsFor(home);
  const sessionUid = "gc-retained-session";
  const oldStore = openStore({ paths, now: () => new Date("2020-01-01T00:00:00.000Z") });
  for (const [index, eventUid] of ["gc-old-1", "gc-old-2", "gc-old-3"].entries()) {
    oldStore.captureSessionEvent({
      ...event(eventUid),
      session_uid: sessionUid,
      event_seq: index + 1,
      role: "assistant"
    });
    oldStore.createNotification({
      sessionUid,
      contextEpoch: 1,
      kind: "candidate_captured",
      eventUid,
      payload: {},
      language: "en"
    });
  }
  oldStore.close();

  const currentStore = openStore({ paths, now: () => new Date("2024-01-01T00:00:00.000Z") });
  currentStore.captureSessionEvent({
    ...event("gc-retained-event"),
    session_uid: sessionUid,
    event_seq: 4,
    role: "assistant"
  });
  const retainedNotification = currentStore.createNotification({
    sessionUid,
    contextEpoch: 1,
    kind: "candidate_captured",
    eventUid: "gc-retained-event",
    payload: {},
    language: "en"
  });

  const result = currentStore.gcExpired({ beforeMs: Date.parse("2021-01-01T00:00:00.000Z") });
  assert.equal(result.eventCount, 3);
  assert.equal(result.notificationCount, 3);
  assert.deepEqual(
    currentStore.listSessionEvents("project-a").map((row) => row.event_uid),
    ["gc-retained-event"]
  );
  assert.deepEqual(
    currentStore.listNotifications({ sessionUid }).map((row) => ({
      notification_id: row.notification_id,
      event_uid: row.event_uid
    })),
    [{
      notification_id: retainedNotification.notification_id,
      event_uid: "gc-retained-event"
    }]
  );
  currentStore.close();

  const verify = new DatabaseSync(paths.storeFile);
  assert.deepEqual(verify.prepare("PRAGMA foreign_key_check").all(), []);
  verify.close();
});

test("retention GC preserves old evidence that is still pending review", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-gc-pending-"));
  const paths = pathsFor(home);
  const oldStore = openStore({ paths, now: () => new Date("2020-01-01T00:00:00.000Z") });
  oldStore.captureSessionEvent({ ...event("old-pending-assistant"), session_uid: "old-pending-session", event_seq: 1, role: "assistant" });
  oldStore.captureSessionEvent({ ...event("old-pending"), session_uid: "old-pending-session", event_seq: 2 });
  oldStore.close();
  const currentStore = openStore({ paths });
  const result = currentStore.gcExpired({ beforeMs: Date.now() - 24 * 60 * 60 * 1000 });
  assert.equal(result.eventCount, 0);
  assert.equal(currentStore.listSessionEvents("project-a").length, 2);
  currentStore.close();
});

test("review cooldown prevents an immediate second batch after completion", async () => {
  const store = await storeFixture();
  for (const id of ["cool-1", "cool-2", "cool-3"]) {
    store.captureSessionEvent({ ...event(id), project_id: "project-cool", session_uid: `codex:install:${id}`, source_event_id: id });
  }
  const first = store.submitDueReview({ projectId: "project-cool", minEntries: 3, cooldownMs: 0 });
  const lease = store.claimReviewerJob(first.job_id, "reviewer-cool", Date.now() + 100_000, 1);
  store.commitReview({ jobId: first.job_id, ownerId: "reviewer-cool", attempt: 1, leaseEpoch: lease.lease_epoch }, { write_complete: true, review_receipt_id: "cool-r", report_content_id: "cool-report", report_content: "No durable lesson was proven from this cooldown fixture.", status: "reviewed_no_lesson", lessons: [] });
  for (const id of ["cool-4", "cool-5", "cool-6"]) {
    store.captureSessionEvent({ ...event(id), project_id: "project-cool", session_uid: `codex:install:${id}`, source_event_id: id });
  }
  const blocked = store.submitDueReview({ projectId: "project-cool", minEntries: 3, cooldownMs: 3_600_000 });
  assert.equal(blocked.status, "not_due");
  assert.equal(blocked.eventCount, 3);
  store.close();
});

test("reconcile worker lease fences overlap and can be released by its owner", async () => {
  const store = await storeFixture();
  const first = store.claimWorkerLease({ name: "codex_reconcile", ownerId: "worker-a", nowMs: 1_000, leaseMs: 60_000 });
  assert.equal(first.acquired, true);
  assert.equal(store.claimWorkerLease({ name: "codex_reconcile", ownerId: "worker-b", nowMs: 2_000, leaseMs: 60_000 }).acquired, false);
  assert.equal(store.releaseWorkerLease({ name: "codex_reconcile", ownerId: "worker-b" }), false);
  assert.equal(store.releaseWorkerLease({ name: "codex_reconcile", ownerId: "worker-a" }), true);
  assert.equal(store.claimWorkerLease({ name: "codex_reconcile", ownerId: "worker-b", nowMs: 3_000, leaseMs: 60_000 }).acquired, true);
  store.close();
});

test("transcript cursor compare-and-swap rejects a stale worker", async () => {
  const store = await storeFixture();
  store.saveTranscriptCursor({ provider: "codex", transcriptPath: "/tmp/one.jsonl", inodeId: "1", offset: 10, state: {}, expectedMissing: true });
  store.saveTranscriptCursor({ provider: "codex", transcriptPath: "/tmp/one.jsonl", inodeId: "1", offset: 20, state: {}, expectedOffset: 10, expectedInodeId: "1" });
  assert.throws(
    () => store.saveTranscriptCursor({ provider: "codex", transcriptPath: "/tmp/one.jsonl", inodeId: "1", offset: 15, state: {}, expectedOffset: 10, expectedInodeId: "1" }),
    /cursor changed/i
  );
  assert.equal(store.getTranscriptCursor("codex", "/tmp/one.jsonl").offset, 20);
  assert.deepEqual(
    store.listTranscriptCursors("codex").map((cursor) => [cursor.transcript_path, cursor.offset]),
    [["/tmp/one.jsonl", 20]]
  );
  store.close();
});

test("runtime status is durable and redacted for doctor diagnostics", async () => {
  const store = await storeFixture();
  store.setRuntimeStatus("codex_reconcile", { status: "completed", scanned: 2, detail: "password=synthetic-secret" });
  const status = store.getRuntimeStatus("codex_reconcile");
  assert.equal(status.status, "completed");
  assert.equal(status.scanned, 2);
  assert.doesNotMatch(JSON.stringify(status), /synthetic-secret/);
  store.close();
});
