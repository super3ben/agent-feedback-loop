import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.mjs";
import { containsReceiptMarker, detectReceiptLanguage, validateReceiptPayload } from "./receipt.mjs";

const SQLITE_BUSY_TIMEOUT_MS = 5_000;
import { validateReviewQuality } from "./lessons.mjs";
import { redactText } from "./capture.mjs";

const require = createRequire(import.meta.url);
let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

export class CapturePolicyError extends Error {}
export class RevisionConflictError extends Error {}
export class LeaseConflictError extends Error {}

const EFFECTIVENESS_FAILURE_MODES = new Set([
  "not_materialized", "not_selected", "delivery_unconfirmed", "loaded_not_applied",
  "contract_incomplete", "external_limit", "unknown"
]);
const EFFECTIVENESS_OWNERS = new Set([
  "capture_adapter", "reviewer_runner", "reviewer", "store", "compiler", "selector",
  "delivery_adapter", "agent_execution", "lesson_contract", "external", "unknown"
]);
const SEVERITY_RANK = Object.freeze({ Minor: 0, Major: 1, Critical: 2, Blocker: 3 });
const NOTIFICATION_TRANSPORTS = new Set(["codex_thread", "system", "audit", "legacy_model_echo"]);
const CLAIMABLE_NOTIFICATION_TRANSPORTS = new Set(["codex_thread", "system"]);
const NOTIFICATION_DELIVERY_STATES = new Set([
  "pending", "delivering", "accepted", "observed", "failed", "unsupported", "suppressed", "audited_only"
]);
const ENSURABLE_NOTIFICATION_DELIVERY_STATES = new Set(["pending", "failed", "unsupported", "suppressed", "audited_only"]);
const DISPATCHED_NOTIFICATION_KINDS = new Set(["review_completed", "reviewed_no_lesson", "review_exhausted"]);

function validateEffectiveness(effectiveness, { previousLesson, delivery }) {
  if (!effectiveness || typeof effectiveness !== "object") throw new TypeError("recurring lesson requires an effectiveness audit");
  if (effectiveness.previous_lesson_id !== previousLesson.lesson_id) throw new TypeError("effectiveness previous_lesson_id does not match the applicable lesson");
  if (Number(effectiveness.expected_revision) !== Number(previousLesson.current_revision)) throw new TypeError("effectiveness expected_revision is stale");
  if (typeof effectiveness.was_applicable !== "boolean") throw new TypeError("effectiveness was_applicable must be boolean");
  if (effectiveness.was_followed !== null && typeof effectiveness.was_followed !== "boolean") throw new TypeError("effectiveness was_followed must be boolean or null");
  if (!EFFECTIVENESS_FAILURE_MODES.has(effectiveness.failure_mode)) throw new TypeError("effectiveness failure_mode is invalid");
  if (!EFFECTIVENESS_OWNERS.has(effectiveness.control_owner)) throw new TypeError("effectiveness control_owner is invalid");
  if (!String(effectiveness.corrective_action || "").trim()) throw new TypeError("effectiveness corrective_action is required");
  const claimedState = String(effectiveness.delivery_state || "");
  if (delivery) {
    if (delivery.lesson_id !== previousLesson.lesson_id || Number(delivery.revision) !== Number(previousLesson.current_revision)) {
      throw new TypeError("effectiveness application does not reference the expected lesson revision");
    }
    if (claimedState !== delivery.state) throw new TypeError("effectiveness delivery_state does not match the stored receipt");
  } else if (effectiveness.application_id || !["not_found", "selected"].includes(claimedState)) {
    throw new TypeError("effectiveness without a delivery receipt must use not_found or selected");
  }
  if (effectiveness.failure_mode === "delivery_unconfirmed" && claimedState !== "emitted_unconfirmed") {
    throw new TypeError("delivery_unconfirmed requires an emitted_unconfirmed receipt");
  }
  if (effectiveness.failure_mode === "loaded_not_applied" && (claimedState !== "observed" || effectiveness.was_applicable !== true || effectiveness.was_followed !== false)) {
    throw new TypeError("loaded_not_applied requires observed, applicable, and not followed evidence");
  }
  return effectiveness;
}

function sanitizeStructured(value) {
  if (typeof value === "string") return redactText(value).text;
  if (Array.isArray(value)) return value.map(sanitizeStructured);
  if (!value || typeof value !== "object") return value;
  const sanitized = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "reviewer_capability" || key === "report_content") continue;
    sanitized[key] = sanitizeStructured(item);
  }
  return sanitized;
}

function boundedText(value, maxChars, marker = "...[truncated]...") {
  const text = redactText(String(value || "")).text;
  if (text.length <= maxChars) return text;
  if (maxChars <= marker.length) return marker.slice(0, maxChars);
  const side = Math.floor((maxChars - marker.length) / 2);
  return `${text.slice(0, side)}${marker}${text.slice(-(maxChars - marker.length - side))}`;
}

function boundedStructured(value, maxChars) {
  const sanitized = sanitizeStructured(value);
  const serialized = JSON.stringify(sanitized ?? null);
  if (serialized.length <= maxChars) return sanitized;
  const prefix = '{"truncated":true,"preview":';
  const suffix = "}";
  const previewBudget = Math.max(0, maxChars - prefix.length - suffix.length - 2);
  return { truncated: true, preview: boundedText(serialized, previewBudget) };
}

function parseJsonOr(value, fallback) {
  try { return JSON.parse(value || JSON.stringify(fallback)); } catch { return fallback; }
}

function validateLessonEvidence(db, job, lesson) {
  const findFeedback = db.prepare(`SELECT e.rowid AS storage_order, e.event_uid, e.project_id, e.role, e.redacted_text, e.source_timestamp
    FROM queue_events q JOIN session_events e ON e.event_uid=q.event_uid
    WHERE q.job_id=? AND e.event_uid=?`);
  const findReferent = db.prepare("SELECT rowid AS storage_order, event_uid, project_id, role, source_timestamp FROM session_events WHERE event_uid=?");
  for (const evidence of lesson.evidence_refs || []) {
    const feedback = findFeedback.get(job.job_id, evidence.feedback_event_id);
    if (!feedback || feedback.role !== "user") {
      throw new TypeError(`evidence feedback event is not a user event assigned to this review job: ${evidence.feedback_event_id}`);
    }
    const feedbackQuote = String(evidence.feedback_quote || "").trim();
    if (!feedbackQuote || !String(feedback.redacted_text || "").includes(feedbackQuote)) {
      throw new TypeError(`evidence feedback quote is not an exact excerpt of the referenced user event: ${evidence.feedback_event_id}`);
    }
    let hasAssistantReferent = false;
    for (const referentId of evidence.referent_event_ids || []) {
      const referent = findReferent.get(referentId);
      if (!referent) throw new TypeError(`evidence referent event does not exist: ${referentId}`);
      if ((referent.project_id || null) !== (feedback.project_id || null)) {
        throw new TypeError(`evidence referent belongs to a different project: ${referentId}`);
      }
      const referentTime = Date.parse(referent.source_timestamp || "");
      const feedbackTime = Date.parse(feedback.source_timestamp || "");
      const referentPrecedes = Number.isFinite(referentTime) && Number.isFinite(feedbackTime)
        ? referentTime < feedbackTime
        : Number(referent.storage_order) < Number(feedback.storage_order);
      if (!referentPrecedes) {
        throw new TypeError(`evidence referent must precede the feedback event: ${referentId}`);
      }
      if (referent.role === "assistant") hasAssistantReferent = true;
    }
    if (!hasAssistantReferent) throw new TypeError("evidence must include a prior assistant referent");
  }
}

function incidentForLesson(job, lesson) {
  const eventUids = [...new Set((lesson.evidence_refs || []).flatMap((evidence) => [
    evidence.feedback_event_id,
    ...(evidence.referent_event_ids || [])
  ]))].sort();
  const projectId = lesson.project_id || job.project_id || null;
  const incidentFingerprint = createHash("sha256")
    .update(`incident:v1\u0000${projectId || "_"}\u0000${eventUids.join("\u0000")}`)
    .digest("hex");
  return { incidentFingerprint, eventUids, projectId };
}

function nowIso(now) {
  return (typeof now === "function" ? now() : now || new Date()).toISOString();
}

function ensureString(value, field) {
  if (!value) throw new TypeError(`${field} is required`);
  return String(value);
}

function ensurePrivateDirectorySync(directory, label) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!info.isDirectory()) throw new Error(`${label} must be a directory`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`${label} must be owned by the current user`);
  chmodSync(directory, 0o700);
}

function migrationEpisodeId(jobId) {
  return createHash("sha256")
    .update(`feedback-episode:migration:v1\u0000${jobId}`)
    .digest("hex");
}

function backfillSchemaV9ControlPlane(db) {
  let deliveries = 0;
  deliveries += db.prepare(`INSERT OR IGNORE INTO notification_deliveries
    (notification_id, transport, state, owner_id, attempt, lease_epoch, lease_until, next_attempt_at,
     ack_id, reason_code, accepted_at, observed_at, created_at, updated_at)
    SELECT notification_id, 'audit', 'audited_only', NULL, 0, 0, NULL, NULL,
      NULL, NULL, NULL, NULL, created_at, updated_at
    FROM notification_outbox`).run().changes;
  deliveries += db.prepare(`INSERT OR IGNORE INTO notification_deliveries
    (notification_id, transport, state, owner_id, attempt, lease_epoch, lease_until, next_attempt_at,
     ack_id, reason_code, accepted_at, observed_at, created_at, updated_at)
    SELECT notification_id, 'system',
      CASE system_state
        WHEN 'not_applicable' THEN 'audited_only'
        WHEN 'pending' THEN 'pending'
        WHEN 'delivering' THEN 'delivering'
        WHEN 'delivered' THEN 'accepted'
        WHEN 'failed' THEN 'failed'
        WHEN 'unsupported' THEN 'unsupported'
        WHEN 'suppressed' THEN 'suppressed'
      END,
      CASE WHEN system_state='delivering' THEN system_owner ELSE NULL END,
      system_attempts, system_lease_epoch,
      CASE WHEN system_state='delivering' THEN system_lease_until ELSE NULL END,
      CASE WHEN system_state IN ('pending','failed') THEN next_attempt_at ELSE NULL END,
      NULL,
      CASE
        WHEN system_reason_code IS NULL THEN NULL
        WHEN length(system_reason_code) BETWEEN 1 AND 64
          AND system_reason_code NOT GLOB '*[^a-z0-9_]*' THEN system_reason_code
        ELSE 'legacy_reason_invalid'
      END,
      CASE WHEN system_state='delivered' THEN COALESCE(system_delivered_at, updated_at) ELSE NULL END,
      NULL, created_at, updated_at
    FROM notification_outbox`).run().changes;
  deliveries += db.prepare(`INSERT OR IGNORE INTO notification_deliveries
    (notification_id, transport, state, owner_id, attempt, lease_epoch, lease_until, next_attempt_at,
     ack_id, reason_code, accepted_at, observed_at, created_at, updated_at)
    SELECT notification_id, 'legacy_model_echo',
      CASE chat_state
        WHEN 'observed' THEN 'observed'
        WHEN 'emitted' THEN 'accepted'
        WHEN 'emitted_unconfirmed' THEN 'accepted'
        WHEN 'pending' THEN 'audited_only'
        WHEN 'suppressed' THEN 'audited_only'
      END,
      NULL, chat_emit_attempts, 0, NULL, NULL,
      CASE WHEN chat_turn_id IS NULL THEN NULL ELSE substr(chat_turn_id, 1, 512) END,
      CASE
        WHEN chat_state='pending' THEN 'legacy_not_emitted'
        WHEN chat_state='suppressed' THEN 'legacy_suppressed'
        ELSE NULL
      END,
      CASE WHEN chat_state IN ('emitted','emitted_unconfirmed','observed')
        THEN COALESCE(chat_emitted_at, updated_at) ELSE NULL END,
      CASE WHEN chat_state='observed' THEN COALESCE(chat_observed_at, updated_at) ELSE NULL END,
      created_at, updated_at
    FROM notification_outbox`).run().changes;

  const findEpisodeSource = db.prepare(`SELECT e.session_uid, e.context_epoch, e.parent_event_id
    FROM queue_events q JOIN session_events e ON e.event_uid=q.event_uid
    WHERE q.job_id=? ORDER BY q.created_at, e.rowid LIMIT 1`);
  const isAssistantReferent = db.prepare("SELECT 1 FROM session_events WHERE event_uid=? AND role='assistant'");
  const insertEpisode = db.prepare(`INSERT OR IGNORE INTO feedback_episodes
    (episode_id, session_uid, context_epoch, project_id, root_referent_event_uid, signal_strength,
     status, reviewer_job_id, opened_at, ready_at, closed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'strong', ?, ?, ?, ?, ?, ?)`);
  const findEpisode = db.prepare("SELECT episode_id FROM feedback_episodes WHERE reviewer_job_id=?");
  const insertEpisodeEvent = db.prepare(`INSERT OR IGNORE INTO feedback_episode_events
    (episode_id, event_uid, relation, signal_reason, created_at)
    SELECT ?, event_uid, 'feedback', 'reconciled_context', created_at
    FROM queue_events WHERE job_id=?`);
  let episodes = 0;
  for (const job of db.prepare("SELECT * FROM reviewer_jobs ORDER BY job_id").all()) {
    const source = findEpisodeSource.get(job.job_id) || null;
    const referentId = source?.parent_event_id && isAssistantReferent.get(source.parent_event_id)
      ? source.parent_event_id
      : null;
    const status = job.status === "completed"
      ? "reviewed"
      : (["pending", "running"].includes(job.status) ? "assigned" : "closed");
    const closedAt = ["reviewed", "closed"].includes(status) ? job.updated_at : null;
    episodes += insertEpisode.run(
      migrationEpisodeId(job.job_id), source?.session_uid || null, source?.context_epoch || null,
      job.project_id || null, referentId, status, job.job_id, job.created_at, job.created_at,
      closedAt, job.updated_at
    ).changes;
    const episode = findEpisode.get(job.job_id);
    if (episode) insertEpisodeEvent.run(episode.episode_id, job.job_id);
  }
  return { deliveries, episodes };
}

export function openStore({ paths, now = () => new Date(), receiptLanguage = process.env.AGENT_FEEDBACK_LOOP_RECEIPT_LANGUAGE || "auto" }) {
  if (!DatabaseSync) throw new Error("transactional SQLite backend unavailable; Node.js 24.15 or newer is required");
  if (!paths?.storeFile) throw new TypeError("paths.storeFile is required");
  const dbPath = paths.storeFile;
  ensurePrivateDirectorySync(paths.dataRoot, "data root");
  ensurePrivateDirectorySync(path.dirname(dbPath), "store directory");
  try {
    if (lstatSync(dbPath).isSymbolicLink()) throw new Error("store path must not be a symlink");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const db = new DatabaseSync(dbPath);
  chmodSync(dbPath, 0o600);
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;`);
  let migrationDiagnostic = null;
  db.exec("BEGIN IMMEDIATE");
  try {
    const migrationTableExists = db.prepare(`SELECT 1 FROM sqlite_master
      WHERE type='table' AND name='schema_migrations'`).get();
    const schemaVersionBeforeMigration = migrationTableExists
      ? Number(db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version)
      : 0;
    db.exec(SCHEMA_SQL);
    for (const statement of [
    "ALTER TABLE session_events ADD COLUMN redaction_manifest_json TEXT",
    "ALTER TABLE session_events ADD COLUMN encrypted_raw_ref TEXT",
    "ALTER TABLE lessons ADD COLUMN severity TEXT NOT NULL DEFAULT 'Major'",
    "ALTER TABLE lessons ADD COLUMN scope_json TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE session_events ADD COLUMN source_namespace TEXT NOT NULL DEFAULT 'hook'",
    "ALTER TABLE session_events ADD COLUMN native_turn_id TEXT",
    "ALTER TABLE session_events ADD COLUMN parent_event_id TEXT",
    "ALTER TABLE session_events ADD COLUMN capture_source TEXT NOT NULL DEFAULT 'prompt_hook'",
    "ALTER TABLE session_events ADD COLUMN capture_completeness TEXT NOT NULL DEFAULT 'prompt_only'",
    "ALTER TABLE session_events ADD COLUMN tool_name TEXT",
    "ALTER TABLE session_events ADD COLUMN tool_args_json TEXT",
    "ALTER TABLE session_events ADD COLUMN textual_output_ref TEXT",
    "ALTER TABLE session_events ADD COLUMN file_refs_json TEXT",
    "ALTER TABLE session_events ADD COLUMN artifact_hashes_json TEXT",
    "ALTER TABLE session_events ADD COLUMN source_timestamp TEXT",
    "ALTER TABLE reviewer_jobs ADD COLUMN wake_attempt INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE reviewer_jobs ADD COLUMN prompted_at INTEGER",
    "ALTER TABLE reviewer_jobs ADD COLUMN next_wake_at INTEGER",
    "ALTER TABLE reviewer_jobs ADD COLUMN capability_hash TEXT",
    "ALTER TABLE reviewer_jobs ADD COLUMN capability_expires_at INTEGER",
    "ALTER TABLE reviewer_jobs ADD COLUMN capability_consumed_at INTEGER",
    "ALTER TABLE reviewer_jobs ADD COLUMN reviewer_provider TEXT",
    "ALTER TABLE notification_outbox ADD COLUMN semantic_key TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE notification_outbox ADD COLUMN system_lease_epoch INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE lessons ADD COLUMN responsibility TEXT",
    "ALTER TABLE lessons ADD COLUMN confidence TEXT",
    "ALTER TABLE lessons ADD COLUMN method_class TEXT",
    "ALTER TABLE lessons ADD COLUMN class_id TEXT",
    "ALTER TABLE lessons ADD COLUMN family_id TEXT",
    "ALTER TABLE lessons ADD COLUMN generalizable INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE lessons ADD COLUMN recurrence_count INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE lessons ADD COLUMN promotion_state TEXT NOT NULL DEFAULT 'project'",
    "ALTER TABLE delivery_receipts ADD COLUMN nonce TEXT",
    "ALTER TABLE lesson_family_evidence ADD COLUMN incident_fingerprint TEXT"
    ]) {
      try { db.exec(statement); } catch (error) {
        if (!/duplicate column name/i.test(error.message)) throw error;
      }
    }
    db.exec(`UPDATE notification_outbox
      SET semantic_key=CASE
        WHEN kind='lesson_delivered' AND application_id IS NOT NULL
          AND json_extract(payload_json, '$.lesson_count')=1 THEN json_array(application_id)
        WHEN kind='lesson_delivered' THEN 'legacy:' || notification_id
        ELSE ''
      END
      WHERE semantic_key='';
      DROP INDEX IF EXISTS notification_outbox_semantic_idx;
      CREATE UNIQUE INDEX notification_outbox_semantic_idx
        ON notification_outbox(
          session_uid, context_epoch, kind,
          IFNULL(job_id, ''), IFNULL(event_uid, ''), IFNULL(application_id, ''), semantic_key
        );`);
    db.exec(`UPDATE session_events SET project_id='unscoped:' || session_uid WHERE project_id IS NULL;
      UPDATE sessions SET project_id='unscoped:' || session_uid WHERE project_id IS NULL;
      UPDATE queue_events SET project_id=(SELECT project_id FROM session_events WHERE session_events.event_uid=queue_events.event_uid) WHERE project_id IS NULL;
      UPDATE reviewer_jobs SET project_id=(SELECT project_id FROM queue_events WHERE queue_events.job_id=reviewer_jobs.job_id LIMIT 1)
        WHERE project_id IS NULL AND EXISTS (SELECT 1 FROM queue_events WHERE queue_events.job_id=reviewer_jobs.job_id);`);
    db.exec("UPDATE reviewer_jobs SET reason_code=NULL, lease_until=NULL WHERE status='completed' AND (reason_code IS NOT NULL OR lease_until IS NOT NULL)");
    if (schemaVersionBeforeMigration > 0 && schemaVersionBeforeMigration < SCHEMA_VERSION) {
      migrationDiagnostic = {
        from: schemaVersionBeforeMigration,
        to: SCHEMA_VERSION,
        ...backfillSchemaV9ControlPlane(db)
      };
    }
    db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(SCHEMA_VERSION, nowIso(now));
    db.prepare("INSERT OR IGNORE INTO store_meta(key, value) VALUES ('capture_policy_revision', '1'), ('capture_enabled', '1')").run();
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    db.close();
    throw error;
  }
  if (migrationDiagnostic) {
    try {
      console.error(`schema.migrated from=${migrationDiagnostic.from} to=${migrationDiagnostic.to} deliveries=${migrationDiagnostic.deliveries} episodes=${migrationDiagnostic.episodes}`);
    } catch {}
  }

  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  };

  const currentPolicy = () => {
    const revision = Number(db.prepare("SELECT value FROM store_meta WHERE key='capture_policy_revision'").get().value);
    const enabled = db.prepare("SELECT value FROM store_meta WHERE key='capture_enabled'").get().value === "1";
    return { revision, enabled };
  };

  const notificationIdFor = ({ sessionUid, contextEpoch, kind, jobId, eventUid, applicationId, semanticKey }) => createHash("sha256")
    .update([
      semanticKey ? "notification:v2" : "notification:v1",
      sessionUid, contextEpoch, kind, jobId || "", eventUid || "", applicationId || "",
      ...(semanticKey ? [semanticKey] : [])
    ].join("\u0000"))
    .digest("hex");

  const notificationLanguage = ({ language, jobId, eventUid, sessionUid, contextEpoch }) => {
    if (language !== undefined && language !== null) return detectReceiptLanguage("", language);
    if (eventUid) {
      const eventSource = db.prepare(`SELECT session_uid, context_epoch, redacted_text
        FROM session_events WHERE event_uid=?`).get(eventUid);
      if (eventSource && (eventSource.session_uid !== sessionUid || Number(eventSource.context_epoch) !== Number(contextEpoch))) {
        throw new TypeError("notification event does not belong to its session and context epoch");
      }
      if (eventSource) return detectReceiptLanguage(eventSource.redacted_text, receiptLanguage);
    }
    if (jobId) {
      const inherited = db.prepare(`SELECT language FROM notification_outbox
        WHERE job_id=? AND session_uid=? AND context_epoch=? AND kind='review_queued'
        ORDER BY created_at, notification_id LIMIT 1`).get(jobId, sessionUid, contextEpoch);
      if (inherited) return inherited.language;
    }
    const source = db.prepare(`SELECT redacted_text FROM session_events
      WHERE session_uid=? AND context_epoch=? AND role='user'
      ORDER BY event_seq DESC, rowid DESC LIMIT 1`).get(sessionUid, contextEpoch);
    return detectReceiptLanguage(source?.redacted_text, receiptLanguage);
  };

  const validateNotificationTransport = (transport, { claimable = false } = {}) => {
    const safeTransport = ensureString(transport, "transport");
    const allowed = claimable ? CLAIMABLE_NOTIFICATION_TRANSPORTS : NOTIFICATION_TRANSPORTS;
    if (!allowed.has(safeTransport)) throw new TypeError(`transport is not ${claimable ? "claimable" : "supported"}`);
    return safeTransport;
  };

  const validateNotificationDeliveryState = (state, { ensurable = false } = {}) => {
    const safeState = ensureString(state, "state");
    const allowed = ensurable ? ENSURABLE_NOTIFICATION_DELIVERY_STATES : NOTIFICATION_DELIVERY_STATES;
    if (!allowed.has(safeState)) throw new TypeError(`notification delivery state is not ${ensurable ? "ensurable" : "valid"}`);
    return safeState;
  };

  const validateNotificationReasonCode = (reasonCode, { required = false } = {}) => {
    if (reasonCode === undefined || reasonCode === null) {
      if (required) throw new TypeError("reasonCode is required");
      return null;
    }
    const safeReasonCode = String(reasonCode);
    if (!/^[a-z0-9_]{1,64}$/.test(safeReasonCode)) throw new TypeError("reasonCode is invalid");
    return safeReasonCode;
  };

  const validateNotificationLeaseEpoch = (leaseEpoch) => {
    const safeLeaseEpoch = Math.floor(Number(leaseEpoch));
    if (!Number.isInteger(safeLeaseEpoch) || safeLeaseEpoch < 1) throw new TypeError("leaseEpoch must be a positive integer");
    return safeLeaseEpoch;
  };

  const readNotificationDelivery = (notificationId, transport) => {
    const delivery = db.prepare(`SELECT * FROM notification_deliveries
      WHERE notification_id=? AND transport=?`).get(notificationId, transport);
    if (!delivery) return null;
    const notification = db.prepare("SELECT * FROM notification_outbox WHERE notification_id=?").get(notificationId);
    return {
      ...delivery,
      notification: notification ? { ...notification, payload: parseJsonOr(notification.payload_json, {}) } : null
    };
  };

  const ensureNotificationDeliveryInTransaction = ({ notificationId, transport, state, reasonCode = null }) => {
    const safeNotificationId = ensureString(notificationId, "notificationId");
    const safeTransport = validateNotificationTransport(transport);
    const safeState = validateNotificationDeliveryState(state, { ensurable: true });
    const safeReasonCode = validateNotificationReasonCode(reasonCode);
    if (safeTransport === "audit" && safeState !== "audited_only") {
      throw new TypeError("audit transport must remain audited_only");
    }
    if (!db.prepare("SELECT 1 FROM notification_outbox WHERE notification_id=?").get(safeNotificationId)) return null;
    const timestamp = nowIso(now);
    const result = db.prepare(`INSERT OR IGNORE INTO notification_deliveries
      (notification_id, transport, state, owner_id, attempt, lease_epoch, lease_until, next_attempt_at,
       ack_id, reason_code, accepted_at, observed_at, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 0, 0, NULL, NULL, NULL, ?, NULL, NULL, ?, ?)`).run(
      safeNotificationId, safeTransport, safeState, safeReasonCode, timestamp, timestamp
    );
    return { changed: result.changes === 1, delivery: readNotificationDelivery(safeNotificationId, safeTransport) };
  };

  const createNotificationInTransaction = ({
    sessionUid, contextEpoch, kind, jobId = null, eventUid = null, applicationId = null,
    semanticKey = null, payload = {}, language
  }) => {
    const safePayload = validateReceiptPayload(kind, payload);
    const safeSessionUid = ensureString(sessionUid, "sessionUid");
    const safeContextEpoch = Math.max(1, Math.floor(Number(contextEpoch) || 1));
    const safeSemanticKey = semanticKey === null
      ? (kind === "lesson_delivered" && applicationId ? JSON.stringify([String(applicationId)]) : "")
      : String(semanticKey);
    const notificationId = notificationIdFor({
      sessionUid: safeSessionUid, contextEpoch: safeContextEpoch, kind, jobId, eventUid, applicationId,
      semanticKey: safeSemanticKey
    });
    const resolvedLanguage = notificationLanguage({
      language, jobId, eventUid, sessionUid: safeSessionUid, contextEpoch: safeContextEpoch
    });
    const chatState = kind === "lesson_delivered" ? "suppressed" : "pending";
    const systemState = ["review_completed", "reviewed_no_lesson", "review_exhausted"].includes(kind) ? "pending" : "not_applicable";
    const timestamp = nowIso(now);
    const inserted = db.prepare(`INSERT INTO notification_outbox
      (notification_id, session_uid, context_epoch, job_id, event_uid, application_id, semantic_key, kind,
       payload_json, language, chat_state, system_state, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING`).run(
      notificationId, safeSessionUid, safeContextEpoch, jobId, eventUid, applicationId, safeSemanticKey, kind,
      JSON.stringify(safePayload), resolvedLanguage, chatState, systemState,
      systemState === "pending" ? 0 : null, timestamp, timestamp
    );
    if (inserted.changes === 1) {
      ensureNotificationDeliveryInTransaction({ notificationId, transport: "audit", state: "audited_only" });
      ensureNotificationDeliveryInTransaction({
        notificationId,
        transport: "codex_thread",
        state: DISPATCHED_NOTIFICATION_KINDS.has(kind) ? "pending" : "audited_only"
      });
    }
    if (kind === "review_queued") {
      db.prepare(`UPDATE notification_outbox SET chat_state='suppressed', updated_at=?
        WHERE session_uid=? AND context_epoch=? AND kind='candidate_captured'
          AND chat_state IN ('pending','emitted','emitted_unconfirmed') AND (? IS NULL OR event_uid=?)`).run(
        timestamp, safeSessionUid, safeContextEpoch, eventUid, eventUid
      );
    } else if (["review_completed", "reviewed_no_lesson", "review_exhausted"].includes(kind)) {
      db.prepare(`UPDATE notification_outbox SET chat_state='suppressed', updated_at=?
        WHERE session_uid=? AND context_epoch=? AND kind IN ('candidate_captured','review_queued')
          AND chat_state IN ('pending','emitted_unconfirmed')
          AND (job_id=? OR (kind='candidate_captured' AND event_uid IN (
            SELECT event_uid FROM notification_outbox WHERE job_id=? AND kind='review_queued'
          )) OR (kind='candidate_captured' AND event_uid IN (
            SELECT event_uid FROM queue_events WHERE job_id=?
          )))`).run(
        timestamp, safeSessionUid, safeContextEpoch, jobId, jobId, jobId
      );
    }
    return db.prepare("SELECT * FROM notification_outbox WHERE notification_id=?").get(notificationId)
      || db.prepare(`SELECT * FROM notification_outbox
        WHERE session_uid=? AND context_epoch=? AND kind=?
          AND IFNULL(job_id, '')=? AND IFNULL(event_uid, '')=? AND IFNULL(application_id, '')=?
          AND semantic_key=?`).get(
        safeSessionUid, safeContextEpoch, kind, jobId || "", eventUid || "", applicationId || "", safeSemanticKey
      );
  };

  const asNotificationRef = (row) => ({
    notification_id: row.notification_id,
    kind: row.kind,
    session_uid: row.session_uid
  });

  const recordReviewerJobEventInTransaction = (job, state, reasonCode = null) => {
    const jobEventId = createHash("sha256")
      .update(["reviewer-job-event:v1", job.job_id, job.lease_epoch, state, reasonCode || ""].join("\u0000"))
      .digest("hex");
    db.prepare(`INSERT OR IGNORE INTO reviewer_job_events
      (job_event_id, job_id, attempt, lease_epoch, state, provider, reason_code, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      jobEventId, job.job_id, Number(job.attempt), Number(job.lease_epoch), state,
      job.reviewer_provider || null, reasonCode, nowIso(now)
    );
    return db.prepare("SELECT * FROM reviewer_job_events WHERE job_event_id=?").get(jobEventId);
  };

  const notificationSessionsForJob = (jobId) => {
    const assignments = db.prepare(`SELECT e.session_uid, e.context_epoch, q.event_uid,
        (SELECT n.language FROM notification_outbox n
          WHERE n.session_uid=e.session_uid AND n.context_epoch=e.context_epoch AND n.event_uid=q.event_uid
            AND (n.kind='candidate_captured' OR (n.kind='review_queued' AND n.job_id=q.job_id))
          ORDER BY CASE n.kind WHEN 'review_queued' THEN 0 ELSE 1 END, n.created_at, n.notification_id
          LIMIT 1) AS language
      FROM queue_events q
      JOIN session_events e ON e.event_uid=q.event_uid
      WHERE q.job_id=? AND EXISTS (
        SELECT 1 FROM notification_outbox n
        WHERE n.session_uid=e.session_uid AND n.context_epoch=e.context_epoch AND n.event_uid=q.event_uid
          AND (n.kind='candidate_captured' OR (n.kind='review_queued' AND n.job_id=q.job_id))
      )
      ORDER BY e.session_uid, e.context_epoch, q.created_at, q.event_uid`).all(jobId);
    const sessions = new Map();
    for (const assignment of assignments) {
      const key = `${assignment.session_uid}\u0000${assignment.context_epoch}`;
      if (!sessions.has(key)) sessions.set(key, assignment);
    }
    return [...sessions.values()];
  };

  const suppressQueueNotificationInTransaction = (jobId, eventUid) => db.prepare(`UPDATE notification_outbox
    SET chat_state='suppressed', updated_at=?
    WHERE job_id=? AND event_uid=? AND kind='review_queued'
      AND chat_state IN ('pending','emitted','emitted_unconfirmed')`).run(
    nowIso(now), jobId, eventUid
  ).changes;

  const createExhaustedNotificationsInTransaction = (jobId, reasonCode) => notificationSessionsForJob(jobId).map((session) =>
    createNotificationInTransaction({
      sessionUid: session.session_uid,
      contextEpoch: session.context_epoch,
      jobId,
      kind: "review_exhausted",
      payload: { reason_code: reasonCode },
      language: session.language
    })
  );

  const createQueueNotificationInTransaction = (jobId, eventUid) => {
    const source = db.prepare("SELECT session_uid, context_epoch FROM session_events WHERE event_uid=?").get(eventUid);
    if (!source) return [];
    return [createNotificationInTransaction({
      sessionUid: source.session_uid,
      contextEpoch: source.context_epoch,
      jobId,
      eventUid,
      kind: "review_queued",
      payload: {}
    })];
  };

  const suppressClaimableChatNotifications = ({ sessionUid, contextEpoch }) => transaction(() => db.prepare(`UPDATE notification_outbox
    SET chat_state='suppressed', updated_at=?
    WHERE session_uid=? AND context_epoch=?
      AND chat_state IN ('pending','emitted','emitted_unconfirmed')`).run(
    nowIso(now), ensureString(sessionUid, "sessionUid"), Math.max(1, Math.floor(Number(contextEpoch) || 1))
  ).changes);

  return {
    path: dbPath,
    capability: { backend: "node:sqlite", schemaVersion: SCHEMA_VERSION },
    createNotification(input) {
      return transaction(() => createNotificationInTransaction(input));
    },
    listNotifications({ sessionUid, jobId } = {}) {
      if (sessionUid !== undefined && jobId !== undefined) {
        return db.prepare("SELECT * FROM notification_outbox WHERE session_uid=? AND job_id=? ORDER BY created_at, notification_id").all(sessionUid, jobId);
      }
      if (sessionUid !== undefined) return db.prepare("SELECT * FROM notification_outbox WHERE session_uid=? ORDER BY created_at, notification_id").all(sessionUid);
      if (jobId !== undefined) return db.prepare("SELECT * FROM notification_outbox WHERE job_id=? ORDER BY created_at, notification_id").all(jobId);
      return db.prepare("SELECT * FROM notification_outbox ORDER BY created_at, notification_id").all();
    },
    ensureNotificationDelivery(input) {
      return transaction(() => ensureNotificationDeliveryInTransaction(input));
    },
    claimNotificationDeliveries({ ownerId, nowMs = Date.now(), leaseMs = 120_000, limit = 8, transports = ["codex_thread", "system"] }) {
      return transaction(() => {
        const safeOwnerId = ensureString(ownerId, "ownerId");
        const safeNowMs = Number(nowMs);
        const safeLeaseMs = Math.max(1, Math.floor(Number(leaseMs) || 120_000));
        const safeLimit = Math.max(1, Math.min(256, Math.floor(Number(limit) || 8)));
        if (!Number.isFinite(safeNowMs)) throw new TypeError("nowMs must be finite");
        if (!Array.isArray(transports)) throw new TypeError("transports must be an array");
        const safeTransports = [...new Set(transports.map((transport) => validateNotificationTransport(transport, { claimable: true })))];
        if (safeTransports.length === 0) return [];
        const placeholders = safeTransports.map(() => "?").join(",");
        const rows = db.prepare(`SELECT notification_id, transport FROM notification_deliveries
          WHERE transport IN (${placeholders}) AND (
            (state='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?))
            OR (state='failed' AND next_attempt_at IS NOT NULL AND next_attempt_at<=?)
            OR (state='delivering' AND lease_until IS NOT NULL AND lease_until<=?)
          )
          ORDER BY COALESCE(next_attempt_at, 0), created_at, notification_id, transport LIMIT ?`).all(
          ...safeTransports, safeNowMs, safeNowMs, safeNowMs, safeLimit
        );
        const claimed = [];
        const timestamp = nowIso(now);
        for (const row of rows) {
          const result = db.prepare(`UPDATE notification_deliveries
            SET state='delivering', owner_id=?, attempt=attempt+1, lease_epoch=lease_epoch+1,
                lease_until=?, next_attempt_at=NULL, reason_code=NULL, updated_at=?
            WHERE notification_id=? AND transport=? AND (
              (state='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?))
              OR (state='failed' AND next_attempt_at IS NOT NULL AND next_attempt_at<=?)
              OR (state='delivering' AND lease_until IS NOT NULL AND lease_until<=?)
            )`).run(
            safeOwnerId, safeNowMs + safeLeaseMs, timestamp, row.notification_id, row.transport,
            safeNowMs, safeNowMs, safeNowMs
          );
          if (result.changes === 1) claimed.push(readNotificationDelivery(row.notification_id, row.transport));
        }
        return claimed;
      });
    },
    acceptNotificationDelivery({ notificationId, transport, ownerId, leaseEpoch, ackId }) {
      const safeNotificationId = ensureString(notificationId, "notificationId");
      const safeTransport = validateNotificationTransport(transport, { claimable: true });
      const safeOwnerId = ensureString(ownerId, "ownerId");
      const safeLeaseEpoch = validateNotificationLeaseEpoch(leaseEpoch);
      const safeAckId = ensureString(ackId, "ackId");
      if (safeAckId.length > 512) throw new TypeError("ackId must be at most 512 characters");
      return transaction(() => {
        if (!readNotificationDelivery(safeNotificationId, safeTransport)) return null;
        const timestamp = nowIso(now);
        const result = db.prepare(`UPDATE notification_deliveries
          SET state='accepted', owner_id=NULL, lease_until=NULL, next_attempt_at=NULL,
              ack_id=?, reason_code=NULL, accepted_at=?, updated_at=?
          WHERE notification_id=? AND transport=? AND state='delivering' AND owner_id=? AND lease_epoch=?`).run(
          safeAckId, timestamp, timestamp, safeNotificationId, safeTransport, safeOwnerId, safeLeaseEpoch
        );
        return { changed: result.changes === 1, delivery: readNotificationDelivery(safeNotificationId, safeTransport) };
      });
    },
    failNotificationDelivery({ notificationId, transport, ownerId, leaseEpoch, reasonCode, retryAt, retryable }) {
      const safeNotificationId = ensureString(notificationId, "notificationId");
      const safeTransport = validateNotificationTransport(transport, { claimable: true });
      const safeOwnerId = ensureString(ownerId, "ownerId");
      const safeLeaseEpoch = validateNotificationLeaseEpoch(leaseEpoch);
      const safeReasonCode = validateNotificationReasonCode(reasonCode, { required: true });
      if (typeof retryable !== "boolean") throw new TypeError("retryable must be boolean");
      const safeRetryAt = retryable ? Number(retryAt) : null;
      if (retryable && !Number.isFinite(safeRetryAt)) throw new TypeError("retryAt must be finite for a retryable failure");
      return transaction(() => {
        if (!readNotificationDelivery(safeNotificationId, safeTransport)) return null;
        const result = db.prepare(`UPDATE notification_deliveries
          SET state='failed', owner_id=NULL, lease_until=NULL, next_attempt_at=?, ack_id=NULL,
              reason_code=?, accepted_at=NULL, observed_at=NULL, updated_at=?
          WHERE notification_id=? AND transport=? AND state='delivering' AND owner_id=? AND lease_epoch=?`).run(
          safeRetryAt, safeReasonCode, nowIso(now), safeNotificationId, safeTransport, safeOwnerId, safeLeaseEpoch
        );
        return { changed: result.changes === 1, delivery: readNotificationDelivery(safeNotificationId, safeTransport) };
      });
    },
    markNotificationUnsupported({ notificationId, transport, ownerId, leaseEpoch, reasonCode }) {
      const safeNotificationId = ensureString(notificationId, "notificationId");
      const safeTransport = validateNotificationTransport(transport, { claimable: true });
      const safeOwnerId = ensureString(ownerId, "ownerId");
      const safeLeaseEpoch = validateNotificationLeaseEpoch(leaseEpoch);
      const safeReasonCode = validateNotificationReasonCode(reasonCode, { required: true });
      return transaction(() => {
        if (!readNotificationDelivery(safeNotificationId, safeTransport)) return null;
        const result = db.prepare(`UPDATE notification_deliveries
          SET state='unsupported', owner_id=NULL, lease_until=NULL, next_attempt_at=NULL, ack_id=NULL,
              reason_code=?, accepted_at=NULL, observed_at=NULL, updated_at=?
          WHERE notification_id=? AND transport=? AND state='delivering' AND owner_id=? AND lease_epoch=?`).run(
          safeReasonCode, nowIso(now), safeNotificationId, safeTransport, safeOwnerId, safeLeaseEpoch
        );
        return { changed: result.changes === 1, delivery: readNotificationDelivery(safeNotificationId, safeTransport) };
      });
    },
    observeNotificationDelivery({ notificationId, transport, observationId, observedAt = nowIso(now) }) {
      const safeNotificationId = ensureString(notificationId, "notificationId");
      const safeTransport = validateNotificationTransport(transport, { claimable: true });
      const safeObservationId = ensureString(observationId, "observationId");
      if (safeObservationId.length > 512) throw new TypeError("observationId must be at most 512 characters");
      const safeObservedAt = ensureString(observedAt, "observedAt");
      if (!Number.isFinite(Date.parse(safeObservedAt))) throw new TypeError("observedAt must be an ISO timestamp");
      return transaction(() => {
        if (!readNotificationDelivery(safeNotificationId, safeTransport)) return null;
        const result = db.prepare(`UPDATE notification_deliveries
          SET state='observed', observed_at=?, updated_at=?
          WHERE notification_id=? AND transport=? AND state='accepted'`).run(
          safeObservedAt, nowIso(now), safeNotificationId, safeTransport
        );
        return { changed: result.changes === 1, delivery: readNotificationDelivery(safeNotificationId, safeTransport) };
      });
    },
    listNotificationDeliveries({ notificationId, sessionUid, state, transport } = {}) {
      const clauses = [];
      const values = [];
      if (notificationId !== undefined) {
        clauses.push("d.notification_id=?");
        values.push(ensureString(notificationId, "notificationId"));
      }
      if (sessionUid !== undefined) {
        clauses.push("n.session_uid=?");
        values.push(ensureString(sessionUid, "sessionUid"));
      }
      if (state !== undefined) {
        clauses.push("d.state=?");
        values.push(validateNotificationDeliveryState(state));
      }
      if (transport !== undefined) {
        clauses.push("d.transport=?");
        values.push(validateNotificationTransport(transport));
      }
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      return db.prepare(`SELECT d.notification_id, d.transport FROM notification_deliveries d
        JOIN notification_outbox n ON n.notification_id=d.notification_id${where}
        ORDER BY d.notification_id, d.transport`).all(...values)
        .map((row) => readNotificationDelivery(row.notification_id, row.transport));
    },
    listReviewerJobEvents(jobId) {
      return db.prepare("SELECT * FROM reviewer_job_events WHERE job_id=? ORDER BY created_at, rowid").all(ensureString(jobId, "jobId"));
    },
    setReviewerProvider({ jobId, provider }) {
      if (!["codex", "claude", "gemini", "explicit_command", "prompt_subagent"].includes(provider)) {
        throw new TypeError("reviewer provider is invalid");
      }
      return transaction(() => db.prepare(`UPDATE reviewer_jobs SET reviewer_provider=?, updated_at=?
        WHERE job_id=? AND status IN ('pending','running')`).run(provider, nowIso(now), ensureString(jobId, "jobId")).changes === 1);
    },
    claimChatNotification({ sessionUid, contextEpoch, nativeTurnId }) {
      return transaction(() => {
        const safeSessionUid = ensureString(sessionUid, "sessionUid");
        const safeTurnId = ensureString(nativeTurnId, "nativeTurnId");
        const safeContextEpoch = Math.max(1, Math.floor(Number(contextEpoch) || 1));
        const alreadyBound = db.prepare(`SELECT 1 FROM notification_outbox
          WHERE session_uid=? AND context_epoch=? AND chat_turn_id=? LIMIT 1`).get(
          safeSessionUid, safeContextEpoch, safeTurnId
        );
        if (alreadyBound) return null;
        const row = db.prepare(`SELECT * FROM notification_outbox
          WHERE session_uid=? AND context_epoch=?
            AND (chat_state='pending' OR (chat_state='emitted_unconfirmed' AND chat_emit_attempts=1))
          ORDER BY CASE kind
            WHEN 'review_completed' THEN 0 WHEN 'reviewed_no_lesson' THEN 0 WHEN 'review_exhausted' THEN 0
            WHEN 'review_queued' THEN 1 WHEN 'candidate_captured' THEN 2 WHEN 'lesson_delivered' THEN 3 ELSE 4 END,
            created_at, notification_id LIMIT 1`).get(safeSessionUid, safeContextEpoch);
        if (!row) return null;
        const timestamp = nowIso(now);
        const updated = db.prepare(`UPDATE notification_outbox
          SET chat_state='emitted', chat_turn_id=?, chat_emit_attempts=chat_emit_attempts+1,
              chat_block_attempted=0, chat_emitted_at=?, updated_at=?
          WHERE notification_id=?
            AND (chat_state='pending' OR (chat_state='emitted_unconfirmed' AND chat_emit_attempts=1))`).run(
          safeTurnId, timestamp, timestamp, row.notification_id
        );
        if (updated.changes !== 1) return null;
        return db.prepare("SELECT * FROM notification_outbox WHERE notification_id=?").get(row.notification_id);
      });
    },
    confirmChatNotification({ sessionUid, contextEpoch, nativeTurnId, transcriptText }) {
      return transaction(() => {
        const row = db.prepare(`SELECT * FROM notification_outbox
          WHERE session_uid=? AND context_epoch=? AND chat_turn_id=? AND chat_state='emitted'
          ORDER BY chat_emitted_at DESC, notification_id LIMIT 1`).get(
          ensureString(sessionUid, "sessionUid"), Math.max(1, Math.floor(Number(contextEpoch) || 1)),
          ensureString(nativeTurnId, "nativeTurnId")
        );
        if (!row) return { action: "pass", notification: null };
        const timestamp = nowIso(now);
        if (containsReceiptMarker(transcriptText, row)) {
          db.prepare(`UPDATE notification_outbox SET chat_state='observed', chat_observed_at=?, updated_at=?
            WHERE notification_id=? AND chat_state='emitted' AND chat_turn_id=?`).run(
            timestamp, timestamp, row.notification_id, nativeTurnId
          );
          return { action: "observed", notification: db.prepare("SELECT * FROM notification_outbox WHERE notification_id=?").get(row.notification_id) };
        }
        if (Number(row.chat_block_attempted) === 0) {
          db.prepare(`UPDATE notification_outbox SET chat_block_attempted=1, updated_at=?
            WHERE notification_id=? AND chat_state='emitted' AND chat_turn_id=? AND chat_block_attempted=0`).run(
            timestamp, row.notification_id, nativeTurnId
          );
          return { action: "block", notification: db.prepare("SELECT * FROM notification_outbox WHERE notification_id=?").get(row.notification_id) };
        }
        db.prepare(`UPDATE notification_outbox SET chat_state='emitted_unconfirmed', updated_at=?
          WHERE notification_id=? AND chat_state='emitted' AND chat_turn_id=? AND chat_block_attempted=1`).run(
          timestamp, row.notification_id, nativeTurnId
        );
        return { action: "pass_unconfirmed", notification: db.prepare("SELECT * FROM notification_outbox WHERE notification_id=?").get(row.notification_id) };
      });
    },
    claimSystemNotifications({ ownerId, nowMs = Date.now(), leaseMs = 120_000, limit = 8 }) {
      return transaction(() => {
        const safeOwnerId = ensureString(ownerId, "ownerId");
        const safeNowMs = Number(nowMs);
        const safeLeaseMs = Math.max(1, Math.floor(Number(leaseMs) || 120_000));
        const safeLimit = Math.max(1, Math.min(256, Math.floor(Number(limit) || 8)));
        if (!Number.isFinite(safeNowMs)) throw new TypeError("nowMs must be finite");
        const rows = db.prepare(`SELECT * FROM notification_outbox
          WHERE ((system_state IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at<=?))
            OR (system_state='delivering' AND system_lease_until IS NOT NULL AND system_lease_until<=?))
          ORDER BY COALESCE(next_attempt_at, 0), created_at, notification_id LIMIT ?`).all(safeNowMs, safeNowMs, safeLimit);
        const claimed = [];
        const timestamp = nowIso(now);
        for (const row of rows) {
          const result = db.prepare(`UPDATE notification_outbox
            SET system_state='delivering', system_owner=?, system_lease_epoch=system_lease_epoch+1,
                system_lease_until=?, system_attempts=system_attempts+1,
                system_reason_code=NULL, updated_at=?
            WHERE notification_id=? AND (
              (system_state IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at<=?))
              OR (system_state='delivering' AND system_lease_until IS NOT NULL AND system_lease_until<=?)
            )`).run(safeOwnerId, safeNowMs + safeLeaseMs, timestamp, row.notification_id, safeNowMs, safeNowMs);
          if (result.changes === 1) claimed.push(db.prepare("SELECT * FROM notification_outbox WHERE notification_id=?").get(row.notification_id));
        }
        return claimed;
      });
    },
    completeSystemNotification({ notificationId, ownerId, leaseEpoch, deliveredAt = nowIso(now) }) {
      const safeLeaseEpoch = Math.floor(Number(leaseEpoch));
      if (!Number.isInteger(safeLeaseEpoch) || safeLeaseEpoch < 1) throw new TypeError("leaseEpoch must be a positive integer");
      return transaction(() => db.prepare(`UPDATE notification_outbox
        SET system_state='delivered', system_owner=NULL, system_lease_until=NULL, next_attempt_at=NULL,
            system_reason_code=NULL, system_delivered_at=?, updated_at=?
        WHERE notification_id=? AND system_state='delivering' AND system_owner=? AND system_lease_epoch=?`).run(
        deliveredAt, nowIso(now), ensureString(notificationId, "notificationId"), ensureString(ownerId, "ownerId"), safeLeaseEpoch
      ).changes === 1);
    },
    failSystemNotification({ notificationId, ownerId, leaseEpoch, reasonCode, nowMs = Date.now() }) {
      return transaction(() => {
        const safeReasonCode = ensureString(reasonCode, "reasonCode");
        if (!/^[a-z0-9_]{1,64}$/.test(safeReasonCode)) throw new TypeError("reasonCode is invalid");
        const safeLeaseEpoch = Math.floor(Number(leaseEpoch));
        if (!Number.isInteger(safeLeaseEpoch) || safeLeaseEpoch < 1) throw new TypeError("leaseEpoch must be a positive integer");
        const safeNowMs = Number(nowMs);
        if (!Number.isFinite(safeNowMs)) throw new TypeError("nowMs must be finite");
        const row = db.prepare(`SELECT system_attempts FROM notification_outbox
          WHERE notification_id=? AND system_state='delivering' AND system_owner=? AND system_lease_epoch=?`).get(
          ensureString(notificationId, "notificationId"), ensureString(ownerId, "ownerId"), safeLeaseEpoch
        );
        if (!row) return false;
        const delay = Math.min(21_600_000, 60_000 * (2 ** Math.max(0, Number(row.system_attempts) - 1)));
        return db.prepare(`UPDATE notification_outbox
          SET system_state='failed', system_owner=NULL, system_lease_until=NULL, next_attempt_at=?,
              system_reason_code=?, updated_at=?
          WHERE notification_id=? AND system_state='delivering' AND system_owner=? AND system_lease_epoch=?`).run(
          safeNowMs + delay, safeReasonCode, nowIso(now), notificationId, ownerId, safeLeaseEpoch
        ).changes === 1;
      });
    },
    markSystemNotificationUnsupported({ notificationId, ownerId, leaseEpoch, reasonCode }) {
      return transaction(() => {
        const safeReasonCode = ensureString(reasonCode, "reasonCode");
        if (!/^[a-z0-9_]{1,64}$/.test(safeReasonCode)) throw new TypeError("reasonCode is invalid");
        const safeLeaseEpoch = Math.floor(Number(leaseEpoch));
        if (!Number.isInteger(safeLeaseEpoch) || safeLeaseEpoch < 1) throw new TypeError("leaseEpoch must be a positive integer");
        return db.prepare(`UPDATE notification_outbox
          SET system_state='unsupported', system_owner=NULL, system_lease_until=NULL, next_attempt_at=NULL,
              system_reason_code=?, updated_at=?
          WHERE notification_id=? AND system_state='delivering' AND system_owner=? AND system_lease_epoch=?`).run(
          safeReasonCode, nowIso(now), ensureString(notificationId, "notificationId"), ensureString(ownerId, "ownerId"), safeLeaseEpoch
        ).changes === 1;
      });
    },
    suppressClaimableChatNotifications(input) {
      return suppressClaimableChatNotifications(input);
    },
    suppressPendingChatNotifications(input) {
      return suppressClaimableChatNotifications(input);
    },
    suppressDueSystemNotifications({ nowMs = Date.now(), reasonCode }) {
      return transaction(() => {
        const safeReasonCode = ensureString(reasonCode, "reasonCode");
        if (!/^[a-z0-9_]{1,64}$/.test(safeReasonCode)) throw new TypeError("reasonCode is invalid");
        const safeNowMs = Number(nowMs);
        if (!Number.isFinite(safeNowMs)) throw new TypeError("nowMs must be finite");
        return db.prepare(`UPDATE notification_outbox
          SET system_state='suppressed', system_owner=NULL, system_lease_until=NULL,
              system_reason_code=?, updated_at=?
          WHERE system_state IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at<=?)`).run(
          safeReasonCode, nowIso(now), safeNowMs
        ).changes;
      });
    },
    getCapturePolicy() { return currentPolicy(); },
    setRuntimeStatus(name, value) {
      return transaction(() => {
        const payload = boundedStructured({ ...(value || {}), updatedAt: nowIso(now) }, 16 * 1024);
        db.prepare(`INSERT INTO store_meta(key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(`runtime_status:${ensureString(name, "name")}`, JSON.stringify(payload));
        return payload;
      });
    },
    getRuntimeStatus(name) {
      const row = db.prepare("SELECT value FROM store_meta WHERE key=?").get(`runtime_status:${ensureString(name, "name")}`);
      return row ? parseJsonOr(row.value, null) : null;
    },
    assertCaptureAllowed(event) {
      const policy = currentPolicy();
      if (!policy.enabled || Number(event.capture_policy_revision) !== policy.revision) {
        throw new CapturePolicyError("capture policy changed or capture is disabled");
      }
    },
    setCapturePolicy({ enabled, revision }) {
      return transaction(() => {
        db.prepare("UPDATE store_meta SET value=? WHERE key='capture_enabled'").run(enabled ? "1" : "0");
        db.prepare("UPDATE store_meta SET value=? WHERE key='capture_policy_revision'").run(String(revision));
        return { enabled: Boolean(enabled), revision };
      });
    },
    captureSessionEvent(event) {
      return transaction(() => {
        const policy = currentPolicy();
        if (!policy.enabled || Number(event.capture_policy_revision) !== policy.revision) {
          throw new CapturePolicyError("capture policy changed or capture is disabled");
        }
        const timestamp = nowIso(now);
        const redactedEventText = event.redacted_text == null ? null : boundedText(event.redacted_text, 128 * 1024);
        const redactionManifest = boundedStructured(event.redaction_manifest || [], 8 * 1024);
        const toolArgs = event.tool_args == null ? null : boundedStructured(event.tool_args, 16 * 1024);
        const fileRefs = boundedStructured(event.file_refs || [], 8 * 1024);
        const artifactHashes = boundedStructured(event.artifact_hashes || [], 8 * 1024);
        db.prepare(`INSERT OR IGNORE INTO sessions
          (session_uid, cli, native_session_id, installation_id, project_id, context_epoch, started_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          ensureString(event.session_uid, "session_uid"), event.cli || "unknown", event.native_session_id || null,
          event.installation_id || "unknown", event.project_id || null, event.context_epoch || 1, timestamp
        );
        db.prepare(`INSERT INTO session_events
          (event_uid, session_uid, event_seq, context_epoch, project_id, source_event_id, source_namespace, native_turn_id,
           parent_event_id, role, redacted_text, redaction_manifest_json, encrypted_raw_ref, content_hash,
           capture_policy_revision, data_class, capture_source, capture_completeness, tool_name, tool_args_json,
           textual_output_ref, file_refs_json, artifact_hashes_json, source_timestamp, captured_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          ensureString(event.event_uid, "event_uid"), event.session_uid, event.event_seq, event.context_epoch,
          event.project_id || null, event.source_event_id || null, event.source_namespace || "hook",
          event.native_turn_id || event.native_turn || null, event.parent_event_id || null, event.role, redactedEventText,
          JSON.stringify(redactionManifest), event.encrypted_raw_ref || null, event.content_hash,
          event.capture_policy_revision, event.data_class || "normal", event.capture_source || "prompt_hook",
          event.capture_completeness || "prompt_only", event.tool_name ? boundedText(event.tool_name, 512) : null,
          toolArgs == null ? null : JSON.stringify(toolArgs), event.textual_output_ref ? boundedText(event.textual_output_ref, 4 * 1024) : null,
          JSON.stringify(fileRefs), JSON.stringify(artifactHashes), event.source_timestamp || null, timestamp
        );
        if (event.source_event_id) {
          db.prepare(`INSERT OR IGNORE INTO event_observations
            (provider, source_namespace, source_id, event_uid, source_offset, observed_at)
            VALUES (?, ?, ?, ?, ?, ?)`).run(
            event.cli || "unknown", event.source_namespace || "hook",
            event.observation_source_id || event.source_event_id, event.event_uid,
            event.source_offset == null ? null : Math.max(0, Math.floor(Number(event.source_offset) || 0)), timestamp
          );
        }
        if (event.data_class !== "synthetic_canary" && event.role === "user") {
          db.prepare("INSERT OR IGNORE INTO queue_events(event_uid, project_id, status, created_at) VALUES (?, ?, 'pending', ?)").run(event.event_uid, event.project_id || null, timestamp);
        }
        return event;
      });
    },
    listSessionEvents(projectId) {
      return db.prepare("SELECT * FROM session_events WHERE project_id=? ORDER BY COALESCE(source_timestamp, captured_at), rowid").all(projectId);
    },
    explainMemory(reference) {
      const value = ensureString(reference, "session reference");
      const session = db.prepare(`SELECT * FROM sessions
        WHERE session_uid=? OR native_session_id=?
        ORDER BY CASE WHEN session_uid=? THEN 0 ELSE 1 END, started_at DESC
        LIMIT 1`).get(value, value, value) || null;
      if (!session) return null;

      const events = db.prepare(`SELECT e.event_uid, e.event_seq, e.context_epoch, e.role, e.capture_source,
          e.capture_completeness, e.source_timestamp, e.captured_at,
          q.status AS queue_status, q.job_id,
          j.status AS reviewer_status, j.attempt AS reviewer_attempt, j.reason_code,
          j.receipt_id, j.created_at AS reviewer_created_at, j.updated_at AS reviewer_updated_at
        FROM session_events e
        LEFT JOIN queue_events q ON q.event_uid=e.event_uid
        LEFT JOIN reviewer_jobs j ON j.job_id=q.job_id
        WHERE e.session_uid=?
        ORDER BY COALESCE(e.source_timestamp, e.captured_at), e.rowid`).all(session.session_uid);

      const eventIds = new Set(events.map((event) => event.event_uid));
      const jobs = [];
      const seenJobs = new Set();
      const producedLessons = [];
      const seenLessons = new Set();
      for (const event of events) {
        if (!event.job_id || seenJobs.has(event.job_id)) continue;
        seenJobs.add(event.job_id);
        jobs.push({
          job_id: event.job_id,
          status: event.reviewer_status,
          attempt: Number(event.reviewer_attempt || 0),
          reason_code: event.reason_code || null,
          receipt_id: event.receipt_id || null,
          created_at: event.reviewer_created_at || null,
          updated_at: event.reviewer_updated_at || null
        });
        if (!event.receipt_id) continue;
        const receipt = db.prepare("SELECT payload_json FROM review_receipts WHERE receipt_id=?").get(event.receipt_id);
        const payload = receipt ? parseJsonOr(receipt.payload_json, {}) : {};
        for (const lesson of payload.lessons || []) {
          const feedbackIds = (lesson.evidence_refs || [])
            .map((evidence) => evidence?.feedback_event_id)
            .filter(Boolean);
          if (!feedbackIds.some((eventUid) => eventIds.has(eventUid))) continue;
          const key = `${lesson.lesson_id || "unknown"}:${lesson.revision || 0}`;
          if (seenLessons.has(key)) continue;
          seenLessons.add(key);
          producedLessons.push({
            lesson_id: lesson.lesson_id,
            revision: Number(lesson.revision || 0),
            severity: lesson.severity || null,
            responsibility: lesson.responsibility || null,
            method_class: lesson.method_class || null,
            class_id: lesson.class_id || null
          });
        }
      }

      const normalizeDelivery = (delivery) => ({
        ...delivery,
        revision: Number(delivery.revision),
        context_epoch: Number(delivery.context_epoch),
        observed: Boolean(delivery.observed)
      });
      const deliveriesIntoSession = db.prepare(`SELECT application_id, lesson_id, revision, session_uid, context_epoch, state, observed, created_at
        FROM delivery_receipts WHERE session_uid=? ORDER BY created_at, application_id`).all(session.session_uid)
        .map(normalizeDelivery);
      const producedLessonDeliveries = producedLessons.flatMap((lesson) => db.prepare(`SELECT application_id, lesson_id, revision, session_uid, context_epoch, state, observed, created_at
        FROM delivery_receipts WHERE lesson_id=? AND revision=? ORDER BY created_at, application_id`).all(lesson.lesson_id, lesson.revision))
        .map(normalizeDelivery);
      const queueEvents = events.filter((event) => event.queue_status != null);
      return {
        session,
        stages: {
          captured: events.length > 0,
          queued: queueEvents.length > 0,
          reviewed: jobs.some((job) => job.status === "completed"),
          lesson_compiled: producedLessons.length > 0,
          emitted: producedLessonDeliveries.some((delivery) => ["emitted", "emitted_unconfirmed", "observed"].includes(delivery.state)),
          observed: producedLessonDeliveries.some((delivery) => delivery.state === "observed" && delivery.observed),
          delivered_into_session: deliveriesIntoSession.some((delivery) => ["emitted", "emitted_unconfirmed", "observed"].includes(delivery.state)),
          observed_in_session: deliveriesIntoSession.some((delivery) => delivery.state === "observed" && delivery.observed)
        },
        counts: {
          events: events.length,
          feedback_candidates: queueEvents.length,
          reviewer_jobs: jobs.length,
          produced_lessons: producedLessons.length,
          produced_lesson_deliveries: producedLessonDeliveries.length,
          deliveries_into_session: deliveriesIntoSession.length,
          deliveries: deliveriesIntoSession.length
        },
        events: events.map((event) => ({
          event_uid: event.event_uid,
          event_seq: Number(event.event_seq),
          context_epoch: Number(event.context_epoch),
          role: event.role,
          capture_source: event.capture_source,
          capture_completeness: event.capture_completeness,
          source_timestamp: event.source_timestamp || null,
          captured_at: event.captured_at,
          queue_status: event.queue_status || null,
          job_id: event.job_id || null
        })),
        reviewer_jobs: jobs,
        produced_lessons: producedLessons,
        produced_lesson_deliveries: producedLessonDeliveries,
        deliveries_into_session: deliveriesIntoSession,
        deliveries: deliveriesIntoSession
      };
    },
    hasSessionEvent(eventUid) {
      return Boolean(db.prepare("SELECT 1 FROM session_events WHERE event_uid=?").get(eventUid));
    },
    getEventObservation(provider, sourceNamespace, sourceId) {
      return db.prepare(`SELECT o.*, e.project_id, e.session_uid, e.role, e.content_hash, e.native_turn_id
        FROM event_observations o JOIN session_events e ON e.event_uid=o.event_uid
        WHERE o.provider=? AND o.source_namespace=? AND o.source_id=?`).get(provider, sourceNamespace, sourceId) || null;
    },
    resolveEventObservation({ provider, sourceNamespace, sourceId, sourceOffset = null, sessionUid, nativeTurnId = null, role, contentHash, sourceTimestamp = null }) {
      return transaction(() => {
        const existing = db.prepare(`SELECT o.*, e.project_id, e.session_uid, e.role, e.content_hash, e.native_turn_id
          FROM event_observations o JOIN session_events e ON e.event_uid=o.event_uid
          WHERE o.provider=? AND o.source_namespace=? AND o.source_id=?`).get(provider, sourceNamespace, sourceId);
        if (existing) return existing;
        let candidate = db.prepare(`SELECT e.* FROM session_events e
          LEFT JOIN event_observations o
            ON o.event_uid=e.event_uid AND o.provider=? AND o.source_namespace=?
          WHERE e.session_uid=? AND e.role=? AND e.content_hash=?
            AND COALESCE(e.native_turn_id, '')=COALESCE(?, '')
            AND o.event_uid IS NULL
          ORDER BY CASE WHEN e.source_namespace='prompt_hook' OR e.source_namespace='stop_hook' THEN 0 ELSE 1 END,
            COALESCE(e.source_timestamp, e.captured_at), e.rowid
          LIMIT 1`).get(provider, sourceNamespace, sessionUid, role, contentHash, nativeTurnId);
        if (!candidate && nativeTurnId != null) {
          const relaxed = db.prepare(`SELECT e.* FROM session_events e
            LEFT JOIN event_observations o
              ON o.event_uid=e.event_uid AND o.provider=? AND o.source_namespace=?
            WHERE e.session_uid=? AND e.role=? AND e.content_hash=?
              AND e.native_turn_id IS NULL
              AND o.event_uid IS NULL
            ORDER BY CASE WHEN e.source_namespace='prompt_hook' OR e.source_namespace='stop_hook' THEN 0 ELSE 1 END,
              COALESCE(e.source_timestamp, e.captured_at), e.rowid
            LIMIT 32`).all(provider, sourceNamespace, sessionUid, role, contentHash);
          const incomingAt = Date.parse(sourceTimestamp || nowIso(now));
          const aliasWindowMs = 5 * 60 * 1000;
          const nearby = relaxed.filter((row) => {
            const candidateAt = Date.parse(row.source_timestamp || row.captured_at || "");
            return Number.isFinite(incomingAt) && Number.isFinite(candidateAt)
              && Math.abs(incomingAt - candidateAt) <= aliasWindowMs;
          });
          if (nearby.length === 1) candidate = nearby[0];
        }
        if (!candidate) return null;
        db.prepare(`INSERT INTO event_observations
          (provider, source_namespace, source_id, event_uid, source_offset, observed_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(
          provider, sourceNamespace, sourceId, candidate.event_uid,
          sourceOffset == null ? null : Math.max(0, Math.floor(Number(sourceOffset) || 0)), nowIso(now)
        );
        return { ...candidate, provider, source_namespace: sourceNamespace, source_id: sourceId, source_offset: sourceOffset };
      });
    },
    getTranscriptCursor(provider, transcriptPath) {
      return db.prepare("SELECT * FROM transcript_cursors WHERE provider=? AND transcript_path=?").get(provider, transcriptPath) || null;
    },
    listTranscriptCursors(provider) {
      return db.prepare("SELECT * FROM transcript_cursors WHERE provider=? ORDER BY updated_at, transcript_path")
        .all(ensureString(provider, "provider"));
    },
    saveTranscriptCursor({
      provider,
      transcriptPath,
      deviceId = null,
      inodeId = null,
      offset,
      state,
      expectedMissing = false,
      expectedOffset,
      expectedInodeId
    }) {
      return transaction(() => {
        const current = db.prepare("SELECT * FROM transcript_cursors WHERE provider=? AND transcript_path=?").get(provider, transcriptPath) || null;
        if (expectedMissing && current) throw new RevisionConflictError("transcript cursor changed before commit");
        if (expectedOffset !== undefined && (!current
          || Number(current.offset) !== Number(expectedOffset)
          || (expectedInodeId !== undefined && String(current.inode_id) !== String(expectedInodeId)))) {
          throw new RevisionConflictError("transcript cursor changed before commit");
        }
        const stateJson = JSON.stringify(state || {});
        db.prepare(`INSERT INTO transcript_cursors(provider, transcript_path, device_id, inode_id, offset, state_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider, transcript_path) DO UPDATE SET
            device_id=excluded.device_id,
            inode_id=excluded.inode_id,
            offset=excluded.offset,
            state_json=excluded.state_json,
            updated_at=excluded.updated_at`).run(
          ensureString(provider, "provider"), ensureString(transcriptPath, "transcript_path"),
          deviceId == null ? null : String(deviceId), inodeId == null ? null : String(inodeId),
          Math.max(0, Math.floor(Number(offset) || 0)), stateJson, nowIso(now)
        );
        return db.prepare("SELECT * FROM transcript_cursors WHERE provider=? AND transcript_path=?").get(provider, transcriptPath);
      });
    },
    claimWorkerLease({ name, ownerId, nowMs = Date.now(), leaseMs = 120_000 }) {
      return transaction(() => {
        const leaseName = ensureString(name, "name");
        const owner = ensureString(ownerId, "ownerId");
        const current = db.prepare("SELECT * FROM worker_leases WHERE name=?").get(leaseName);
        if (current && current.owner_id !== owner && Number(current.lease_until) > nowMs) {
          return { acquired: false, ownerId: current.owner_id, leaseUntil: Number(current.lease_until), leaseEpoch: Number(current.lease_epoch) };
        }
        const epoch = Number(current?.lease_epoch || 0) + 1;
        const leaseUntil = nowMs + Math.max(1_000, Math.floor(Number(leaseMs) || 120_000));
        db.prepare(`INSERT INTO worker_leases(name, owner_id, lease_epoch, lease_until, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET owner_id=excluded.owner_id, lease_epoch=excluded.lease_epoch,
            lease_until=excluded.lease_until, updated_at=excluded.updated_at`).run(
          leaseName, owner, epoch, leaseUntil, nowIso(now)
        );
        return { acquired: true, ownerId: owner, leaseUntil, leaseEpoch: epoch };
      });
    },
    releaseWorkerLease({ name, ownerId }) {
      return transaction(() => db.prepare("DELETE FROM worker_leases WHERE name=? AND owner_id=?").run(name, ownerId).changes === 1);
    },
    createIncident(input) {
      return transaction(() => {
        db.prepare(`INSERT INTO incidents
          (incident_fingerprint, fingerprint_version, project_id, responsibility, severity, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.incident_fingerprint, input.fingerprint_version, input.project_id || null,
          input.responsibility || null, input.severity || null, input.status || "captured", nowIso(now));
        for (const eventUid of input.event_uids || []) {
          db.prepare("INSERT INTO incident_events(incident_fingerprint, event_uid) VALUES (?, ?)").run(input.incident_fingerprint, eventUid);
        }
        return input;
      });
    },
    listIncidents(projectId) {
      const rows = projectId === undefined
        ? db.prepare("SELECT * FROM incidents ORDER BY created_at, incident_fingerprint").all()
        : db.prepare("SELECT * FROM incidents WHERE project_id=? ORDER BY created_at, incident_fingerprint").all(projectId);
      const eventIds = db.prepare("SELECT event_uid FROM incident_events WHERE incident_fingerprint=? ORDER BY event_uid");
      return rows.map((row) => ({ ...row, event_uids: eventIds.all(row.incident_fingerprint).map((item) => item.event_uid) }));
    },
    upsertLessonRevision(input, expectedBaseRevision) {
      return transaction(() => {
        const existing = db.prepare("SELECT current_revision FROM lessons WHERE lesson_id=?").get(input.lesson_id);
        const actual = existing ? Number(existing.current_revision) : 0;
        if (actual !== Number(expectedBaseRevision)) throw new RevisionConflictError(`expected revision ${expectedBaseRevision}, got ${actual}`);
        if (actual === 0) {
          db.prepare("INSERT INTO lessons(lesson_id, severity, project_id, scope_json, conflict_state, current_revision) VALUES (?, ?, ?, ?, ?, ?)").run(input.lesson_id, input.severity || "Major", input.project_id || null, JSON.stringify(input.scope || {}), input.conflict_state || "none", input.revision);
        } else {
          db.prepare("UPDATE lessons SET current_revision=?, severity=COALESCE(?, severity), scope_json=?, conflict_state=COALESCE(?, conflict_state) WHERE lesson_id=?").run(input.revision, input.severity || null, JSON.stringify(input.scope || {}), input.conflict_state || null, input.lesson_id);
        }
        db.prepare("INSERT INTO lesson_revisions(lesson_id, revision, card_json, created_at) VALUES (?, ?, ?, ?)").run(
          input.lesson_id, input.revision, input.card_json, nowIso(now)
        );
        return input;
      });
    },
    selectLessons({ projectId } = {}) {
      const rows = db.prepare(`SELECT l.lesson_id, l.project_id, l.severity, l.lifecycle, l.enablement, l.conflict_state, l.load_policy, l.scope_json,
        l.responsibility, l.confidence, l.method_class, l.class_id, l.family_id, l.generalizable, l.recurrence_count, l.promotion_state,
        l.current_revision, r.card_json
        FROM lessons l JOIN lesson_revisions r ON r.lesson_id=l.lesson_id AND r.revision=l.current_revision
        WHERE l.lifecycle='active' AND l.enablement='enabled'
          AND (l.project_id IS NULL OR l.project_id=?)`).all(projectId || null);
      return rows.map((row) => ({ ...row, revision: Number(row.current_revision), scope: JSON.parse(row.scope_json || "{}"), card: JSON.parse(row.card_json) }));
    },
    hasDelivery(applicationId) {
      return Boolean(db.prepare("SELECT 1 FROM delivery_receipts WHERE application_id=? AND state IN ('emitted','observed')").get(applicationId));
    },
    recordDeliveries({ deliveries, sessionUid, contextEpoch, language }) {
      if (!Array.isArray(deliveries) || deliveries.length === 0) throw new TypeError("deliveries must be a non-empty array");
      return transaction(() => {
        const safeSessionUid = ensureString(sessionUid, "sessionUid");
        const safeContextEpoch = Math.max(1, Math.floor(Number(contextEpoch) || 1));
        const applicationIds = [...new Set(deliveries.map((delivery) => ensureString(delivery.application_id, "application_id")))].sort();
        const timestamp = nowIso(now);
        db.prepare(`INSERT OR IGNORE INTO sessions
          (session_uid, cli, native_session_id, installation_id, project_id, context_epoch, started_at)
          VALUES (?, 'unknown', NULL, 'unknown', NULL, ?, ?)`).run(safeSessionUid, safeContextEpoch, timestamp);
        const upsert = db.prepare(`INSERT INTO delivery_receipts
          (application_id, lesson_id, revision, session_uid, context_epoch, nonce, state, observed, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(application_id) DO UPDATE SET nonce=excluded.nonce, state=excluded.state, observed=excluded.observed`);
        let inserted = 0;
        for (const delivery of deliveries) {
          const exists = db.prepare("SELECT 1 FROM delivery_receipts WHERE application_id=?").get(delivery.application_id);
          upsert.run(
            ensureString(delivery.application_id, "application_id"), ensureString(delivery.lesson_id, "lesson_id"),
            Number(delivery.revision), safeSessionUid, safeContextEpoch, delivery.nonce || null,
            delivery.state || "emitted", delivery.observed ? 1 : 0, timestamp
          );
          if (!exists) inserted += 1;
        }
        const applicationId = applicationIds[0];
        const notification = createNotificationInTransaction({
          sessionUid: safeSessionUid,
          contextEpoch: safeContextEpoch,
          applicationId,
          semanticKey: JSON.stringify(applicationIds),
          kind: "lesson_delivered",
          payload: { lesson_count: applicationIds.length },
          language
        });
        return { inserted, notification };
      });
    },
    recordDelivery({ application_id, lesson_id, revision, session_uid, context_epoch, state, observed = false, nonce = null, language }) {
      return this.recordDeliveries({
        deliveries: [{ application_id, lesson_id, revision, state, observed, nonce }],
        sessionUid: session_uid,
        contextEpoch: context_epoch,
        language
      });
    },
    observeDeliveryNonces({ session_uid, context_epoch, transcriptText }) {
      return transaction(() => {
        const rows = db.prepare("SELECT application_id, nonce FROM delivery_receipts WHERE session_uid=? AND context_epoch=? AND state IN ('emitted','emitted_unconfirmed')").all(session_uid, context_epoch);
        let changes = 0;
        for (const row of rows) {
          if (row.nonce && String(transcriptText).includes(`nonce=${row.nonce}`)) {
            changes += db.prepare("UPDATE delivery_receipts SET observed=1, state='observed' WHERE application_id=? AND state IN ('emitted','emitted_unconfirmed')").run(row.application_id).changes;
          }
        }
        return changes;
      });
    },
    finalizeUnconfirmedDeliveries({ session_uid, context_epoch }) {
      return transaction(() => db.prepare("UPDATE delivery_receipts SET state='emitted_unconfirmed' WHERE session_uid=? AND context_epoch=? AND state='emitted'").run(session_uid, context_epoch).changes);
    },
    getDelivery(applicationId) {
      return db.prepare("SELECT * FROM delivery_receipts WHERE application_id=?").get(applicationId) || null;
    },
    getDeliveryByNonce(nonce) {
      return db.prepare("SELECT * FROM delivery_receipts WHERE nonce=? ORDER BY created_at DESC LIMIT 1").get(nonce) || null;
    },
    listLessonEffectiveness(lessonId) {
      return db.prepare("SELECT * FROM lesson_effectiveness_events WHERE lesson_id=? ORDER BY created_at, effectiveness_event_id").all(lessonId);
    },
    promoteLesson({ lessonId, projectId = null }) {
      return transaction(() => {
        const lesson = db.prepare("SELECT * FROM lessons WHERE lesson_id=? AND lifecycle IN ('active','candidate')").get(lessonId);
        if (!lesson) throw new Error(`promotable lesson not found: ${lessonId}`);
        if (projectId === null && !(lesson.project_id === null && lesson.promotion_state === "active_global")) {
          const independent = lesson.family_id
            ? db.prepare(`SELECT COUNT(DISTINCT repository_lineage_id) AS lineages,
                COUNT(DISTINCT incident_fingerprint) AS incidents
              FROM lesson_family_evidence WHERE family_id=? AND incident_fingerprint IS NOT NULL`).get(lesson.family_id)
            : { lineages: 0, incidents: 0 };
          if (lesson.severity !== "Blocker" || lesson.responsibility !== "agent_fault" || Number(lesson.generalizable) !== 1 || Number(independent.lineages) < 2 || Number(independent.incidents) < 2) {
            throw new Error("global promotion requires a generalizable agent_fault Blocker with two independent incidents and repository lineages");
          }
        }
        if (projectId !== null && lesson.project_id !== null && lesson.project_id !== projectId) {
          throw new Error("project promotion cannot move a lesson across projects");
        }
        const result = db.prepare("UPDATE lessons SET project_id=?, lifecycle='active', promotion_state=CASE WHEN ? IS NULL THEN 'active_global' ELSE 'project' END WHERE lesson_id=? AND lifecycle IN ('active','candidate')").run(projectId, projectId, lessonId);
        if (result.changes !== 1) throw new Error(`promotable lesson not found: ${lessonId}`);
        return { lesson_id: lessonId, project_id: projectId };
      });
    },
    pendingReviewEventCount(projectId) {
      return Number(db.prepare("SELECT COUNT(*) AS count FROM queue_events WHERE project_id=? AND status='pending'").get(projectId).count);
    },
    submitDueReview({ projectId, minEntries = 3, maxEntries = 24, maxAgeMs = 3_600_000, cooldownMs = 900_000, promptVersion = "v1", immediateEventUid = null }) {
      return transaction(() => {
        const boundedMaxEntries = Math.max(1, Math.floor(Number(maxEntries) || 24));
        const immediateEvent = immediateEventUid
          ? db.prepare("SELECT event_uid, job_id FROM queue_events WHERE event_uid=? AND project_id=? AND status='pending'").get(immediateEventUid, projectId)
          : null;
        if (immediateEventUid && !immediateEvent) {
          return { status: "not_due", eventCount: this.pendingReviewEventCount(projectId), immediate: true, reason: "immediate_event_unavailable", notificationRefs: [] };
        }

        const alreadyAssigned = immediateEvent?.job_id
          ? db.prepare("SELECT job_id, status, wake_attempt FROM reviewer_jobs WHERE job_id=? AND status IN ('pending','running')").get(immediateEvent.job_id)
          : null;
        if (alreadyAssigned) {
          const count = Number(db.prepare("SELECT COUNT(*) AS count FROM queue_events WHERE project_id=? AND job_id=?").get(projectId, alreadyAssigned.job_id).count);
          const notifications = createQueueNotificationInTransaction(alreadyAssigned.job_id, immediateEventUid);
          return { job_id: alreadyAssigned.job_id, status: alreadyAssigned.status, eventCount: count, existing: true, immediate: true, notificationRefs: notifications.map(asNotificationRef) };
        }

        const existing = db.prepare("SELECT job_id, status, wake_attempt FROM reviewer_jobs WHERE project_id=? AND status IN ('pending','running') ORDER BY created_at DESC LIMIT 1").get(projectId);
        if (existing && !immediateEvent) {
          const count = Number(db.prepare("SELECT COUNT(*) AS count FROM queue_events WHERE project_id=? AND job_id=?").get(projectId, existing.job_id).count);
          return { job_id: existing.job_id, status: existing.status, eventCount: count, existing: true, notificationRefs: [] };
        }
        if (existing?.status === "pending" && Number(existing.wake_attempt || 0) === 0 && immediateEvent) {
          const assigned = Number(db.prepare("SELECT COUNT(*) AS count FROM queue_events WHERE project_id=? AND job_id=?").get(projectId, existing.job_id).count);
          if (assigned >= boundedMaxEntries) {
            const displaced = db.prepare("SELECT event_uid FROM queue_events WHERE project_id=? AND job_id=? ORDER BY created_at, event_uid LIMIT 1").get(projectId, existing.job_id);
            if (displaced) {
              const cleared = db.prepare("UPDATE queue_events SET job_id=NULL WHERE event_uid=? AND job_id=?").run(displaced.event_uid, existing.job_id).changes;
              if (cleared === 1) suppressQueueNotificationInTransaction(existing.job_id, displaced.event_uid);
            }
          }
          db.prepare("UPDATE queue_events SET job_id=? WHERE event_uid=? AND project_id=? AND status='pending' AND job_id IS NULL").run(existing.job_id, immediateEventUid, projectId);
          const count = Number(db.prepare("SELECT COUNT(*) AS count FROM queue_events WHERE project_id=? AND job_id=?").get(projectId, existing.job_id).count);
          const notifications = createQueueNotificationInTransaction(existing.job_id, immediateEventUid);
          return { job_id: existing.job_id, status: "pending", eventCount: count, existing: true, immediate: true, notificationRefs: notifications.map(asNotificationRef) };
        }

        const latest = db.prepare("SELECT created_at FROM reviewer_jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 1").get(projectId);
        const oldest = db.prepare("SELECT MIN(created_at) AS created_at FROM queue_events WHERE project_id=? AND status='pending'").get(projectId);
        const count = this.pendingReviewEventCount(projectId);
        if (!oldest?.created_at || (!immediateEvent && latest?.created_at && (Date.now() - Date.parse(latest.created_at)) < cooldownMs) || (!immediateEvent && count < minEntries && (Date.now() - Date.parse(oldest.created_at)) < maxAgeMs)) {
          return { status: "not_due", eventCount: count, notificationRefs: [] };
        }
        const ids = immediateEvent
          ? db.prepare("SELECT event_uid FROM queue_events WHERE project_id=? AND status='pending' AND job_id IS NULL ORDER BY CASE WHEN event_uid=? THEN 0 ELSE 1 END, created_at, event_uid LIMIT ?").all(projectId, immediateEventUid, boundedMaxEntries).map((row) => row.event_uid)
          : db.prepare("SELECT event_uid FROM queue_events WHERE project_id=? AND status='pending' AND job_id IS NULL ORDER BY created_at, event_uid LIMIT ?").all(projectId, boundedMaxEntries).map((row) => row.event_uid);
        if (ids.length === 0 || (immediateEvent && !ids.includes(immediateEventUid))) {
          return { status: "not_due", eventCount: count, immediate: Boolean(immediateEvent), reason: "no_assignable_events", notificationRefs: [] };
        }
        const jobId = createHash("sha256").update([promptVersion, projectId, ids[0], ids.at(-1)].join("\u0000")).digest("hex");
        const timestamp = nowIso(now);
        db.prepare("INSERT INTO reviewer_jobs(job_id, project_id, prompt_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(jobId, projectId, promptVersion, timestamp, timestamp);
        const assign = db.prepare("UPDATE queue_events SET job_id=? WHERE event_uid=? AND status='pending' AND job_id IS NULL");
        for (const eventUid of ids) assign.run(jobId, eventUid);
        const notifications = immediateEvent ? createQueueNotificationInTransaction(jobId, immediateEventUid) : [];
        return { job_id: jobId, status: "pending", eventCount: ids.length, existing: false, immediate: Boolean(immediateEvent), notificationRefs: notifications.map(asNotificationRef) };
      });
    },
    submitReviewerJob(input) {
      return transaction(() => {
        db.prepare(`INSERT INTO reviewer_jobs(job_id, project_id, prompt_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)`).run(input.job_id, input.project_id || null, input.prompt_version, nowIso(now), nowIso(now));
        return input;
      });
    },
    getReviewerJob(jobId) {
      return db.prepare("SELECT * FROM reviewer_jobs WHERE job_id=?").get(jobId) || null;
    },
    listRecoverableReviewerJobs({ nowMs = Date.now(), maxAttempts = 3, limit = 32 } = {}) {
      const boundedAttempts = Math.max(1, Math.floor(Number(maxAttempts) || 3));
      const boundedLimit = Math.max(1, Math.min(256, Math.floor(Number(limit) || 32)));
      return db.prepare(`SELECT j.*,
          COALESCE((SELECT s.cli FROM queue_events q
            JOIN session_events e ON e.event_uid=q.event_uid
            JOIN sessions s ON s.session_uid=e.session_uid
            WHERE q.job_id=j.job_id ORDER BY q.created_at, q.event_uid LIMIT 1), 'codex') AS cli
        FROM reviewer_jobs j
        WHERE j.attempt < ? AND (
          (j.status='pending' AND (j.next_wake_at IS NULL OR j.next_wake_at<=?))
          OR (j.status='running' AND j.lease_until IS NOT NULL AND j.lease_until<=?)
        )
        ORDER BY j.updated_at, j.job_id LIMIT ?`).all(boundedAttempts, nowMs, nowMs, boundedLimit);
    },
    requeueExpiredReviewerJob({ jobId, nowMs = Date.now() }) {
      return transaction(() => {
        const job = db.prepare("SELECT * FROM reviewer_jobs WHERE job_id=?").get(jobId);
        if (!job) return false;
        const changed = db.prepare(`UPDATE reviewer_jobs
          SET status='pending', owner_id=NULL, lease_until=NULL, reason_code='lease_expired', updated_at=?
          WHERE job_id=? AND status='running' AND lease_until IS NOT NULL AND lease_until<=?`).run(
          nowIso(now), jobId, nowMs
        ).changes === 1;
        if (changed) recordReviewerJobEventInTransaction(job, "requeued", "lease_expired");
        return changed;
      });
    },
    failExhaustedReviewerJobs({ nowMs = Date.now(), maxAttempts = 3 } = {}) {
      const boundedAttempts = Math.max(1, Math.floor(Number(maxAttempts) || 3));
      return transaction(() => {
        const jobs = db.prepare(`SELECT * FROM reviewer_jobs WHERE attempt>=? AND (
          (status='pending' AND (next_wake_at IS NULL OR next_wake_at<=?))
          OR (status='running' AND lease_until IS NOT NULL AND lease_until<=?)
        ) ORDER BY created_at, job_id`).all(boundedAttempts, nowMs, nowMs);
        let count = 0;
        const notifications = [];
        for (const job of jobs) {
          const changed = db.prepare(`UPDATE reviewer_jobs
            SET status='failed', reason_code='retry_exhausted', owner_id=NULL, lease_until=NULL, updated_at=?
            WHERE job_id=? AND status=? AND lease_epoch=?`).run(nowIso(now), job.job_id, job.status, job.lease_epoch).changes;
          if (changed !== 1) continue;
          count += 1;
          recordReviewerJobEventInTransaction(job, "retry_exhausted", "retry_exhausted");
          notifications.push(...createExhaustedNotificationsInTransaction(job.job_id, "retry_exhausted"));
        }
        return { count, notificationRefs: notifications.map(asNotificationRef) };
      });
    },
    claimReviewerWake({ jobId, nowMs = Date.now(), cooldownMs = 300_000 }) {
      return transaction(() => {
        const job = db.prepare("SELECT * FROM reviewer_jobs WHERE job_id=?").get(jobId);
        if (!job || job.status !== "pending") return { action: "not_pending", attempt: Number(job?.wake_attempt || 0) };
        const attempt = Number(job.wake_attempt || 0);
        if (attempt > 0 && Number(job.next_wake_at || 0) > nowMs) {
          return { action: "suppressed", attempt, nextWakeAt: Number(job.next_wake_at) };
        }
        const nextAttempt = attempt + 1;
        const action = attempt === 0 ? "inject" : "retry";
        const capability = randomBytes(32).toString("base64url");
        const capabilityHash = createHash("sha256").update(capability).digest("hex");
        const capabilityExpiresAt = nowMs + Math.max(cooldownMs * 2, 120_000);
        db.prepare("UPDATE reviewer_jobs SET wake_attempt=?, prompted_at=?, next_wake_at=?, capability_hash=?, capability_expires_at=?, capability_consumed_at=NULL, updated_at=? WHERE job_id=? AND status='pending'").run(
          nextAttempt, nowMs, nowMs + cooldownMs, capabilityHash, capabilityExpiresAt, nowIso(now), jobId
        );
        return { action, attempt: nextAttempt, nextWakeAt: nowMs + cooldownMs, capability, capabilityExpiresAt };
      });
    },
    getReviewerContext(jobId, { priorEvents = 6, followingEvents = 2, maxEvents = 128, maxEventChars = 16 * 1024, maxTotalChars = 256 * 1024 } = {}) {
      const job = db.prepare("SELECT * FROM reviewer_jobs WHERE job_id=?").get(jobId);
      if (!job) throw new Error(`reviewer job not found: ${jobId}`);
      const queued = db.prepare(`SELECT e.event_uid, e.session_uid FROM queue_events q
        JOIN session_events e ON e.event_uid=q.event_uid WHERE q.job_id=?
        ORDER BY COALESCE(e.source_timestamp, e.captured_at), e.rowid`).all(jobId);
      const queuedIds = queued.map((row) => row.event_uid);
      const selectedIds = new Set(queuedIds);
      const sessionIds = [...new Set(queued.map((row) => row.session_uid))];
      const rowsById = new Map();
      const orderedRows = [];
      const selectSession = db.prepare(`SELECT e.rowid AS storage_order, e.event_uid, e.session_uid, e.context_epoch, e.project_id,
          e.source_event_id, e.source_namespace, e.parent_event_id, e.role, e.redacted_text,
          e.capture_source, e.capture_completeness, e.tool_name, e.tool_args_json,
          e.textual_output_ref, e.file_refs_json, e.artifact_hashes_json, e.source_timestamp, e.captured_at
        FROM session_events e WHERE e.session_uid=? AND (e.project_id=? OR ? IS NULL)
        ORDER BY COALESCE(e.source_timestamp, e.captured_at), e.rowid`);
      for (const sessionUid of sessionIds) {
        const sessionRows = selectSession.all(sessionUid, job.project_id || null, job.project_id || null);
        for (const row of sessionRows) rowsById.set(row.event_uid, row);
        for (const eventUid of queuedIds.filter((id) => rowsById.get(id)?.session_uid === sessionUid)) {
          const index = sessionRows.findIndex((row) => row.event_uid === eventUid);
          const start = Math.max(0, index - Math.max(0, Number(priorEvents) || 0));
          const end = Math.min(sessionRows.length, index + Math.max(0, Number(followingEvents) || 0) + 1);
          for (let offset = start; offset < end && selectedIds.size < Math.max(queuedIds.length, Number(maxEvents) || 128); offset += 1) {
            selectedIds.add(sessionRows[offset].event_uid);
          }
        }
      }
      for (const eventUid of selectedIds) {
        const row = rowsById.get(eventUid);
        if (row) orderedRows.push(row);
      }
      orderedRows.sort((left, right) => {
        const leftTime = Date.parse(left.source_timestamp || left.captured_at || "");
        const rightTime = Date.parse(right.source_timestamp || right.captured_at || "");
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
        return Number(left.storage_order) - Number(right.storage_order);
      });
      const requestedEventLimit = Number(maxEventChars);
      const requestedTotalLimit = Number(maxTotalChars);
      const eventLimit = Number.isFinite(requestedEventLimit) && requestedEventLimit >= 0 ? Math.floor(requestedEventLimit) : 16 * 1024;
      const totalLimit = Number.isFinite(requestedTotalLimit) && requestedTotalLimit >= 0 ? Math.floor(requestedTotalLimit) : 256 * 1024;
      const perEventLimit = Math.max(0, Math.min(eventLimit, Math.floor(totalLimit / Math.max(1, orderedRows.length))));
      const truncatedEventIds = [];
      const events = orderedRows.map((row) => {
        const originalText = String(row.redacted_text || "");
        const metadata = {
          tool_args: parseJsonOr(row.tool_args_json, null),
          textual_output_ref: row.textual_output_ref ? boundedText(row.textual_output_ref, 4 * 1024) : null,
          file_refs: parseJsonOr(row.file_refs_json, []),
          artifact_hashes: parseJsonOr(row.artifact_hashes_json, [])
        };
        const metadataSerialized = JSON.stringify(metadata);
        const metadataLimit = Math.floor(perEventLimit * 0.4);
        let renderedMetadata;
        let metadataTruncated = false;
        if (metadataSerialized.length <= metadataLimit) {
          renderedMetadata = metadata;
        } else if (metadataLimit >= 32) {
          renderedMetadata = {
            tool_args: null,
            textual_output_ref: null,
            file_refs: [],
            artifact_hashes: [],
            metadata_preview: boundedText(metadataSerialized, Math.max(0, metadataLimit - 96)),
            metadata_truncated: true
          };
          metadataTruncated = true;
        } else {
          renderedMetadata = { tool_args: null, textual_output_ref: null, file_refs: [], artifact_hashes: [], metadata_truncated: true };
          metadataTruncated = true;
        }
        const metadataCost = Math.min(perEventLimit, JSON.stringify(renderedMetadata).length);
        const textLimit = Math.max(0, perEventLimit - metadataCost);
        const redactedText = boundedText(originalText, textLimit, "\n...[bounded reviewer excerpt]...\n");
        const contextTruncated = originalText.length !== redactedText.length || metadataTruncated;
        if (contextTruncated) truncatedEventIds.push(row.event_uid);
        return {
          storage_order: row.storage_order,
          event_uid: row.event_uid,
          session_uid: row.session_uid,
          context_epoch: row.context_epoch,
          project_id: row.project_id,
          source_event_id: row.source_event_id,
          source_namespace: row.source_namespace,
          parent_event_id: row.parent_event_id,
          role: row.role,
          redacted_text: redactedText,
          capture_source: row.capture_source,
          capture_completeness: row.capture_completeness,
          tool_name: row.tool_name,
          ...renderedMetadata,
          captured_at: row.captured_at,
          source_timestamp: row.source_timestamp,
          queued_for_review: queuedIds.includes(row.event_uid),
          context_truncated: contextTruncated
        };
      });
      return {
        job: {
          job_id: job.job_id,
          project_id: job.project_id,
          prompt_version: job.prompt_version,
          status: job.status,
          attempt: job.attempt,
          created_at: job.created_at
        },
        queued_event_ids: queuedIds,
        feedback_candidate_event_ids: queuedIds,
        events,
        truncated_event_ids: [...new Set(truncatedEventIds)],
        context_limits: { prior_events: priorEvents, following_events: followingEvents, max_events: maxEvents, max_event_chars: maxEventChars, max_total_content_chars: maxTotalChars, max_serialized_bytes: 512 * 1024 }
      };
    },
    submitPromptReview(jobId, review, ownerId = `prompt-reviewer-${process.pid}`) {
      const job = this.getReviewerJob(jobId);
      if (!job) throw new Error(`reviewer job not found: ${jobId}`);
      if (review?.mode !== "background_subagent" || !String(review?.background_agent_id || "").trim()) throw new Error("background subagent identity is required");
      const capabilityHash = createHash("sha256").update(String(review?.reviewer_capability || "")).digest("hex");
      if (!job.capability_hash || job.capability_hash !== capabilityHash || job.capability_consumed_at || Number(job.capability_expires_at || 0) <= Date.now()) {
        throw new Error("reviewer capability is invalid, expired, or already consumed");
      }
      const attempt = Number(job.attempt) + 1;
      const lease = this.claimReviewerJob(jobId, ownerId, Date.now() + 120_000, attempt);
      try {
        return this.commitReview({ jobId, ownerId, attempt, leaseEpoch: lease.lease_epoch, capabilityHash }, review);
      } catch (error) {
        try { this.failReviewerJob(jobId, ownerId, attempt, lease.lease_epoch, true, "prompt_receipt_rejected"); } catch {}
        throw error;
      }
    },
    commitReview({ jobId, ownerId, attempt, leaseEpoch, capabilityHash = null }, review) {
      return transaction(() => {
        if (!review || review.write_complete !== true || !review.review_receipt_id || !review.report_content_id
          || String(review.report_content || "").trim().length < 24
          || !["reviewed", "reviewed_no_lesson"].includes(review.status) || !Array.isArray(review.lessons)) {
          throw new TypeError("invalid structured review receipt");
        }
        validateReviewQuality(review);
        const persistedReview = sanitizeStructured(review);
        const persistedReport = redactText(String(review.report_content || JSON.stringify(persistedReview))).text;
        const job = db.prepare("SELECT * FROM reviewer_jobs WHERE job_id=?").get(jobId);
        if (!job || job.status !== "running" || job.owner_id !== ownerId || Number(job.attempt) !== Number(attempt) || Number(job.lease_epoch) !== Number(leaseEpoch) || !job.lease_until || job.lease_until <= Date.now()) {
          throw new LeaseConflictError("stale reviewer completion");
        }
        if (capabilityHash && (job.capability_hash !== capabilityHash || job.capability_consumed_at || Number(job.capability_expires_at || 0) <= Date.now())) {
          throw new LeaseConflictError("reviewer capability is stale");
        }
        for (const lesson of review.lessons) {
          validateLessonEvidence(db, job, lesson);
          const incident = incidentForLesson(job, lesson);
          db.prepare(`INSERT OR IGNORE INTO incidents
            (incident_fingerprint, fingerprint_version, project_id, responsibility, severity, status, created_at)
            VALUES (?, 1, ?, ?, ?, 'reviewed', ?)`).run(
            incident.incidentFingerprint, incident.projectId, lesson.responsibility, lesson.severity, nowIso(now)
          );
          const insertIncidentEvent = db.prepare("INSERT OR IGNORE INTO incident_events(incident_fingerprint, event_uid) VALUES (?, ?)");
          for (const eventUid of incident.eventUids) insertIncidentEvent.run(incident.incidentFingerprint, eventUid);
          const card = sanitizeStructured(lesson.card || {});
          const scope = sanitizeStructured(lesson.scope || {});
          for (const field of ["when", "must_do", "must_not", "verify", "why", "exception"]) {
            if (!String(card[field] || "").trim()) throw new TypeError(`lesson card missing ${field}`);
          }
          if (!Array.isArray(card.source_ids) || card.source_ids.length === 0) throw new TypeError("lesson card missing source_ids");
          const existing = db.prepare("SELECT current_revision FROM lessons WHERE lesson_id=?").get(lesson.lesson_id);
          const actual = existing ? Number(existing.current_revision) : 0;
          if (actual !== Number(lesson.base_revision)) throw new RevisionConflictError(`expected revision ${lesson.base_revision}, got ${actual}`);
          const familyId = createHash("sha256").update(`${lesson.method_class}\u0000${lesson.class_id}`).digest("hex");
          const effectiveProjectId = lesson.project_id || job.project_id || null;
          const previousLesson = actual > 0
            ? db.prepare("SELECT lesson_id, current_revision, project_id, severity FROM lessons WHERE lesson_id=?").get(lesson.lesson_id)
            : db.prepare(`SELECT lesson_id, current_revision, project_id, severity FROM lessons
                WHERE family_id=? AND (project_id IS NULL OR project_id=?)
                ORDER BY CASE WHEN project_id=? THEN 0 ELSE 1 END, current_revision DESC LIMIT 1`).get(familyId, effectiveProjectId, effectiveProjectId);
          let effectiveness = null;
          if (previousLesson) {
            const previousRank = SEVERITY_RANK[previousLesson.severity];
            const nextRank = SEVERITY_RANK[lesson.severity];
            if (previousRank === undefined || nextRank === undefined || (previousRank < SEVERITY_RANK.Blocker && nextRank <= previousRank) || (previousRank === SEVERITY_RANK.Blocker && nextRank !== SEVERITY_RANK.Blocker)) {
              throw new TypeError("recurring lesson severity must escalate by at least one level, up to Blocker");
            }
            const applicationId = lesson.effectiveness?.application_id || null;
            const delivery = applicationId ? db.prepare("SELECT * FROM delivery_receipts WHERE application_id=?").get(applicationId) : null;
            effectiveness = validateEffectiveness(lesson.effectiveness, { previousLesson, delivery });
          }
          if (actual === 0) {
            db.prepare(`INSERT INTO lessons(lesson_id, severity, project_id, scope_json, responsibility, confidence,
              method_class, class_id, family_id, generalizable, lifecycle, current_revision)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`).run(
              lesson.lesson_id, lesson.severity || "Major", lesson.project_id || null, JSON.stringify(scope),
              lesson.responsibility, lesson.confidence, lesson.method_class, lesson.class_id, familyId,
              lesson.generalizable ? 1 : 0, lesson.revision
            );
          } else {
            db.prepare(`UPDATE lessons SET severity=?, scope_json=?, responsibility=?, confidence=?, method_class=?,
              class_id=?, family_id=?, generalizable=?, lifecycle='active', current_revision=?, recurrence_count=recurrence_count+1
              WHERE lesson_id=?`).run(
              lesson.severity || "Major", JSON.stringify(scope), lesson.responsibility, lesson.confidence,
              lesson.method_class, lesson.class_id, familyId, lesson.generalizable ? 1 : 0, lesson.revision, lesson.lesson_id
            );
          }
          db.prepare("INSERT INTO lesson_revisions(lesson_id, revision, card_json, created_at) VALUES (?, ?, ?, ?)").run(lesson.lesson_id, lesson.revision, JSON.stringify(card), nowIso(now));
          if (effectiveness) {
            const persistedEffectiveness = sanitizeStructured(effectiveness);
            const effectivenessId = lesson.effectiveness_event_id || createHash("sha256").update(`${review.report_content_id}\u0000${lesson.lesson_id}\u0000${lesson.revision}`).digest("hex");
            db.prepare(`INSERT INTO lesson_effectiveness_events
              (effectiveness_event_id, lesson_id, previous_lesson_id, expected_revision, application_id,
               delivery_state, was_applicable, was_followed, failure_mode, control_owner, corrective_action,
               report_content_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
              effectivenessId, lesson.lesson_id, persistedEffectiveness.previous_lesson_id, persistedEffectiveness.expected_revision,
              persistedEffectiveness.application_id || null, persistedEffectiveness.delivery_state, persistedEffectiveness.was_applicable ? 1 : 0,
              persistedEffectiveness.was_followed === null ? null : (persistedEffectiveness.was_followed ? 1 : 0), persistedEffectiveness.failure_mode,
              persistedEffectiveness.control_owner, persistedEffectiveness.corrective_action, review.report_content_id, nowIso(now)
            );
          }
          const lineageId = createHash("sha256").update(`project-lineage:v1\u0000${effectiveProjectId || "unknown"}`).digest("hex");
          db.prepare(`INSERT OR IGNORE INTO lesson_family_evidence
            (family_id, repository_lineage_id, project_id, lesson_id, report_content_id, incident_fingerprint, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(familyId, lineageId, lesson.project_id || job.project_id || "unknown", lesson.lesson_id, review.report_content_id, incident.incidentFingerprint, nowIso(now));
          const independent = db.prepare(`SELECT COUNT(DISTINCT repository_lineage_id) AS lineages,
              COUNT(DISTINCT incident_fingerprint) AS incidents
            FROM lesson_family_evidence WHERE family_id=? AND incident_fingerprint IS NOT NULL`).get(familyId);
          if (lesson.severity === "Blocker" && lesson.responsibility === "agent_fault" && lesson.generalizable === true && lesson.rule_action === "propose_global_rule" && Number(independent.lineages) >= 2 && Number(independent.incidents) >= 2) {
            db.prepare("UPDATE lessons SET project_id=NULL, promotion_state='active_global' WHERE lesson_id=?").run(lesson.lesson_id);
          }
        }
        db.prepare("INSERT INTO review_receipts(receipt_id, job_id, payload_json, created_at) VALUES (?, ?, ?, ?)").run(review.review_receipt_id, jobId, JSON.stringify(persistedReview), nowIso(now));
        db.prepare("INSERT INTO report_contents(content_id, job_id, content_text, created_at) VALUES (?, ?, ?, ?)").run(review.report_content_id, jobId, persistedReport, nowIso(now));
        const notifications = [];
        if (review.status === "reviewed") {
          const bySession = new Map();
          for (const lesson of review.lessons) {
            for (const evidence of lesson.evidence_refs || []) {
              const source = db.prepare("SELECT session_uid, context_epoch, redacted_text FROM session_events WHERE event_uid=?").get(evidence.feedback_event_id);
              if (!source) continue;
              const key = `${source.session_uid}\u0000${source.context_epoch}`;
              const current = bySession.get(key) || {
                ...source,
                language: detectReceiptLanguage(source.redacted_text, receiptLanguage),
                severity: lesson.severity,
                lessonIds: new Set()
              };
              if (SEVERITY_RANK[lesson.severity] > SEVERITY_RANK[current.severity]) current.severity = lesson.severity;
              current.lessonIds.add(lesson.lesson_id);
              bySession.set(key, current);
            }
          }
          for (const session of bySession.values()) {
            notifications.push(createNotificationInTransaction({
              sessionUid: session.session_uid,
              contextEpoch: session.context_epoch,
              jobId,
              kind: "review_completed",
              payload: { severity: session.severity, lesson_count: session.lessonIds.size },
              language: session.language
            }));
          }
        } else {
          for (const session of notificationSessionsForJob(jobId)) {
            notifications.push(createNotificationInTransaction({
              sessionUid: session.session_uid,
              contextEpoch: session.context_epoch,
              jobId,
              kind: "reviewed_no_lesson",
              payload: {},
              language: session.language
            }));
          }
        }
        db.prepare("UPDATE reviewer_jobs SET status='completed', receipt_id=?, reason_code=NULL, lease_until=NULL, updated_at=? WHERE job_id=?").run(review.review_receipt_id, nowIso(now), jobId);
        if (capabilityHash) db.prepare("UPDATE reviewer_jobs SET capability_consumed_at=? WHERE job_id=?").run(Date.now(), jobId);
        db.prepare("UPDATE queue_events SET status='acknowledged' WHERE job_id=?").run(jobId);
        recordReviewerJobEventInTransaction(job, "completed");
        return {
          status: "completed",
          receipt_id: review.review_receipt_id,
          lessonCount: review.lessons.length,
          notificationRefs: notifications.map(asNotificationRef)
        };
      });
    },
    getReportContent(contentId) {
      return db.prepare("SELECT * FROM report_contents WHERE content_id=?").get(contentId) || null;
    },
    getReviewReceipt(receiptId) {
      return db.prepare("SELECT * FROM review_receipts WHERE receipt_id=?").get(receiptId) || null;
    },
    listEncryptedRawRefs() {
      return db.prepare("SELECT DISTINCT encrypted_raw_ref FROM session_events WHERE encrypted_raw_ref IS NOT NULL").all().map((row) => row.encrypted_raw_ref);
    },
    gcExpired({ beforeIso, beforeMs = Date.parse(beforeIso) } = {}) {
      if (!Number.isFinite(beforeMs)) throw new TypeError("beforeIso or beforeMs is required");
      return transaction(() => {
        const events = db.prepare(`SELECT e.event_uid, e.encrypted_raw_ref
          FROM session_events e
          WHERE e.captured_at < ?
            AND NOT EXISTS (
              SELECT 1 FROM session_events related
              JOIN queue_events pending ON pending.event_uid=related.event_uid
              WHERE related.session_uid=e.session_uid AND pending.status='pending'
            )`).all(new Date(beforeMs).toISOString());
        const deleteEventNotifications = db.prepare("DELETE FROM notification_outbox WHERE event_uid=?");
        let notificationCount = 0;
        for (const row of events) {
          notificationCount += deleteEventNotifications.run(row.event_uid).changes;
          db.prepare("DELETE FROM incident_events WHERE event_uid=?").run(row.event_uid);
          db.prepare("DELETE FROM queue_events WHERE event_uid=?").run(row.event_uid);
          db.prepare("DELETE FROM event_observations WHERE event_uid=?").run(row.event_uid);
          db.prepare("DELETE FROM session_events WHERE event_uid=?").run(row.event_uid);
        }
        db.prepare("DELETE FROM sessions WHERE session_uid NOT IN (SELECT DISTINCT session_uid FROM session_events)").run();
        const candidates = [...new Set(events.map((row) => row.encrypted_raw_ref).filter(Boolean))];
        const stillReferenced = db.prepare("SELECT 1 FROM session_events WHERE encrypted_raw_ref=? LIMIT 1");
        const blobRefs = candidates.filter((reference) => !stillReferenced.get(reference));
        return { eventCount: events.length, notificationCount, jobCount: 0, blobRefs };
      });
    },
    claimReviewerJob(jobId, ownerId, leaseUntil, attempt) {
      return transaction(() => {
        const job = db.prepare("SELECT * FROM reviewer_jobs WHERE job_id=?").get(jobId);
        if (!job || (job.status !== "pending" && !(job.status === "running" && job.lease_until && job.lease_until < Date.now()))) throw new LeaseConflictError("reviewer job is not claimable");
        if (job.status === "running") recordReviewerJobEventInTransaction(job, "requeued", "lease_expired");
        const epoch = Number(job.lease_epoch) + 1;
        const result = db.prepare(`UPDATE reviewer_jobs SET status='running', owner_id=?, attempt=?, lease_epoch=?, lease_until=?, updated_at=?
          WHERE job_id=? AND lease_epoch=?`).run(ownerId, attempt, epoch, leaseUntil, nowIso(now), jobId, job.lease_epoch);
        if (result.changes !== 1) throw new LeaseConflictError("stale reviewer lease");
        const claimed = { ...job, owner_id: ownerId, attempt, lease_epoch: epoch, lease_until: leaseUntil, status: "running" };
        recordReviewerJobEventInTransaction(claimed, "claimed");
        return claimed;
      });
    },
    heartbeatReviewerJob(jobId, ownerId, attempt, leaseEpoch, leaseUntil) {
      const result = db.prepare("UPDATE reviewer_jobs SET lease_until=?, updated_at=? WHERE job_id=? AND status='running' AND owner_id=? AND attempt=? AND lease_epoch=? AND lease_until>?").run(leaseUntil, nowIso(now), jobId, ownerId, attempt, leaseEpoch, Date.now());
      if (result.changes !== 1) throw new LeaseConflictError("stale reviewer heartbeat");
    },
    completeReviewerJob(jobId, ownerId, attempt, leaseEpoch, receiptId) {
      return transaction(() => {
        const job = db.prepare("SELECT * FROM reviewer_jobs WHERE job_id=?").get(jobId);
        const result = db.prepare("UPDATE reviewer_jobs SET status='completed', receipt_id=?, reason_code=NULL, lease_until=NULL, updated_at=? WHERE job_id=? AND status='running' AND owner_id=? AND attempt=? AND lease_epoch=? AND lease_until>?").run(receiptId, nowIso(now), jobId, ownerId, attempt, leaseEpoch, Date.now());
        if (result.changes !== 1) throw new LeaseConflictError("stale reviewer completion");
        recordReviewerJobEventInTransaction(job, "completed");
        return { status: "completed", receipt_id: receiptId, notificationRefs: [] };
      });
    },
    failReviewerJob(jobId, ownerId, attempt, leaseEpoch, retryable, reasonCode) {
      return transaction(() => {
        const safeReasonCode = ensureString(reasonCode, "reasonCode")
          .toLowerCase()
          .replace(/[^a-z0-9_]+/g, "_")
          .replace(/^_+|_+$/g, "")
          .slice(0, 64) || "reviewer_failed";
        const job = db.prepare("SELECT * FROM reviewer_jobs WHERE job_id=?").get(jobId);
        const result = db.prepare(`UPDATE reviewer_jobs
          SET status=?, reason_code=?, owner_id=NULL, lease_until=NULL, updated_at=?
          WHERE job_id=? AND status='running' AND owner_id=? AND attempt=? AND lease_epoch=? AND lease_until>?`).run(
          retryable ? "pending" : "failed", safeReasonCode, nowIso(now), jobId, ownerId, attempt, leaseEpoch, Date.now()
        );
        if (result.changes !== 1) throw new LeaseConflictError("stale reviewer failure");
        recordReviewerJobEventInTransaction(job, "failed", safeReasonCode);
        const notifications = retryable ? [] : createExhaustedNotificationsInTransaction(jobId, safeReasonCode);
        return {
          status: retryable ? "pending" : "failed",
          notificationRefs: notifications.map(asNotificationRef)
        };
      });
    },
    close() { db.close(); }
  };
}
