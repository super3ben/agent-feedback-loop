import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { pathsFor } from "../src/index.mjs";
import { captureObservedSession, captureSession, detectStructuralFeedbackSignal, extractTranscriptExcerpt, normalizeHookEvent, normalizeStopEvent, redactText } from "../src/capture.mjs";
import { BlobKeyProvider, EncryptedBlobStore } from "../src/crypto-store.mjs";
import { openStore } from "../src/store.mjs";

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "afl-capture-"));
  const paths = pathsFor(home);
  const store = openStore({ paths });
  const keyProvider = new BlobKeyProvider({ keyRoot: paths.keyRoot });
  const blobs = new EncryptedBlobStore({ root: paths.blobRoot, keyProvider });
  return { paths, store, blobs };
}

test("normalizes CLI events with namespaced IDs and native timeout units", () => {
  const common = { installationId: "install-1", sessionId: "native-1", eventId: "event-1", cwd: "/tmp/project", prompt: "hello" };
  const codex = normalizeHookEvent({ cli: "codex", payload: common });
  const claude = normalizeHookEvent({ cli: "claude", payload: common, timeout: 2, timeoutUnit: "seconds" });
  const gemini = normalizeHookEvent({ cli: "gemini", payload: common, timeout: 2000, timeoutUnit: "milliseconds" });
  assert.notEqual(codex.event_uid, claude.event_uid);
  assert.notEqual(claude.session_uid, gemini.session_uid);
  assert.equal(claude.timeout_unit, "seconds");
  assert.equal(gemini.timeout_unit, "milliseconds");
});

test("redacts secrets while preserving a deterministic content hash", () => {
  const first = redactText("token=sk-test-secret password=hunter2");
  const second = redactText("token=sk-test-secret password=hunter2");
  assert.doesNotMatch(first.text, /sk-test-secret|hunter2/);
  assert.equal(first.contentHash, second.contentHash);
  assert.ok(first.manifest.length >= 2);
});

test("redacts natural-language credential assignments without language-specific values leaking", () => {
  const chinese = redactText("服务器密码是 SyntheticOnly-123+ 请直接连接");
  const english = redactText("The password is SyntheticOnly-456+ for this test");
  assert.doesNotMatch(chinese.text, /SyntheticOnly-123/);
  assert.doesNotMatch(english.text, /SyntheticOnly-456/);
  assert.match(chinese.text, /\[REDACTED\]/);
  assert.match(english.text, /\[REDACTED\]/);
});

test("redacts credential-like values from reminder-style credential context", () => {
  const chinese = redactText("密码之前已经提供，账号 operator SyntheticReminder-731+");
  const english = redactText("The password was already shared for operator SyntheticReminder-842+");
  assert.doesNotMatch(chinese.text, /SyntheticReminder-731/);
  assert.doesNotMatch(english.text, /SyntheticReminder-842/);
  assert.ok(chinese.manifest.some((item) => item.type === "credential_context"));
  assert.ok(english.manifest.some((item) => item.type === "credential_context"));
});

test("detects an immediately preceding interrupted turn without matching prompt wording", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-signal-"));
  const transcript = path.join(home, "rollout.jsonl");
  await writeFile(transcript, [
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "turn-2", reason: "interrupted" } }),
    JSON.stringify({ type: "response_item", payload: { role: "user", content: "neutral text with no feedback keywords" } })
  ].join("\n"), "utf8");

  const signal = await detectStructuralFeedbackSignal({ transcript_path: transcript, turn_id: "turn-3" });
  assert.deepEqual(signal, { immediateReview: true, reason: "prior_turn_interrupted" });
});

test("completed-turn corrective wording stays on deferred review instead of a keyword fast path", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-signal-control-"));
  const transcript = path.join(home, "rollout.jsonl");
  await writeFile(transcript, [
    JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "turn-1", reason: "interrupted" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-2" } })
  ].join("\n"), "utf8");

  const signal = await detectStructuralFeedbackSignal({
    transcript_path: transcript,
    turn_id: "turn-3",
    prompt: "为什么又用了 Termius，之前已经说过应该直接用 SSH"
  });
  assert.deepEqual(signal, { immediateReview: false, reason: "none" });
});

test("does not fast-track a stale interruption after a long idle resume", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-signal-stale-"));
  const transcript = path.join(home, "rollout.jsonl");
  await writeFile(transcript, JSON.stringify({
    timestamp: "2026-07-14T00:00:00.000Z",
    type: "event_msg",
    payload: { type: "turn_aborted", turn_id: "turn-1", reason: "interrupted" }
  }), "utf8");

  const signal = await detectStructuralFeedbackSignal(
    { transcript_path: transcript, turn_id: "turn-2" },
    { now: () => Date.parse("2026-07-14T01:00:00.000Z"), maxSignalAgeMs: 15 * 60 * 1000 }
  );
  assert.deepEqual(signal, { immediateReview: false, reason: "stale_interruption" });
});

test("detects same-turn user steering after assistant output without matching wording", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-signal-steering-"));
  const transcript = path.join(home, "rollout.jsonl");
  await writeFile(transcript, [
    JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-active" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "initial request" }] } }),
    JSON.stringify({ timestamp: "2026-07-14T12:00:10.000Z", type: "response_item", payload: { id: "msg-assistant-active", type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "working" }] } })
  ].join("\n"), "utf8");

  const signal = await detectStructuralFeedbackSignal({ transcript_path: transcript, turn_id: "turn-active" });
  assert.deepEqual(signal, {
    immediateReview: true,
    reason: "active_turn_steering",
    referent: {
      id: "msg-assistant-active",
      turnId: "turn-active",
      timestamp: "2026-07-14T12:00:10.000Z",
      text: "working"
    }
  });
});

test("does not treat a receipt-only assistant transcript message as a steering referent", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-signal-receipt-"));
  const transcript = path.join(home, "rollout.jsonl");
  await writeFile(transcript, [
    JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-active" } }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{
          type: "output_text",
          text: "[AFL] Review completed · severity=Major · lessons=1 · job=7e876e\n<!--afl-receipt id=notification-1234567890 nonce=0123456789abcdef state=review_completed-->"
        }]
      }
    })
  ].join("\n"), "utf8");

  const signal = await detectStructuralFeedbackSignal({ transcript_path: transcript, turn_id: "turn-active" });

  assert.deepEqual(signal, { immediateReview: false, reason: "none" });
});

test("same-turn requirement additions before assistant output stay on the batch path", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-signal-addition-"));
  const transcript = path.join(home, "rollout.jsonl");
  await writeFile(transcript, [
    JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-active" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "initial request" }] } })
  ].join("\n"), "utf8");

  const signal = await detectStructuralFeedbackSignal({ transcript_path: transcript, turn_id: "turn-active" });
  assert.deepEqual(signal, { immediateReview: false, reason: "none" });
});

test("capture stores index data and encrypted raw evidence with restrictive modes", async () => {
  const { paths, store, blobs } = await fixture();
  const event = normalizeHookEvent({
    cli: "codex",
    payload: { installationId: "install-1", sessionId: "s1", eventId: "e1", cwd: "/tmp/project", prompt: "token=sk-live-secret" }
  });
  const result = await captureSession({ store, blobs, event, rawText: "token=sk-live-secret" });
  assert.ok(result.blobPath.endsWith(".enc"));
  const indexed = store.listSessionEvents("/tmp/project")[0];
  assert.doesNotMatch(indexed.redacted_text, /sk-live-secret/);
  assert.equal(indexed.encrypted_raw_ref, result.blobPath);
  assert.match(indexed.redaction_manifest_json, /token/);
  assert.doesNotMatch(await readFile(result.blobPath, "utf8"), /sk-live-secret/);
  assert.equal((await stat(result.blobPath)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.keyRoot)).mode & 0o777, 0o700);
  store.close();
});

test("capture aliases a later transcript observation to a legacy hook without a native turn", async () => {
  const { store, blobs } = await fixture();
  const hookEvent = normalizeHookEvent({
    cli: "codex",
    installationId: "default",
    capturePolicyRevision: store.getCapturePolicy().revision,
    payload: { session_id: "alias-session", cwd: "/tmp/alias-project", prompt: "use direct SSH", timestamp: "2026-07-14T12:00:00.000Z" }
  });
  await captureObservedSession({ store, blobs, event: hookEvent, rawText: "use direct SSH" });

  const transcriptEvent = normalizeHookEvent({
    cli: "codex",
    installationId: "default",
    capturePolicyRevision: store.getCapturePolicy().revision,
    payload: { session_id: "alias-session", turn_id: "turn-1", cwd: "/tmp/alias-project", prompt: "use direct SSH", timestamp: "2026-07-14T12:00:01.000Z" }
  });
  transcriptEvent.event_uid = "codex:default:alias-session:message:transcript-1";
  transcriptEvent.source_event_id = "message:transcript-1";
  transcriptEvent.source_namespace = "transcript_message";
  transcriptEvent.observation_source_id = "transcript-1";
  const captured = await captureObservedSession({ store, blobs, event: transcriptEvent, rawText: "use direct SSH" });

  assert.equal(captured.duplicate, true);
  assert.equal(captured.eventUid, hookEvent.event_uid);
  assert.equal(store.listSessionEvents("/tmp/alias-project").length, 1);
  assert.equal(store.getEventObservation("codex", "transcript_message", "transcript-1").event_uid, hookEvent.event_uid);
  store.close();
});

test("identical hook messages in one native turn remain distinct occurrences", async () => {
  const { store, blobs } = await fixture();
  const input = { session_id: "repeat-session", turn_id: "turn-1", cwd: "/tmp/repeat-project", prompt: "use direct SSH", timestamp: "2026-07-14T12:00:00.000Z" };
  const first = normalizeHookEvent({ cli: "codex", installationId: "default", capturePolicyRevision: store.getCapturePolicy().revision, payload: input });
  const second = normalizeHookEvent({ cli: "codex", installationId: "default", capturePolicyRevision: store.getCapturePolicy().revision, payload: input });

  assert.notEqual(first.event_uid, second.event_uid);
  await captureObservedSession({ store, blobs, event: first, rawText: input.prompt });
  await captureObservedSession({ store, blobs, event: second, rawText: input.prompt });
  assert.equal(store.listSessionEvents(input.cwd).length, 2);
  store.close();
});

test("a hook without a native turn does not alias an older transcript event from another turn", async () => {
  const { store, blobs } = await fixture();
  const transcriptEvent = normalizeHookEvent({
    cli: "codex",
    installationId: "default",
    capturePolicyRevision: store.getCapturePolicy().revision,
    payload: { session_id: "late-session", turn_id: "turn-old", cwd: "/tmp/late-project", prompt: "use direct SSH", timestamp: "2026-07-14T12:00:00.000Z" }
  });
  transcriptEvent.event_uid = "codex:default:late-session:message:old";
  transcriptEvent.source_event_id = "message:old";
  transcriptEvent.source_namespace = "transcript_message";
  transcriptEvent.observation_source_id = "old";
  await captureObservedSession({ store, blobs, event: transcriptEvent, rawText: "use direct SSH" });

  const hookEvent = normalizeHookEvent({
    cli: "codex",
    installationId: "default",
    capturePolicyRevision: store.getCapturePolicy().revision,
    payload: { session_id: "late-session", cwd: "/tmp/late-project", prompt: "use direct SSH", timestamp: "2026-07-14T13:00:00.000Z" }
  });
  const captured = await captureObservedSession({ store, blobs, event: hookEvent, rawText: "use direct SSH" });

  assert.equal(captured.duplicate, false);
  assert.equal(store.listSessionEvents("/tmp/late-project").length, 2);
  store.close();
});

test("different raw secrets that redact identically keep distinct encrypted evidence", async () => {
  const { store, blobs } = await fixture();
  const first = normalizeHookEvent({ cli: "codex", payload: { session_id: "same-session", turn_id: "1", cwd: "/tmp/project", prompt: "token=first-secret" } });
  const second = normalizeHookEvent({ cli: "codex", payload: { session_id: "same-session", turn_id: "2", cwd: "/tmp/project", prompt: "token=second-secret" } });
  assert.equal(first.content_hash, second.content_hash);
  const firstCapture = await captureSession({ store, blobs, event: first, rawText: "token=first-secret" });
  const secondCapture = await captureSession({ store, blobs, event: second, rawText: "token=second-secret" });
  assert.notEqual(firstCapture.blobPath, secondCapture.blobPath);
  assert.equal(await blobs.read(firstCapture.blobPath), "token=first-secret");
  assert.equal(await blobs.read(secondCapture.blobPath), "token=second-secret");
  store.close();
});

test("a duplicate event rejection does not remove encrypted evidence used by the stored event", async () => {
  const { store, blobs } = await fixture();
  const event = normalizeHookEvent({ cli: "codex", payload: { session_id: "duplicate-session", turn_id: "1", cwd: "/tmp/project", prompt: "same raw evidence" } });
  const first = await captureSession({ store, blobs, event, rawText: "same raw evidence" });
  await assert.rejects(() => captureSession({ store, blobs, event: { ...event }, rawText: "same raw evidence" }), /UNIQUE|constraint/i);
  assert.equal(await blobs.read(first.blobPath), "same raw evidence");
  store.close();
});

test("GC preserves a shared blob and prunes only old unreferenced encrypted evidence", async () => {
  const { paths, store, blobs } = await fixture();
  store.close();
  const sharedRaw = "shared raw evidence";
  const first = normalizeHookEvent({ cli: "codex", payload: { session_id: "shared-session", turn_id: "1", cwd: "/tmp/shared", prompt: "first" } });
  first.role = "assistant";
  const second = normalizeHookEvent({ cli: "codex", payload: { session_id: "shared-session", turn_id: "2", cwd: "/tmp/shared", prompt: "second" } });
  second.role = "assistant";
  const oldStore = openStore({ paths, now: () => new Date("2020-01-01T00:00:00.000Z") });
  const firstCapture = await captureSession({ store: oldStore, blobs, event: first, rawText: sharedRaw });
  oldStore.close();
  const currentStore = openStore({ paths });
  const secondCapture = await captureSession({ store: currentStore, blobs, event: second, rawText: sharedRaw });
  assert.equal(firstCapture.blobPath, secondCapture.blobPath);

  const duplicate = { ...second, event_uid: "duplicate-index-event", source_event_id: second.source_event_id, event_seq: 999 };
  const orphanHash = (await import("node:crypto")).createHash("sha256").update("orphan raw evidence").digest("hex");
  await assert.rejects(() => captureSession({ store: currentStore, blobs, event: duplicate, rawText: "orphan raw evidence" }), /UNIQUE|constraint/i);
  assert.equal(await access(path.join(paths.blobRoot, `${orphanHash}.enc`)).then(() => true), true);

  const rows = currentStore.listSessionEvents("/tmp/shared");
  const sharedRef = rows[0].encrypted_raw_ref;
  const zeroRefs = currentStore.gcExpired({ beforeMs: Date.now() - 24 * 60 * 60 * 1000 }).blobRefs;
  assert.deepEqual(zeroRefs, []);
  const removed = await blobs.pruneUnreferenced(currentStore.listEncryptedRawRefs(), { beforeMs: Date.now() + 1 });
  assert.ok(removed.some((file) => file.endsWith(`${orphanHash}.enc`)));
  assert.equal(await blobs.read(sharedRef), sharedRaw);
  currentStore.close();
});

test("capture policy off prevents index and blob writes", async () => {
  const { store, blobs } = await fixture();
  store.setCapturePolicy({ enabled: false, revision: 2 });
  const event = normalizeHookEvent({
    cli: "claude",
    payload: { installationId: "install-1", sessionId: "s2", eventId: "e2", cwd: "/tmp/project", prompt: "do not store" },
    capturePolicyRevision: 2
  });
  await assert.rejects(() => captureSession({ store, blobs, event, rawText: "do not store" }), /disabled|policy/i);
  assert.equal(store.listSessionEvents("/tmp/project").length, 0);
  store.close();
});

test("missing native event IDs are generated without collapsing distinct prompts", () => {
  const first = normalizeHookEvent({ cli: "codex", payload: { installationId: "i", sessionId: "s", prompt: "first" } });
  const second = normalizeHookEvent({ cli: "codex", payload: { installationId: "i", sessionId: "s", prompt: "second" } });
  assert.notEqual(first.event_uid, second.event_uid);
  assert.notEqual(first.source_event_id, "unknown");
});

test("unscoped events remain reviewable and prompt/stop source IDs cannot collide", async () => {
  const { store, blobs } = await fixture();
  const prompt = normalizeHookEvent({ cli: "codex", payload: { session_id: "unscoped-session", event_id: "shared-native-id", prompt: "prior answer was wrong" } });
  const stop = normalizeStopEvent({ cli: "codex", payload: { session_id: "unscoped-session", event_id: "shared-native-id", last_assistant_message: "unsupported answer" } });
  assert.match(prompt.project_id, /^unscoped:codex:/);
  assert.equal(stop.project_id, prompt.project_id);
  assert.notEqual(prompt.source_event_id, stop.source_event_id);
  await captureSession({ store, blobs, event: prompt, rawText: "prior answer was wrong" });
  await captureSession({ store, blobs, event: stop, rawText: "unsupported answer" });
  assert.equal(store.listSessionEvents(prompt.project_id).length, 2);
  assert.equal(store.submitDueReview({ projectId: prompt.project_id, minEntries: 1, cooldownMs: 0 }).status, "pending");
  store.close();
});

test("normalizes stop payloads into assistant evidence with honest completeness", () => {
  const claude = normalizeStopEvent({
    cli: "claude",
    payload: { session_id: "s1", turn_id: "2", cwd: "/tmp/project", last_assistant_message: "Implemented without running tests" },
    installationId: "install-1"
  });
  const gemini = normalizeStopEvent({
    cli: "gemini",
    payload: { session_id: "s2", turn_id: "3", cwd: "/tmp/project", prompt_response: "Done", tool_name: "write_file", file_refs: ["src/a.js"] },
    installationId: "install-1"
  });
  assert.equal(claude.role, "assistant");
  assert.equal(claude.redacted_text, "Implemented without running tests");
  assert.equal(claude.capture_source, "stop_payload");
  assert.equal(claude.capture_completeness, "partial");
  assert.equal(gemini.tool_name, "write_file");
  assert.deepEqual(gemini.file_refs, ["src/a.js"]);
});

test("receipt control stop capture excludes synthetic receipt-only and preserves mixed assistant output", async () => {
  const { store, blobs } = await fixture();
  const projectId = "/tmp/receipt-stop-project";
  const control = [
    "[AFL] Review completed · severity=Major · lessons=1 · job=7e876e",
    "<!--afl-receipt id=notification-1234567890 nonce=0123456789abcdef state=review_completed-->"
  ].join("\n");
  const normalized = normalizeStopEvent({
    cli: "codex",
    installationId: "install-receipt",
    payload: { session_id: "receipt-stop", turn_id: "1", cwd: projectId, last_assistant_message: control }
  });

  assert.equal(normalized.redacted_text, "");
  await captureSession({ store, blobs, event: normalized, rawText: control });
  assert.equal(store.pendingReviewEventCount(projectId), 0);
  assert.equal(store.listSessionEvents(projectId).some((event) => event.redacted_text?.includes("[AFL]")), false);

  const mixed = normalizeStopEvent({
    cli: "codex",
    installationId: "install-receipt",
    payload: {
      session_id: "receipt-stop-mixed",
      turn_id: "2",
      cwd: projectId,
      last_assistant_message: `normal answer\n${control}`
    }
  });
  assert.equal(mixed.redacted_text, "normal answer");
  store.close();
});

test("extracts a bounded redacted assistant excerpt from transcript-only stop evidence", () => {
  const transcript = [
    JSON.stringify({ role: "user", content: "please verify" }),
    JSON.stringify({ role: "assistant", content: "I skipped verification token=secret-value" })
  ].join("\n");
  const excerpt = extractTranscriptExcerpt(transcript, { maxChars: 256 });
  const event = normalizeStopEvent({
    cli: "codex",
    payload: {
      session_id: "transcript-only",
      turn_id: "4",
      cwd: "/tmp/project",
      transcript_path: "/tmp/transcript.jsonl",
      transcript_excerpt: excerpt,
      capture_completeness: "transcript_tail_read"
    }
  });
  assert.match(event.redacted_text, /skipped verification/);
  assert.doesNotMatch(event.redacted_text, /secret-value/);
  assert.doesNotMatch(event.redacted_text, /please verify/);
  assert.ok(event.redacted_text.length <= 256);
  assert.equal(event.capture_completeness, "transcript_tail_read");
});

test("blob store rejects path traversal hashes", async () => {
  const { blobs } = await fixture();
  await assert.rejects(() => blobs.write("../escape", "secret"), /hash/i);
  await assert.rejects(() => blobs.remove("../escape"), /hash/i);
});

test("key and blob stores reject symlink roots and malformed key material", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-crypto-paths-"));
  const outside = await mkdtemp(path.join(tmpdir(), "afl-crypto-outside-"));
  const keyRoot = path.join(home, "keys");
  await symlink(outside, keyRoot);
  await assert.rejects(() => new BlobKeyProvider({ keyRoot }).getKey(), /symlink/i);

  const realKeyRoot = path.join(home, "real-keys");
  await mkdir(realKeyRoot, { recursive: true, mode: 0o700 });
  await writeFile(path.join(realKeyRoot, "data-key.bin"), "short", { mode: 0o600 });
  await assert.rejects(() => new BlobKeyProvider({ keyRoot: realKeyRoot }).getKey(), /32 bytes/i);

  const blobRoot = path.join(home, "blobs");
  await symlink(outside, blobRoot);
  const blobs = new EncryptedBlobStore({ root: blobRoot, keyProvider: new BlobKeyProvider({ keyRoot: path.join(home, "safe-keys") }) });
  await assert.rejects(() => blobs.write("a".repeat(64), "secret"), /symlink/i);
});
