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
    candidate_captured: () => "已捕获反馈候选",
    review_queued: () => "后台反思已排队",
    review_completed: (payload) => `反思完成 · severity=${payload.severity} · lessons=${payload.lesson_count}`,
    reviewed_no_lesson: () => "已复核，本次未形成长期经验",
    review_exhausted: () => "反思失败，证据已保留并等待重试",
    lesson_delivered: (payload) => `已向本任务投递 ${payload.lesson_count} 条历史经验`
  }),
  en: Object.freeze({
    candidate_captured: () => "Feedback candidate captured",
    review_queued: () => "Background review queued",
    review_completed: (payload) => `Review completed · severity=${payload.severity} · lessons=${payload.lesson_count}`,
    reviewed_no_lesson: () => "Reviewed; no long-term lesson was created",
    review_exhausted: () => "Review failed; evidence retained for retry",
    lesson_delivered: (payload) => `Delivered ${payload.lesson_count} prior lessons to this task`
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

const CANONICAL_ID_PATTERN = /^[a-f0-9]{64}$/;
const RECEIPT_MARKER_PATTERN = /^<!--afl-receipt id=([a-f0-9]{64}) nonce=([a-f0-9]{16}) state=([a-z_]+)-->$/;
const VISIBLE_LINE_PATTERNS = Object.freeze({
  candidate_captured: /^\[AFL\] (?:已捕获反馈候选|Feedback candidate captured) · event=[a-f0-9]{6}$/,
  review_queued: /^\[AFL\] (?:后台反思已排队|Background review queued) · job=[a-f0-9]{6}$/,
  review_completed: /^\[AFL\] (?:反思完成|Review completed) · severity=(?:Minor|Major|Critical|Blocker) · lessons=\d+ · job=[a-f0-9]{6}$/,
  reviewed_no_lesson: /^\[AFL\] (?:已复核，本次未形成长期经验|Reviewed; no long-term lesson was created) · job=[a-f0-9]{6}$/,
  review_exhausted: /^\[AFL\] (?:反思失败，证据已保留并等待重试|Review failed; evidence retained for retry) · job=[a-f0-9]{6}$/,
  lesson_delivered: /^\[AFL\] (?:已向本任务投递 \d+ 条历史经验|Delivered \d+ prior lessons to this task)$/
});
const MAX_EVENT_ID_CHARS = 2048;
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
  if (typeof notification.notification_id !== "string" || !CANONICAL_ID_PATTERN.test(notification.notification_id)) {
    throw new TypeError("receipt notification id is invalid");
  }
  if (notification.kind === "candidate_captured") {
    if (typeof notification.event_uid !== "string" || notification.event_uid.length < 1 || notification.event_uid.length > MAX_EVENT_ID_CHARS) {
      throw new TypeError("receipt event id is invalid");
    }
  } else if (!["lesson_delivered"].includes(notification.kind)) {
    if (typeof notification.job_id !== "string" || !CANONICAL_ID_PATTERN.test(notification.job_id)) {
      throw new TypeError("receipt job id is invalid");
    }
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
  let reference = "";
  if (notification.kind === "candidate_captured") {
    const eventReference = createHash("sha256")
      .update(`receipt-event-ref:v1\u0000${notification.event_uid}`)
      .digest("hex")
      .slice(0, 6);
    reference = ` · event=${eventReference}`;
  } else if (notification.kind !== "lesson_delivered") {
    reference = ` · job=${notification.job_id.slice(0, 6)}`;
  }
  const line = `[AFL] ${body}${reference}`;
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
  const lines = String(text ?? "").split(/\r?\n/);
  const retained = [];
  for (let index = 0; index < lines.length; index += 1) {
    const visibleLine = lines[index];
    const markerLine = lines[index + 1];
    const marker = RECEIPT_MARKER_PATTERN.exec(markerLine || "");
    if (marker) {
      const [, notificationId, nonce, state] = marker;
      const visiblePattern = VISIBLE_LINE_PATTERNS[state];
      if (visiblePattern?.test(visibleLine) && nonce === receiptNonce(notificationId)) {
        index += 1;
        continue;
      }
    }
    retained.push(visibleLine);
  }
  return retained.join("\n");
}
