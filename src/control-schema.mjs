export const SCHEMA_VERSION = 2;

export const REVIEW_JOB_STATES = Object.freeze([
  "pending", "running", "retryable", "reviewed_no_lesson", "published", "failed"
]);

export const V1_SCHEMA_SQL = `
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

export const CONVERGENCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS convergence_tasks(task_uid TEXT PRIMARY KEY, lineage_digest TEXT NOT NULL, adapter_kind TEXT NOT NULL, adapter_capability TEXT NOT NULL, native_task_digest TEXT NOT NULL, contract_source_kind TEXT NOT NULL, contract_source_ref_digest TEXT NOT NULL, contract_revision TEXT NOT NULL, policy_revision TEXT NOT NULL, importance TEXT NOT NULL, importance_authority TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS convergence_loops(fingerprint TEXT PRIMARY KEY, task_uid TEXT NOT NULL REFERENCES convergence_tasks(task_uid), boundary_id TEXT NOT NULL, canonical_invariant_id TEXT NOT NULL, status TEXT NOT NULL, failure_count INTEGER NOT NULL DEFAULT 0, fix_generation INTEGER NOT NULL DEFAULT 0, decision_basis_digest TEXT NOT NULL, current_decision TEXT NOT NULL, direction_generation INTEGER NOT NULL DEFAULT 0, aliases_json TEXT NOT NULL DEFAULT '[]', active_grant_id TEXT, probe_kind TEXT, probe_state TEXT, probe_attempt INTEGER NOT NULL DEFAULT 0, probe_owner_id TEXT, probe_lease_epoch INTEGER NOT NULL DEFAULT 0, probe_lease_until TEXT, probe_next_attempt_at TEXT, probe_result_digest TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(task_uid, boundary_id, canonical_invariant_id));
CREATE TABLE IF NOT EXISTS convergence_events(id INTEGER PRIMARY KEY AUTOINCREMENT, event_uid TEXT NOT NULL UNIQUE, task_uid TEXT NOT NULL REFERENCES convergence_tasks(task_uid), fingerprint TEXT REFERENCES convergence_loops(fingerprint), generation INTEGER, event_type TEXT NOT NULL, reason_code TEXT, decision TEXT, action TEXT, evidence_digest TEXT, source_digest TEXT, result_digest TEXT, facts_json TEXT NOT NULL DEFAULT '{}', previous_event_digest TEXT, event_digest TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS continuation_grants(grant_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, task_uid TEXT NOT NULL REFERENCES convergence_tasks(task_uid), fingerprint TEXT NOT NULL REFERENCES convergence_loops(fingerprint), current_generation INTEGER NOT NULL, next_generation INTEGER NOT NULL, purpose TEXT NOT NULL, scope_digest TEXT NOT NULL, contract_revision TEXT NOT NULL, policy_revision TEXT NOT NULL, decision_basis_digest TEXT NOT NULL, evidence_digest TEXT NOT NULL, state TEXT NOT NULL, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, revoked_at TEXT);
`;

export const SCHEMA_SQL = `${V1_SCHEMA_SQL}${CONVERGENCE_SCHEMA_SQL}`;

function sqlSignature(sqlText) {
  return Object.fromEntries(
    sqlText.split("\n")
    .map((statement) => statement.trim())
    .filter((statement) => statement.startsWith("CREATE TABLE IF NOT EXISTS "))
    .map((statement) => {
      const sql = statement
        .replace(/^CREATE TABLE IF NOT EXISTS /, "CREATE TABLE ")
        .replace(/;$/, "");
      const name = sql.slice("CREATE TABLE ".length, sql.indexOf("("));
      return [name, sql];
    }));
}

export const CONTROL_SCHEMA_SQL_SIGNATURE = Object.freeze(sqlSignature(SCHEMA_SQL));
export const CONTROL_SCHEMA_V1_SQL_SIGNATURE = Object.freeze(sqlSignature(V1_SCHEMA_SQL));

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
  continuation_grants: {
    columns: ordinaryColumns(
      ["grant_id", "TEXT", 0, null, 1],
      ["token_hash", "TEXT", 1, null, 0],
      ["task_uid", "TEXT", 1, null, 0],
      ["fingerprint", "TEXT", 1, null, 0],
      ["current_generation", "INTEGER", 1, null, 0],
      ["next_generation", "INTEGER", 1, null, 0],
      ["purpose", "TEXT", 1, null, 0],
      ["scope_digest", "TEXT", 1, null, 0],
      ["contract_revision", "TEXT", 1, null, 0],
      ["policy_revision", "TEXT", 1, null, 0],
      ["decision_basis_digest", "TEXT", 1, null, 0],
      ["evidence_digest", "TEXT", 1, null, 0],
      ["state", "TEXT", 1, null, 0],
      ["issued_at", "TEXT", 1, null, 0],
      ["expires_at", "TEXT", 1, null, 0],
      ["consumed_at", "TEXT", 0, null, 0],
      ["revoked_at", "TEXT", 0, null, 0]
    ),
    indexes: [
      canonicalUniqueIndex("pk", [[0, "grant_id"]]),
      canonicalUniqueIndex("u", [[1, "token_hash"]])
    ],
    foreignKeys: [
      ["convergence_loops", "fingerprint", "fingerprint", "NO ACTION", "NO ACTION", "NONE"],
      ["convergence_tasks", "task_uid", "task_uid", "NO ACTION", "NO ACTION", "NONE"]
    ]
  },
  convergence_events: {
    columns: ordinaryColumns(
      ["id", "INTEGER", 0, null, 1],
      ["event_uid", "TEXT", 1, null, 0],
      ["task_uid", "TEXT", 1, null, 0],
      ["fingerprint", "TEXT", 0, null, 0],
      ["generation", "INTEGER", 0, null, 0],
      ["event_type", "TEXT", 1, null, 0],
      ["reason_code", "TEXT", 0, null, 0],
      ["decision", "TEXT", 0, null, 0],
      ["action", "TEXT", 0, null, 0],
      ["evidence_digest", "TEXT", 0, null, 0],
      ["source_digest", "TEXT", 0, null, 0],
      ["result_digest", "TEXT", 0, null, 0],
      ["facts_json", "TEXT", 1, "'{}'", 0],
      ["previous_event_digest", "TEXT", 0, null, 0],
      ["event_digest", "TEXT", 1, null, 0],
      ["created_at", "TEXT", 1, null, 0]
    ),
    indexes: [
      canonicalUniqueIndex("u", [[1, "event_uid"]]),
      canonicalUniqueIndex("u", [[14, "event_digest"]])
    ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    foreignKeys: [
      ["convergence_loops", "fingerprint", "fingerprint", "NO ACTION", "NO ACTION", "NONE"],
      ["convergence_tasks", "task_uid", "task_uid", "NO ACTION", "NO ACTION", "NONE"]
    ]
  },
  convergence_loops: {
    columns: ordinaryColumns(
      ["fingerprint", "TEXT", 0, null, 1],
      ["task_uid", "TEXT", 1, null, 0],
      ["boundary_id", "TEXT", 1, null, 0],
      ["canonical_invariant_id", "TEXT", 1, null, 0],
      ["status", "TEXT", 1, null, 0],
      ["failure_count", "INTEGER", 1, "0", 0],
      ["fix_generation", "INTEGER", 1, "0", 0],
      ["decision_basis_digest", "TEXT", 1, null, 0],
      ["current_decision", "TEXT", 1, null, 0],
      ["direction_generation", "INTEGER", 1, "0", 0],
      ["aliases_json", "TEXT", 1, "'[]'", 0],
      ["active_grant_id", "TEXT", 0, null, 0],
      ["probe_kind", "TEXT", 0, null, 0],
      ["probe_state", "TEXT", 0, null, 0],
      ["probe_attempt", "INTEGER", 1, "0", 0],
      ["probe_owner_id", "TEXT", 0, null, 0],
      ["probe_lease_epoch", "INTEGER", 1, "0", 0],
      ["probe_lease_until", "TEXT", 0, null, 0],
      ["probe_next_attempt_at", "TEXT", 0, null, 0],
      ["probe_result_digest", "TEXT", 0, null, 0],
      ["version", "INTEGER", 1, "1", 0],
      ["created_at", "TEXT", 1, null, 0],
      ["updated_at", "TEXT", 1, null, 0]
    ),
    indexes: [
      canonicalUniqueIndex("pk", [[0, "fingerprint"]]),
      canonicalUniqueIndex("u", [[1, "task_uid"], [2, "boundary_id"], [3, "canonical_invariant_id"]])
    ],
    foreignKeys: [["convergence_tasks", "task_uid", "task_uid", "NO ACTION", "NO ACTION", "NONE"]]
  },
  convergence_tasks: {
    columns: ordinaryColumns(
      ["task_uid", "TEXT", 0, null, 1],
      ["lineage_digest", "TEXT", 1, null, 0],
      ["adapter_kind", "TEXT", 1, null, 0],
      ["adapter_capability", "TEXT", 1, null, 0],
      ["native_task_digest", "TEXT", 1, null, 0],
      ["contract_source_kind", "TEXT", 1, null, 0],
      ["contract_source_ref_digest", "TEXT", 1, null, 0],
      ["contract_revision", "TEXT", 1, null, 0],
      ["policy_revision", "TEXT", 1, null, 0],
      ["importance", "TEXT", 1, null, 0],
      ["importance_authority", "TEXT", 1, null, 0],
      ["state", "TEXT", 1, null, 0],
      ["created_at", "TEXT", 1, null, 0],
      ["updated_at", "TEXT", 1, null, 0]
    ),
    indexes: [canonicalUniqueIndex("pk", [[0, "task_uid"]])],
    foreignKeys: []
  },
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

const CONVERGENCE_TABLES = new Set([
  "continuation_grants",
  "convergence_events",
  "convergence_loops",
  "convergence_tasks"
]);

export const CONTROL_SCHEMA_V1_SIGNATURE = Object.freeze(Object.fromEntries(
  Object.entries(CONTROL_SCHEMA_SIGNATURE).filter(([name]) => !CONVERGENCE_TABLES.has(name))
));
