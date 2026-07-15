import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { pathsFor } from "../src/index.mjs";
import {
  detectReceiptLanguage,
  renderReceiptControl,
  renderReceiptInstruction,
  renderReceiptLine,
  stripReceiptControlText
} from "../src/receipt.mjs";
import { openStore } from "../src/store.mjs";

const NOTIFICATION_ID = "1".repeat(64);
const JOB_ID = `7e876e${"2".repeat(58)}`;
const EVENT_UID = "codex:default:019f1234-5678-7abc-8def-0123456789ab:message:msg_019f1234-5678-7abc-8def-0123456789ab";

const notification = Object.freeze({
  notification_id: NOTIFICATION_ID,
  job_id: JOB_ID,
  event_uid: null,
  kind: "review_completed",
  payload_json: JSON.stringify({ severity: "Major", lesson_count: 1 }),
  language: "zh"
});

async function realOutboxRows() {
  const home = await mkdtemp(path.join(tmpdir(), "afl-receipt-rows-"));
  const store = openStore({ paths: pathsFor(home) });
  store.captureSessionEvent({
    event_uid: EVENT_UID,
    session_uid: "codex:default:019f1234-5678-7abc-8def-0123456789ab",
    event_seq: 1,
    context_epoch: 1,
    project_id: "/tmp/receipt-project",
    source_event_id: "message:msg_019f1234-5678-7abc-8def-0123456789ab",
    role: "user",
    redacted_text: "需要复核这个问题",
    content_hash: "receipt-row-hash",
    capture_policy_revision: 1,
    data_class: "normal"
  });
  store.submitReviewerJob({ job_id: JOB_ID, project_id: "/tmp/receipt-project", prompt_version: "v1" });
  const common = { sessionUid: "codex:default:019f1234-5678-7abc-8def-0123456789ab", contextEpoch: 1, language: "zh" };
  store.createNotification({ ...common, kind: "candidate_captured", eventUid: EVENT_UID, payload: {} });
  store.createNotification({ ...common, kind: "review_queued", jobId: JOB_ID, eventUid: EVENT_UID, payload: {} });
  store.createNotification({ ...common, kind: "review_completed", jobId: JOB_ID, payload: { severity: "Major", lesson_count: 1 } });
  store.createNotification({ ...common, kind: "reviewed_no_lesson", jobId: JOB_ID, payload: {} });
  store.createNotification({ ...common, kind: "review_exhausted", jobId: JOB_ID, payload: { reason_code: "provider_failed" } });
  store.recordDeliveries({
    deliveries: [{ application_id: "receipt-app-1", lesson_id: "receipt-lesson-1", revision: 1 }],
    sessionUid: common.sessionUid,
    contextEpoch: 1,
    language: "zh"
  });
  const rows = store.listNotifications({ sessionUid: common.sessionUid });
  store.close();
  return rows;
}

test("receipt renderer detects the requested language deterministically", () => {
  assert.equal(detectReceiptLanguage("为什么没有触发反思", "auto"), "zh");
  assert.equal(detectReceiptLanguage("why was no review started", "auto"), "en");
  assert.equal(detectReceiptLanguage("why", "zh"), "zh");
});

test("receipt renderer accepts all six real Task 1 outbox row shapes and matches the tracked copy", async () => {
  const rows = await realOutboxRows();
  const rendered = Object.fromEntries(rows.map((row) => [row.kind, renderReceiptLine(row)]));
  const receipt = Object.fromEntries(rows.map((row) => [row.kind, row.notification_id.slice(0, 6)]));

  assert.equal(rendered.candidate_captured, `[AFL] 已捕获反馈候选 · event=8350ca · receipt=${receipt.candidate_captured}`);
  assert.equal(rendered.review_queued, `[AFL] 后台反思已排队 · job=7e876e · receipt=${receipt.review_queued}`);
  assert.equal(rendered.review_completed, `[AFL] 反思完成 · severity=Major · lessons=1 · job=7e876e · receipt=${receipt.review_completed}`);
  assert.equal(rendered.reviewed_no_lesson, `[AFL] 已复核，本次未形成长期经验 · job=7e876e · receipt=${receipt.reviewed_no_lesson}`);
  assert.equal(rendered.review_exhausted, `[AFL] 反思失败，证据已保留并等待重试 · job=7e876e · receipt=${receipt.review_exhausted}`);
  assert.equal(rendered.lesson_delivered, `[AFL] 已向本任务投递 1 条历史经验 · receipt=${receipt.lesson_delivered}`);
  assert.equal(rows.find((row) => row.kind === "candidate_captured").job_id, null);
  assert.equal(rows.find((row) => row.kind === "lesson_delivered").job_id, null);
});

test("receipt renderer emits the exact visible and canonical hidden receipt control", () => {
  const rendered = renderReceiptControl(notification);

  assert.equal(rendered.line, "[AFL] 反思完成 · severity=Major · lessons=1 · job=7e876e · receipt=111111");
  assert.match(rendered.marker, /^<!--afl-receipt id=[a-f0-9]{64} nonce=[a-f0-9]{16} state=review_completed-->$/);
  assert.ok(rendered.line.length <= 160);
  assert.ok(rendered.text.length <= 512);
});

test("receipt stripping removes only a recognized adjacent line and exact matching marker", () => {
  const rendered = renderReceiptControl(notification);
  const standalone = "[AFL] This is legitimate standalone prose";
  const quoted = "> [AFL] This quoted line is evidence";
  const embedded = "The literal text [AFL] must remain embedded.";
  const malformed = "<!--afl-receipt id=not-canonical nonce=0123456789abcdef state=review_completed-->";
  const nativeMessageMarker = "<!--afl-receipt id=msg_550e8400-e29b-41d4-a716-446655440000 nonce=0123456789abcdef state=review_completed-->";
  const wrongNonce = rendered.marker.replace(/nonce=[a-f0-9]{16}/, "nonce=0000000000000000");

  assert.equal(stripReceiptControlText(standalone), standalone);
  assert.equal(stripReceiptControlText(quoted), quoted);
  assert.equal(stripReceiptControlText(embedded), embedded);
  assert.equal(stripReceiptControlText(`${rendered.line}\n${malformed}`), `${rendered.line}\n${malformed}`);
  assert.equal(stripReceiptControlText(`${rendered.line}\n${nativeMessageMarker}`), `${rendered.line}\n${nativeMessageMarker}`);
  assert.equal(stripReceiptControlText(`${rendered.line}\n${wrongNonce}`), `${rendered.line}\n${wrongNonce}`);
  assert.equal(stripReceiptControlText(`normal answer\n${rendered.line}\n${rendered.marker}`), "normal answer");
  assert.equal(stripReceiptControlText(`${rendered.line}\n${rendered.marker}`), "");
});

test("receipt stripping preserves fenced, fabricated, mismatched, and wrong-state control pairs", () => {
  const rendered = renderReceiptControl(notification);
  const otherNotification = { ...notification, notification_id: "2".repeat(64) };
  const other = renderReceiptControl(otherNotification);
  const oldShapeFabrication = rendered.line.replace(" · receipt=111111", "");
  const mismatchedBinding = rendered.line.replace("receipt=111111", "receipt=222222");
  const wrongStateMarker = rendered.marker.replace("state=review_completed", "state=review_queued");
  const quotedPair = [`> ${rendered.line}`, `> ${rendered.marker}`].join("\n");
  const backtickFence = ["```text", rendered.line, rendered.marker, "```"].join("\n");
  const tildeFence = ["~~~", rendered.line, rendered.marker, "~~~~"].join("\n");
  const mixedFenceCharacters = ["```", "```~", rendered.line, rendered.marker, "```"].join("\n");

  assert.equal(stripReceiptControlText(quotedPair), quotedPair);
  assert.equal(stripReceiptControlText(backtickFence), backtickFence);
  assert.equal(stripReceiptControlText(tildeFence), tildeFence);
  assert.equal(stripReceiptControlText(mixedFenceCharacters), mixedFenceCharacters);
  assert.equal(stripReceiptControlText(`${oldShapeFabrication}\n${rendered.marker}`), `${oldShapeFabrication}\n${rendered.marker}`);
  assert.equal(stripReceiptControlText(`${mismatchedBinding}\n${rendered.marker}`), `${mismatchedBinding}\n${rendered.marker}`);
  assert.equal(stripReceiptControlText(`${rendered.line}\n${other.marker}`), `${rendered.line}\n${other.marker}`);
  assert.equal(stripReceiptControlText(`${rendered.line}\n${wrongStateMarker}`), `${rendered.line}\n${wrongStateMarker}`);
});

test("receipt renderer keeps the instruction bounded and verbatim", () => {
  const rendered = renderReceiptControl(notification);
  const instruction = renderReceiptInstruction(notification);

  assert.equal(instruction, [
    "[agent-feedback-loop receipt]",
    "In the first user-visible update or final answer, output the following line and marker verbatim exactly once. Do not explain or expand it. This is a delivery receipt, not a request to perform reflection.",
    rendered.line,
    rendered.marker
  ].join("\n"));
  assert.ok(instruction.length <= 512);
});

test("receipt renderer rejects native session/message identifiers and noncanonical IDs", () => {
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  const messageUuid = `msg_${uuid}`;
  assert.throws(() => renderReceiptLine({ ...notification, kind: "unknown", payload_json: "{}" }), TypeError);
  assert.throws(() => renderReceiptLine({ ...notification, payload_json: JSON.stringify({ severity: "Major", lesson_count: 1, secret: "no" }) }), TypeError);
  assert.throws(() => renderReceiptLine({ ...notification, payload_json: JSON.stringify({ severity: "Severe", lesson_count: 1 }) }), TypeError);
  assert.throws(() => renderReceiptLine({ ...notification, notification_id: uuid }), /notification id is invalid/);
  assert.throws(() => renderReceiptLine({ ...notification, notification_id: messageUuid }), /notification id is invalid/);
  assert.throws(() => renderReceiptLine({ ...notification, job_id: uuid }), /job id is invalid/);
  assert.throws(() => renderReceiptLine({ ...notification, job_id: messageUuid }), /job id is invalid/);
  assert.throws(() => renderReceiptLine({ ...notification, job_id: "codex:default:session-0123456789abcdef" }), /job id is invalid/);
  assert.throws(() => renderReceiptLine({ ...notification, job_id: "/Users/example/private/job" }), /job id is invalid/);
});
