import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { pathsFor } from "./index.mjs";
import {
  parseReflectionMarkdown,
  publishReflectionDocument,
  renderReflectionMarkdown,
  validateReflectionModel
} from "./reflection-document.mjs";

const SOURCE_SUFFIXES = Object.freeze(["", "-wal", "-shm"]);
const SUPPORTED_SCHEMA_VERSIONS = new Set([8, 9]);
const SUPPORTED_SEVERITIES = new Set(["Major", "Critical", "Blocker"]);
const PLAN_STATE = new WeakMap();
const TIMEZONE_TIMESTAMP = /(?:Z|[+-]\d{2}:\d{2})$/iu;
const LEGACY_METHOD_CLASS = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u;
const MAX_ID_CHARACTERS = 2_048;
const MAX_CAUSAL_CHARACTERS = 2_048;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exportError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function fail(code, cause) {
  throw exportError(code, cause);
}

function currentUid() {
  if ((process.platform !== "darwin" && process.platform !== "linux")
      || typeof process.getuid !== "function") {
    fail("unsupported_platform");
  }
  return process.getuid();
}

function characterLength(value) {
  return Array.from(value).length;
}

function boundedIdentity(value) {
  return typeof value === "string"
    && value.length > 0
    && characterLength(value) <= MAX_ID_CHARACTERS;
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalAbsolute(value, label) {
  if (typeof value !== "string" || !value || value.includes("\u0000")
      || !path.isAbsolute(value) || path.normalize(value) !== value) {
    fail(`${label}_path_invalid`);
  }
  return value;
}

async function lstatOrNull(target) {
  try {
    return await fsPromises.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("filesystem_check_failed", error);
  }
}

async function assertNoSymlinkComponents(target, label) {
  const root = path.parse(target).root;
  const components = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    const info = await lstatOrNull(current);
    if (!info) fail(`${label}_path_missing`);
    if (info.isSymbolicLink()) fail(`${label}_path_symlink`);
    if (current !== target && !info.isDirectory()) fail(`${label}_path_invalid`);
  }
}

async function canonicalExisting(target, label) {
  canonicalAbsolute(target, label);
  await assertNoSymlinkComponents(target, label);
  let resolved;
  try {
    resolved = await fsPromises.realpath(target);
  } catch (error) {
    fail(`${label}_path_missing`, error);
  }
  if (resolved !== target) fail(`${label}_path_not_canonical`);
  return target;
}

async function validateOutputPath(outputDir) {
  canonicalAbsolute(outputDir, "output");
  const info = await lstatOrNull(outputDir);
  if (info) {
    await assertNoSymlinkComponents(outputDir, "output");
    if (!info.isDirectory()) fail("output_not_directory");
    if (info.uid !== currentUid()) fail("output_not_owned");
    let resolved;
    try {
      resolved = await fsPromises.realpath(outputDir);
    } catch (error) {
      fail("output_path_invalid", error);
    }
    if (resolved !== outputDir) fail("output_path_not_canonical");
    return { exists: true };
  }

  const parent = path.dirname(outputDir);
  if (parent === outputDir) fail("output_parent_invalid");
  try {
    await canonicalExisting(parent, "output_parent");
  } catch (error) {
    if (String(error?.code || "").startsWith("output_parent_path_symlink")) {
      fail("output_path_symlink", error);
    }
    throw error;
  }
  const parentInfo = await lstatOrNull(parent);
  if (!parentInfo?.isDirectory()) fail("output_parent_not_directory");
  if (parentInfo.uid !== currentUid()) fail("output_parent_not_owned");
  return { exists: false };
}

function statIdentity(info) {
  return Object.freeze({
    dev: String(info.dev),
    ino: String(info.ino),
    size: String(info.size),
    mode: String(info.mode),
    uid: String(info.uid),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs)
  });
}

function sameIdentity(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

async function hashHandle(handle) {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) break;
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
    if (!Number.isSafeInteger(position)) fail("source_file_too_large");
  }
  return digest.digest("hex");
}

async function openSourceMember(sourceDb, suffix, required) {
  const memberPath = `${sourceDb}${suffix}`;
  let handle;
  try {
    handle = await fsPromises.open(memberPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return null;
    if (error?.code === "ELOOP") fail("source_path_symlink", error);
    fail(required ? "source_path_missing" : "source_set_invalid", error);
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) fail("source_not_regular_file");
    if (info.uid !== BigInt(currentUid())) fail("source_not_owned");
    return { suffix, handle, identity: statIdentity(info) };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function openSourceSet(sourceDb) {
  await canonicalExisting(sourceDb, "source");
  const members = [];
  try {
    for (const suffix of SOURCE_SUFFIXES) {
      const member = await openSourceMember(sourceDb, suffix, suffix === "");
      if (member) members.push(member);
    }
    return members;
  } catch (error) {
    await Promise.all(members.map((member) => member.handle.close().catch(() => {})));
    throw error;
  }
}

async function closeSourceSet(members) {
  await Promise.all(members.map((member) => member.handle.close().catch(() => {})));
}

async function fingerprintOpenSet(members) {
  const fingerprint = [];
  for (const member of members) {
    const before = statIdentity(await member.handle.stat({ bigint: true }));
    if (!sameIdentity(member.identity, before)) fail("source_changed");
    const hash = await hashHandle(member.handle);
    const after = statIdentity(await member.handle.stat({ bigint: true }));
    if (!sameIdentity(before, after)) fail("source_changed");
    fingerprint.push(Object.freeze({ suffix: member.suffix, identity: after, sha256: hash }));
  }
  return Object.freeze(fingerprint);
}

function sameFingerprint(left, right) {
  return left.length === right.length && left.every((member, index) => {
    const other = right[index];
    return member.suffix === other?.suffix
      && member.sha256 === other.sha256
      && sameIdentity(member.identity, other.identity);
  });
}

async function currentSourceFingerprint(sourceDb) {
  const members = await openSourceSet(sourceDb);
  try {
    return await fingerprintOpenSet(members);
  } finally {
    await closeSourceSet(members);
  }
}

async function copyMember(member, destination) {
  let destinationHandle;
  const digest = createHash("sha256");
  try {
    destinationHandle = await fsPromises.open(destination, "wx", 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await member.handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(
          buffer, written, bytesRead - written, position + written
        );
        if (result.bytesWritten <= 0) fail("snapshot_copy_failed");
        written += result.bytesWritten;
      }
      position += bytesRead;
      if (!Number.isSafeInteger(position)) fail("source_file_too_large");
    }
    await destinationHandle.sync();
    return digest.digest("hex");
  } catch (error) {
    if (error?.code && String(error.code).startsWith("source_")) throw error;
    fail("snapshot_copy_failed", error);
  } finally {
    await destinationHandle?.close().catch(() => {});
  }
}

async function readPrivateSnapshot(sourceDb) {
  const snapshotRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "afl-legacy-snapshot-"));
  await fsPromises.chmod(snapshotRoot, 0o700);
  const snapshotDb = path.join(snapshotRoot, "legacy.sqlite3");
  let sourceMembers = [];
  try {
    sourceMembers = await openSourceSet(sourceDb);
    const before = await fingerprintOpenSet(sourceMembers);
    for (const [index, member] of sourceMembers.entries()) {
      const copiedHash = await copyMember(member, `${snapshotDb}${member.suffix}`);
      if (copiedHash !== before[index].sha256) fail("source_changed");
    }
    const after = await fingerprintOpenSet(sourceMembers);
    if (!sameFingerprint(before, after)) fail("source_changed");

    const current = await currentSourceFingerprint(sourceDb);
    if (!sameFingerprint(before, current)) fail("source_changed");

    let database;
    try {
      database = new DatabaseSync(snapshotDb, { readOnly: true });
      // Keep every statement literal and limited to the version marker and
      // the four declared legacy export tables.
      const migrations = database.prepare(
        "SELECT version, applied_at FROM schema_migrations ORDER BY version"
      ).all();
      const receipts = database.prepare(
        "SELECT receipt_id, job_id, payload_json, created_at FROM review_receipts ORDER BY receipt_id"
      ).all();
      const reports = database.prepare(
        "SELECT content_id, job_id, content_text, created_at FROM report_contents ORDER BY content_id"
      ).all();
      const lessons = database.prepare(
        "SELECT lesson_id, severity, responsibility, method_class, class_id, current_revision FROM lessons ORDER BY lesson_id"
      ).all();
      const revisions = database.prepare(
        "SELECT lesson_id, revision, card_json, created_at FROM lesson_revisions ORDER BY lesson_id, revision"
      ).all();
      return { fingerprint: before, migrations, receipts, reports, lessons, revisions };
    } catch (error) {
      fail("legacy_schema_invalid", error);
    } finally {
      try {
        database?.close();
      } catch (error) {
        fail("snapshot_close_failed", error);
      }
    }
  } finally {
    await closeSourceSet(sourceMembers);
    await fsPromises.rm(snapshotRoot, { recursive: true, force: true });
  }
}

function validTimestamp(value) {
  return typeof value === "string"
    && TIMEZONE_TIMESTAMP.test(value)
    && Number.isFinite(Date.parse(value));
}

function tupleSerialization(receiptId, lessonId, revision, ordinal) {
  const tuple = ["legacy-export-v1", receiptId, lessonId, revision];
  if (lessonId === null || revision === null) tuple.push(ordinal);
  return JSON.stringify(tuple);
}

function opaqueId(receiptId, lessonId, revision, ordinal = 0) {
  return `legacy-${sha256(tupleSerialization(receiptId, lessonId, revision, ordinal))}`;
}

function revisionKey(lessonId, revision) {
  return JSON.stringify([lessonId, revision]);
}

function safeText(value, maxCharacters = MAX_CAUSAL_CHARACTERS) {
  return typeof value === "string"
    && value.trim().length > 0
    && characterLength(value.trim()) <= maxCharacters;
}

function evidenceComplete(lesson) {
  if (!Array.isArray(lesson.evidence_refs) || lesson.evidence_refs.length === 0) return false;
  return lesson.evidence_refs.every((reference) => isRecord(reference)
    && boundedIdentity(reference.feedback_event_id)
    && typeof reference.feedback_quote === "string"
    && reference.feedback_quote === reference.feedback_quote.trim()
    && safeText(reference.feedback_quote, 512)
    && Array.isArray(reference.referent_event_ids)
    && reference.referent_event_ids.length > 0
    && reference.referent_event_ids.every(boundedIdentity));
}

function causalEvidenceComplete(lesson) {
  if (!Array.isArray(lesson.causal_chain) || lesson.causal_chain.length < 5
      || !lesson.causal_chain.every((entry) => safeText(entry))) return false;
  if (!["medium", "high"].includes(lesson.confidence)
      || typeof lesson.generalizable !== "boolean") return false;
  if (["Critical", "Blocker"].includes(lesson.severity)) {
    if (!Array.isArray(lesson.decision_timeline) || lesson.decision_timeline.length < 2
        || !lesson.decision_timeline.every((entry) => isRecord(entry) || safeText(entry))
        || !safeText(lesson.counterfactual_checkpoint)) return false;
  }
  if (lesson.severity === "Blocker") {
    if (!safeText(lesson.impact_scope)
        || !safeText(lesson.stop_condition)
        || !safeText(lesson.rollback_or_isolation)
        || !Array.isArray(lesson.global_promotion_evidence)) return false;
  }
  return true;
}

function cardComplete(card) {
  if (!isRecord(card)) return false;
  for (const field of ["when", "must_do", "must_not", "verify", "why", "exception"]) {
    if (!safeText(card[field])) return false;
  }
  return Array.isArray(card.source_ids)
    && card.source_ids.length > 0
    && card.source_ids.every(boundedIdentity);
}

function exactEvidenceHash(receipt, report, lessonRow, revisionRow) {
  return sha256(JSON.stringify([
    [receipt.receipt_id, receipt.job_id, receipt.payload_json, receipt.created_at],
    [report.content_id, report.job_id, report.content_text, report.created_at],
    [
      lessonRow.lesson_id,
      lessonRow.severity,
      lessonRow.responsibility,
      lessonRow.method_class,
      lessonRow.class_id,
      lessonRow.current_revision
    ],
    [revisionRow.lesson_id, revisionRow.revision, revisionRow.card_json, revisionRow.created_at]
  ]));
}

function incomplete(id, reason) {
  return { id, status: "incomplete", reason };
}

function candidateFor({ receipt, payload, lesson, ordinal, reports, lessons, revisions }) {
  const id = opaqueId(receipt.receipt_id, lesson?.lesson_id ?? null, lesson?.revision ?? null, ordinal);
  if (!isRecord(lesson) || !boundedIdentity(lesson.lesson_id)
      || !Number.isSafeInteger(lesson.revision) || lesson.revision <= 0) {
    return { item: incomplete(id, "invalid_lesson_identity") };
  }
  if (!SUPPORTED_SEVERITIES.has(lesson.severity)) {
    return { item: incomplete(id, "unsupported_severity") };
  }
  if (lesson.responsibility !== "agent_fault") {
    return { item: incomplete(id, "unsupported_responsibility") };
  }
  if (!boundedIdentity(payload.report_content_id)) {
    return { item: incomplete(id, "missing_report") };
  }
  const report = reports.get(payload.report_content_id);
  if (!report) return { item: incomplete(id, "missing_report") };
  if (report.job_id !== receipt.job_id) return { item: incomplete(id, "mismatched_report") };
  const lessonRow = lessons.get(lesson.lesson_id);
  if (!lessonRow) return { item: incomplete(id, "missing_lesson") };
  const revisionRow = revisions.get(revisionKey(lesson.lesson_id, lesson.revision));
  if (!revisionRow) return { item: incomplete(id, "missing_revision") };
  const currentRevision = Number(lessonRow.current_revision);
  if (!Number.isSafeInteger(currentRevision) || currentRevision < lesson.revision) {
    return { item: incomplete(id, "mismatched_revision") };
  }
  if (currentRevision === lesson.revision
      && (lessonRow.severity !== lesson.severity
        || lessonRow.responsibility !== lesson.responsibility
        || lessonRow.method_class !== lesson.method_class
        || lessonRow.class_id !== lesson.class_id)) {
    return { item: incomplete(id, "mismatched_lesson") };
  }
  if (!validTimestamp(receipt.created_at)
      || !validTimestamp(report.created_at)
      || !validTimestamp(revisionRow.created_at)) {
    return { item: incomplete(id, "invalid_timestamp") };
  }
  if (!evidenceComplete(lesson)) return { item: incomplete(id, "incomplete_evidence") };
  if (!causalEvidenceComplete(lesson)) return { item: incomplete(id, "incomplete_causal_evidence") };
  if (typeof lesson.method_class !== "string"
      || !LEGACY_METHOD_CLASS.test(lesson.method_class)
      || !safeText(lesson.class_id)) {
    return { item: incomplete(id, "incomplete_causal_evidence") };
  }

  let card;
  try {
    card = JSON.parse(revisionRow.card_json);
  } catch {
    return { item: incomplete(id, "malformed_card") };
  }
  if (!cardComplete(card)) {
    return { item: incomplete(id, "incomplete_card") };
  }

  const quotes = lesson.evidence_refs.map((reference) => reference.feedback_quote);
  const legacyFamilyId = sha256(`${lesson.method_class}\u0000${lesson.class_id}`);
  const evidenceHash = exactEvidenceHash(receipt, report, lessonRow, revisionRow);
  const sourceIdentity = `${id}:${evidenceHash}`;
  const result = {
    outcome: "lesson",
    final_severity: lesson.severity,
    responsibility: "agent_fault",
    method_class: lesson.method_class.replaceAll("-", "_"),
    family_id: legacyFamilyId,
    proposed_family_key: null,
    applies_when: [card.when],
    facts: quotes,
    user_complaint: quotes.join("\n"),
    root_cause: report.content_text,
    class_of_mistake: lesson.class_id,
    method_changes: [card.must_do, card.must_not, card.verify],
    repeated_pattern_evidence: [],
    recurrence_of: []
  };
  try {
    const model = validateReflectionModel(result, {
      sourceIdentity,
      createdAt: revisionRow.created_at,
      publishedAt: receipt.created_at
    });
    return { item: { id, status: "planned" }, candidate: { id, model } };
  } catch {
    return { item: incomplete(id, "invalid_model") };
  }
}

function buildCandidates(rows) {
  const versions = rows.migrations.map((row) => Number(row.version));
  const schemaVersion = versions.length > 0 ? Math.max(...versions) : NaN;
  if (!Number.isSafeInteger(schemaVersion) || !SUPPORTED_SCHEMA_VERSIONS.has(schemaVersion)) {
    fail("unsupported_legacy_schema");
  }
  const reports = new Map(rows.reports.map((row) => [row.content_id, row]));
  const lessons = new Map(rows.lessons.map((row) => [row.lesson_id, row]));
  const revisions = new Map(rows.revisions.map((row) => [revisionKey(row.lesson_id, Number(row.revision)), row]));
  const items = [];
  const candidates = [];

  for (const receipt of rows.receipts) {
    let payload;
    try {
      payload = JSON.parse(receipt.payload_json);
    } catch {
      items.push(incomplete(opaqueId(receipt.receipt_id, null, null), "malformed_receipt"));
      continue;
    }
    if (isRecord(payload) && payload.status === "reviewed_no_lesson") continue;
    if (!isRecord(payload) || payload.write_complete !== true || payload.status !== "reviewed"
        || !Array.isArray(payload.lessons) || payload.lessons.length === 0) {
      items.push(incomplete(opaqueId(receipt.receipt_id, null, null), "invalid_receipt"));
      continue;
    }
    if (payload.review_receipt_id !== undefined
        && payload.review_receipt_id !== receipt.receipt_id) {
      for (const [ordinal, lesson] of payload.lessons.entries()) {
        items.push(incomplete(
          opaqueId(receipt.receipt_id, lesson?.lesson_id ?? null, lesson?.revision ?? null, ordinal),
          "mismatched_receipt"
        ));
      }
      continue;
    }
    for (const [ordinal, lesson] of payload.lessons.entries()) {
      const converted = candidateFor({
        receipt, payload, lesson, ordinal, reports, lessons, revisions
      });
      items.push(converted.item);
      if (converted.candidate) candidates.push(converted.candidate);
    }
  }
  return { items, candidates };
}

async function inspectPublication(candidate, outputDir, outputExists) {
  if (!outputExists) return null;
  const suffix = candidate.model.reflection_id.slice(-12);
  const expected = Buffer.from(renderReflectionMarkdown(candidate.model), "utf8");
  const expectedHash = sha256(expected);
  let entries;
  try {
    entries = await fsPromises.readdir(outputDir, { withFileTypes: true });
  } catch (error) {
    fail("output_read_failed", error);
  }
  const matching = entries
    .filter((entry) => entry.name.endsWith(`-${suffix}.md`))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of matching) {
    if (entry.isSymbolicLink() || !entry.isFile()) return "publication_collision";
    let handle;
    try {
      handle = await fsPromises.open(
        path.join(outputDir, entry.name),
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
      );
      const info = await handle.stat();
      if (!info.isFile()) return "publication_collision";
      const bytes = await handle.readFile();
      const parsed = parseReflectionMarkdown(new TextDecoder("utf-8", { fatal: true }).decode(bytes), {
        path: entry.name
      });
      if (!parsed.eligible || !parsed.canonical
          || parsed.reflectionId !== candidate.model.reflection_id
          || sha256(bytes) !== expectedHash
          || !bytes.equals(expected)) return "publication_collision";
    } catch {
      return "publication_collision";
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return null;
}

async function revalidateSource(sourceDb, expected) {
  const actual = await currentSourceFingerprint(sourceDb);
  if (!sameFingerprint(expected, actual)) fail("source_changed");
}

async function realLegacyDatabasePath() {
  const configured = path.normalize(pathsFor(os.homedir()).legacyDatabase);
  try {
    return await fsPromises.realpath(configured);
  } catch (error) {
    if (error?.code === "ENOENT") return configured;
    fail("legacy_database_path_check_failed", error);
  }
}

async function ensureOutputLeaf(outputDir) {
  const state = await validateOutputPath(outputDir);
  if (state.exists) return;
  try {
    await fsPromises.mkdir(outputDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") fail("output_create_failed", error);
  }
  await validateOutputPath(outputDir);
  try {
    await fsPromises.chmod(outputDir, 0o700);
  } catch (error) {
    fail("output_create_failed", error);
  }
}

export async function inspectLegacyExport({ sourceDb, outputDir } = {}) {
  currentUid();
  canonicalAbsolute(sourceDb, "source");
  canonicalAbsolute(outputDir, "output");
  const outputState = await validateOutputPath(outputDir);
  const rows = await readPrivateSnapshot(sourceDb);
  const converted = buildCandidates(rows);
  let conflicts = 0;
  const conflictIds = new Set();
  for (const candidate of converted.candidates) {
    const reason = await inspectPublication(candidate, outputDir, outputState.exists);
    if (reason) {
      conflicts += 1;
      conflictIds.add(candidate.id);
    }
  }
  const publicItems = converted.items.map((item) => conflictIds.has(item.id)
    ? Object.freeze({ id: item.id, status: "conflict", reason: "publication_collision" })
    : Object.freeze({ ...item }));
  const counts = Object.freeze({
    planned: converted.candidates.length,
    incomplete: publicItems.filter((item) => item.status === "incomplete").length,
    conflicts
  });
  const plan = Object.freeze({ counts, items: Object.freeze(publicItems) });
  PLAN_STATE.set(plan, Object.freeze({
    sourceDb,
    outputDir,
    fingerprint: rows.fingerprint,
    candidates: Object.freeze(converted.candidates),
    incomplete: counts.incomplete
  }));
  return plan;
}

export async function executeLegacyExport({ plan, dryRun } = {}) {
  const state = PLAN_STATE.get(plan);
  if (!state || typeof dryRun !== "boolean") fail("invalid_export_plan");
  await revalidateSource(state.sourceDb, state.fingerprint);
  await validateOutputPath(state.outputDir);
  if (dryRun) {
    await revalidateSource(state.sourceDb, state.fingerprint);
    return {
      planned: state.candidates.length,
      written: 0,
      skipped: 0,
      incomplete: state.incomplete,
      conflicts: plan.counts.conflicts
    };
  }

  if (state.sourceDb === await realLegacyDatabasePath()) fail("live_legacy_database_refused");
  if (state.candidates.length > 0) await ensureOutputLeaf(state.outputDir);
  let written = 0;
  let skipped = 0;
  let conflicts = 0;
  let publicationFailure = null;
  try {
    for (const candidate of state.candidates) {
      try {
        const result = await publishReflectionDocument({
          reflectionDir: state.outputDir,
          model: candidate.model
        });
        if (result.created) written += 1;
        else skipped += 1;
      } catch (error) {
        if (error?.code === "publication_collision" || error?.message === "publication_collision") {
          conflicts += 1;
          continue;
        }
        publicationFailure = exportError("publication_failed", error);
        break;
      }
    }
  } finally {
    await revalidateSource(state.sourceDb, state.fingerprint);
  }
  if (publicationFailure) throw publicationFailure;
  return {
    planned: state.candidates.length,
    written,
    skipped,
    incomplete: state.incomplete,
    conflicts
  };
}
