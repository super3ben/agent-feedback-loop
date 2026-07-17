import { createHash } from "node:crypto";
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

const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const MAX_CONTEXT_EPOCH = 2_147_483_647;
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

function unavailable() {
  return new ControlStoreError(CONTROL_STORE_UNAVAILABLE, CONTROL_STORE_UNAVAILABLE);
}

function requireDatabase() {
  if (!DatabaseSync) throw unavailable();
}

function assertOwned(info, label) {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new ControlStoreError(CONTROL_STORE_UNAVAILABLE, `${label} must be owned by the current user`);
  }
}

function ensurePrivateDirectory(directory, label) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw unavailable();
  assertOwned(info, label);
  chmodSync(directory, 0o700);
}

function assertExistingPrivateDirectory(directory, label) {
  let info;
  try {
    info = lstatSync(directory);
  } catch (error) {
    if (error.code === "ENOENT") throw unavailable();
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0) throw unavailable();
  assertOwned(info, label);
}

function assertExistingPrivateDatabase(file) {
  let info;
  try {
    info = lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") throw unavailable();
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) throw unavailable();
  assertOwned(info, "control database");
}

function assertNoSymlinkPathComponents(target, anchor) {
  const resolved = path.resolve(target);
  const root = path.resolve(anchor);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw unavailable();
  const rootInfo = lstatSync(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw unavailable();
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT") throw unavailable();
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw unavailable();
  }
}

function assertControlDatabasePath(paths) {
  if (!paths?.dataRoot || !paths?.controlDatabase) throw new TypeError("paths.dataRoot and paths.controlDatabase are required");
  const dataRoot = path.resolve(paths.dataRoot);
  const storeRoot = path.join(dataRoot, "store");
  const expected = path.join(storeRoot, "control.sqlite3");
  if (path.resolve(paths.controlDatabase) !== expected) throw unavailable();
  assertNoSymlinkPathComponents(dataRoot, paths.home || path.dirname(dataRoot));
  assertExistingPrivateDirectory(dataRoot, "data root");
  assertExistingPrivateDirectory(storeRoot, "control store directory");
  assertExistingPrivateDatabase(expected);
}

function assertString(value, field, maxLength = 4096) {
  if (typeof value !== "string" || !value || value.length > maxLength) {
    throw new TypeError(`${field} must be a bounded non-empty string`);
  }
  return value;
}

function assertOptionalString(value, field, maxLength = 4096) {
  if (value === null || value === undefined) return null;
  return assertString(value, field, maxLength);
}

function observationKey(provider, sourceNamespace, sourceId) {
  return `${provider}\u0000${sourceNamespace}\u0000${sourceId}`;
}

function observationUid(key) {
  return `observation:${createHash("sha256").update(key).digest("hex")}`;
}

function eventFields(event) {
  if (!event || typeof event !== "object") throw new TypeError("event must be an object");
  for (const field of ["raw_text", "rawText", "report", "card", "lesson"]) {
    if (event[field] !== undefined && event[field] !== null) throw new TypeError(`raw text field is not allowed: ${field}`);
  }
  if (!Number.isSafeInteger(event.context_epoch) || event.context_epoch < 1 || event.context_epoch > MAX_CONTEXT_EPOCH) {
    throw new TypeError("context_epoch must be a bounded positive integer");
  }
  const cli = assertString(event.cli, "cli", 64);
  const sourceNamespace = assertString(event.source_namespace || "hook", "source_namespace", 128);
  const sourceId = assertString(event.observation_source_id || event.source_event_id, "source_event_id", 1024);
  const key = observationKey(cli, sourceNamespace, sourceId);
  return {
    event_uid: assertString(event.event_uid, "event_uid", 512),
    session_uid: assertString(event.session_uid, "session_uid", 512),
    cli,
    project_id: assertOptionalString(event.project_id, "project_id", 1024),
    context_epoch: event.context_epoch,
    source_event_id: assertString(event.source_event_id, "source_event_id", 1024),
    source_identity: assertOptionalString(event.source_identity, "source_identity", 2048) || key,
    observation_key: key,
    observation_uid: observationUid(key),
    observation_capture_source: `${cli}:${sourceNamespace}`,
    role: assertString(event.role, "role", 64),
    referent_event_uid: assertOptionalString(event.referent_event_uid, "referent_event_uid", 512),
    content_hash: assertString(event.content_hash, "content_hash", 128),
    encrypted_raw_ref: assertOptionalString(event.encrypted_raw_ref, "encrypted_raw_ref", 4096),
    completeness: assertString(event.completeness || event.capture_completeness, "completeness", 64)
  };
}

function observationFields(input) {
  if (!input || typeof input !== "object") throw new TypeError("observation input must be an object");
  if (input.observation_key !== undefined || input.event_uid !== undefined) {
    return {
      observation_key: assertString(input.observation_key, "observation_key", 2048),
      observation_uid: assertString(input.observation_uid, "observation_uid", 512),
      event_uid: assertOptionalString(input.event_uid, "event_uid", 512),
      capture_source: assertString(input.capture_source, "capture_source", 256),
      session_uid: null,
      role: null,
      content_hash: null
    };
  }
  const provider = assertString(input.provider, "provider", 64);
  const sourceNamespace = assertString(input.sourceNamespace, "sourceNamespace", 128);
  const sourceId = assertString(input.sourceId, "sourceId", 1024);
  const key = observationKey(provider, sourceNamespace, sourceId);
  return {
    observation_key: key,
    observation_uid: observationUid(key),
    event_uid: null,
    capture_source: `${provider}:${sourceNamespace}`,
    session_uid: assertString(input.sessionUid, "sessionUid", 512),
    role: assertString(input.role, "role", 64),
    content_hash: assertString(input.contentHash, "contentHash", 128)
  };
}

function eventObservation(database, key) {
  return database.prepare(`SELECT o.observation_uid, o.event_uid, o.capture_source,
      e.encrypted_raw_ref, e.session_uid, e.role, e.content_hash
    FROM event_observations o JOIN session_events e ON e.event_uid=o.event_uid
    WHERE o.observation_key=?`).get(key) || null;
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
        const byUid = database.prepare("SELECT event_uid, source_identity FROM session_events WHERE event_uid=?").get(fields.event_uid);
        const byIdentity = database.prepare("SELECT event_uid, source_identity FROM session_events WHERE source_identity=?").get(fields.source_identity);
        if (byUid || byIdentity) {
          if (byUid?.event_uid === byIdentity?.event_uid && byUid.source_identity === fields.source_identity) {
            return { event_uid: byUid.event_uid, duplicate: true };
          }
          throw new ControlStoreError("control_identity_collision", "control identity collision");
        }
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
        database.prepare(`INSERT INTO event_observations
          (observation_uid, observation_key, event_uid, capture_source, observed_at)
          VALUES (?, ?, ?, ?, ?)`).run(
          fields.observation_uid, fields.observation_key, fields.event_uid,
          fields.observation_capture_source, timestamp
        );
        return { event_uid: fields.event_uid, duplicate: false };
      });
    },
    resolveEventObservation(input) {
      const fields = observationFields(input);
      return transaction(() => {
        const existing = eventObservation(database, fields.observation_key);
        if (existing) return { ...existing, duplicate: true };
        if (fields.event_uid) {
          if (!database.prepare("SELECT 1 FROM session_events WHERE event_uid=?").get(fields.event_uid)) {
            throw new TypeError("event_uid must reference a captured session event");
          }
          database.prepare(`INSERT INTO event_observations
            (observation_uid, observation_key, event_uid, capture_source, observed_at)
            VALUES (?, ?, ?, ?, ?)`).run(
            fields.observation_uid, fields.observation_key, fields.event_uid, fields.capture_source, nowIso(now)
          );
          return { observation_uid: fields.observation_uid, event_uid: fields.event_uid, duplicate: false };
        }
        const candidates = database.prepare(`SELECT e.event_uid FROM session_events e
          WHERE e.session_uid=? AND e.role=? AND e.content_hash=?
            AND NOT EXISTS (SELECT 1 FROM event_observations o
              WHERE o.event_uid=e.event_uid AND o.capture_source=?)
          ORDER BY e.created_at, e.event_uid LIMIT 2`).all(
          fields.session_uid, fields.role, fields.content_hash, fields.capture_source
        );
        if (candidates.length !== 1) return null;
        const eventUid = candidates[0].event_uid;
        database.prepare(`INSERT INTO event_observations
          (observation_uid, observation_key, event_uid, capture_source, observed_at)
          VALUES (?, ?, ?, ?, ?)`).run(
          fields.observation_uid, fields.observation_key, eventUid, fields.capture_source, nowIso(now)
        );
        return { ...eventObservation(database, fields.observation_key), duplicate: false };
      });
    },
    getEventObservation(provider, sourceNamespace, sourceId) {
      return eventObservation(
        database,
        observationKey(assertString(provider, "provider", 64), assertString(sourceNamespace, "sourceNamespace", 128), assertString(sourceId, "sourceId", 1024))
      );
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
    throw new ControlStoreError(CONTROL_SCHEMA_MISMATCH, CONTROL_SCHEMA_MISMATCH);
  }
  if (versions.length !== 1 || versions[0] !== requireSchemaVersion) {
    throw new ControlStoreError(CONTROL_SCHEMA_MISMATCH, CONTROL_SCHEMA_MISMATCH);
  }
  const expected = [
    "event_observations", "reflection_emissions", "review_job_events", "reviewer_jobs",
    "schema_migrations", "session_events", "sessions", "store_meta"
  ];
  if (JSON.stringify(listUserTables(database)) !== JSON.stringify(expected)) {
    throw new ControlStoreError(CONTROL_SCHEMA_MISMATCH, CONTROL_SCHEMA_MISMATCH);
  }
}

function configureConnection(database) {
  database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}; PRAGMA foreign_keys = ON;`);
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
    configureConnection(database);
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
  assertControlDatabasePath(paths);
  const database = new DatabaseSync(paths.controlDatabase);
  try {
    configureConnection(database);
    verifyControlSchema(database, requireSchemaVersion);
    return createStore(database, now);
  } catch (error) {
    database.close();
    throw error;
  }
}
