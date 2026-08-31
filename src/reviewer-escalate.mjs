// Deterministic review escalation.
//
// The LLM reviewer has proven unreliable at honoring a family's own
// would_qualify_if promise: it declines the same recurring problem again and
// again, each time inventing a fresh excuse (post-hoc correction, "not
// deployed yet", "user misunderstanding", "prospective request"). The
// contract says a prior decline's would_qualify_if is a commitment, but the
// model keeps finding a way around it.
//
// This module is the backstop that does not rely on the model. When the
// reviewer declines a family that has already been declined repeatedly in the
// window, it synthesizes a minimal lesson from the accumulated decline records
// rather than accepting another no_lesson. The content is real — it comes from
// what the earlier reviews already wrote in incident_summary — not invented
// facts. This is what "the promise was met" means in code instead of in prose.

// A family is escalated once it has been declined this many times in the
// window. The signal is repetition: the same class of problem kept coming back
// and each review declined to learn from it.
const ESCALATION_THRESHOLD = 3;
// Decline history only counts within this window, so a project that had a bad
// month a year ago does not escalate forever.
const ESCALATION_WINDOW_MS = 14 * 24 * 60 * 60 * 1_000;

function bounded(value, max) {
  const text = String(value ?? "").trim();
  return Array.from(text).slice(0, max).join("");
}

function joinSummaries(declines, max = 600) {
  return bounded(declines.map((entry) => entry.incidentSummary).filter(Boolean).join("；"), max);
}

/**
 * Decides whether a no_lesson verdict should be escalated into a published
 * lesson, and if so returns the synthesized lesson result (validateReflectionModel
 * compatible). Returns null when the verdict stands.
 *
 * @param {object} params
 * @param {object} params.verdict - the LLM's declined result (reason_code,
 *   family_key, incident_summary, why_not_a_lesson, would_qualify_if).
 * @param {Array<{incidentSummary, reasonCode, wouldQualifyIf, declinedAt}>}
 *   params.declines - the family's decline history, newest first.
 * @param {object} params.job - the current review job row (for source identity).
 */
export function escalateDeclinedFamily({ verdict, declines = [], job }) {
  const familyKey = String(verdict?.family_key ?? "").trim();
  if (!familyKey) return null;
  if (!job?.source_identity) return null;

  // Declines arrive in two shapes: the store returns camelCase
  // (familyKey/incidentSummary), but the review context's prior_declines are
  // serialized snake_case (family_key/incident_summary). Read both — matching
  // only one shape silently makes every family look first-time.
  const normalized = (declines || []).map((entry) => ({
    familyKey: entry.familyKey ?? entry.family_key ?? null,
    reasonCode: entry.reasonCode ?? entry.reason_code ?? null,
    declinedAt: entry.declinedAt ?? entry.declined_at ?? null,
    incidentSummary: entry.incidentSummary ?? entry.incident_summary ?? null,
    wouldQualifyIf: entry.wouldQualifyIf ?? entry.would_qualify_if ?? null
  }));

  // Only the same family's own history counts; a different family that also
  // recurs is not this family's promise.
  const familyDeclines = normalized.filter((entry) => entry.familyKey === familyKey);
  // Count declines in the window. declinedAt may be null on backfilled rows;
  // treat a missing timestamp as recent so old rows without a stamp still
  // count rather than silently making the family look fresh.
  const cutoff = Date.now() - ESCALATION_WINDOW_MS;
  const inWindow = familyDeclines.filter((entry) => {
    const at = entry.declinedAt ? Date.parse(entry.declinedAt) : NaN;
    return Number.isFinite(at) ? at >= cutoff : true;
  });
  if (inWindow.length < ESCALATION_THRESHOLD) return null;

  // The current verdict is being declined too — it is part of the run that
  // proved repetition. Count it even though it is not in prior_declines yet.
  const total = inWindow.length + 1;

  const methodClass = "recurring_decline_after_user_feedback";
  const classOfMistake = bounded(
    "同一类问题在评审中反复被拒为「不足以沉淀」的时机/证据门槛不成立：用户已明确反馈，评审却以事后纠正、未部署、用户转述或前瞻建议为由拒绝沉淀，导致该问题反复发生却从未被记入反思。",
    2_048
  );
  const userComplaint = bounded(
    verdict?.incident_summary || joinSummaries(inWindow),
    2_048
  );
  const rootCause = bounded(
    "评审把「是否值得沉淀」建立在 agent 是否已经事后纠正或是否已部署上，而不是建立在用户是否明确反馈、agent 是否第一时间就做错上。事后承认不能防止下次再犯，所以这类问题每次都被放过。",
    2_048
  );
  const facts = [
    bounded(
      "该族问题已在本窗口内被评审拒绝 " + total + " 次（含本次），每次理由不同但均未沉淀。",
      512
    ),
    bounded(
      "用户明确反馈：「" + (userComplaint || "该问题反复出现") + "」。",
      512
    )
  ].filter(Boolean);

  const methodChanges = [
    "收到用户的明确范围、能力声明或否定性反馈时，agent 的第一反应是去核查、去执行，而不是先反驳或把活推回用户；事后承认不能替代第一时间做对。",
    "当同类问题第二次出现时，把它当作已承诺的 would_qualify_if 已被命中，必须沉淀为反思或规则，而不是再次以相同理由拒绝。"
  ].slice(0, 8);

  const appliesWhen = [
    "当用户对 agent 的工作表达明确不满、指出其理解错或范围做过头时",
    "when the user explicitly expresses dissatisfaction or points out that the agent misunderstood the scope"
  ].slice(0, 16);

  const proposedFamilyKey = familyKey;
  // The family has never been published (it was only ever declined), so this is
  // a new family: family_id stays null and the key is proposed. An existing
  // family would carry a published family_id, which is not the case here.
  const familyId = null;

  return {
    outcome: "lesson",
    final_severity: "Major",
    responsibility: "agent_fault",
    method_class: methodClass,
    family_id: familyId,
    proposed_family_key: proposedFamilyKey,
    applies_when: appliesWhen,
    facts,
    user_complaint: userComplaint,
    root_cause: rootCause,
    class_of_mistake: classOfMistake,
    method_changes: methodChanges,
    repeated_pattern_evidence: inWindow.slice(0, 8).map((entry, index) =>
      bounded(`第 ${index + 1} 次拒绝：${entry.incidentSummary || entry.reasonCode || "无摘要"}`, 512)
    ),
    recurrence_of: []
  };
}
