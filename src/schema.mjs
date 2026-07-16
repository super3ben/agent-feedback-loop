export const SCHEMA_VERSION = 9;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS store_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  session_uid TEXT PRIMARY KEY,
  cli TEXT NOT NULL,
  native_session_id TEXT,
  installation_id TEXT NOT NULL,
  project_id TEXT,
  context_epoch INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS session_events (
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
CREATE TABLE IF NOT EXISTS event_observations (
  provider TEXT NOT NULL,
  source_namespace TEXT NOT NULL,
  source_id TEXT NOT NULL,
  event_uid TEXT NOT NULL REFERENCES session_events(event_uid) ON DELETE CASCADE,
  source_offset INTEGER,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(provider, source_namespace, source_id),
  UNIQUE(event_uid, provider, source_namespace)
);
CREATE INDEX IF NOT EXISTS event_observations_event_uid_idx ON event_observations(event_uid);
CREATE TABLE IF NOT EXISTS queue_events (
  event_uid TEXT PRIMARY KEY REFERENCES session_events(event_uid),
  project_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  job_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS incidents (
  incident_fingerprint TEXT PRIMARY KEY,
  fingerprint_version INTEGER NOT NULL,
  project_id TEXT,
  responsibility TEXT,
  severity TEXT,
  status TEXT NOT NULL DEFAULT 'captured',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS incident_events (
  incident_fingerprint TEXT NOT NULL REFERENCES incidents(incident_fingerprint),
  event_uid TEXT NOT NULL REFERENCES session_events(event_uid),
  PRIMARY KEY(incident_fingerprint, event_uid)
);
CREATE TABLE IF NOT EXISTS lessons (
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
CREATE TABLE IF NOT EXISTS lesson_revisions (
  lesson_id TEXT NOT NULL REFERENCES lessons(lesson_id),
  revision INTEGER NOT NULL,
  card_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(lesson_id, revision)
);
CREATE TABLE IF NOT EXISTS lesson_family_evidence (
  family_id TEXT NOT NULL,
  repository_lineage_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL REFERENCES lessons(lesson_id),
  report_content_id TEXT NOT NULL,
  incident_fingerprint TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(family_id, repository_lineage_id)
);
CREATE TABLE IF NOT EXISTS reviewer_jobs (
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
CREATE TABLE IF NOT EXISTS reviewer_job_events (
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
CREATE UNIQUE INDEX IF NOT EXISTS reviewer_job_events_transition_idx
  ON reviewer_job_events(job_id, lease_epoch, state, IFNULL(reason_code, ''));
CREATE TABLE IF NOT EXISTS review_receipts (
  receipt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES reviewer_jobs(job_id),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS report_contents (
  content_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES reviewer_jobs(job_id),
  content_text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_receipts (
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
CREATE TABLE IF NOT EXISTS notification_outbox (
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
CREATE INDEX IF NOT EXISTS notification_outbox_chat_due_idx
  ON notification_outbox(session_uid, context_epoch, chat_state, created_at);
CREATE INDEX IF NOT EXISTS notification_outbox_system_due_idx
  ON notification_outbox(system_state, next_attempt_at, system_lease_until);
CREATE TABLE IF NOT EXISTS notification_deliveries (
  notification_id TEXT NOT NULL REFERENCES notification_outbox(notification_id) ON DELETE CASCADE,
  transport TEXT NOT NULL CHECK(transport IN (
    'codex_thread','system','audit','legacy_model_echo'
  )),
  state TEXT NOT NULL CHECK(state IN (
    'pending','delivering','accepted','observed','failed','unsupported','suppressed','audited_only'
  )),
  owner_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK(lease_epoch >= 0),
  lease_until INTEGER,
  next_attempt_at INTEGER,
  ack_id TEXT CHECK(ack_id IS NULL OR length(ack_id) <= 512),
  reason_code TEXT CHECK(reason_code IS NULL OR (
    length(reason_code) BETWEEN 1 AND 64 AND reason_code NOT GLOB '*[^a-z0-9_]*'
  )),
  accepted_at TEXT,
  observed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(notification_id, transport)
);
CREATE INDEX IF NOT EXISTS notification_deliveries_due_idx
  ON notification_deliveries(transport, state, next_attempt_at, lease_until);
CREATE INDEX IF NOT EXISTS notification_deliveries_lease_idx
  ON notification_deliveries(owner_id, lease_epoch, state);
CREATE TABLE IF NOT EXISTS feedback_episodes (
  episode_id TEXT PRIMARY KEY,
  session_uid TEXT REFERENCES sessions(session_uid) ON DELETE SET NULL,
  context_epoch INTEGER CHECK(context_epoch IS NULL OR context_epoch >= 1),
  project_id TEXT,
  root_referent_event_uid TEXT REFERENCES session_events(event_uid) ON DELETE SET NULL,
  signal_strength TEXT NOT NULL CHECK(signal_strength IN ('weak','strong')),
  status TEXT NOT NULL CHECK(status IN ('open','ready','assigned','reviewed','closed')),
  reviewer_job_id TEXT UNIQUE REFERENCES reviewer_jobs(job_id) ON DELETE SET NULL,
  opened_at TEXT NOT NULL,
  ready_at TEXT,
  closed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS feedback_episodes_open_projection_idx
  ON feedback_episodes(session_uid, context_epoch, IFNULL(root_referent_event_uid, ''))
  WHERE status='open';
CREATE INDEX IF NOT EXISTS feedback_episodes_due_idx
  ON feedback_episodes(status, ready_at, updated_at);
CREATE INDEX IF NOT EXISTS feedback_episodes_reviewer_idx
  ON feedback_episodes(reviewer_job_id, status);
CREATE TABLE IF NOT EXISTS feedback_episode_events (
  episode_id TEXT NOT NULL REFERENCES feedback_episodes(episode_id) ON DELETE CASCADE,
  event_uid TEXT NOT NULL UNIQUE REFERENCES session_events(event_uid) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK(relation IN ('referent','feedback','context')),
  signal_reason TEXT NOT NULL CHECK(signal_reason IN (
    'active_turn_steering','turn_interrupted','explicit_feedback','reconciled_context'
  )),
  created_at TEXT NOT NULL,
  PRIMARY KEY(episode_id, event_uid)
);
CREATE INDEX IF NOT EXISTS feedback_episode_events_episode_idx
  ON feedback_episode_events(episode_id, created_at, event_uid);
CREATE TABLE IF NOT EXISTS memory_maintenance_jobs (
  maintenance_job_id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL CHECK(job_type IN ('consolidate','resize','conflict_review')),
  project_id TEXT,
  family_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending','running','completed','failed','retry_exhausted','needs_human_resolution'
  )),
  owner_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK(lease_epoch >= 0),
  lease_until INTEGER,
  next_attempt_at INTEGER,
  reason_code TEXT CHECK(reason_code IS NULL OR (
    length(reason_code) BETWEEN 1 AND 64 AND reason_code NOT GLOB '*[^a-z0-9_]*'
  )),
  input_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS memory_maintenance_jobs_due_idx
  ON memory_maintenance_jobs(status, next_attempt_at, lease_until, created_at);
CREATE INDEX IF NOT EXISTS memory_maintenance_jobs_lease_idx
  ON memory_maintenance_jobs(owner_id, lease_epoch, status);
CREATE TABLE IF NOT EXISTS memory_maintenance_inputs (
  maintenance_job_id TEXT NOT NULL REFERENCES memory_maintenance_jobs(maintenance_job_id) ON DELETE CASCADE,
  lesson_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  card_hash TEXT NOT NULL,
  PRIMARY KEY(maintenance_job_id, lesson_id, revision),
  FOREIGN KEY(lesson_id, revision) REFERENCES lesson_revisions(lesson_id, revision)
);
CREATE TABLE IF NOT EXISTS memory_maintenance_job_events (
  event_id TEXT PRIMARY KEY,
  maintenance_job_id TEXT NOT NULL REFERENCES memory_maintenance_jobs(maintenance_job_id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK(attempt >= 0),
  lease_epoch INTEGER NOT NULL CHECK(lease_epoch >= 0),
  state TEXT NOT NULL CHECK(state IN (
    'claimed','requeued','completed','failed','retry_exhausted','needs_human_resolution'
  )),
  reason_code TEXT CHECK(reason_code IS NULL OR (
    length(reason_code) BETWEEN 1 AND 64 AND reason_code NOT GLOB '*[^a-z0-9_]*'
  )),
  provider TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_maintenance_job_events_transition_idx
  ON memory_maintenance_job_events(maintenance_job_id, lease_epoch, state, IFNULL(reason_code, ''));
CREATE TABLE IF NOT EXISTS lesson_lineage (
  source_lesson_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK(source_revision >= 1),
  target_lesson_id TEXT NOT NULL,
  target_revision INTEGER NOT NULL CHECK(target_revision >= 1),
  relation TEXT NOT NULL CHECK(relation IN ('consolidated_into','superseded_by')),
  maintenance_job_id TEXT NOT NULL REFERENCES memory_maintenance_jobs(maintenance_job_id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(source_lesson_id, source_revision, target_lesson_id, target_revision, relation),
  FOREIGN KEY(source_lesson_id, source_revision) REFERENCES lesson_revisions(lesson_id, revision),
  FOREIGN KEY(target_lesson_id, target_revision) REFERENCES lesson_revisions(lesson_id, revision)
);
CREATE INDEX IF NOT EXISTS lesson_lineage_maintenance_idx
  ON lesson_lineage(maintenance_job_id, relation);
CREATE TABLE IF NOT EXISTS lesson_effectiveness_events (
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
CREATE TABLE IF NOT EXISTS transcript_cursors (
  provider TEXT NOT NULL,
  transcript_path TEXT NOT NULL,
  device_id TEXT,
  inode_id TEXT,
  offset INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(provider, transcript_path)
);
CREATE TABLE IF NOT EXISTS worker_leases (
  name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL DEFAULT 1,
  lease_until INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`;
