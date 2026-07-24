import { createHash } from "node:crypto";

import { ControlStoreError, prepareCapture } from "./control-store.mjs";
import {
  classifyRetrospectiveEvidence,
  lengthPrefixedUtf8Sha256,
  outputTextFromAssistantContent,
  readDirectAssistantReferent,
  roleValidatedAssistantMessage,
  textFromValue,
  stripSyntheticAflControlText
} from "./feedback-signal.mjs";

const SECRET_PATTERNS = [
  { name: "token", pattern: /(token|api[_-]?key|secret)\s*[=:]\s*([^\s,;]+)/gi },
  { name: "password", pattern: /(password|passwd)\s*[=:]\s*([^\s,;]+)/gi },
  { name: "credential", pattern: /(password|passwd|passcode|api[_ -]?key|token|secret)\s+(?:is|was)\s+(?!(?:already|previously|shared|provided|given|sent)\b)([^\s,;]+)/gi },
  { name: "credential", pattern: /(密码|口令|密钥)\s*(?:是|为|：|:)\s*([^\s,，;；。]+)/g },
  { name: "bearer", pattern: /Bearer\s+[A-Za-z0-9._~+/=-]+/gi }
];
const CREDENTIAL_CONTEXT_PATTERN = /\b(?:password|passwd|passcode|credential|api[_ -]?key|token|secret)\b|密码|口令|密钥/i;
const CONTEXT_TOKEN_PATTERN = /[^\s,，;；。!?！？"'`<>]+/g;

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

export async function detectStructuralFeedbackSignal(payload, {
  maxBytes = 2 * 1024 * 1024,
  maxSignalAgeMs = 15 * 60 * 1000,
  now = () => Date.now()
} = {}) {
  const input = payload || {};
  const resolved = await readDirectAssistantReferent({
    cli: input.cli || "codex",
    payload: input,
    maxBytes,
    maxSignalAgeMs,
    now
  });
  const referent = resolved.referent
    ? {
        id: resolved.referent.eventUid,
        turnId: resolved.referent.turnId,
        timestamp: resolved.referent.timestamp,
        text: resolved.referent.text
      }
    : null;
  if (["active_turn_steering", "prior_turn_interrupted"].includes(resolved.structuralReason)) {
    return {
      immediateReview: true,
      reason: resolved.structuralReason,
      ...(referent ? { referent } : {})
    };
  }
  if (resolved.structuralReason === "stale_interruption") {
    return { immediateReview: false, reason: "stale_interruption" };
  }
  if (resolved.structuralReason === "transcript_unavailable") {
    return { immediateReview: false, reason: "transcript_unavailable" };
  }
  const classified = classifyRetrospectiveEvidence({
    userText: input.prompt || input.text || "",
    hasReferent: Boolean(resolved.referent)
  });
  if (classified.candidate) {
    return {
      immediateReview: true,
      reason: "explicit_retrospective_feedback",
      reasonCodes: classified.reasonCodes,
      referent
    };
  }
  return { immediateReview: false, reason: "none" };
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
  const stableSessionId = String(input.session_id || input.sessionId || "").trim();
  const nativeSessionId = stableSessionId || "unknown";
  const explicitEventId = input.event_id || input.eventId || input.prompt_id || input.promptId || null;
  const nativeTurnId = input.native_turn || input.turn_id || input.turnId || null;
  const stableTurnId = nativeTurnId === null ? "" : String(nativeTurnId).trim();
  const redacted = redactText(input.prompt || input.text || "");
  const transcriptPath = String(input.transcript_path || input.transcriptPath || "");
  const derivedSourceId = `derived:${lengthPrefixedUtf8Sha256([
    cli,
    stableSessionId,
    stableTurnId,
    transcriptPath,
    redacted.contentHash
  ])}`;
  const sourceEventId = String(explicitEventId || derivedSourceId);
  const sequenceSource = input.event_seq || input.eventSeq || input.native_turn || input.turn_id || input.turnId;
  const hashedSequence = Number.parseInt(createHash("sha256").update(sourceEventId).digest("hex").slice(0, 12), 16);
  const eventSeq = Number.isFinite(Number(sequenceSource)) ? Number(sequenceSource) : (hashedSequence || 1);
  const sessionUid = `${cli}:${installationId}:${nativeSessionId}`;
  const eventUid = `${cli}:${installationId}:${nativeSessionId}:${sourceEventId}`;
  const projectId = input.cwd || input.project_id || `unscoped:${cli}:${createHash("sha256").update(nativeSessionId).digest("hex").slice(0, 16)}`;
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
    identity_unstable: !stableSessionId && !stableTurnId,
    timeout,
    timeout_unit: timeoutUnit
  };
}

export function normalizeAssistantReferentEvent({
  cli,
  event,
  referent,
  installationId = "unknown",
  capturePolicyRevision = 1
}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new TypeError("event must be an object");
  }
  if (!referent || typeof referent !== "object" || Array.isArray(referent)) {
    throw new TypeError("referent must be an object");
  }
  const referentText = String(referent.text || "");
  if (!referentText.trim()) throw new TypeError("referent text must be non-empty");
  const referentIdentity = lengthPrefixedUtf8Sha256([
    cli,
    event.session_uid,
    event.context_epoch,
    referent.eventUid,
    referent.turnId,
    referent.timestamp
  ]);
  const redacted = redactText(referentText);
  const sourceEventId = `assistant:${referentIdentity}`;
  return {
    cli,
    installation_id: installationId,
    native_session_id: event.native_session_id,
    session_uid: event.session_uid,
    event_uid: `${event.session_uid}:${sourceEventId}`,
    source_event_id: sourceEventId,
    source_namespace: "transcript_message",
    observation_source_id: sourceEventId,
    parent_event_id: null,
    event_seq: Number.parseInt(referentIdentity.slice(0, 12), 16) || 1,
    native_turn: referent.turnId || null,
    native_turn_id: referent.turnId || null,
    context_epoch: event.context_epoch,
    task_fingerprint: event.task_fingerprint,
    task_type: event.task_type,
    paths: [],
    tools: [],
    project_id: event.project_id,
    cwd: event.cwd,
    role: "assistant",
    referent_event_uid: null,
    redacted_text: redacted.text,
    content_hash: redacted.contentHash,
    redaction_manifest: redacted.manifest,
    capture_policy_revision: capturePolicyRevision,
    data_class: event.data_class || "normal",
    capture_source: "prompt_hook_assistant_referent",
    capture_completeness: "transcript_visible_assistant",
    tool_name: null,
    tool_args: null,
    tool_refs: [],
    textual_output_ref: null,
    file_refs: [],
    artifact_hashes: [],
    source_timestamp: referent.timestamp || null
  };
}

const CAPTURE_FAIL_REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const DEFAULT_CAPTURE_FAIL_REASON = "session_event_write_failed";

function boundedCaptureFailReason(error) {
  if (!(error instanceof ControlStoreError)) return DEFAULT_CAPTURE_FAIL_REASON;
  const code = String(error.code || "").toLowerCase();
  return CAPTURE_FAIL_REASON_PATTERN.test(code) ? code : DEFAULT_CAPTURE_FAIL_REASON;
}

// Best-effort diagnostics: a durability failure here must never mask the
// original error, and must never itself become a new source of failure for
// the (fast, silent) prompt hook path.
function recordCaptureFailOpen({ store, identity, error, now }) {
  try {
    store.recordCaptureFailOpen({
      eventType: "capture_fail_open",
      reasonCode: boundedCaptureFailReason(error),
      sourceProvider: identity?.source_provider ?? null,
      sessionUid: identity?.session_uid ?? null,
      eventUid: identity?.event_uid ?? null,
      createdAt: now().toISOString()
    });
  } catch {
    // Diagnosability is strictly secondary to fail-open safety.
  }
}

async function capturePreparedControlSession({ store, blobs, preparedCapture, rawText, now = () => new Date() }) {
  try {
    const writerRef = await blobs.write(preparedCapture.blobContentHash, rawText);
    if (typeof writerRef !== "string" || !writerRef || writerRef.length > 4096) {
      throw new TypeError("authoritativeEncryptedRef must be a bounded non-empty string");
    }
    if (preparedCapture.suppliedEncryptedRawRef !== null
        && preparedCapture.suppliedEncryptedRawRef !== writerRef) {
      throw new ControlStoreError("control_observation_collision", "control observation collision");
    }
    const resolution = store.resolveOrInsertCapture({
      preparedCapture,
      authoritativeEncryptedRef: writerRef
    });
    await blobs.write(preparedCapture.blobContentHash, rawText);
    return {
      ...resolution,
      event_uid: resolution.eventUid,
      event: resolution.eventView
    };
  } catch (error) {
    // Any capture durability failure — blob write, writer-ref guard, collision,
    // or the store insert — must leave a queryable fail-open reason so a capture
    // miss is never indistinguishable from a detector miss. Recording is
    // best-effort and never masks the original error (see recordCaptureFailOpen).
    recordCaptureFailOpen({ store, identity: preparedCapture.identity, error, now });
    throw error;
  }
}

export async function captureSession({ store, blobs, event, rawText, now = () => new Date() }) {
  const preparedCapture = prepareCapture({ event, rawText });
  return capturePreparedControlSession({ store, blobs, preparedCapture, rawText, now });
}

export async function captureObservedSession({ store, blobs, event, rawText, now = () => new Date() }) {
  const preparedCapture = prepareCapture({ event, rawText });
  return capturePreparedControlSession({ store, blobs, preparedCapture, rawText, now });
}
