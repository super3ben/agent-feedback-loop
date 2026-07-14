import { createHash } from "node:crypto";

const ORDER = { Blocker: 0, Critical: 1, Major: 2, Minor: 3 };
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const DEFAULT_LIMITS = Object.freeze({ singleCardFloor: 192, singleCardHardLimit: 1600, maxCandidates: 12, maxSevereCards: 4 });

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

function scopeMatches(lesson, task) {
  const scope = lesson.scope || {};
  if (scope.task_types?.length && !scope.task_types.includes(task.task_type)) return false;
  if (scope.paths?.length && !scope.paths.some((path) => (task.paths || []).some((candidate) => candidate === path || candidate.startsWith(`${path}/`)))) return false;
  if (scope.tools?.length && !scope.tools.some((tool) => (task.tools || []).includes(tool))) return false;
  if (scope.signals?.length) {
    const prompt = String(task.prompt || "").toLocaleLowerCase();
    if (!scope.signals.some((signal) => prompt.includes(String(signal).toLocaleLowerCase()))) return false;
  }
  return true;
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
  const scoped = dedupeFamilies(lessons.filter((lesson) => lesson.enablement !== "disabled" && relevant(lesson, task.project_id) && scopeMatches(lesson, task)));
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
