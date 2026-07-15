import assert from "node:assert/strict";
import { appendFile, lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { normalizeHookEvent } from "../src/capture.mjs";
import { EncryptedBlobStore, BlobKeyProvider } from "../src/crypto-store.mjs";
import { pathsFor } from "../src/index.mjs";
import { discoverCodexTranscriptCandidates, reconcileCodexTranscripts } from "../src/codex-reconcile.mjs";
import { renderReceiptControl } from "../src/receipt.mjs";
import { openStore } from "../src/store.mjs";

const RECEIPT_CONTROL = renderReceiptControl({
  notification_id: "1".repeat(64),
  job_id: `7e876e${"2".repeat(58)}`,
  event_uid: null,
  kind: "review_completed",
  payload_json: JSON.stringify({ severity: "Major", lesson_count: 1 }),
  language: "en"
}).text;

function record(timestamp, type, payload) {
  return `${JSON.stringify({ timestamp, type, payload })}\n`;
}

function turnContext(timestamp, turnId, cwd) {
  return record(timestamp, "turn_context", { turn_id: turnId, cwd });
}

function message(timestamp, role, text, id = null, turnId = null) {
  const payload = {
    type: "message",
    internal_chat_message_metadata_passthrough: turnId ? { turn_id: turnId } : undefined,
    role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }]
  };
  if (id !== false) payload.id = id || `msg-${timestamp}-${role}`;
  return record(timestamp, "response_item", payload);
}

function terminal(timestamp, type, turnId) {
  return record(timestamp, "event_msg", { type, turn_id: turnId });
}

async function fixture(name) {
  const home = await mkdtemp(path.join(tmpdir(), `afl-reconcile-${name}-`));
  const paths = pathsFor(home);
  const transcript = path.join(home, "rollout-session-1.jsonl");
  const store = openStore({ paths });
  const blobs = new EncryptedBlobStore({
    root: paths.blobRoot,
    keyProvider: new BlobKeyProvider({ keyRoot: paths.keyRoot })
  });
  const candidate = {
    sessionId: "session-1",
    rolloutPath: transcript,
    cwd: "/tmp/project-a",
    source: "vscode",
    threadSource: "user",
    updatedAtMs: Date.parse("2026-07-14T12:01:00.000Z")
  };
  return { home, paths, transcript, store, blobs, candidate };
}

test("a stale Codex thread reconciles an interrupted-turn correction into one immediate background review", async () => {
  const { transcript, store, blobs, candidate } = await fixture("interrupted");
  await writeFile(transcript, [
    turnContext("2026-07-14T12:00:00.000Z", "turn-1", candidate.cwd),
    message("2026-07-14T12:00:00.010Z", "user", "send a test card"),
    message("2026-07-14T12:00:10.000Z", "assistant", "I will send it to the project group"),
    terminal("2026-07-14T12:00:20.000Z", "turn_aborted", "turn-1"),
    turnContext("2026-07-14T12:00:25.000Z", "turn-2", candidate.cwd),
    message("2026-07-14T12:00:25.010Z", "user", "Do not send it to the group; send it to me directly")
  ].join(""), { mode: 0o600 });

  const launches = [];
  const first = await reconcileCodexTranscripts({
    store,
    blobs,
    candidates: [candidate],
    now: () => Date.parse("2026-07-14T12:00:30.000Z"),
    launchReviewer: async (input) => launches.push(input)
  });

  assert.equal(first.filesScanned, 1);
  assert.equal(first.eventsCaptured, 3);
  assert.equal(first.immediateSignals, 1);
  assert.equal(first.reviewersLaunched, 1);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].cli, "codex");
  assert.equal(store.pendingReviewEventCount(candidate.cwd), 2);
  assert.ok(store.getReviewerJob(launches[0].jobId));

  const events = store.listSessionEvents(candidate.cwd);
  const correction = events.find((event) => event.source_event_id.includes("msg-2026-07-14T12:00:25.010Z-user"));
  assert.match(correction.event_uid, /:message:msg-2026-07-14T12:00:25\.010Z-user$/);
  assert.equal(correction.capture_source, "codex_transcript_reconcile");

  const second = await reconcileCodexTranscripts({
    store,
    blobs,
    candidates: [candidate],
    now: () => Date.parse("2026-07-14T12:00:40.000Z"),
    launchReviewer: async (input) => launches.push(input)
  });
  assert.equal(second.eventsCaptured, 0);
  assert.equal(second.reviewersLaunched, 0);
  assert.equal(launches.length, 1);
  assert.equal(store.listSessionEvents(candidate.cwd).length, 3);
  assert.equal(store.getTranscriptCursor("codex", transcript).offset, (await stat(transcript)).size);
  store.close();
});

test("reconciliation reuses a hook-captured event id but still supplies a missed immediate signal", async () => {
  const { transcript, store, blobs, candidate } = await fixture("dedupe");
  await writeFile(transcript, [
    turnContext("2026-07-14T12:00:00.000Z", "turn-1", candidate.cwd),
    message("2026-07-14T12:00:00.010Z", "user", "connect to the host"),
    message("2026-07-14T12:00:10.000Z", "assistant", "I will use a saved terminal session"),
    terminal("2026-07-14T12:00:20.000Z", "turn_aborted", "turn-1"),
    turnContext("2026-07-14T12:00:25.000Z", "turn-2", candidate.cwd),
    message("2026-07-14T12:00:25.010Z", "user", "Why not use direct SSH?")
  ].join(""), { mode: 0o600 });

  const hookEvent = normalizeHookEvent({
    cli: "codex",
    installationId: "default",
    capturePolicyRevision: store.getCapturePolicy().revision,
    payload: { session_id: "session-1", turn_id: "turn-2", cwd: candidate.cwd, prompt: "Why not use direct SSH?" }
  });
  store.captureSessionEvent(hookEvent);

  const launches = [];
  const result = await reconcileCodexTranscripts({
    store,
    blobs,
    candidates: [candidate],
    now: () => Date.parse("2026-07-14T12:00:30.000Z"),
    launchReviewer: async (input) => launches.push(input)
  });

  assert.equal(result.duplicateEvents, 1);
  assert.equal(result.immediateSignals, 1);
  assert.equal(result.reviewersLaunched, 1);
  assert.equal(store.listSessionEvents(candidate.cwd).filter((event) => event.event_uid === hookEvent.event_uid).length, 1);
  const context = store.getReviewerContext(launches[0].jobId);
  const assistantIndex = context.events.findIndex((event) => event.role === "assistant");
  const correctionIndex = context.events.findIndex((event) => event.event_uid === hookEvent.event_uid);
  assert.ok(assistantIndex >= 0 && assistantIndex < correctionIndex, "reconciled historical evidence must keep source chronology even when inserted after the hook event");
  store.close();
});

test("a second real user message in one active turn is preserved and triggers immediate steering review", async () => {
  const { transcript, store, blobs, candidate } = await fixture("same-turn-steering");
  await writeFile(transcript, [
    turnContext("2026-07-14T12:00:00.000Z", "turn-1", candidate.cwd),
    message("2026-07-14T12:00:00.010Z", "user", "send a test card", "msg-user-1", "turn-1"),
    message("2026-07-14T12:00:10.000Z", "assistant", "I will send it to the group", "msg-assistant-1", "turn-1"),
    message("2026-07-14T12:00:15.000Z", "user", "send it only to me", "msg-user-2", "turn-1")
  ].join(""), { mode: 0o600 });

  const launches = [];
  const result = await reconcileCodexTranscripts({
    store,
    blobs,
    candidates: [candidate],
    now: () => Date.parse("2026-07-14T12:00:20.000Z"),
    launchReviewer: async (input) => launches.push(input)
  });

  assert.equal(result.eventsCaptured, 3);
  assert.equal(result.immediateSignals, 1);
  assert.equal(result.reviewersLaunched, 1);
  const userEvents = store.listSessionEvents(candidate.cwd).filter((event) => event.role === "user");
  assert.equal(userEvents.length, 2);
  assert.deepEqual(userEvents.map((event) => event.native_turn_id), ["turn-1", "turn-1"]);
  assert.ok(userEvents.some((event) => event.source_event_id === "message:msg-user-2"));
  store.close();
});

test("multiple steering corrections in one scan coalesce into one reviewer job", async () => {
  const { transcript, store, blobs, candidate } = await fixture("same-scan-coalesce");
  await writeFile(transcript, [
    turnContext("2026-07-14T12:00:00.000Z", "turn-1", candidate.cwd),
    message("2026-07-14T12:00:00.010Z", "user", "deploy the test card", "msg-user-1", "turn-1"),
    message("2026-07-14T12:00:05.000Z", "assistant", "sending it to the group", "msg-assistant-1", "turn-1"),
    message("2026-07-14T12:00:10.000Z", "user", "send it only to me", "msg-user-2", "turn-1"),
    message("2026-07-14T12:00:15.000Z", "assistant", "I need the password", "msg-assistant-2", "turn-1"),
    message("2026-07-14T12:00:20.000Z", "user", "use the credential already provided", "msg-user-3", "turn-1")
  ].join(""), { mode: 0o600 });

  const launches = [];
  const result = await reconcileCodexTranscripts({
    store,
    blobs,
    candidates: [candidate],
    now: () => Date.parse("2026-07-14T12:00:30.000Z"),
    launchReviewer: async (input) => launches.push(input)
  });

  assert.equal(result.immediateSignals, 2);
  assert.equal(result.reviewersLaunched, 1);
  assert.equal(launches.length, 1);
  assert.equal(store.getReviewerContext(launches[0].jobId).events.filter((event) => event.queued_for_review).length, 3);
  store.close();
});

test("identical same-turn steering messages remain distinct after one transcript observation matches a hook event", async () => {
  const { transcript, store, blobs, candidate } = await fixture("same-turn-identical");
  await writeFile(transcript, [
    turnContext("2026-07-14T12:00:00.000Z", "turn-1", candidate.cwd),
    message("2026-07-14T12:00:00.010Z", "user", "use direct SSH", "msg-identical-1", "turn-1"),
    message("2026-07-14T12:00:10.000Z", "assistant", "checking", "msg-assistant-identical", "turn-1"),
    message("2026-07-14T12:00:15.000Z", "user", "use direct SSH", "msg-identical-2", "turn-1")
  ].join(""), { mode: 0o600 });
  const hookEvent = normalizeHookEvent({
    cli: "codex",
    installationId: "default",
    capturePolicyRevision: store.getCapturePolicy().revision,
    payload: { session_id: "session-1", turn_id: "turn-1", cwd: candidate.cwd, prompt: "use direct SSH", timestamp: "2026-07-14T12:00:00.010Z" }
  });
  store.captureSessionEvent(hookEvent);

  const result = await reconcileCodexTranscripts({
    store,
    blobs,
    candidates: [candidate],
    now: () => Date.parse("2026-07-14T12:00:20.000Z"),
    launchReviewer: async () => {}
  });

  assert.equal(result.duplicateEvents, 1);
  assert.equal(result.eventsCaptured, 2);
  const userEvents = store.listSessionEvents(candidate.cwd).filter((event) => event.role === "user");
  assert.equal(userEvents.length, 2);
  assert.equal(store.getEventObservation("codex", "transcript_message", "msg-identical-1").event_uid, hookEvent.event_uid);
  assert.notEqual(store.getEventObservation("codex", "transcript_message", "msg-identical-2").event_uid, hookEvent.event_uid);
  store.close();
});

test("messages without a native id use stable byte offsets and do not collapse", async () => {
  const { transcript, store, blobs, candidate } = await fixture("offset-identity");
  await writeFile(transcript, [
    turnContext("2026-07-14T12:00:00.000Z", "turn-offset", candidate.cwd),
    message("2026-07-14T12:00:00.010Z", "user", "same text", false, "turn-offset"),
    message("2026-07-14T12:00:05.000Z", "assistant", "first answer", false, "turn-offset"),
    message("2026-07-14T12:00:10.000Z", "user", "same text", false, "turn-offset")
  ].join(""), { mode: 0o600 });

  const result = await reconcileCodexTranscripts({ store, blobs, candidates: [candidate], launchReviewer: async () => ({ launched: false }) });
  assert.equal(result.eventsCaptured, 3);
  const users = store.listSessionEvents(candidate.cwd).filter((event) => event.role === "user");
  assert.equal(users.length, 2);
  assert.equal(new Set(users.map((event) => event.event_uid)).size, 2);
  assert.equal(users.every((event) => event.source_event_id.startsWith("message:offset:")), true);
  store.close();
});

test("an additive user message before any assistant output is captured without claiming feedback", async () => {
  const { transcript, store, blobs, candidate } = await fixture("same-turn-additive");
  await writeFile(transcript, [
    turnContext("2026-07-14T12:00:00.000Z", "turn-add", candidate.cwd),
    message("2026-07-14T12:00:00.010Z", "user", "check the deployment", "msg-add-1", "turn-add"),
    message("2026-07-14T12:00:01.000Z", "user", "also include the logs", "msg-add-2", "turn-add")
  ].join(""), { mode: 0o600 });

  const result = await reconcileCodexTranscripts({ store, blobs, candidates: [candidate], reviewMinEntries: 99, launchReviewer: async () => assert.fail("must not launch") });
  assert.equal(result.eventsCaptured, 2);
  assert.equal(result.immediateSignals, 0);
  assert.equal(result.reviewersLaunched, 0);
  store.close();
});

test("a bounded Codex compaction history recovers user messages that have no response_item rows", async () => {
  const { transcript, store, blobs, candidate } = await fixture("compaction-history");
  const history = [
    {
      type: "message",
      id: "msg_019f6068-e637-7481-a878-fb80f69fd4e2",
      role: "user",
      content: [{ type: "input_text", text: "Why did the previous method ignore the direct path?" }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn-c1" }
    },
    {
      type: "message",
      id: "msg_019f606a-6e6b-7231-982b-499fa98e6a47",
      role: "user",
      content: [{ type: "input_text", text: "I already supplied the required connection detail." }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn-c2" }
    },
    {
      type: "message",
      id: "msg_019f6093-0f9f-7c93-bf5c-69d80526abde",
      role: "user",
      content: [{ type: "input_text", text: "Do not send the preview to the project group." }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn-c3" }
    },
    {
      type: "message",
      id: "msg-control",
      role: "user",
      content: [{ type: "input_text", text: "<environment_context>machine context</environment_context>" }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn-control" }
    },
    {
      type: "message",
      id: "msg-developer-padding",
      role: "developer",
      content: [{ type: "input_text", text: "x".repeat(2_048) }]
    }
  ];
  const compacted = record("2026-07-14T13:57:55.368Z", "compacted", { replacement_history: history, window_number: 22 });
  await writeFile(transcript, compacted, { mode: 0o600 });
  const launches = [];

  const result = await reconcileCodexTranscripts({
    store,
    blobs,
    candidates: [candidate],
    maxLineBytes: 256,
    maxCompactionLineBytes: 8 * 1024,
    reviewMinEntries: 3,
    reviewCooldownMs: 0,
    launchReviewer: async (request) => { launches.push(request); return { launched: true }; }
  });

  assert.equal(result.oversizedLinesSkipped, 0);
  assert.equal(result.eventsCaptured, 3);
  assert.equal(result.reviewersLaunched, 1);
  assert.equal(launches.length, 1);
  const users = store.listSessionEvents(candidate.cwd).filter((event) => event.role === "user");
  assert.equal(users.length, 3);
  assert.equal(users.every((event) => event.capture_source === "codex_compaction_reconcile"), true);
  assert.equal(users.every((event) => event.capture_completeness === "compaction_history_user"), true);
  store.close();
});

test("control records are not misclassified as user feedback", async () => {
  const { transcript, store, blobs, candidate } = await fixture("control-records");
  await writeFile(transcript, [
    turnContext("2026-07-14T12:00:00.000Z", "turn-control", candidate.cwd),
    message("2026-07-14T12:00:00.010Z", "user", "<subagent_notification>done</subagent_notification>", "msg-control", "turn-control"),
    message("2026-07-14T12:00:01.000Z", "user", "real request", "msg-real", "turn-control")
  ].join(""), { mode: 0o600 });

  await reconcileCodexTranscripts({ store, blobs, candidates: [candidate], reviewMinEntries: 99 });
  const users = store.listSessionEvents(candidate.cwd).filter((event) => event.role === "user");
  assert.deepEqual(users.map((event) => event.redacted_text), ["real request"]);
  store.close();
});

test("receipt control transcript capture skips synthetic output and preserves mixed semantic output", async () => {
  const { transcript, store, blobs, candidate } = await fixture("receipt-control");
  const control = RECEIPT_CONTROL;
  await writeFile(transcript, [
    turnContext("2026-07-14T12:00:00.000Z", "turn-receipt", candidate.cwd),
    message("2026-07-14T12:00:01.000Z", "assistant", control, "msg-receipt-only", "turn-receipt"),
    message("2026-07-14T12:00:02.000Z", "assistant", `normal answer\n${control}`, "msg-receipt-mixed", "turn-receipt")
  ].join(""), { mode: 0o600 });

  const result = await reconcileCodexTranscripts({
    store,
    blobs,
    candidates: [candidate],
    reviewMinEntries: 99,
    launchReviewer: async () => assert.fail("receipt controls must not start a reviewer")
  });

  assert.equal(result.eventsCaptured, 1);
  assert.equal(store.pendingReviewEventCount(candidate.cwd), 0);
  assert.equal(store.listSessionEvents(candidate.cwd).some((event) => event.redacted_text?.includes("[AFL]")), false);
  assert.deepEqual(
    store.listSessionEvents(candidate.cwd).filter((event) => event.role === "assistant").map((event) => event.redacted_text),
    ["normal answer"]
  );
  assert.equal(store.getTranscriptCursor("codex", transcript).offset, (await stat(transcript)).size);
  store.close();
});

test("receipt-only Codex text with structural references is captured and advances the cursor", async () => {
  const { transcript, store, blobs, candidate } = await fixture("receipt-structural");
  const payload = {
    id: "msg_019f1234-5678-7abc-8def-0123456789ab",
    type: "message",
    role: "assistant",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-receipt-structural" },
    content: [{ type: "output_text", text: RECEIPT_CONTROL }],
    tool_refs: ["apply_patch"],
    file_refs: ["src/receipt.mjs"],
    artifact_hashes: ["sha256:abc123"]
  };
  await writeFile(transcript, [
    turnContext("2026-07-14T12:00:00.000Z", "turn-receipt-structural", candidate.cwd),
    record("2026-07-14T12:00:01.000Z", "response_item", payload)
  ].join(""), { mode: 0o600 });

  const result = await reconcileCodexTranscripts({
    store,
    blobs,
    candidates: [candidate],
    reviewMinEntries: 99,
    launchReviewer: async () => assert.fail("assistant structural evidence must not launch a reviewer")
  });

  assert.equal(result.eventsCaptured, 1);
  const [event] = store.listSessionEvents(candidate.cwd);
  assert.equal(event.redacted_text, "");
  assert.equal(event.tool_name, "apply_patch");
  assert.deepEqual(JSON.parse(event.file_refs_json), ["src/receipt.mjs"]);
  assert.deepEqual(JSON.parse(event.artifact_hashes_json), ["sha256:abc123"]);
  assert.equal(store.getTranscriptCursor("codex", transcript).offset, (await stat(transcript)).size);
  store.close();
});

test("empty Codex message content with structural references is captured and advances the cursor", async () => {
  const { transcript, store, blobs, candidate } = await fixture("empty-content-structural");
  const payload = {
    id: "msg_019f2234-5678-7abc-8def-0123456789ab",
    type: "message",
    role: "assistant",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-empty-content-structural" },
    content: [],
    tool_refs: ["exec_command"],
    textual_output_refs: ["command-output:42"],
    file_refs: ["src/codex-reconcile.mjs"],
    artifact_hashes: ["sha256:def456"]
  };
  await writeFile(transcript, [
    turnContext("2026-07-14T12:00:00.000Z", "turn-empty-content-structural", candidate.cwd),
    record("2026-07-14T12:00:01.000Z", "response_item", payload)
  ].join(""), { mode: 0o600 });

  const result = await reconcileCodexTranscripts({
    store,
    blobs,
    candidates: [candidate],
    reviewMinEntries: 99,
    launchReviewer: async () => assert.fail("assistant structural evidence must not launch a reviewer")
  });

  assert.equal(result.eventsCaptured, 1);
  const [event] = store.listSessionEvents(candidate.cwd);
  assert.equal(event.redacted_text, "");
  assert.equal(event.tool_name, "exec_command");
  assert.equal(event.textual_output_ref, "command-output:42");
  assert.deepEqual(JSON.parse(event.file_refs_json), ["src/codex-reconcile.mjs"]);
  assert.deepEqual(JSON.parse(event.artifact_hashes_json), ["sha256:def456"]);
  assert.equal(store.getTranscriptCursor("codex", transcript).offset, (await stat(transcript)).size);
  store.close();
});

test("disabled capture skips transcript IO and oversized records produce an explicit coverage gap", async () => {
  const disabled = await fixture("disabled-before-read");
  disabled.store.setCapturePolicy({ enabled: false, revision: 2 });
  const skipped = await reconcileCodexTranscripts({ store: disabled.store, blobs: disabled.blobs, candidates: [{ ...disabled.candidate, rolloutPath: path.join(disabled.home, "does-not-exist.jsonl") }] });
  assert.equal(skipped.filesSkipped, 1);
  assert.equal(skipped.errors.length, 0);
  disabled.store.close();

  const oversized = await fixture("oversized-gap");
  await writeFile(oversized.transcript, `${"x".repeat(256)}\n`, { mode: 0o600 });
  const result = await reconcileCodexTranscripts({ store: oversized.store, blobs: oversized.blobs, candidates: [oversized.candidate], maxLineBytes: 64 });
  assert.equal(result.oversizedLinesSkipped, 1);
  assert.deepEqual(result.coverageGaps.map((gap) => gap.kind), ["oversized_jsonl_record"]);
  oversized.store.close();
});

test("an oversized record larger than one scan window cannot permanently pin the cursor", async () => {
  const { transcript, store, blobs, candidate } = await fixture("oversized-progress");
  const valid = [
    turnContext("2026-07-14T12:00:00.000Z", "turn-after-oversized", candidate.cwd),
    message("2026-07-14T12:00:00.010Z", "user", "capture me after the oversized record", "msg-after-oversized", "turn-after-oversized")
  ].join("");
  await writeFile(transcript, `${"x".repeat(1_024)}\n${valid}`, { mode: 0o600 });

  const first = await reconcileCodexTranscripts({
    store,
    blobs,
    candidates: [candidate],
    maxLineBytes: 400,
    maxScanBytes: 512,
    reviewMinEntries: 99
  });
  const firstCursor = store.getTranscriptCursor("codex", transcript);
  assert.equal(first.oversizedLinesSkipped, 1);
  assert.ok(Number(firstCursor.offset) > 0, "the cursor must advance while discarding an oversized record");

  for (let attempt = 0; attempt < 8 && store.listSessionEvents(candidate.cwd).length === 0; attempt += 1) {
    await reconcileCodexTranscripts({
      store,
      blobs,
      candidates: [candidate],
      maxLineBytes: 400,
      maxScanBytes: 512,
      reviewMinEntries: 99
    });
  }

  assert.equal(store.listSessionEvents(candidate.cwd).some((event) => event.source_event_id === "message:msg-after-oversized"), true);
  assert.equal(store.getTranscriptCursor("codex", transcript).offset, (await stat(transcript)).size);
  store.close();
});

test("a retryable reviewer failure is relaunched by reconciliation even when no transcript changed", async () => {
  const { store, blobs, candidate } = await fixture("reviewer-recovery");
  const event = normalizeHookEvent({
    cli: "codex",
    installationId: "default",
    capturePolicyRevision: store.getCapturePolicy().revision,
    payload: { session_id: "recovery-session", turn_id: "turn-1", cwd: candidate.cwd, prompt: "review this correction" }
  });
  store.captureSessionEvent(event);
  const due = store.submitDueReview({ projectId: candidate.cwd, minEntries: 1, cooldownMs: 0 });
  const wakeAt = Date.now();
  store.claimReviewerWake({ jobId: due.job_id, nowMs: wakeAt, cooldownMs: 1_000 });
  const lease = store.claimReviewerJob(due.job_id, "failed-worker", Date.now() + 30_000, 1);
  store.failReviewerJob(due.job_id, "failed-worker", 1, lease.lease_epoch, true, "provider_failed");

  const launches = [];
  const result = await reconcileCodexTranscripts({
    store,
    blobs,
    candidates: [],
    now: () => wakeAt + 1_001,
    wakeCooldownMs: 1_000,
    launchReviewer: async (input) => launches.push(input)
  });

  assert.equal(result.recoveredReviewers, 1);
  assert.equal(result.reviewersLaunched, 1);
  assert.equal(launches[0].jobId, due.job_id);
  assert.equal(launches[0].recovery, true);
  store.close();
});

test("an expired running reviewer lease is requeued and relaunched", async () => {
  const { store, blobs, candidate } = await fixture("expired-reviewer-recovery");
  const event = normalizeHookEvent({
    cli: "codex",
    installationId: "default",
    capturePolicyRevision: store.getCapturePolicy().revision,
    payload: { session_id: "expired-session", turn_id: "turn-1", cwd: candidate.cwd, prompt: "recover the abandoned review" }
  });
  store.captureSessionEvent(event);
  const due = store.submitDueReview({ projectId: candidate.cwd, minEntries: 1, cooldownMs: 0 });
  const nowMs = Date.now();
  store.claimReviewerWake({ jobId: due.job_id, nowMs: nowMs - 2_000, cooldownMs: 1_000 });
  store.claimReviewerJob(due.job_id, "abandoned-worker", nowMs - 1, 1);

  const launches = [];
  const result = await reconcileCodexTranscripts({
    store,
    blobs,
    candidates: [],
    now: () => nowMs,
    wakeCooldownMs: 1_000,
    launchReviewer: async (input) => launches.push(input)
  });

  assert.equal(result.recoveredReviewers, 1);
  assert.equal(launches[0].recoveryReason, "expired_lease");
  assert.equal(store.getReviewerJob(due.job_id).status, "pending");
  store.close();
});

test("an exhausted reviewer job fails visibly instead of retrying forever", async () => {
  const { store, blobs, candidate } = await fixture("reviewer-exhausted");
  const event = normalizeHookEvent({
    cli: "codex",
    installationId: "default",
    capturePolicyRevision: store.getCapturePolicy().revision,
    payload: { session_id: "exhausted-session", turn_id: "turn-1", cwd: candidate.cwd, prompt: "do not retry forever" }
  });
  store.captureSessionEvent(event);
  const due = store.submitDueReview({ projectId: candidate.cwd, minEntries: 1, cooldownMs: 0, immediateEventUid: event.event_uid });
  const nowMs = Date.now();
  store.claimReviewerWake({ jobId: due.job_id, nowMs: nowMs - 2_000, cooldownMs: 1_000 });
  store.claimReviewerJob(due.job_id, "last-worker", nowMs - 1, 3);

  const result = await reconcileCodexTranscripts({
    store,
    blobs,
    candidates: [],
    now: () => nowMs,
    reviewMaxAttempts: 3,
    launchReviewer: async () => assert.fail("an exhausted job must not launch")
  });

  assert.equal(result.exhaustedReviewerJobs, 1);
  assert.deepEqual(result.notificationRefs.map((row) => row.kind), ["review_exhausted"]);
  assert.equal(result.recoveredReviewers, 0);
  assert.equal(store.getReviewerJob(due.job_id).status, "failed");
  assert.equal(store.getReviewerJob(due.job_id).reason_code, "retry_exhausted");
  store.close();
});

test("a completed prior turn followed by a new request is captured without an immediate review", async () => {
  const { transcript, store, blobs, candidate } = await fixture("normal");
  await writeFile(transcript, [
    turnContext("2026-07-14T12:00:00.000Z", "turn-1", candidate.cwd),
    message("2026-07-14T12:00:00.010Z", "user", "summarize the file"),
    message("2026-07-14T12:00:10.000Z", "assistant", "summary complete"),
    terminal("2026-07-14T12:00:20.000Z", "task_complete", "turn-1"),
    turnContext("2026-07-14T12:00:25.000Z", "turn-2", candidate.cwd),
    message("2026-07-14T12:00:25.010Z", "user", "now update the README")
  ].join(""), { mode: 0o600 });

  const launches = [];
  const result = await reconcileCodexTranscripts({
    store,
    blobs,
    candidates: [candidate],
    reviewMinEntries: 99,
    now: () => Date.parse("2026-07-14T12:00:30.000Z"),
    launchReviewer: async (input) => launches.push(input)
  });

  assert.equal(result.eventsCaptured, 3);
  assert.equal(result.immediateSignals, 0);
  assert.equal(result.reviewersLaunched, 0);
  assert.equal(launches.length, 0);
  store.close();
});

test("cursor state never persists transcript text from an in-progress turn", async () => {
  const { transcript, store, blobs, candidate } = await fixture("secret");
  const syntheticSecret = "SyntheticPass-842+";
  await writeFile(transcript, [
    turnContext("2026-07-14T12:00:00.000Z", "turn-1", candidate.cwd),
    message("2026-07-14T12:00:00.010Z", "user", `the password was already shared: ${syntheticSecret}`),
    message("2026-07-14T12:00:10.000Z", "assistant", `I remember ${syntheticSecret}`)
  ].join(""), { mode: 0o600 });

  await reconcileCodexTranscripts({
    store,
    blobs,
    candidates: [candidate],
    reviewMinEntries: 99,
    now: () => Date.parse("2026-07-14T12:00:30.000Z"),
    launchReviewer: async () => assert.fail("normal in-progress turn must not launch a reviewer")
  });

  const cursor = store.getTranscriptCursor("codex", transcript);
  assert.doesNotMatch(cursor.state_json, new RegExp(syntheticSecret.replace(/[+]/g, "\\+")));
  assert.equal(Object.hasOwn(JSON.parse(cursor.state_json), "assistantTail"), false);
  const events = store.listSessionEvents(candidate.cwd);
  assert.equal(events.length, 2);
  assert.equal(events.some((event) => event.role === "assistant"), true);
  assert.equal(events.every((event) => !new RegExp(syntheticSecret.replace(/[+]/g, "\\+")).test(event.redacted_text)), true);
  assert.equal((await lstat(transcript)).isSymbolicLink(), false);
  store.close();
});

test("candidate discovery reads only recently active root Codex transcripts under the owned sessions root", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-discovery-"));
  const codexRoot = path.join(home, ".codex");
  const sessionsRoot = path.join(codexRoot, "sessions", "2026", "07", "14");
  await mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
  const rootTranscript = path.join(sessionsRoot, "rollout-root-session.jsonl");
  const subagentTranscript = path.join(sessionsRoot, "rollout-subagent-session.jsonl");
  const staleTranscript = path.join(sessionsRoot, "rollout-stale-session.jsonl");
  await writeFile(rootTranscript, "", { mode: 0o600 });
  await writeFile(subagentTranscript, "", { mode: 0o600 });
  await writeFile(staleTranscript, "new transcript bytes\n", { mode: 0o600 });
  const stateFile = path.join(codexRoot, "state_5.sqlite");
  const db = new DatabaseSync(stateFile);
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    rollout_path TEXT NOT NULL,
    updated_at_ms INTEGER,
    source TEXT,
    thread_source TEXT,
    cwd TEXT,
    cli_version TEXT
  )`);
  const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)");
  const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
  insert.run("root-session", rootTranscript, nowMs - 1_000, "vscode", "user", "/tmp/root", "0.142.5");
  insert.run("subagent-session", subagentTranscript, nowMs - 1_000, "subagent", "subagent", "/tmp/root", "0.142.5");
  insert.run("stale-session", staleTranscript, nowMs - 3_600_000, "vscode", "user", "/tmp/stale", "0.142.5");
  insert.run("outside-session", path.join(home, "outside.jsonl"), nowMs - 1_000, "vscode", "user", "/tmp/outside", "0.142.5");
  db.close();

  const candidates = await discoverCodexTranscriptCandidates({ home, nowMs, lookbackMs: 60_000 });

  assert.deepEqual(candidates.map((candidate) => candidate.sessionId), ["root-session"]);
  assert.equal(candidates[0].rolloutPath, rootTranscript);
  assert.equal(candidates[0].cwd, "/tmp/root");
  assert.equal(candidates[0].cliVersion, "0.142.5");

  const lagged = await discoverCodexTranscriptCandidates({
    home,
    nowMs,
    lookbackMs: 60_000,
    trackedCursors: [{ transcript_path: staleTranscript, offset: 0 }]
  });
  assert.deepEqual(lagged.map((candidate) => candidate.sessionId), ["stale-session", "root-session"]);

  const caughtUp = await discoverCodexTranscriptCandidates({
    home,
    nowMs,
    lookbackMs: 60_000,
    trackedCursors: [{ transcript_path: staleTranscript, offset: (await stat(staleTranscript)).size }]
  });
  assert.deepEqual(caughtUp.map((candidate) => candidate.sessionId), ["root-session"]);
});

test("reconciliation rejects symlink transcript candidates", async () => {
  const { home, transcript, store, blobs, candidate } = await fixture("symlink");
  const target = path.join(home, "real-transcript.jsonl");
  await writeFile(target, turnContext("2026-07-14T12:00:00.000Z", "turn-1", candidate.cwd), { mode: 0o600 });
  await symlink(target, transcript);

  const result = await reconcileCodexTranscripts({ store, blobs, candidates: [candidate] });

  assert.equal(result.filesScanned, 0);
  assert.equal(result.filesSkipped, 1);
  assert.equal(store.listSessionEvents(candidate.cwd).length, 0);
  store.close();
});
