import { createHash } from "node:crypto";

const ORDER = { Blocker: 0, Critical: 1, Major: 2, Minor: 3 };
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const DEFAULT_LIMITS = Object.freeze({ singleCardFloor: 192, singleCardHardLimit: 1600, maxCandidates: 12, maxSevereCards: 4 });
const GENERIC_LATIN_TERMS = new Set([
  "agent", "and", "are", "before", "current", "for", "from", "into", "says",
  "task", "the", "then", "use", "user", "using", "was", "were", "when", "with"
]);

export function estimateCardTokens(card, hostPrefix = "") {
  const text = `${hostPrefix}\n${JSON.stringify(card)}`;
  const cjkCount = (text.match(CJK_PATTERN) || []).length;
  const nonCjk = text.replace(CJK_PATTERN, "");
  // Local conservative estimate only. CJK characters are commonly close to
  // one token, while JSON/Latin text is budgeted more tightly than chars/4.
  return Math.ceil(cjkCount * 1.2 + Buffer.byteLength(nonCjk, "utf8") / 3 + 16);
}

export function applicationId({ sessionUid, contextEpoch, taskFingerprint, lessonId, revision }) {
  return createHash("sha256").update([sessionUid, contextEpoch, taskFingerprint, lessonId, revision].join("\u0000")).digest("hex");
}

function relevant(lesson, projectId) {
  return !lesson.project_id || lesson.project_id === projectId;
}

function normalizeRetrievalText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

function latinTerms(value) {
  return new Set((normalizeRetrievalText(value).match(/[a-z][a-z0-9+_.-]{2,}/g) || [])
    .filter((term) => !GENERIC_LATIN_TERMS.has(term)));
}

function cjkNgrams(value, size) {
  const result = new Set();
  const runs = String(value || "").normalize("NFKC").match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) || [];
  for (const run of runs) {
    for (let index = 0; index <= run.length - size; index += 1) result.add(run.slice(index, index + size));
  }
  return result;
}

function latinOverlapCount(left, right) {
  const leftTerms = latinTerms(left);
  const rightTerms = latinTerms(right);
  return [...rightTerms].filter((term) => leftTerms.has(term)).length;
}

function compactRetrievalText(value) {
  return normalizeRetrievalText(value).replace(/\s+/g, "");
}

function hasExplicitSignalMatch(prompt, signal) {
  if (!String(prompt || "").trim() || !String(signal || "").trim()) return false;
  const promptCompact = compactRetrievalText(prompt);
  const signalCompact = compactRetrievalText(signal);
  const signalHasCjk = CJK_PATTERN.test(signalCompact);
  CJK_PATTERN.lastIndex = 0;
  if (signalHasCjk && signalCompact.length >= 2 && promptCompact.includes(signalCompact)) return true;
  const signalLatin = latinTerms(signal);
  if (signalLatin.size === 0) return false;
  return latinOverlapCount(prompt, signal) >= Math.min(2, signalLatin.size);
}

function promptMentionsScopedTool(prompt, tools) {
  const promptNormalized = ` ${normalizeRetrievalText(prompt)} `;
  const promptCompact = compactRetrievalText(prompt);
  return tools.some((tool) => {
    const normalized = normalizeRetrievalText(tool);
    if (!normalized) return false;
    if (CJK_PATTERN.test(normalized)) {
      CJK_PATTERN.lastIndex = 0;
      const compact = normalized.replace(/\s+/g, "");
      return compact.length >= 2 && promptCompact.includes(compact);
    }
    CJK_PATTERN.lastIndex = 0;
    return promptNormalized.includes(` ${normalized} `);
  });
}

function hasActionConditionMatch(prompt, condition) {
  if (!String(prompt || "").trim() || !String(condition || "").trim()) return false;
  const promptCompact = compactRetrievalText(prompt);
  const conditionCompact = compactRetrievalText(condition);
  if (conditionCompact.length >= 8 && promptCompact.includes(conditionCompact)) return true;
  if (latinOverlapCount(prompt, condition) >= 2) return true;
  const promptCjk = cjkNgrams(prompt, 4);
  const conditionCjk = cjkNgrams(condition, 4);
  return [...promptCjk].some((term) => conditionCjk.has(term));
}

function pathScopeMatches(scopePaths, taskPaths) {
  return scopePaths.some((path) => taskPaths.some((candidate) => candidate === path || candidate.startsWith(`${path}/`)));
}

function lessonOriginatesFromSession(lesson, sessionUid) {
  if (!sessionUid) return false;
  return (lesson.card?.source_ids || []).some((sourceId) => String(sourceId).startsWith(`${sessionUid}:`));
}

function scopeMatches(lesson, task, session) {
  const scope = lesson.scope || {};
  const taskPaths = Array.isArray(task.paths) ? task.paths : [];
  const taskTools = Array.isArray(task.tools) ? task.tools : [];
  let positiveMatch = lessonOriginatesFromSession(lesson, session?.session_uid);

  if (scope.task_types?.length && task.task_type) {
    if (!scope.task_types.includes(task.task_type)) return false;
    positiveMatch = true;
  }
  if (scope.paths?.length && taskPaths.length > 0) {
    if (!pathScopeMatches(scope.paths, taskPaths)) return false;
    positiveMatch = true;
  }
  if (scope.tools?.length && taskTools.length > 0) {
    if (!scope.tools.some((tool) => taskTools.includes(tool))) return false;
    positiveMatch = true;
  }

  const prompt = String(task.prompt || "");
  if ((scope.signals || []).some((signal) => hasExplicitSignalMatch(prompt, signal))) positiveMatch = true;
  if (scope.tools?.length && promptMentionsScopedTool(prompt, scope.tools)) positiveMatch = true;
  if (lesson.card?.when && hasActionConditionMatch(prompt, lesson.card.when)) positiveMatch = true;

  return lesson.severity === "Major" ? positiveMatch : true;
}

function hasTaskScope(lesson) {
  const scope = lesson.scope || {};
  return [scope.task_types, scope.paths, scope.tools, scope.signals].some((value) => Array.isArray(value) && value.length > 0);
}

function percentile95(values) {
  if (values.length === 0) return DEFAULT_LIMITS.singleCardFloor;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

function deriveBudgets(costs, override) {
  const target = Math.min(
    DEFAULT_LIMITS.singleCardHardLimit,
    Math.max(DEFAULT_LIMITS.singleCardFloor, Math.ceil(percentile95(costs) * 1.2))
  );
  const absolute = Number.isFinite(override) && override > 0 ? Number(override) : target * DEFAULT_LIMITS.maxSevereCards;
  return {
    singleCardTarget: target,
    singleCardHardLimit: DEFAULT_LIMITS.singleCardHardLimit,
    normalSoft: Math.min(absolute, target * 2),
    severeReserve: Math.min(absolute, target * DEFAULT_LIMITS.maxSevereCards),
    absolute,
    maxCandidates: DEFAULT_LIMITS.maxCandidates,
    maxSevereCards: DEFAULT_LIMITS.maxSevereCards
  };
}

function strongerFamilyProjection(left, right) {
  const leftSeverity = ORDER[left.severity] ?? 99;
  const rightSeverity = ORDER[right.severity] ?? 99;
  if (leftSeverity !== rightSeverity) return rightSeverity < leftSeverity ? right : left;
  if (Number(left.revision || 0) !== Number(right.revision || 0)) return Number(right.revision || 0) > Number(left.revision || 0) ? right : left;
  if (right.promotion_state === "active_global" && left.promotion_state !== "active_global") return right;
  return left;
}

function dedupeFamilies(lessons) {
  const families = new Map();
  for (const lesson of lessons) {
    const key = lesson.family_id || `lesson:${lesson.lesson_id}`;
    const existing = families.get(key);
    families.set(key, existing ? strongerFamilyProjection(existing, lesson) : lesson);
  }
  return [...families.values()];
}

export function selectLessons({ lessons, session, task, budget, hostPrefix = "", store = null }) {
  const scoped = dedupeFamilies(lessons.filter((lesson) => lesson.enablement !== "disabled" && relevant(lesson, task.project_id) && scopeMatches(lesson, task, session)));
  const candidates = scoped.filter((lesson) => lesson.severity !== "Major" || hasTaskScope(lesson));
  const candidateCosts = candidates.map((lesson) => estimateCardTokens(lesson.card, hostPrefix));
  const budgets = deriveBudgets(candidateCosts, Number(budget));
  if (candidates.some((lesson) => lesson.conflict_state === "safety_hold" && (lesson.severity === "Blocker" || lesson.severity === "Critical"))) {
    return { cards: [], hold: "safety_hold", tokenEstimate: 0, budgets };
  }
  const selected = candidates
    .filter((lesson) => lesson.conflict_state === "none" && lesson.severity !== "Minor")
    .filter((lesson) => lesson.severity === "Blocker" || lesson.severity === "Critical" || lesson.load_policy !== "trend_only")
    .sort((a, b) => (ORDER[a.severity] ?? 99) - (ORDER[b.severity] ?? 99))
    .slice(0, budgets.maxCandidates);
  const severeCount = selected.filter((lesson) => lesson.severity === "Blocker" || lesson.severity === "Critical").length;
  if (severeCount > budgets.maxSevereCards) return { cards: [], hold: "memory_overflow_hold", tokenEstimate: 0, budgets };
  const cards = [];
  let tokenEstimate = 0;
  let majorTokens = 0;
  for (const lesson of selected) {
    const cost = estimateCardTokens(lesson.card, hostPrefix);
    const id = applicationId({ sessionUid: session.session_uid, contextEpoch: session.context_epoch, taskFingerprint: task.fingerprint, lessonId: lesson.lesson_id, revision: lesson.revision });
    if (store?.hasDelivery(id)) continue;
    const severe = lesson.severity === "Blocker" || lesson.severity === "Critical";
    if (cost > budgets.singleCardHardLimit || tokenEstimate + cost > budgets.absolute) {
      if (severe) return { cards: [], hold: "memory_overflow_hold", tokenEstimate: tokenEstimate + cost, budgets };
      continue;
    }
    if (!severe && majorTokens + cost > budgets.normalSoft) continue;
    cards.push({ ...lesson, application_id: id });
    tokenEstimate += cost;
    if (!severe) majorTokens += cost;
  }
  return { cards, hold: null, tokenEstimate, budgets };
}
