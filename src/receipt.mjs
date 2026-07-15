import { createHash } from "node:crypto";

const PAYLOAD_KEYS = Object.freeze({
  candidate_captured: [],
  review_queued: [],
  review_completed: ["severity", "lesson_count"],
  reviewed_no_lesson: [],
  review_exhausted: ["reason_code"],
  lesson_delivered: ["lesson_count"]
});

export function validateReceiptPayload(kind, payload = {}) {
  const allowed = PAYLOAD_KEYS[kind];
  if (!allowed) throw new TypeError(`unsupported receipt kind: ${kind}`);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("receipt payload must be an object");
  const keys = Object.keys(payload);
  if (keys.some((key) => !allowed.includes(key))) throw new TypeError("receipt payload contains a forbidden key");
  if (kind === "review_completed" && !["Minor", "Major", "Critical", "Blocker"].includes(payload.severity)) {
    throw new TypeError("review_completed requires a valid severity");
  }
  if (("lesson_count" in payload) && (!Number.isInteger(payload.lesson_count) || payload.lesson_count < 0)) {
    throw new TypeError("lesson_count must be a non-negative integer");
  }
  if (("reason_code" in payload) && !/^[a-z0-9_]{1,64}$/.test(payload.reason_code)) {
    throw new TypeError("reason_code is invalid");
  }
  return Object.freeze(Object.assign({}, payload));
}

export function detectReceiptLanguage(text, override = "auto") {
  if (override === "zh" || override === "en") return override;
  if (override !== "auto") throw new TypeError("receipt language must be auto, zh, or en");
  return /[\u3400-\u9fff]/u.test(String(text || "")) ? "zh" : "en";
}

export function receiptNonce(notificationId) {
  return createHash("sha256").update(`receipt:v1\u0000${notificationId}`).digest("hex").slice(0, 16);
}

export function containsReceiptMarker(text, notification) {
  const marker = `<!--afl-receipt id=${notification.notification_id} nonce=${receiptNonce(notification.notification_id)} state=${notification.kind}-->`;
  return String(text || "").includes(marker);
}
