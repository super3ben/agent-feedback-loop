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
CREATE TABLE IF NOT EXISTS event_observations(observation_uid TEXT PRIMARY KEY, observation_key TEXT NOT NULL UNIQUE, observation_signature TEXT NOT NULL, source_provider TEXT NOT NULL, session_uid TEXT NOT NULL, context_epoch INTEGER NOT NULL, source_namespace TEXT NOT NULL, source_id TEXT NOT NULL, observed_event_uid TEXT NOT NULL, event_uid TEXT NOT NULL REFERENCES session_events(event_uid), capture_source TEXT NOT NULL, observed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reviewer_jobs(job_id TEXT PRIMARY KEY, source_identity TEXT NOT NULL UNIQUE, source_event_uid TEXT NOT NULL REFERENCES session_events(event_uid), referent_event_uid TEXT, project_id TEXT, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, launch_epoch INTEGER NOT NULL DEFAULT 0, owner_id TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0, lease_until TEXT, next_attempt_at TEXT, next_launch_at TEXT, created_at TEXT NOT NULL, claimed_at TEXT, completed_at TEXT, result_code TEXT, error_code TEXT, published_path TEXT, published_sha256 TEXT);
CREATE TABLE IF NOT EXISTS review_job_events(id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES reviewer_jobs(job_id), event_type TEXT NOT NULL, reason_code TEXT, lease_epoch INTEGER, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reflection_emissions(id INTEGER PRIMARY KEY AUTOINCREMENT, document_path TEXT NOT NULL, document_sha256 TEXT NOT NULL, family_id TEXT NOT NULL, session_uid TEXT NOT NULL, context_epoch INTEGER NOT NULL, task_fingerprint TEXT NOT NULL, selected_at TEXT NOT NULL, emitted_at TEXT, outcome TEXT NOT NULL, reason_code TEXT, UNIQUE(document_sha256, session_uid, context_epoch, task_fingerprint));
`;

export const CONTROL_SCHEMA_SQL_SIGNATURE = Object.freeze(Object.fromEntries(
  SCHEMA_SQL.split("\n")
    .map((statement) => statement.trim())
    .filter((statement) => statement.startsWith("CREATE TABLE IF NOT EXISTS "))
    .map((statement) => {
      const sql = statement
        .replace(/^CREATE TABLE IF NOT EXISTS /, "CREATE TABLE ")
        .replace(/;$/, "");
      const name = sql.slice("CREATE TABLE ".length, sql.indexOf("("));
      return [name, sql];
    })
));

function ordinaryColumns(...columns) {
  return columns.map((column) => [...column, 0]);
}

function canonicalUniqueIndex(origin, columns) {
  return [
    1,
    origin,
    0,
    [
      ...columns.map(([cid, name], seqno) => [seqno, cid, name, 0, "BINARY", 1]),
      [columns.length, -1, null, 0, "BINARY", 0]
    ]
  ];
}

export const CONTROL_SCHEMA_SIGNATURE = Object.freeze({
  event_observations: {
    columns: ordinaryColumns(
      ["observation_uid", "TEXT", 0, null, 1],
      ["observation_key", "TEXT", 1, null, 0],
      ["observation_signature", "TEXT", 1, null, 0],
      ["source_provider", "TEXT", 1, null, 0],
      ["session_uid", "TEXT", 1, null, 0],
      ["context_epoch", "INTEGER", 1, null, 0],
      ["source_namespace", "TEXT", 1, null, 0],
      ["source_id", "TEXT", 1, null, 0],
      ["observed_event_uid", "TEXT", 1, null, 0],
      ["event_uid", "TEXT", 1, null, 0],
      ["capture_source", "TEXT", 1, null, 0],
      ["observed_at", "TEXT", 1, null, 0]
    ),
    indexes: [
      canonicalUniqueIndex("pk", [[0, "observation_uid"]]),
      canonicalUniqueIndex("u", [[1, "observation_key"]])
    ],
    foreignKeys: [["session_events", "event_uid", "event_uid", "NO ACTION", "NO ACTION", "NONE"]]
  },
  reflection_emissions: {
    columns: ordinaryColumns(
      ["id", "INTEGER", 0, null, 1],
      ["document_path", "TEXT", 1, null, 0],
      ["document_sha256", "TEXT", 1, null, 0],
      ["family_id", "TEXT", 1, null, 0],
      ["session_uid", "TEXT", 1, null, 0],
      ["context_epoch", "INTEGER", 1, null, 0],
      ["task_fingerprint", "TEXT", 1, null, 0],
      ["selected_at", "TEXT", 1, null, 0],
      ["emitted_at", "TEXT", 0, null, 0],
      ["outcome", "TEXT", 1, null, 0],
      ["reason_code", "TEXT", 0, null, 0]
    ),
    indexes: [canonicalUniqueIndex("u", [
      [2, "document_sha256"],
      [4, "session_uid"],
      [5, "context_epoch"],
      [6, "task_fingerprint"]
    ])],
    foreignKeys: []
  },
  review_job_events: {
    columns: ordinaryColumns(
      ["id", "INTEGER", 0, null, 1],
      ["job_id", "TEXT", 1, null, 0],
      ["event_type", "TEXT", 1, null, 0],
      ["reason_code", "TEXT", 0, null, 0],
      ["lease_epoch", "INTEGER", 0, null, 0],
      ["created_at", "TEXT", 1, null, 0]
    ),
    indexes: [],
    foreignKeys: [["reviewer_jobs", "job_id", "job_id", "NO ACTION", "NO ACTION", "NONE"]]
  },
  reviewer_jobs: {
    columns: ordinaryColumns(
      ["job_id", "TEXT", 0, null, 1],
      ["source_identity", "TEXT", 1, null, 0],
      ["source_event_uid", "TEXT", 1, null, 0],
      ["referent_event_uid", "TEXT", 0, null, 0],
      ["project_id", "TEXT", 0, null, 0],
      ["state", "TEXT", 1, null, 0],
      ["attempt", "INTEGER", 1, "0", 0],
      ["launch_epoch", "INTEGER", 1, "0", 0],
      ["owner_id", "TEXT", 0, null, 0],
      ["lease_epoch", "INTEGER", 1, "0", 0],
      ["lease_until", "TEXT", 0, null, 0],
      ["next_attempt_at", "TEXT", 0, null, 0],
      ["next_launch_at", "TEXT", 0, null, 0],
      ["created_at", "TEXT", 1, null, 0],
      ["claimed_at", "TEXT", 0, null, 0],
      ["completed_at", "TEXT", 0, null, 0],
      ["result_code", "TEXT", 0, null, 0],
      ["error_code", "TEXT", 0, null, 0],
      ["published_path", "TEXT", 0, null, 0],
      ["published_sha256", "TEXT", 0, null, 0]
    ),
    indexes: [
      canonicalUniqueIndex("pk", [[0, "job_id"]]),
      canonicalUniqueIndex("u", [[1, "source_identity"]])
    ],
    foreignKeys: [["session_events", "source_event_uid", "event_uid", "NO ACTION", "NO ACTION", "NONE"]]
  },
  schema_migrations: {
    columns: ordinaryColumns(
      ["version", "INTEGER", 0, null, 1],
      ["applied_at", "TEXT", 1, null, 0]
    ),
    indexes: [],
    foreignKeys: []
  },
  session_events: {
    columns: ordinaryColumns(
      ["event_uid", "TEXT", 0, null, 1],
      ["session_uid", "TEXT", 1, null, 0],
      ["context_epoch", "INTEGER", 1, null, 0],
      ["source_provider", "TEXT", 1, null, 0],
      ["source_event_id", "TEXT", 1, null, 0],
      ["source_namespace", "TEXT", 1, null, 0],
      ["observation_source_id", "TEXT", 1, null, 0],
      ["source_identity", "TEXT", 1, null, 0],
      ["role", "TEXT", 1, null, 0],
      ["referent_event_uid", "TEXT", 0, null, 0],
      ["native_turn_id", "TEXT", 0, null, 0],
      ["content_hash", "TEXT", 1, null, 0],
      ["encrypted_raw_ref", "TEXT", 0, null, 0],
      ["completeness", "TEXT", 1, null, 0],
      ["source_timestamp", "TEXT", 0, null, 0],
      ["created_at", "TEXT", 1, null, 0]
    ),
    indexes: [
      canonicalUniqueIndex("pk", [[0, "event_uid"]]),
      canonicalUniqueIndex("u", [[7, "source_identity"]])
    ],
    foreignKeys: [["sessions", "session_uid", "session_uid", "NO ACTION", "NO ACTION", "NONE"]]
  },
  sessions: {
    columns: ordinaryColumns(
      ["session_uid", "TEXT", 0, null, 1],
      ["cli", "TEXT", 1, null, 0],
      ["project_id", "TEXT", 0, null, 0],
      ["context_epoch", "INTEGER", 1, null, 0],
      ["started_at", "TEXT", 1, null, 0],
      ["updated_at", "TEXT", 1, null, 0]
    ),
    indexes: [canonicalUniqueIndex("pk", [[0, "session_uid"]])],
    foreignKeys: []
  },
  store_meta: {
    columns: ordinaryColumns(
      ["key", "TEXT", 0, null, 1],
      ["value", "TEXT", 1, null, 0]
    ),
    indexes: [canonicalUniqueIndex("pk", [[0, "key"]])],
    foreignKeys: []
  }
});
