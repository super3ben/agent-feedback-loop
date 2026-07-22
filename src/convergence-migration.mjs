import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod, lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink, writeFile
} from "node:fs/promises";
import path from "node:path";

import {
  deriveTaskUid,
  digestDecisionBasis,
  projectContract,
  readRepositoryLineage
} from "./convergence-identity.mjs";
import { openControlStoreReadOnly } from "./control-store.mjs";
import {
  canonicalGuardParityValue,
  guardParitySetDigest
} from "./convergence-store.mjs";

const PLAN_PRIVATE = new WeakMap();
const MAPPING_REVISION = "guard-v1-repository-v1";
const POLICY_REVISION_DIGEST = sha256("convergence-policy-v2");
const AUTHORITY_NATIVE_ID = "guard-authority";
const MAX_STATE_BYTES = 1024 * 1024;
const LEGACY_KEYS = new Set([
  "version", "repository_id", "updated_at", "aliases", "distinct_declarations", "loops"
]);
const LOOP_KEYS = new Set([
  "task_id", "canonical_invariant_id", "boundary", "status", "failure_count",
  "seen_review_run_ids", "local_fix_generations", "architecture_fix_count", "checkpoint",
  "active_receipt", "direction_signal", "last_evidence_sha256", "events"
]);
const LEGACY_STATUSES = new Set([
  "open", "closed", "blocked_direction_review", "blocked_architecture_review",
  "architecture_fix_ready", "architecture_fix_in_progress", "blocked_human_decision"
]);
const PARITY_FIELDS = Object.freeze([
  "authorization_eligibility", "decision", "failure_generation", "next_required_action"
]);

function coded(code) {
  return Object.assign(new Error(code), { code });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function plain(value, code, allowed) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw coded(code);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw coded(code);
  return value;
}

function boundedText(value, code, maximum = 256) {
  if (typeof value !== "string" || value.includes("\0") || value.length < 1 || value.length > maximum) {
    throw coded(code);
  }
  return value;
}

function normalizedId(value, code = "legacy_state_invalid") {
  const normalized = boundedText(value, code).normalize("NFKC").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,255}$/u.test(normalized)) throw coded(code);
  return normalized;
}

function exactDigest(value, code = "legacy_state_invalid") {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw coded(code);
  return value;
}

function timestamp(value, code = "legacy_state_invalid") {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw coded(code);
  return new Date(value).toISOString();
}

function own(info, code) {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw coded(code);
}

async function secureRepoRoot(repoRoot) {
  if (typeof repoRoot !== "string" || repoRoot.includes("\0")) throw coded("repo_root_invalid");
  const input = path.resolve(repoRoot);
  const info = await lstat(input).catch(() => { throw coded("repo_root_invalid"); });
  if (!info.isDirectory() || info.isSymbolicLink()) throw coded("repo_root_unsafe");
  own(info, "repo_root_untrusted_owner");
  return realpath(input);
}

async function assertSafePath(root, target, includeLeaf = true) {
  const relative = path.relative(root, target);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) throw coded("legacy_state_outside_repo");
  const parts = relative.split(path.sep);
  let current = root;
  const limit = includeLeaf ? parts.length : parts.length - 1;
  for (let index = 0; index < limit; index += 1) {
    current = path.join(current, parts[index]);
    const info = await lstat(current).catch(() => { throw coded("legacy_state_missing"); });
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) {
      throw coded("legacy_state_unsafe");
    }
    own(info, "legacy_state_untrusted_owner");
  }
}

function resolvedStateTarget(rootInput, root, stateFile) {
  const requested = path.resolve(rootInput, stateFile);
  return requested !== rootInput && requested.startsWith(`${rootInput}${path.sep}`)
    ? path.join(root, path.relative(rootInput, requested))
    : requested;
}

async function readOwnedGuardState({ repoRoot, stateFile, expectedSha256 = null, mode = "source" }) {
  const rootInput = path.resolve(repoRoot);
  const root = await secureRepoRoot(repoRoot);
  const target = resolvedStateTarget(rootInput, root, stateFile);
  await assertSafePath(root, target);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes(error?.code)) throw coded("legacy_state_unsafe");
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.isSymbolicLink()) throw coded("legacy_state_unsafe");
    own(info, "legacy_state_untrusted_owner");
    const permissions = info.mode & 0o777;
    const allowedModes = mode === "snapshot" ? new Set([0o400]) : new Set([0o400, 0o600]);
    if (!allowedModes.has(permissions)) throw coded(`${mode}_unsafe_mode`);
    if (info.size < 2 || info.size > MAX_STATE_BYTES) throw coded(`${mode}_size_invalid`);
    const bytes = await handle.readFile();
    const current = await lstat(target).catch(() => { throw coded(`${mode}_replaced`); });
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino) {
      throw coded(`${mode}_replaced`);
    }
    const sourceSha256 = sha256(bytes);
    if (expectedSha256 !== null && sourceSha256 !== expectedSha256) throw coded(`${mode}_digest_changed`);
    return Object.freeze({
      root, target, bytes, sourceSha256, dev: info.dev, ino: info.ino,
      uid: info.uid, permissions, type: "regular"
    });
  } finally {
    await handle.close();
  }
}

function legacyFingerprint(taskId, invariantId, boundary) {
  return sha256(Buffer.from(JSON.stringify([taskId, invariantId, boundary]), "utf8"));
}

function validateLegacyState(value, repositoryId) {
  const state = plain(value, "legacy_state_invalid", LEGACY_KEYS);
  if (state.version !== 1 || state.repository_id !== repositoryId
      || typeof state.aliases !== "object" || state.aliases === null || Array.isArray(state.aliases)
      || !Array.isArray(state.distinct_declarations)
      || typeof state.loops !== "object" || state.loops === null || Array.isArray(state.loops)) {
    throw coded("legacy_state_invalid");
  }
  timestamp(state.updated_at);
  if (Object.keys(state.loops).length > 128 || Object.keys(state.aliases).length > 128
      || state.distinct_declarations.length > 128) throw coded("legacy_state_too_large");
  const aliases = Object.entries(state.aliases).map(([alias, canonical]) => [
    normalizedId(alias), normalizedId(canonical)
  ]);
  const distinct = state.distinct_declarations.map((raw) => {
    const item = plain(raw, "legacy_state_invalid", new Set([
      "task_id", "boundary", "invariant_id", "reason", "declared_at"
    ]));
    return Object.freeze({
      taskId: normalizedId(item.task_id), boundary: normalizedId(item.boundary),
      invariantId: normalizedId(item.invariant_id), reason: boundedText(item.reason, "legacy_state_invalid", 4096),
      declaredAt: timestamp(item.declared_at)
    });
  });
  const loops = Object.entries(state.loops).map(([fingerprint, raw]) => {
    exactDigest(fingerprint);
    const loop = plain(raw, "legacy_state_invalid", LOOP_KEYS);
    const taskId = normalizedId(loop.task_id);
    const invariantId = normalizedId(loop.canonical_invariant_id);
    const boundary = normalizedId(loop.boundary);
    if (legacyFingerprint(taskId, invariantId, boundary) !== fingerprint
        || !LEGACY_STATUSES.has(loop.status)
        || !Number.isSafeInteger(loop.failure_count) || loop.failure_count < 0 || loop.failure_count > 3
        || !Array.isArray(loop.seen_review_run_ids) || !Array.isArray(loop.local_fix_generations)
        || !Number.isSafeInteger(loop.architecture_fix_count)
        || loop.architecture_fix_count < 0 || loop.architecture_fix_count > 1
        || !Array.isArray(loop.events) || loop.events.length > 512) throw coded("legacy_state_invalid");
    for (const run of loop.seen_review_run_ids) boundedText(run, "legacy_state_invalid");
    for (const generation of loop.local_fix_generations) {
      if (!Number.isSafeInteger(generation) || generation < 1 || generation > 3) throw coded("legacy_state_invalid");
    }
    if (loop.last_evidence_sha256 !== null) exactDigest(loop.last_evidence_sha256);
    if (!new Set(["none", "structural_blocked", "no_local_seam"]).has(loop.direction_signal)) {
      throw coded("legacy_state_invalid");
    }
    if (loop.checkpoint !== null) {
      const checkpoint = plain(loop.checkpoint, "legacy_state_invalid", new Set([
        "path", "sha256", "recorded_at", "kind"
      ]));
      boundedText(checkpoint.path, "legacy_state_invalid", 4096);
      exactDigest(checkpoint.sha256);
      timestamp(checkpoint.recorded_at);
      if (!new Set(["direction", "legacy_architecture"]).has(checkpoint.kind)) throw coded("legacy_state_invalid");
    }
    if (loop.active_receipt !== null) {
      const receipt = loop.active_receipt;
      if (typeof receipt !== "object" || Array.isArray(receipt)) throw coded("legacy_state_invalid");
      exactDigest(receipt.receipt_id);
      if (!new Set(["local_fix", "architecture_fix"]).has(receipt.mode)) throw coded("legacy_state_invalid");
      timestamp(receipt.issued_at);
      if (receipt.consumed_at !== null) timestamp(receipt.consumed_at);
    }
    return Object.freeze({ fingerprint, taskId, invariantId, boundary, ...loop });
  });
  return Object.freeze({ aliases, distinct, loops });
}

async function inspectCanonicalLegacyState(root) {
  const stateFile = path.join(root, ".superpowers", "sdd", "review-loop-state.json");
  let source;
  try {
    source = await readOwnedGuardState({ repoRoot: root, stateFile });
  } catch (error) {
    if (new Set(["legacy_state_missing", "ENOENT"]).has(error?.code)) return "absent";
    throw error;
  }
  let json;
  try { json = JSON.parse(source.bytes.toString("utf8")); } catch { throw coded("legacy_state_invalid"); }
  validateLegacyState(json, sha256(source.root));
  return "valid";
}

async function inspectTransitionLock(root) {
  const lock = transitionPaths(
    path.join(root, ".superpowers", "sdd", "review-loop-state.json")
  ).authorityLock;
  try {
    const info = await lstat(lock);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw coded("guard_authority_lock_invalid");
    }
    own(info, "guard_authority_lock_invalid");
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function repositoryProjection({
  repositoryState,
  lineageId,
  legacyState,
  storeState,
  imported = false,
  cutOver = false
}) {
  return Object.freeze({
    repositoryState, lineageId, legacyState, storeState,
    imported: Boolean(imported), cutOver: Boolean(cutOver)
  });
}

export async function inspectGuardRepository({ repoRoot, paths, logger = () => {} } = {}) {
  if (typeof logger !== "function") throw coded("guard_preflight_invalid_arguments");
  let lineage;
  try {
    lineage = await readRepositoryLineage({ repoRoot });
  } catch (error) {
    if (error?.code !== "lineage_not_initialized") throw error;
    const result = repositoryProjection({
      repositoryState: "uninitialized", lineageId: null,
      legacyState: "absent", storeState: "absent"
    });
    logger(Object.freeze({
      action: "repository_preflight", effectiveState: result.repositoryState,
      reasonCode: "lineage_not_initialized"
    }));
    return result;
  }

  const root = await secureRepoRoot(repoRoot);
  const transitionLocked = await inspectTransitionLock(root);
  const legacyState = await inspectCanonicalLegacyState(root);
  let storeState = "absent";
  let authority = null;
  try {
    await lstat(paths?.controlDatabase);
    const store = openControlStoreReadOnly({ paths });
    try {
      authority = store.getGuardAuthority({
        authorityTaskUid: guardAuthorityTaskUid(lineage.lineageId)
      });
      storeState = "valid";
    } finally {
      store.close();
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw coded("control_store_invalid");
  }

  const imported = Boolean(authority?.imported);
  const cutOver = authority?.authority === "afl_sqlite" && imported;
  let repositoryState;
  if (transitionLocked) repositoryState = "transition_locked";
  else if (legacyState === "valid") repositoryState = cutOver ? "afl_sqlite" : "legacy_guard";
  else repositoryState = storeState === "valid" ? "afl_sqlite" : "fresh_afl_eligible";
  const result = repositoryProjection({
    repositoryState, lineageId: lineage.lineageId, legacyState, storeState, imported, cutOver
  });
  logger(Object.freeze({
    action: "repository_preflight", effectiveState: result.repositoryState,
    reasonCode: transitionLocked ? "transition_lock_present"
      : legacyState === "valid" && !cutOver ? "legacy_authoritative"
        : storeState === "valid" ? "store_valid" : "store_absent"
  }));
  return result;
}

function taskProjection({ lineageId, taskId, authority = false }) {
  const nativeTaskId = authority ? AUTHORITY_NATIVE_ID : taskId;
  const sourceRef = authority ? "guard-v1-authority" : `sdd-task:${taskId}`;
  const contract = projectContract({
    sourceKind: "approved_plan", sourceRef, sourceRevision: "sdd-task-v1",
    requirements: [], exclusions: [], importance: "routine", importanceAuthority: "approved_plan"
  });
  return Object.freeze({
    taskUid: deriveTaskUid({ lineageId, adapterKind: "sdd", nativeTaskId }),
    lineageDigest: sha256(lineageId), adapterKind: "sdd", adapterCapability: "workflow_gate",
    nativeTaskDigest: sha256(nativeTaskId), contractSourceKind: contract.sourceKind,
    contractSourceRefDigest: contract.sourceRefDigest, contractRevision: contract.revision,
    policyRevision: POLICY_REVISION_DIGEST, importance: contract.importance,
    importanceAuthority: contract.importanceAuthority
  });
}

export function guardAuthorityTaskUid(lineageId) {
  return deriveTaskUid({ lineageId, adapterKind: "sdd", nativeTaskId: AUTHORITY_NATIVE_ID });
}

function mapStatus(loop) {
  return {
    open: ["generation_closed", "pass"], closed: ["terminal", "finish"],
    blocked_direction_review: ["checkpoint_required", "checkpoint_required"],
    blocked_architecture_review: ["checkpoint_required", "checkpoint_required"],
    architecture_fix_ready: ["direction_approved", "checkpoint_required"],
    architecture_fix_in_progress: ["active_generation", "pass"],
    blocked_human_decision: ["human_decision", "human_decision"]
  }[loop.status];
}

function eventUid(sourceSha256, fingerprint, index, action) {
  return `legacy:${sourceSha256.slice(0, 12)}:${fingerprint.slice(0, 16)}:${index}:${action}`;
}

function liveReviewRunId(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replaceAll(/[^a-z0-9._:-]+/gu, "-");
  if (!/^[a-z0-9][a-z0-9._:-]{0,255}$/u.test(normalized)) throw coded("legacy_state_invalid");
  return normalized;
}

function auditText(value, required = true) {
  if ((value === null || value === undefined) && !required) return null;
  const normalized = boundedText(value, "legacy_state_invalid", 4096).trim();
  if (normalized.length === 0) throw coded("legacy_state_invalid");
  return normalized;
}

function liveReviewMapping({ task, loop, raw, finalGeneration, historicalFailureCount }) {
  const reviewRunId = liveReviewRunId(raw.review_run_id);
  const severity = String(raw.severity ?? "").toLowerCase();
  const verdict = String(raw.verdict ?? "").toLowerCase();
  const countedFailure = verdict === "changes_required" && severity !== "minor";
  if (!new Set(["minor", "important", "critical"]).has(severity)
      || !new Set(["approved", "changes_required"]).has(verdict)) throw coded("legacy_state_invalid");
  const directionSignal = String(raw.direction_signal ?? "none").toLowerCase();
  if (!new Set(["none", "structural_blocked", "no_local_seam"]).has(directionSignal)) {
    throw coded("legacy_state_invalid");
  }
  const hypothesis = auditText(raw.hypothesis, countedFailure);
  const newEvidence = auditText(raw.new_evidence, countedFailure);
  const falsificationTest = auditText(raw.falsification_test, countedFailure);
  const failureNextAction = raw.failure_next_action === null || raw.failure_next_action === undefined
    ? null : auditText(raw.failure_next_action).toLowerCase();
  if (countedFailure && !new Set(["direction_review", "stop"]).has(failureNextAction)) {
    throw coded("legacy_state_invalid");
  }
  const auditEnvelope = Object.freeze({
    reviewRunId,
    taskId: loop.taskId,
    invariantId: loop.invariantId,
    boundary: loop.boundary,
    severity,
    verdict,
    commit: auditText(raw.commit),
    reviewRef: auditText(raw.review_ref),
    hypothesis,
    newEvidence,
    falsificationTest,
    failureNextAction,
    directionSignal
  });
  const evidenceDigest = countedFailure
    ? sha256(newEvidence)
    : sha256(`${verdict}:${reviewRunId}`);
  if (countedFailure && raw.new_evidence_sha256 !== evidenceDigest) throw coded("legacy_state_invalid");
  const decisionBasisDigest = digestDecisionBasis(auditEnvelope);
  const uid = `review:${task.taskUid.slice(0, 16)}:${loop.fingerprint}:${reviewRunId}`;
  const envelope = Object.freeze({
    eventUid: uid,
    taskUid: task.taskUid,
    boundaryId: loop.boundary,
    submittedIdentity: Object.freeze({
      fingerprint: loop.fingerprint,
      invariantId: loop.invariantId
    }),
    canonicalIdentity: Object.freeze({
      fingerprint: loop.fingerprint,
      invariantId: loop.invariantId
    }),
    generation: finalGeneration,
    severity,
    verdict,
    directionSignal,
    evidenceDigest,
    decisionBasisDigest
  });
  const decision = countedFailure
    && (historicalFailureCount >= 2 || directionSignal !== "none")
    ? "checkpoint_required"
    : "pass";
  return Object.freeze({
    uid, severity, verdict, directionSignal, evidenceDigest, decisionBasisDigest,
    envelopeDigest: sha256(canonicalJson(envelope)), decision
  });
}

function eventDigest(event) {
  return sha256(Buffer.from(canonicalJson(event), "utf8"));
}

function mapGroup({ sourceSha256, task, loops, aliases, distinct }) {
  const mappedLoops = [];
  const grants = [];
  const mappedEvents = [];
  let unsupportedEventCount = 0;
  for (const loop of loops) {
    const [status, currentDecision] = mapStatus(loop);
    const basis = loop.last_evidence_sha256 ?? eventDigest({
      fingerprint: loop.fingerprint, failureCount: loop.failure_count, status: loop.status
    });
    const loopAliases = aliases.filter(([, canonical]) => canonical === loop.invariantId)
      .map(([alias]) => alias);
    mappedLoops.push(Object.freeze({
      fingerprint: loop.fingerprint, boundaryId: loop.boundary,
      canonicalInvariantId: loop.invariantId, status, failureCount: loop.failure_count,
      fixGeneration: loop.local_fix_generations.length + loop.architecture_fix_count,
      decisionBasisDigest: basis, currentDecision,
      directionGeneration: loop.checkpoint === null ? 0 : 1, aliases: loopAliases
    }));
    let failureCount = 0;
    let localGrantIndex = 0;
    let architectureGrantIndex = 0;
    const grantByReceipt = new Map();
    const finalGeneration = loop.local_fix_generations.length + loop.architecture_fix_count;
    loop.events.forEach((raw, index) => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw coded("legacy_state_invalid");
      const action = normalizedId(raw.action);
      let uid = eventUid(sourceSha256, loop.fingerprint, index, action);
      const sourceDigest = eventDigest(raw);
      if (action === "review_recorded") {
        const countedFailure = String(raw.verdict ?? "").toLowerCase() === "changes_required"
          && String(raw.severity ?? "").toLowerCase() !== "minor";
        if (countedFailure) failureCount = Math.min(failureCount + 1, 3);
        const review = liveReviewMapping({
          task, loop, raw, finalGeneration, historicalFailureCount: failureCount
        });
        uid = review.uid;
        mappedEvents.push(Object.freeze({
          eventUid: uid, fingerprint: loop.fingerprint,
          generation: Math.min(localGrantIndex + architectureGrantIndex, 3), eventType: "review_recorded",
          reasonCode: null, decision: review.decision, action: null,
          evidenceDigest: review.evidenceDigest, sourceDigest: review.envelopeDigest,
          resultDigest: review.decisionBasisDigest,
          facts: {
            directionSignal: review.directionSignal,
            failureCount,
            legacyImported: 1,
            severity: review.severity,
            verdict: review.verdict
          }
        }));
      } else if (action === "checkpoint_recorded") {
        if (loop.checkpoint === null) throw coded("legacy_state_invalid");
        mappedEvents.push(Object.freeze({
          eventUid: uid, fingerprint: loop.fingerprint,
          generation: localGrantIndex + architectureGrantIndex, eventType: "checkpoint_recorded",
          reasonCode: null, decision: null, action: null, evidenceDigest: null,
          sourceDigest, resultDigest: loop.checkpoint.sha256,
          facts: { fileDigest: loop.checkpoint.sha256, kind: loop.checkpoint.kind }
        }));
      } else if (action === "fix_authorized") {
        const receiptId = exactDigest(raw.receipt_id);
        const purpose = localGrantIndex < loop.local_fix_generations.length
          ? "local_fix" : "architecture_fix";
        const currentGeneration = purpose === "local_fix"
          ? loop.local_fix_generations[localGrantIndex++] - 1
          : loop.local_fix_generations.length + architectureGrantIndex++;
        const issuedAt = timestamp(raw.at);
        const grant = {
          grantId: `legacy-grant:${receiptId.slice(0, 32)}`, tokenHash: sha256(receiptId),
          fingerprint: loop.fingerprint, currentGeneration, nextGeneration: currentGeneration + 1,
          purpose, scopeDigest: sourceDigest, contractRevision: task.contractRevision,
          policyRevision: task.policyRevision, decisionBasisDigest: basis,
          evidenceDigest: sourceDigest, state: "revoked", issuedAt, expiresAt: issuedAt,
          consumedAt: null, revokedAt: issuedAt
        };
        grantByReceipt.set(receiptId, grant);
        grants.push(grant);
        mappedEvents.push(Object.freeze({
          eventUid: uid, fingerprint: loop.fingerprint, generation: currentGeneration,
          eventType: "grant_issued", reasonCode: null, decision: null, action: purpose,
          evidenceDigest: sourceDigest, sourceDigest, resultDigest: sourceDigest,
          facts: { generation: currentGeneration + 1, purpose }
        }));
      } else if (action === "receipt_consumed") {
        const receiptId = exactDigest(raw.receipt_id);
        const grant = grantByReceipt.get(receiptId);
        if (!grant) throw coded("legacy_state_invalid");
        grant.state = "consumed";
        grant.consumedAt = timestamp(raw.at);
        grant.revokedAt = null;
        grant.expiresAt = grant.consumedAt;
        mappedEvents.push(Object.freeze({
          eventUid: uid, fingerprint: loop.fingerprint, generation: grant.nextGeneration,
          eventType: "grant_consumed", reasonCode: null, decision: null, action: grant.purpose,
          evidenceDigest: grant.evidenceDigest, sourceDigest,
          resultDigest: grant.scopeDigest, facts: { generation: grant.nextGeneration, purpose: grant.purpose }
        }));
      } else if (action === "human_resolution") {
        mappedEvents.push(Object.freeze({
          eventUid: uid, fingerprint: loop.fingerprint,
          generation: loop.local_fix_generations.length + loop.architecture_fix_count,
          eventType: "task_resolved", reasonCode: "legacy_human_resolution",
          decision: "finish", action: "closed", evidenceDigest: null,
          sourceDigest, resultDigest: null, facts: {}
        }));
      } else {
        unsupportedEventCount += 1;
      }
    });
    if (loop.active_receipt !== null) {
      const active = grantByReceipt.get(loop.active_receipt.receipt_id);
      if (active) {
        active.state = loop.active_receipt.consumed_at === null ? "active" : "consumed";
        active.consumedAt = loop.active_receipt.consumed_at === null
          ? null : timestamp(loop.active_receipt.consumed_at);
        active.revokedAt = null;
      }
    }
  }
  for (const declaration of distinct.filter((item) => item.taskId === loops[0]?.taskId)) {
    const loop = loops.find((candidate) => candidate.boundary === declaration.boundary
      && candidate.invariantId === declaration.invariantId);
    if (!loop) continue;
    const sourceDigest = eventDigest(declaration);
    mappedEvents.push(Object.freeze({
      eventUid: `legacy-distinct:${sourceDigest.slice(0, 40)}`, fingerprint: loop.fingerprint,
      generation: 0, eventType: "distinct_declared", reasonCode: normalizedId(
        declaration.reason.replaceAll(/[^a-zA-Z0-9._:-]+/gu, "-")
      ), decision: null, action: null, evidenceDigest: sourceDigest,
      sourceDigest, resultDigest: null, facts: { reasonCode: normalizedId(
        declaration.reason.replaceAll(/[^a-zA-Z0-9._:-]+/gu, "-")
      ) }
    }));
  }
  return Object.freeze({ task, loops: mappedLoops, grants, mappedEvents, unsupportedEventCount });
}

export async function inspectGuardImport({ repoRoot, stateFile, store, logger = () => {} }) {
  if (!store || typeof store.transactionalGuardImport !== "function" || typeof logger !== "function") {
    throw coded("guard_import_invalid_arguments");
  }
  const source = await readOwnedGuardState({ repoRoot, stateFile });
  let json;
  try { json = JSON.parse(source.bytes.toString("utf8")); } catch { throw coded("legacy_state_invalid"); }
  const { lineageId } = await readRepositoryLineage({ repoRoot: source.root });
  const parsed = validateLegacyState(json, sha256(source.root));
  const taskIds = [...new Set(parsed.loops.map((loop) => loop.taskId))].sort();
  const taskMappings = taskIds.map((taskId) => {
    const task = taskProjection({ lineageId, taskId });
    return mapGroup({
      sourceSha256: source.sourceSha256, task,
      loops: parsed.loops.filter((loop) => loop.taskId === taskId),
      aliases: parsed.aliases, distinct: parsed.distinct
    });
  });
  const authorityTask = taskProjection({ lineageId, taskId: AUTHORITY_NATIVE_ID, authority: true });
  const rawEventCount = parsed.loops.reduce((sum, loop) => sum + loop.events.length, 0);
  const consumedGrants = taskMappings.reduce((sum, group) => sum
    + group.grants.filter((grant) => grant.state === "consumed").length, 0);
  const unsupportedEventCount = taskMappings.reduce((sum, group) => sum + group.unsupportedEventCount, 0);
  const plan = deepFreeze({
    sourceSha256: source.sourceSha256,
    mappingRevision: MAPPING_REVISION,
    authorityTaskUid: authorityTask.taskUid,
    counts: { tasks: taskMappings.length, loops: parsed.loops.length,
      events: rawEventCount, consumedGrants },
    items: taskMappings.map((group) => ({
      taskUid: group.task.taskUid, loopCount: group.loops.length,
      eventCount: group.mappedEvents.length, grantCount: group.grants.length
    })),
    warnings: unsupportedEventCount === 0
      ? [] : [`unsupported_legacy_events:${unsupportedEventCount}`]
  });
  PLAN_PRIVATE.set(plan, Object.freeze({
    repoRoot: source.root, stateFile: source.target, authorityTask, taskMappings,
    legacyLiveAction: parsed.loops.some((loop) => loop.active_receipt !== null)
  }));
  logger(Object.freeze({ action: "inspect", sourceSha256: source.sourceSha256,
    taskCount: taskMappings.length, loopCount: parsed.loops.length }));
  return plan;
}

function privatePlan(plan) {
  const value = PLAN_PRIVATE.get(plan);
  if (!value) throw coded("guard_import_plan_invalid");
  return value;
}

export async function applyGuardImport({ plan, store, logger = () => {} }) {
  const internal = privatePlan(plan);
  await readOwnedGuardState({
    repoRoot: internal.repoRoot, stateFile: internal.stateFile, expectedSha256: plan.sourceSha256
  });
  const result = store.transactionalGuardImport({
    eventUid: `legacy-import:${plan.authorityTaskUid.slice(0, 24)}:${plan.sourceSha256.slice(0, 24)}`,
    authorityTask: internal.authorityTask, sourceSha256: plan.sourceSha256,
    mappingRevision: plan.mappingRevision,
    tasks: internal.taskMappings.map(({ task, loops, grants, mappedEvents }) => ({
      task, loops, grants, mappedEvents
    }))
  });
  logger(Object.freeze({ action: "apply", authorityTaskUid: plan.authorityTaskUid,
    sourceSha256: plan.sourceSha256, taskCount: result.taskCount }));
  return result;
}

function canonicalParity(field, side, value) {
  try {
    return canonicalGuardParityValue(field, side, value);
  } catch {
    throw coded("shadow_input_invalid");
  }
}

export async function compareGuardShadow({ plan, store, comparisons, logger = () => {} }) {
  privatePlan(plan);
  if (!Array.isArray(comparisons) || comparisons.length !== PARITY_FIELDS.length) {
    throw coded("shadow_input_invalid");
  }
  const byField = new Map();
  for (const raw of comparisons) {
    const item = plain(raw, "shadow_input_invalid", new Set(["field", "legacy", "kernel"]));
    if (!PARITY_FIELDS.includes(item.field) || byField.has(item.field)) throw coded("shadow_input_invalid");
    byField.set(item.field, item);
  }
  if (PARITY_FIELDS.some((field) => !byField.has(field))) throw coded("shadow_input_invalid");
  let paritySetDigest;
  try {
    paritySetDigest = guardParitySetDigest({
      sourceSha256: plan.sourceSha256,
      mappingRevision: plan.mappingRevision,
      comparisons: PARITY_FIELDS.map((field) => byField.get(field))
    });
  } catch {
    throw coded("shadow_input_invalid");
  }
  let result;
  for (const field of PARITY_FIELDS) {
    const item = byField.get(field);
    const legacy = canonicalParity(field, "legacy", item.legacy);
    const kernel = canonicalParity(field, "kernel", item.kernel);
    const inputDigest = sha256(Buffer.from(canonicalJson({ field, legacy: item.legacy, kernel: item.kernel }), "utf8"));
    result = store.recordGuardShadowComparison({
      eventUid: `shadow:${plan.authorityTaskUid.slice(0, 12)}:${paritySetDigest.slice(0, 12)}:${inputDigest.slice(0, 32)}`,
      authorityTaskUid: plan.authorityTaskUid, sourceSha256: plan.sourceSha256,
      mappingRevision: plan.mappingRevision, paritySetDigest, field,
      legacyValue: item.legacy, kernelValue: item.kernel, inputDigest,
      legacyResultDigest: sha256(Buffer.from(canonicalJson(legacy), "utf8")),
      kernelResultDigest: sha256(Buffer.from(canonicalJson(kernel), "utf8")),
      matched: canonicalJson(legacy) === canonicalJson(kernel)
    });
  }
  logger(Object.freeze({ action: "shadow", authorityTaskUid: plan.authorityTaskUid,
    paritySetDigest, comparisonCount: result.comparisonCount, mismatchCount: result.mismatchCount }));
  return Object.freeze({ paritySetDigest, comparisonCount: result.comparisonCount,
    mismatchCount: result.mismatchCount, matched: result.mismatchCount === 0 });
}

function transitionPaths(stateFile) {
  return Object.freeze({
    authorityLock: path.join(path.dirname(stateFile), "review-loop-authority.lock"),
    legacyLock: path.join(path.dirname(stateFile), "review-loop-state.lock"),
    snapshot: path.join(path.dirname(stateFile), ".review-loop-state.afl-cutover.snapshot")
  });
}

async function acquireDirectoryLock(target, code) {
  try { await mkdir(target, { mode: 0o700 }); } catch (error) {
    if (error?.code === "EEXIST") throw coded(code);
    throw error;
  }
  const owner = path.join(target, "owner.json");
  await writeFile(owner, `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`, {
    flag: "wx", mode: 0o600
  });
  return async () => {
    await unlink(owner).catch(() => {});
    await rmdir(target).catch(() => {});
  };
}

async function withTransitionLocks(stateFile, operation) {
  const paths = transitionPaths(stateFile);
  const releaseAuthority = await acquireDirectoryLock(paths.authorityLock, "guard_authority_locked");
  let releaseLegacy;
  try {
    releaseLegacy = await acquireDirectoryLock(paths.legacyLock, "legacy_state_locked");
    return await operation(paths);
  } finally {
    await releaseLegacy?.();
    await releaseAuthority();
  }
}

async function writeSnapshot(repoRoot, snapshot, bytes, expectedDigest) {
  try {
    const existing = await readOwnedGuardState({
      repoRoot, stateFile: snapshot,
      expectedSha256: expectedDigest, mode: "snapshot"
    });
    return existing;
  } catch (error) {
    if (!new Set(["legacy_state_missing", "ENOENT"]).has(error?.code)) throw error;
  }
  const handle = await open(snapshot, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o400);
  } finally {
    await handle.close();
  }
  const directory = await open(path.dirname(snapshot), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
  return readOwnedGuardState({
    repoRoot, stateFile: snapshot, expectedSha256: expectedDigest, mode: "snapshot"
  });
}

function exactSnapshotMetadata(snapshot, authority) {
  if (snapshot.dev !== authority.snapshotDev || snapshot.ino !== authority.snapshotIno
      || snapshot.uid !== authority.snapshotUid || snapshot.permissions !== authority.snapshotMode
      || snapshot.type !== authority.snapshotType) throw coded("snapshot_identity_changed");
}

export async function cutoverGuard({
  repoRoot, stateFile, plan, store, paritySetDigest, decisionRef, apply,
  hooks = {}, logger = () => {}
}) {
  const internal = privatePlan(plan);
  if (apply !== true) throw coded("guard_apply_required");
  exactDigest(paritySetDigest, "parity_set_digest_invalid");
  const decisionRefDigest = sha256(Buffer.from(boundedText(decisionRef, "decision_ref_invalid", 4096), "utf8"));
  const rootInput = path.resolve(repoRoot);
  const root = await secureRepoRoot(repoRoot);
  if (internal.repoRoot !== root
      || internal.stateFile !== resolvedStateTarget(rootInput, root, stateFile)) {
    throw coded("guard_import_plan_mismatch");
  }
  return withTransitionLocks(internal.stateFile, async (paths) => {
    const first = await readOwnedGuardState({ repoRoot, stateFile, expectedSha256: plan.sourceSha256 });
    if (internal.legacyLiveAction) throw coded("legacy_live_action");
    await hooks.beforeSnapshot?.();
    const snapshot = await writeSnapshot(
      internal.repoRoot, paths.snapshot, first.bytes, first.sourceSha256
    );
    await hooks.afterSnapshot?.();
    await readOwnedGuardState({ repoRoot, stateFile, expectedSha256: plan.sourceSha256 });
    const verifiedSnapshot = await readOwnedGuardState({
      repoRoot: internal.repoRoot,
      stateFile: paths.snapshot,
      expectedSha256: snapshot.sourceSha256,
      mode: "snapshot"
    });
    exactSnapshotMetadata(verifiedSnapshot, {
      snapshotDev: snapshot.dev,
      snapshotIno: snapshot.ino,
      snapshotUid: snapshot.uid,
      snapshotMode: snapshot.permissions,
      snapshotType: snapshot.type
    });
    const eventUidValue = `guard-cutover:${plan.authorityTaskUid.slice(0, 16)}:${plan.sourceSha256.slice(0, 16)}:${decisionRefDigest.slice(0, 16)}`;
    const result = store.recordGuardCutover({
      eventUid: eventUidValue, authorityTaskUid: plan.authorityTaskUid,
      sourceSha256: plan.sourceSha256, mappingRevision: plan.mappingRevision,
      paritySetDigest, snapshotDigest: verifiedSnapshot.sourceSha256,
      snapshotDev: verifiedSnapshot.dev, snapshotIno: verifiedSnapshot.ino,
      snapshotMode: verifiedSnapshot.permissions, snapshotType: verifiedSnapshot.type,
      snapshotUid: verifiedSnapshot.uid, decisionRefDigest
    });
    logger(Object.freeze({ action: "cutover", authorityTaskUid: plan.authorityTaskUid,
      sourceSha256: plan.sourceSha256, cutoverEventUid: result.cutoverEventUid }));
    return result;
  });
}

export async function rollbackGuardCutover({
  repoRoot, stateFile, store, authorityTaskUid, cutoverEventUid, decisionRef, apply,
  hooks = {}, logger = () => {}
}) {
  if (apply !== true) throw coded("guard_apply_required");
  boundedText(cutoverEventUid, "cutover_event_uid_invalid");
  const rootInput = path.resolve(repoRoot);
  const root = await secureRepoRoot(repoRoot);
  const stateTarget = resolvedStateTarget(rootInput, root, stateFile);
  const authority = store.getGuardAuthority({ authorityTaskUid });
  if (authority.authority !== "afl_sqlite" || authority.cutoverEventUid !== cutoverEventUid) {
    throw coded("guard_not_cut_over");
  }
  const decisionRefDigest = sha256(Buffer.from(boundedText(decisionRef, "decision_ref_invalid", 4096), "utf8"));
  return withTransitionLocks(stateTarget, async (paths) => {
    const snapshot = await readOwnedGuardState({
      repoRoot: root, stateFile: paths.snapshot, expectedSha256: authority.snapshotDigest, mode: "snapshot"
    });
    exactSnapshotMetadata(snapshot, authority);
    const current = await readOwnedGuardState({ repoRoot: root, stateFile: stateTarget });
    await hooks.beforeRestore?.();
    if (!current.bytes.equals(snapshot.bytes)) {
      const temporary = path.join(path.dirname(stateTarget), `.review-loop-state.rollback.${process.pid}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      let renamed = false;
      try {
        await handle.writeFile(snapshot.bytes);
        await handle.sync();
        await handle.close();
        await rename(temporary, stateTarget);
        renamed = true;
        await chmod(stateTarget, 0o600);
        const directory = await open(path.dirname(stateTarget), constants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
      } finally {
        await handle.close().catch(() => {});
        if (!renamed) await unlink(temporary).catch(() => {});
      }
    }
    await hooks.afterRestore?.();
    await readOwnedGuardState({
      repoRoot: root, stateFile: stateTarget, expectedSha256: authority.snapshotDigest
    });
    const result = store.recordGuardRollback({
      eventUid: `guard-rollback:${cutoverEventUid.slice(-32)}:${decisionRefDigest.slice(0, 16)}`,
      authorityTaskUid, cutoverEventUid, snapshotDigest: authority.snapshotDigest,
      snapshotDev: snapshot.dev, snapshotIno: snapshot.ino, snapshotMode: snapshot.permissions,
      snapshotType: snapshot.type, snapshotUid: snapshot.uid,
      decisionRefDigest
    });
    logger(Object.freeze({ action: "rollback", authorityTaskUid,
      rollbackEventUid: result.rollbackEventUid, snapshotDigest: authority.snapshotDigest }));
    return result;
  });
}

export async function readGuardAdapterAuthority({ repoRoot, store, lineageId }) {
  const root = await secureRepoRoot(repoRoot);
  const lock = transitionPaths(path.join(root, ".superpowers", "sdd", "review-loop-state.json")).authorityLock;
  try {
    const info = await lstat(lock);
    if (!info.isDirectory() || info.isSymbolicLink()) throw coded("guard_authority_locked");
    own(info, "guard_authority_locked");
    return Object.freeze({ authority: "transition_locked", authorityTaskUid: guardAuthorityTaskUid(lineageId) });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const authorityTaskUid = guardAuthorityTaskUid(lineageId);
  return Object.freeze({ authorityTaskUid, ...store.getGuardAuthority({ authorityTaskUid }) });
}

export { MAPPING_REVISION };
