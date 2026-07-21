import { createHash } from "node:crypto";
import { chmod, lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

import {
  deriveTaskUid,
  digestDecisionBasis,
  ensureRepositoryLineage,
  projectContract
} from "./convergence-identity.mjs";
import { evaluateConvergence } from "./convergence-policy.mjs";

const POLICY_REVISION = "convergence-policy-v1";
const POLICY_REVISION_DIGEST = sha256(POLICY_REVISION);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const REVIEW_SEVERITIES = new Set(["minor", "important", "critical"]);
const VERDICTS = new Set(["approved", "changes_required"]);
const DIRECTION_SIGNALS = new Set(["none", "structural_blocked", "no_local_seam"]);
const MODES = new Set(["local_fix", "architecture_fix"]);
const FAILURE_ACTIONS = new Set(["direction_review", "stop"]);
const COMMAND_FLAGS = Object.freeze({
  "record-review": new Set([
    "--task-id", "--invariant-id", "--boundary", "--review-run-id", "--severity",
    "--verdict", "--commit", "--review-ref", "--hypothesis", "--new-evidence",
    "--falsification-test", "--failure-next-action", "--direction-signal"
  ]),
  status: new Set(["--task-id"]),
  "lock-status": new Set(),
  "add-alias": new Set(["--alias", "--canonical"]),
  "declare-distinct": new Set([
    "--task-id", "--invariant-id", "--boundary", "--reason", "--evidence"
  ]),
  checkpoint: new Set(["--task-id", "--invariant-id", "--boundary", "--file"]),
  "authorize-fix": new Set([
    "--task-id", "--invariant-id", "--boundary", "--mode", "--grant-file",
    "--receipt-file", "--checkpoint-file"
  ]),
  "consume-grant": new Set(["--grant-file", "--receipt-file", "--brief-ref"]),
  "consume-receipt": new Set(["--grant-file", "--receipt-file", "--brief-ref"]),
  resolve: new Set([
    "--task-id", "--invariant-id", "--boundary", "--action", "--decision-ref"
  ])
});
const REQUIRED = Object.freeze({
  "record-review": [
    "--task-id", "--invariant-id", "--boundary", "--review-run-id", "--severity",
    "--verdict", "--commit", "--review-ref"
  ],
  status: ["--task-id"],
  "lock-status": [],
  "add-alias": ["--alias", "--canonical"],
  "declare-distinct": ["--task-id", "--invariant-id", "--boundary", "--reason", "--evidence"],
  checkpoint: ["--task-id", "--invariant-id", "--boundary", "--file"],
  "authorize-fix": ["--task-id", "--invariant-id", "--boundary", "--mode"],
  "consume-grant": ["--brief-ref"],
  "consume-receipt": ["--brief-ref"],
  resolve: ["--task-id", "--invariant-id", "--boundary", "--action", "--decision-ref"]
});
const CHECKPOINT_FIELDS = Object.freeze([
  "Task ID", "Invariant ID", "Boundary", "Business goal", "Hard constraints",
  "Failed assumption", "Authoritative state or evidence", "Options considered",
  "Selected direction", "Shared root cause", "Wrong abstraction or state source",
  "New invariant", "New falsifiable invariant", "Paths to remove or change",
  "Bounded implementation scope", "Explicit exclusions",
  "Validation proving the new boundary", "Stop or rollback condition"
]);

function coded(code) {
  return Object.assign(new Error(code), { code });
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function normalizeId(value, code = "guard_invalid_arguments") {
  const normalized = String(value ?? "").trim().toLowerCase().replaceAll(/[^a-z0-9._:-]+/gu, "-");
  if (!IDENTIFIER.test(normalized)) throw coded(code);
  return normalized;
}

function parseArgs(args) {
  if (!Array.isArray(args) || args.length < 1 || !Object.hasOwn(COMMAND_FLAGS, args[0])) {
    throw coded("guard_invalid_arguments");
  }
  const command = args[0];
  const allowed = COMMAND_FLAGS[command];
  const values = Object.create(null);
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowed.has(flag) || Object.hasOwn(values, flag)
        || typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw coded("guard_invalid_arguments");
    }
    values[flag] = value;
  }
  for (const flag of REQUIRED[command]) {
    if (!Object.hasOwn(values, flag)) throw coded("guard_invalid_arguments");
  }
  if (["authorize-fix", "consume-grant", "consume-receipt"].includes(command)) {
    const artifactFlags = ["--grant-file", "--receipt-file"].filter((flag) => Object.hasOwn(values, flag));
    if (artifactFlags.length !== 1) throw coded("guard_invalid_arguments");
    values["--grant-file"] = values[artifactFlags[0]];
  }
  return Object.freeze({ command, values });
}

function keyFrom(values) {
  return Object.freeze({
    taskId: normalizeId(values["--task-id"]),
    invariantId: normalizeId(values["--invariant-id"]),
    boundary: normalizeId(values["--boundary"])
  });
}

function fingerprintFor(key) {
  return sha256(`${key.taskId}\0${key.invariantId}\0${key.boundary}`);
}

function eventUid(kind, ...parts) {
  return `${kind}:${sha256(parts.join("\0"))}`;
}

function reviewEventUid(taskUid, fingerprint, reviewRunId) {
  return `review:${taskUid.slice(0, 16)}:${fingerprint}:${reviewRunId}`;
}

function summary(loop, action, exitCode, architectureFixCount = 0) {
  return Object.freeze({
    action,
    exitCode,
    fingerprint: loop.fingerprint,
    task_id: loop.taskUid,
    canonical_invariant_id: loop.canonicalInvariantId,
    boundary: loop.boundaryId,
    status: loop.status,
    failure_count: loop.failureCount,
    fix_generations: loop.fixGenerations,
    architecture_fix_count: architectureFixCount,
    direction_signal: loop.decision === "checkpoint_required" ? "required" : "none"
  });
}

async function ensureTask({ store, repoRoot, taskId }) {
  const lineage = await ensureRepositoryLineage({ repoRoot });
  const contract = projectContract({
    sourceKind: "approved_plan",
    sourceRef: `sdd-task:${taskId}`,
    sourceRevision: "sdd-task-v1",
    requirements: [],
    exclusions: [],
    importance: "routine",
    importanceAuthority: "approved_plan"
  });
  const taskUid = deriveTaskUid({ lineageId: lineage.lineageId, adapterKind: "sdd", nativeTaskId: taskId });
  const task = store.upsertConvergenceTask({
    eventUid: `contract:${taskUid}`,
    taskUid,
    lineageDigest: sha256(lineage.lineageId),
    adapterKind: "sdd",
    adapterCapability: "workflow_gate",
    nativeTaskDigest: sha256(taskId),
    contractSourceKind: contract.sourceKind,
    contractSourceRefDigest: contract.sourceRefDigest,
    contractRevision: contract.revision,
    policyRevision: POLICY_REVISION_DIGEST,
    importance: contract.importance,
    importanceAuthority: contract.importanceAuthority
  });
  return Object.freeze({ lineage, contract, task });
}

function loopByIdentity(store, taskUid, boundary, invariantId) {
  const rows = store.database.prepare(`SELECT fingerprint, canonical_invariant_id, aliases_json
    FROM convergence_loops WHERE task_uid=? AND boundary_id=?`).all(taskUid, boundary);
  const row = rows.find((candidate) => candidate.canonical_invariant_id === invariantId
    || JSON.parse(candidate.aliases_json).includes(invariantId));
  return row ? store.getConvergenceStatus({ taskUid, fingerprint: row.fingerprint }) : null;
}

function lastGrantPurpose(store, fingerprint) {
  return store.database.prepare(`SELECT action FROM convergence_events
    WHERE fingerprint=? AND event_type='grant_consumed' ORDER BY id DESC LIMIT 1`).get(fingerprint)?.action ?? null;
}

function architectureFixCount(store, fingerprint) {
  return Number(store.database.prepare(`SELECT COUNT(*) AS count FROM convergence_events
    WHERE fingerprint=? AND event_type='grant_consumed' AND action='architecture_fix'`).get(fingerprint).count);
}

function decisionRequest({ contract, loop, priorBasis, lastPurpose }) {
  return {
    adapterCapability: "workflow_gate",
    contract,
    previousDecisionBasisDigest: priorBasis,
    decisionBasisDigest: loop.decisionBasisDigest,
    currentGeneration: loop.currentGeneration,
    requestedGeneration: loop.currentGeneration + 1,
    failureCount: loop.failureCount,
    lastGrantPurpose: lastPurpose,
    acceptanceSatisfied: false,
    addsArchitecture: false,
    touchesExplicitExclusion: false,
    oscillationDetected: false,
    sameInvariant: true,
    explorationRequested: false,
    explorationUsed: false,
    riskHypothesis: null,
    falsificationTest: null,
    evidenceQuality: "verified",
    evidenceChanged: priorBasis !== loop.decisionBasisDigest,
    fileSaveCount: 0,
    semanticRecommendation: null
  };
}

async function recordReview({ parsed, repoRoot, store }) {
  const key = keyFrom(parsed.values);
  const { contract, task } = await ensureTask({ store, repoRoot, taskId: key.taskId });
  const severity = parsed.values["--severity"].trim().toLowerCase();
  const verdict = parsed.values["--verdict"];
  const directionSignal = parsed.values["--direction-signal"] ?? "none";
  if (!REVIEW_SEVERITIES.has(severity) || !VERDICTS.has(verdict)
      || !DIRECTION_SIGNALS.has(directionSignal)) throw coded("guard_invalid_arguments");
  const countedFailure = verdict === "changes_required" && severity !== "minor";
  if (countedFailure) {
    for (const flag of ["--hypothesis", "--new-evidence", "--falsification-test", "--failure-next-action"]) {
      if (!Object.hasOwn(parsed.values, flag)) throw coded("review_evidence_required");
    }
    if (!FAILURE_ACTIONS.has(parsed.values["--failure-next-action"])) throw coded("guard_invalid_arguments");
  }
  const reviewRunId = normalizeId(parsed.values["--review-run-id"]);
  const fingerprint = fingerprintFor(key);
  const prior = loopByIdentity(store, task.taskUid, key.boundary, key.invariantId);
  const reviewUid = reviewEventUid(task.taskUid, prior?.fingerprint ?? fingerprint, reviewRunId);
  const replayEvent = store.database.prepare(
    "SELECT 1 FROM convergence_events WHERE event_uid=?"
  ).get(reviewUid);
  if (!prior && !replayEvent) {
    const candidates = store.database.prepare(`SELECT 1 FROM convergence_loops
      WHERE task_uid=? AND boundary_id=? LIMIT 1`).get(task.taskUid, key.boundary);
    if (candidates) throw coded("invariant_classification_required");
  }
  const evidenceDigest = countedFailure
    ? sha256(parsed.values["--new-evidence"].trim())
    : sha256(`${verdict}:${reviewRunId}`);
  if (countedFailure && prior && !replayEvent) {
    const historical = store.database.prepare(`SELECT 1 FROM convergence_events
      WHERE task_uid=? AND fingerprint=? AND event_type='review_recorded'
        AND evidence_digest=? LIMIT 1`).get(task.taskUid, prior.fingerprint, evidenceDigest);
    if (historical) throw coded("evidence_not_new");
  }
  const basis = digestDecisionBasis({ evidenceDigest, reviewRunId, verdict });
  let loop = store.recordConvergenceReview({
    eventUid: reviewUid,
    taskUid: task.taskUid,
    fingerprint,
    boundaryId: key.boundary,
    canonicalInvariantId: key.invariantId,
    verdict,
    severity,
    directionSignal,
    decisionBasisDigest: basis,
    evidenceDigest,
    generation: prior?.currentGeneration ?? 0
  });
  if (verdict === "approved") return summary(loop, "closed", 0, architectureFixCount(store, loop.fingerprint));

  if (loop.failureCount >= 2 || directionSignal !== "none") {
    const request = decisionRequest({
      contract,
      loop,
      priorBasis: prior?.decisionBasisDigest ?? loop.decisionBasisDigest,
      lastPurpose: lastGrantPurpose(store, loop.fingerprint)
    });
    const evaluation = evaluateConvergence(request);
    const targetStatus = evaluation.decision === "human_decision" ? "human_decision" : "checkpoint_required";
    loop = store.recordConvergenceDecision({
      eventUid: eventUid("decision", task.taskUid, loop.fingerprint, reviewRunId),
      taskUid: task.taskUid,
      fingerprint: loop.fingerprint,
      evaluationRequest: request,
      evaluation,
      targetStatus
    });
  }
  const count = architectureFixCount(store, loop.fingerprint);
  if (loop.decision === "human_decision") return summary(loop, "human_decision_required", 4, count);
  if (loop.decision === "checkpoint_required") return summary(loop, "direction_review_required", 3, count);
  return summary(loop, "local_fix_allowed", 0, count);
}

function loopStatus(store, loop) {
  const prefix = `review:${loop.taskUid.slice(0, 16)}:${loop.fingerprint}:`;
  const seenReviewRunIds = store.database.prepare(`SELECT event_uid FROM convergence_events
    WHERE task_uid=? AND fingerprint=? AND event_type='review_recorded' ORDER BY id`).all(
      loop.taskUid, loop.fingerprint
    ).map((row) => row.event_uid.startsWith(prefix) ? row.event_uid.slice(prefix.length) : row.event_uid);
  return Object.freeze({
    fingerprint: loop.fingerprint,
    task_id: loop.taskUid,
    canonical_invariant_id: loop.canonicalInvariantId,
    boundary: loop.boundaryId,
    status: loop.status,
    failure_count: loop.failureCount,
    fix_generations: loop.fixGenerations,
    architecture_fix_count: architectureFixCount(store, loop.fingerprint),
    seen_review_run_ids: Object.freeze(seenReviewRunIds),
    aliases: loop.aliases,
    decision: loop.decision
  });
}

async function status({ parsed, repoRoot, store }) {
  const taskId = normalizeId(parsed.values["--task-id"]);
  const { task } = await ensureTask({ store, repoRoot, taskId });
  const rows = store.database.prepare(`SELECT fingerprint FROM convergence_loops
    WHERE task_uid=? ORDER BY created_at, fingerprint`).all(task.taskUid);
  return Object.freeze({
    authority: "afl_sqlite",
    task_id: task.taskUid,
    loops: Object.freeze(rows.map((row) => loopStatus(
      store,
      store.getConvergenceStatus({ taskUid: task.taskUid, fingerprint: row.fingerprint })
    ))),
    exitCode: 0
  });
}

function lockStatus(store) {
  const row = store.database.prepare("PRAGMA journal_mode").get();
  return Object.freeze({
    authority: "afl_sqlite",
    locked: false,
    journal_mode: String(row?.journal_mode ?? "unknown").toLowerCase(),
    exitCode: 0
  });
}

function uniqueCanonicalLoop(store, canonicalInvariantId) {
  const matches = store.database.prepare(`SELECT l.task_uid, l.fingerprint
    FROM convergence_loops l JOIN convergence_tasks t ON t.task_uid=l.task_uid
    WHERE t.adapter_kind='sdd' AND l.canonical_invariant_id=?`).all(canonicalInvariantId);
  if (matches.length !== 1) throw coded(matches.length === 0
    ? "canonical_invariant_unknown"
    : "canonical_invariant_ambiguous");
  return matches[0];
}

function addAlias({ parsed, store }) {
  const alias = normalizeId(parsed.values["--alias"]);
  const canonical = normalizeId(parsed.values["--canonical"]);
  const target = uniqueCanonicalLoop(store, canonical);
  const result = store.addConvergenceAlias({
    eventUid: eventUid("alias", target.task_uid, alias, canonical),
    taskUid: target.task_uid,
    fingerprint: target.fingerprint,
    aliasInvariantId: alias
  });
  return Object.freeze({ action: "alias_declared", exitCode: 0, alias, canonical, fingerprint: result.fingerprint });
}

async function declareDistinct({ parsed, repoRoot, store }) {
  const key = keyFrom(parsed.values);
  const { task } = await ensureTask({ store, repoRoot, taskId: key.taskId });
  const candidates = store.database.prepare(`SELECT 1 FROM convergence_loops
    WHERE task_uid=? AND boundary_id=? AND canonical_invariant_id<>? LIMIT 1`).get(
      task.taskUid, key.boundary, key.invariantId
    );
  if (!candidates) throw coded("distinct_declaration_unnecessary");
  const reason = normalizeId(parsed.values["--reason"]);
  const evidenceDigest = sha256(parsed.values["--evidence"].trim());
  const fingerprint = fingerprintFor(key);
  const loop = store.declareConvergenceDistinct({
    eventUid: eventUid("distinct", task.taskUid, fingerprint, reason, evidenceDigest),
    taskUid: task.taskUid,
    fingerprint,
    boundaryId: key.boundary,
    canonicalInvariantId: key.invariantId,
    reasonCode: reason,
    evidenceDigest,
    decisionBasisDigest: digestDecisionBasis({ reason, evidenceDigest })
  });
  return Object.freeze({ action: "distinct_declared", exitCode: 0, ...loopStatus(store, loop) });
}

async function safeRepositoryFile(repoRoot, file, { expectedMode = 0o600 } = {}) {
  const root = await realpath(repoRoot);
  const resolved = await realpath(file);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) throw coded("artifact_outside_repo");
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw coded("artifact_unsafe");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw coded("artifact_not_owned");
  if ((info.mode & 0o777) !== expectedMode) throw coded("artifact_unsafe_mode");
  return resolved;
}

async function privateArtifactTarget(repoRoot, file) {
  const root = await realpath(repoRoot);
  const parent = await realpath(path.dirname(file));
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) throw coded("artifact_outside_repo");
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) throw coded("artifact_unsafe");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw coded("artifact_not_owned");
  return path.join(parent, path.basename(file));
}

async function writePrivateJson(repoRoot, file, value) {
  const target = await privateArtifactTarget(repoRoot, file);
  try {
    await lstat(target);
    throw coded("grant_artifact_exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await chmod(target, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return target;
}

function parseCheckpoint(text, key) {
  const values = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^- ([^:]+):\s*(.+?)\s*$/u.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  if (CHECKPOINT_FIELDS.some((field) => !values.get(field))
      || normalizeId(values.get("Task ID")) !== key.taskId
      || normalizeId(values.get("Invariant ID")) !== key.invariantId
      || normalizeId(values.get("Boundary")) !== key.boundary) {
    throw coded("checkpoint_invalid");
  }
}

async function checkpoint({ parsed, repoRoot, store }) {
  const key = keyFrom(parsed.values);
  const { task } = await ensureTask({ store, repoRoot, taskId: key.taskId });
  const fingerprint = fingerprintFor(key);
  const file = await safeRepositoryFile(repoRoot, parsed.values["--file"]);
  const body = await readFile(file, "utf8");
  parseCheckpoint(body, key);
  const fileDigest = sha256(body);
  const loop = store.recordConvergenceCheckpoint({
    eventUid: eventUid("checkpoint", task.taskUid, fingerprint, fileDigest),
    taskUid: task.taskUid,
    fingerprint,
    checkpointKind: "architecture_direction",
    fileDigest
  });
  return summary(loop, "architecture_fix_allowed", 0, architectureFixCount(store, fingerprint));
}

async function authorizeFix({ parsed, repoRoot, store, now }) {
  const key = keyFrom(parsed.values);
  const { lineage, task } = await ensureTask({ store, repoRoot, taskId: key.taskId });
  const mode = parsed.values["--mode"];
  if (!MODES.has(mode)) throw coded("guard_invalid_arguments");
  const fingerprint = fingerprintFor(key);
  const loop = store.getConvergenceStatus({ taskUid: task.taskUid, fingerprint });
  if (mode === "local_fix" && (loop.failureCount !== 1 || loop.currentGeneration !== 0)) {
    throw coded(loop.decision === "checkpoint_required" ? "direction_review_required" : "transition_invalid");
  }
  if (mode === "architecture_fix" && !["direction_approved", "grant_ready"].includes(loop.status)) {
    throw coded(loop.decision === "human_decision" ? "human_decision_required" : "direction_review_required");
  }
  let checkpoint = null;
  if (mode === "architecture_fix") {
    if (!Object.hasOwn(parsed.values, "--checkpoint-file")) throw coded("guard_invalid_arguments");
    const row = store.database.prepare(`SELECT result_digest FROM convergence_events
      WHERE fingerprint=? AND event_type='checkpoint_recorded' ORDER BY id DESC LIMIT 1`).get(fingerprint);
    if (!row) throw coded("checkpoint_invalid");
    const checkpointFile = await safeRepositoryFile(repoRoot, parsed.values["--checkpoint-file"]);
    const checkpointBody = await readFile(checkpointFile, "utf8");
    if (sha256(checkpointBody) !== row.result_digest) throw coded("checkpoint_changed");
    checkpoint = {
      digest: row.result_digest,
      file: path.relative(await realpath(repoRoot), checkpointFile)
    };
  } else if (Object.hasOwn(parsed.values, "--checkpoint-file")) {
    throw coded("guard_invalid_arguments");
  }
  const scopeDigest = digestDecisionBasis({ taskUid: task.taskUid, fingerprint, mode, generation: loop.currentGeneration });
  const evidenceDigest = checkpoint?.digest ?? loop.decisionBasisDigest;
  const issued = store.issueContinuationGrant({
    eventUid: eventUid("grant", task.taskUid, fingerprint, mode, String(loop.currentGeneration)),
    grantId: eventUid("grant-id", task.taskUid, fingerprint, mode, String(loop.currentGeneration)),
    taskUid: task.taskUid,
    fingerprint,
    currentGeneration: loop.currentGeneration,
    nextGeneration: loop.currentGeneration + 1,
    purpose: mode,
    scopeDigest,
    contractRevision: task.contractRevision,
    policyRevision: task.policyRevision,
    decisionBasisDigest: loop.decisionBasisDigest,
    evidenceDigest,
    expiresAt: new Date(now().getTime() + 5 * 60_000).toISOString()
  });
  if (issued.replayed === true) {
    const artifactFile = await safeRepositoryFile(repoRoot, parsed.values["--grant-file"]);
    let existing;
    try { existing = JSON.parse(await readFile(artifactFile, "utf8")); } catch {
      throw coded("grant_artifact_unrecoverable");
    }
    const existingGrant = existing?.continuation_grant;
    if (existing?.version !== 1 || existingGrant?.grantId !== issued.grantId
        || existingGrant.taskUid !== task.taskUid || existingGrant.fingerprint !== fingerprint
        || existingGrant.purpose !== mode || existingGrant.currentGeneration !== loop.currentGeneration
        || typeof existingGrant.token !== "string") {
      throw coded("grant_artifact_unrecoverable");
    }
    return Object.freeze({
      action: `${mode}_authorized`,
      exitCode: 0,
      continuation_grant: Object.freeze({
        grant_id: existingGrant.grantId,
        purpose: existingGrant.purpose,
        expires_at: existingGrant.expiresAt
      })
    });
  }
  if (typeof issued.token !== "string") throw coded("grant_artifact_unrecoverable");
  const artifact = {
    version: 1,
    continuation_grant: {
      grantId: issued.grantId,
      token: issued.token,
      taskUid: issued.taskUid,
      fingerprint: issued.fingerprint,
      currentGeneration: issued.currentGeneration,
      nextGeneration: issued.nextGeneration,
      purpose: issued.purpose,
      scopeDigest: issued.scopeDigest,
      contractRevision: issued.contractRevision,
      policyRevision: issued.policyRevision,
      decisionBasisDigest: issued.decisionBasisDigest,
      evidenceDigest: issued.evidenceDigest,
      expiresAt: issued.expiresAt,
      lineageDigest: sha256(lineage.lineageId),
      checkpointDigest: checkpoint?.digest ?? null,
      checkpointFile: checkpoint?.file ?? null
    }
  };
  await writePrivateJson(repoRoot, parsed.values["--grant-file"], artifact);
  return Object.freeze({
    action: `${mode}_authorized`,
    exitCode: 0,
    continuation_grant: Object.freeze({
      grant_id: issued.grantId,
      purpose: issued.purpose,
      expires_at: issued.expiresAt
    })
  });
}

async function consumeGrant({ parsed, repoRoot, store }) {
  const artifactFile = await safeRepositoryFile(repoRoot, parsed.values["--grant-file"]);
  let artifact;
  try { artifact = JSON.parse(await readFile(artifactFile, "utf8")); } catch { throw coded("grant_artifact_invalid"); }
  const grant = artifact?.continuation_grant;
  if (artifact?.version !== 1 || !grant || typeof grant !== "object") throw coded("grant_artifact_invalid");
  const lineage = await ensureRepositoryLineage({ repoRoot });
  if (grant.lineageDigest !== sha256(lineage.lineageId)) throw coded("grant_repository_mismatch");
  if (grant.purpose === "architecture_fix") {
    if (typeof grant.checkpointFile !== "string" || typeof grant.checkpointDigest !== "string") {
      throw coded("grant_artifact_invalid");
    }
    const checkpointFile = await safeRepositoryFile(repoRoot, path.join(repoRoot, grant.checkpointFile));
    if (sha256(await readFile(checkpointFile, "utf8")) !== grant.checkpointDigest) {
      throw coded("checkpoint_changed");
    }
  }
  const result = store.consumeContinuationGrant({
    eventUid: eventUid("consume", grant.grantId, parsed.values["--brief-ref"]),
    token: grant.token,
    taskUid: grant.taskUid,
    fingerprint: grant.fingerprint,
    currentGeneration: grant.currentGeneration,
    nextGeneration: grant.nextGeneration,
    purpose: grant.purpose,
    scopeDigest: grant.scopeDigest,
    contractRevision: grant.contractRevision,
    policyRevision: grant.policyRevision,
    decisionBasisDigest: grant.decisionBasisDigest,
    evidenceDigest: grant.evidenceDigest
  });
  await unlink(artifactFile);
  return Object.freeze({
    action: "continuation_grant_consumed",
    exitCode: 0,
    continuation_grant: Object.freeze({
      consumed: true,
      fingerprint: result.fingerprint,
      generation: result.generation,
      purpose: result.purpose,
      brief_ref: parsed.values["--brief-ref"]
    })
  });
}

async function resolve({ parsed, repoRoot, store }) {
  const key = keyFrom(parsed.values);
  const { task } = await ensureTask({ store, repoRoot, taskId: key.taskId });
  if (parsed.values["--action"] !== "close") throw coded("guard_invalid_arguments");
  const loop = loopByIdentity(store, task.taskUid, key.boundary, key.invariantId);
  if (!loop) throw coded("loop_not_found");
  const resolved = store.resolveConvergenceLoop({
    eventUid: eventUid("resolve", task.taskUid, loop.fingerprint, parsed.values["--decision-ref"]),
    taskUid: task.taskUid,
    fingerprint: loop.fingerprint,
    resolution: "closed",
    reasonCode: normalizeId(parsed.values["--decision-ref"])
  });
  return Object.freeze({ action: "closed", exitCode: 0, ...loopStatus(store, resolved) });
}

export async function runGuardCommand({ args, repoRoot, store, now = () => new Date() }) {
  if (typeof repoRoot !== "string" || !store || typeof now !== "function") throw coded("guard_invalid_arguments");
  const parsed = parseArgs(args);
  if (parsed.command === "record-review") return recordReview({ parsed, repoRoot, store });
  if (parsed.command === "status") return status({ parsed, repoRoot, store });
  if (parsed.command === "lock-status") return lockStatus(store);
  if (parsed.command === "add-alias") return addAlias({ parsed, store });
  if (parsed.command === "declare-distinct") return declareDistinct({ parsed, repoRoot, store });
  if (parsed.command === "checkpoint") return checkpoint({ parsed, repoRoot, store });
  if (parsed.command === "authorize-fix") return authorizeFix({ parsed, repoRoot, store, now });
  if (parsed.command === "consume-grant" || parsed.command === "consume-receipt") {
    return consumeGrant({ parsed, repoRoot, store });
  }
  if (parsed.command === "resolve") return resolve({ parsed, repoRoot, store });
  throw coded("guard_invalid_arguments");
}
