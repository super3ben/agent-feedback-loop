import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  CONTROL_SCHEMA_SIGNATURE,
  CONTROL_SCHEMA_SQL_SIGNATURE,
  SCHEMA_SQL,
  SCHEMA_VERSION
} from "./control-schema.mjs";

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
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || (rootInfo.mode & 0o022) !== 0) throw unavailable();
  assertOwned(rootInfo, "control home");
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
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o022) !== 0) throw unavailable();
    assertOwned(info, "control path component");
  }
}

function assertControlDatabasePath(paths) {
  if (!paths?.home || !paths?.dataRoot || !paths?.controlDatabase) throw new TypeError("paths.home, paths.dataRoot and paths.controlDatabase are required");
  const home = path.resolve(paths.home);
  const dataRoot = path.resolve(paths.dataRoot);
  if (dataRoot !== path.join(home, ".agent", "feedback-loop-data")) throw unavailable();
  const storeRoot = path.join(dataRoot, "store");
  const expected = path.join(storeRoot, "control.sqlite3");
  if (path.resolve(paths.controlDatabase) !== expected) throw unavailable();
  assertNoSymlinkPathComponents(storeRoot, home);
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

function observationKey(provider, sessionUid, contextEpoch, sourceNamespace, sourceId) {
  return JSON.stringify([provider, sessionUid, contextEpoch, sourceNamespace, sourceId]);
}

function observationUid(key) {
  return `observation:${createHash("sha256").update(key).digest("hex")}`;
}

function observationSignature(fields) {
  return createHash("sha256").update(JSON.stringify([
    fields.event_uid ?? null,
    fields.capture_source ?? fields.observation_capture_source,
    fields.source_provider,
    fields.session_uid,
    fields.context_epoch,
    fields.source_namespace,
    fields.source_id ?? fields.observation_source_id,
    fields.native_turn_id,
    fields.source_timestamp,
    fields.role,
    fields.content_hash
  ])).digest("hex");
}

function assertOptionalEpoch(value, field) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONTEXT_EPOCH) {
    throw new TypeError(`${field} must be a bounded positive integer`);
  }
  return value;
}

function collision() {
  return new ControlStoreError("control_observation_collision", "control observation collision");
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
  const sessionUid = assertString(event.session_uid, "session_uid", 512);
  const sourceEventId = assertString(event.source_event_id, "source_event_id", 1024);
  const sourceNamespace = event.source_namespace == null
    ? "hook"
    : assertString(event.source_namespace, "source_namespace", 128);
  const sourceId = event.observation_source_id == null
    ? sourceEventId
    : assertString(event.observation_source_id, "observation_source_id", 1024);
  const suppliedCompleteness = event.completeness == null
    ? null
    : assertString(event.completeness, "completeness", 64);
  const suppliedCaptureCompleteness = event.capture_completeness == null
    ? null
    : assertString(event.capture_completeness, "capture_completeness", 64);
  const completeness = suppliedCompleteness ?? assertString(suppliedCaptureCompleteness, "capture_completeness", 64);
  const key = observationKey(cli, sessionUid, event.context_epoch, sourceNamespace, sourceId);
  if (event.source_identity != null && assertString(event.source_identity, "source_identity", 2048) !== key) throw collision();
  return {
    event_uid: assertString(event.event_uid, "event_uid", 512),
    session_uid: sessionUid,
    cli,
    project_id: assertOptionalString(event.project_id, "project_id", 1024),
    context_epoch: event.context_epoch,
    source_event_id: sourceEventId,
    source_identity: key,
    observation_key: key,
    observation_uid: observationUid(key),
    source_provider: cli,
    source_namespace: sourceNamespace,
    observation_source_id: sourceId,
    observation_capture_source: `${cli}:${sourceNamespace}`,
    role: assertString(event.role, "role", 64),
    referent_event_uid: assertOptionalString(event.referent_event_uid, "referent_event_uid", 512),
    native_turn_id: assertOptionalString(event.native_turn_id ?? event.native_turn, "native_turn_id", 512),
    content_hash: assertString(event.content_hash, "content_hash", 128),
    encrypted_raw_ref: assertOptionalString(event.encrypted_raw_ref, "encrypted_raw_ref", 4096),
    completeness,
    source_timestamp: assertOptionalString(event.source_timestamp, "source_timestamp", 128)
  };
}

function observationFields(input) {
  if (!input || typeof input !== "object") throw new TypeError("observation input must be an object");
  const provider = assertString(input.provider, "provider", 64);
  const sessionUid = assertString(input.sessionUid, "sessionUid", 512);
  const contextEpoch = assertOptionalEpoch(input.contextEpoch ?? input.context_epoch, "contextEpoch");
  const sourceNamespace = assertString(input.sourceNamespace, "sourceNamespace", 128);
  const sourceId = assertString(input.sourceId, "sourceId", 1024);
  const key = contextEpoch == null ? null : observationKey(provider, sessionUid, contextEpoch, sourceNamespace, sourceId);
  return {
    observation_key: key,
    observation_uid: key == null ? null : observationUid(key),
    event_uid: assertOptionalString(input.eventUid ?? input.event_uid, "eventUid", 512),
    capture_source: input.captureSource == null ? `${provider}:${sourceNamespace}` : assertString(input.captureSource, "captureSource", 256),
    source_provider: provider,
    session_uid: sessionUid,
    context_epoch: contextEpoch,
    source_namespace: sourceNamespace,
    source_id: sourceId,
    native_turn_id: assertOptionalString(input.nativeTurnId ?? input.native_turn_id, "nativeTurnId", 512),
    source_timestamp: assertOptionalString(input.sourceTimestamp ?? input.source_timestamp, "sourceTimestamp", 128),
    role: assertString(input.role, "role", 64),
    content_hash: assertString(input.contentHash, "contentHash", 128)
  };
}

function eventObservations(database, fields) {
  const where = fields.context_epoch == null ? "" : " AND o.context_epoch=?";
  return database.prepare(`SELECT o.observation_uid, o.observation_signature, o.observed_event_uid, o.event_uid, o.capture_source,
      o.source_provider AS observation_source_provider,
      o.session_uid AS observation_session_uid, o.context_epoch AS observation_context_epoch,
      o.source_namespace AS observation_source_namespace, o.source_id AS observation_source_id,
      e.encrypted_raw_ref, e.session_uid, e.context_epoch, e.source_provider, e.source_namespace,
      e.observation_source_id AS event_observation_source_id, e.source_identity, e.role, e.native_turn_id, e.content_hash,
      e.source_timestamp, e.completeness
    FROM event_observations o JOIN session_events e ON e.event_uid=o.event_uid
    WHERE o.source_provider=? AND o.session_uid=? AND o.source_namespace=? AND o.source_id=?${where}`).all(
    fields.source_provider, fields.session_uid, fields.source_namespace, fields.source_id,
    ...(fields.context_epoch == null ? [] : [fields.context_epoch])
  );
}

function eventObservation(database, fields) {
  const rows = eventObservations(database, fields);
  if (rows.length > 1) throw collision();
  return rows[0] || null;
}

function sameNullable(left, right) {
  return (left ?? null) === (right ?? null);
}

function sameEvent(row, fields) {
  return row.event_uid === fields.event_uid
    && row.session_uid === fields.session_uid
    && Number(row.context_epoch) === fields.context_epoch
    && row.source_provider === fields.source_provider
    && row.source_namespace === fields.source_namespace
    && row.observation_source_id === fields.observation_source_id
    && row.source_identity === fields.source_identity
    && row.role === fields.role
    && row.content_hash === fields.content_hash
    && sameNullable(row.native_turn_id, fields.native_turn_id)
    && sameNullable(row.source_timestamp, fields.source_timestamp)
    && sameNullable(row.referent_event_uid, fields.referent_event_uid)
    && sameNullable(row.completeness, fields.completeness)
    && sameNullable(row.encrypted_raw_ref, fields.encrypted_raw_ref);
}

function sameObservedEvent(row, fields) {
  return row.observation_signature === observationSignature(fields)
    && (!fields.event_uid || row.observed_event_uid === fields.event_uid)
    && row.observation_source_provider === fields.source_provider
    && row.observation_session_uid === fields.session_uid
    && (fields.context_epoch == null || Number(row.observation_context_epoch) === fields.context_epoch)
    && row.observation_source_namespace === fields.source_namespace
    && row.observation_source_id === fields.source_id
    && row.capture_source === fields.capture_source
    && row.session_uid === fields.session_uid
    && (fields.context_epoch == null || Number(row.context_epoch) === fields.context_epoch)
    && row.source_provider === fields.source_provider
    && row.role === fields.role
    && row.content_hash === fields.content_hash;
}

function sameObservationTarget(row, fields) {
  return (!fields.event_uid || row.observed_event_uid === fields.event_uid)
    && row.session_uid === fields.session_uid
    && (fields.context_epoch == null || Number(row.context_epoch) === fields.context_epoch)
    && row.source_provider === fields.source_provider
    && row.role === fields.role
    && row.content_hash === fields.content_hash
    && sameNullable(row.native_turn_id, fields.native_turn_id)
    && sameNullable(row.source_timestamp, fields.source_timestamp);
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
        const byUid = database.prepare("SELECT * FROM session_events WHERE event_uid=?").get(fields.event_uid);
        const byIdentity = database.prepare("SELECT * FROM session_events WHERE source_identity=?").get(fields.source_identity);
        if (byUid || byIdentity) {
          if (byUid?.event_uid === byIdentity?.event_uid && sameEvent(byUid, fields)) {
            return { event_uid: byUid.event_uid, duplicate: true };
          }
          throw collision();
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
          (event_uid, session_uid, context_epoch, source_provider, source_event_id, source_namespace,
           observation_source_id, source_identity, role, referent_event_uid, native_turn_id,
           content_hash, encrypted_raw_ref, completeness, source_timestamp, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          fields.event_uid, fields.session_uid, fields.context_epoch, fields.source_provider,
          fields.source_event_id, fields.source_namespace, fields.observation_source_id,
          fields.source_identity, fields.role, fields.referent_event_uid, fields.native_turn_id,
          fields.content_hash, fields.encrypted_raw_ref, fields.completeness, fields.source_timestamp, timestamp
        );
        database.prepare(`INSERT INTO event_observations
          (observation_uid, observation_key, observation_signature, source_provider, session_uid, context_epoch,
           source_namespace, source_id, observed_event_uid, event_uid, capture_source, observed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          fields.observation_uid, fields.observation_key, observationSignature(fields), fields.source_provider, fields.session_uid,
          fields.context_epoch, fields.source_namespace, fields.observation_source_id,
          fields.event_uid, fields.event_uid, fields.observation_capture_source, timestamp
        );
        return { event_uid: fields.event_uid, duplicate: false };
      });
    },
    resolveEventObservation(input) {
      const fields = observationFields(input);
      return transaction(() => {
        const existing = eventObservation(database, fields);
        if (existing) {
          if (!sameObservedEvent(existing, fields)) throw collision();
          return { ...existing, duplicate: true };
        }
        if (fields.event_uid) {
          const target = database.prepare("SELECT * FROM session_events WHERE event_uid=?").get(fields.event_uid);
          if (target) {
            if (!sameObservationTarget({ ...target, observed_event_uid: target.event_uid }, fields)) throw collision();
            const contextEpoch = fields.context_epoch ?? Number(target.context_epoch);
            const key = observationKey(fields.source_provider, fields.session_uid, contextEpoch, fields.source_namespace, fields.source_id);
            database.prepare(`INSERT INTO event_observations
              (observation_uid, observation_key, observation_signature, source_provider, session_uid, context_epoch,
               source_namespace, source_id, observed_event_uid, event_uid, capture_source, observed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
              observationUid(key), key, observationSignature(fields), fields.source_provider, fields.session_uid, contextEpoch,
              fields.source_namespace, fields.source_id, fields.event_uid, fields.event_uid, fields.capture_source, nowIso(now)
            );
            return { observation_uid: observationUid(key), event_uid: fields.event_uid, duplicate: false };
          }
        }
        const incomingTimestamp = fields.source_timestamp || nowIso(now);
        if (!Number.isFinite(Date.parse(incomingTimestamp))) return null;
        const contextClause = fields.context_epoch == null ? "" : " AND e.context_epoch=?";
        const selectCandidates = (nativeTurnId) => database.prepare(`SELECT e.* FROM session_events e
          WHERE e.session_uid=? AND e.source_provider=? AND e.role=? AND e.content_hash=?${contextClause}
            AND COALESCE(e.native_turn_id, '')=COALESCE(?, '')
            AND julianday(COALESCE(e.source_timestamp, e.created_at))
              BETWEEN julianday(?) - (5.0 / 1440.0) AND julianday(?) + (5.0 / 1440.0)
            AND NOT EXISTS (SELECT 1 FROM event_observations o
              WHERE o.event_uid=e.event_uid AND o.capture_source=?)
          ORDER BY COALESCE(e.source_timestamp, e.created_at), e.event_uid LIMIT 2`).all(
          fields.session_uid, fields.source_provider, fields.role, fields.content_hash,
          ...(fields.context_epoch == null ? [] : [fields.context_epoch]), nativeTurnId,
          incomingTimestamp, incomingTimestamp, fields.capture_source
        );
        let candidates = selectCandidates(fields.native_turn_id);
        if (!candidates.length && fields.native_turn_id != null) {
          candidates = selectCandidates(null);
        }
        if (candidates.length !== 1) return null;
        const candidate = candidates[0];
        const contextEpoch = Number(candidate.context_epoch);
        const key = observationKey(fields.source_provider, fields.session_uid, contextEpoch, fields.source_namespace, fields.source_id);
        database.prepare(`INSERT INTO event_observations
          (observation_uid, observation_key, observation_signature, source_provider, session_uid, context_epoch,
           source_namespace, source_id, observed_event_uid, event_uid, capture_source, observed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          observationUid(key), key, observationSignature(fields), fields.source_provider, fields.session_uid, contextEpoch,
          fields.source_namespace, fields.source_id, fields.event_uid || candidate.event_uid,
          candidate.event_uid, fields.capture_source, nowIso(now)
        );
        return { ...eventObservation(database, { ...fields, context_epoch: contextEpoch }), duplicate: false };
      });
    },
    getEventObservation(provider, sourceNamespace, sourceId) {
      const rows = database.prepare(`SELECT o.observation_uid, o.event_uid, o.capture_source,
          e.encrypted_raw_ref, e.session_uid, e.role, e.content_hash
        FROM event_observations o JOIN session_events e ON e.event_uid=o.event_uid
        WHERE o.source_provider=? AND o.source_namespace=? AND o.source_id=?`).all(
        assertString(provider, "provider", 64), assertString(sourceNamespace, "sourceNamespace", 128), assertString(sourceId, "sourceId", 1024)
      );
      return rows.length === 1 ? rows[0] : null;
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
  const expected = Object.keys(CONTROL_SCHEMA_SIGNATURE);
  if (JSON.stringify(listUserTables(database)) !== JSON.stringify(expected)) {
    throw new ControlStoreError(CONTROL_SCHEMA_MISMATCH, CONTROL_SCHEMA_MISMATCH);
  }
  const schemaObjects = database.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE type IN ('table', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
  const expectedSchemaObjects = Object.entries(CONTROL_SCHEMA_SQL_SIGNATURE).map(([name, sql]) => ({
    type: "table",
    name,
    tbl_name: name,
    sql
  })).sort((left, right) => left.name.localeCompare(right.name));
  if (JSON.stringify(schemaObjects) !== JSON.stringify(expectedSchemaObjects)) {
    throw new ControlStoreError(CONTROL_SCHEMA_MISMATCH, CONTROL_SCHEMA_MISMATCH);
  }
  for (const [table, signature] of Object.entries(CONTROL_SCHEMA_SIGNATURE)) {
    const escapedTable = table.replaceAll("'", "''");
    const columns = database.prepare(`PRAGMA table_xinfo('${escapedTable}')`).all().map((row) => [
      row.name, row.type, Number(row.notnull), row.dflt_value, Number(row.pk), Number(row.hidden)
    ]);
    const indexes = database.prepare(`PRAGMA index_list('${escapedTable}')`).all().map((row) => {
      const escapedIndex = row.name.replaceAll("'", "''");
      const indexedColumns = database.prepare(`PRAGMA index_xinfo('${escapedIndex}')`).all().map((column) => [
        Number(column.seqno), Number(column.cid), column.name, Number(column.desc), column.coll, Number(column.key)
      ]);
      return [Number(row.unique), row.origin, Number(row.partial), indexedColumns];
    }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const foreignKeys = database.prepare(`PRAGMA foreign_key_list('${escapedTable}')`).all().map((row) => [
      row.table, row.from, row.to, row.on_update, row.on_delete, row.match
    ]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const actual = { columns, indexes, foreignKeys };
    if (JSON.stringify(actual) !== JSON.stringify(signature)) {
      throw new ControlStoreError(CONTROL_SCHEMA_MISMATCH, CONTROL_SCHEMA_MISMATCH);
    }
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
