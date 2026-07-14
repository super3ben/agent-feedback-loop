export const SCHEMA_VERSION = 6;

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
  captured_at TEXT NOT NULL,
  UNIQUE(session_uid, event_seq),
  UNIQUE(session_uid, source_event_id)
);
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
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
`;
