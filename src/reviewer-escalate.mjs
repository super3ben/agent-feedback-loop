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

// How many times the SAME stated reason may be used on one family before it
// stops counting as a judgement. Two is the honest limit: the first decline
// states a condition, the second must be tested against it, and a second
// identical reason is evidence that the condition was never checked rather than
// that it failed. This is deliberately lower than ESCALATION_THRESHOLD because
// it is a stronger signal — not "this keeps happening" but "this exact
// objection has already been answered".
const REPEATED_REASON_LIMIT = 1;

// Reason codes that assert something about the WORLD rather than about the
// agent's own work. Escalating those into a Major/agent_fault lesson fabricates
// a rule out of a non-fault: an external outage repeating is not a lesson about
// how the agent should behave. They still must not pass silently, so they are
// recorded as declined-but-unpublishable instead of being force-published.
const NON_AGENT_FAULT_REASONS = new Set([
  "not_agent_fault",
  "external_limit",
  "user_misunderstanding"
]);

function bounded(value, max) {
  const text = String(value ?? "").trim();
  return Array.from(text).slice(0, max).join("");
}

// Words that appear in nearly every complaint, so they carry no matching power.
// Kept deliberately small: this picks the distinctive nouns out of one sentence,
// it does not try to be a tokenizer.
const CONDITION_STOP_TERMS = new Set([
  "用户", "问题", "反馈", "指出", "认为", "表示", "需要", "应该", "已经", "还是",
  "这个", "那个", "之前", "之后", "然后", "但是", "所以", "因为", "如果", "没有",
  "不是", "就是", "什么", "怎么", "为什么", "自己", "我们", "他们", "时候",
  "the", "and", "for", "with", "that", "this", "from", "user", "agent"
]);

/**
 * Picks the distinctive phrases out of an incident summary.
 *
 * The condition has to be phrased in words a future prompt might share, so it is
 * built from the complaint's own vocabulary rather than a paraphrase.
 *
 * Phrases, not tokens. The first version sliced every run of Chinese into
 * fixed six-character chunks, which produced ``「 如果是自动检、测的完成度和、
 * 进度描述都置 」`` — fragments that straddle word boundaries and match nothing.
 * A clause delimited by punctuation is the smallest unit that stays readable and
 * still carries meaning, and the scorer tokenises it into bigrams anyway, so
 * nothing is lost on the matching side.
 *
 * Order matters: a quoted span is the user's own words for the thing they care
 * about, which is exactly the vocabulary the next complaint will reuse.
 */
export function distinctTerms(text, limit = 3) {
  const source = String(text ?? "").trim();
  if (!source) return [];

  const picked = [];
  const push = (raw) => {
    const phrase = String(raw ?? "").trim().replace(/\s+/gu, " ");
    if (Array.from(phrase).length < 4) return;
    if (CONDITION_STOP_TERMS.has(phrase)) return;
    // Drop a phrase that contains or is contained by one already picked. A
    // quoted span sits inside the clause that quotes it, so without this the
    // condition reads "when the task involves A、B where B is the sentence
    // containing A" — the same words twice, and the longer copy adds nothing
    // but length to every prompt that matches it.
    const key = phrase.toLowerCase();
    for (const existing of picked) {
      const existingKey = existing.toLowerCase();
      if (existingKey.includes(key) || key.includes(existingKey)) return;
    }
    picked.push(Array.from(phrase).slice(0, 28).join(""));
  };

  // 1. Quoted spans: the user's own name for the problem.
  for (const match of source.matchAll(/[「『"“]([^」』"”]{4,40})[」』"”]/gu)) push(match[1]);

  // 2. Otherwise whole clauses, which stay grammatical.
  if (picked.length < limit) {
    for (const clause of source.split(/[。；;！？!?\n，,]/u)) push(clause);
  }

  return picked.slice(0, limit);
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
 * @param {boolean} [params.hasPublishedLesson] - the family already has a
 *   published lesson. Escalation exists to break a never-published family out
 *   of a decline loop; once published, normal recurrence machinery owns the
 *   family and escalating again would pile up duplicate meta-lessons.
 * @param {{declines: number, firstDeclinedAt?: string|null}} [params.permanentDeclines]
 *   how many times this family was declined according to the permanent job
 *   table. The prior_declines records live in a capped store_meta ring that is
 *   evicted across ALL families, so they undercount badly on a busy project —
 *   one family had 53 declined reviews and 2 surviving records. The stored
 *   ring still supplies the prose (what each review actually said); this count
 *   supplies the truth about how often it happened.
 * @param {{reasonCode: string, priorDeclines: number, firstSeen?: string|null,
 *   lastSeen?: string|null, hasPublishedLesson?: boolean}|null} [params.repeatDecline]
 *   the same family was already declined for this exact stated reason. Present
 *   means the reviewer is restating an objection that was already answered, so
 *   the verdict is not a judgement to weigh — it is a repeat to overrule.
 */
export function escalateDeclinedFamily({
  verdict,
  declines = [],
  job,
  hasPublishedLesson = false,
  permanentDeclines = null,
  repeatDecline = null
}) {
  const familyKey = String(verdict?.family_key ?? "").trim();
  if (!familyKey) return null;
  if (!job?.source_identity) return null;

  // A reason already used on this family is not a fresh judgement. When it is
  // an agent-fault shaped reason, the lesson must be published even though one
  // already exists — the existing one demonstrably did not hold. When it
  // asserts something about the world (outage, user misunderstanding), there is
  // no agent behaviour to encode, so escalating would fabricate a rule; the
  // caller records it as declined-but-unpublishable instead of letting a fifth
  // identical excuse pass unseen.
  const repeatedReason = repeatDecline
    && Number(repeatDecline.priorDeclines) >= REPEATED_REASON_LIMIT
    && String(repeatDecline.reasonCode ?? "") === String(verdict?.reason_code ?? "")
      ? repeatDecline
      : null;
  const repeatIsNonFault = Boolean(
    repeatedReason && NON_AGENT_FAULT_REASONS.has(String(repeatedReason.reasonCode))
  );

  if (hasPublishedLesson && !repeatedReason) return null;
  if (repeatIsNonFault) return null;

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

  // The ring buffer above is capped and shared across every family, so on a
  // busy project it holds a small fraction of the real history: one family had
  // 53 declined reviews and 2 surviving records, which read as "not recurring"
  // and was declined a 54th time. The permanent count wins when it is larger.
  const permanentCount = Number.isFinite(permanentDeclines?.declines)
    ? permanentDeclines.declines
    : 0;
  const permanentFirst = permanentDeclines?.firstDeclinedAt
    ? Date.parse(permanentDeclines.firstDeclinedAt)
    : NaN;
  const permanentInWindow = Number.isFinite(permanentFirst) ? permanentFirst >= cutoff : true;
  const effectiveCount = permanentInWindow
    ? Math.max(inWindow.length, permanentCount)
    : inWindow.length;

  // Two independent triggers, and the repeat-reason one deliberately bypasses
  // the window. The window answers "is this happening a lot lately"; a repeated
  // identical reason answers the sharper question "was the objection already
  // made and never tested". The second must not be filtered by the first: the
  // SSH family was declined across four months, which is zero hits in any
  // 14-day lookback, and that is exactly the case the window kept losing.
  if (!repeatedReason && effectiveCount < ESCALATION_THRESHOLD) return null;

  // The current verdict is being declined too — it is part of the run that
  // proved repetition. Count it even though it is not in prior_declines yet.
  const total = repeatedReason
    ? Number(repeatedReason.priorDeclines) + 1
    : effectiveCount + 1;

  const methodClass = "recurring_decline_after_user_feedback";
  const classOfMistake = bounded(
    repeatedReason
      ? "评审用同一个理由反复拒绝同一类问题，而从不去验证这个理由是否成立：用户已明确反馈，评审却拿同一句话当作新的判断，导致该问题反复发生却始终没有沉淀。"
      : "同一类问题在评审中反复被拒为「不足以沉淀」的时机/证据门槛不成立：用户已明确反馈，评审却以事后纠正、未部署、用户转述或前瞻建议为由拒绝沉淀，导致该问题反复发生却从未被记入反思。",
    2_048
  );
  const userComplaint = bounded(
    verdict?.incident_summary || joinSummaries(inWindow),
    2_048
  );
  const rootCause = bounded(
    repeatedReason
      ? `评审第 ${total} 次用「${repeatedReason.reasonCode}」拒绝这一类问题，而该理由此前已经用过 ${repeatedReason.priorDeclines} 次。重复使用同一理由说明这个理由本身从未被检验，不是判断而是习惯。`
      : "评审把「是否值得沉淀」建立在 agent 是否已经事后纠正或是否已部署上，而不是建立在用户是否明确反馈、agent 是否第一时间就做错上。事后承认不能防止下次再犯，所以这类问题每次都被放过。",
    2_048
  );
  const facts = [
    bounded(
      repeatedReason
        ? `该族问题已被同一理由「${repeatedReason.reasonCode}」拒绝 ${total} 次（含本次），首次 ${String(repeatedReason.firstSeen ?? "未知").slice(0, 10)}，最近 ${String(repeatedReason.lastSeen ?? "未知").slice(0, 10)}。`
        : "该族问题已在本窗口内被评审拒绝 " + total + " 次（含本次），每次理由不同但均未沉淀。",
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

  // Selection matches a future session's OPENING request by literal word
  // overlap, so the condition has to be phrased in the vocabulary the user will
  // actually type — not in the vocabulary of a complaint.
  //
  // The previous version echoed 100 characters of the incident summary and
  // appended "或按群类型/项目归属/现场归属/日志时间窗下判断之前". That tail is
  // generic to the point of matching every prompt, and the echo is a whole
  // paragraph: measured on a live project, the condition for a UI-style lesson
  // became a 100-character run-on that mentioned 表单/置灰/TypeError/截图, so a
  // prompt saying "页面样式不对" matched neither it nor anything else usefully.
  //
  // What survives is the incident's own distinctive terms, deduplicated and
  // capped, so the condition reads as "before doing X / when the user says Y"
  // using the words that actually appeared in the complaint.
  const incidentTerms = distinctTerms(verdict?.incident_summary, 6);
  const incidentEcho = bounded(incidentTerms.join("、"), 90);
  const appliesWhen = [
    incidentEcho
      ? bounded(`当任务涉及「${incidentEcho}」时，或用户以相近说法指出同类问题时`, 160)
      : null,
    incidentEcho
      ? bounded(`when the task involves ${incidentEcho}, or the user raises the same class of problem in similar words`, 160)
      : null,
    "当用户对 agent 的工作表达明确不满、指出其理解错或范围做过头时",
    "when the user explicitly expresses dissatisfaction or points out that the agent misunderstood the scope"
  ].filter(Boolean).slice(0, 16);

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
