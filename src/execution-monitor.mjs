import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

export const EXECUTION_MONITOR_THRESHOLDS = Object.freeze({
  toolCallCount: 32,
  elapsedMs: 45 * 60 * 1_000,
  consecutiveNoProgress: 16
});

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_RECORDS = 50_000;
const MAX_PATH_BYTES = 4_096;
const MAX_METRIC = 2_147_483_647;
const TOOL_TYPES = new Set(["tool_use", "tool_call", "function_call", "custom_tool_call"]);
const TEXT_TYPES = new Set(["text", "output_text", "assistant_text"]);

function boundedIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0");
}

export function deriveExecutionMonitorId({ cli, sessionId } = {}) {
  if (!boundedIdentity(cli) || !boundedIdentity(sessionId)) {
    throw new TypeError("cli and sessionId must be bounded identities");
  }
  return createHash("sha256").update(JSON.stringify([cli, sessionId]), "utf8").digest("hex");
}

function transcriptPath(value) {
  return typeof value === "string" && path.isAbsolute(value) && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= MAX_PATH_BYTES;
}

function timestampOf(record) {
  const value = record.timestamp ?? record.created_at ?? record.createdAt
    ?? record.payload?.timestamp ?? record.message?.timestamp;
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function recordEnvelopes(record) {
  return [record, record.payload]
    .filter((value) => value && typeof value === "object" && !Array.isArray(value));
}

function contentBlocks(envelope) {
  if (Array.isArray(envelope.content)) return envelope.content;
  if (Array.isArray(envelope.message?.content)) return envelope.message.content;
  return [];
}

function visibleText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function classify(record) {
  const envelopes = recordEnvelopes(record);
  let toolCalls = 0;
  let visibleProgress = false;
  let userTurn = false;
  for (const envelope of envelopes) {
    const type = typeof envelope.type === "string" ? envelope.type : "";
    const role = typeof envelope.role === "string" ? envelope.role
      : typeof envelope.message?.role === "string" ? envelope.message.role : "";
    if (role === "user" || type === "user") userTurn = true;
    if (TOOL_TYPES.has(type)) toolCalls += 1;
    const assistant = role === "assistant" || type === "assistant" || type === "agent_message"
      || record.type === "assistant";
    if (assistant && visibleText(envelope.text)) visibleProgress = true;
    if (assistant && ["message", "agent_message"].includes(type) && visibleText(envelope.message)) {
      visibleProgress = true;
    }
    for (const block of contentBlocks(envelope)) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      if (TOOL_TYPES.has(block.type)) toolCalls += 1;
      if (assistant && TEXT_TYPES.has(block.type) && visibleText(block.text ?? block.content)) {
        visibleProgress = true;
      }
    }
  }
  return { toolCalls, visibleProgress, userTurn };
}

function increment(value, amount = 1) {
  return Math.min(MAX_METRIC, value + amount);
}

function parseTranscript(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  let records;
  if (trimmed.startsWith("[")) {
    try { records = JSON.parse(trimmed); } catch { return null; }
    if (!Array.isArray(records)) return null;
  } else {
    const lines = trimmed.split(/\r?\n/u);
    if (lines.some((line) => !line.trim())) return null;
    try { records = lines.map((line) => JSON.parse(line)); } catch { return null; }
  }
  if (records.length < 1 || records.length > MAX_TRANSCRIPT_RECORDS) return null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let turnCount = 0;
  let toolCallCount = 0;
  let consecutiveNoProgress = 0;
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    const timestamp = timestampOf(record);
    if (timestamp === null || (lastTimestamp !== null && timestamp < lastTimestamp)) return null;
    firstTimestamp ??= timestamp;
    lastTimestamp = timestamp;
    const classification = classify(record);
    if (classification.userTurn) turnCount = increment(turnCount);
    if (classification.visibleProgress) consecutiveNoProgress = 0;
    if (classification.toolCalls > 0) {
      toolCallCount = increment(toolCallCount, classification.toolCalls);
      consecutiveNoProgress = increment(consecutiveNoProgress, classification.toolCalls);
    }
  }
  if (firstTimestamp === null || lastTimestamp === null) return null;
  const metrics = Object.freeze({
    turnCount,
    toolCallCount,
    elapsedMs: Math.min(MAX_METRIC, Math.max(0, lastTimestamp - firstTimestamp)),
    consecutiveNoProgress
  });
  const thresholdReached = metrics.toolCallCount >= EXECUTION_MONITOR_THRESHOLDS.toolCallCount
    && metrics.elapsedMs >= EXECUTION_MONITOR_THRESHOLDS.elapsedMs
    && metrics.consecutiveNoProgress >= EXECUTION_MONITOR_THRESHOLDS.consecutiveNoProgress;
  const snapshotDigest = createHash("sha256").update(JSON.stringify([
    metrics.turnCount,
    metrics.toolCallCount,
    metrics.elapsedMs,
    metrics.consecutiveNoProgress
  ]), "utf8").digest("hex");
  return Object.freeze({ metrics, thresholdReached, snapshotDigest });
}

export async function inspectExecutionTranscript({ transcriptPath: file } = {}) {
  if (!transcriptPath(file)) return null;
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_TRANSCRIPT_BYTES) return null;
    if (typeof process.getuid === "function" && before.uid !== process.getuid()) return null;
    const buffer = Buffer.allocUnsafe(MAX_TRANSCRIPT_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (bytesRead > MAX_TRANSCRIPT_BYTES || bytesRead !== before.size || after.size !== before.size
        || after.dev !== before.dev || after.ino !== before.ino) return null;
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      return null;
    }
    return parseTranscript(text);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
