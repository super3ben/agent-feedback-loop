import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { pathsFor } from "../src/index.mjs";
import { captureObservedSession, detectStructuralFeedbackSignal, extractTranscriptExcerpt, normalizeHookEvent, redactText } from "../src/capture.mjs";
import { initializeControlStore } from "../src/control-store.mjs";
import { BlobKeyProvider, EncryptedBlobStore } from "../src/crypto-store.mjs";
import { classifyRetrospectiveEvidence, detectFeedbackCandidate, feedbackSourceIdentity, readDirectAssistantReferent, stripSyntheticAflControlText } from "../src/feedback-signal.mjs";

test("capture runtime has no dormant Stop normalization path", async () => {
  const captureSource = await readFile(new URL("../src/capture.mjs", import.meta.url), "utf8");
  const forbidden = ["normalize" + "StopEvent", "stop_" + "payload", "stop_" + "hook"];
  for (const identifier of forbidden) assert.ok(!captureSource.includes(identifier), `${identifier} must not remain in capture runtime`);
});

function syntheticControl() {
  return syntheticControlFor({
    state: "candidate_captured",
    visibleLine: "[AFL] Feedback candidate captured · event=abcdef · receipt=111111"
  });
}

function syntheticControlFor({ state, visibleLine }) {
  const id = "1".repeat(64);
  const nonce = createHash("sha256")
    .update(`receipt-control:v2\u0000${id}\u0000${state}\u0000${visibleLine}`)
    .digest("hex")
    .slice(0, 16);
  const marker = `<!--afl-receipt id=${id} nonce=${nonce} state=${state}-->`;
  return `${visibleLine}\n${marker}`;
}

test("synthetic control stripping no longer needs receipt transport", () => {
  const control = syntheticControl();
  const [line, marker] = control.split("\n");

  assert.deepEqual(stripSyntheticAflControlText(control), { text: "", syntheticOnly: true });
  assert.deepEqual(stripSyntheticAflControlText(`business answer\n${control}`), { text: "business answer", syntheticOnly: false });
  for (const preserved of [
    `> ${control.replace("\n", "\n> ")}`,
    `\`\`\`text\n${control}\n\`\`\``,
    `${line.replace("receipt=111111", "receipt=222222")}\n${marker}`,
    `${line.replace("Feedback candidate captured", "Feedback candidate captured for business")}\n${marker}`
  ]) {
    assert.deepEqual(stripSyntheticAflControlText(preserved), { text: preserved, syntheticOnly: false });
  }
  assert.deepEqual(
    stripSyntheticAflControlText(`business answer\n${control}\nmore business text`),
    { text: "business answer\nmore business text", syntheticOnly: false }
  );
});

test("synthetic control stripping recognizes every canonical state in English and Chinese", () => {
  const visibleLines = [
    ["candidate_captured", "[AFL] Feedback candidate captured · event=abcdef · receipt=111111", "[AFL] 已捕获反馈候选 · event=abcdef · receipt=111111"],
    ["review_queued", "[AFL] Background review queued · job=abcdef · receipt=111111", "[AFL] 后台反思已排队 · job=abcdef · receipt=111111"],
    ["review_completed", "[AFL] Review completed · severity=Minor · lessons=2 · job=abcdef · receipt=111111", "[AFL] 反思完成 · severity=Minor · lessons=2 · job=abcdef · receipt=111111"],
    ["reviewed_no_lesson", "[AFL] Reviewed; no long-term lesson was created · job=abcdef · receipt=111111", "[AFL] 已复核，本次未形成长期经验 · job=abcdef · receipt=111111"],
    ["review_exhausted", "[AFL] Review failed; evidence retained for retry · job=abcdef · receipt=111111", "[AFL] 反思失败，证据已保留并等待重试 · job=abcdef · receipt=111111"],
    ["lesson_delivered", "[AFL] Delivered 2 prior lessons to this task · receipt=111111", "[AFL] 已向本任务投递 2 条历史经验 · receipt=111111"]
  ];

  for (const [state, ...translations] of visibleLines) {
    for (const visibleLine of translations) {
      const control = syntheticControlFor({ state, visibleLine });
      assert.deepEqual(stripSyntheticAflControlText(control), { text: "", syntheticOnly: true }, `${state}: ${visibleLine}`);
    }
  }
});

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "afl-capture-"));
  const paths = pathsFor(home);
  const keyProvider = new BlobKeyProvider({ keyRoot: paths.keyRoot });
  const blobs = new EncryptedBlobStore({ root: paths.blobRoot, keyProvider });
  return { paths, blobs };
}

async function controlCaptureFixture() {
  const { paths, blobs } = await fixture();
  return { paths, blobs, store: initializeControlStore({ paths }) };
}

function captureEvent(overrides = {}) {
  return {
    event_uid: "fail-open-event-1",
    session_uid: "fail-open-session-1",
    cli: "codex",
    project_id: "project-1",
    context_epoch: 1,
    source_event_id: "fail-open-source-1",
    source_namespace: "prompt_hook",
    role: "user",
    referent_event_uid: null,
    content_hash: createHash("sha256").update("fail-open-event-1").digest("hex"),
    encrypted_raw_ref: null,
    completeness: "prompt_only",
    ...overrides
  };
}

test("capture durability failure records a bounded queryable fail-open reason code", async () => {
  const { store, blobs } = await controlCaptureFixture();
  store.database.exec(
    "CREATE TEMP TRIGGER force_capture_abort BEFORE INSERT ON session_events " +
    "BEGIN SELECT RAISE(ABORT, 'forced session-event abort'); END"
  );

  await assert.rejects(
    captureObservedSession({ store, blobs, event: captureEvent(), rawText: "capture durability failure" }),
    /forced session-event abort/
  );

  const records = store.listCaptureFailOpen();
  assert.equal(records.length, 1);
  assert.equal(records[0].event_type, "capture_fail_open");
  assert.match(records[0].reason_code, /^[a-z][a-z0-9_]{0,63}$/);
  assert.equal(records[0].session_uid, "fail-open-session-1");
  assert.ok(records[0].created_at);
  store.close();
});

test("capture fail-open log is bounded and keeps the most recent records", async () => {
  const { store, blobs } = await controlCaptureFixture();
  store.database.exec(
    "CREATE TEMP TRIGGER force_capture_abort_bounded BEFORE INSERT ON session_events " +
    "BEGIN SELECT RAISE(ABORT, 'forced session-event abort'); END"
  );

  for (let index = 0; index < 55; index += 1) {
    await assert.rejects(
      captureObservedSession({
        store,
        blobs,
        event: captureEvent({
          event_uid: `fail-open-event-${index}`,
          source_event_id: `fail-open-source-${index}`
        }),
        rawText: `capture durability failure ${index}`
      })
    );
  }

  const records = store.listCaptureFailOpen();
  assert.ok(records.length <= 50);
  assert.equal(records[records.length - 1].session_uid, "fail-open-session-1");
  store.close();
});

test("capture fail-open recording never masks the original durability error", async () => {
  const { store, blobs } = await controlCaptureFixture();
  const originalRecordCaptureFailOpen = store.recordCaptureFailOpen;
  store.recordCaptureFailOpen = () => {
    throw new Error("diagnostics backend unavailable");
  };
  store.database.exec(
    "CREATE TEMP TRIGGER force_capture_abort_masked BEFORE INSERT ON session_events " +
    "BEGIN SELECT RAISE(ABORT, 'forced session-event abort'); END"
  );

  await assert.rejects(
    captureObservedSession({ store, blobs, event: captureEvent(), rawText: "capture durability failure" }),
    /forced session-event abort/
  );

  store.recordCaptureFailOpen = originalRecordCaptureFailOpen;
  store.close();
});

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

test("explicit completed-turn dissatisfaction becomes an immediate review candidate", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-signal-control-"));
  const transcript = path.join(home, "rollout.jsonl");
  await writeFile(transcript, [
    JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-2" } }),
    JSON.stringify({
      timestamp: "2026-07-14T12:00:00.000Z",
      type: "response_item",
      payload: {
        id: "assistant-prior",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "previous design" }]
      }
    }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-2" } })
  ].join("\n"), "utf8");

  const signal = await detectStructuralFeedbackSignal({
    transcript_path: transcript,
    turn_id: "turn-3",
    prompt: "是的，而且为什么你改造这些之前没有去考虑这些东西呢，而是等到我发现事情变复杂了才开始思考这些东西"
  });
  assert.equal(signal.immediateReview, true);
  assert.equal(signal.reason, "explicit_retrospective_feedback");
  assert.deepEqual(signal.reasonCodes, [
    "negative_evaluation",
    "backward_reference",
    "causal_accountability",
    "expected_process_contrast"
  ]);
  assert.equal(signal.referent.id, "assistant-prior");
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
          text: syntheticControl()
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

test("classifies the frozen explicit dissatisfaction with ordered independent evidence", async () => {
  const referent = { eventUid: "assistant:1", text: "previous design" };
  const userText = "是的，而且为什么你改造这些之前没有去考虑这些东西呢，而是等到我发现事情变复杂了才开始思考这些东西";

  const classified = classifyRetrospectiveEvidence({ userText, hasReferent: true });
  assert.deepEqual(classified, {
    candidate: true,
    source: "explicit",
    reasonCodes: [
      "negative_evaluation",
      "backward_reference",
      "causal_accountability",
      "expected_process_contrast"
    ],
    score: 100
  });

  const detected = await detectFeedbackCandidate({ payload: {}, userText, referent, now: () => 0 });
  assert.equal(detected.candidate, true);
  assert.deepEqual(detected.reasonCodes, classified.reasonCodes);
  assert.equal(detected.score, 100);
  assert.equal(detected.referent, referent);
});

test("classification exposes explicit vs expanded admission source", async () => {
  const explicit = classifyRetrospectiveEvidence({
    userText: "是的，而且为什么你改造这些之前没有去考虑这些东西呢，而是等到我发现事情变复杂了才开始思考这些东西",
    hasReferent: true
  });
  assert.equal(explicit.candidate, true);
  assert.equal(explicit.source, "explicit");

  const expanded = classifyRetrospectiveEvidence({
    userText: "之前出现过好几次了，都第七八次了",
    hasReferent: true
  });
  assert.equal(expanded.candidate, true);
  assert.equal(expanded.source, "expanded");

  const negative = classifyRetrospectiveEvidence({ userText: "帮我看下这个日志", hasReferent: true });
  assert.equal(negative.candidate, false);
  assert.equal(negative.source, null);
});

test("a standalone known-info forgetting complaint is admitted via the expanded path", async () => {
  // Real missed case p1: the user points out the assistant is asking for a
  // value it was already given. This must not be dropped just because it lacks
  // an independent backward_reference token.
  const result = classifyRetrospectiveEvidence({
    userText: "密码不是都有吗端口55555",
    hasReferent: true
  });
  assert.equal(result.candidate, true);
  assert.equal(result.source, "expanded");
  assert.ok(result.reasonCodes.includes("known_info_forgetting"));
});

test("detectFeedbackCandidate carries the admission source through to callers", async () => {
  const referent = { eventUid: "assistant:src", text: "I asked for the port and password again." };
  const detected = await detectFeedbackCandidate({
    payload: {},
    userText: "密码不是都有吗端口55555",
    referent,
    now: () => 0
  });
  assert.equal(detected.candidate, true);
  assert.equal(detected.source, "expanded");
});

test("ordinary prompts, invited design calibration and isolated keywords are not candidates", async () => {
  const negativeCases = [
    "reviewer job 是干嘛的？",
    "按推荐执行",
    "以后量大了再上 RAG",
    "为什么",
    "问题",
    "反思"
  ];
  for (const userText of negativeCases) {
    const result = await detectFeedbackCandidate({ payload: {}, userText, referent: null, now: () => 0 });
    assert.equal(result.candidate, false, userText);
  }

  const invited = await detectFeedbackCandidate({
    payload: { invited_design_calibration: true },
    userText: "为什么不先讨论问题和反思边界？",
    referent: { eventUid: "assistant:question", text: "Which design boundary do you prefer?" },
    now: () => 0
  });
  assert.equal(invited.candidate, false);
});

test("synthetic AFL hook control is rejected before retrospective scoring", async () => {
  const userText = [
    '<hook_prompt hook_run_id="stop:4:/tmp/config.toml">',
    "Output this receipt verbatim before stopping:",
    "[AFL] 已复核，本次未形成长期经验 · job=52cd37 · receipt=de027c",
    "</hook_prompt>",
    "为什么你之前没有考虑，导致事情变复杂了，而是等我发现才开始反思"
  ].join("\n");
  const detected = await detectFeedbackCandidate({
    payload: { hook_run_id: "stop:4:/tmp/config.toml" },
    userText,
    referent: { eventUid: "assistant:prior", text: "prior answer" },
    now: () => 0
  });
  assert.deepEqual(detected, { candidate: false, source: null, reasonCodes: [], score: 0, referent: null });
});

test("prefers role-validated explicit Claude and Gemini assistant referents", async () => {
  const claude = await readDirectAssistantReferent({
    cli: "claude",
    payload: {
      turn_id: "claude-current",
      assistant_message: {
        role: "assistant",
        event_id: "claude-assistant",
        turn_id: "claude-prior",
        content: [{ type: "text", text: "Claude prior answer" }]
      }
    },
    maxBytes: 1024,
    now: () => 0
  });
  assert.deepEqual(claude, {
    referent: {
      eventUid: "claude-assistant",
      turnId: "claude-prior",
      timestamp: null,
      text: "Claude prior answer"
    },
    structuralReason: null
  });

  const gemini = await readDirectAssistantReferent({
    cli: "gemini",
    payload: {
      turn_id: "gemini-current",
      previous_assistant_message: {
        role: "assistant",
        message_id: "gemini-assistant",
        turn_id: "gemini-prior",
        content: [{ type: "output_text", text: "Gemini prior answer" }]
      }
    },
    maxBytes: 1024,
    now: () => 0
  });
  assert.equal(gemini.referent.eventUid, "gemini-assistant");
  assert.equal(gemini.referent.text, "Gemini prior answer");
  assert.equal(gemini.structuralReason, null);
});

test("rejects explicit non-assistant fields and unparsed user or system transcript bytes", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-role-validation-"));
  const transcript = path.join(home, "rollout.jsonl");
  await writeFile(transcript, [
    '{"role":"assistant","content":"truncated',
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "assistant-like user text" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "system", content: [{ type: "text", text: "assistant-like system text" }] } })
  ].join("\n"), "utf8");

  const result = await readDirectAssistantReferent({
    cli: "codex",
    payload: {
      turn_id: "turn-current",
      transcript_path: transcript,
      assistant_message: { role: "user", event_id: "not-assistant", content: "do not trust" }
    },
    maxBytes: 4096,
    now: () => 0
  });
  assert.equal(result.referent, null);
  assert.equal(result.structuralReason, null);
});

test("uses the closest completed Codex assistant as referent without making structure sufficient", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-completed-referent-"));
  const transcript = path.join(home, "rollout.jsonl");
  await writeFile(transcript, [
    JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-1" } }),
    JSON.stringify({ type: "response_item", payload: { id: "assistant-old", type: "message", role: "assistant", content: [{ type: "output_text", text: "older answer" }] } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-2" } }),
    JSON.stringify({ timestamp: "2026-07-14T12:00:00.000Z", type: "response_item", payload: { id: "assistant-nearest", type: "message", role: "assistant", content: [{ type: "output_text", text: "nearest answer" }] } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-2" } })
  ].join("\n"), "utf8");

  const resolved = await readDirectAssistantReferent({
    cli: "codex",
    payload: { transcript_path: transcript, turn_id: "turn-3" },
    maxBytes: 4096,
    now: () => Date.parse("2026-07-14T12:01:00.000Z")
  });
  assert.equal(resolved.referent.eventUid, "assistant-nearest");
  assert.equal(resolved.referent.text, "nearest answer");
  assert.equal(resolved.structuralReason, null);

  const neutral = await detectFeedbackCandidate({
    payload: { transcript_path: transcript, turn_id: "turn-3" },
    userText: "请继续",
    now: () => Date.parse("2026-07-14T12:01:00.000Z")
  });
  assert.equal(neutral.candidate, false);
  assert.equal(neutral.referent.eventUid, "assistant-nearest");
});

test("stops Codex referent selection at the current user event boundary", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-user-boundary-"));
  const transcript = path.join(home, "rollout.jsonl");
  await writeFile(transcript, [
    JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-prior" } }),
    JSON.stringify({ type: "response_item", payload: { id: "assistant-before", type: "message", role: "assistant", content: [{ type: "output_text", text: "answer before current user" }] } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-prior" } }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-current" } }),
    JSON.stringify({ type: "response_item", payload: { id: "current-user", type: "message", role: "user", content: [{ type: "input_text", text: "current feedback" }] } }),
    JSON.stringify({ type: "response_item", payload: { id: "assistant-after", type: "message", role: "assistant", content: [{ type: "output_text", text: "must not become the referent" }] } })
  ].join("\n"), "utf8");

  const resolved = await readDirectAssistantReferent({
    cli: "codex",
    payload: {
      event_id: "current-user",
      prompt: "current feedback",
      transcript_path: transcript,
      turn_id: "turn-current"
    },
    maxBytes: 4096,
    now: () => 0
  });
  assert.equal(resolved.referent.eventUid, "assistant-before");
  assert.equal(resolved.structuralReason, null);
});

test("transcript safety rejects missing, symlinked and unowned files and bounds oversized tails", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-transcript-safety-"));
  const transcript = path.join(home, "rollout.jsonl");
  const assistantLine = JSON.stringify({
    type: "response_item",
    payload: { id: "assistant-safe", type: "message", role: "assistant", content: [{ type: "output_text", text: "safe answer" }] }
  });
  await writeFile(transcript, `${assistantLine}\n${"x".repeat(2048)}`, "utf8");

  const missing = await readDirectAssistantReferent({
    cli: "codex",
    payload: { transcript_path: path.join(home, "missing.jsonl"), turn_id: "turn-current" },
    maxBytes: 128,
    now: () => 0
  });
  assert.equal(missing.referent, null);

  const link = path.join(home, "linked.jsonl");
  await symlink(transcript, link);
  const linked = await readDirectAssistantReferent({
    cli: "codex",
    payload: { transcript_path: link, turn_id: "turn-current" },
    maxBytes: 4096,
    now: () => 0
  });
  assert.equal(linked.referent, null);

  const originalGetuid = process.getuid;
  try {
    process.getuid = () => originalGetuid() + 1;
    const unowned = await readDirectAssistantReferent({
      cli: "codex",
      payload: { transcript_path: transcript, turn_id: "turn-current" },
      maxBytes: 4096,
      now: () => 0
    });
    assert.equal(unowned.referent, null);
  } finally {
    process.getuid = originalGetuid;
  }

  const bounded = await readDirectAssistantReferent({
    cli: "codex",
    payload: { transcript_path: transcript, turn_id: "turn-current" },
    maxBytes: 128,
    now: () => 0
  });
  assert.equal(bounded.referent, null);
});

test("feedback source identity uses five length-prefixed UTF-8 fields", () => {
  const fields = ["codex", "session:甲", "3", "prompt:event", "assistant:1"];
  const expected = createHash("sha256");
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    expected.update(length).update(bytes);
  }

  assert.equal(feedbackSourceIdentity({
    cli: fields[0],
    sessionUid: fields[1],
    contextEpoch: 3,
    sourceEventId: fields[3],
    referentEventUid: fields[4]
  }), expected.digest("hex"));
  assert.notEqual(
    feedbackSourceIdentity({ cli: "ab", sessionUid: "c", contextEpoch: 1, sourceEventId: "d", referentEventUid: "e" }),
    feedbackSourceIdentity({ cli: "a", sessionUid: "bc", contextEpoch: 1, sourceEventId: "d", referentEventUid: "e" })
  );
});

test("normalizes native prompt identity first and derives replay-stable fallback identity", () => {
  const native = normalizeHookEvent({
    cli: "codex",
    payload: { session_id: "native-session", turn_id: "native-turn", event_id: "event-first", prompt_id: "prompt-second", prompt: "same words" }
  });
  assert.equal(native.source_event_id, "prompt:event-first");
  assert.equal(native.identity_unstable, false);

  const payload = {
    session_id: "replay-session",
    turn_id: "turn-1",
    transcript_path: "/tmp/replay.jsonl",
    prompt: "same words"
  };
  const first = normalizeHookEvent({ cli: "codex", payload });
  const replay = normalizeHookEvent({ cli: "codex", payload: { ...payload } });
  assert.equal(first.source_event_id, replay.source_event_id);
  assert.equal(first.event_uid, replay.event_uid);
  assert.equal(first.identity_unstable, false);

  const anotherSession = normalizeHookEvent({ cli: "codex", payload: { ...payload, session_id: "replay-session-2" } });
  const anotherTurn = normalizeHookEvent({ cli: "codex", payload: { ...payload, turn_id: "turn-2" } });
  assert.notEqual(first.source_event_id, anotherSession.source_event_id);
  assert.notEqual(first.source_event_id, anotherTurn.source_event_id);

  const eventOnly = normalizeHookEvent({ cli: "codex", payload: { event_id: "native-event-only", prompt: "same words" } });
  assert.equal(eventOnly.source_event_id, "prompt:native-event-only");
  assert.equal(eventOnly.identity_unstable, true);

  const unstable = normalizeHookEvent({ cli: "codex", payload: { prompt: "same words", cwd: "/tmp/project" } });
  assert.equal(unstable.identity_unstable, true);
  assert.match(unstable.source_event_id, /^prompt:derived:/);
});

test("missing native event IDs are generated without collapsing distinct prompts", () => {
  const first = normalizeHookEvent({ cli: "codex", payload: { installationId: "i", sessionId: "s", prompt: "first" } });
  const second = normalizeHookEvent({ cli: "codex", payload: { installationId: "i", sessionId: "s", prompt: "second" } });
  assert.notEqual(first.event_uid, second.event_uid);
  assert.notEqual(first.source_event_id, "unknown");
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
