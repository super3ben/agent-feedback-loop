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
const LEGACY_ID_PATTERN = /^notification-([1-9]\d{0,15})$/;
const RECEIPT_MARKER_PATTERN = /^<!--afl-receipt id=([a-f0-9]{64}) nonce=([a-f0-9]{16}) state=([a-z_]+)-->$/;
const VISIBLE_LINE_PATTERNS = Object.freeze({
  candidate_captured: /^\[AFL\] (?:已捕获反馈候选|Feedback candidate captured) · event=[a-f0-9]{6} · receipt=([a-f0-9]{6})$/,
  review_queued: /^\[AFL\] (?:后台反思已排队|Background review queued) · job=[a-f0-9]{6} · receipt=([a-f0-9]{6})$/,
  review_completed: /^\[AFL\] (?:反思完成|Review completed) · severity=(?:Minor|Major|Critical|Blocker) · lessons=\d+ · job=[a-f0-9]{6} · receipt=([a-f0-9]{6})$/,
  reviewed_no_lesson: /^\[AFL\] (?:已复核，本次未形成长期经验|Reviewed; no long-term lesson was created) · job=[a-f0-9]{6} · receipt=([a-f0-9]{6})$/,
  review_exhausted: /^\[AFL\] (?:反思失败，证据已保留并等待重试|Review failed; evidence retained for retry) · job=[a-f0-9]{6} · receipt=([a-f0-9]{6})$/,
  lesson_delivered: /^\[AFL\] (?:已向本任务投递 \d+ 条历史经验|Delivered \d+ prior lessons to this task) · receipt=([a-f0-9]{6})$/
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

function receiptControlNonce(notificationId, state, visibleLine) {
  return createHash("sha256")
    .update(`receipt-control:v2\u0000${notificationId}\u0000${state}\u0000${visibleLine}`)
    .digest("hex")
    .slice(0, 16);
}

function isSupportedObservationId(notificationId) {
  if (typeof notificationId !== "string") return false;
  if (CANONICAL_ID_PATTERN.test(notificationId)) return true;
  const legacy = LEGACY_ID_PATTERN.exec(notificationId);
  return Boolean(legacy && BigInt(legacy[1]) <= BigInt(Number.MAX_SAFE_INTEGER));
}

export function containsReceiptMarker(text, notification) {
  if (!notification || typeof notification !== "object" || Array.isArray(notification)) return false;
  if (!isSupportedObservationId(notification.notification_id)) return false;
  if (!Object.hasOwn(PAYLOAD_KEYS, notification.kind)) return false;
  let marker;
  if (CANONICAL_ID_PATTERN.test(notification.notification_id)) {
    try {
      marker = renderReceiptControl(notification).marker;
    } catch {
      return false;
    }
  } else {
    marker = `<!--afl-receipt id=${notification.notification_id} nonce=${receiptNonce(notification.notification_id)} state=${notification.kind}-->`;
  }
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

function receiptMarker(notification, visibleLine) {
  const nonce = receiptControlNonce(notification.notification_id, notification.kind, visibleLine);
  return `<!--afl-receipt id=${notification.notification_id} nonce=${nonce} state=${notification.kind}-->`;
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
  const line = `[AFL] ${body}${reference} · receipt=${notification.notification_id.slice(0, 6)}`;
  if (line.length > MAX_VISIBLE_LINE_CHARS) throw new TypeError("receipt visible line exceeds the bounded length");
  return line;
}

export function renderReceiptControl(notification) {
  const line = renderReceiptLine(notification);
  const marker = receiptMarker(notification, line);
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

function receiptTextLines(text) {
  const lines = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    if (newline === -1) {
      lines.push({ start, end: text.length, contentEnd: text.length, content: text.slice(start) });
      break;
    }
    const contentEnd = newline > start && text[newline - 1] === "\r" ? newline - 1 : newline;
    lines.push({ start, end: newline + 1, contentEnd, content: text.slice(start, contentEnd) });
    start = newline + 1;
  }
  return lines;
}

export function stripReceiptControlText(text) {
  const source = String(text ?? "");
  const lines = receiptTextLines(source);
  const removals = [];
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const visibleLine = lines[index].content;
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(visibleLine);
      if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) fence = null;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(visibleLine);
    if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
      fence = { character: opening[1][0], length: opening[1].length };
      continue;
    }
    const markerLine = lines[index + 1];
    const marker = RECEIPT_MARKER_PATTERN.exec(markerLine?.content || "");
    if (marker) {
      const [, notificationId, nonce, state] = marker;
      const visiblePattern = VISIBLE_LINE_PATTERNS[state];
      const visible = visiblePattern?.exec(visibleLine);
      if (visible
        && visible[1] === notificationId.slice(0, 6)
        && nonce === receiptControlNonce(notificationId, state, visibleLine)) {
        const start = index === 0 ? lines[index].start : lines[index - 1].contentEnd;
        const end = index === 0 ? markerLine.end : markerLine.contentEnd;
        removals.push({ start, end });
        index += 1;
        continue;
      }
    }
  }
  if (removals.length === 0) return source;
  let stripped = "";
  let cursor = 0;
  for (const removal of removals) {
    stripped += source.slice(cursor, removal.start);
    cursor = removal.end;
  }
  return stripped + source.slice(cursor);
}
