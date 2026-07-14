import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { pathsFor } from "../src/index.mjs";
import { captureSession, extractTranscriptExcerpt, normalizeHookEvent, normalizeStopEvent, redactText } from "../src/capture.mjs";
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
