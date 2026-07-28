import { createHash } from "node:crypto";

import { validateConvergenceProbeResult } from "./convergence-probe-result.mjs";

const DEFAULT_LEASE_MS = 240_000;

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function resultDigest(result) {
  return createHash("sha256").update(canonicalJson(result), "utf8").digest("hex");
}

function failureCode(error) {
  if (["reviewer_timeout", "provider_timeout"].includes(error?.code)) return "provider_timeout";
  if (["reviewer_unavailable", "provider_unavailable", "ENOENT", "EACCES"].includes(error?.code)) {
    return "provider_unavailable";
  }
  return "provider_invalid";
}

export async function runExecutionMonitorProbe({
  store,
  monitorId,
  reservationEpoch,
  ownerId,
  provider,
  leaseMs = DEFAULT_LEASE_MS
} = {}) {
  if (!store || typeof store.claimExecutionMonitorProbe !== "function"
      || typeof store.completeExecutionMonitorProbe !== "function"
      || typeof store.failExecutionMonitorProbe !== "function"
      || typeof provider !== "function") {
    throw new TypeError("execution probe dependencies are invalid");
  }
  const claimed = store.claimExecutionMonitorProbe({
    monitorId, reservationEpoch, ownerId, leaseMs
  });
  const context = Object.freeze({
    status: Object.freeze({
      monitorId: claimed.monitorId,
      cli: claimed.cli,
      failureCount: claimed.failureCount,
      probeState: claimed.probeState,
      reservationEpoch: claimed.reservationEpoch
    }),
    evidence: Object.freeze({
      metrics: Object.freeze({ ...claimed.reservationMetrics }),
      snapshotDigest: claimed.reservationSnapshotDigest
    })
  });
  let result;
  try {
    result = validateConvergenceProbeResult(
      await provider(context, Object.freeze({ resultKind: "convergence_probe" }))
    );
  } catch (error) {
    try {
      store.failExecutionMonitorProbe({
        monitorId,
        reservationEpoch,
        ownerId,
        reasonCode: failureCode(error)
      });
    } catch {}
    throw error;
  }
  const completed = store.completeExecutionMonitorProbe({
    monitorId,
    reservationEpoch,
    ownerId,
    assessment: result.assessment,
    action: result.action,
    resultDigest: resultDigest(result)
  });
  return Object.freeze({
    assessment: result.assessment,
    action: result.action,
    failureCount: completed.failureCount
  });
}
