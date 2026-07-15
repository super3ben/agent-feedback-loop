import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectReceiptLanguage,
  renderReceiptControl,
  renderReceiptInstruction,
  renderReceiptLine,
  stripReceiptControlText
} from "../src/receipt.mjs";

const notification = Object.freeze({
  notification_id: "notification-1234567890",
  job_id: "7e876e123",
  kind: "review_completed",
  payload_json: JSON.stringify({ severity: "Major", lesson_count: 1 }),
  language: "zh"
});

test("receipt renderer detects the requested language deterministically", () => {
  assert.equal(detectReceiptLanguage("为什么没有触发反思", "auto"), "zh");
  assert.equal(detectReceiptLanguage("why was no review started", "auto"), "en");
  assert.equal(detectReceiptLanguage("why", "zh"), "zh");
});

test("receipt renderer renders every notification kind from fixed bilingual copy", () => {
  const cases = [
    [{ kind: "candidate_captured", payload_json: "{}", language: "zh" }, "[AFL] 已捕获候选 · job=7e876e"],
    [{ kind: "review_queued", payload_json: "{}", language: "en" }, "[AFL] Review queued · job=7e876e"],
    [{ kind: "review_completed", payload_json: JSON.stringify({ severity: "Major", lesson_count: 1 }), language: "zh" }, "[AFL] 反思完成 · severity=Major · lessons=1 · job=7e876e"],
    [{ kind: "reviewed_no_lesson", payload_json: "{}", language: "en" }, "[AFL] Review completed · no lessons · job=7e876e"],
    [{ kind: "review_exhausted", payload_json: JSON.stringify({ reason_code: "provider_failed" }), language: "zh" }, "[AFL] 反思未完成 · reason=provider_failed · job=7e876e"],
    [{ kind: "lesson_delivered", payload_json: JSON.stringify({ lesson_count: 2 }), language: "en" }, "[AFL] Lessons delivered · lessons=2 · job=7e876e"]
  ];

  for (const [overrides, expected] of cases) {
    assert.equal(renderReceiptLine({ ...notification, ...overrides }), expected);
  }
});

test("receipt renderer emits the exact visible and hidden receipt control", () => {
  const rendered = renderReceiptControl(notification);

  assert.equal(rendered.line, "[AFL] 反思完成 · severity=Major · lessons=1 · job=7e876e");
  assert.match(rendered.marker, /^<!--afl-receipt id=notification-1234567890 nonce=[a-f0-9]{16} state=review_completed-->$/);
  assert.ok(rendered.line.length <= 160);
  assert.ok(rendered.text.length <= 512);
  assert.equal(stripReceiptControlText(`normal answer\n${rendered.line}\n${rendered.marker}`), "normal answer");
  assert.equal(stripReceiptControlText(`${rendered.line}\n${rendered.marker}`), "");
  assert.equal(stripReceiptControlText("AFL is part of this ordinary user sentence."), "AFL is part of this ordinary user sentence.");
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

test("receipt renderer rejects untrusted, private, or oversized notification values", () => {
  assert.throws(() => renderReceiptLine({ ...notification, kind: "unknown", payload_json: "{}" }), TypeError);
  assert.throws(() => renderReceiptLine({ ...notification, payload_json: JSON.stringify({ severity: "Major", lesson_count: 1, secret: "no" }) }), TypeError);
  assert.throws(() => renderReceiptLine({ ...notification, payload_json: JSON.stringify({ severity: "Severe", lesson_count: 1 }) }), TypeError);
  assert.throws(() => renderReceiptLine({ ...notification, notification_id: 1234567890 }), /notification id is invalid/);
  assert.throws(() => renderReceiptLine({ ...notification, job_id: 123456 }), /job id is invalid/);
  assert.throws(() => renderReceiptLine({ ...notification, job_id: "codex:default:session-0123456789abcdef" }), TypeError);
  assert.throws(() => renderReceiptLine({ ...notification, job_id: "/Users/example/private/job" }), TypeError);
  assert.throws(() => renderReceiptLine({ ...notification, job_id: "a".repeat(161) }), TypeError);
});
