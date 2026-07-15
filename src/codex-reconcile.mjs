import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { captureObservedSession, credentialContextTokenHashes, hasCaptureEvidence, normalizeHookEvent, normalizeStopEvent, redactText } from "./capture.mjs";
import { stripReceiptControlText } from "./receipt.mjs";

const DEFAULT_INITIAL_TAIL_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_SCAN_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_COMPACTION_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_COMPACTION_USER_TAIL = 24;
const DEFAULT_INTERRUPTION_WINDOW_MS = 15 * 60 * 1000;
const MAX_ASSISTANT_STATE_CHARS = 16 * 1024;
const CONTROL_MESSAGE_TAGS = new Set([
  "environment_context",
  "recommended_plugins",
  "subagent_notification",
  "turn_aborted"
]);

function parseState(cursor, candidate) {
  let parsed = {};
  try { parsed = JSON.parse(cursor?.state_json || "{}"); } catch {}
  return {
    sessionId: String(parsed.sessionId || candidate.sessionId || "unknown"),
    cwd: parsed.cwd || candidate.cwd || null,
    currentTurnId: parsed.currentTurnId || null,
    currentTurnCwd: parsed.currentTurnCwd || candidate.cwd || null,
    userMessageCount: Math.max(0, Number(parsed.userMessageCount ?? (parsed.userCaptured ? 1 : 0)) || 0),
    assistantSinceLastUser: Boolean(parsed.assistantSinceLastUser || parsed.assistantTail),
    assistantMessageId: parsed.assistantMessageId || null,
    assistantSourceOffset: Number.isFinite(Number(parsed.assistantSourceOffset)) ? Number(parsed.assistantSourceOffset) : null,
    assistantSourceTimestamp: parsed.assistantSourceTimestamp || null,
    assistantToolRefs: [],
    assistantTextualOutputRefs: [],
    assistantFileRefs: [],
    assistantArtifactHashes: [],
    sensitiveTokenHashes: Array.isArray(parsed.sensitiveTokenHashes)
      ? parsed.sensitiveTokenHashes.filter((value) => /^[a-f0-9]{64}$/.test(value)).slice(0, 64)
      : [],
    assistantTail: redactText(parsed.assistantTail || "", { blockedTokenHashes: parsed.sensitiveTokenHashes || [] }).text.slice(-MAX_ASSISTANT_STATE_CHARS),
    lastTerminalType: parsed.lastTerminalType || null,
    lastTerminalTurnId: parsed.lastTerminalTurnId || null,
    lastTerminalAt: Number(parsed.lastTerminalAt || 0),
    discardUntilNewline: Boolean(parsed.discardUntilNewline)
  };
}

function textFromMessage(payload) {
  if (!payload || payload.type !== "message" || !Array.isArray(payload.content)) return "";
  return payload.content
    .filter((item) => item && ["input_text", "output_text", "text"].includes(item.type))
    .map((item) => String(item.text || ""))
    .filter(Boolean)
    .join("\n");
}

function boundedStringRefs(values) {
  const refs = [];
  for (const value of values.flat(Infinity)) {
    if (typeof value !== "string") continue;
    const ref = value.trim();
    if (!ref || ref.length > 4 * 1024 || refs.includes(ref)) continue;
    refs.push(ref);
    if (refs.length >= 64) break;
  }
  return refs;
}

function structuralEvidenceFromMessage(payload) {
  const content = Array.isArray(payload?.content) ? payload.content.filter((item) => item && typeof item === "object") : [];
  const records = [payload, ...content];
  return {
    toolRefs: boundedStringRefs(records.flatMap((item) => [item?.tool_refs || [], item?.toolRefs || [], item?.tool_name || []])),
    textualOutputRefs: boundedStringRefs(records.flatMap((item) => [item?.textual_output_refs || [], item?.textual_output_ref || []])),
    fileRefs: boundedStringRefs(records.flatMap((item) => [item?.file_refs || [], item?.fileRefs || []])),
    artifactHashes: boundedStringRefs(records.flatMap((item) => [item?.artifact_hashes || [], item?.artifactHashes || []]))
  };
}

function isControlMessage(text) {
  const trimmed = String(text || "").trimStart();
  if (/^# AGENTS\.md instructions(?:\s|$)/i.test(trimmed)) return true;
  const match = /^<\/?([a-zA-Z0-9_-]+)(?:\s|>)/.exec(trimmed);
  return Boolean(match && CONTROL_MESSAGE_TAGS.has(match[1]));
}

function messageIdentity(payload, lineOffset) {
  return String(payload?.id || `offset:${Math.max(0, Number(lineOffset) || 0)}`);
}

function compactionMessageIdentity(payload, index, text, turnId) {
  if (payload?.id) return String(payload.id);
  const hash = createHash("sha256").update(`${turnId || "unknown"}\0${index}\0${text}`).digest("hex").slice(0, 24);
  return `compaction:${turnId || "unknown"}:${index}:${hash}`;
}

function nativeMessageTimestamp(messageId, fallback) {
  const match = /^msg_([0-9a-f]{8})-([0-9a-f]{4})-/i.exec(String(messageId || ""));
  if (!match) return fallback;
  const timestampMs = Number.parseInt(`${match[1]}${match[2]}`, 16);
  const fallbackMs = Date.parse(fallback || "");
  const earliest = Date.parse("2020-01-01T00:00:00.000Z");
  if (!Number.isFinite(timestampMs) || timestampMs < earliest) return fallback;
  if (Number.isFinite(fallbackMs) && timestampMs > fallbackMs + 24 * 60 * 60 * 1000) return fallback;
  return new Date(timestampMs).toISOString();
}

function transcriptMessageEvent({ state, candidate, role, text, messageId, turnId, timestamp, sourceOffset, structural = {} }) {
  const common = {
    cli: "codex",
    installationId: "default",
    payload: {
      session_id: state.sessionId,
      turn_id: turnId,
      event_id: `message:${messageId}`,
      cwd: state.currentTurnCwd || state.cwd || candidate.cwd,
      timestamp,
      tool_name: structural.toolRefs?.[0] || null,
      tool_args: structural.toolRefs?.length ? { tool_refs: structural.toolRefs } : null,
      textual_output_ref: structural.textualOutputRefs?.[0] || null,
      file_refs: structural.fileRefs || [],
      artifact_hashes: structural.artifactHashes || []
    },
    capturePolicyRevision: candidate.capturePolicyRevision
  };
  const event = role === "assistant"
    ? normalizeStopEvent({
        ...common,
        payload: { ...common.payload, last_assistant_message: text, capture_completeness: "transcript_visible_assistant" }
      })
    : normalizeHookEvent({ ...common, payload: { ...common.payload, prompt: text } });
  event.event_uid = `codex:default:${state.sessionId}:message:${messageId}`;
  event.source_event_id = `message:${messageId}`;
  event.source_namespace = "transcript_message";
  event.observation_source_id = messageId;
  event.source_offset = sourceOffset;
  event.native_turn = turnId;
  event.native_turn_id = turnId;
  event.capture_source = "codex_transcript_reconcile";
  event.capture_completeness = role === "assistant" ? "transcript_visible_assistant" : "transcript_visible_user";
  return event;
}

function flushAssistantEvent(events, state, candidate) {
  const structural = {
    toolRefs: state.assistantToolRefs,
    textualOutputRefs: state.assistantTextualOutputRefs,
    fileRefs: state.assistantFileRefs,
    artifactHashes: state.assistantArtifactHashes
  };
  if (!state.currentTurnId || !hasCaptureEvidence({
    redacted_text: state.assistantTail,
    tool_refs: structural.toolRefs,
    textual_output_ref: structural.textualOutputRefs?.[0],
    file_refs: structural.fileRefs,
    artifact_hashes: structural.artifactHashes
  })) return;
  const messageId = String(state.assistantMessageId || `assistant-span:${state.currentTurnId}`);
  const event = transcriptMessageEvent({
    state,
    candidate,
    role: "assistant",
    text: state.assistantTail,
    messageId,
    turnId: state.currentTurnId,
    timestamp: state.assistantSourceTimestamp,
    sourceOffset: state.assistantSourceOffset,
    structural
  });
  events.push({ event, rawText: state.assistantTail, immediate: false });
  state.assistantTail = "";
  state.assistantMessageId = null;
  state.assistantSourceOffset = null;
  state.assistantSourceTimestamp = null;
  state.assistantToolRefs = [];
  state.assistantTextualOutputRefs = [];
  state.assistantFileRefs = [];
  state.assistantArtifactHashes = [];
}

async function readCompleteLines(file, {
  startOffset,
  discardInitialPartial,
  continueDiscarding = false,
  maxScanBytes,
  maxLineBytes,
  maxCompactionLineBytes,
  expectedStat
}) {
  const handle = await open(file, "r");
  const lines = [];
  let position = startOffset;
  let lastCompleteOffset = startOffset;
  let scanned = 0;
  let lineParts = [];
  let lineBytes = 0;
  let lineLimit = maxLineBytes;
  let lineStartOffset = startOffset;
  let discarding = discardInitialPartial || continueDiscarding;
  let discardAcrossScans = discarding;
  let skippedOversizedLines = 0;
  const chunk = Buffer.allocUnsafe(256 * 1024);
  try {
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile()
      || (typeof process.getuid === "function" && openedInfo.uid !== process.getuid())
      || expectedStat && (String(openedInfo.dev) !== String(expectedStat.dev) || String(openedInfo.ino) !== String(expectedStat.ino))) {
      const error = new Error("transcript file changed between discovery and open");
      error.code = "transcript_identity_changed";
      throw error;
    }
    while (scanned < maxScanBytes) {
      const requested = Math.min(chunk.length, maxScanBytes - scanned);
      const { bytesRead } = await handle.read(chunk, 0, requested, position);
      if (bytesRead === 0) break;
      let segmentStart = 0;
      while (segmentStart < bytesRead) {
        const newline = chunk.subarray(0, bytesRead).indexOf(0x0a, segmentStart);
        const segmentEnd = newline === -1 ? bytesRead : newline;
        if (!discarding && segmentEnd > segmentStart) {
          const segment = Buffer.from(chunk.subarray(segmentStart, segmentEnd));
          lineParts.push(segment);
          lineBytes += segment.length;
          if (lineBytes > lineLimit && lineLimit === maxLineBytes) {
            const prefix = lineParts[0]?.subarray(0, 2 * 1024).toString("utf8") || "";
            if (/"type"\s*:\s*"compacted"/.test(prefix)) lineLimit = Math.max(maxLineBytes, maxCompactionLineBytes);
          }
          if (lineBytes > lineLimit) {
            lineParts = [];
            lineBytes = 0;
            lineLimit = maxLineBytes;
            discarding = true;
            discardAcrossScans = true;
            skippedOversizedLines += 1;
          }
        }
        if (newline === -1) break;
        if (!discarding) lines.push({ text: Buffer.concat(lineParts, lineBytes).toString("utf8"), offset: lineStartOffset });
        lineParts = [];
        lineBytes = 0;
        lineLimit = maxLineBytes;
        discarding = false;
        discardAcrossScans = false;
        lastCompleteOffset = position + newline + 1;
        lineStartOffset = lastCompleteOffset;
        segmentStart = newline + 1;
      }
      position += bytesRead;
      scanned += bytesRead;
      if (bytesRead < requested) break;
    }
  } finally {
    await handle.close();
  }
  return {
    lines,
    nextOffset: discarding && discardAcrossScans ? position : lastCompleteOffset,
    scannedBytes: scanned,
    skippedOversizedLines,
    continueDiscarding: discarding && discardAcrossScans
  };
}

function parseTranscriptLines(lines, state, candidate, interruptionWindowMs) {
  const events = [];
  for (const lineRecord of lines) {
    const line = typeof lineRecord === "string" ? lineRecord : lineRecord.text;
    const lineOffset = typeof lineRecord === "string" ? 0 : lineRecord.offset;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const timestampMs = Date.parse(record.timestamp || "");
    const timestamp = Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : null;
    if (record.type === "session_meta") {
      state.sessionId = String(record.payload?.id || state.sessionId || candidate.sessionId || "unknown");
      state.cwd = record.payload?.cwd || state.cwd || candidate.cwd || null;
      continue;
    }
    if (record.type === "turn_context") {
      const turnId = String(record.payload?.turn_id || "");
      if (!turnId) continue;
      if (state.currentTurnId !== turnId) {
        state.currentTurnId = turnId;
        state.currentTurnCwd = record.payload?.cwd || state.cwd || candidate.cwd || null;
        state.userMessageCount = 0;
        state.assistantSinceLastUser = false;
        state.assistantMessageId = null;
        state.assistantSourceOffset = null;
        state.assistantSourceTimestamp = null;
        state.assistantToolRefs = [];
        state.assistantTextualOutputRefs = [];
        state.assistantFileRefs = [];
        state.assistantArtifactHashes = [];
        state.sensitiveTokenHashes = [];
        state.assistantTail = "";
      } else if (record.payload?.cwd) {
        state.currentTurnCwd = record.payload.cwd;
      }
      continue;
    }
    if (record.type === "compacted" && Array.isArray(record.payload?.replacement_history)) {
      const history = record.payload.replacement_history
        .map((payload, index) => ({ payload, index, text: textFromMessage(payload) }))
        .filter(({ payload, text }) => payload?.type === "message" && payload.role === "user" && text && !isControlMessage(text))
        .slice(-DEFAULT_COMPACTION_USER_TAIL);
      for (const { payload, index, text } of history) {
        const turnId = String(payload.internal_chat_message_metadata_passthrough?.turn_id || state.currentTurnId || `compaction:${record.payload.window_id || record.payload.window_number || "unknown"}`);
        const messageId = compactionMessageIdentity(payload, index, text, turnId);
        const event = transcriptMessageEvent({
          state,
          candidate,
          role: "user",
          text,
          messageId,
          turnId,
          timestamp: nativeMessageTimestamp(messageId, timestamp),
          sourceOffset: lineOffset
        });
        event.source_namespace = "codex_compaction_message";
        event.capture_source = "codex_compaction_reconcile";
        event.capture_completeness = "compaction_history_user";
        events.push({ event, rawText: text, immediate: false });
      }
      continue;
    }
    if (record.type === "response_item" && record.payload?.type === "message" && state.currentTurnId) {
      const role = String(record.payload.role || "");
      const text = textFromMessage(record.payload);
      const structural = structuralEvidenceFromMessage(record.payload);
      const semanticText = role === "assistant" ? stripReceiptControlText(text) : text;
      if (!hasCaptureEvidence({
        semantic_text: semanticText,
        tool_refs: structural.toolRefs,
        textual_output_ref: structural.textualOutputRefs[0],
        file_refs: structural.fileRefs,
        artifact_hashes: structural.artifactHashes
      })) continue;
      if (role === "user" && !isControlMessage(text)) {
        const nativeTurnId = String(record.payload.internal_chat_message_metadata_passthrough?.turn_id || state.currentTurnId);
        const interrupted = state.userMessageCount === 0 && state.lastTerminalType === "turn_aborted"
          && state.lastTerminalTurnId !== state.currentTurnId
          && state.lastTerminalAt > 0
          && Number.isFinite(timestampMs)
          && timestampMs >= state.lastTerminalAt
          && timestampMs - state.lastTerminalAt <= interruptionWindowMs;
        const steering = state.userMessageCount > 0 && state.assistantSinceLastUser;
        if (steering) flushAssistantEvent(events, state, candidate);
        const messageId = messageIdentity(record.payload, lineOffset);
        const event = transcriptMessageEvent({
          state,
          candidate,
          role: "user",
          text,
          messageId,
          turnId: nativeTurnId,
          timestamp,
          sourceOffset: lineOffset
        });
        events.push({ event, rawText: text, immediate: interrupted || steering });
        state.userMessageCount += 1;
        state.assistantSinceLastUser = false;
        state.sensitiveTokenHashes = credentialContextTokenHashes(text);
      } else if (role === "assistant") {
        if (semanticText.trim()) {
          state.assistantTail = redactText(`${state.assistantTail}${state.assistantTail ? "\n" : ""}${semanticText}`, {
            blockedTokenHashes: state.sensitiveTokenHashes
          }).text.slice(-MAX_ASSISTANT_STATE_CHARS);
        }
        state.assistantToolRefs = boundedStringRefs([state.assistantToolRefs, structural.toolRefs]);
        state.assistantTextualOutputRefs = boundedStringRefs([state.assistantTextualOutputRefs, structural.textualOutputRefs]);
        state.assistantFileRefs = boundedStringRefs([state.assistantFileRefs, structural.fileRefs]);
        state.assistantArtifactHashes = boundedStringRefs([state.assistantArtifactHashes, structural.artifactHashes]);
        state.assistantSinceLastUser = true;
        state.assistantMessageId = messageIdentity(record.payload, lineOffset);
        state.assistantSourceOffset = lineOffset;
        state.assistantSourceTimestamp = timestamp;
      }
      continue;
    }
    if (record.type === "event_msg" && ["task_complete", "turn_aborted"].includes(record.payload?.type)) {
      const terminalTurnId = String(record.payload?.turn_id || state.currentTurnId || "");
      if (terminalTurnId) flushAssistantEvent(events, state, candidate);
      state.lastTerminalType = record.payload.type;
      state.lastTerminalTurnId = terminalTurnId || null;
      state.lastTerminalAt = Number.isFinite(timestampMs) ? timestampMs : 0;
      state.currentTurnId = null;
      state.currentTurnCwd = null;
      state.userMessageCount = 0;
      state.assistantSinceLastUser = false;
      state.assistantMessageId = null;
      state.assistantSourceOffset = null;
      state.assistantSourceTimestamp = null;
      state.assistantToolRefs = [];
      state.assistantTextualOutputRefs = [];
      state.assistantFileRefs = [];
      state.assistantArtifactHashes = [];
      state.sensitiveTokenHashes = [];
      state.assistantTail = "";
    }
  }
  // Do not persist transcript text in the cursor. Capturing the current tail here
  // preserves evidence across scans while the cursor keeps only structural state.
  flushAssistantEvent(events, state, candidate);
  return events;
}

async function newestCodexStateDatabase(home) {
  const codexRoot = path.join(home, ".codex");
  let entries;
  try { entries = await readdir(codexRoot); } catch { return null; }
  const candidates = entries
    .map((name) => ({ name, match: /^state_(\d+)\.sqlite$/.exec(name) }))
    .filter((entry) => entry.match)
    .sort((left, right) => Number(right.match[1]) - Number(left.match[1]));
  for (const candidate of candidates) {
    const file = path.join(codexRoot, candidate.name);
    try {
      const info = await lstat(file);
      if (info.isFile() && !info.isSymbolicLink() && (typeof process.getuid !== "function" || info.uid === process.getuid())) return file;
    } catch {}
  }
  return null;
}

export async function discoverCodexTranscriptCandidates({
  home,
  nowMs = Date.now(),
  lookbackMs = 15 * 60 * 1000,
  trackedCursors = []
}) {
  const stateFile = await newestCodexStateDatabase(home);
  if (!stateFile) return [];
  const sessionsRoot = path.resolve(home, ".codex", "sessions");
  const database = new DatabaseSync(stateFile, { readOnly: true });
  try {
    const columns = new Set(database.prepare("PRAGMA table_info(threads)").all().map((row) => row.name));
    if (!["id", "rollout_path", "cwd"].every((name) => columns.has(name))) return [];
    const updatedExpression = columns.has("updated_at_ms")
      ? "updated_at_ms"
      : (columns.has("updated_at") ? "updated_at * 1000" : "0");
    const sourceExpression = columns.has("source") ? "source" : "''";
    const threadSourceExpression = columns.has("thread_source") ? "thread_source" : "'user'";
    const cliVersionExpression = columns.has("cli_version") ? "cli_version" : "''";
    const select = `SELECT id, rollout_path, cwd,
        ${updatedExpression} AS updated_at_ms,
        ${sourceExpression} AS source,
        ${threadSourceExpression} AS thread_source,
        ${cliVersionExpression} AS cli_version
      FROM threads`;
    const rowsByPath = new Map();
    for (const row of database.prepare(`${select} WHERE ${updatedExpression} >= ?`).all(nowMs - lookbackMs)) {
      rowsByPath.set(path.resolve(String(row.rollout_path || "")), row);
    }
    const trackedByPath = new Map(trackedCursors
      .filter((cursor) => cursor?.transcript_path && Number.isFinite(Number(cursor.offset)))
      .map((cursor) => [path.resolve(String(cursor.transcript_path)), Math.max(0, Number(cursor.offset))]));
    const trackedPaths = [...trackedByPath.keys()];
    for (let index = 0; index < trackedPaths.length; index += 200) {
      const batch = trackedPaths.slice(index, index + 200);
      const placeholders = batch.map(() => "?").join(",");
      for (const row of database.prepare(`${select} WHERE rollout_path IN (${placeholders})`).all(...batch)) {
        const rolloutPath = path.resolve(String(row.rollout_path || ""));
        if (!rowsByPath.has(rolloutPath)) rowsByPath.set(rolloutPath, row);
      }
    }
    const rows = [...rowsByPath.values()].sort((left, right) =>
      Number(left.updated_at_ms || 0) - Number(right.updated_at_ms || 0)
      || String(left.id).localeCompare(String(right.id)));
    const result = [];
    for (const row of rows) {
      if (row.thread_source && row.thread_source !== "user") continue;
      const rolloutPath = path.resolve(String(row.rollout_path || ""));
      const relative = path.relative(sessionsRoot, rolloutPath);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      try {
        const info = await lstat(rolloutPath);
        if (!info.isFile() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid())) continue;
        const recent = Number(row.updated_at_ms || 0) >= nowMs - lookbackMs;
        const trackedOffset = trackedByPath.get(rolloutPath);
        if (!recent && (trackedOffset === undefined || info.size <= trackedOffset)) continue;
      } catch {
        continue;
      }
      result.push({
        sessionId: String(row.id),
        rolloutPath,
        cwd: row.cwd || null,
        source: row.source || null,
        threadSource: row.thread_source || "user",
        updatedAtMs: Number(row.updated_at_ms || 0),
        cliVersion: row.cli_version || null
      });
    }
    return result;
  } finally {
    database.close();
  }
}

export async function reconcileCodexTranscripts({
  store,
  blobs,
  candidates = [],
  now = () => Date.now(),
  initialTailBytes = DEFAULT_INITIAL_TAIL_BYTES,
  maxScanBytes = DEFAULT_MAX_SCAN_BYTES,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  maxCompactionLineBytes = DEFAULT_MAX_COMPACTION_LINE_BYTES,
  interruptionWindowMs = DEFAULT_INTERRUPTION_WINDOW_MS,
  reviewMinEntries = 3,
  reviewMaxEntries = 24,
  reviewMaxAgeMs = 3_600_000,
  reviewCooldownMs = 900_000,
  wakeCooldownMs = 300_000,
  reviewMaxAttempts = 3,
  launchReviewer = async () => {}
}) {
  if (!store || !blobs) throw new TypeError("store and blobs are required");
  const result = {
    filesScanned: 0,
    filesSkipped: 0,
    eventsCaptured: 0,
    duplicateEvents: 0,
    immediateSignals: 0,
    reviewersLaunched: 0,
    recoveredReviewers: 0,
    exhaustedReviewerJobs: 0,
    notificationRefs: [],
    oversizedLinesSkipped: 0,
    coverageGaps: [],
    errors: []
  };
  const reviewSignalsByProject = new Map();
  for (const candidate of candidates) {
    if (!candidate?.rolloutPath || candidate.threadSource && candidate.threadSource !== "user") {
      result.filesSkipped += 1;
      continue;
    }
    try {
      const capturePolicy = store.getCapturePolicy();
      if (!capturePolicy.enabled) {
        result.filesSkipped += 1;
        continue;
      }
      const info = await lstat(candidate.rolloutPath);
      if (!info.isFile() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
        result.filesSkipped += 1;
        continue;
      }
      const cursor = store.getTranscriptCursor("codex", candidate.rolloutPath);
      const sameFile = cursor && String(cursor.device_id) === String(info.dev) && String(cursor.inode_id) === String(info.ino);
      const validOffset = sameFile && Number(cursor.offset) >= 0 && Number(cursor.offset) <= info.size;
      const startOffset = validOffset ? Number(cursor.offset) : Math.max(0, info.size - initialTailBytes);
      const state = parseState(validOffset ? cursor : null, {
        ...candidate,
        capturePolicyRevision: capturePolicy.revision
      });
      candidate.capturePolicyRevision = capturePolicy.revision;
      const chunk = await readCompleteLines(candidate.rolloutPath, {
        startOffset,
        discardInitialPartial: !validOffset && startOffset > 0,
        continueDiscarding: validOffset && state.discardUntilNewline,
        maxScanBytes,
        maxLineBytes,
        maxCompactionLineBytes,
        expectedStat: info
      });
      state.discardUntilNewline = chunk.continueDiscarding;
      result.filesScanned += 1;
      result.oversizedLinesSkipped += chunk.skippedOversizedLines;
      if (chunk.skippedOversizedLines > 0) {
        result.coverageGaps.push({
          path: candidate.rolloutPath,
          kind: "oversized_jsonl_record",
          count: chunk.skippedOversizedLines,
          maxLineBytes
        });
      }
      const parsedEvents = parseTranscriptLines(chunk.lines, state, candidate, interruptionWindowMs);
      for (const item of parsedEvents) {
        const captured = await captureObservedSession({ store, blobs, event: item.event, rawText: item.rawText });
        const canonicalEventUid = captured.eventUid;
        if (captured.duplicate) result.duplicateEvents += 1;
        else result.eventsCaptured += 1;
        if (item.event.role !== "user") continue;
        if (captured.duplicate && !item.immediate) continue;
        if (item.immediate) result.immediateSignals += 1;
        const projectId = item.event.project_id;
        if (!reviewSignalsByProject.has(projectId)) reviewSignalsByProject.set(projectId, []);
        reviewSignalsByProject.get(projectId).push({ eventUid: canonicalEventUid, immediate: item.immediate });
      }
      const persistedState = { ...state };
      delete persistedState.assistantTail;
      store.saveTranscriptCursor({
        provider: "codex",
        transcriptPath: candidate.rolloutPath,
        deviceId: info.dev,
        inodeId: info.ino,
        offset: chunk.nextOffset,
        state: persistedState,
        ...(cursor
          ? { expectedOffset: Number(cursor.offset), expectedInodeId: cursor.inode_id }
          : { expectedMissing: true })
      });
    } catch (error) {
      result.errors.push({ path: candidate?.rolloutPath || null, code: error.code || "reconcile_failed", message: error.message });
    }
  }
  const launchedJobs = new Set();
  for (const [projectId, signals] of reviewSignalsByProject) {
    try {
      const immediateEventUids = [...new Set(signals.filter((signal) => signal.immediate).map((signal) => signal.eventUid))];
      let due = null;
      if (immediateEventUids.length > 0) {
        // Merge every correction into the same still-pending job before claiming
        // its wake. This keeps one transcript catch-up pass to one reviewer per project.
        for (const immediateEventUid of immediateEventUids) {
          const candidateDue = store.submitDueReview({
            projectId,
            minEntries: 1,
            maxEntries: reviewMaxEntries,
            maxAgeMs: reviewMaxAgeMs,
            cooldownMs: reviewCooldownMs,
            promptVersion: "v1",
            immediateEventUid
          });
          if (candidateDue.status === "pending") {
            due = candidateDue;
            result.notificationRefs.push(...(candidateDue.notificationRefs || []));
          }
        }
      } else {
        due = store.submitDueReview({
          projectId,
          minEntries: reviewMinEntries,
          maxEntries: reviewMaxEntries,
          maxAgeMs: reviewMaxAgeMs,
          cooldownMs: reviewCooldownMs,
          promptVersion: "v1"
        });
        result.notificationRefs.push(...(due.notificationRefs || []));
      }
      if (!due || due.status !== "pending") continue;
      const wake = store.claimReviewerWake({ jobId: due.job_id, nowMs: now(), cooldownMs: wakeCooldownMs });
      if (!["inject", "retry"].includes(wake.action)) continue;
      const launch = await launchReviewer({ cli: "codex", jobId: due.job_id, wake, projectId });
      if (launch?.launched !== false) {
        result.reviewersLaunched += 1;
        launchedJobs.add(due.job_id);
      }
    } catch (error) {
      result.errors.push({ projectId, code: error.code || "reviewer_schedule_failed", message: error.message });
    }
  }
  const exhausted = store.failExhaustedReviewerJobs({ nowMs: now(), maxAttempts: reviewMaxAttempts });
  if (typeof exhausted === "number") {
    result.exhaustedReviewerJobs = exhausted;
  } else {
    result.exhaustedReviewerJobs = Number(exhausted?.count || 0);
    result.notificationRefs.push(...(exhausted?.notificationRefs || []));
  }
  for (const job of store.listRecoverableReviewerJobs({ nowMs: now(), maxAttempts: reviewMaxAttempts })) {
    if (launchedJobs.has(job.job_id)) continue;
    try {
      if (job.status === "running" && !store.requeueExpiredReviewerJob({ jobId: job.job_id, nowMs: now() })) continue;
      const wake = store.claimReviewerWake({ jobId: job.job_id, nowMs: now(), cooldownMs: wakeCooldownMs });
      if (!["inject", "retry"].includes(wake.action)) continue;
      const launch = await launchReviewer({
        cli: job.cli || "codex",
        jobId: job.job_id,
        wake,
        projectId: job.project_id,
        recovery: true,
        recoveryReason: job.status === "running" ? "expired_lease" : "pending_retry"
      });
      if (launch?.launched !== false) {
        result.reviewersLaunched += 1;
        result.recoveredReviewers += 1;
        launchedJobs.add(job.job_id);
      }
    } catch (error) {
      result.errors.push({ jobId: job.job_id, code: error.code || "reviewer_recovery_failed", message: error.message });
    }
  }
  return result;
}
