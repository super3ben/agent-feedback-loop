import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";

import { stripReceiptControlText } from "./receipt.mjs";

const DEFAULT_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const DEFAULT_SIGNAL_AGE_MS = 15 * 60 * 1000;
const MAX_REFERENT_CHARS = 16 * 1024;
const TERMINAL_TURN_EVENTS = new Set(["task_complete", "turn_aborted"]);
const STRUCTURAL_CANDIDATE_REASONS = new Set(["active_turn_steering", "prior_turn_interrupted"]);

const REASON_ORDER = Object.freeze([
  "negative_evaluation",
  "backward_reference",
  "causal_accountability",
  "expected_process_contrast",
  "explicit_correction"
]);

const EVIDENCE_PATTERNS = Object.freeze({
  negative_evaluation: Object.freeze([
    /(?:没有|没|未)(?:有|能|去)?(?:提前|认真|完整|充分)?(?:考虑|想到|实现|达到|满足|处理)/u,
    /(?:事情|方案|设计|实现|流程|系统)?(?:变得|变成|搞得|弄得)(?:太|更)?复杂/u,
    /(?:明显不满|不合理|不正确|做错了|搞错了|没有达到要求|影响(?:了)?(?:正常|主)?会话)/u,
    /\b(?:wrong|broken|unreasonable|failed|failure|made (?:it|this) (?:more )?complex)\b/iu
  ]),
  backward_reference: Object.freeze([
    /(?:之前|刚才|上面|前面|先前|原来|此前|前一(?:次|轮|条|个))/u,
    /\b(?:before|earlier|previous(?:ly)?|last time|above)\b/iu
  ]),
  causal_accountability: Object.freeze([
    /(?:为什么|为何|怎么)(?:你|你们|模型|agent|codex)?[^。！？?\n]{0,72}(?:没有|没|未|会|要|做|改|考虑|想到)/iu,
    /\b(?:why did you|why didn't you|how did you|how come you)\b/iu
  ]),
  expected_process_contrast: Object.freeze([
    /(?:而是|却)[^。！？?\n]{0,96}(?:等到|直到|才)/u,
    /(?:等到|直到|等我|等用户)[^。！？?\n]{0,72}才/u,
    /(?:本来|原本)[^。！？?\n]{0,48}(?:应该|应当|需要)/u,
    /\b(?:should have|instead of|only after I)\b/iu
  ]),
  explicit_correction: Object.freeze([
    /(?:请|应该|应当|需要)(?:先|直接|改成|改为|不要|停止)/u,
    /(?:不要|别)[^。！？?\n]{0,48}(?:而要|应该|改成|改为)/u,
    /\b(?:please (?:use|change|stop)|should (?:use|change)|use .{1,48} instead)\b/iu
  ])
});

function normalizedText(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function nowMilliseconds(now) {
  const value = typeof now === "function" ? now() : now;
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Date.now();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

export function lengthPrefixedUtf8Sha256(values) {
  const hash = createHash("sha256");
  for (const value of values) {
    const bytes = Buffer.from(String(value ?? ""), "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function feedbackSourceIdentity({ cli, sessionUid, contextEpoch, sourceEventId, referentEventUid }) {
  return lengthPrefixedUtf8Sha256([
    cli,
    sessionUid,
    contextEpoch,
    sourceEventId,
    referentEventUid
  ]);
}

export function textFromValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromValue).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  return [value.text, value.content, value.message, value.output_text]
    .map(textFromValue)
    .filter(Boolean)
    .join("\n");
}

export function outputTextFromAssistantContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(outputTextFromAssistantContent).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const type = String(value.type || "").toLowerCase();
  if (type && !["text", "output_text"].includes(type)) return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.output_text === "string") return value.output_text;
  return type ? "" : outputTextFromAssistantContent(value.content || value.message);
}

export function roleValidatedAssistantMessage(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (record.type === "response_item") {
    return record.payload?.type === "message" && record.payload?.role === "assistant"
      ? record.payload
      : null;
  }
  if (record.type === "assistant" && record.message?.role === "assistant") return record.message;
  if (["message", "assistant_message"].includes(record.type) || !record.type) {
    return record.role === "assistant" ? record : null;
  }
  return null;
}

function roleValidatedUserMessage(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (record.type === "response_item") {
    return record.payload?.type === "message" && record.payload?.role === "user"
      ? record.payload
      : null;
  }
  if (["message", "user_message"].includes(record.type) || !record.type) {
    return record.role === "user" ? record : null;
  }
  return null;
}

async function readOwnedTranscriptTail(file, maxBytes) {
  if (!file) return null;
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) return null;
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) return null;
  const length = Math.min(info.size, maxBytes);
  if (length <= 0) return "";
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, info.size - length);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function assistantReferent(message, { cli, turnId = null, timestamp = null } = {}) {
  const text = stripReceiptControlText(
    outputTextFromAssistantContent(message?.content ?? message?.text ?? message?.message)
  ).trim();
  if (!text) return null;
  const eventUid = firstNonEmpty(
    message.event_uid,
    message.eventUid,
    message.event_id,
    message.eventId,
    message.id,
    message.message_id,
    message.messageId,
    message.internal_chat_message_metadata_passthrough?.message_id
  ) || `derived:${lengthPrefixedUtf8Sha256([cli, turnId, timestamp, text]).slice(0, 24)}`;
  return {
    eventUid,
    turnId: firstNonEmpty(
      message.turn_id,
      message.turnId,
      message.internal_chat_message_metadata_passthrough?.turn_id,
      turnId
    ),
    timestamp: firstNonEmpty(message.timestamp, timestamp),
    text: text.slice(-MAX_REFERENT_CHARS)
  };
}

function explicitAssistantReferent(cli, payload) {
  for (const field of ["assistant_message", "previous_assistant_message", "last_assistant_message", "assistant_response", "prompt_response"]) {
    const candidate = payload?.[field];
    const message = roleValidatedAssistantMessage(candidate);
    if (!message) continue;
    const referent = assistantReferent(message, {
      cli,
      turnId: firstNonEmpty(candidate.turn_id, candidate.turnId),
      timestamp: firstNonEmpty(candidate.timestamp)
    });
    if (referent) return referent;
  }
  return null;
}

function trustedStructuralReason(payload) {
  const signal = String(payload?.feedback_signal || payload?.structural_feedback_signal || "");
  if (payload?.active_turn_steering === true || signal === "active_turn_steering") return "active_turn_steering";
  if (payload?.turn_interrupted === true || signal === "prior_turn_interrupted" || signal === "turn_interrupted") {
    return "prior_turn_interrupted";
  }
  return null;
}

export async function readDirectAssistantReferent({
  cli,
  payload,
  maxBytes = DEFAULT_TRANSCRIPT_BYTES,
  maxSignalAgeMs = DEFAULT_SIGNAL_AGE_MS,
  now = () => Date.now()
}) {
  const input = payload && typeof payload === "object" ? payload : {};
  const currentTurn = firstNonEmpty(input.native_turn, input.turn_id, input.turnId);
  const currentEventId = firstNonEmpty(input.event_id, input.eventId, input.prompt_id, input.promptId);
  const currentUserText = normalizedText(input.prompt || input.text || "");
  const explicit = explicitAssistantReferent(cli, input);
  const explicitStructural = trustedStructuralReason(input);
  if (explicit) {
    return {
      referent: explicit,
      structuralReason: explicitStructural || (currentTurn && explicit.turnId === currentTurn ? "active_turn_steering" : null)
    };
  }
  if (explicitStructural) return { referent: null, structuralReason: explicitStructural };

  const transcriptPath = firstNonEmpty(input.transcript_path, input.transcriptPath);
  if (!transcriptPath) return { referent: null, structuralReason: null };
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes must be a positive integer");
  if (!Number.isFinite(maxSignalAgeMs) || maxSignalAgeMs < 0) throw new TypeError("maxSignalAgeMs must be non-negative");

  let transcript;
  try {
    transcript = await readOwnedTranscriptTail(transcriptPath, maxBytes);
  } catch {
    return { referent: null, structuralReason: "transcript_unavailable" };
  }
  if (transcript === null) return { referent: null, structuralReason: "transcript_unavailable" };

  let transcriptTurn = null;
  let latestCompletedReferent = null;
  let activeTurnReferent = null;
  let latestTerminal = null;
  let latestTerminalAt = null;
  for (const line of transcript.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type === "turn_context") {
      transcriptTurn = firstNonEmpty(record.payload?.turn_id, record.payload?.turnId, transcriptTurn);
      continue;
    }
    const userMessage = roleValidatedUserMessage(record);
    if (userMessage) {
      const userTurn = firstNonEmpty(
        userMessage.turn_id,
        userMessage.turnId,
        userMessage.internal_chat_message_metadata_passthrough?.turn_id,
        transcriptTurn
      );
      const userEventId = firstNonEmpty(
        userMessage.event_id,
        userMessage.eventId,
        userMessage.id,
        userMessage.message_id,
        userMessage.messageId,
        userMessage.internal_chat_message_metadata_passthrough?.message_id
      );
      const userText = normalizedText(textFromValue(userMessage.content ?? userMessage.text ?? userMessage.message));
      const matchingId = Boolean(currentEventId && userEventId === currentEventId);
      const matchingText = Boolean(currentUserText && userText === currentUserText && (!currentTurn || userTurn === currentTurn));
      if (matchingId || matchingText) break;
      continue;
    }
    const message = roleValidatedAssistantMessage(record);
    if (message) {
      const messageTurn = firstNonEmpty(
        message.turn_id,
        message.turnId,
        message.internal_chat_message_metadata_passthrough?.turn_id,
        transcriptTurn
      );
      const referent = assistantReferent(message, { cli, turnId: messageTurn, timestamp: record.timestamp || null });
      if (!referent) continue;
      if (currentTurn && messageTurn === currentTurn) activeTurnReferent = referent;
      else latestCompletedReferent = referent;
      continue;
    }
    if (record?.type !== "event_msg") continue;
    const event = record.payload || {};
    if (!TERMINAL_TURN_EVENTS.has(event.type)) continue;
    if (currentTurn && firstNonEmpty(event.turn_id, event.turnId) === currentTurn) continue;
    latestTerminal = event.type;
    const parsedTimestamp = Date.parse(record.timestamp || "");
    latestTerminalAt = Number.isFinite(parsedTimestamp) ? parsedTimestamp : null;
  }

  if (activeTurnReferent) return { referent: activeTurnReferent, structuralReason: "active_turn_steering" };
  if (latestTerminal === "turn_aborted") {
    if (latestTerminalAt !== null && nowMilliseconds(now) - latestTerminalAt > maxSignalAgeMs) {
      return { referent: latestCompletedReferent, structuralReason: "stale_interruption" };
    }
    return { referent: latestCompletedReferent, structuralReason: "prior_turn_interrupted" };
  }
  return { referent: latestCompletedReferent, structuralReason: null };
}

export function classifyRetrospectiveEvidence({ userText, hasReferent }) {
  const text = normalizedText(userText);
  const reasons = new Set();
  for (const reason of REASON_ORDER) {
    if (EVIDENCE_PATTERNS[reason].some((pattern) => pattern.test(text))) reasons.add(reason);
  }
  const supporting = [
    "backward_reference",
    "causal_accountability",
    "expected_process_contrast",
    "explicit_correction"
  ].filter((reason) => reasons.has(reason));
  const required = Boolean(hasReferent) && reasons.has("negative_evaluation");
  return {
    candidate: required && supporting.length >= 1,
    reasonCodes: REASON_ORDER.filter((reason) => reasons.has(reason)),
    score: 40 + supporting.length * 20
  };
}

function isSyntheticAflControl(payload, userText) {
  if (payload?.hook_run_id || payload?.hookRunId || payload?.hook_prompt || payload?.hookPrompt) return true;
  const text = String(userText ?? "");
  if (/<\/?hook_prompt\b/iu.test(text)) return true;
  if (/Output this receipt verbatim before stopping:/iu.test(text) && /(?:\[AFL\]|<!--afl-receipt\b)/u.test(text)) return true;
  return Boolean(text.trim()) && !stripReceiptControlText(text).trim();
}

export async function detectFeedbackCandidate({
  payload,
  userText,
  referent,
  now = () => Date.now(),
  maxBytes = DEFAULT_TRANSCRIPT_BYTES,
  maxSignalAgeMs = DEFAULT_SIGNAL_AGE_MS
}) {
  const input = payload && typeof payload === "object" ? payload : {};
  if (isSyntheticAflControl(input, userText)) {
    return { candidate: false, reasonCodes: [], score: 0, referent: null };
  }

  const resolved = referent === undefined
    ? await readDirectAssistantReferent({ cli: input.cli || "unknown", payload: input, maxBytes, maxSignalAgeMs, now })
    : { referent, structuralReason: trustedStructuralReason(input) };
  if (STRUCTURAL_CANDIDATE_REASONS.has(resolved.structuralReason)) {
    return {
      candidate: true,
      reasonCodes: [resolved.structuralReason],
      score: 100,
      referent: resolved.referent || null
    };
  }
  const classified = classifyRetrospectiveEvidence({ userText, hasReferent: Boolean(resolved.referent) });
  return { ...classified, referent: resolved.referent || null };
}
