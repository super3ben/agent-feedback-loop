/**
 * Splits a rules block into layers and decides which layer-1 sections a given
 * turn should see.
 *
 * Why the block needs layering at all: it was a single flat list of full
 * sections competing for one 6 KB budget. With 16 qualified families it
 * saturated at 97% and 12 families were reduced to a one-line heading. Adding
 * capacity did not help, because the real problem was not the size of the list
 * — it was that every turn received the same list regardless of what the user
 * had just asked. A deployment turn read the same 6 KB as a CSS-complaint turn.
 *
 * The three layers borrow their shape from how large context systems organise
 * retrievable memory:
 *
 * - L0 is the complete index: one line per family, always injected. Its job is
 *   to guarantee nothing is ever invisible, which the flat budget could not do —
 *   there, 12 of 16 families were reduced to headings with no instructions at
 *   all.
 * - L1 is the full instruction text, injected only for the families the current
 *   request actually touches. Relevance is decided here, at injection time,
 *   because the file on disk cannot know what the next prompt will be.
 * - L2 is the reflection document on disk. It is never injected; it is where a
 *   reader goes for the full incident when L1 is not enough.
 *
 * The scoring is deliberately lexical rather than embedding-based. At this scale
 * (tens of families) a vector index buys nothing a term-frequency weighting does
 * not, and it would add a model dependency and latency to every prompt.
 */

/**
 * Terms that appear across most families carry no discriminating power but
 * dominate a naive overlap count. Measured on a live project, "用户" occurred in
 * 16/16 families, "the" in 16/16, "必须" in 15/16 — which is why a plain overlap
 * score marked 16 of 16 families as relevant for two of six test prompts.
 *
 * This is a stop-list, not a stemmer: the goal is to stop the obvious noise from
 * deciding the ranking, not to build an IR system.
 */
const GENERIC_TERMS = new Set([
  "用户", "问题", "必须", "不是", "不要", "需要", "执行", "处理", "时候", "已经",
  "事情", "东西", "这个", "这些", "那样", "之前", "之后", "而是", "所以", "因为",
  "user", "the", "and", "for", "when", "with", "that", "this", "from", "into",
  "must", "never", "always", "agent", "should", "before", "after", "same",
  "not", "are", "was", "has", "have", "its", "it's", "one", "only", "than"
]);

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const LATIN_WORD = /[\p{Script=Latin}\p{Number}]+/gu;

/**
 * How many L1 sections a single turn may expand.
 *
 * Two, not more: at the measured relevance distribution the third-ranked family
 * is already a partial match on an incidental word, and every extra section
 * spends budget the reader then has to skim past. Both settings are overridden
 * by the caller when the request is clearly single-topic.
 */
export const DEFAULT_EXPAND_LIMIT = 2;

/**
 * A candidate must reach this fraction of the top score to be expanded.
 *
 * Without it, one strong match plus eleven weak ones all clear an absolute
 * threshold and the layering does nothing. Measured across six real prompts,
 * this cut the average expansion from 16 families to 2.4.
 */
const RELATIVE_THRESHOLD = 0.45;

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

function termsOf(values) {
  const terms = new Set();
  for (const source of Array.isArray(values) ? values : [values]) {
    const value = normalize(source);
    for (const word of value.match(LATIN_WORD) ?? []) {
      if (!GENERIC_TERMS.has(word)) terms.add(word);
    }
    for (const run of value.match(CJK_RUN) ?? []) {
      const points = Array.from(run);
      for (let index = 0; index + 1 < points.length; index += 1) {
        const bigram = `${points[index]}${points[index + 1]}`;
        if (!GENERIC_TERMS.has(bigram)) terms.add(bigram);
      }
    }
  }
  return terms;
}

// The index line carries an optional trailing fact: `- family (12×) [tag] → what
// to do`. The fact is the only part that says what the family means, so the
// parser keeps it and the composer puts it back — dropping it at either end
// leaves a name that identifies nothing.
const L0_LINE = /^-\s+(.+?)\s+\((\d+)×\)(.*)$/u;
const L1_HEADING = /^###\s+(.+?)\s+\((\d+)×,\s*(\w+)\)/u;

/**
 * Splits a managed block into its two injected layers.
 *
 * Tolerant by design: the block is a file on disk that a person may have edited,
 * and a parse failure must degrade to "inject the whole block" rather than "drop
 * the rules". Callers get null when the block is not recognisable as layered,
 * which is the signal to fall back to the old whole-block behaviour.
 *
 * @param {string} text - the text between the managed markers.
 */
export function parseLayeredBlock(text) {
  const source = String(text ?? "");
  if (!source.trim()) return null;

  const l1 = [];
  const l0 = [];
  const preamble = [];
  let current = null;

  // Line-by-line rather than split-on-heading: the index normally follows the
  // last section, so a heading-based split buries those lines inside the final
  // section's body and they disappear from L0. That silent loss would leave the
  // guarantee this layer exists for unexplained by anything on screen.
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trimEnd();
    const headingMatch = /^###\s+/u.test(line) ? L1_HEADING.exec(line) : null;
    if (headingMatch) {
      current = {
        familyKey: headingMatch[1].trim(),
        occurrences: Number(headingMatch[2]),
        severity: headingMatch[3],
        lines: [line]
      };
      l1.push(current);
      continue;
    }
    if (/^###\s+/u.test(line)) {
      // A heading with an unexpected shape is still a section boundary, and its
      // text is kept so a hand-written one is not silently discarded.
      current = { familyKey: null, occurrences: 0, severity: null, lines: [line] };
      l1.push(current);
      continue;
    }
    const indexEntry = L0_LINE.exec(line.trim());
    if (indexEntry) {
      l0.push({
        familyKey: indexEntry[1].trim(),
        occurrences: Number(indexEntry[2]),
        detail: (indexEntry[3] ?? "").trim()
      });
      continue;
    }
    if (current) {
      current.lines.push(line);
    } else if (line.trim()) {
      preamble.push(line);
    }
  }

  if (!l1.length && !l0.length) return null;
  return {
    preamble: preamble.join("\n").trim(),
    l0,
    l1: l1.map(({ lines, ...rest }) => ({ ...rest, text: lines.join("\n").trim() }))
  };
}

/**
 * Ranks L1 sections against a prompt and returns the ones worth expanding.
 *
/**
 * Whether a prompt is the user reporting a problem or objecting — as opposed to
 * giving the next ordinary instruction.
 *
 * This is the question the injection gate actually needs answered, and it is not
 * the same question as "does this prompt resemble a lesson's topic". Measured on
 * 21 real user messages, topic similarity could not separate the two classes at
 * any threshold: 「之前密码不是给你了怎么又问我」 and 「继续做审美的也一样做完」
 * both scored 2.4, and 「ppt里的文字图片都应该能修改」 scored 2.4 too — different
 * outcomes, identical scores. Every threshold on the score traded one error for
 * the other, best case 15/21.
 *
 * Two shapes count, and both are things a lesson can help with:
 *
 * - The user objects (太乱 / 怎么又 / 之前不是给过吗). A lesson is a record of a
 *   mistake they objected to before, so this is exactly its moment.
 * - The user reports something broken (日报没发出去 / 登录不了 / 更新失败了).
 *   They are telling the agent about a failure, which is the same moment from
 *   the other side: the lesson says how this failure was caused last time.
 *
 * What does not count is the ordinary next instruction (把这个报告存到 docs 下 /
 * 继续做审美的也一样做完). No lesson applies to it, however many words overlap.
 *
 * Deliberately lexical and synchronous. The detached LLM classifier answers a
 * related question better, but it takes 30-90s against the prompt hook's 5s
 * budget — so the two serve different moments. The classifier decides whether
 * something is worth LEAVING BEHIND as a lesson; this decides whether lessons
 * already written are worth SHOWING right now. Running the slow one here would
 * mean either blocking the turn or answering about a turn that already passed.
 */
const OBJECTION = Object.freeze([
  // Intensity on the agent's own output: 太乱 / 太简单 / 太粗糙.
  /(?:太|很|真|挺)(?:乱|差|慢|复杂|简单|粗糙|糟糕)/u,
  // Recurrence: 又不行 / 还是这样 / 老是出现 / 又来.
  /(?:又|还是|仍然|老是|总是)(?:不|没|是|出现|来|问|这样|那样)/u,
  // Rhetorical accountability: 怎么又 / 怎么会 / 怎么不能.
  /怎么(?:又|还|会|不|能|回事)/u,
  // "I already gave you this" — the omission the user has to point out.
  /不是(?:给|说|讲|做|要|让|有)?[^。！？?\n]{0,10}(?:吗|了|过)/u,
  // Named defects in the agent's work.
  /(?:漏|缺|少|错|不对|有问题|没做到|没实现|没考虑|没生效)/u,
  // The same omissions with an infix: 没有去考虑 / 没有仔细想 / 没好好做. The
  // bare form above misses them, and this is how a real complaint is phrased:
  // 「为什么你改造这些之前没有去考虑这些东西呢」.
  /没(?:有)?(?:去|仔细|认真|好好|提前)?(?:考虑|想|检查|核对|验证|确认|看)/u,
  // Hedged dissatisfaction: 感觉还是不够 / 觉得不太对.
  /(?:感觉|觉得)[^。！？?\n]{0,10}(?:不|太|差|乱)/u,
  // Hindsight: 才更新的吧 / 刚改的吧.
  /(?:才|刚)[^。！？?\n]{0,6}(?:吧|呀|啊)/u,
  // Expectation vs. result.
  /(?:明明|既然)[^。！？?\n]{0,18}(?:为什么|怎么|却)/u,
  /(?:本来|应该)[^。！？?\n]{0,14}(?:却|但|结果)/u,
  // The agent's own output called out directly.
  /(?:你|你们)(?:这个|那个|根本|又)[^。！？?\n]{0,18}(?:不|没|错|乱|简单|粗糙|搞)/u,
  /(?:你|你们)[^。！？?\n]{0,10}(?:说错|做错|搞错|没改|没做|漏了)/u
]);

/**
 * Something the user is reporting as not working. Distinct from an objection:
 * the user may be entirely calm ("今天的日报没有发出去"), but they are still
 * telling the agent about a failure, which is when a lesson about that failure
 * earns its place.
 *
 * Kept to failure shapes, not bare topics. 「日报」 alone is a topic; 「日报没有
 * 发出去」 is a report. The negative marker is what carries the signal, so every
 * pattern requires one.
 */
const PROBLEM_REPORT = Object.freeze([
  // X 没/不 + verb: 日报没有发出去 / 服务没起来 / 页面打不开.
  /(?:没|没有|不)(?:有)?[^。！？?\n]{0,6}(?:发出去|发出|发送|生效|起来|启动|打开|显示|出来|响应|返回|工作|通|用|走)/u,
  // Explicit failure words.
  /(?:失败|报错|出错|异常|崩溃|超时|卡住|卡死|挂掉|挂了|宕机|不通|断掉|断开)/u,
  // Cannot-do phrasing, including the bare question form.
  /(?:登录|登陆|连接|访问|部署|安装|执行|运行|提交|保存|上传|下载)[^。！？?\n]{0,4}(?:不|没)(?:了|上|通|过|去|来)/u,
  // 为什么 + a broken-state predicate. Narrow on purpose: 「为什么」 alone is a
  // question, and most questions are not problem reports.
  /为什么[^。！？?\n]{0,16}(?:不(?:能|行|通|对|生效)|没(?:有)?(?:发|出来|返回|响应|生效))/u,
  // 为什么 + any negation: 「为什么不直接展示在底部」「为什么又要我提供」. The
  // narrow list above missed both, and they are complaints, not curiosity — the
  // user is asking why the agent did not do the obvious thing.
  /为什么[^。！？?\n]{0,12}不/u,
  // A diagnostic question about a failure: 「看下日志是什么问题」「什么问题导致的」.
  // The user is not asking what a feature is; they are asking what went wrong.
  /(?:是什么|什么|啥)(?:问题|原因|错误|毛病)/u,
  /(?:看|查|看下|查下|检查)[^。！？?\n]{0,12}(?:日志|报错|错误|问题|异常)/u
]);

export function readsAsProblemOrObjection(text) {
  const value = String(text ?? "").trim();
  if (!value) return false;
  return OBJECTION.some((pattern) => pattern.test(value))
    || PROBLEM_REPORT.some((pattern) => pattern.test(value));
}

/**
 * How much of the match has to be distinctive before a section is considered.
 *
 * Expressed as a share of the sections that must NOT contain the term, not as an
 * absolute score. An absolute floor is calibrated to one corpus size and breaks
 * on another: IDF for a term unique to its section is log((N+1)/1.5), which is
 * 0.69 with two sections and 2.43 with sixteen. A floor of 1.5 is therefore
 * unreachable for a small project and trivially cleared for a large one.
 *
 * What actually matters is the same at any size: the match must rest on at least
 * one term that is not shared across the project. A term found in half the
 * sections carries no information about which section applies, whatever the
 * corpus size.
 */
const DISTINCTIVE_DF_RATIO = 0.5;

/**
 * @param {{l1: Array<{familyKey: string|null, text: string}>, prompt: string,
 *   limit?: number, minScore?: number}} params
 * @returns {{selected: Array<object>, scores: Array<{familyKey: string|null, score: number,
 *   rawScore: number}>}}
 */
export function selectL1Sections({
  l1 = [],
  prompt,
  limit = DEFAULT_EXPAND_LIMIT
}) {
  if (!Array.isArray(l1) || l1.length === 0) return { selected: [], scores: [] };
  const promptTerms = termsOf(prompt);
  if (promptTerms.size === 0) {
    // An empty or purely generic prompt gives no signal. Expanding nothing is
    // correct: L0 still tells the reader which lessons exist, and a guess would
    // spend budget on a coin flip.
    return { selected: [], scores: l1.map((section) => ({ familyKey: section.familyKey, score: 0, rawScore: 0, distinctive: 0 })) };
  }

  // Document frequency over this project's own sections, not a general corpus:
  // a term that is common here is common for a reason and carries no signal.
  const sectionTerms = l1.map((section) => termsOf([section.text]));
  const documentFrequency = new Map();
  for (const terms of sectionTerms) {
    for (const term of terms) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const total = l1.length;
  const idf = (term) => Math.log((total + 1) / ((documentFrequency.get(term) ?? 0) + 0.5));
  // A term shared by half the sections says nothing about which one applies.
  const distinctiveLimit = Math.max(1, Math.floor(total * DISTINCTIVE_DF_RATIO));

  const scored = l1.map((section, index) => {
    let rawScore = 0;
    let distinctive = 0;
    for (const term of promptTerms) {
      if (!sectionTerms[index].has(term)) continue;
      rawScore += idf(term);
      if ((documentFrequency.get(term) ?? 0) <= distinctiveLimit) distinctive += 1;
    }
    // Length-normalised: a long section matches more terms by accident, and
    // without this the longest lesson wins every prompt.
    return {
      section,
      familyKey: section.familyKey,
      rawScore,
      distinctive,
      score: rawScore / Math.max(promptTerms.size, 1)
    };
  });

  const ranked = [...scored].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return String(left.familyKey ?? "").localeCompare(String(right.familyKey ?? ""), "en-US");
  });

  const top = ranked[0] ?? null;

  // The gate comes first, before the match result is worth reporting. A lesson
  // is a record of a problem the user reported before, so it is worth showing
  // when they are reporting one now — not when they are giving the next ordinary
  // instruction, however much the words happen to overlap.
  //
  // Ordering it this way also makes the reason honest: when an instruction
  // happens to share no words with any lesson, saying "nothing matched" would
  // point at the wrong problem. Nothing SHOULD have matched, because an
  // instruction is not a moment for lessons at all.
  //
  // Skipping is cheap and safe: L0 still lists every family, so nothing is
  // hidden. What is saved is the 2 KB of instructions that do not apply.
  if (!readsAsProblemOrObjection(prompt)) return { selected: [], scores: ranked, gated: "not_a_problem" };

  if (!top || top.rawScore <= 0) return { selected: [], scores: ranked, gated: "no_match" };

  // At least one matched term must be distinctive to this section. Scale-free on
  // purpose: an absolute score floor is calibrated to one corpus size, since IDF
  // for a unique term is 0.69 with two sections and 2.43 with sixteen.
  if (top.distinctive < 1) return { selected: [], scores: ranked, gated: "no_distinctive_term" };

  const cutoff = top.score * RELATIVE_THRESHOLD;
  const selected = ranked
    .filter((entry) => entry.score >= cutoff)
    .slice(0, Math.max(1, limit))
    .map((entry) => entry.section);

  return { selected, scores: ranked };
}

/**
 * Assembles the injected text from the layers under a byte budget.
 *
 * L0 is reserved first and never sacrificed: it is the guarantee that a family
 * is visible at all, and it is what the flat block used to lose. L1 sections are
 * added while they fit. A section that would overflow is skipped rather than
 * truncated — a half-written instruction reads as complete while missing the
 * part that made it actionable.
 *
 * @param {{preamble?: string, l0: Array<{familyKey: string, occurrences: number}>,
 *   selected: Array<{text: string}>, maxBytes: number, header?: string}} params
 */
export function composeInjection({ preamble = "", l0 = [], selected = [], maxBytes, header = null }) {
  const headerLines = [header].filter(Boolean);
  const indexLines = l0.map((entry) =>
    `- ${entry.familyKey} (${entry.occurrences}×)${entry.detail ? ` ${entry.detail}` : ""}`);

  const assemble = (sections) => {
    const lines = [];
    if (headerLines.length) {
      lines.push(...headerLines, "");
    }
    for (const section of sections) lines.push(section.text, "");
    if (indexLines.length) {
      lines.push("**本项目已记录的全部教训家族**（命中相关时上面对应条目会展开；需要完整经过时读 `.agent/reflections/`）", "");
      lines.push(...indexLines);
    }
    return lines.join("\n").trim();
  };

  let sections = [...selected];
  for (;;) {
    const text = assemble(sections);
    if (Buffer.byteLength(text, "utf8") <= maxBytes) {
      return { text, expandedCount: sections.length, indexCount: indexLines.length };
    }
    if (!sections.length) {
      // Only the index and header remain. The index alone is the smallest
      // useful output; if even that overflows, it is still better than nothing
      // and the caller logs the overshoot.
      return { text, expandedCount: 0, indexCount: indexLines.length, overBudget: true };
    }
    sections = sections.slice(0, -1);
  }
}
