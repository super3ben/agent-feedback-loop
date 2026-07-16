import { createHash } from "node:crypto";

export const SCHEMA_V8_SQL = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE store_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE sessions (
  session_uid TEXT PRIMARY KEY,
  cli TEXT NOT NULL,
  native_session_id TEXT,
  installation_id TEXT NOT NULL,
  project_id TEXT,
  context_epoch INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE TABLE session_events (
  event_uid TEXT PRIMARY KEY,
  session_uid TEXT NOT NULL REFERENCES sessions(session_uid),
  event_seq INTEGER NOT NULL,
  context_epoch INTEGER NOT NULL,
  project_id TEXT,
  source_event_id TEXT,
  source_namespace TEXT NOT NULL DEFAULT 'hook',
  native_turn_id TEXT,
  parent_event_id TEXT,
  role TEXT NOT NULL,
  redacted_text TEXT,
  redaction_manifest_json TEXT,
  encrypted_raw_ref TEXT,
  content_hash TEXT NOT NULL,
  capture_policy_revision INTEGER NOT NULL,
  data_class TEXT NOT NULL,
  capture_source TEXT NOT NULL DEFAULT 'prompt_hook',
  capture_completeness TEXT NOT NULL DEFAULT 'prompt_only',
  tool_name TEXT,
  tool_args_json TEXT,
  textual_output_ref TEXT,
  file_refs_json TEXT,
  artifact_hashes_json TEXT,
  source_timestamp TEXT,
  captured_at TEXT NOT NULL,
  UNIQUE(session_uid, event_seq),
  UNIQUE(session_uid, source_event_id)
);
CREATE TABLE event_observations (
  provider TEXT NOT NULL,
  source_namespace TEXT NOT NULL,
  source_id TEXT NOT NULL,
  event_uid TEXT NOT NULL REFERENCES session_events(event_uid) ON DELETE CASCADE,
  source_offset INTEGER,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(provider, source_namespace, source_id),
  UNIQUE(event_uid, provider, source_namespace)
);
CREATE INDEX event_observations_event_uid_idx ON event_observations(event_uid);
CREATE TABLE queue_events (
  event_uid TEXT PRIMARY KEY REFERENCES session_events(event_uid),
  project_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  job_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE incidents (
  incident_fingerprint TEXT PRIMARY KEY,
  fingerprint_version INTEGER NOT NULL,
  project_id TEXT,
  responsibility TEXT,
  severity TEXT,
  status TEXT NOT NULL DEFAULT 'captured',
  created_at TEXT NOT NULL
);
CREATE TABLE incident_events (
  incident_fingerprint TEXT NOT NULL REFERENCES incidents(incident_fingerprint),
  event_uid TEXT NOT NULL REFERENCES session_events(event_uid),
  PRIMARY KEY(incident_fingerprint, event_uid)
);
CREATE TABLE lessons (
  lesson_id TEXT PRIMARY KEY,
  severity TEXT NOT NULL DEFAULT 'Major',
  lifecycle TEXT NOT NULL DEFAULT 'candidate',
  enablement TEXT NOT NULL DEFAULT 'enabled',
  conflict_state TEXT NOT NULL DEFAULT 'none',
  load_policy TEXT NOT NULL DEFAULT 'conditional',
  project_id TEXT,
  scope_json TEXT NOT NULL DEFAULT '{}',
  responsibility TEXT,
  confidence TEXT,
  method_class TEXT,
  class_id TEXT,
  family_id TEXT,
  generalizable INTEGER NOT NULL DEFAULT 0,
  recurrence_count INTEGER NOT NULL DEFAULT 1,
  promotion_state TEXT NOT NULL DEFAULT 'project',
  current_revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE lesson_revisions (
  lesson_id TEXT NOT NULL REFERENCES lessons(lesson_id),
  revision INTEGER NOT NULL,
  card_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(lesson_id, revision)
);
CREATE TABLE lesson_family_evidence (
  family_id TEXT NOT NULL,
  repository_lineage_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL REFERENCES lessons(lesson_id),
  report_content_id TEXT NOT NULL,
  incident_fingerprint TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(family_id, repository_lineage_id)
);
CREATE TABLE reviewer_jobs (
  job_id TEXT PRIMARY KEY,
  project_id TEXT,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  owner_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  receipt_id TEXT,
  reason_code TEXT,
  wake_attempt INTEGER NOT NULL DEFAULT 0,
  prompted_at INTEGER,
  next_wake_at INTEGER,
  capability_hash TEXT,
  capability_expires_at INTEGER,
  capability_consumed_at INTEGER,
  reviewer_provider TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE reviewer_job_events (
  job_event_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES reviewer_jobs(job_id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  lease_epoch INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN (
    'claimed','requeued','completed','failed','retry_exhausted'
  )),
  provider TEXT,
  reason_code TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX reviewer_job_events_transition_idx
  ON reviewer_job_events(job_id, lease_epoch, state, IFNULL(reason_code, ''));
CREATE TABLE review_receipts (
  receipt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES reviewer_jobs(job_id),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE report_contents (
  content_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES reviewer_jobs(job_id),
  content_text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE delivery_receipts (
  application_id TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  session_uid TEXT NOT NULL,
  context_epoch INTEGER NOT NULL,
  nonce TEXT,
  state TEXT NOT NULL,
  observed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE notification_outbox (
  notification_id TEXT PRIMARY KEY,
  session_uid TEXT NOT NULL REFERENCES sessions(session_uid) ON DELETE CASCADE,
  context_epoch INTEGER NOT NULL,
  job_id TEXT REFERENCES reviewer_jobs(job_id) ON DELETE CASCADE,
  event_uid TEXT REFERENCES session_events(event_uid) ON DELETE SET NULL,
  application_id TEXT REFERENCES delivery_receipts(application_id) ON DELETE SET NULL,
  semantic_key TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK(kind IN (
    'candidate_captured','review_queued','review_completed','reviewed_no_lesson',
    'review_exhausted','lesson_delivered'
  )),
  payload_json TEXT NOT NULL,
  language TEXT NOT NULL CHECK(language IN ('zh','en')),
  chat_state TEXT NOT NULL DEFAULT 'pending' CHECK(chat_state IN (
    'pending','emitted','observed','emitted_unconfirmed','suppressed'
  )),
  chat_turn_id TEXT,
  chat_emit_attempts INTEGER NOT NULL DEFAULT 0,
  chat_block_attempted INTEGER NOT NULL DEFAULT 0,
  chat_emitted_at TEXT,
  chat_observed_at TEXT,
  system_state TEXT NOT NULL DEFAULT 'not_applicable' CHECK(system_state IN (
    'not_applicable','pending','delivering','delivered','failed','unsupported','suppressed'
  )),
  system_owner TEXT,
  system_lease_epoch INTEGER NOT NULL DEFAULT 0,
  system_lease_until INTEGER,
  system_attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  system_reason_code TEXT,
  system_delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX notification_outbox_chat_due_idx
  ON notification_outbox(session_uid, context_epoch, chat_state, created_at);
CREATE INDEX notification_outbox_system_due_idx
  ON notification_outbox(system_state, next_attempt_at, system_lease_until);
CREATE UNIQUE INDEX notification_outbox_semantic_idx
  ON notification_outbox(
    session_uid, context_epoch, kind,
    IFNULL(job_id, ''), IFNULL(event_uid, ''), IFNULL(application_id, ''), semantic_key
  );
CREATE TABLE lesson_effectiveness_events (
  effectiveness_event_id TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL REFERENCES lessons(lesson_id),
  previous_lesson_id TEXT NOT NULL REFERENCES lessons(lesson_id),
  expected_revision INTEGER NOT NULL,
  application_id TEXT,
  delivery_state TEXT NOT NULL,
  was_applicable INTEGER NOT NULL,
  was_followed INTEGER,
  failure_mode TEXT NOT NULL,
  control_owner TEXT NOT NULL,
  corrective_action TEXT NOT NULL,
  report_content_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE transcript_cursors (
  provider TEXT NOT NULL,
  transcript_path TEXT NOT NULL,
  device_id TEXT,
  inode_id TEXT,
  offset INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(provider, transcript_path)
);
CREATE TABLE worker_leases (
  name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL DEFAULT 1,
  lease_until INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const CREATED_AT = "2026-07-15T08:00:00.000Z";
const UPDATED_AT = "2026-07-15T08:05:00.000Z";

function fixtureCard(id, mustDo = `Apply bounded corrective action ${id}.`) {
  return {
    when: `When fixture condition ${id} occurs.`,
    must_do: mustDo,
    must_not: "Do not route control-plane work through the primary model.",
    verify: "Verify the durable store state and transport evidence.",
    why: "Control-plane work must remain observable and non-interfering.",
    exception: "Only an explicit safety boundary may suspend this action.",
    source_ids: [`fixture-source-${id}`]
  };
}

export function seedSchemaV8ControlPlane(database) {
  database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;");
  try {
    database.exec(SCHEMA_V8_SQL);
    database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (8, ?)").run(CREATED_AT);
    database.prepare("INSERT INTO store_meta(key, value) VALUES ('capture_policy_revision', '1'), ('capture_enabled', '1')").run();
    database.prepare(`INSERT INTO sessions
      (session_uid, cli, native_session_id, installation_id, project_id, context_epoch, started_at)
      VALUES ('codex:fixture:control-plane', 'codex', 'fixture-native-session', 'fixture-installation',
        'fixture-project', 1, ?)` ).run(CREATED_AT);

    const insertEvent = database.prepare(`INSERT INTO session_events
      (event_uid, session_uid, event_seq, context_epoch, project_id, source_event_id, source_namespace,
       native_turn_id, parent_event_id, role, redacted_text, redaction_manifest_json, content_hash,
       capture_policy_revision, data_class, capture_source, capture_completeness, file_refs_json,
       artifact_hashes_json, source_timestamp, captured_at)
      VALUES (?, 'codex:fixture:control-plane', ?, 1, 'fixture-project', ?, ?, ?, ?, ?, ?, '[]', ?,
        1, 'normal', ?, 'complete', '[]', '[]', ?, ?)`);
    const events = [
      ["fixture-assistant-root", 1, "fixture-assistant-root", "stop_hook", "turn-root", null, "assistant", "A normal assistant answer.", "hash-assistant-root", "stop_hook", "2026-07-15T08:00:00.000Z"],
      ["fixture-followup-one", 2, "fixture-followup-one", "prompt_hook", "turn-followup-one", "fixture-assistant-root", "user", "请继续说明这个普通问题。", "hash-followup-one", "prompt_hook", "2026-07-15T08:01:00.000Z"],
      ["fixture-followup-two", 3, "fixture-followup-two", "prompt_hook", "turn-followup-two", "fixture-assistant-root", "user", "这个日志怎么看？", "hash-followup-two", "prompt_hook", "2026-07-15T08:02:00.000Z"],
      ["fixture-explicit-feedback", 4, "fixture-explicit-feedback", "host_feedback", "turn-feedback", "fixture-assistant-root", "user", "这次控制面处理打断了业务回合。", "hash-explicit-feedback", "host_feedback", "2026-07-15T08:03:00.000Z"]
    ];
    for (const row of events) insertEvent.run(...row, CREATED_AT);

    const jobs = [
      ["fixture-job-followup-one", "pending", null, null, 0, 0],
      ["fixture-job-followup-two", "completed", "fixture-receipt-commentary", null, 1, 1],
      ["fixture-job-lessons", "completed", "fixture-receipt-lessons", null, 1, 1]
    ];
    const insertJob = database.prepare(`INSERT INTO reviewer_jobs
      (job_id, project_id, prompt_version, status, owner_id, attempt, lease_epoch, lease_until, receipt_id,
       reason_code, wake_attempt, reviewer_provider, created_at, updated_at)
      VALUES (?, 'fixture-project', 'fixture-review-v8', ?, NULL, ?, ?, NULL, ?, ?, 0, 'codex', ?, ?)`);
    for (const [jobId, status, receiptId, reasonCode, attempt, leaseEpoch] of jobs) {
      insertJob.run(jobId, status, attempt, leaseEpoch, receiptId, reasonCode, CREATED_AT, UPDATED_AT);
    }

    const insertQueue = database.prepare(`INSERT INTO queue_events(event_uid, project_id, status, job_id, created_at)
      VALUES (?, 'fixture-project', ?, ?, ?)`);
    insertQueue.run("fixture-followup-one", "queued", "fixture-job-followup-one", CREATED_AT);
    insertQueue.run("fixture-followup-two", "acknowledged", "fixture-job-followup-two", CREATED_AT);
    insertQueue.run("fixture-explicit-feedback", "acknowledged", "fixture-job-lessons", CREATED_AT);

    const lessonIds = [
      "fixture-critical-1", "fixture-critical-2", "fixture-critical-3", "fixture-critical-4", "fixture-critical-5",
      "fixture-critical-oversized", "fixture-safety-left", "fixture-safety-right"
    ];
    const insertLesson = database.prepare(`INSERT INTO lessons
      (lesson_id, severity, lifecycle, enablement, conflict_state, load_policy, project_id, scope_json,
       responsibility, confidence, method_class, class_id, family_id, generalizable, recurrence_count,
       promotion_state, current_revision)
      VALUES (?, 'Critical', 'active', 'enabled', ?, 'conditional', 'fixture-project', '{"repository":"fixture"}',
        'agent_fault', 'high', 'control_plane', ?, ?, 0, 1, 'project', 1)`);
    const insertRevision = database.prepare(`INSERT INTO lesson_revisions(lesson_id, revision, card_json, created_at)
      VALUES (?, 1, ?, ?)`);
    for (const [index, lessonId] of lessonIds.entries()) {
      const safety = lessonId.startsWith("fixture-safety-");
      const familyId = safety ? "fixture-safety-hold-family" : `fixture-family-${lessonId}`;
      insertLesson.run(lessonId, safety ? "safety_hold" : "none", `fixture-class-${index + 1}`, familyId);
      const mustDo = lessonId === "fixture-critical-oversized"
        ? `Preserve this oversized critical rule: ${"x".repeat(48 * 1024)}`
        : fixtureCard(lessonId).must_do;
      insertRevision.run(lessonId, JSON.stringify(fixtureCard(lessonId, mustDo)), CREATED_AT);
    }

    database.prepare(`INSERT INTO review_receipts(receipt_id, job_id, payload_json, created_at)
      VALUES (?, ?, ?, ?)` ).run(
      "fixture-receipt-commentary",
      "fixture-job-followup-two",
      JSON.stringify({ status: "reviewed_no_lesson", write_complete: true, lessons: [], channel: "commentary_only" }),
      CREATED_AT
    );
    database.prepare(`INSERT INTO review_receipts(receipt_id, job_id, payload_json, created_at)
      VALUES (?, ?, ?, ?)` ).run(
      "fixture-receipt-lessons",
      "fixture-job-lessons",
      JSON.stringify({ status: "reviewed", write_complete: true, lessons: lessonIds.map((lesson_id) => ({ lesson_id })) }),
      CREATED_AT
    );

    const notifications = [
      ["fixture-notification-commentary", "fixture-job-followup-two", "fixture-followup-two", "reviewed_no_lesson", "observed", "turn-commentary-only", 1, 0, "2026-07-15T08:03:00.000Z", "2026-07-15T08:04:00.000Z", "not_applicable", null, 0, null, 0, null, null, null],
      ["fixture-notification-emitted", "fixture-job-followup-one", "fixture-followup-one", "review_queued", "emitted", "turn-emitted", 1, 1, "2026-07-15T08:03:00.000Z", null, "pending", null, 0, null, 0, 0, null, null],
      ["fixture-notification-unconfirmed", "fixture-job-followup-one", null, "review_exhausted", "emitted_unconfirmed", "turn-unconfirmed", 2, 1, "2026-07-15T08:03:00.000Z", null, "failed", null, 2, null, 2, 1_000, "legacy_retry", null],
      ["fixture-notification-observed", "fixture-job-lessons", "fixture-explicit-feedback", "review_completed", "observed", "turn-observed", 1, 0, "2026-07-15T08:03:00.000Z", "2026-07-15T08:04:00.000Z", "delivered", null, 1, null, 1, null, null, "2026-07-15T08:04:00.000Z"],
      ["fixture-notification-pending", null, "fixture-explicit-feedback", "candidate_captured", "pending", null, 0, 0, null, null, "unsupported", null, 1, null, 1, null, "legacy_unsupported", null],
      ["fixture-notification-suppressed", null, null, "lesson_delivered", "suppressed", null, 0, 0, null, null, "suppressed", null, 0, null, 0, null, "legacy_suppressed", null],
      ["fixture-notification-delivering", "fixture-job-lessons", null, "reviewed_no_lesson", "emitted", "turn-delivering", 1, 0, "2026-07-15T08:03:00.000Z", null, "delivering", "legacy-system-owner", 3, 9_999_999_999_999, 3, null, null, null]
    ];
    const insertNotification = database.prepare(`INSERT INTO notification_outbox
      (notification_id, session_uid, context_epoch, job_id, event_uid, semantic_key, kind, payload_json,
       language, chat_state, chat_turn_id, chat_emit_attempts, chat_block_attempted, chat_emitted_at,
       chat_observed_at, system_state, system_owner, system_lease_epoch, system_lease_until, system_attempts,
       next_attempt_at, system_reason_code, system_delivered_at, created_at, updated_at)
      VALUES (?, 'codex:fixture:control-plane', 1, ?, ?, ?, ?, '{}', 'zh', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of notifications) {
      insertNotification.run(row[0], row[1], row[2], `fixture-semantic-${row[0]}`, ...row.slice(3), CREATED_AT, UPDATED_AT);
    }

    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function tableSnapshot(database, table, columns, orderBy) {
  const rows = database.prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${orderBy}`).all();
  return {
    count: rows.length,
    hash: createHash("sha256").update(JSON.stringify(rows)).digest("hex")
  };
}

export function snapshotSchemaV8Evidence(database) {
  return {
    evidence: tableSnapshot(database, "session_events", [
      "event_uid", "session_uid", "event_seq", "context_epoch", "project_id", "source_event_id",
      "source_namespace", "native_turn_id", "parent_event_id", "role", "redacted_text", "content_hash",
      "capture_policy_revision", "data_class", "capture_source", "capture_completeness", "source_timestamp", "captured_at"
    ], "event_uid"),
    queue_events: tableSnapshot(database, "queue_events", ["event_uid", "project_id", "status", "job_id", "created_at"], "event_uid"),
    reviewer_jobs: tableSnapshot(database, "reviewer_jobs", [
      "job_id", "project_id", "prompt_version", "status", "owner_id", "attempt", "lease_epoch", "lease_until",
      "receipt_id", "reason_code", "wake_attempt", "prompted_at", "next_wake_at", "capability_hash",
      "capability_expires_at", "capability_consumed_at", "reviewer_provider", "created_at", "updated_at"
    ], "job_id"),
    review_receipts: tableSnapshot(database, "review_receipts", ["receipt_id", "job_id", "payload_json", "created_at"], "receipt_id"),
    lesson_revisions: tableSnapshot(database, "lesson_revisions", ["lesson_id", "revision", "card_json", "created_at"], "lesson_id, revision")
  };
}
