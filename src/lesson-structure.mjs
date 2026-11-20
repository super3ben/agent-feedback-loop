/**
 * What a lesson names, as opposed to what it says.
 *
 * The marker measurement in lesson-verify.mjs asks whether an answer reproduces
 * a family's distinctive token, and its tokens are Latin identifiers only —
 * `draft.json`, `8766`, `L1-contract`. That is deliberate: those are what a model
 * copies verbatim. But such an identifier only counts as a marker when it is
 * unique to one family. On the live 58-family corpus, 14 families yield no such
 * marker: every identifier in them is shared with another family or already in
 * the prompt. Their distinctive content is a THING —
 * 免密私钥, 映射表, 主题选择器, 卡片状态 — not an identifier.
 *
 * Scoring those families with the Latin marker machinery reports "unmeasurable",
 * which is honest but useless: a Chinese lesson is exactly where the question
 * "does this change what the model does" matters most, because a model that has
 * never seen this project cannot invent 开权限名称 on its own.
 *
 * This module extracts those things. It is a word-discovery problem, not a
 * segmentation one: there is no dictionary, no POS tagger, and no way to ask
 * which characters are nouns. What the corpus does give is a way to tell a
 * project's own vocabulary from the vocabulary every lesson in the project
 * shares, and a way to tell a word from a window cut out of a sentence.
 *
 * Three signals, each measured on the live corpus rather than assumed:
 *
 * 1. GENERIC IS COMMON. A term most families use cannot show that one family's
 *    lesson moved an answer — the control has it too. The cutoff is empirical:
 *    words in 30%+ of families are generic. Measured on the 58-family corpus,
 *    that lands between the two populations: 用户 98%, 问题 59%, 验证 57%,
 *    状态 57%, 确认 53%, 核对 38%, 检查 33% on one side; 密码认证 5%,
 *    开权限名称 3%, 免密私钥 3%, 名称对照表 2%, 观察点 2% on the other. There is
 *    no family between 5% and 22% that the cut has to thread.
 *
 *    The cutoff is a FRACTION, not a count, so it keeps working when a project
 *    has three families instead of fifty-eight.
 *
 * 2. A WORD IS NOT ALWAYS INSIDE A LONGER ONE. A repeated sentence yields every
 *    window inside it with the same count — 「只打包当前功能」 twice makes
 *    「打包当前功」 twice as well. The rule that removes them is the oldest one
 *    in word discovery: a candidate that is always embedded in the same longer
 *    string is a piece of that string, not a word. Tested by count: if extending
 *    a candidate letter by letter never changes how often it occurs, it is a
 *    window. 密码认证 occurs inside 密码认证先登录, 用的是密码认证还是, and
 *    （密码认证） — three different neighbours, so it stays.
 *
 * 3. A TERM DOES NOT START OR END ON A FUNCTION CHARACTER. Chinese function
 *    words are a closed class — 的, 了, 在, 把, 后, 就 — and a span that begins or
 *    ends on one is a clause, not a name. This is a closed-class list rather
 *    than a learned one because it is small, stable, and wrong in a direction
 *    that costs recall rather than precision: dropping 先 from 先查生产日志
 *    leaves 查生产日志 and 生产日志 to compete, and the count test picks the
 *    real term.
 *
 * 4. A TWO-CHARACTER SURVIVOR IS NOT A NAME. Measured on the live corpus, every
 *    2-character candidate that survived the three signals above was either a
 *    common verb (备选, 查实) or a window cut across a clause (明本, from
 *    写明本次用的是密码认证). The short real objects — 日志, 表, 端口 — are heads
 *    that the 30% cut already drops, or that ride inside a longer term the
 *    containment rule keeps. Three characters is the floor, and it is also what
 *    covers 定位 and 排查: both are process verbs at 10% of families, below the
 *    generic cut, and both are two characters long.
 *
 * What this does NOT do is claim to return nouns. It returns PROJECT-SPECIFIC
 * TERMS, which is what the measurement needs: a phrase that a model answering
 * from general practice would not produce. Some of them are phrases with a verb
 * in them — 只部署局部 — and that is fine, because the question is not "is this
 * a noun" but "does its presence distinguish an answer that had this lesson from
 * one that did not".
 */

/**
 * Closed-class Chinese function characters.
 *
 * A span that starts or ends on one of these is a clause fragment. Kept
 * deliberately narrow: every character here is a particle, conjunction,
 * preposition, auxiliary, or an adverbial that only appears before a verb. Words
 * that merely look grammatical — 表, 单, 日志, 路径 — are NOT here, because they
 * are exactly the heads this module is trying to keep.
 */
const FUNCTION_CHARS = new Set(Array.from(
  "的了着过和与及并而或但就都也还再又才是没要有会能可把被将对向从在为以时后前若如当各每全该这那其之且所得地很更最不下入出中里外于由让使给用做先"
));

const HAN_RUN = /[\p{Script=Han}]+/gu;
const LATIN_TOKEN = /^[a-z0-9][a-z0-9_.:-]*$/u;

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("en-US");
}

/** Every Han n-gram in a text, between `min` and `max` characters long. */
function grams(text, min, max) {
  const out = [];
  for (const run of String(text ?? "").normalize("NFKC").match(HAN_RUN) ?? []) {
    const points = Array.from(run);
    for (let size = min; size <= Math.min(max, points.length); size += 1) {
      for (let start = 0; start + size <= points.length; start += 1) {
        out.push(points.slice(start, start + size).join(""));
      }
    }
  }
  return out;
}

function textOf(document) {
  return [
    document?.classOfMistake ?? "",
    ...(document?.methodChanges ?? []),
    ...(document?.appliesWhen ?? [])
  ].join("\n");
}

/**
 * Corpus statistics a family's terms are judged against.
 *
 * `total` maps every n-gram up to `maxExtend` characters to how often it occurs
 * across the whole corpus; the long lengths exist only for the embedding test,
 * never as candidates. `familyCount` maps the scoring lengths to how many
 * FAMILIES contain the gram — the generic cutoff is a fraction of families, not
 * of occurrences, because a family that repeats a word ten times says nothing
 * about whether the word is generic.
 *
 * @param {object[]} documents
 * @param {{familyFraction?: number, maxLength?: number, maxExtend?: number}} [options]
 */
export function buildVocabulary(documents, {
  familyFraction = 0.3,
  maxLength = 6,
  maxExtend = 12
} = {}) {
  const list = Array.isArray(documents) ? documents : [];
  const total = new Map();
  const familyCount = new Map();

  for (const document of list) {
    const text = textOf(document);
    for (const gram of grams(text, 1, maxExtend)) {
      total.set(gram, (total.get(gram) ?? 0) + 1);
    }
    for (const gram of new Set(grams(text, 2, maxLength))) {
      familyCount.set(gram, (familyCount.get(gram) ?? 0) + 1);
    }
  }

  const generic = new Set();
  if (list.length > 0) {
    for (const [gram, count] of familyCount) {
      // Two families at least. Without that floor, a three-family project makes
      // every term 33% and calls all of them generic — the measurement would go
      // silent exactly where it has least to compare against.
      if (count < 2) continue;
      if (count / list.length >= familyFraction) generic.add(gram);
    }
  }

  return { documents: list.length, families: list.length, total, familyCount, generic, maxLength, maxExtend };
}

/** Whether the corpus says this term is too common to distinguish anything. */
export function isGenericTerm(term, vocabulary) {
  return Boolean(vocabulary?.generic?.has(String(term ?? "")));
}

/** Whether a candidate is always embedded in the same longer string. */
function isEmbeddedWindow(term, candidates, total) {
  const count = total.get(term) ?? 0;
  // No corpus support means nothing can be concluded; the caller drops it on
  // the count test anyway.
  if (!count) return true;
  for (const longer of candidates) {
    if (longer.length <= term.length) continue;
    if (!longer.includes(term)) continue;
    if ((total.get(longer) ?? 0) === count) return true;
  }
  return false;
}

/**
 * The project-specific terms one family's method changes name.
 *
 * @param {object} params
 * @param {object} params.family - with `methodChanges`
 * @param {object} params.vocabulary - from buildVocabulary
 * @param {string} [params.prompt] - the question both arms receive; a term it
 *   already contains cannot distinguish the two answers
 * @param {number} [params.max]
 * @param {number} [params.minCorpusCount]
 * @returns {string[]} most distinctive first
 */
export function extractObjects({
  family,
  vocabulary,
  prompt = "",
  max = 8,
  minLength = 3,
  minCorpusCount = 2
}) {
  const total = vocabulary?.total ?? new Map();
  const methods = (family?.methodChanges ?? []).join("\n");
  const maxLength = vocabulary?.maxLength ?? 6;
  const maxExtend = vocabulary?.maxExtend ?? 12;
  const inPrompt = normalize(prompt);

  const familyCount = new Map();
  for (const gram of grams(methods, 1, maxLength)) {
    familyCount.set(gram, (familyCount.get(gram) ?? 0) + 1);
  }
  // Every span of the family's own text, including the long ones, because the
  // embedding test needs to see what a candidate is always part of.
  const spans = new Set(grams(methods, 2, maxExtend));

  const candidates = [];
  for (const term of spans) {
    const length = Array.from(term).length;
    if (length < minLength || length > maxLength) continue;
    if ((total.get(term) ?? 0) < minCorpusCount) continue;
    if (isGenericTerm(term, vocabulary)) continue;
    // A term that already occurs in the question is common ground. This is the
    // same exclusion distinctiveMarkers makes, for the same measured reason:
    // 31 of 202 markers were already in the prompt.
    if (inPrompt.includes(term)) continue;
    const points = Array.from(term);
    if (FUNCTION_CHARS.has(points[0]) || FUNCTION_CHARS.has(points[points.length - 1])) continue;
    if (isEmbeddedWindow(term, spans, total)) continue;
    candidates.push(term);
  }

  // Two overlapping terms both hit on one phrase and count twice. Keep the
  // longer of the pair: 生产日志 rather than 日志 inside it.
  const kept = candidates.filter((term) => !candidates.some((other) =>
    other.length > term.length && other.includes(term)));

  kept.sort((left, right) => {
    const leftConcentration = (familyCount.get(left) ?? 0) / (total.get(left) ?? 1);
    const rightConcentration = (familyCount.get(right) ?? 0) / (total.get(right) ?? 1);
    if (leftConcentration !== rightConcentration) return rightConcentration - leftConcentration;
    if (left.length !== right.length) return right.length - left.length;
    return left.localeCompare(right, "zh-Hans-CN");
  });

  return kept.slice(0, Math.max(0, max));
}

/**
 * How many of a family's terms an answer contains.
 *
 * Substring for Chinese, token for Latin: a Chinese term has no boundary a regex
 * can see, while a Latin one does — `main` must not score on `mainline`, which is
 * exactly the kind of false hit that makes a measurement look better than it is.
 */
export function scoreObjects({ answer, terms = [], threshold } = {}) {
  const text = normalize(answer);
  const latinTokens = new Set(text.match(/[a-z0-9][a-z0-9_.:-]*/gu) ?? []);
  const hits = [];
  for (const term of terms) {
    const needle = normalize(term);
    if (!needle) continue;
    if (LATIN_TOKEN.test(needle)) {
      if (latinTokens.has(needle)) hits.push(term);
    } else if (text.includes(needle)) {
      hits.push(term);
    }
  }
  const limit = Number.isSafeInteger(threshold) ? threshold : Math.min(2, terms.length);
  return { hits, count: hits.length, reflected: terms.length > 0 && hits.length >= limit };
}
