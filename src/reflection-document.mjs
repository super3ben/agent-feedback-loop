import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

import { deriveReviewerFamilyId } from "./reviewer-result.mjs";

const RESULT_KEYS = new Set([
  "outcome", "final_severity", "responsibility", "method_class", "family_id",
  "proposed_family_key", "applies_when", "facts", "user_complaint", "root_cause",
  "class_of_mistake", "method_changes", "repeated_pattern_evidence", "recurrence_of"
]);
const SOURCE_KEYS = new Set(["sourceIdentity", "createdAt", "publishedAt"]);
const CANONICAL_METADATA = [
  "reflection_id", "created_at", "published_at", "final_severity", "responsibility",
  "method_class", "family_id", "applies_when", "effectiveness", "source_identity_hash"
];
const SEVERITIES = new Set(["Major", "Critical", "Blocker"]);
const METHOD_CLASS_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const FAMILY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIMEZONE_TIMESTAMP = /(?:Z|[+-]\d{2}:\d{2})$/i;
const UNSUPPORTED_DIRECTORY_SYNC = new Set(["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EBADF"]);

const HEADING_ALIASES = new Map();
for (const [kind, aliases] of Object.entries({
  facts: ["facts proven by context", "队列评审范围"],
  complaint: ["user complaint in plain language", "user complaint", "用户诉求（白话）"],
  rootCause: ["root cause", "根因"],
  mistakeClass: ["class of mistake", "类别抽象"],
  methodChange: ["method change", "method changes", "方法改进", "preventive constraint"],
  repeatedPattern: ["repeated pattern evidence", "复发证据"]
})) {
  for (const alias of aliases) HEADING_ALIASES.set(normalizeHeading(alias), kind);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, keys, subject) {
  if (!isRecord(value)
      || Object.keys(value).length !== keys.size
      || Object.keys(value).some((key) => !keys.has(key))
      || [...keys].some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${subject} has unexpected fields`);
  }
}

function boundedString(value, name, maxLength, { pattern = null } = {}) {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || Array.from(normalized).length > maxLength) {
    throw new TypeError(`${name} is outside its length bound`);
  }
  if (pattern && !pattern.test(normalized)) throw new TypeError(`${name} has an invalid format`);
  return normalized;
}

function boundedStrings(value, name, { min = 0, max, itemMax }) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new TypeError(`${name} is outside its item bound`);
  }
  return value.map((item) => boundedString(item, name, itemMax));
}

function utcTimestamp(value, name) {
  if (typeof value !== "string" || !TIMEZONE_TIMESTAMP.test(value)) {
    throw new TypeError(`${name} must include a timezone`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${name} is not a valid timestamp`);
  return new Date(milliseconds).toISOString();
}

function titleFromMistakeClass(value, fallback) {
  const flattened = value.normalize("NFC").replace(/[\r\n]+/gu, " ").replace(/\s+/gu, " ").trim();
  const withoutHeadingSyntax = flattened.replace(/^#+\s*/u, "");
  const characters = Array.from(withoutHeadingSyntax || fallback);
  return characters.slice(0, 80).join("");
}

export function validateReflectionModel(result, source) {
  assertExactKeys(result, RESULT_KEYS, "reviewer result");
  assertExactKeys(source, SOURCE_KEYS, "source envelope");
  if (result.outcome !== "lesson") throw new TypeError("reviewer result must contain a lesson");
  if (!SEVERITIES.has(result.final_severity)) throw new TypeError("final_severity is unsupported");
  if (result.responsibility !== "agent_fault") throw new TypeError("responsibility is unsupported");

  const methodClass = boundedString(result.method_class, "method_class", 64, { pattern: METHOD_CLASS_PATTERN });
  const classOfMistake = boundedString(result.class_of_mistake, "class_of_mistake", 2_048);
  let familyId;
  if (result.family_id === null) {
    if (result.recurrence_of.length !== 0 || typeof result.proposed_family_key !== "string") {
      throw new TypeError("new family provenance is invalid");
    }
    familyId = deriveReviewerFamilyId(methodClass, result.proposed_family_key);
  } else {
    familyId = boundedString(result.family_id, "family_id", 128, { pattern: FAMILY_ID_PATTERN });
    if (result.proposed_family_key !== null) throw new TypeError("existing family provenance is invalid");
  }

  const sourceIdentity = boundedString(source.sourceIdentity, "sourceIdentity", 2_048);
  if (sourceIdentity !== source.sourceIdentity) throw new TypeError("sourceIdentity must already be canonical");
  const identityHash = sha256(sourceIdentity);
  return {
    reflection_id: `reflection-${identityHash.slice(0, 24)}`,
    created_at: utcTimestamp(source.createdAt, "createdAt"),
    published_at: utcTimestamp(source.publishedAt, "publishedAt"),
    final_severity: result.final_severity,
    responsibility: "agent_fault",
    method_class: methodClass,
    family_id: familyId,
    applies_when: boundedStrings(result.applies_when, "applies_when", { min: 1, max: 8, itemMax: 160 }),
    effectiveness: "unknown",
    source_identity_hash: identityHash,
    title: titleFromMistakeClass(classOfMistake, methodClass),
    facts: boundedStrings(result.facts, "facts", { min: 1, max: 12, itemMax: 512 }),
    user_complaint: boundedString(result.user_complaint, "user_complaint", 2_048),
    root_cause: boundedString(result.root_cause, "root_cause", 2_048),
    class_of_mistake: classOfMistake,
    method_changes: boundedStrings(result.method_changes, "method_changes", { min: 1, max: 8, itemMax: 512 }),
    repeated_pattern_evidence: boundedStrings(result.repeated_pattern_evidence, "repeated_pattern_evidence", { max: 8, itemMax: 512 })
  };
}

export function renderReflectionMarkdown(model) {
  return [
    `# 反思报告：${model.title}`,
    "",
    `- reflection_id: ${model.reflection_id}`,
    `- created_at: ${model.created_at}`,
    `- published_at: ${model.published_at}`,
    `- final_severity: ${model.final_severity}`,
    `- responsibility: ${model.responsibility}`,
    `- method_class: ${model.method_class}`,
    `- family_id: ${model.family_id}`,
    `- applies_when: ${model.applies_when.join(" | ")}`,
    `- effectiveness: ${model.effectiveness ?? "unknown"}`,
    `- source_identity_hash: ${model.source_identity_hash}`,
    "",
    "## facts proven by context", "", ...model.facts.map((fact) => `- ${fact}`), "",
    "## user complaint in plain language", "", model.user_complaint, "",
    "## root cause", "", model.root_cause, "",
    "## class of mistake", "", model.class_of_mistake, "",
    "## method change", "", ...model.method_changes.map((item, index) => `${index + 1}. ${item}`), "",
    "## repeated pattern evidence", "", ...(model.repeated_pattern_evidence.length
      ? model.repeated_pattern_evidence.map((item) => `- ${item}`)
      : ["- none"]), ""
  ].join("\n");
}

function normalizeHeading(value) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function metadataFrom(markdown) {
  const metadata = new Map();
  const prefix = markdown.split(/^##\s+/mu, 1)[0];
  for (const line of prefix.split(/\r?\n/u)) {
    const match = /^\s*(?:-\s*)?([a-z][a-z0-9_]*)\s*:\s*(.*?)\s*$/iu.exec(line);
    if (!match) continue;
    const key = match[1].toLocaleLowerCase("en-US");
    if (metadata.has(key)) return null;
    metadata.set(key, match[2]);
  }
  return metadata;
}

function sectionsFrom(markdown) {
  const headings = [...markdown.matchAll(/^##\s+(.+?)\s*$/gmu)];
  const sections = new Map();
  for (let index = 0; index < headings.length; index += 1) {
    const kind = HEADING_ALIASES.get(normalizeHeading(headings[index][1]));
    if (!kind || sections.has(kind)) continue;
    const start = headings[index].index + headings[index][0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index : markdown.length;
    sections.set(kind, markdown.slice(start, end).trim());
  }
  return sections;
}

function normalizedSectionText(value) {
  return value.normalize("NFC").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).join(" ").replace(/\s+/gu, " ").trim();
}

function listItems(value) {
  if (!value) return [];
  const lines = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const items = lines.map((line) => line.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/u, "").trim()).filter(Boolean);
  return items.length === 1 && /^none$/iu.test(items[0]) ? [] : items;
}

function filenameCreatedAt(filePath) {
  const name = path.basename(filePath);
  let match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-|\.)/u.exec(name);
  if (match) {
    const [, year, month, day, hour, minute, second] = match;
    const timestamp = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
    return Number.isNaN(timestamp.valueOf()) ? null : timestamp.toISOString();
  }
  match = /^(\d{4})-(\d{2})-(\d{2})(?:-|\.)/u.exec(name);
  if (match) {
    const [, year, month, day] = match;
    const timestamp = new Date(`${year}-${month}-${day}T00:00:00Z`);
    return Number.isNaN(timestamp.valueOf()) ? null : timestamp.toISOString();
  }
  return null;
}

function ineligible(filePath, omission) {
  return { eligible: false, omission, path: filePath };
}

function canonicalDocument(metadata, sections, title, filePath) {
  if (CANONICAL_METADATA.some((key) => !metadata.has(key))
      || !/^reflection-[a-f0-9]{24}$/u.test(metadata.get("reflection_id"))
      || !/^[a-f0-9]{64}$/u.test(metadata.get("source_identity_hash"))
      || !SEVERITIES.has(metadata.get("final_severity"))
      || metadata.get("responsibility") !== "agent_fault"
      || !METHOD_CLASS_PATTERN.test(metadata.get("method_class"))
      || !FAMILY_ID_PATTERN.test(metadata.get("family_id"))) {
    return ineligible(filePath, "canonical_invalid");
  }
  let createdAt;
  let publishedAt;
  try {
    createdAt = utcTimestamp(metadata.get("created_at"), "created_at");
    publishedAt = utcTimestamp(metadata.get("published_at"), "published_at");
  } catch {
    return ineligible(filePath, "canonical_invalid");
  }
  const facts = listItems(sections.get("facts"));
  const complaint = normalizedSectionText(sections.get("complaint") ?? "");
  const rootCause = normalizedSectionText(sections.get("rootCause") ?? "");
  const classOfMistake = normalizedSectionText(sections.get("mistakeClass") ?? "");
  const methodChanges = listItems(sections.get("methodChange"));
  if (!facts.length || !complaint || !rootCause || !classOfMistake || !methodChanges.length) {
    return ineligible(filePath, "canonical_invalid");
  }
  return {
    eligible: true,
    canonical: true,
    path: filePath,
    title,
    reflectionId: metadata.get("reflection_id"),
    createdAt,
    publishedAt,
    severity: metadata.get("final_severity"),
    responsibility: "agent_fault",
    methodClass: metadata.get("method_class"),
    familyId: metadata.get("family_id"),
    appliesWhen: metadata.get("applies_when").split(/\s*\|\s*/u).filter(Boolean),
    effectiveness: metadata.get("effectiveness"),
    sourceIdentityHash: metadata.get("source_identity_hash"),
    facts,
    userComplaint: complaint,
    rootCause,
    classOfMistake,
    methodChanges,
    repeatedPatternEvidence: listItems(sections.get("repeatedPattern"))
  };
}

export function parseReflectionMarkdown(markdown, { path: filePath }) {
  if (typeof markdown !== "string" || typeof filePath !== "string") {
    throw new TypeError("markdown and path must be strings");
  }
  const metadata = metadataFrom(markdown);
  if (!metadata) return ineligible(filePath, "invalid_metadata");
  const sections = sectionsFrom(markdown);
  const titleMatch = /^#\s+(.+?)\s*$/mu.exec(markdown);
  const title = titleMatch ? titleMatch[1].replace(/^反思报告：/u, "").trim() : "";
  if (metadata.has("reflection_id")) return canonicalDocument(metadata, sections, title, filePath);

  const severity = metadata.get("final_severity");
  const responsibility = metadata.get("responsibility");
  const classOfMistake = normalizedSectionText(sections.get("mistakeClass") ?? "");
  const methodChanges = listItems(sections.get("methodChange"));
  if (!SEVERITIES.has(severity) || responsibility !== "agent_fault" || !classOfMistake || !methodChanges.length) {
    return ineligible(filePath, "legacy_incomplete");
  }
  const methodClass = `legacy-method-${sha256(classOfMistake).slice(0, 20)}`;
  return {
    eligible: true,
    canonical: false,
    path: filePath,
    title,
    reflectionId: null,
    createdAt: filenameCreatedAt(filePath),
    publishedAt: null,
    severity,
    responsibility: "agent_fault",
    methodClass,
    familyId: `legacy-family-${sha256(`${classOfMistake}\n${methodClass}`).slice(0, 20)}`,
    appliesWhen: [],
    effectiveness: "unknown",
    sourceIdentityHash: null,
    facts: listItems(sections.get("facts")),
    userComplaint: normalizedSectionText(sections.get("complaint") ?? ""),
    rootCause: normalizedSectionText(sections.get("rootCause") ?? ""),
    classOfMistake,
    methodChanges,
    repeatedPatternEvidence: listItems(sections.get("repeatedPattern"))
  };
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function strictUtf8(bytes) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function readBounded(handle, maxFileBytes) {
  const bytes = Buffer.allocUnsafe(maxFileBytes + 1);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return bytes.subarray(0, offset);
}

async function lstatOrNull(fsImpl, targetPath) {
  try {
    return await fsImpl.lstat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function currentUid() {
  if (typeof process.getuid !== "function") throw new Error("unsupported_platform");
  return process.getuid();
}

async function assertOwnedDirectory(fsImpl, directory, label) {
  const info = await fsImpl.lstat(directory);
  if (info.isSymbolicLink()) throw new Error(`${label}_symlink`);
  if (!info.isDirectory()) throw new Error(`${label}_not_directory`);
  if (info.uid !== currentUid()) throw new Error(`${label}_not_owned`);
}

async function catalogReflectionDirectory(projectDir, fsImpl) {
  if (!path.isAbsolute(projectDir)) throw new TypeError("projectDir must be absolute");
  await assertOwnedDirectory(fsImpl, projectDir, "project_root");
  const agentDir = path.join(projectDir, ".agent");
  const reflectionDir = path.join(agentDir, "reflections");
  const agentInfo = await lstatOrNull(fsImpl, agentDir);
  if (!agentInfo) return null;
  await assertOwnedDirectory(fsImpl, agentDir, "agent_directory");
  const reflectionInfo = await lstatOrNull(fsImpl, reflectionDir);
  if (!reflectionInfo) return null;
  await assertOwnedDirectory(fsImpl, reflectionDir, "reflection_directory");
  return reflectionDir;
}

export async function readReflectionCatalog({
  projectDir,
  publishedBefore,
  maxFileBytes = 131_072,
  maxFiles = 256
}) {
  const fsImpl = fsPromises;
  positiveInteger(maxFileBytes, "maxFileBytes");
  positiveInteger(maxFiles, "maxFiles");
  const cutoff = utcTimestamp(publishedBefore, "publishedBefore");
  const cutoffMs = Date.parse(cutoff);
  const reflectionDir = await catalogReflectionDirectory(projectDir, fsImpl);
  if (!reflectionDir) return { documents: [], omissions: [] };

  const names = (await fsImpl.readdir(reflectionDir, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith(".md"))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const documents = [];
  const omissions = [];
  for (let index = 0; index < names.length; index += 1) {
    const entry = names[index];
    const filePath = path.join(reflectionDir, entry.name);
    if (index >= maxFiles) {
      omissions.push({ path: filePath, omission: "max_files_exceeded" });
      continue;
    }
    if (entry.isSymbolicLink()) {
      omissions.push({ path: filePath, omission: "symlink" });
      continue;
    }
    if (!entry.isFile()) {
      omissions.push({ path: filePath, omission: "not_regular_file" });
      continue;
    }
    let handle;
    try {
      try {
        handle = await fsImpl.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      } catch (error) {
        omissions.push({ path: filePath, omission: error?.code === "ELOOP" ? "symlink" : "changed_during_read" });
        continue;
      }
      const before = await handle.stat();
      if (!before.isFile()) {
        omissions.push({ path: filePath, omission: "not_regular_file" });
        continue;
      }
      if (before.size > maxFileBytes) {
        omissions.push({ path: filePath, omission: "file_too_large" });
        continue;
      }
      const bytes = await readBounded(handle, maxFileBytes);
      if (bytes.byteLength > maxFileBytes) {
        omissions.push({ path: filePath, omission: "file_too_large" });
        continue;
      }
      let markdown;
      try {
        markdown = strictUtf8(bytes);
      } catch {
        omissions.push({ path: filePath, omission: "invalid_utf8" });
        continue;
      }
      const parsed = parseReflectionMarkdown(markdown, { path: filePath });
      if (!parsed.eligible) {
        omissions.push({ path: filePath, omission: parsed.omission });
        continue;
      }
      if (parsed.canonical) {
        if (Date.parse(parsed.publishedAt) >= cutoffMs) {
          omissions.push({ path: filePath, omission: "published_after_cutoff" });
          continue;
        }
      } else {
        const after = await handle.stat();
        if (!after.isFile()) {
          omissions.push({ path: filePath, omission: "changed_during_read" });
          continue;
        }
        if (after.mtimeMs >= cutoffMs) {
          omissions.push({ path: filePath, omission: "published_after_cutoff" });
          continue;
        }
        parsed.publishedAt = after.mtime.toISOString();
        if (!parsed.createdAt) parsed.createdAt = parsed.publishedAt;
      }
      documents.push(parsed);
    } finally {
      await handle?.close();
    }
  }
  return { documents, omissions };
}

async function createPrivateDirectory(fsImpl, directory, label) {
  try {
    await fsImpl.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await assertOwnedDirectory(fsImpl, directory, label);
}

async function publicationDirectory({ projectDir, reflectionDir, fsImpl }) {
  if ((projectDir === undefined) === (reflectionDir === undefined)) {
    throw new TypeError("exactly one of projectDir or reflectionDir is required");
  }
  const selected = projectDir ?? reflectionDir;
  if (typeof selected !== "string" || !path.isAbsolute(selected)) {
    throw new TypeError("publication directory must be absolute");
  }
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("unsupported_platform");
  if (reflectionDir !== undefined) {
    await assertOwnedDirectory(fsImpl, reflectionDir, "reflection_directory");
    return { directory: reflectionDir, verify: () => assertOwnedDirectory(fsImpl, reflectionDir, "reflection_directory") };
  }

  await assertOwnedDirectory(fsImpl, projectDir, "project_root");
  const agentDir = path.join(projectDir, ".agent");
  const directory = path.join(agentDir, "reflections");
  await createPrivateDirectory(fsImpl, agentDir, "agent_directory");
  await createPrivateDirectory(fsImpl, directory, "reflection_directory");
  const verify = async () => {
    await assertOwnedDirectory(fsImpl, projectDir, "project_root");
    await assertOwnedDirectory(fsImpl, agentDir, "agent_directory");
    await assertOwnedDirectory(fsImpl, directory, "reflection_directory");
  };
  return { directory, verify };
}

function slug(value, fallback) {
  const normalized = value.normalize("NFKD").toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48).replace(/-+$/u, "");
  return normalized || fallback;
}

function targetName(model) {
  const timestamp = utcTimestamp(model.created_at, "created_at");
  const date = new Date(timestamp);
  const stamp = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("") + "-" + [
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
    String(date.getUTCSeconds()).padStart(2, "0")
  ].join("");
  const suffix = model.reflection_id.slice(-12);
  return `${stamp}-${slug(model.title, suffix)}-${suffix}.md`;
}

function publicationError(code, cause) {
  const error = new Error(code, { cause });
  error.code = code;
  return error;
}

async function publicationForIdentity(fsImpl, directory, reflectionId, expectedHash) {
  const suffix = reflectionId.slice(-12);
  const candidates = (await fsImpl.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith(`-${suffix}.md`))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  let identical = null;
  for (const entry of candidates) {
    const candidatePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) throw publicationError("publication_collision");
    let bytes;
    let parsed;
    try {
      const info = await fsImpl.lstat(candidatePath);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("candidate is not a regular file");
      bytes = await fsImpl.readFile(candidatePath);
      parsed = parseReflectionMarkdown(strictUtf8(bytes), { path: candidatePath });
    } catch (error) {
      throw publicationError("publication_collision", error);
    }
    if (!parsed.eligible || !parsed.canonical || parsed.reflectionId !== reflectionId) {
      throw publicationError("publication_collision");
    }
    const actualHash = sha256(bytes);
    if (actualHash !== expectedHash) throw publicationError("publication_collision");
    identical = { path: candidatePath, sha256: actualHash, created: false };
  }
  return identical;
}

async function syncDirectory(fsImpl, directory) {
  let handle;
  try {
    handle = await fsImpl.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!UNSUPPORTED_DIRECTORY_SYNC.has(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

export async function publishReflectionDocument({
  projectDir,
  reflectionDir,
  model,
  beforeRename,
  fsImpl = fsPromises
}) {
  const { directory, verify } = await publicationDirectory({ projectDir, reflectionDir, fsImpl });
  const markdown = renderReflectionMarkdown(model);
  const expectedHash = sha256(markdown);
  const targetPath = path.join(directory, targetName(model));
  const identityAdopted = await publicationForIdentity(
    fsImpl, directory, model.reflection_id, expectedHash
  );
  if (identityAdopted) return identityAdopted;

  const tempPath = path.join(directory, `.reflection-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  let handle;
  let renamed = false;
  try {
    try {
      handle = await fsImpl.open(tempPath, "wx", 0o600);
      await handle.writeFile(markdown, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
    } catch (error) {
      throw publicationError("publication_write_failed", error);
    }
    if (beforeRename !== undefined) {
      if (typeof beforeRename !== "function") throw publicationError("publication_before_rename_failed");
      try {
        await beforeRename({ tempPath, targetPath });
      } catch (error) {
        throw publicationError("publication_before_rename_failed", error);
      }
    }
    await verify();
    const identityRaced = await publicationForIdentity(
      fsImpl, directory, model.reflection_id, expectedHash
    );
    if (identityRaced) return identityRaced;
    try {
      await fsImpl.rename(tempPath, targetPath);
      renamed = true;
    } catch (error) {
      throw publicationError("publication_rename_failed", error);
    }
    try {
      await syncDirectory(fsImpl, directory);
      const actualHash = sha256(await fsImpl.readFile(targetPath));
      if (actualHash !== expectedHash) throw new Error("published hash mismatch");
      return { path: targetPath, sha256: actualHash, created: true };
    } catch (error) {
      throw publicationError("publication_verification_failed", error);
    }
  } finally {
    try {
      await handle?.close();
    } catch {
      // The original publication error is more useful than a cleanup failure.
    }
    if (!renamed) {
      try {
        await fsImpl.unlink(tempPath);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          // A private, non-selectable temp may remain if the filesystem rejects cleanup.
        }
      }
    }
  }
}
