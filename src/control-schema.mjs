export const SCHEMA_VERSION = 1;

export const REVIEW_JOB_STATES = Object.freeze([
  "pending", "running", "retryable", "reviewed_no_lesson", "published", "failed"
]);

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS store_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(session_uid TEXT PRIMARY KEY, cli TEXT NOT NULL, project_id TEXT, context_epoch INTEGER NOT NULL, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS session_events(event_uid TEXT PRIMARY KEY, session_uid TEXT NOT NULL REFERENCES sessions(session_uid), context_epoch INTEGER NOT NULL, source_provider TEXT NOT NULL, source_event_id TEXT NOT NULL, source_namespace TEXT NOT NULL, observation_source_id TEXT NOT NULL, source_identity TEXT NOT NULL UNIQUE, role TEXT NOT NULL, referent_event_uid TEXT, native_turn_id TEXT, content_hash TEXT NOT NULL, encrypted_raw_ref TEXT, completeness TEXT NOT NULL, source_timestamp TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS event_observations(observation_uid TEXT PRIMARY KEY, observation_key TEXT NOT NULL UNIQUE, source_provider TEXT NOT NULL, session_uid TEXT NOT NULL, context_epoch INTEGER NOT NULL, source_namespace TEXT NOT NULL, source_id TEXT NOT NULL, observed_event_uid TEXT NOT NULL, event_uid TEXT NOT NULL REFERENCES session_events(event_uid), capture_source TEXT NOT NULL, observed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reviewer_jobs(job_id TEXT PRIMARY KEY, source_identity TEXT NOT NULL UNIQUE, source_event_uid TEXT NOT NULL REFERENCES session_events(event_uid), referent_event_uid TEXT, project_id TEXT, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, launch_epoch INTEGER NOT NULL DEFAULT 0, owner_id TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0, lease_until TEXT, next_attempt_at TEXT, next_launch_at TEXT, created_at TEXT NOT NULL, claimed_at TEXT, completed_at TEXT, result_code TEXT, error_code TEXT, published_path TEXT, published_sha256 TEXT);
CREATE TABLE IF NOT EXISTS review_job_events(id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES reviewer_jobs(job_id), event_type TEXT NOT NULL, reason_code TEXT, lease_epoch INTEGER, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reflection_emissions(id INTEGER PRIMARY KEY AUTOINCREMENT, document_path TEXT NOT NULL, document_sha256 TEXT NOT NULL, family_id TEXT NOT NULL, session_uid TEXT NOT NULL, context_epoch INTEGER NOT NULL, task_fingerprint TEXT NOT NULL, selected_at TEXT NOT NULL, emitted_at TEXT, outcome TEXT NOT NULL, reason_code TEXT, UNIQUE(document_sha256, session_uid, context_epoch, task_fingerprint));
`;
