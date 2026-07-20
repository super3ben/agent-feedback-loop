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
const CAPTURE_IDENTITY_FIELDS = Object.freeze([
  "event_uid",
  "source_provider",
  "session_uid",
  "context_epoch",
  "source_namespace",
  "source_id",
  "source_event_id",
  "source_offset",
  "capture_source",
  "native_turn_id",
  "source_timestamp",
  "role",
  "referent_event_uid",
  "content_hash",
  "completeness"
]);
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

function captureIdentitySignature(identity) {
  return createHash("sha256").update(JSON.stringify([
    ...CAPTURE_IDENTITY_FIELDS.map((field) => identity[field])
  ])).digest("hex");
}

function assertOptionalEpoch(value, field) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONTEXT_EPOCH) {
    throw new TypeError(`${field} must be a bounded positive integer`);
  }
  return value;
}

function assertOptionalSourceOffset(value, field) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a bounded non-negative integer`);
  }
  return value;
}

function collision() {
  return new ControlStoreError("control_observation_collision", "control observation collision");
}

function readAliasGroup(input, aliases, normalize, {
  defaultValue = null,
  conflict = () => new TypeError(`${aliases.join("/")} aliases must identify the same value`)
} = {}) {
  let resolved = defaultValue;
  let supplied = false;
  for (const alias of aliases) {
    const rawValue = input[alias];
    if (rawValue === null || rawValue === undefined) continue;
    const normalizedValue = normalize(rawValue, alias);
    if (supplied && normalizedValue !== resolved) throw conflict();
    resolved = normalizedValue;
    supplied = true;
  }
  return resolved;
}

function normalizedCaptureSource(input, provider, sourceNamespace) {
  return readAliasGroup(
    input,
    ["capture_source", "captureSource"],
    (value, alias) => assertString(value, alias, 256),
    {
      defaultValue: `${provider}:${sourceNamespace}`,
      conflict: () => new TypeError("capture_source and captureSource must identify the same capture source")
    }
  );
}

function normalizedCompleteness(input) {
  return readAliasGroup(
    input,
    ["completeness", "capture_completeness"],
    (value, alias) => assertString(value, alias, 64)
  );
}

function normalizedEncryptedRawRef(input) {
  return readAliasGroup(
    input,
    ["encrypted_raw_ref", "encryptedRawRef"],
    (value, alias) => assertString(value, alias, 4096),
    { conflict: collision }
  );
}

export function normalizeCaptureIdentity(input, { requireEventIdentity = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("capture identity input must be an object");
  }
  const provider = assertString(readAliasGroup(
    input,
    ["source_provider", "provider", "cli"],
    (value) => assertString(value, "source_provider", 64)
  ), "source_provider", 64);
  const sessionUid = assertString(readAliasGroup(
    input,
    ["session_uid", "sessionUid"],
    (value) => assertString(value, "session_uid", 512)
  ), "session_uid", 512);
  const contextEpochValue = readAliasGroup(
    input,
    ["context_epoch", "contextEpoch"],
    (value) => assertOptionalEpoch(value, "context_epoch")
  );
  const contextEpoch = assertOptionalEpoch(contextEpochValue, "context_epoch");
  if (requireEventIdentity && contextEpoch === null) {
    throw new TypeError("context_epoch must be a bounded positive integer");
  }
  const sourceEventValue = readAliasGroup(
    input,
    ["source_event_id", "sourceEventId"],
    (value) => assertOptionalString(value, "source_event_id", 1024)
  );
  const sourceEventId = requireEventIdentity
    ? assertString(sourceEventValue, "source_event_id", 1024)
    : assertOptionalString(sourceEventValue, "source_event_id", 1024);
  const sourceNamespaceValue = readAliasGroup(
    input,
    ["source_namespace", "sourceNamespace"],
    (value) => assertString(value, "source_namespace", 128)
  );
  const sourceNamespace = sourceNamespaceValue == null && requireEventIdentity
    ? "hook"
    : assertString(sourceNamespaceValue, "source_namespace", 128);
  const sourceIdValue = readAliasGroup(
    input,
    ["source_id", "sourceId", "observation_source_id"],
    (value) => assertString(value, "source_id", 1024)
  );
  const sourceId = sourceIdValue == null && requireEventIdentity
    ? sourceEventId
    : assertString(sourceIdValue, "source_id", 1024);
  const eventUidValue = readAliasGroup(
    input,
    ["event_uid", "eventUid"],
    (value) => assertOptionalString(value, "event_uid", 512)
  );
  const completenessValue = normalizedCompleteness(input);
  const identity = {
    event_uid: requireEventIdentity
      ? assertString(eventUidValue, "event_uid", 512)
      : assertOptionalString(eventUidValue, "event_uid", 512),
    source_provider: provider,
    session_uid: sessionUid,
    context_epoch: contextEpoch,
    source_namespace: sourceNamespace,
    source_id: sourceId,
    source_event_id: sourceEventId,
    source_offset: readAliasGroup(
      input,
      ["source_offset", "sourceOffset"],
      (value) => assertOptionalSourceOffset(value, "source_offset")
    ),
    capture_source: normalizedCaptureSource(input, provider, sourceNamespace),
    native_turn_id: readAliasGroup(
      input,
      ["native_turn_id", "nativeTurnId", "native_turn"],
      (value) => assertOptionalString(value, "native_turn_id", 512)
    ),
    source_timestamp: readAliasGroup(
      input,
      ["source_timestamp", "sourceTimestamp"],
      (value) => assertOptionalString(value, "source_timestamp", 128)
    ),
    role: assertString(input.role, "role", 64),
    referent_event_uid: readAliasGroup(
      input,
      ["referent_event_uid", "referentEventUid"],
      (value) => assertOptionalString(value, "referent_event_uid", 512)
    ),
    content_hash: assertString(readAliasGroup(
      input,
      ["content_hash", "contentHash"],
      (value) => assertString(value, "content_hash", 128)
    ), "content_hash", 128),
    completeness: requireEventIdentity
      ? assertString(completenessValue, "completeness", 64)
      : assertOptionalString(completenessValue, "completeness", 64)
  };
  return Object.freeze(identity);
}

function eventFields(event) {
  if (!event || typeof event !== "object") throw new TypeError("event must be an object");
  for (const field of ["raw_text", "rawText", "report", "card", "lesson"]) {
    if (event[field] !== undefined && event[field] !== null) throw new TypeError(`raw text field is not allowed: ${field}`);
  }
  const identity = normalizeCaptureIdentity(event, { requireEventIdentity: true });
  const key = observationKey(
    identity.source_provider,
    identity.session_uid,
    identity.context_epoch,
    identity.source_namespace,
    identity.source_id
  );
  if (event.source_identity != null && assertString(event.source_identity, "source_identity", 2048) !== key) throw collision();
  return {
    identity,
    ...identity,
    cli: identity.source_provider,
    project_id: assertOptionalString(event.project_id, "project_id", 1024),
    source_identity: key,
    observation_key: key,
    observation_uid: observationUid(key),
    observation_source_id: identity.source_id,
    encrypted_raw_ref: normalizedEncryptedRawRef(event)
  };
}

export function prepareCapture({ event, rawText }) {
  const fields = eventFields(event);
  const identity = Object.freeze({ ...fields.identity });
  return Object.freeze({
    identity,
    signature: captureIdentitySignature(identity),
    projectId: fields.project_id,
    sourceIdentity: fields.source_identity,
    observationKey: fields.observation_key,
    observationUid: fields.observation_uid,
    suppliedEncryptedRawRef: fields.encrypted_raw_ref,
    blobContentHash: createHash("sha256").update(String(rawText)).digest("hex")
  });
}

function observationFields(input) {
  const identity = normalizeCaptureIdentity(input);
  const key = identity.context_epoch == null ? null : observationKey(
    identity.source_provider,
    identity.session_uid,
    identity.context_epoch,
    identity.source_namespace,
    identity.source_id
  );
  return {
    identity,
    ...identity,
    signature: captureIdentitySignature(identity),
    observation_key: key,
    observation_uid: key == null ? null : observationUid(key),
    encrypted_raw_ref: normalizedEncryptedRawRef(input)
  };
}

function eventObservations(database, fields) {
  const where = fields.context_epoch == null ? "" : " AND o.context_epoch=?";
  return database.prepare(`SELECT o.observation_uid, o.observation_key, o.observation_signature,
      o.observed_event_uid, o.event_uid, o.capture_source, o.observed_at,
      o.source_provider AS observation_source_provider,
      o.session_uid AS observation_session_uid, o.context_epoch AS observation_context_epoch,
      o.source_namespace AS observation_source_namespace, o.source_id AS observation_source_id,
      e.encrypted_raw_ref, e.session_uid, e.context_epoch, e.source_provider, e.source_namespace,
      e.observation_source_id AS event_observation_source_id, e.source_identity, e.role, e.native_turn_id, e.content_hash,
      e.source_timestamp, e.completeness, e.created_at
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

function sameEncryptedRawRef(row, fields) {
  return (row.encrypted_raw_ref ?? null) === fields.encrypted_raw_ref;
}

function sameObservationBinding(row, fields) {
  const boundKey = observationKey(
    fields.source_provider,
    fields.session_uid,
    Number(row.observation_context_epoch),
    fields.source_namespace,
    fields.source_id
  );
  return row.observation_key === boundKey
    && row.observation_signature === (fields.signature ?? captureIdentitySignature(fields.identity))
    && (!fields.event_uid || row.observed_event_uid === fields.event_uid)
    && row.observation_source_provider === fields.source_provider
    && row.observation_session_uid === fields.session_uid
    && (fields.context_epoch == null || Number(row.observation_context_epoch) === fields.context_epoch)
    && row.observation_source_namespace === fields.source_namespace
    && row.observation_source_id === fields.source_id
    && row.capture_source === fields.capture_source;
}

function targetCompatibility(fields, timestampFallback) {
  return {
    session_uid: fields.session_uid,
    source_provider: fields.source_provider,
    context_epoch: fields.context_epoch,
    role: fields.role,
    content_hash: fields.content_hash,
    native_turn_id: fields.native_turn_id,
    source_timestamp: fields.source_timestamp ?? timestampFallback,
    completeness: fields.completeness
  };
}

function sameTargetEvent(row, target, {
  exactNativeTurn = false,
  exactTimestamp = false
} = {}) {
  const incomingTimestampValue = target.source_timestamp;
  const persistedTimestampValue = row.source_timestamp ?? row.created_at;
  const incomingTimestamp = Date.parse(incomingTimestampValue);
  const persistedTimestamp = Date.parse(persistedTimestampValue);
  const timestampMatches = exactTimestamp
    ? (row.source_timestamp ?? null) === incomingTimestampValue
    : persistedTimestampValue === incomingTimestampValue
      || (Number.isFinite(incomingTimestamp)
        && Number.isFinite(persistedTimestamp)
        && Math.abs(incomingTimestamp - persistedTimestamp) <= 5 * 60 * 1000);
  const nativeTurnMatches = (row.native_turn_id ?? null) === target.native_turn_id
    || (!exactNativeTurn && row.native_turn_id == null && target.native_turn_id != null);
  return row.session_uid === target.session_uid
    && row.source_provider === target.source_provider
    && (target.context_epoch == null || Number(row.context_epoch) === target.context_epoch)
    && row.role === target.role
    && row.content_hash === target.content_hash
    && nativeTurnMatches
    && timestampMatches
    && (target.completeness == null || row.completeness === target.completeness);
}

function samePreparedCaptureBinding(row, fields) {
  return sameObservationBinding(row, fields)
    && sameTargetEvent(row, targetCompatibility(fields, row.observed_at));
}

function sameObservationTarget(row, fields) {
  return (!fields.event_uid || row.observed_event_uid === fields.event_uid)
    && sameTargetEvent(row, targetCompatibility(fields, fields.source_timestamp), {
      exactNativeTurn: true,
      exactTimestamp: true
    });
}

function requireCompatibleDirectRef(row, fields) {
  if (fields.encrypted_raw_ref !== null && !sameEncryptedRawRef(row, fields)) throw collision();
}

function captureFields(preparedCapture, authoritativeEncryptedRef) {
  if (!preparedCapture || !Object.isFrozen(preparedCapture)
      || !preparedCapture.identity || !Object.isFrozen(preparedCapture.identity)) {
    throw new TypeError("preparedCapture must be a frozen prepared capture");
  }
  const identity = preparedCapture.identity;
  const key = observationKey(
    identity.source_provider,
    identity.session_uid,
    identity.context_epoch,
    identity.source_namespace,
    identity.source_id
  );
  if (preparedCapture.signature !== captureIdentitySignature(identity)
      || preparedCapture.sourceIdentity !== key
      || preparedCapture.observationKey !== key
      || preparedCapture.observationUid !== observationUid(key)) {
    throw collision();
  }
  return {
    identity,
    ...identity,
    signature: preparedCapture.signature,
    cli: identity.source_provider,
    project_id: assertOptionalString(preparedCapture.projectId, "projectId", 1024),
    source_identity: preparedCapture.sourceIdentity,
    observation_key: preparedCapture.observationKey,
    observation_uid: preparedCapture.observationUid,
    observation_source_id: identity.source_id,
    encrypted_raw_ref: authoritativeEncryptedRef
  };
}

function captureResolution(kind, eventRow, observationRow) {
  const eventView = Object.freeze({
    event_uid: eventRow.event_uid,
    session_uid: eventRow.session_uid,
    source_event_id: eventRow.source_event_id,
    source_identity: eventRow.source_identity,
    role: eventRow.role,
    referent_event_uid: eventRow.referent_event_uid ?? null,
    content_hash: eventRow.content_hash,
    encrypted_raw_ref: eventRow.encrypted_raw_ref ?? null,
    completeness: eventRow.completeness
  });
  const observation = Object.freeze({
    observation_uid: observationRow.observation_uid,
    observation_key: observationRow.observation_key,
    observed_event_uid: observationRow.observed_event_uid,
    event_uid: observationRow.event_uid,
    capture_source: observationRow.capture_source
  });
  return {
    kind,
    duplicate: kind !== "new",
    eventUid: eventView.event_uid,
    blobPath: eventView.encrypted_raw_ref,
    eventView,
    observation
  };
}

function withCaptureAliases(resolution) {
  return {
    ...resolution,
    event_uid: resolution.eventUid,
    event: resolution.eventView
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

  const insertObservation = (fields, eventUid, timestamp) => {
    database.prepare(`INSERT INTO event_observations
      (observation_uid, observation_key, observation_signature, source_provider, session_uid, context_epoch,
       source_namespace, source_id, observed_event_uid, event_uid, capture_source, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      fields.observation_uid, fields.observation_key, fields.signature,
      fields.source_provider, fields.session_uid, fields.context_epoch,
      fields.source_namespace, fields.observation_source_id,
      fields.event_uid, eventUid, fields.capture_source, timestamp
    );
    return database.prepare("SELECT * FROM event_observations WHERE observation_key=?").get(fields.observation_key);
  };

  const selectCompatibleTargetCandidates = (target, nativeTurnId) => database.prepare(`SELECT e.*
    FROM session_events e
    WHERE e.session_uid = ?
      AND e.source_provider = ?
      AND e.role = ?
      AND e.content_hash = ?
      AND (? IS NULL OR e.context_epoch = ?)
      AND (? IS NULL OR e.completeness = ?)
      AND COALESCE(e.native_turn_id, '') = COALESCE(?, '')
      AND julianday(COALESCE(e.source_timestamp, e.created_at))
          BETWEEN julianday(?) - (5.0 / 1440.0)
              AND julianday(?) + (5.0 / 1440.0)
    ORDER BY COALESCE(e.source_timestamp, e.created_at), e.event_uid
    LIMIT 2`).all(
    target.session_uid, target.source_provider, target.role, target.content_hash,
    target.context_epoch, target.context_epoch,
    target.completeness, target.completeness,
    nativeTurnId, target.source_timestamp, target.source_timestamp
  );

  const compatibleTargetCandidates = (target) => {
    let candidates = selectCompatibleTargetCandidates(target, target.native_turn_id);
    if (!candidates.length && target.native_turn_id != null) {
      candidates = selectCompatibleTargetCandidates(target, null);
    }
    return candidates;
  };

  const resolveOrInsertCapture = ({ preparedCapture, authoritativeEncryptedRef }) => {
    const authoritativeRef = authoritativeEncryptedRef == null
      ? null
      : assertString(authoritativeEncryptedRef, "authoritativeEncryptedRef", 4096);
    const fields = captureFields(preparedCapture, authoritativeRef);
    return transaction(() => {
      const existingObservation = eventObservation(database, fields);
      if (existingObservation) {
        if (!samePreparedCaptureBinding(existingObservation, fields)
            || !sameEncryptedRawRef(existingObservation, fields)) {
          throw collision();
        }
        const eventRow = database.prepare("SELECT * FROM session_events WHERE event_uid=?")
          .get(existingObservation.event_uid);
        return captureResolution("exact_replay", eventRow, existingObservation);
      }

      const byUid = database.prepare("SELECT * FROM session_events WHERE event_uid=?").get(fields.event_uid);
      const byIdentity = database.prepare("SELECT * FROM session_events WHERE source_identity=?").get(fields.source_identity);
      if (byUid || byIdentity) throw collision();

      const existingSession = database.prepare("SELECT cli FROM sessions WHERE session_uid=?").get(fields.session_uid);
      if (existingSession && existingSession.cli !== fields.cli) throw collision();

      const timestamp = nowIso(now);
      const candidates = compatibleTargetCandidates(targetCompatibility(fields, timestamp));
      if (candidates.length === 1 && sameEncryptedRawRef(candidates[0], fields)) {
        const observation = insertObservation(fields, candidates[0].event_uid, timestamp);
        return captureResolution("alias", candidates[0], observation);
      }

      database.prepare(`INSERT INTO sessions
        (session_uid, cli, project_id, context_epoch, started_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_uid) DO UPDATE SET
          project_id=excluded.project_id, context_epoch=excluded.context_epoch,
          updated_at=excluded.updated_at`).run(
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
      const eventRow = database.prepare("SELECT * FROM session_events WHERE event_uid=?").get(fields.event_uid);
      const observation = insertObservation(fields, fields.event_uid, timestamp);
      return captureResolution("new", eventRow, observation);
    });
  };

  return {
    database,
    assertCaptureAllowed(event) {
      return eventFields(event);
    },
    resolveOrInsertCapture,
    captureSessionEvent(event) {
      const preparedCapture = prepareCapture({ event, rawText: "" });
      return withCaptureAliases(resolveOrInsertCapture({
        preparedCapture,
        authoritativeEncryptedRef: preparedCapture.suppliedEncryptedRawRef
      }));
    },
    resolveEventObservation(input) {
      const fields = observationFields(input);
      return transaction(() => {
        const existing = eventObservation(database, fields);
        if (existing) {
          if (!samePreparedCaptureBinding(existing, fields)) throw collision();
          requireCompatibleDirectRef(existing, fields);
          return { ...existing, duplicate: true };
        }
        if (fields.event_uid) {
          const target = database.prepare("SELECT * FROM session_events WHERE event_uid=?").get(fields.event_uid);
          if (target) {
            if (!sameObservationTarget({ ...target, observed_event_uid: target.event_uid }, fields)) throw collision();
            requireCompatibleDirectRef(target, fields);
            const contextEpoch = fields.context_epoch ?? Number(target.context_epoch);
            const key = observationKey(fields.source_provider, fields.session_uid, contextEpoch, fields.source_namespace, fields.source_id);
            database.prepare(`INSERT INTO event_observations
              (observation_uid, observation_key, observation_signature, source_provider, session_uid, context_epoch,
               source_namespace, source_id, observed_event_uid, event_uid, capture_source, observed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
              observationUid(key), key, captureIdentitySignature(fields.identity), fields.source_provider, fields.session_uid, contextEpoch,
              fields.source_namespace, fields.source_id, fields.event_uid, fields.event_uid, fields.capture_source, nowIso(now)
            );
            return {
              ...eventObservation(database, { ...fields, context_epoch: contextEpoch }),
              duplicate: false
            };
          }
        }
        const incomingTimestamp = fields.source_timestamp || nowIso(now);
        if (!Number.isFinite(Date.parse(incomingTimestamp))) return null;
        const candidates = compatibleTargetCandidates(targetCompatibility(fields, incomingTimestamp));
        if (candidates.length !== 1) return null;
        const candidate = candidates[0];
        requireCompatibleDirectRef(candidate, fields);
        const contextEpoch = Number(candidate.context_epoch);
        const key = observationKey(fields.source_provider, fields.session_uid, contextEpoch, fields.source_namespace, fields.source_id);
        database.prepare(`INSERT INTO event_observations
          (observation_uid, observation_key, observation_signature, source_provider, session_uid, context_epoch,
           source_namespace, source_id, observed_event_uid, event_uid, capture_source, observed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          observationUid(key), key, captureIdentitySignature(fields.identity), fields.source_provider, fields.session_uid, contextEpoch,
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
    WHERE type IN ('table', 'trigger', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
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
