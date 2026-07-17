import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { SCHEMA_SQL, SCHEMA_VERSION } from "./control-schema.mjs";

const require = createRequire(import.meta.url);
let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

export const CONTROL_STORE_UNAVAILABLE = "control_store_unavailable";
export const CONTROL_SCHEMA_MISMATCH = "control_schema_mismatch";

export class ControlStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function nowIso(now) {
  return now().toISOString();
}

function requireDatabase() {
  if (!DatabaseSync) throw new ControlStoreError(CONTROL_STORE_UNAVAILABLE, "control_store_unavailable");
}

function assertOwned(info, label) {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new ControlStoreError(CONTROL_STORE_UNAVAILABLE, `${label} must be owned by the current user`);
  }
}

function ensurePrivateDirectory(directory, label) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ControlStoreError(CONTROL_STORE_UNAVAILABLE, `${label} must be a private directory`);
  }
  assertOwned(info, label);
  chmodSync(directory, 0o700);
}

function assertExistingPrivateDatabase(file) {
  let info;
  try {
    info = lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") throw new ControlStoreError(CONTROL_STORE_UNAVAILABLE, "control_store_unavailable");
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ControlStoreError(CONTROL_STORE_UNAVAILABLE, "control_store_unavailable");
  }
  assertOwned(info, "control database");
  if ((info.mode & 0o077) !== 0) {
    throw new ControlStoreError(CONTROL_STORE_UNAVAILABLE, "control_store_unavailable");
  }
}

function assertString(value, field, maxLength = 4096) {
  const text = String(value || "");
  if (!text || text.length > maxLength) throw new TypeError(`${field} must be a bounded non-empty string`);
  return text;
}

function assertOptionalString(value, field, maxLength = 4096) {
  if (value === null || value === undefined) return null;
  return assertString(value, field, maxLength);
}

function eventFields(event) {
  if (!event || typeof event !== "object") throw new TypeError("event must be an object");
  for (const field of ["raw_text", "rawText", "redacted_text", "report", "card", "lesson"]) {
    if (event[field] !== undefined && event[field] !== null) throw new TypeError(`raw text field is not allowed: ${field}`);
  }
  const contextEpoch = Math.floor(Number(event.context_epoch));
  if (!Number.isInteger(contextEpoch) || contextEpoch < 1) throw new TypeError("context_epoch must be a positive integer");
  return {
    event_uid: assertString(event.event_uid, "event_uid", 512),
    session_uid: assertString(event.session_uid, "session_uid", 512),
    cli: assertString(event.cli, "cli", 64),
    project_id: assertOptionalString(event.project_id, "project_id", 1024),
    context_epoch: contextEpoch,
    source_event_id: assertString(event.source_event_id, "source_event_id", 1024),
    source_identity: assertString(event.source_identity, "source_identity", 256),
    role: assertString(event.role, "role", 64),
    referent_event_uid: assertOptionalString(event.referent_event_uid, "referent_event_uid", 512),
    content_hash: assertString(event.content_hash, "content_hash", 128),
    encrypted_raw_ref: assertOptionalString(event.encrypted_raw_ref, "encrypted_raw_ref", 4096),
    completeness: assertString(event.completeness, "completeness", 64)
  };
}

function createStore(database, now) {
  const transaction = (fn) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  };

  return {
    database,
    assertCaptureAllowed(event) {
      return eventFields(event);
    },
    captureSessionEvent(event) {
      const fields = eventFields(event);
      return transaction(() => {
        const existing = database.prepare(`SELECT event_uid FROM session_events
          WHERE event_uid=? OR source_identity=? LIMIT 1`).get(fields.event_uid, fields.source_identity);
        if (existing) return { event_uid: existing.event_uid, duplicate: true };
        const timestamp = nowIso(now);
        database.prepare(`INSERT INTO sessions
          (session_uid, cli, project_id, context_epoch, started_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_uid) DO UPDATE SET
            cli=excluded.cli, project_id=excluded.project_id,
            context_epoch=excluded.context_epoch, updated_at=excluded.updated_at`).run(
          fields.session_uid, fields.cli, fields.project_id, fields.context_epoch, timestamp, timestamp
        );
        database.prepare(`INSERT INTO session_events
          (event_uid, session_uid, source_event_id, source_identity, role, referent_event_uid,
           content_hash, encrypted_raw_ref, completeness, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          fields.event_uid, fields.session_uid, fields.source_event_id, fields.source_identity,
          fields.role, fields.referent_event_uid, fields.content_hash, fields.encrypted_raw_ref,
          fields.completeness, timestamp
        );
        return { event_uid: fields.event_uid, duplicate: false };
      });
    },
    resolveEventObservation(input) {
      if (!input || typeof input !== "object") throw new TypeError("observation input must be an object");
      const observationKey = assertString(input.observation_key, "observation_key", 1024);
      const observationUid = assertString(input.observation_uid, "observation_uid", 512);
      const eventUid = assertString(input.event_uid, "event_uid", 512);
      const captureSource = assertString(input.capture_source, "capture_source", 64);
      return transaction(() => {
        const existing = database.prepare("SELECT observation_uid, event_uid FROM event_observations WHERE observation_key=?").get(observationKey);
        if (existing) return { ...existing, duplicate: true };
        if (!database.prepare("SELECT 1 FROM session_events WHERE event_uid=?").get(eventUid)) {
          throw new TypeError("event_uid must reference a captured session event");
        }
        database.prepare(`INSERT INTO event_observations
          (observation_uid, observation_key, event_uid, capture_source, observed_at)
          VALUES (?, ?, ?, ?, ?)`).run(observationUid, observationKey, eventUid, captureSource, nowIso(now));
        return { observation_uid: observationUid, event_uid: eventUid, duplicate: false };
      });
    },
    getSessionEvent(eventUid) {
      const row = database.prepare(`SELECT event_uid, session_uid, source_event_id, source_identity, role,
        referent_event_uid, content_hash, encrypted_raw_ref, completeness
        FROM session_events WHERE event_uid=?`).get(assertString(eventUid, "event_uid", 512));
      return row ? { ...row } : null;
    },
    close() {
      database.close();
    }
  };
}

export function listUserTables(database) {
  return database.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((row) => row.name);
}

function verifyControlSchema(database, requireSchemaVersion) {
  let versions;
  try {
    versions = database.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => Number(row.version));
  } catch {
    throw new ControlStoreError(CONTROL_SCHEMA_MISMATCH, "control_schema_mismatch");
  }
  if (versions.length !== 1 || versions[0] !== requireSchemaVersion) {
    throw new ControlStoreError(CONTROL_SCHEMA_MISMATCH, "control_schema_mismatch");
  }
  const expected = [
    "event_observations", "reflection_emissions", "review_job_events", "reviewer_jobs",
    "schema_migrations", "session_events", "sessions", "store_meta"
  ];
  if (JSON.stringify(listUserTables(database)) !== JSON.stringify(expected)) {
    throw new ControlStoreError(CONTROL_SCHEMA_MISMATCH, "control_schema_mismatch");
  }
}

export function initializeControlStore({ paths, now = () => new Date() }) {
  requireDatabase();
  if (!paths?.controlDatabase || !paths?.dataRoot) throw new TypeError("paths.controlDatabase and paths.dataRoot are required");
  ensurePrivateDirectory(paths.dataRoot, "data root");
  ensurePrivateDirectory(path.dirname(paths.controlDatabase), "control store directory");
  if (existsSync(paths.controlDatabase)) assertExistingPrivateDatabase(paths.controlDatabase);
  const database = new DatabaseSync(paths.controlDatabase);
  try {
    chmodSync(paths.controlDatabase, 0o600);
    database.exec(SCHEMA_SQL);
    database.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(SCHEMA_VERSION, nowIso(now));
    verifyControlSchema(database, SCHEMA_VERSION);
    return createStore(database, now);
  } catch (error) {
    database.close();
    throw error;
  }
}

export function openControlStore({ paths, now = () => new Date(), requireSchemaVersion = SCHEMA_VERSION }) {
  requireDatabase();
  if (!paths?.controlDatabase) throw new TypeError("paths.controlDatabase is required");
  assertExistingPrivateDatabase(paths.controlDatabase);
  const database = new DatabaseSync(paths.controlDatabase);
  try {
    verifyControlSchema(database, requireSchemaVersion);
    return createStore(database, now);
  } catch (error) {
    database.close();
    throw error;
  }
}
