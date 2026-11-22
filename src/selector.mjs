import { createHash } from "node:crypto";

import { readReflectionCatalog } from "./reflection-document.mjs";
import { mergeReflectionDocuments } from "./reflection-merge.mjs";

const HARD_LIMITS = Object.freeze({
  maxFileBytes: 131_072,
  // The card count, not the token budget, was the binding constraint. Measured
  // over 90 real prompts across three projects: at 4 the selector kept 3.5
  // lessons per turn and dropped 962 as `count_budget`; lifting the cap to 6
  // raised that to 4.9 lessons and cut the drops to 424, while the matching
  // lesson was reached on 8 prompts instead of 6.
  //
  // The old figure of 4 predates any measurement of what a turn can carry. It
  // was a safety margin, and it was costing real coverage: the fourth-priority
  // document was thrown away even when it was the only one on topic, because
  // the budget had room for it.
  maxCards: 6,
  maxDocumentTokens: 640,
  // Raised from 1600. The rules block (2.3 KB) plus the reflection documents
  // (3.9 KB) came to 6.2 KB of a prompt that routinely carries far more. With
  // the injected copy compressed (class_of_mistake dropped, two method changes
  // instead of four) a document costs ~449 tokens, so this fits five.
  maxTotalTokens: 2400
});

/**
 * What goes into the injected text, as opposed to what selection matches on.
 *
 * Matching runs over the FULL document (every applies_when entry, every method
 * change), so trimming the injected copy costs no recall — it only stops the
 * model from being shown the same match surface twice.
 *
 * The budget is the binding constraint, not the document count. Measured on one
 * project: a document costs 586 tokens on average against a 640-token per-document
 * cap and a 1600-token per-turn cap, so two of four slots actually filled and 12
 * of 46 documents exceeded the per-document cap outright and could never be
 * selected at all. The documents that never reached a session were the LONGER
 * ones (4.3 conditions, 320 chars) against those that did (3.2, 204) — the
 * failure was verbosity, not quality.
 *
 * Where the bytes went, and what this keeps:
 *
 *   method_changes   45%   the instruction — kept, trimmed to the two that act
 *   applies_when     39%   the match surface — kept whole, trimming costs recall
 *   class_of_mistake 16%   explanation only — dropped
 *
 * `class_of_mistake` never participates in matching. It is a prose description of
 * the failure for a human reader, and the rules block already carries an incident
 * summary for families that reach it. Removing it from the injected copy took a
 * document from 536 to 449 tokens, which is one more lesson per turn at the same
 * budget.
 */
const GUIDANCE_LIMITS = Object.freeze({
  appliesWhen: 3,
  // Two, not four. Selection ranks by relevance and severity, so the first two
  // are the ones that matter; the rest was bulk that pushed other lessons out of
  // the turn. Measured: dropping to two raised lessons-selected-per-turn from
  // 2.5 to 3.4 and double the rate at which a matching lesson was reached.
  methodChanges: 2,
  methodChangeChars: 300
});
const SEVERITY_RANK = Object.freeze({ Major: 1, Critical: 2, Blocker: 3 });
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const LATIN_WORD = /[\p{Script=Latin}\p{Number}]+/gu;
const TOKEN_PART = /[A-Za-z0-9]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[^\s]/gu;
const CATALOG_REASON = Object.freeze({
  file_too_large: "oversized_document",
  max_files_exceeded: "catalog_limit",
  legacy_incomplete: "legacy_incomplete",
  published_after_cutoff: "published_after_cutoff"
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Terms that appear across most lessons carry no discriminating power, but they
 * dominate a naive overlap count all the same.
 *
 * This list already existed in the rules-block channel; selection had none, and
 * that asymmetry produced the false matches. Measured over 13 unrelated requests
 * against a live project, every false positive rested on one of these terms:
 * 「加一个接口，返回用户列表」 matched a lesson on 一个/用户/返回/列表 and reached a
 * score of 16, 「写一个 README」 matched on 一个 alone. With them removed, the same
 * 13 requests produced no match at all.
 *
 * Kept deliberately short and additive to the rules-block list rather than a
 * second, divergent one: the two channels answer the same question, and a term
 * that is noise for one is noise for the other.
 */
const GENERIC_TERMS = new Set([
  "用户", "问题", "必须", "不是", "不要", "需要", "执行", "处理", "时候", "已经",
  "事情", "东西", "这个", "这些", "那样", "之前", "之后", "而是", "所以", "因为",
  "一个", "一下", "可以", "什么", "怎么", "还是", "没有", "现在", "然后", "如果",
  "就是", "这样", "但是", "只是", "应该", "可能", "知道", "或者", "以及", "进行",
  "通过", "我的", "你的", "他们", "也要", "一起", "直接", "现在", "全部", "开始",
  // Politeness and deictic filler. These were missing and became visible the
  // moment user_complaint started participating in matching: 「帮我看看这个文件」,
  // a request about nothing in particular, overlapped a chart lesson on 帮我 and
  // 看看 alone and injected it. They carry no subject, so they cannot be allowed
  // to decide which lesson applies.
  "帮我", "给你", "我看", "看看", "看下", "一下", "这个", "那个", "这些", "那些",
  "上面", "下面", "看看这", "麻烦", "谢谢", "请问", "能否", "是否", "有没有",
  // Nouns so general they name no subject at all. 「帮我看看这个文件」 matched a
  // PDF-font lesson on 文件 alone and scored exactly the floor of 4, so a request
  // about nothing in particular injected a lesson about printing. Measured across
  // one live project: 文件 appears in 55 of 129 documents, which is the definition
  // of a term that cannot say WHICH lesson applies.
  "文件", "内容", "东西", "情况", "问题", "方式", "方法", "地方", "部分", "方面",
  "user", "the", "and", "for", "when", "with", "that", "this", "from", "into",
  "must", "never", "always", "agent", "should", "before", "after", "same",
  "not", "are", "was", "has", "have", "its", "one", "only", "than", "run", "runs"
]);

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

function textFeatures(values) {
  const latin = new Set();
  const cjk = new Set();
  for (const source of Array.isArray(values) ? values : [values]) {
    const value = normalize(source);
    for (const token of value.match(LATIN_WORD) ?? []) {
      if (!GENERIC_TERMS.has(token)) latin.add(token);
    }
    for (const run of value.match(CJK_RUN) ?? []) {
      const points = Array.from(run);
      for (let index = 0; index + 1 < points.length; index += 1) {
        const bigram = `${points[index]}${points[index + 1]}`;
        if (!GENERIC_TERMS.has(bigram)) cjk.add(bigram);
      }
    }
  }
  return { latin, cjk };
}

function exactMetadataMatches(document, task) {
  const targets = new Set([
    ...(document.appliesWhen ?? []),
    document.classOfMistake,
    document.methodClass,
    ...(document.methodChanges ?? [])
  ].map(normalize).filter(Boolean));
  const metadata = new Set([
    ...(Array.isArray(task?.paths) ? task.paths : []),
    ...(Array.isArray(task?.tools) ? task.tools : [])
  ].map(normalize).filter(Boolean));
  let matches = 0;
  for (const value of metadata) if (targets.has(value)) matches += 1;
  return matches;
}

/**
 * A term shared by this share of the candidate lessons says nothing about which
 * one applies. Same ratio, same reasoning, as the rules-block channel — the two
 * channels answer the same question and must agree about what counts as signal.
 */
const DISTINCTIVE_DF_RATIO = 0.5;

/**
 * The bar a match must clear when no lesson can be told apart from the others.
 *
 * Only used in that case — see the separability block in selectReflections. It is
 * deliberately above the noise range measured on an unrelated request against a
 * live project (top score ~6), because a shared condition is what an accidental
 * match looks like and there is no distinctive term left to tell them apart.
 */
const AMBIGUOUS_SCORE_FLOOR = 10;

/**
 * The lowest score any selected lesson may carry, separable or not.
 *
 * The distinctive floor answers "can I tell these lessons apart"; it does not
 * answer "does anything apply". After it was made available-aware (a two-term
 * message like 「又不知道用ssh密码」 can never supply four distinctive terms), a
 * message with ONE shared term cleared a floor of one and injected lessons at
 * score 4. Measured: 「今天天气怎么样」 selected two lessons.
 *
 * Four is where the ranges separate on real data: the weakest genuine match
 * (「部署上去」 against the deployment lesson) scores 4.0, while unrelated prompts
 * top out at 1.0-3.0.
 */
const MIN_SELECTED_SCORE = 4;

/**
 * Which terms a lesson is about, and how strongly each one counts.
 *
 * A term's weight is the strongest field it appears in, not the sum: a condition
 * that appears in both applies_when and the method text is one condition, and
 * adding the two weights would let a verbose lesson outrank a focused one.
 *
 * Cached per document object. The document set is re-read on every prompt, but
 * within one process the same objects are scored against several texts (the
 * current message, then the conversation), and rebuilding this map for each is
 * pure waste.
 */
const TERM_WEIGHT_CACHE = new WeakMap();

function lessonTermWeights(document) {
  const cached = TERM_WEIGHT_CACHE.get(document);
  if (cached) return cached;
  const weights = new Map();
  // A bare numeral is not a term. Lesson ids and fixture names carry digits
  // (`class_1`, `family-2`), so a reply of 「1」 otherwise matched one of them and
  // counted as a distinctive hit — which told the selector the message had a
  // subject of its own and stopped it from falling back to the conversation. The
  // measured effect was a single digit silently suppressing the context path.
  const isNumber = (term) => /^\d+$/u.test(term);
  const fields = [
    [4, textFeatures(document.appliesWhen ?? [])],
    [3, textFeatures(document.classOfMistake)],
    [2, textFeatures(document.methodClass)],
    [1, textFeatures(document.methodChanges ?? [])],
    // The complaint, in the user's own words.
    //
    // This field has been stored since the format existed and was never matched
    // against — the selector read four fields and skipped it. It is the only
    // place a lesson records what the user actually SAID, and matching is
    // literal word overlap, so its absence is measured: an indirect request
    // ("这张表加几个字段") reached its lesson 1 time in 3 with conditions alone,
    // and 3 in 3 once the user's own phrasing was available to match.
    //
    // Weighted 3, level with class_of_mistake: it is evidence of the real
    // situation, but it is a record of one utterance, and a lesson must not be
    // reachable only by someone who phrases it the same way. The condition field
    // keeps its 4 so a well-written condition still outranks a quoted sentence.
    [3, textFeatures(document.userComplaint ?? "")],
    // root_cause is the reviewer's diagnosis, not the user's words, and it is
    // weighted separately and lower for that reason. Folding it in with
    // user_complaint made the two indistinguishable: a request that touched only
    // a phrase from the diagnosis scored exactly as if the user had said it.
    [2, textFeatures(document.rootCause ?? "")]
  ];
  for (const [weight, features] of fields) {
    for (const term of features.latin) {
      if (isNumber(term)) continue;
      const key = `l\u0000${term}`;
      if ((weights.get(key) ?? 0) < weight) weights.set(key, weight);
    }
    for (const term of features.cjk) {
      const key = `c\u0000${term}`;
      if ((weights.get(key) ?? 0) < weight) weights.set(key, weight);
    }
  }
  TERM_WEIGHT_CACHE.set(document, weights);
  return weights;
}

/**
 * How much this lesson is about this text, and on how many uncommon terms that
 * rests.
 *
 * Both halves are needed. The score alone cannot separate a real match from an
 * accident once the text may be a whole conversation: measured over 187 real
 * turns of one project, every candidate scored above the noise floor on every
 * turn — 5,955 selections for 187 turns, so the budget was always full and the
 * ranking was decided by whatever bigrams happened to line up. On a labelled set
 * that showed up as 7 of 13 unrelated requests pulling in a lesson about
 * credentials.
 *
 * `distinctive` is the half that fixes it, and it is the same guard the
 * rules-block channel already applies: a match resting only on terms shared
 * across half the project carries no information about WHICH lesson applies. The
 * two channels answered the same question differently, which is how a request
 * for "跑一下测试" could arrive carrying a lesson about SSH.
 */
function promptMatch(document, promptFeatures, task, documentFrequency, distinctiveLimit) {
  const weights = lessonTermWeights(document);
  let lexical = 0;
  let distinctive = 0;
  for (const term of promptFeatures.latin) {
    const weight = weights.get(`l\u0000${term}`);
    if (weight === undefined) continue;
    lexical += weight;
    if ((documentFrequency.get(`l\u0000${term}`) ?? 0) <= distinctiveLimit) distinctive += 1;
  }
  for (const term of promptFeatures.cjk) {
    const weight = weights.get(`c\u0000${term}`);
    if (weight === undefined) continue;
    lexical += weight;
    if ((documentFrequency.get(`c\u0000${term}`) ?? 0) <= distinctiveLimit) distinctive += 1;
  }
  const metadata = 8 * exactMetadataMatches(document, task);
  // Square root rather than the full count: linear normalisation would make a
  // lesson that genuinely matches a long report score lower than one that
  // coincidentally matches a short message. The root keeps longer matches ahead
  // while stopping the count from growing with text length alone.
  const promptTermCount = promptFeatures.latin.size + promptFeatures.cjk.size;
  const scale = Math.max(1, Math.sqrt(promptTermCount / 8));
  return {
    relevanceScore: Math.min(40, (lexical + metadata) / scale),
    distinctive,
    // An exact path or tool match is not an accident of shared vocabulary, so it
    // satisfies the distinctive check on its own. Without this a task-scoped
    // lesson — the one case where the match is certain — would be the one case
    // the floor rejected.
    exactMatch: metadata > 0
  };
}

function boundedLimit(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, fallback) : fallback;
}

function limitsFrom(budget = {}) {
  return {
    maxCards: boundedLimit(budget.maxCards, HARD_LIMITS.maxCards),
    maxDocumentTokens: boundedLimit(budget.maxDocumentTokens, HARD_LIMITS.maxDocumentTokens),
    maxTotalTokens: boundedLimit(budget.maxTotalTokens, HARD_LIMITS.maxTotalTokens)
  };
}

function clip(value, max) {
  const text = String(value ?? "");
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  // Cut on a clause boundary when one is near the end, so a clipped condition
  // still reads as a complete phrase instead of stopping mid-word.
  const clipped = chars.slice(0, max).join("");
  const boundary = Math.max(
    clipped.lastIndexOf("；"), clipped.lastIndexOf("。"), clipped.lastIndexOf("，"), clipped.lastIndexOf("; ")
  );
  return `${(boundary > max * 0.6 ? clipped.slice(0, boundary) : clipped).trimEnd()}…`;
}

/**
 * The text injected into the model's context.
 *
 * Deliberately narrower than the document: selection matched on every
 * applies_when entry and every method change, and repeating all of them here
 * doubles the cost for no extra recall.
 *
 * The list of applies_when entries is capped, not the document: a lesson with
 * twelve conditions still matches on all twelve, it just shows the first few.
 *
 * When `pointerOnly` is set the document body is replaced by a reference. That
 * is the case when the rules block already carries this document's family: the
 * block renders the same method changes from the same file, so sending both is
 * one lesson twice in one prompt. Measured on a live project, the selected
 * documents accounted for 4.7 KB of a 6.9 KB injection while the layered rules
 * block — which held every one of those lessons, plus the index — cost 1.8 KB.
 *
 * A pointer still carries the hash, so "was this lesson delivered" stays
 * answerable from the session, and the path, so the reader can open the whole
 * incident when the summary is not enough. What it drops is the duplication.
 */
function documentGuidance(document, { pointerOnly = false } = {}) {
  if (pointerOnly) {
    return [
      `document_hash: ${document.documentHash}`,
      `（本家族的完整条目已在上方规则块中，此处只登记送达；需要完整经过时读 ${document.path ?? "对应反思文档"}）`
    ].join("\n");
  }
  const conditions = (document.appliesWhen ?? []).slice(0, GUIDANCE_LIMITS.appliesWhen);
  const changes = (document.methodChanges ?? []).slice(0, GUIDANCE_LIMITS.methodChanges);
  const lines = [
    // Kept despite costing ~21 tokens: it is the only handle that ties the text
    // the model sees back to the exact document in the store, which is what makes
    // "was this lesson actually delivered" answerable from the session itself.
    `document_hash: ${document.documentHash}`,
    "applies_when:",
    ...conditions.map((value) => `- ${clip(value, GUIDANCE_LIMITS.methodChangeChars)}`)
  ];
  if ((document.appliesWhen ?? []).length > conditions.length) {
    lines.push(`- (共 ${(document.appliesWhen ?? []).length} 条匹配条件，此处只列前 ${conditions.length} 条)`);
  }
  lines.push("method_changes:");
  for (const [index, value] of changes.entries()) {
    lines.push(`${index + 1}. ${clip(value, GUIDANCE_LIMITS.methodChangeChars)}`);
  }
  if ((document.methodChanges ?? []).length > changes.length) {
    lines.push(`(共 ${(document.methodChanges ?? []).length} 条方法，此处只列前 ${changes.length} 条)`);
  }
  return lines.join("\n");
}

export function estimateGuidanceTokens(value) {
  let total = 0;
  for (const part of String(value ?? "").match(TOKEN_PART) ?? []) {
    total += /^[A-Za-z0-9]+$/u.test(part) ? Math.ceil(part.length / 4) : 1;
  }
  return total;
}

function stableIdentity(document) {
  return document.documentHash || document.reflectionId || "";
}

function omission(document, reason) {
  return { documentHash: stableIdentity(document), reason };
}

function compareNewest(left, right) {
  const time = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (time !== 0) return time;
  const leftId = left.reflectionId ?? "";
  const rightId = right.reflectionId ?? "";
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

/**
 * Ranking order for equally relevant lessons.
 *
 * `familyRecurrence` used to outrank recency, which permanently buried a lesson
 * the moment it was written: a family that recurred 99 times months ago kept the
 * slot against the document written yesterday, which had recurred once. Measured
 * adversarially — one new document against eight old ones, all at the same
 * relevance — the new one was dropped every time.
 *
 * That inverts the point of the system. A lesson written today describes the
 * problem the user is hitting now; one from three months ago describes what they
 * were hitting then. The count says how often it mattered historically, not
 * whether it is the one that matters today.
 *
 * So recency leads and the count breaks ties, which keeps the old behaviour
 * where it was right: among documents of the same age, the one that keeps
 * recurring still wins.
 */
function rankKey(document) {
  return [
    // A family whose lesson was already in front of the agent when the same
    // complaint happened again has been contradicted by evidence. It is not
    // removed — its subject may still be right — but it loses the slot to a
    // lesson that has never been disproven. See src/reflection-lifecycle.mjs.
    -(document.relevanceScore * (document.lifecycleWeight ?? 1)),
    -(SEVERITY_RANK[document.finalSeverity] ?? 0),
    // Newest first. An undatable document sorts last rather than crashing.
    -(Date.parse(document.createdAt) || 0),
    -document.familyRecurrence,
    document.reflectionId ?? ""
  ];
}

function compareRank(left, right) {
  const leftKey = rankKey(left);
  const rightKey = rankKey(right);
  for (let index = 0; index < leftKey.length; index += 1) {
    if (leftKey[index] < rightKey[index]) return -1;
    if (leftKey[index] > rightKey[index]) return 1;
  }
  const leftIdentity = stableIdentity(left);
  const rightIdentity = stableIdentity(right);
  return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
}

function emissionMatches(prior, document, session, task) {
  return (prior?.documentHash ?? prior?.document_hash) === document.documentHash
    && (prior?.sessionUid ?? prior?.session_uid) === (session?.sessionUid ?? session?.session_uid)
    && Number(prior?.contextEpoch ?? prior?.context_epoch) === Number(session?.contextEpoch ?? session?.context_epoch)
    && (prior?.taskFingerprint ?? prior?.task_fingerprint) === (task?.fingerprint ?? task?.taskFingerprint ?? task?.task_fingerprint);
}

function completeDocument(document) {
  return Boolean(document && typeof document === "object"
    && typeof document.documentHash === "string"
    && typeof document.familyId === "string"
    && typeof document.createdAt === "string"
    && Array.isArray(document.appliesWhen)
    && typeof document.classOfMistake === "string"
    && Array.isArray(document.methodChanges)
    && document.methodChanges.length > 0);
}

export async function loadReflectionDocuments({
  projectDir,
  publishedBefore,
  maxFileBytes = HARD_LIMITS.maxFileBytes,
  merge = true
}) {
  const catalog = await readReflectionCatalog({
    projectDir,
    publishedBefore,
    maxFileBytes: boundedLimit(maxFileBytes, HARD_LIMITS.maxFileBytes)
  });
  // One file per reviewed incident means a class the user keeps hitting arrives
  // as N near-identical documents, each competing for the same injection budget
  // as a genuinely different lesson. Collapsing them here — at read time, never
  // on disk — keeps the delivery log's document hashes intact while freeing the
  // budget for the lessons that differ.
  const { documents, mergedGroups } = merge
    ? mergeReflectionDocuments(catalog.documents)
    : { documents: catalog.documents, mergedGroups: [] };
  return {
    documents,
    mergedGroups,
    omissions: catalog.omissions.map((item) => ({
      opaqueId: sha256(`catalog\u0000${item.path}`),
      reason: CATALOG_REASON[item.omission] ?? "parse_error"
    }))
  };
}

export function selectReflections({
  documents,
  prompt,
  // The preceding user messages in this session, if the caller has them. Used
  // only as a fallback when `prompt` carries no distinctive subject of its own —
  // never merged into one string with it. See the ranking block below.
  context = "",
  session,
  task,
  budget,
  priorEmissions = [],
  publishedBefore,
  familyRecurrence = {},
  // Per-family lifecycle state, from src/reflection-lifecycle.mjs. Only
  // "recurred" changes anything: it demotes a family whose lesson was already in
  // front of the agent when the same complaint happened again. Absent entries
  // rank at full weight, so a caller that does not compute states behaves as it
  // did before.
  familyLifecycle = {},
  coveredFamilies = null,
  // The families the rules block rendered IN FULL this turn. Distinct from
  // coveredFamilies, which is what selection must skip; this is what selection
  // may compress to a pointer because the instructions are already above it.
  expandedFamilies = null,
  // The text the rules block already contributed to this same prompt. Used to
  // detect a document whose instructions are already stated verbatim above it;
  // family identity cannot catch that, because the duplicated sentences come
  // from a shared template rather than from a shared family.
  injectedText = "",
  familyKeyOf = null
}) {
  const limits = limitsFrom(budget);
  const cutoffMs = Date.parse(publishedBefore);
  if (!Number.isFinite(cutoffMs)) throw new TypeError("publishedBefore must be a valid timestamp");
  // Which key the caller's lifecycle map uses for this document. The store's
  // states are keyed by reviewer family_key; the document carries a derived
  // `family-<sha20>` id. They are different namespaces, so the lookup has to go
  // through the same resolver selection already uses to recognise a covered
  // family — otherwise the demotion is looked up under a key that never exists.
  const lifecycleKeyOf = (document) => {
    if (typeof familyKeyOf === "function") {
      try {
        const key = familyKeyOf(document);
        if (key) return key;
      } catch {
        // Fall through to the document id.
      }
    }
    return document.familyId;
  };
  const ordered = [...(Array.isArray(documents) ? documents : [])]
    .sort((left, right) => stableIdentity(left).localeCompare(stableIdentity(right), "en-US"));
  const omissions = [];
  const loaded = [];
  for (const document of ordered) {
    if (!completeDocument(document)) {
      omissions.push(omission(document, document?.canonical === false ? "legacy_incomplete" : "parse_error"));
      continue;
    }
    if (!Number.isFinite(Date.parse(document.publishedAt)) || Date.parse(document.publishedAt) >= cutoffMs) {
      omissions.push(omission(document, "published_after_cutoff"));
      continue;
    }
    loaded.push(document);
  }

  // A family that reached the rules tier is injected on every prompt by the
  // every-turn block. Selecting its document here too would put the same lesson
  // in one prompt twice and spend the selection budget on a repeat — measured
  // on a live project, 29 of 53 catalog documents duplicated a family the rules
  // block already carried. The block is the mechanical channel; selection is
  // for everything that did not make that cut.
  let candidates = loaded;
  if (coveredFamilies && typeof coveredFamilies.has === "function" && typeof familyKeyOf === "function") {
    const kept = [];
    for (const document of loaded) {
      let familyKey = null;
      try {
        familyKey = familyKeyOf(document);
      } catch {
        familyKey = null;
      }
      if (familyKey && coveredFamilies.has(familyKey)) {
        omissions.push(omission(document, "covered_by_rules"));
        continue;
      }
      kept.push(document);
    }
    candidates = kept;
  }

  // How often each family has actually recurred. Counting documents instead
  // only ever yields 1, because family projection keeps one document per
  // family — so without this the tie-break carried no information at all.
  const recurrence = new Map();
  for (const document of candidates) recurrence.set(document.familyId, (recurrence.get(document.familyId) ?? 0) + 1);
  for (const [familyId, occurrences] of Object.entries(familyRecurrence ?? {})) {
    if (Number.isSafeInteger(occurrences) && occurrences > 0) {
      recurrence.set(familyId, Math.max(recurrence.get(familyId) ?? 0, occurrences));
    }
  }
  const scored = [];
  const distinctiveFloor = Math.max(1, Math.ceil(Math.sqrt(candidates.length) / 2));
  const distinctiveLimit = Math.max(1, Math.floor(candidates.length * DISTINCTIVE_DF_RATIO));

  // Document frequency over this project's own lessons, not a general corpus.
  // Counting is per distinctive term identity (`l\0word` / `c\0bigram`) because
  // a Latin word and a CJK bigram can spell the same string, and a match on one
  // must not make the other look common.
  const documentFrequency = new Map();
  for (const document of candidates) {
    for (const [key] of lessonTermWeights(document)) {
      documentFrequency.set(key, (documentFrequency.get(key) ?? 0) + 1);
    }
  }

  // Which text decides this turn — decided ONCE for the whole turn.
  //
  // The conversation says what the work is ABOUT; the message says what is being
  // ASKED right now, and those are not the same question once a session runs for
  // a while. Scored as one concatenated text, the longer side always won: the
  // topic set up twenty turns ago drowned out a message that had changed the
  // subject, and measured on a real session the selector kept returning the SSH
  // lesson when the user had moved on to page styling.
  //
  // The choice must be global, not per-document. Deciding it document by
  // document lets every lesson that matches the current message poorly fall back
  // to the conversation and score high there, while the one lesson the message
  // actually matches keeps its honest, lower score — so the fallback outranks the
  // real answer. Measured exactly that way: 「这个页面的样式跟上面不一致」 with an
  // SSH conversation put the SSH lesson first and the styling lesson behind it.
  //
  // So: does the current message distinguish ANY lesson? If yes it is the
  // subject, and the conversation is ignored for ranking. If no — 「B」, 「好」,
  // 「继续」 — the whole turn falls back, because the message carries no subject
  // of its own and the only thing left to go on is what the session is about.
  const currentFeatures = textFeatures(prompt);
  const contextFeatures = textFeatures(context);
  const hasContext = contextFeatures.latin.size + contextFeatures.cjk.size > 0;

  // How many distinctive terms the message has to offer at all.
  //
  // The corpus-scaled floor below asks for four, which is right when the message
  // is a paragraph. It is impossible for a message that only contains two rare
  // terms in total: 「又不知道用ssh密码」 is exactly that — ssh and 密码 are the
  // evidence, everything else in it is 又不/不知/知道, shared with every other
  // complaint in the project. Demanding four distinctive matches from a message
  // that only HAS two rejects the most direct complaint about credentials on
  // record, which is the failure this whole project exists to prevent.
  //
  // So the floor is capped by what the message can supply. A short, precise
  // message asks for less because it offers less, not because it is weaker
  // evidence — and two rare terms that both point at the same lesson are stronger
  // evidence than four scattered ones.
  //
  // Zero is a different case from "few". A message that shares no distinctive
  // term with any lesson cannot establish separability at all, so the floor must
  // not collapse to 1 — that would be the most permissive setting on the exact
  // input that carries the least signal, which is backwards. Measured that way:
  // 「今天天气怎么样」 matched two lessons at score 4.
  const availableDistinctive = candidates.reduce((best, document) => {
    let count = 0;
    const weights = lessonTermWeights(document);
    for (const term of currentFeatures.latin) {
      if (weights.has(`l\u0000${term}`) && (documentFrequency.get(`l\u0000${term}`) ?? 0) <= distinctiveLimit) count += 1;
    }
    for (const term of currentFeatures.cjk) {
      if (weights.has(`c\u0000${term}`) && (documentFrequency.get(`c\u0000${term}`) ?? 0) <= distinctiveLimit) count += 1;
    }
    return Math.max(best, count);
  }, 0);
  const effectiveFloor = availableDistinctive > 0
    ? Math.min(distinctiveFloor, availableDistinctive)
    : distinctiveFloor;

  const fromPromptAll = candidates.map((document) =>
    promptMatch(document, currentFeatures, task, documentFrequency, distinctiveLimit));
  const promptSeparates = fromPromptAll.some((match) => match.distinctive >= effectiveFloor);
  const useContext = hasContext && !promptSeparates;

  for (const [index, document] of candidates.entries()) {
    const chosen = useContext
      ? promptMatch(document, contextFeatures, task, documentFrequency, distinctiveLimit)
      : fromPromptAll[index];
    if (chosen.relevanceScore <= 0) {
      omissions.push(omission(document, "not_applicable"));
      continue;
    }
    scored.push({ document, ...chosen });
  }

  // Is there ANY lesson this prompt can be told apart by?
  //
  // The floor below rejects a match that rests only on terms shared across half
  // the project — those terms cannot say WHICH lesson applies. But that breaks
  // on a project whose lessons genuinely share a condition: with five lessons all
  // written for 「修改已有架构前先核对用户目标」, that condition IS the answer for
  // all five, and every one of them scores zero distinctive terms. Rejecting them
  // all would turn a well-covered class into a total miss.
  //
  // So the floor applies only when some lesson CAN be distinguished. When none
  // can, the prompt matched a shared condition rather than a separating one, and
  // the honest response is to rank by score alone — with a higher bar, because a
  // shared condition is exactly what an accidental match looks like. Measured on
  // a labelled set of 13 unrelated requests against a live project: this held
  // back all 13 while keeping 14 of 14 real ones.
  const maxDistinctive = scored.reduce((best, entry) => Math.max(best, entry.distinctive), 0);
  const separabilityRequired = maxDistinctive >= effectiveFloor;

  const applicable = [];
  for (const { document, ...entry } of scored) {
    if (separabilityRequired
      ? entry.distinctive < effectiveFloor && !entry.exactMatch
      : entry.relevanceScore < AMBIGUOUS_SCORE_FLOOR) {
      omissions.push(omission(document, "ambiguous_match"));
      continue;
    }
    if (entry.relevanceScore < MIN_SELECTED_SCORE) {
      omissions.push(omission(document, "not_applicable"));
      continue;
    }
    applicable.push({
      ...document,
      finalSeverity: document.severity,
      relevanceScore: entry.relevanceScore,
      familyRecurrence: recurrence.get(document.familyId),
      // The lifecycle is keyed by reviewer family_key, not by the document's
      // derived familyId: `family-<sha20>` is a hash of (method_class, key), and
      // looking it up against the store's keys matched nothing — demotion was
      // computed and then never applied. Fall back to familyId so a caller that
      // supplies states keyed by document (the lifecycle eval does) still works.
      lifecycleWeight: familyLifecycle[lifecycleKeyOf(document)] === "recurred" ? 0.5 : 1
    });
  }

  const projected = new Map();
  for (const document of applicable) {
    const current = projected.get(document.familyId);
    if (!current || compareNewest(document, current) > 0) {
      if (current) omissions.push(omission(current, "family_projection"));
      projected.set(document.familyId, document);
    } else {
      omissions.push(omission(document, "family_projection"));
    }
  }

  const ranked = [];
  for (const document of projected.values()) {
    if (priorEmissions.some((prior) => emissionMatches(prior, document, session, task))) {
      omissions.push(omission(document, "prior_emission"));
      continue;
    }
    ranked.push(document);
  }
  ranked.sort(compareRank);

  const budgeted = [];
  for (const document of ranked) {
    // When is a document's body redundant with what the rules block already
    // put in this same prompt? Two distinct cases, and the second is the one
    // that actually occurs:
    //
    // 1. Its family was expanded in full above. Selection normally skips those
    //    already (covered_by_rules), so this is a belt-and-braces check for a
    //    family that resolved here but not there.
    // 2. Its instructions already appear verbatim in the block. This is the
    //    real case: the escalation template writes the same two method sentences
    //    for every family it rescues, so a document for family A repeats what
    //    the block says about family B. Measured on a live project, the injected
    //    document was 1,492 B and both of its method changes were byte-identical
    //    to lines already in the block — 2 of 2.
    //
    // Identity alone cannot catch case 2; the families genuinely differ. Only
    // comparing the text can, so that is what decides.
    let pointerOnly = false;
    if (expandedFamilies && typeof expandedFamilies.has === "function" && typeof familyKeyOf === "function") {
      try {
        const familyKey = familyKeyOf(document);
        pointerOnly = Boolean(familyKey && expandedFamilies.has(familyKey));
      } catch {
        pointerOnly = false;
      }
    }
    if (!pointerOnly && injectedText) {
      const changes = (document.methodChanges ?? []).filter((entry) => String(entry ?? "").trim());
      const unique = changes.filter((entry) => !injectedText.includes(clip(entry, GUIDANCE_LIMITS.methodChangeChars)));
      pointerOnly = changes.length > 0 && unique.length === 0;
    }
    const guidance = documentGuidance(document, { pointerOnly });
    const tokenEstimate = estimateGuidanceTokens(guidance);
    if (tokenEstimate > limits.maxDocumentTokens) {
      omissions.push(omission(document, "token_budget"));
      continue;
    }
    budgeted.push({ ...document, guidance, tokenEstimate, pointerOnly });
  }

  const selected = [];
  let tokenEstimate = 0;
  for (const document of budgeted) {
    if (selected.length >= limits.maxCards) {
      omissions.push(omission(document, "count_budget"));
      continue;
    }
    if (tokenEstimate + document.tokenEstimate > limits.maxTotalTokens) {
      omissions.push(omission(document, "token_budget"));
      continue;
    }
    selected.push(document);
    tokenEstimate += document.tokenEstimate;
  }

  return {
    guidance: selected.map((document) => document.guidance).join("\n\n"),
    selected: selected.map(({ guidance: ignored, ...document }) => document),
    omissions,
    tokenEstimate
  };
}
