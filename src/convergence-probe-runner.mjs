import { createHash, randomUUID } from "node:crypto";

import { validateConvergenceProbeResult } from "./convergence-probe-result.mjs";

const DEFAULT_LEASE_MS = 240_000;
const RETRY_BACKOFF_MS = 30_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const STATUS_FIELDS = Object.freeze([
  "taskUid",
  "fingerprint",
  "boundaryId",
  "canonicalInvariantId",
  "status",
  "failureCount",
  "currentGeneration",
  "decisionBasisDigest",
  "decision",
  "directionGeneration",
  "probeKind",
  "probeState",
  "probeAttempt",
  "probeLeaseEpoch",
  "probeLeaseUntil",
  "probeResultDigest",
  "version"
]);
function coded(code) {
  return Object.assign(new Error(code), { code });
}

function identifier(value) {
  if (typeof value !== "string" || !ID.test(value)) throw coded("context_invalid");
  return value;
}

function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw coded("context_invalid");
  }
  return value;
}

function digest(value) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw coded("context_invalid");
  return value;
}

function optionalDigest(value) {
  return value === null ? null : digest(value);
}

function isoTimestamp(value) {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
      || !Number.isFinite(Date.parse(value))) throw coded("context_invalid");
  return new Date(Date.parse(value)).toISOString();
}

function boundedStatus(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw coded("context_invalid");
  }
  const result = {
    taskUid: identifier(value.taskUid),
    fingerprint: identifier(value.fingerprint),
    boundaryId: identifier(value.boundaryId),
    canonicalInvariantId: identifier(value.canonicalInvariantId),
    status: identifier(value.status),
    failureCount: integer(value.failureCount),
    currentGeneration: integer(value.currentGeneration),
    decisionBasisDigest: digest(value.decisionBasisDigest),
    decision: identifier(value.decision),
    directionGeneration: integer(value.directionGeneration),
    probeKind: identifier(value.probeKind),
    probeState: identifier(value.probeState),
    probeAttempt: integer(value.probeAttempt),
    probeLeaseEpoch: integer(value.probeLeaseEpoch),
    probeLeaseUntil: isoTimestamp(value.probeLeaseUntil),
    probeResultDigest: optionalDigest(value.probeResultDigest),
    version: integer(value.version)
  };
  if (!STATUS_FIELDS.every((field) => Object.hasOwn(result, field))) {
    throw coded("context_invalid");
  }
  return Object.freeze(result);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function resultDigest(result) {
  return createHash("sha256").update(canonicalJson(result), "utf8").digest("hex");
}

function failureDetails(error) {
  const code = String(error?.code || "");
  if (code === "reviewer_timeout" || code === "provider_timeout") {
    return { reasonCode: "provider_timeout", retryable: true };
  }
  if (["reviewer_unavailable", "provider_unavailable", "ENOENT", "EACCES"].includes(code)) {
    return { reasonCode: "provider_unavailable", retryable: true };
  }
  if (code === "context_invalid") return { reasonCode: "context_invalid", retryable: false };
  return { reasonCode: "provider_invalid", retryable: false };
}

function assertClaim(claimed, ownerId) {
  if (!claimed || claimed.probeState !== "running" || claimed.probeOwnerId !== ownerId
      || !Number.isSafeInteger(claimed.probeLeaseEpoch) || claimed.probeLeaseEpoch < 1
      || typeof claimed.probeLeaseUntil !== "string"
      || !Number.isFinite(Date.parse(claimed.probeLeaseUntil))) {
    throw coded("probe_lease_lost");
  }
  return claimed.probeLeaseEpoch;
}

export async function runConvergenceProbeJob({
  store,
  taskUid,
  fingerprint,
  ownerId,
  provider,
  leaseMs = DEFAULT_LEASE_MS,
  eventUid = () => `probe-${randomUUID()}`
} = {}) {
  if (!store || typeof store.claimConvergenceProbe !== "function"
      || typeof store.getConvergenceStatus !== "function"
      || typeof store.completeConvergenceProbe !== "function"
      || typeof store.failConvergenceProbe !== "function"
      || typeof provider !== "function" || typeof eventUid !== "function") {
    throw coded("context_invalid");
  }
  identifier(taskUid);
  identifier(fingerprint);
  identifier(ownerId);
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) {
    throw coded("context_invalid");
  }

  const claimed = store.claimConvergenceProbe({
    eventUid: identifier(eventUid()),
    taskUid,
    fingerprint,
    ownerId,
    leaseMs
  });
  const leaseEpoch = assertClaim(claimed, ownerId);
  let result;
  let digestValue;
  try {
    const context = Object.freeze({
      status: boundedStatus(store.getConvergenceStatus({ taskUid, fingerprint }))
    });
    result = validateConvergenceProbeResult(
      await provider(context, { resultKind: "convergence_probe" })
    );
    digestValue = resultDigest(result);
  } catch (error) {
    const failure = failureDetails(error);
    try {
      store.failConvergenceProbe({
        eventUid: identifier(eventUid()),
        taskUid,
        fingerprint,
        ownerId,
        leaseEpoch,
        reasonCode: failure.reasonCode,
        retryable: failure.retryable,
        backoffMs: failure.retryable ? RETRY_BACKOFF_MS : 0
      });
    } catch {}
    throw error;
  }

  store.completeConvergenceProbe({
    eventUid: identifier(eventUid()),
    taskUid,
    fingerprint,
    ownerId,
    leaseEpoch,
    action: result.action,
    resultDigest: digestValue
  });
  return Object.freeze({ outcome: result.assessment, action: result.action, resultDigest: digestValue });
}
