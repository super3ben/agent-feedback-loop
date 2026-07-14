import { createHash } from "node:crypto";

const SECRET_PATTERNS = [
  { name: "token", pattern: /(token|api[_-]?key|secret)\s*[=:]\s*([^\s,;]+)/gi },
  { name: "password", pattern: /(password|passwd)\s*[=:]\s*([^\s,;]+)/gi },
  { name: "bearer", pattern: /Bearer\s+[A-Za-z0-9._~+/=-]+/gi }
];

export function redactText(input) {
  let text = String(input ?? "");
  const manifest = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    text = text.replace(pattern, (match, label) => {
      manifest.push({ type: name, label: label || name });
      return label ? `${label}=[REDACTED]` : "Bearer [REDACTED]";
    });
  }
  return {
    text,
    manifest,
    contentHash: createHash("sha256").update(text).digest("hex")
  };
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
  const nativeSessionId = String(input.session_id || input.sessionId || "unknown");
  const promptForId = String(input.prompt || input.text || "");
  const generatedId = `generated:${createHash("sha256").update(`${promptForId}\u0000${input.timestamp || Date.now()}`).digest("hex").slice(0, 24)}`;
  const sourceEventId = String(input.event_id || input.eventId || input.turn_id || input.turnId || input.prompt_id || input.promptId || generatedId);
  const sequenceSource = input.event_seq || input.eventSeq || input.native_turn || input.turn_id || input.turnId;
  const hashedSequence = Number.parseInt(createHash("sha256").update(sourceEventId).digest("hex").slice(0, 8), 16);
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
    native_turn: input.native_turn || input.turn_id || input.turnId || null,
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
    tool_name: input.tool_name || null,
    tool_args: input.tool_args || null,
    textual_output_ref: input.textual_output_ref || null,
    file_refs: Array.isArray(input.file_refs) ? input.file_refs : [],
    artifact_hashes: Array.isArray(input.artifact_hashes) ? input.artifact_hashes : [],
    timeout,
    timeout_unit: timeoutUnit
  };
}

export function normalizeStopEvent({ cli, payload, installationId = "unknown", capturePolicyRevision = 1 }) {
  const input = payload || {};
  const nativeSessionId = String(input.session_id || input.sessionId || "unknown");
  const nativeTurn = String(input.turn_id || input.turnId || input.native_turn || "unknown");
  const sourceEventId = String(input.event_id || input.eventId || `stop:${nativeTurn}`);
  const text = String(input.last_assistant_message || input.assistant_response || input.prompt_response || input.response || input.output || input.transcript_excerpt || "");
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
    tool_name: input.tool_name || null,
    tool_args: input.tool_args || null,
    textual_output_ref: input.transcript_path || input.textual_output_ref || null,
    file_refs: Array.isArray(input.file_refs) ? input.file_refs : [],
    artifact_hashes: Array.isArray(input.artifact_hashes) ? input.artifact_hashes : []
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
