const ACTIVE_TRANSPORTS = new Set(["codex_thread", "system"]);
const NATIVE_TRANSPORT = "codex_thread";
const FALLBACK_TRANSPORT = "system";
const MAX_RETRY_DELAY_MS = 21_600_000;

function normalizeReasonCode(value, fallback) {
  const normalized = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return normalized || fallback;
}

function retryAtFor(delivery, nowMs) {
  const attempt = Math.max(1, Math.floor(Number(delivery.attempt) || 1));
  return nowMs + Math.min(MAX_RETRY_DELAY_MS, 60_000 * (2 ** Math.max(0, attempt - 1)));
}

function adapterEntries(adapters) {
  const entries = adapters instanceof Map ? [...adapters.entries()] : Object.entries(adapters || {});
  for (const [transport, adapter] of entries) {
    if (!ACTIVE_TRANSPORTS.has(transport)) throw new TypeError(`unsupported notification adapter transport: ${transport}`);
    if (!adapter || typeof adapter.probe !== "function" || typeof adapter.deliver !== "function") {
      throw new TypeError(`notification adapter ${transport} must define probe() and deliver()`);
    }
  }
  return entries;
}

function emit(log, event, delivery, details = {}) {
  if (typeof log !== "function") return;
  try {
    log({
      event,
      notificationId: delivery.notification_id,
      transport: delivery.transport,
      attempt: delivery.attempt,
      leaseEpoch: delivery.lease_epoch,
      ...details
    });
  } catch {}
}

function activateSystemFallback(store, delivery, summary) {
  if (delivery.transport !== NATIVE_TRANSPORT) return;
  const fallback = store.ensureNotificationDelivery({
    notificationId: delivery.notification_id,
    transport: FALLBACK_TRANSPORT,
    state: "pending"
  });
  if (fallback?.changed) summary.fallbackActivated += 1;
}

function recordMutation(summary, key, mutation) {
  if (mutation?.changed) summary[key] += 1;
  else summary.stale += 1;
  return Boolean(mutation?.changed);
}

/**
 * Adapter protocol:
 * - probe({ delivery, notification }) -> { supported, reasonCode? }
 * - deliver({ delivery, notification }) ->
 *   { status: "accepted", ackId } |
 *   { status: "retry", reasonCode, retryAt? } |
 *   { status: "unsupported", reasonCode } |
 *   { status: "failed", reasonCode, retryable? }
 */
export async function deliverNotificationBatch({
  store,
  adapters,
  ownerId,
  nowMs = Date.now(),
  leaseMs = 120_000,
  limit = 8,
  log
}) {
  if (!store || typeof store.claimNotificationDeliveries !== "function") throw new TypeError("store delivery API is required");
  if (!ownerId) throw new TypeError("ownerId is required");
  const safeNowMs = Number(nowMs);
  if (!Number.isFinite(safeNowMs)) throw new TypeError("nowMs must be finite");
  const entries = adapterEntries(adapters);
  const adapterByTransport = new Map(entries);
  const transports = entries.map(([transport]) => transport);
  const claimed = transports.length === 0 ? [] : store.claimNotificationDeliveries({
    ownerId,
    nowMs: safeNowMs,
    leaseMs,
    limit,
    transports
  });
  const summary = {
    claimed: claimed.length,
    accepted: 0,
    retrying: 0,
    failed: 0,
    unsupported: 0,
    fallbackActivated: 0,
    stale: 0
  };

  for (const delivery of claimed) {
    const adapter = adapterByTransport.get(delivery.transport);
    const input = { delivery, notification: delivery.notification };
    emit(log, "notification.delivery.claimed", delivery, { ownerId });
    let probe;
    try {
      probe = await adapter.probe(input);
    } catch (error) {
      const reasonCode = "probe_error";
      const retryAt = retryAtFor(delivery, safeNowMs);
      const mutation = store.failNotificationDelivery({
        notificationId: delivery.notification_id,
        transport: delivery.transport,
        ownerId,
        leaseEpoch: delivery.lease_epoch,
        reasonCode,
        retryAt,
        retryable: true
      });
      recordMutation(summary, "retrying", mutation);
      emit(log, "notification.delivery.retrying", delivery, { reasonCode, retryAt, errorName: error?.name || "Error" });
      continue;
    }
    if (!probe || probe.supported !== true) {
      const reasonCode = normalizeReasonCode(probe?.reasonCode, "unsupported_transport");
      const mutation = store.markNotificationUnsupported({
        notificationId: delivery.notification_id,
        transport: delivery.transport,
        ownerId,
        leaseEpoch: delivery.lease_epoch,
        reasonCode
      });
      if (recordMutation(summary, "unsupported", mutation)) activateSystemFallback(store, delivery, summary);
      emit(log, "notification.delivery.unsupported", delivery, { reasonCode });
      continue;
    }

    let result;
    try {
      result = await adapter.deliver(input);
    } catch (error) {
      result = { status: "retry", reasonCode: "adapter_error", errorName: error?.name || "Error" };
    }
    if (result?.status === "accepted" && typeof result.ackId === "string" && result.ackId.length > 0 && result.ackId.length <= 512) {
      const mutation = store.acceptNotificationDelivery({
        notificationId: delivery.notification_id,
        transport: delivery.transport,
        ownerId,
        leaseEpoch: delivery.lease_epoch,
        ackId: result.ackId
      });
      recordMutation(summary, "accepted", mutation);
      emit(log, "notification.delivery.accepted", delivery, { ackLength: result.ackId.length });
      continue;
    }
    if (result?.status === "unsupported") {
      const reasonCode = normalizeReasonCode(result.reasonCode, "unsupported_transport");
      const mutation = store.markNotificationUnsupported({
        notificationId: delivery.notification_id,
        transport: delivery.transport,
        ownerId,
        leaseEpoch: delivery.lease_epoch,
        reasonCode
      });
      if (recordMutation(summary, "unsupported", mutation)) activateSystemFallback(store, delivery, summary);
      emit(log, "notification.delivery.unsupported", delivery, { reasonCode });
      continue;
    }
    const retryable = result?.status === "retry" || (result?.status === "failed" && result.retryable === true)
      || result?.status === "accepted";
    const reasonCode = normalizeReasonCode(
      result?.reasonCode,
      result?.status === "accepted" ? "invalid_ack" : (retryable ? "adapter_protocol_error" : "delivery_failed")
    );
    const explicitRetryAt = Number(result?.retryAt);
    const retryAt = retryable
      ? (Number.isFinite(explicitRetryAt) ? explicitRetryAt : retryAtFor(delivery, safeNowMs))
      : null;
    const mutation = store.failNotificationDelivery({
      notificationId: delivery.notification_id,
      transport: delivery.transport,
      ownerId,
      leaseEpoch: delivery.lease_epoch,
      reasonCode,
      retryAt,
      retryable
    });
    if (retryable) {
      recordMutation(summary, "retrying", mutation);
      emit(log, "notification.delivery.retrying", delivery, { reasonCode, retryAt, errorName: result?.errorName });
    } else {
      if (recordMutation(summary, "failed", mutation)) activateSystemFallback(store, delivery, summary);
      emit(log, "notification.delivery.failed", delivery, { reasonCode });
    }
  }

  return summary;
}
