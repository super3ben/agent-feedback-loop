import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { TextDecoder, types } from "node:util";

import { BREAKER_REASONS, GRANT_PURPOSES } from "./convergence-policy.mjs";
import { decryptAesGcmBuffer, encryptAesGcmBuffer } from "./crypto-store.mjs";

const MAX_CANONICAL_BYTES = 16 * 1_024;
const MAX_ENCRYPTED_BYTES = MAX_CANONICAL_BYTES + 32;
const MAX_COUNT = 10_000_000;
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_ORPHAN_INSPECTIONS = 32;
const DIGEST = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const CATEGORY_ID = /^[a-z][a-z0-9_-]{0,127}$/u;

const IMPORTANCE = new Set(["routine", "important", "critical"]);
const AUTHORITIES = new Set([
  "explicit_user", "approved_spec", "approved_plan", "verified_runtime",
  "review_finding", "inferred_advisory"
]);
const BREAKERS = new Set(BREAKER_REASONS);
const ACTIONS = new Set(GRANT_PURPOSES);
const TEST_STATUSES = new Set(["not_run", "passed", "failed", "partial"]);
const EVIDENCE_CLASSES = new Set(AUTHORITIES);
const SEVERITIES = new Set(["minor", "important", "critical"]);
const VERDICTS = new Set(["approved", "changes_required"]);

const ROOT_FIELDS = [
  "version", "identity", "contract", "trigger", "recentGenerations", "reviewEvidence"
];
const IDENTITY_FIELDS = ["taskUid", "fingerprint", "boundaryId", "canonicalInvariantId"];
const CONTRACT_FIELDS = [
  "goalSummary", "acceptanceCriteria", "exclusions", "importance",
  "importanceAuthority", "contractRevision"
];
const TRIGGER_FIELDS = [
  "decision", "breakerReason", "failureCount", "currentGeneration", "decisionBasisDigest"
];
const GENERATION_FIELDS = [
  "generation", "action", "changedFileCount", "additions", "deletions", "pathCategories",
  "testStatus", "evidenceClass", "evidenceDigest"
];
const REVIEW_FIELDS = ["severity", "verdict", "hypothesis", "newEvidence", "falsificationTest"];

const BUILD_FIELDS = ["hostProjection", "controllerFacts"];
const HOST_FIELDS = [
  "producer", "goalSummary", "acceptanceCriteria", "exclusions", "importance",
  "importanceAuthority", "contractRevision", "generationObservations", "reviewEvidence"
];
const CONTROLLER_FIELDS = [
  "taskUid", "fingerprint", "boundaryId", "canonicalInvariantId", "importance",
  "importanceAuthority", "contractRevision", "decision", "breakerReason", "failureCount",
  "currentGeneration", "decisionBasisDigest", "latestEvidenceDigest", "recentGenerations"
];
const OBSERVATION_FIELDS = [
  "generation", "changedFileCount", "additions", "deletions", "pathCategories", "testStatus"
];
const GENERATION_BINDING_FIELDS = ["generation", "action", "evidenceClass", "evidenceDigest"];
const REVIEW_INPUT_FIELDS = [
  "severity", "verdict", "hypothesis", "newEvidence", "falsificationTest",
  "evidenceDigest", "decisionBasisDigest"
];

const FORBIDDEN_CONTENT = Object.freeze([
  /\bauthorization\s*:\s*bearer\s+\S+/iu,
  /\b(?:password|passwd|passcode|api[_ -]?key|secret|token)\s*[=:]\s*\S+/iu,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{12,})\b/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\bAFL_REVIEW_[A-Z0-9_]*\s*=\s*\S+/iu,
  /\[AFL\]|(?:<!--|&lt;!--)\s*afl-receipt\b|<hook_prompt\b|\bhookPrompt\b|Output this receipt verbatim before stopping/iu
]);

function invalid() {
  throw new TypeError("convergence probe evidence is invalid");
}

function recordValues(input, fields) {
  if (input === null || typeof input !== "object" || Array.isArray(input)
      || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) invalid();
  const allowed = new Set(fields);
  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.length !== fields.length) invalid();
  const result = {};
  for (const key of ownKeys) {
    if (typeof key !== "string" || !allowed.has(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalid();
    result[key] = descriptor.value;
  }
  for (const field of fields) if (!Object.hasOwn(result, field)) invalid();
  return result;
}

function arrayValues(input, maximum, minimum = 0) {
  if (!Array.isArray(input) || types.isProxy(input)
      || Object.getPrototypeOf(input) !== Array.prototype
      || input.length < minimum || input.length > maximum) invalid();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== input.length + 1 || !keys.includes("length")) invalid();
  const result = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalid();
    result.push(descriptor.value);
  }
  return result;
}

function validUnicode(value) {
  return typeof value === "string"
    && (typeof value.isWellFormed !== "function" || value.isWellFormed())
    && !value.includes("\0");
}

function scannedText(value, maximum) {
  if (!validUnicode(value) || value !== value.trim()) invalid();
  const length = Array.from(value).length;
  if (length < 1 || length > maximum || FORBIDDEN_CONTENT.some((pattern) => pattern.test(value))) invalid();
  return value;
}

function identifier(value) {
  if (!validUnicode(value) || !ID.test(value) || FORBIDDEN_CONTENT.some((pattern) => pattern.test(value))) invalid();
  return value;
}

function categoryId(value) {
  if (!validUnicode(value) || !CATEGORY_ID.test(value)) invalid();
  return value;
}

function digest(value) {
  if (typeof value !== "string" || !DIGEST.test(value)) invalid();
  return value;
}

function enumValue(value, allowed) {
  if (typeof value !== "string" || !allowed.has(value)) invalid();
  return value;
}

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_COUNT) invalid();
  return value;
}

function textArray(value, { minimum, maximum, itemMaximum }) {
  return Object.freeze(arrayValues(value, maximum, minimum).map((item) => scannedText(item, itemMaximum)));
}

function categories(value) {
  const result = arrayValues(value, 8).map(categoryId);
  if (new Set(result).size !== result.length) invalid();
  return Object.freeze(result);
}

function validateIdentity(input) {
  const value = recordValues(input, IDENTITY_FIELDS);
  return Object.freeze({
    taskUid: identifier(value.taskUid),
    fingerprint: identifier(value.fingerprint),
    boundaryId: identifier(value.boundaryId),
    canonicalInvariantId: identifier(value.canonicalInvariantId)
  });
}

function validateContract(input) {
  const value = recordValues(input, CONTRACT_FIELDS);
  return Object.freeze({
    goalSummary: scannedText(value.goalSummary, 512),
    acceptanceCriteria: textArray(value.acceptanceCriteria, { minimum: 1, maximum: 8, itemMaximum: 256 }),
    exclusions: textArray(value.exclusions, { minimum: 0, maximum: 8, itemMaximum: 256 }),
    importance: enumValue(value.importance, IMPORTANCE),
    importanceAuthority: enumValue(value.importanceAuthority, AUTHORITIES),
    contractRevision: digest(value.contractRevision)
  });
}

function validateTrigger(input) {
  const value = recordValues(input, TRIGGER_FIELDS);
  if (value.decision !== "reflection_required") invalid();
  return Object.freeze({
    decision: value.decision,
    breakerReason: enumValue(value.breakerReason, BREAKERS),
    failureCount: count(value.failureCount),
    currentGeneration: count(value.currentGeneration),
    decisionBasisDigest: digest(value.decisionBasisDigest)
  });
}

function validateGeneration(input, currentGeneration) {
  const value = recordValues(input, GENERATION_FIELDS);
  const generation = count(value.generation);
  if (generation > currentGeneration) invalid();
  return Object.freeze({
    generation,
    action: enumValue(value.action, ACTIONS),
    changedFileCount: count(value.changedFileCount),
    additions: count(value.additions),
    deletions: count(value.deletions),
    pathCategories: categories(value.pathCategories),
    testStatus: enumValue(value.testStatus, TEST_STATUSES),
    evidenceClass: enumValue(value.evidenceClass, EVIDENCE_CLASSES),
    evidenceDigest: digest(value.evidenceDigest)
  });
}

function validateGenerations(input, currentGeneration) {
  const result = arrayValues(input, 2).map((item) => validateGeneration(item, currentGeneration));
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1].generation >= result[index].generation) invalid();
  }
  return Object.freeze(result);
}

function validateReview(input) {
  const value = recordValues(input, REVIEW_FIELDS);
  return Object.freeze({
    severity: enumValue(value.severity, SEVERITIES),
    verdict: enumValue(value.verdict, VERDICTS),
    hypothesis: scannedText(value.hypothesis, 1_024),
    newEvidence: scannedText(value.newEvidence, 1_024),
    falsificationTest: scannedText(value.falsificationTest, 1_024)
  });
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function enforceCanonicalSize(value) {
  if (Buffer.byteLength(canonicalJson(value), "utf8") > MAX_CANONICAL_BYTES) invalid();
}

export function validateConvergenceProbeEvidence(input) {
  const value = recordValues(input, ROOT_FIELDS);
  if (value.version !== 1) invalid();
  const trigger = validateTrigger(value.trigger);
  const result = Object.freeze({
    version: 1,
    identity: validateIdentity(value.identity),
    contract: validateContract(value.contract),
    trigger,
    recentGenerations: validateGenerations(value.recentGenerations, trigger.currentGeneration),
    reviewEvidence: validateReview(value.reviewEvidence)
  });
  enforceCanonicalSize(result);
  return result;
}

export function canonicalProbeEvidence(input) {
  return canonicalJson(validateConvergenceProbeEvidence(input));
}

function validateObservation(input) {
  const value = recordValues(input, OBSERVATION_FIELDS);
  return Object.freeze({
    generation: count(value.generation),
    changedFileCount: count(value.changedFileCount),
    additions: count(value.additions),
    deletions: count(value.deletions),
    pathCategories: categories(value.pathCategories),
    testStatus: enumValue(value.testStatus, TEST_STATUSES)
  });
}

function validateGenerationBinding(input) {
  const value = recordValues(input, GENERATION_BINDING_FIELDS);
  return Object.freeze({
    generation: count(value.generation),
    action: enumValue(value.action, ACTIONS),
    evidenceClass: enumValue(value.evidenceClass, EVIDENCE_CLASSES),
    evidenceDigest: digest(value.evidenceDigest)
  });
}

function validateReviewInput(input) {
  const value = recordValues(input, REVIEW_INPUT_FIELDS);
  return Object.freeze({
    severity: enumValue(value.severity, SEVERITIES),
    verdict: enumValue(value.verdict, VERDICTS),
    hypothesis: scannedText(value.hypothesis, 1_024),
    newEvidence: scannedText(value.newEvidence, 1_024),
    falsificationTest: scannedText(value.falsificationTest, 1_024),
    evidenceDigest: digest(value.evidenceDigest),
    decisionBasisDigest: digest(value.decisionBasisDigest)
  });
}

function validateHostProjection(input) {
  const value = recordValues(input, HOST_FIELDS);
  return Object.freeze({
    producer: identifier(value.producer),
    goalSummary: scannedText(value.goalSummary, 512),
    acceptanceCriteria: textArray(value.acceptanceCriteria, { minimum: 1, maximum: 8, itemMaximum: 256 }),
    exclusions: textArray(value.exclusions, { minimum: 0, maximum: 8, itemMaximum: 256 }),
    importance: enumValue(value.importance, IMPORTANCE),
    importanceAuthority: enumValue(value.importanceAuthority, AUTHORITIES),
    contractRevision: digest(value.contractRevision),
    generationObservations: Object.freeze(arrayValues(value.generationObservations, 2).map(validateObservation)),
    reviewEvidence: validateReviewInput(value.reviewEvidence)
  });
}

function validateControllerFacts(input) {
  const value = recordValues(input, CONTROLLER_FIELDS);
  const currentGeneration = count(value.currentGeneration);
  return Object.freeze({
    taskUid: identifier(value.taskUid),
    fingerprint: identifier(value.fingerprint),
    boundaryId: identifier(value.boundaryId),
    canonicalInvariantId: identifier(value.canonicalInvariantId),
    importance: enumValue(value.importance, IMPORTANCE),
    importanceAuthority: enumValue(value.importanceAuthority, AUTHORITIES),
    contractRevision: digest(value.contractRevision),
    decision: value.decision === "reflection_required" ? value.decision : invalid(),
    breakerReason: enumValue(value.breakerReason, BREAKERS),
    failureCount: count(value.failureCount),
    currentGeneration,
    decisionBasisDigest: digest(value.decisionBasisDigest),
    latestEvidenceDigest: digest(value.latestEvidenceDigest),
    recentGenerations: Object.freeze(arrayValues(value.recentGenerations, 2).map(validateGenerationBinding))
  });
}

function sameBindings(host, facts) {
  return host.importance === facts.importance
    && host.importanceAuthority === facts.importanceAuthority
    && host.contractRevision === facts.contractRevision
    && host.reviewEvidence.evidenceDigest === facts.latestEvidenceDigest
    && host.reviewEvidence.decisionBasisDigest === facts.decisionBasisDigest
    && host.generationObservations.length === facts.recentGenerations.length
    && host.generationObservations.every((item, index) => (
      item.generation === facts.recentGenerations[index].generation
      && item.generation <= facts.currentGeneration
    ));
}

export function buildConvergenceProbeEvidence(input) {
  const value = recordValues(input, BUILD_FIELDS);
  const host = validateHostProjection(value.hostProjection);
  const facts = validateControllerFacts(value.controllerFacts);
  if (!sameBindings(host, facts)) invalid();

  return validateConvergenceProbeEvidence({
    version: 1,
    identity: {
      taskUid: facts.taskUid,
      fingerprint: facts.fingerprint,
      boundaryId: facts.boundaryId,
      canonicalInvariantId: facts.canonicalInvariantId
    },
    contract: {
      goalSummary: host.goalSummary,
      acceptanceCriteria: host.acceptanceCriteria,
      exclusions: host.exclusions,
      importance: facts.importance,
      importanceAuthority: facts.importanceAuthority,
      contractRevision: facts.contractRevision
    },
    trigger: {
      decision: facts.decision,
      breakerReason: facts.breakerReason,
      failureCount: facts.failureCount,
      currentGeneration: facts.currentGeneration,
      decisionBasisDigest: facts.decisionBasisDigest
    },
    recentGenerations: host.generationObservations.map((observation, index) => ({
      ...observation,
      action: facts.recentGenerations[index].action,
      evidenceClass: facts.recentGenerations[index].evidenceClass,
      evidenceDigest: facts.recentGenerations[index].evidenceDigest
    })),
    reviewEvidence: {
      severity: host.reviewEvidence.severity,
      verdict: host.reviewEvidence.verdict,
      hypothesis: host.reviewEvidence.hypothesis,
      newEvidence: host.reviewEvidence.newEvidence,
      falsificationTest: host.reviewEvidence.falsificationTest
    }
  });
}

function contextError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function artifactDigest(value) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw contextError("probe_context_digest_invalid");
  }
  return value;
}

function modeOf(info) {
  return Number(info.mode & 0o777n);
}

function ownedByCurrentUser(info) {
  return typeof process.getuid !== "function" || info.uid === BigInt(process.getuid());
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left, right) {
  return sameInode(left, right)
    && left.mode === right.mode
    && left.uid === right.uid
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertPrivateRootInfo(info) {
  if (info.isSymbolicLink() || !info.isDirectory() || !ownedByCurrentUser(info) || modeOf(info) !== 0o700) {
    throw contextError("probe_context_root_invalid");
  }
}

function assertPrivateArtifactInfo(info, { allowEmpty = false } = {}) {
  if (info.isSymbolicLink() || !info.isFile() || !ownedByCurrentUser(info)
      || modeOf(info) !== 0o600 || info.nlink !== 1n
      || (!allowEmpty && info.size < 33n) || info.size > BigInt(MAX_ENCRYPTED_BYTES)) {
    throw contextError("probe_context_artifact_invalid");
  }
}

function sameSafeArtifact(left, right) {
  return sameInode(left, right)
    && left.mode === right.mode
    && left.uid === right.uid
    && left.size === right.size
    && left.nlink === right.nlink;
}

async function privateRootInfo(root, { create = false, missing = false } = {}) {
  try {
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root, { bigint: true });
    assertPrivateRootInfo(info);
    return info;
  } catch (error) {
    if (missing && error?.code === "ENOENT") return null;
    if (error?.code === "probe_context_root_invalid") throw error;
    throw contextError("probe_context_root_invalid");
  }
}

async function assertStableRoot(root, expected) {
  const current = await privateRootInfo(root);
  if (!sameInode(expected, current)) throw contextError("probe_context_root_invalid");
}

async function privateArtifactInfo(file, { missing = false } = {}) {
  try {
    const info = await lstat(file, { bigint: true });
    assertPrivateArtifactInfo(info);
    return info;
  } catch (error) {
    if (missing && error?.code === "ENOENT") return null;
    if (error?.code === "probe_context_artifact_invalid") throw error;
    throw contextError("probe_context_artifact_invalid");
  }
}

async function readStableArtifact(root, file) {
  const rootInfo = await privateRootInfo(root);
  const before = await privateArtifactInfo(file);
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    assertPrivateArtifactInfo(opened);
    if (!sameSnapshot(before, opened)) throw contextError("probe_context_artifact_invalid");
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const linked = await privateArtifactInfo(file);
    if (!sameSnapshot(opened, after) || !sameSnapshot(after, linked)) {
      throw contextError("probe_context_artifact_invalid");
    }
    await assertStableRoot(root, rootInfo);
    return content;
  } catch (error) {
    if (error?.code === "probe_context_artifact_invalid"
        || error?.code === "probe_context_root_invalid") throw error;
    throw contextError("probe_context_artifact_invalid");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function liveDigestSet(value) {
  if (!(value instanceof Set) || types.isProxy(value)
      || Object.getPrototypeOf(value) !== Set.prototype || Reflect.ownKeys(value).length !== 0) {
    throw contextError("probe_context_live_digests_invalid");
  }
  const result = new Set();
  for (const item of value) result.add(artifactDigest(item));
  return result;
}

export class ConvergenceProbeContextStore {
  constructor({ root, keyProvider }) {
    if (typeof root !== "string" || !path.isAbsolute(root)
        || keyProvider === null || typeof keyProvider?.getKey !== "function") {
      throw new TypeError("probe context store configuration is invalid");
    }
    this.root = path.resolve(root);
    this.keyProvider = keyProvider;
  }

  artifactFile(digestValue) {
    return path.join(this.root, `${artifactDigest(digestValue)}.enc`);
  }

  async key() {
    try {
      return await this.keyProvider.getKey();
    } catch {
      throw contextError("probe_context_artifact_invalid");
    }
  }

  async put(evidence) {
    const canonical = Buffer.from(canonicalProbeEvidence(evidence), "utf8");
    const digestValue = sha256(canonical);
    const file = this.artifactFile(digestValue);
    const rootInfo = await privateRootInfo(this.root, { create: true });
    if (await privateArtifactInfo(file, { missing: true })) {
      await this.read(digestValue);
      return Object.freeze({ digest: digestValue, created: false });
    }

    const encrypted = encryptAesGcmBuffer(await this.key(), canonical);
    const temporary = path.join(
      this.root,
      `.${digestValue}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`
    );
    let handle;
    let created = false;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      const createdInfo = await handle.stat({ bigint: true });
      assertPrivateArtifactInfo(createdInfo, { allowEmpty: true });
      await handle.writeFile(encrypted);
      await handle.sync();
      const written = await handle.stat({ bigint: true });
      assertPrivateArtifactInfo(written);
      await assertStableRoot(this.root, rootInfo);
      try {
        await link(temporary, file);
        created = true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    } catch (error) {
      if (error?.code?.startsWith?.("probe_context_")) throw error;
      throw contextError("probe_context_artifact_invalid");
    } finally {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }

    await this.read(digestValue);
    return Object.freeze({ digest: digestValue, created });
  }

  async read(digestValue) {
    const expectedDigest = artifactDigest(digestValue);
    const encrypted = await readStableArtifact(this.root, this.artifactFile(expectedDigest));
    let plaintext;
    try {
      plaintext = decryptAesGcmBuffer(await this.key(), encrypted);
      if (sha256(plaintext) !== expectedDigest) throw contextError("probe_context_artifact_invalid");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      const evidence = validateConvergenceProbeEvidence(JSON.parse(text));
      if (!Buffer.from(canonicalProbeEvidence(evidence), "utf8").equals(plaintext)) {
        throw contextError("probe_context_artifact_invalid");
      }
      return evidence;
    } catch (error) {
      if (error?.code === "probe_context_artifact_invalid") throw error;
      throw contextError("probe_context_artifact_invalid");
    }
  }

  async remove(digestValue) {
    const expectedDigest = artifactDigest(digestValue);
    const rootInfo = await privateRootInfo(this.root, { missing: true });
    if (rootInfo === null) return false;
    const file = this.artifactFile(expectedDigest);
    const before = await privateArtifactInfo(file, { missing: true });
    if (before === null) return false;
    await this.read(expectedDigest);

    const quarantine = path.join(this.root, `.${expectedDigest}.${randomBytes(12).toString("hex")}.remove`);
    try {
      await rename(file, quarantine);
      const moved = await privateArtifactInfo(quarantine);
      if (!sameSafeArtifact(before, moved)) throw contextError("probe_context_artifact_invalid");
      await assertStableRoot(this.root, rootInfo);
      await rm(quarantine);
      return true;
    } catch (error) {
      if (error?.code?.startsWith?.("probe_context_")) throw error;
      throw contextError("probe_context_artifact_invalid");
    }
  }

  async pruneOrphans(liveDigests) {
    const live = liveDigestSet(liveDigests);
    const rootInfo = await privateRootInfo(this.root, { missing: true });
    if (rootInfo === null) return Object.freeze({ inspected: 0, removed: Object.freeze([]) });
    let names;
    try {
      names = (await readdir(this.root)).sort().slice(0, MAX_ORPHAN_INSPECTIONS);
    } catch {
      throw contextError("probe_context_root_invalid");
    }

    const removed = [];
    const cutoff = Date.now() - ORPHAN_AGE_MS;
    for (const name of names) {
      const match = /^([a-f0-9]{64})\.enc$/u.exec(name);
      if (!match || live.has(match[1])) continue;
      const info = await privateArtifactInfo(path.join(this.root, name));
      if (Number(info.mtimeMs) >= cutoff) continue;
      await this.read(match[1]);
      if (await this.remove(match[1])) removed.push(match[1]);
    }
    await assertStableRoot(this.root, rootInfo);
    return Object.freeze({ inspected: names.length, removed: Object.freeze(removed) });
  }
}
