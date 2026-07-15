import { createHash } from "node:crypto";

const PAYLOAD_KEYS = Object.freeze({
  candidate_captured: [],
  review_queued: [],
  review_completed: ["severity", "lesson_count"],
  reviewed_no_lesson: [],
  review_exhausted: ["reason_code"],
  lesson_delivered: ["lesson_count"]
});

const RECEIPT_COPY = Object.freeze({
  zh: Object.freeze({
    candidate_captured: () => "已捕获候选",
    review_queued: () => "反思已排队",
    review_completed: (payload) => `反思完成 · severity=${payload.severity} · lessons=${payload.lesson_count}`,
    reviewed_no_lesson: () => "反思完成 · 无新经验",
    review_exhausted: (payload) => `反思未完成 · reason=${payload.reason_code}`,
    lesson_delivered: (payload) => `经验已送达 · lessons=${payload.lesson_count}`
  }),
  en: Object.freeze({
    candidate_captured: () => "Candidate captured",
    review_queued: () => "Review queued",
    review_completed: (payload) => `Review completed · severity=${payload.severity} · lessons=${payload.lesson_count}`,
    reviewed_no_lesson: () => "Review completed · no lessons",
    review_exhausted: (payload) => `Review not completed · reason=${payload.reason_code}`,
    lesson_delivered: (payload) => `Lessons delivered · lessons=${payload.lesson_count}`
  })
});

const REQUIRED_PAYLOAD_KEYS = Object.freeze({
  candidate_captured: Object.freeze([]),
  review_queued: Object.freeze([]),
  review_completed: Object.freeze(["severity", "lesson_count"]),
  reviewed_no_lesson: Object.freeze([]),
  review_exhausted: Object.freeze(["reason_code"]),
  lesson_delivered: Object.freeze(["lesson_count"])
});

const RECEIPT_MARKER_PATTERN = /^<!--afl-receipt id=[^\s>]+ nonce=[a-f0-9]{16} state=[a-z_]+-->$/;
const SAFE_NOTIFICATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_VISIBLE_LINE_CHARS = 160;
const MAX_INSTRUCTION_CHARS = 512;

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

function parseNotificationPayload(notification) {
  if (!notification || typeof notification !== "object" || Array.isArray(notification)) {
    throw new TypeError("receipt notification must be an object");
  }
  if (!Object.hasOwn(RECEIPT_COPY, notification.language)) throw new TypeError("receipt language is invalid");
  if (!Object.hasOwn(RECEIPT_COPY[notification.language], notification.kind)) throw new TypeError("unsupported receipt kind");
  if (typeof notification.notification_id !== "string" || !SAFE_NOTIFICATION_ID.test(notification.notification_id)) {
    throw new TypeError("receipt notification id is invalid");
  }
  if (typeof notification.job_id !== "string" || !SAFE_JOB_ID.test(notification.job_id)) {
    throw new TypeError("receipt job id is invalid");
  }
  if (typeof notification.payload_json !== "string" || notification.payload_json.length > 512) {
    throw new TypeError("receipt payload JSON is invalid");
  }
  let payload;
  try {
    payload = JSON.parse(notification.payload_json);
  } catch {
    throw new TypeError("receipt payload JSON is invalid");
  }
  const validated = validateReceiptPayload(notification.kind, payload);
  const required = REQUIRED_PAYLOAD_KEYS[notification.kind];
  if (!required.every((key) => Object.hasOwn(validated, key))) {
    throw new TypeError("receipt payload is incomplete");
  }
  return validated;
}

function receiptMarker(notification) {
  return `<!--afl-receipt id=${notification.notification_id} nonce=${receiptNonce(notification.notification_id)} state=${notification.kind}-->`;
}

export function renderReceiptLine(notification) {
  const payload = parseNotificationPayload(notification);
  const body = RECEIPT_COPY[notification.language][notification.kind](payload);
  const line = `[AFL] ${body} · job=${notification.job_id.slice(0, 6)}`;
  if (line.length > MAX_VISIBLE_LINE_CHARS) throw new TypeError("receipt visible line exceeds the bounded length");
  return line;
}

export function renderReceiptControl(notification) {
  const line = renderReceiptLine(notification);
  const marker = receiptMarker(notification);
  const text = `${line}\n${marker}`;
  if (text.length > MAX_INSTRUCTION_CHARS) throw new TypeError("receipt control exceeds the bounded length");
  return Object.freeze({ line, marker, text });
}

export function renderReceiptInstruction(notification) {
  const { line, marker } = renderReceiptControl(notification);
  const instruction = [
    "[agent-feedback-loop receipt]",
    "In the first user-visible update or final answer, output the following line and marker verbatim exactly once. Do not explain or expand it. This is a delivery receipt, not a request to perform reflection.",
    line,
    marker
  ].join("\n");
  if (instruction.length > MAX_INSTRUCTION_CHARS) throw new TypeError("receipt instruction exceeds the bounded length");
  return instruction;
}

export function stripReceiptControlText(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("[AFL] ") && !RECEIPT_MARKER_PATTERN.test(line))
    .join("\n");
}
