const REQUIRED = ["when", "must_do", "must_not", "verify", "why", "exception", "source_ids"];
const METHOD_CLASSES = new Set(["evidence-premise", "requirements-scope", "execution-order", "verification-closure", "state-context", "resource-lifecycle", "communication-handoff", "learning-retrieval", "safety-irreversible"]);

export function compileLessonCard(input) {
  for (const field of REQUIRED) {
    if (field === "source_ids") {
      if (!Array.isArray(input[field]) || input[field].length === 0) throw new TypeError("source_ids is required");
    } else if (!String(input[field] || "").trim()) {
      throw new TypeError(`${field} is required`);
    }
  }
  return {
    when: String(input.when), must_do: String(input.must_do), must_not: String(input.must_not),
    verify: String(input.verify), why: String(input.why), exception: String(input.exception),
    source_ids: input.source_ids.map(String), verify_predicate: input.verify_predicate || null, gate_predicate: input.gate_predicate || null
  };
}

export function validateReviewQuality(review) {
  const lessonCount = Array.isArray(review.lessons) ? review.lessons.length : 0;
  if (review.status === "reviewed" && lessonCount === 0) throw new TypeError("review status requires at least one lesson");
  if (review.status === "reviewed_no_lesson" && lessonCount !== 0) throw new TypeError("reviewed_no_lesson status cannot contain lessons");
  for (const lesson of review.lessons || []) {
    if (lesson.severity === "Minor") throw new TypeError("Minor findings must not create an active lesson");
    if (lesson.responsibility !== "agent_fault") throw new TypeError("lesson quality requires responsibility=agent_fault");
    if (!["medium", "high"].includes(lesson.confidence)) throw new TypeError("lesson quality requires medium/high confidence");
    if (!Array.isArray(lesson.causal_chain) || lesson.causal_chain.length < 5) throw new TypeError("lesson quality requires a causal chain with at least 5 steps");
    if (!METHOD_CLASSES.has(lesson.method_class)) throw new TypeError("lesson quality requires a controlled method_class");
    if (!String(lesson.class_id || "").trim()) throw new TypeError("lesson quality requires class_id");
    if (typeof lesson.generalizable !== "boolean") throw new TypeError("lesson quality requires generalizable boolean");
    if (!Array.isArray(lesson.evidence_refs) || lesson.evidence_refs.length === 0 || lesson.evidence_refs.some((ref) => !ref.feedback_event_id || !String(ref.feedback_quote || "").trim() || !Array.isArray(ref.referent_event_ids) || ref.referent_event_ids.length === 0)) {
      throw new TypeError("lesson quality requires an exact feedback quote and referent evidence");
    }
    if (["Critical", "Blocker"].includes(lesson.severity)) {
      if (!Array.isArray(lesson.decision_timeline) || lesson.decision_timeline.length < 2) throw new TypeError("Critical lesson quality requires a decision timeline");
      if (!String(lesson.counterfactual_checkpoint || "").trim()) throw new TypeError("Critical lesson quality requires a counterfactual checkpoint");
    }
    if (lesson.severity === "Blocker") {
      if (!String(lesson.impact_scope || "").trim()) throw new TypeError("Blocker lesson quality requires an impact scope");
      if (!String(lesson.stop_condition || "").trim()) throw new TypeError("Blocker lesson quality requires a stop condition");
      if (!String(lesson.rollback_or_isolation || "").trim()) throw new TypeError("Blocker lesson quality requires a rollback or isolation plan");
      if (!Array.isArray(lesson.global_promotion_evidence)) throw new TypeError("Blocker lesson quality requires global promotion evidence, which may be empty");
    }
    if (!["none", "update_project_rule", "propose_global_rule"].includes(lesson.rule_action || "none")) throw new TypeError("lesson quality has invalid rule_action");
    compileLessonCard(lesson.card || {});
  }
  return review;
}
