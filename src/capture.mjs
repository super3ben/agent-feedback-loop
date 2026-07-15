import { createHash, randomUUID } from "node:crypto";
import { lstat, open } from "node:fs/promises";

import { stripReceiptControlText } from "./receipt.mjs";

const SECRET_PATTERNS = [
  { name: "token", pattern: /(token|api[_-]?key|secret)\s*[=:]\s*([^\s,;]+)/gi },
  { name: "password", pattern: /(password|passwd)\s*[=:]\s*([^\s,;]+)/gi },
  { name: "credential", pattern: /(password|passwd|passcode|api[_ -]?key|token|secret)\s+(?:is|was)\s+(?!(?:already|previously|shared|provided|given|sent)\b)([^\s,;]+)/gi },
  { name: "credential", pattern: /(密码|口令|密钥)\s*(?:是|为|：|:)\s*([^\s,，;；。]+)/g },
  { name: "bearer", pattern: /Bearer\s+[A-Za-z0-9._~+/=-]+/gi }
];
const CREDENTIAL_CONTEXT_PATTERN = /\b(?:password|passwd|passcode|credential|api[_ -]?key|token|secret)\b|密码|口令|密钥/i;
const CONTEXT_TOKEN_PATTERN = /[^\s,，;；。!?！？"'`<>]+/g;
const TERMINAL_TURN_EVENTS = new Set(["task_complete", "turn_aborted"]);

function hasArrayValues(value) {
  return Array.isArray(value) && value.some((item) => String(item ?? "").trim());
}

export function hasCaptureEvidence(event) {
  return Boolean(
    String(event?.redacted_text ?? event?.semantic_text ?? "").trim()
    || String(event?.tool_name ?? "").trim()
    || String(event?.textual_output_ref ?? "").trim()
    || hasArrayValues(event?.tool_refs)
    || hasArrayValues(event?.file_refs)
    || hasArrayValues(event?.artifact_hashes)
  );
}

function looksLikeCredentialToken(value) {
  if (value.length < 6 || value.length > 256 || value.includes("[REDACTED]")) return false;
  const hasDigit = /\d/.test(value);
  const hasLetter = /[A-Za-z]/.test(value);
  const hasSymbol = /[^A-Za-z0-9]/.test(value);
  return hasDigit && (hasLetter || hasSymbol);
}

export function credentialContextTokenHashes(input) {
  const source = String(input ?? "");
  if (!CREDENTIAL_CONTEXT_PATTERN.test(source)) return [];
  return [...new Set((source.match(CONTEXT_TOKEN_PATTERN) || [])
    .filter(looksLikeCredentialToken)
    .map((token) => createHash("sha256").update(token).digest("hex")))];
}

export function redactText(input, { blockedTokenHashes = [] } = {}) {
  let text = String(input ?? "");
  const credentialContext = CREDENTIAL_CONTEXT_PATTERN.test(text);
  const blocked = new Set(blockedTokenHashes);
  const manifest = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    text = text.replace(pattern, (match, label) => {
      manifest.push({ type: name, label: label || name });
      return label ? `${label}=[REDACTED]` : "Bearer [REDACTED]";
    });
  }
  if (credentialContext || blocked.size > 0) {
    text = text.replace(CONTEXT_TOKEN_PATTERN, (token) => {
      const tokenHash = createHash("sha256").update(token).digest("hex");
      if (!(credentialContext && looksLikeCredentialToken(token)) && !blocked.has(tokenHash)) return token;
      manifest.push({ type: "credential_context", label: "contextual_token" });
      return "[REDACTED]";
    });
  }
  return {
    text,
    manifest,
    contentHash: createHash("sha256").update(text).digest("hex")
  };
}

async function readOwnedTranscriptTail(file, maxBytes) {
  if (!file) return "";
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) return "";
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) return "";
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

export async function detectStructuralFeedbackSignal(payload, {
  maxBytes = 2 * 1024 * 1024,
  maxSignalAgeMs = 15 * 60 * 1000,
  now = () => Date.now()
} = {}) {
  const input = payload || {};
  if (!input.transcript_path) return { immediateReview: false, reason: "none" };
  let transcript;
  try {
    transcript = await readOwnedTranscriptTail(input.transcript_path, maxBytes);
  } catch {
    return { immediateReview: false, reason: "transcript_unavailable" };
  }
  const currentTurn = String(input.turn_id || input.turnId || "");
  let latestTerminal = null;
  let latestTerminalAt = null;
  let transcriptTurn = null;
  let latestAssistantReferent = null;
  for (const line of transcript.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type === "turn_context") {
      transcriptTurn = String(record.payload?.turn_id || "") || transcriptTurn;
      continue;
    }
    if (record?.type === "response_item" && record.payload?.type === "message") {
      const messageTurn = String(record.payload.internal_chat_message_metadata_passthrough?.turn_id || transcriptTurn || "");
      if (currentTurn && messageTurn === currentTurn && record.payload.role === "assistant") {
        const assistantText = stripReceiptControlText(textFromValue(record.payload.content || record.payload.text || record.payload.message)).trim();
        if (assistantText) {
          const timestamp = record.timestamp || null;
          const derivedId = createHash("sha256")
            .update(`${messageTurn}\u0000${timestamp || ""}\u0000${assistantText}`)
            .digest("hex")
            .slice(0, 24);
          latestAssistantReferent = {
            id: String(record.payload.id || record.payload.message_id || record.payload.internal_chat_message_metadata_passthrough?.message_id || `derived:${derivedId}`),
            turnId: messageTurn,
            timestamp,
            text: assistantText.slice(-16 * 1024)
          };
        }
      }
      continue;
    }
    if (record?.type === "event_msg") {
      const event = record.payload || {};
      if (!TERMINAL_TURN_EVENTS.has(event.type)) continue;
      if (currentTurn && String(event.turn_id || "") === currentTurn) continue;
      latestTerminal = event.type;
      const parsedTimestamp = Date.parse(record.timestamp || "");
      latestTerminalAt = Number.isFinite(parsedTimestamp) ? parsedTimestamp : null;
    }
  }
  if (latestAssistantReferent) return { immediateReview: true, reason: "active_turn_steering", referent: latestAssistantReferent };
  if (latestTerminal === "turn_aborted") {
    if (latestTerminalAt != null && now() - latestTerminalAt > maxSignalAgeMs) {
      return { immediateReview: false, reason: "stale_interruption" };
    }
    return { immediateReview: true, reason: "prior_turn_interrupted" };
  }
  return { immediateReview: false, reason: "none" };
}

function textFromValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromValue).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  return [value.text, value.content, value.message, value.output_text]
    .map(textFromValue)
    .filter(Boolean)
    .join("\n");
}

function outputTextFromAssistantContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(outputTextFromAssistantContent).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const type = String(value.type || "").toLowerCase();
  if (type && !["text", "output_text"].includes(type)) return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.output_text === "string") return value.output_text;
  return type ? "" : outputTextFromAssistantContent(value.content || value.message);
}

function roleValidatedAssistantMessage(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (record.type === "response_item") {
    return record.payload?.type === "message" && record.payload?.role === "assistant"
      ? record.payload
      : null;
  }
  if (["message", "assistant_message"].includes(record.type) || !record.type) {
    return record.role === "assistant" ? record : null;
  }
  if (record.type === "assistant" && record.message?.role === "assistant") return record.message;
  return null;
}

export function extractRoleValidatedAssistantOutput(transcriptText, { maxChars = 64 * 1024 } = {}) {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new TypeError("maxChars must be a positive integer");
  const fragments = [];
  for (const line of String(transcriptText || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const message = roleValidatedAssistantMessage(JSON.parse(line));
      const text = outputTextFromAssistantContent(message?.content ?? message?.text);
      if (text) fragments.push(text);
    } catch {
      // A bounded tail may begin mid-record. Unparsed bytes are never treated
      // as assistant output and remain available only as encrypted evidence.
    }
  }
  return fragments.join("\n").slice(-maxChars);
}

function collectAssistantText(value, output, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectAssistantText(item, output, seen);
    return;
  }
  const role = String(value.role || value.author?.role || "").toLowerCase();
  const type = String(value.type || "").toLowerCase();
  if (["assistant", "model"].includes(role) || ["assistant", "assistant_message"].includes(type)) {
    const text = textFromValue(value.content || value.message || value.text || value.output);
    if (text) output.push(text);
  }
  for (const key of ["last_assistant_message", "assistant_response", "prompt_response"]) {
    const text = textFromValue(value[key]);
    if (text) output.push(text);
  }
  for (const nested of Object.values(value)) collectAssistantText(nested, output, seen);
}

export function extractTranscriptExcerpt(transcriptText, { maxChars = 12 * 1024 } = {}) {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new TypeError("maxChars must be a positive integer");
  const source = String(transcriptText || "");
  const fragments = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      collectAssistantText(JSON.parse(line), fragments);
    } catch {
      // Unstructured transcript text is retained only in the encrypted raw
      // evidence. It is not mislabeled as an assistant response.
    }
  }
  return fragments.join("\n").slice(-maxChars);
}

export function normalizeHookEvent({ cli, payload, installationId = "unknown", timeout, timeoutUnit, capturePolicyRevision = 1 }) {
  const input = typeof payload === "string" ? { prompt: payload } : (payload || {});
  const toolRefs = Array.isArray(input.tool_refs) ? input.tool_refs : [];
  const nativeSessionId = String(input.session_id || input.sessionId || "unknown");
  const generatedId = `generated:${Date.now().toString(36)}:${randomUUID()}`;
  const explicitEventId = input.event_id || input.eventId || input.prompt_id || input.promptId;
  const nativeTurnId = input.native_turn || input.turn_id || input.turnId || null;
  const sourceEventId = String(explicitEventId || generatedId);
  const sequenceSource = input.event_seq || input.eventSeq || input.native_turn || input.turn_id || input.turnId;
  const hashedSequence = Number.parseInt(createHash("sha256").update(sourceEventId).digest("hex").slice(0, 12), 16);
  const eventSeq = Number.isFinite(Number(sequenceSource)) ? Number(sequenceSource) : (hashedSequence || 1);
  const sessionUid = `${cli}:${installationId}:${nativeSessionId}`;
  const eventUid = `${cli}:${installationId}:${nativeSessionId}:${sourceEventId}`;
  const projectId = input.cwd || input.project_id || `unscoped:${cli}:${createHash("sha256").update(nativeSessionId).digest("hex").slice(0, 16)}`;
  const redacted = redactText(input.prompt || input.text || "");
  return {
    cli,
    installation_id: installationId,
    native_session_id: nativeSessionId,
    session_uid: sessionUid,
    event_uid: eventUid,
    source_event_id: `prompt:${sourceEventId}`,
    source_namespace: "prompt_hook",
    parent_event_id: input.parent_event_id || input.parentEventId || null,
    event_seq: eventSeq,
    native_turn: nativeTurnId,
    native_turn_id: nativeTurnId,
    context_epoch: Number(input.context_epoch || 1),
    task_fingerprint: input.task_fingerprint || `${projectId}:${nativeSessionId}`,
    task_type: input.task_type || input.taskType || null,
    paths: Array.isArray(input.paths) ? input.paths : [],
    tools: Array.isArray(input.tools) ? input.tools : [],
    project_id: projectId,
    cwd: input.cwd || null,
    role: input.role || "user",
    redacted_text: redacted.text,
    content_hash: redacted.contentHash,
    redaction_manifest: redacted.manifest,
    capture_policy_revision: capturePolicyRevision,
    data_class: input.data_class || "normal",
    capture_source: "prompt_hook",
    capture_completeness: "prompt_only",
    tool_name: input.tool_name || toolRefs.find((value) => typeof value === "string" && value.trim()) || null,
    tool_args: input.tool_args || (toolRefs.length ? { tool_refs: toolRefs } : null),
    tool_refs: toolRefs,
    textual_output_ref: input.textual_output_ref || null,
    file_refs: Array.isArray(input.file_refs) ? input.file_refs : [],
    artifact_hashes: Array.isArray(input.artifact_hashes) ? input.artifact_hashes : [],
    source_timestamp: input.timestamp || null,
    timeout,
    timeout_unit: timeoutUnit
  };
}

export function normalizeStopEvent({ cli, payload, installationId = "unknown", capturePolicyRevision = 1 }) {
  const input = payload || {};
  const toolRefs = Array.isArray(input.tool_refs) ? input.tool_refs : [];
  const nativeSessionId = String(input.session_id || input.sessionId || "unknown");
  const nativeTurn = String(input.turn_id || input.turnId || input.native_turn || "unknown");
  const sourceEventId = String(input.event_id || input.eventId || `stop:${nativeTurn}`);
  const text = stripReceiptControlText(input.last_assistant_message || input.assistant_response || input.prompt_response || input.response || input.output || input.transcript_excerpt || "");
  const redacted = redactText(text);
  const eventSeq = Number.parseInt(createHash("sha256").update(`stop\u0000${sourceEventId}`).digest("hex").slice(0, 8), 16) || 1;
  const projectId = input.cwd || input.project_id || `unscoped:${cli}:${createHash("sha256").update(nativeSessionId).digest("hex").slice(0, 16)}`;
  return {
    cli,
    installation_id: installationId,
    native_session_id: nativeSessionId,
    session_uid: `${cli}:${installationId}:${nativeSessionId}`,
    event_uid: `${cli}:${installationId}:${nativeSessionId}:stop:${sourceEventId}`,
    source_event_id: `stop:${sourceEventId}`,
    source_namespace: "stop_hook",
    parent_event_id: input.parent_event_id || input.parentEventId || null,
    event_seq: eventSeq,
    native_turn: nativeTurn,
    native_turn_id: nativeTurn,
    context_epoch: Number(input.context_epoch || 1),
    task_fingerprint: input.task_fingerprint || `${projectId}:${nativeSessionId}`,
    task_type: input.task_type || input.taskType || null,
    paths: Array.isArray(input.paths) ? input.paths : [],
    tools: Array.isArray(input.tools) ? input.tools : [],
    project_id: projectId,
    cwd: input.cwd || null,
    role: "assistant",
    redacted_text: redacted.text,
    content_hash: redacted.contentHash,
    redaction_manifest: redacted.manifest,
    capture_policy_revision: capturePolicyRevision,
    data_class: input.data_class || "normal",
    capture_source: input.transcript_path ? "stop_payload+transcript_ref" : "stop_payload",
    capture_completeness: input.capture_completeness || (input.transcript_path ? "partial" : "partial"),
    tool_name: input.tool_name || toolRefs.find((value) => typeof value === "string" && value.trim()) || null,
    tool_args: input.tool_args || (toolRefs.length ? { tool_refs: toolRefs } : null),
    tool_refs: toolRefs,
    textual_output_ref: input.transcript_path || input.textual_output_ref || null,
    file_refs: Array.isArray(input.file_refs) ? input.file_refs : [],
    artifact_hashes: Array.isArray(input.artifact_hashes) ? input.artifact_hashes : [],
    source_timestamp: input.timestamp || null
  };
}

export async function captureSession({ store, blobs, event, rawText }) {
  store.assertCaptureAllowed(event);
  const rawContentHash = createHash("sha256").update(String(rawText)).digest("hex");
  const blobPath = await blobs.write(rawContentHash, rawText);
  event.encrypted_raw_ref = blobPath;
  // A content-addressed blob may already be referenced by an earlier event.
  // Never remove it on an index conflict; retention GC owns deletion.
  store.captureSessionEvent(event);
  // GC can unlink an old zero-reference content-addressed file between the
  // initial write and the SQLite insert. Re-check after the durable reference
  // exists; a concurrent GC will now observe the reference and leave it alone.
  await blobs.write(rawContentHash, rawText);
  return { event, blobPath };
}

function isConstraintError(error) {
  return String(error?.code || "").startsWith("ERR_SQLITE_CONSTRAINT")
    || (error?.code === "ERR_SQLITE_ERROR" && /UNIQUE|constraint/i.test(error.message || ""));
}

export async function captureObservedSession({ store, blobs, event, rawText }) {
  store.assertCaptureAllowed(event);
  const sourceId = event.observation_source_id || event.source_event_id;
  const observationInput = sourceId ? {
    provider: event.cli || "unknown",
    sourceNamespace: event.source_namespace || "hook",
    sourceId,
    sourceOffset: event.source_offset,
    sessionUid: event.session_uid,
    nativeTurnId: event.native_turn_id || event.native_turn || null,
    role: event.role,
    contentHash: event.content_hash,
    sourceTimestamp: event.source_timestamp || null
  } : null;
  const existing = observationInput ? store.resolveEventObservation(observationInput) : null;
  if (existing) return { event, eventUid: existing.event_uid, duplicate: true, observation: existing, blobPath: existing.encrypted_raw_ref || null };
  try {
    const captured = await captureSession({ store, blobs, event, rawText });
    return { ...captured, eventUid: event.event_uid, duplicate: false, observation: null };
  } catch (error) {
    if (!observationInput || !isConstraintError(error)) throw error;
    const raced = store.resolveEventObservation(observationInput)
      || store.getEventObservation(observationInput.provider, observationInput.sourceNamespace, observationInput.sourceId);
    if (!raced) throw error;
    return { event, eventUid: raced.event_uid, duplicate: true, observation: raced, blobPath: raced.encrypted_raw_ref || null };
  }
}
