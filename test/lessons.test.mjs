import assert from "node:assert/strict";
import { test } from "node:test";

import { validateReviewQuality } from "../src/lessons.mjs";

function lesson(overrides = {}) {
  return {
    lesson_id: "lesson-quality",
    revision: 1,
    base_revision: 0,
    project_id: "project-quality",
    severity: "Major",
    responsibility: "agent_fault",
    confidence: "high",
    causal_chain: ["symptom", "missed signal", "skipped check", "missing gate", "unsafe default method"],
    method_class: "verification-closure",
    class_id: "claim-without-evidence",
    generalizable: true,
    rule_action: "update_project_rule",
    evidence_refs: [{ feedback_event_id: "feedback-1", feedback_quote: "exact complaint", referent_event_ids: ["assistant-1"] }],
    card: { when: "claiming completion", must_do: "verify", must_not: "guess", verify: "read evidence", why: "prior miss", exception: "none", source_ids: ["report-1"] },
    ...overrides
  };
}

test("Minor findings cannot create active lessons", () => {
  assert.throws(() => validateReviewQuality({ lessons: [lesson({ severity: "Minor" })] }), /Minor.*lesson/i);
});

test("Critical and Blocker lessons require severity-specific analysis fields", () => {
  assert.throws(() => validateReviewQuality({ lessons: [lesson({ severity: "Critical" })] }), /decision timeline/i);
  const critical = lesson({
    severity: "Critical",
    decision_timeline: ["accepted unsupported premise", "claimed completion before verification"],
    counterfactual_checkpoint: "require observed evidence before the completion claim"
  });
  assert.doesNotThrow(() => validateReviewQuality({ lessons: [critical] }));
  assert.throws(() => validateReviewQuality({ lessons: [lesson({
    ...critical,
    severity: "Blocker"
  })] }), /impact scope|stop condition|rollback/i);
  assert.doesNotThrow(() => validateReviewQuality({ lessons: [lesson({
    ...critical,
    severity: "Blocker",
    impact_scope: "live customer data could be changed",
    stop_condition: "stop before any irreversible write",
    rollback_or_isolation: "isolate the target and restore from the verified backup",
    global_promotion_evidence: ["lineage-one", "lineage-two"]
  })] }));
});

test("review status and lesson projection cannot contradict each other", () => {
  assert.throws(() => validateReviewQuality({ status: "reviewed", lessons: [] }), /status.*lesson/i);
  assert.throws(() => validateReviewQuality({ status: "reviewed_no_lesson", lessons: [lesson()] }), /status.*lesson/i);
  assert.doesNotThrow(() => validateReviewQuality({ status: "reviewed_no_lesson", lessons: [] }));
});
