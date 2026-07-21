import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";

const AUTHORITY_VALUES = Object.freeze([
  "explicit_user", "approved_spec", "approved_plan", "verified_runtime",
  "review_finding", "inferred_advisory"
]);
const AUTHORITY_WHITELIST = new Set(AUTHORITY_VALUES);

export const CONTRACT_AUTHORITIES = Object.freeze({
  has(value) {
    return AUTHORITY_WHITELIST.has(value);
  },
  add() {
    return CONTRACT_AUTHORITIES;
  }
});

const HARD_AUTHORITIES = new Set(["explicit_user", "approved_spec", "approved_plan", "verified_runtime"]);
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_TEXT_LENGTH = 16_384;
const MAX_COLLECTION_LENGTH = 128;
const IDENTIFIER = /^[a-z][a-z0-9_-]{0,127}$/u;
const LINEAGE_ID = /^[a-f0-9]{64}$/u;

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function plainRecord(value, code = "invalid_record") {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw coded(code);
  }
  return value;
}

function boundedText(value, code = "invalid_text") {
  if (typeof value !== "string" || value.includes("\0") || value.length > MAX_TEXT_LENGTH) throw coded(code);
  return value;
}

function boundedId(value) {
  if (typeof value !== "string" || value.includes("\0") || value.length > MAX_IDENTIFIER_LENGTH || !IDENTIFIER.test(value)) {
    throw coded("invalid_identifier");
  }
  return value;
}

function boundedKey(value) {
  if (typeof value !== "string" || value.includes("\0") || value.length > MAX_IDENTIFIER_LENGTH) throw coded("invalid_identifier");
  return value;
}

function validateLineage(value) {
  const candidate = typeof value === "string" && value.endsWith("\n") ? value.slice(0, -1) : value;
  if (typeof candidate !== "string" || !LINEAGE_ID.test(candidate)) throw coded("invalid_lineage_id");
  return candidate;
}

function sha256(value) {
  return createHash("sha256").update(boundedText(value), "utf8").digest("hex");
}

function isDataDescriptor(descriptor) {
  return descriptor !== undefined
    && Object.hasOwn(descriptor, "value")
    && !Object.hasOwn(descriptor, "get")
    && !Object.hasOwn(descriptor, "set");
}

function stableJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(boundedText(value, "invalid_decision_basis"));
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw coded("invalid_decision_basis");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || types.isProxy(value) || ancestors.has(value)) {
    throw coded("invalid_decision_basis");
  }

  ancestors.add(value);
  try {
    const ownKeys = Reflect.ownKeys(value);
    const descriptors = new Map(ownKeys.map((key) => [key, Object.getOwnPropertyDescriptor(value, key)]));

    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw coded("invalid_decision_basis");
      const lengthDescriptor = descriptors.get("length");
      if (!isDataDescriptor(lengthDescriptor)
        || lengthDescriptor.enumerable
        || lengthDescriptor.configurable
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0) {
        throw coded("invalid_decision_basis");
      }
      const length = lengthDescriptor.value;
      if (length > MAX_COLLECTION_LENGTH) throw coded("value_too_large");
      if (ownKeys.length !== length + 1) throw coded("invalid_decision_basis");

      const elementDescriptors = [];
      const allowedKeys = new Set(["length"]);
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        const descriptor = descriptors.get(key);
        if (!isDataDescriptor(descriptor) || !descriptor.enumerable) throw coded("invalid_decision_basis");
        allowedKeys.add(key);
        elementDescriptors.push(descriptor);
      }
      for (const key of ownKeys) {
        if (typeof key !== "string" || !allowedKeys.has(key)) {
          throw coded("invalid_decision_basis");
        }
      }
      return `[${elementDescriptors.map((descriptor) => stableJson(descriptor.value, ancestors)).join(",")}]`;
    }

    if (Object.getPrototypeOf(value) !== Object.prototype) throw coded("invalid_decision_basis");
    if (ownKeys.length > MAX_COLLECTION_LENGTH) throw coded("value_too_large");
    const entries = ownKeys.map((key) => {
      if (typeof key !== "string") throw coded("invalid_decision_basis");
      const descriptor = descriptors.get(key);
      if (!isDataDescriptor(descriptor) || !descriptor.enumerable) throw coded("invalid_decision_basis");
      return [boundedKey(key), descriptor];
    }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, descriptor]) => `${JSON.stringify(key)}:${stableJson(descriptor.value, ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function framedDigest(values) {
  const framed = values.map((value) => {
    const text = boundedText(value);
    return `${Buffer.byteLength(text, "utf8")}:${text}`;
  }).join("|");
  return sha256(framed);
}

function normalizeAuthority(value) {
  return AUTHORITY_WHITELIST.has(value) ? value : "inferred_advisory";
}

function normalizeClauses(clauses) {
  if (clauses === undefined) return [];
  if (!Array.isArray(clauses) || clauses.length > MAX_COLLECTION_LENGTH) throw coded("invalid_clauses");
  return clauses.map((clause) => {
    const record = plainRecord(clause, "invalid_clause");
    const authority = normalizeAuthority(record.authority);
    return {
      id: boundedId(record.id),
      authority,
      hard: HARD_AUTHORITIES.has(authority)
    };
  });
}

function assertOwned(info, code) {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw coded(code);
}

async function ownedRealDirectory(directory) {
  const input = boundedText(directory, "invalid_repository_path");
  const initial = await lstat(input);
  if (initial.isSymbolicLink() || !initial.isDirectory()) throw coded("unsafe_repository_directory");
  assertOwned(initial, "repository_not_owned");
  if ((initial.mode & 0o022) !== 0) throw coded("unsafe_repository_mode");
  const resolved = await realpath(input);
  const resolvedInfo = await lstat(resolved);
  if (resolvedInfo.isSymbolicLink() || !resolvedInfo.isDirectory()) throw coded("unsafe_repository_directory");
  assertOwned(resolvedInfo, "repository_not_owned");
  if ((resolvedInfo.mode & 0o022) !== 0) throw coded("unsafe_repository_mode");
  return resolved;
}

async function readPrivateRegularFileIfPresent(file) {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw coded("unsafe_lineage_file");
    assertOwned(info, "lineage_not_owned");
    if ((info.mode & 0o777) !== 0o600) throw coded("unsafe_lineage_mode");
    return readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function execFileText(execFileImpl, file, args) {
  return new Promise((resolve, reject) => {
    let completed = false;
    const finish = (error, stdout) => {
      if (completed) return;
      completed = true;
      if (error) reject(error);
      else resolve(String(stdout));
    };
    try {
      const result = execFileImpl(file, args, { encoding: "utf8" }, finish);
      if (result && typeof result.then === "function") result.then((value) => finish(null, value?.stdout ?? value), finish);
    } catch (error) {
      finish(error);
    }
  });
}

async function resolveRepositoryLineageLocation({ repoRoot, execFileImpl = execFile } = {}) {
  if (!SUPPORTED_PLATFORMS.has(process.platform)) throw coded("unsupported_platform");
  const root = await ownedRealDirectory(repoRoot);
  let output;
  try {
    output = await execFileText(execFileImpl, "git", ["-C", root, "rev-parse", "--git-common-dir"]);
  } catch {
    throw coded("git_discovery_failed");
  }
  const commonDir = await ownedRealDirectory(path.resolve(root, boundedText(output.trim(), "invalid_git_common_dir")));
  return { commonDir, lineageFile: path.join(commonDir, "afl-lineage-id") };
}

export async function readRepositoryLineage({ repoRoot, execFileImpl = execFile } = {}) {
  const { commonDir, lineageFile } = await resolveRepositoryLineageLocation({ repoRoot, execFileImpl });
  const existing = await readPrivateRegularFileIfPresent(lineageFile);
  if (existing === null) throw coded("lineage_not_initialized");
  return { lineageId: validateLineage(existing), commonDir };
}

export async function ensureRepositoryLineage({
  repoRoot,
  execFileImpl = execFile,
  randomBytesImpl = randomBytes
} = {}) {
  const { commonDir, lineageFile } = await resolveRepositoryLineageLocation({ repoRoot, execFileImpl });
  const existing = await readPrivateRegularFileIfPresent(lineageFile);
  if (existing !== null) return { lineageId: validateLineage(existing), commonDir, created: false };

  const bytes = randomBytesImpl(32);
  const lineageId = validateLineage(bytes?.toString("hex"));
  let created = false;
  try {
    await writeFile(lineageFile, `${lineageId}\n`, { flag: "wx", mode: 0o600 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stored = await readPrivateRegularFileIfPresent(lineageFile);
  if (stored === null) throw coded("lineage_creation_failed");
  return { lineageId: validateLineage(stored), commonDir, created };
}

export function deriveTaskUid({ lineageId, adapterKind, nativeTaskId } = {}) {
  return framedDigest([validateLineage(lineageId), boundedId(adapterKind), boundedId(nativeTaskId)]);
}

export function digestDecisionBasis(input) {
  return sha256(stableJson(input));
}

export function projectContract(input) {
  const record = plainRecord(input, "invalid_contract");
  const requirements = normalizeClauses(record.requirements);
  const exclusions = normalizeClauses(record.exclusions);
  const importanceAuthority = normalizeAuthority(record.importanceAuthority);
  const requestedImportance = ["routine", "important", "critical"].includes(record.importance) ? record.importance : "routine";
  const importance = HARD_AUTHORITIES.has(importanceAuthority) ? requestedImportance : "routine";
  const canonical = {
    sourceKind: boundedId(record.sourceKind),
    sourceRefDigest: sha256(record.sourceRef),
    sourceRevision: boundedId(record.sourceRevision),
    requirements,
    exclusions,
    importance,
    importanceAuthority
  };
  return { ...canonical, revision: digestDecisionBasis(canonical) };
}
