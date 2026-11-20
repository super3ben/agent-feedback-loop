/**
 * Does a lesson earn the bytes it occupies?
 *
 * Every other check in this codebase measures the TEXT: is it readable, is it
 * concrete, does it cite a file that still exists. None of them answer the only
 * question that matters — when a model is given this lesson and the situation it
 * describes comes up, does the model do anything differently?
 *
 * This module answers it the only way that can be answered from outside the
 * model: run the same request twice, once with nothing injected and once with
 * only this lesson's line, and see whether the answer changes in the lesson's
 * direction.
 *
 * The method is not invented here. It was run by hand across eight families
 * before this module existed, with a clean control, and it separates them
 * cleanly:
 *
 *   earned      the answer changes only when the lesson is present
 *   redundant   the answer is already right without it — the lesson is
 *               re-derivable, and its line is spending budget for nothing
 *   missed      the answer does not reflect the lesson even when present
 *
 * Measured on that run: 3 earned, 4 redundant, 1 missed. The redundant ones were
 * exactly the general best practices ("use password auth, not BatchMode") that
 * any model states unprompted; the earned ones were project-specific facts
 * (a draft.json filename, a port number, an L1-contract convention) that no
 * amount of reasoning produces.
 *
 * Three design constraints, each from a way this kind of measurement goes wrong:
 *
 * 1. THE CONTROL MUST BE EMPTY. A project with a rules block removed still
 *    injects reflection documents through the selector, so "no rules block" is
 *    not "no lesson". The control here is a directory with no `.agent` at all.
 *    That mistake produced a false negative the first time this was tried.
 *
 * 2. THE MARKER MUST BE DISTINCTIVE. A term shared with other families says
 *    nothing about which lesson moved the answer. Markers are computed as terms
 *    present in this family's text and absent from every other family's.
 *
 * 3. IT MUST BE OPT-IN AND BOUNDED. A verdict costs two model calls for a
 *    family the markers can measure, and four for one that falls back to
 *    structure (two runs per arm; one run gives no same-arm spread to compare
 *    against). A family whose lesson yields no extractable term costs none.
 *    Running it over thirty families on every prompt is not a maintenance
 *    task, it is a denial of service on the user's quota. The caller sets a
 *    limit, and only families whose verdict is stale get re-checked.
 *
 * 4. AN EMPTY VOCABULARY IS NOT AN ANSWER. The markers are Latin identifiers
 *    distinctive to one family. On the live 58-family corpus, 14 families yield
 *    no such marker — not because they contain no Latin text (they all do) but
 *    because every identifier in them is shared with another family or already
 *    present in the prompt. Their distinguishing content is a THING (a table, a
 *    state, a name) rather than a token a model copies verbatim. Those families
 *    get a second, weaker reading from `verifyFamilyByStructure`: run the same
 *    two arms, count the family's own Chinese terms in each answer, and compare
 *    the gap between the arms against the gap between two runs of the same arm.
 *    It is reported as a `reviewFlag`, never as a verdict, because it moves no
 *    weight: a term surviving into an answer is evidence that the lesson was
 *    read, not that it changed what the model did.
 */
import { buildVocabulary, extractObjects, scoreObjects } from "./lesson-structure.mjs";

/** Terms used to tell whether an answer reflects a particular lesson. */
function tokenize(text) {
  const value = String(text ?? "").normalize("NFKC").toLocaleLowerCase("en-US");
  const tokens = new Set();
  for (const word of value.match(/[a-z0-9_.-]{3,}/gu) ?? []) tokens.add(word);
  for (const run of value.match(/[\p{Script=Han}]+/gu) ?? []) {
    const points = Array.from(run);
    for (let index = 0; index + 1 < points.length; index += 1) {
      tokens.add(`${points[index]}${points[index + 1]}`);
    }
  }
  return tokens;
}

/**
 * A token a model could plausibly reproduce verbatim.
 *
 * The first version of this took the LONGEST unique tokens, on the reasoning
 * that a long token identifies a lesson better than a short one. Run against a
 * live project it produced markers like `20260708-113547`, `py_compile`, `一嫌`,
 * `一存` — a date-stamped filename and two meaningless CJK fragments. Neither
 * condition scored a single hit, so the family was reported "missed" and would
 * have been demoted for a failure of the measurement, not of the lesson.
 *
 * What actually survives into an answer is a NAME: a file, an API, a flag, a
 * port, a config key. Those are Latin identifiers with a dot or an underscore or
 * a digit in them, three characters or more. CJK bigrams are excluded outright —
 * they are fragments of words, not words, and a model writing prose will rarely
 * reproduce the exact bigram the lesson happens to use.
 */
function isReproducibleToken(token) {
  if (/^\d+$/u.test(token)) return false;            // a bare number: a date, a count, an id
  if (/\d{6,}/u.test(token)) return false;           // a timestamp embedded in a name
  if (!/^[a-z0-9_.-]+$/u.test(token)) return false;  // CJK bigrams and other fragments
  if (token.length < 4) return false;                // too short to be distinctive in prose
  return true;
}

/**
 * Terms that belong to one family and no other.
 *
 * `prompt` is excluded, and that exclusion is not optional. The prompt sent to
 * both arms is built from this family's own `applies_when`, so a marker drawn
 * from that field is present in BOTH answers no matter what the lesson says.
 * Measured: 31 of 202 markers were already in the prompt, and 7 of 58 families
 * had enough of them to reach the threshold on the control alone — the verdict
 * was forced to "redundant" before either model call ran. A marker that the
 * question already contains cannot show that the lesson changed the answer.
 *
 * `minCount` guards the other end: when a family has fewer markers than this,
 * the caller should treat the result as unmeasurable rather than score it. A
 * family with two markers needs the model to reproduce 100% of its vocabulary
 * verbatim, so a single paraphrase flips the verdict.
 *
 * @param {{family: object, others: object[], prompt?: string, max?: number}} params
 * @returns {string[]}
 */
export function distinctiveMarkers({ family, others = [], prompt = "", max = 12 }) {
  const gather = (entry) => [
    ...(entry.appliesWhen ?? []),
    entry.incidentSummary ?? "",
    ...(entry.methodChanges ?? [])
  ].join(" ");

  const own = [...tokenize(gather(family))].filter(isReproducibleToken);

  const shared = new Set();
  for (const other of others) {
    for (const token of tokenize(gather(other))) shared.add(token);
  }
  // The question itself is common ground, not evidence.
  for (const token of tokenize(prompt)) shared.add(token);

  const unique = own.filter((token) => !shared.has(token));
  unique.sort((left, right) => right.length - left.length || left.localeCompare(right, "en-US"));
  return unique.slice(0, max);
}

/**
 * How many markers an answer has to contain before the lesson counts as having
 * moved it.
 *
 * One is not enough — a single shared bigram can appear by chance in a long
 * answer. Two is the smallest number that cannot plausibly be coincidence for a
 * distinctive term, and it is what the manual run used.
 */
const MARKER_THRESHOLD = 2;

export function scoreAnswer({ answer, markers, threshold = MARKER_THRESHOLD }) {
  const tokens = tokenize(answer);
  const hits = markers.filter((marker) => tokens.has(marker));
  return {
    hits,
    count: hits.length,
    reflected: hits.length >= threshold
  };
}

/**
 * One family's text as `lesson-structure` reads a reflection document.
 *
 * The verify pipeline carries the incident as `incidentSummary` (it is the
 * rendered name for `class_of_mistake`), while the structure extractor was
 * written against the parsed document, where the field is `classOfMistake`.
 * Both spellings are accepted so the vocabulary is built from the same text
 * either way — a corpus missing its incident narratives would under-count every
 * term and call nothing generic.
 */
function structureDocument(entry) {
  return {
    classOfMistake: entry?.classOfMistake ?? entry?.incidentSummary ?? "",
    methodChanges: entry?.methodChanges ?? [],
    appliesWhen: entry?.appliesWhen ?? []
  };
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function spread(values) {
  return values.length > 1 ? Math.max(...values) - Math.min(...values) : 0;
}

/**
 * The fallback for a family its markers cannot see: does the lesson's own
 * Chinese vocabulary survive into the answer?
 *
 * This runs the same two arms as `verifyFamily` and scores them the way
 * `eval/structure-ab.mjs` does — with the same extractor over the same corpus,
 * the same `max: 10` term cap, and the same test for whether a signal is real:
 * the gap between the arms has to beat the gap between two runs of the SAME
 * arm. It is deliberately NOT a verdict. An answer that reuses the project's
 * terms shows the lesson was read; it does not show the model did anything
 * differently, which is the question `verifyFamily` exists to answer. So the
 * caller's verdict stays `unmeasurable`, the weight stays 1, and nothing
 * demotes — the measurement is attached as `reviewFlag` for a person to read.
 *
 * @param {object} params
 * @param {object} params.family
 * @param {object[]} [params.others] - every other family; builds the corpus the
 *   generic-word cutoff is measured against
 * @param {string} [params.prompt]
 * @param {(args: {workspace: string, prompt: string}) => Promise<string>} params.run
 * @param {(args: {family: object}) => Promise<string>} params.prepareControl
 * @param {(args: {family: object}) => Promise<string>} params.prepareTreatment
 * @param {number} [params.repeats] - runs per arm. Below 2 there is no spread
 *   to compare against, so any difference looks meaningful; the value is
 *   raised to 2 rather than honoured.
 * @param {number} [params.maxTerms]
 * @returns {Promise<object>} the unmeasurable verdict, plus `reviewFlag`
 */
async function verifyFamilyByStructure({
  family,
  others = [],
  prompt = "",
  run,
  prepareControl,
  prepareTreatment,
  repeats = 2,
  maxTerms = 10
}) {
  const familyKey = family.familyKey ?? family.familyKeys?.[0] ?? "(unnamed)";
  const vocabulary = buildVocabulary([family, ...others].map(structureDocument));
  const terms = extractObjects({ family: structureDocument(family), vocabulary, prompt, max: maxTerms });

  const unmeasurable = {
    family: familyKey,
    verdict: "unmeasurable",
    reason: "no_distinctive_vocabulary",
    markers: [],
    control: null,
    treatment: null
  };

  // Nothing extractable is nothing measurable. Spending model calls to score
  // answers against an empty term list would produce a zero-gap comparison that
  // reads like evidence.
  if (!terms.length) {
    return {
      ...unmeasurable,
      reviewFlag: {
        via: "structure",
        verdict: "no_terms",
        terms: [],
        controlHits: [],
        treatmentHits: [],
        noise: 0,
        n: 0
      }
    };
  }

  // Two runs per arm is the floor, not a default. One run measures no
  // same-arm spread at all, so the comparison would divide the arms' gap by a
  // noise of zero and report any difference as real. Asking for one still buys
  // two.
  const rounds = Number.isSafeInteger(repeats) && repeats >= 2 ? repeats : 2;
  const controlWorkspace = await prepareControl({ family });
  const treatmentWorkspace = await prepareTreatment({ family });

  // Interleaved, as the A/B script runs them: drift between the two arms is
  // smaller when they alternate than when every control call precedes every
  // treatment call.
  const controlHits = [];
  const treatmentHits = [];
  for (let index = 0; index < rounds; index += 1) {
    const controlAnswer = await run({ workspace: controlWorkspace, prompt });
    controlHits.push(scoreObjects({ answer: controlAnswer, terms }).count);
    const treatmentAnswer = await run({ workspace: treatmentWorkspace, prompt });
    treatmentHits.push(scoreObjects({ answer: treatmentAnswer, terms }).count);
  }

  const noise = Math.max(spread(controlHits), spread(treatmentHits));
  const separation = mean(treatmentHits) - mean(controlHits);
  let verdict = "within_noise";
  if (Math.abs(separation) > noise) verdict = separation > 0 ? "treatment_ahead" : "treatment_behind";

  return {
    ...unmeasurable,
    reviewFlag: {
      via: "structure",
      verdict,
      terms,
      controlHits,
      treatmentHits,
      noise,
      n: rounds
    }
  };
}

/**
 * Runs one family through the control and the treatment.
 *
 * @param {object} params
 * @param {object} params.family - one entry as buildRulesBlock consumes
 * @param {object[]} params.others - every other family, for marker subtraction
 * @param {string} params.prompt - the request to ask both times
 * @param {(args: {workspace: string, prompt: string}) => Promise<string>} params.run
 *   Executes one model call in a prepared workspace and returns its answer.
 * @param {(args: {family: object}) => Promise<string>} params.prepareControl
 *   Builds a workspace with NOTHING injected.
 * @param {(args: {family: object}) => Promise<string>} params.prepareTreatment
 *   Builds a workspace with only this family's block.
 * @param {number} [params.structureRepeats] - runs per arm for the structure
 *   fallback, which is only reached by a family with zero markers.
 * @returns {Promise<{family: string, verdict: string, markers: string[], control: object, treatment: object, reviewFlag?: object}>}
 */
export async function verifyFamily({
  family,
  others,
  prompt,
  run,
  prepareControl,
  prepareTreatment,
  structureRepeats = 2
}) {
  const tokenMarkers = distinctiveMarkers({ family, others, prompt });
  const familyKey = family.familyKey ?? family.familyKeys?.[0] ?? "(unnamed)";

  // ZERO markers, exactly. A family with one marker is still measured by the
  // marker scorer (and comes out unmeasurable below, because the threshold is
  // two), and widening the fallback to cover it would change what that path
  // reports. The fallback exists only where the marker scorer has nothing at
  // all to look for.
  if (tokenMarkers.length === 0) {
    return verifyFamilyByStructure({
      family,
      others,
      prompt,
      run,
      prepareControl,
      prepareTreatment,
      repeats: structureRepeats
    });
  }

  // A family with no vocabulary of its own cannot be measured this way. Saying
  // so is more useful than returning a verdict produced by a marker that other
  // families also carry.
  if (tokenMarkers.length < MARKER_THRESHOLD) {
    return {
      family: familyKey,
      verdict: "unmeasurable",
      reason: "no_distinctive_vocabulary",
      markers: tokenMarkers,
      control: null,
      treatment: null
    };
  }

  const controlWorkspace = await prepareControl({ family });
  const controlAnswer = await run({ workspace: controlWorkspace, prompt });
  const control = scoreAnswer({ answer: controlAnswer, markers: tokenMarkers });

  const treatmentWorkspace = await prepareTreatment({ family });
  const treatmentAnswer = await run({ workspace: treatmentWorkspace, prompt });
  const treatment = scoreAnswer({ answer: treatmentAnswer, markers: tokenMarkers });

  let verdict;
  if (treatment.reflected && !control.reflected) verdict = "earned";
  else if (treatment.reflected && control.reflected) verdict = "redundant";
  else if (!treatment.reflected && control.reflected) verdict = "harmful";
  else verdict = "missed";

  return {
    family: familyKey,
    verdict,
    markers: tokenMarkers,
    control,
    treatment
  };
}

/**
 * The branch a model chose, or null when it did not choose one.
 *
 * A decision question only measures anything if the answer is a decision. The
 * failure mode to design against is not a wrong branch — it is a parser that
 * reads a hedge as a branch and manufactures a verdict out of noise. So this
 * returns null far more readily than it returns a letter:
 *
 * - No letter, no answer. "这取决于具体情况" is unparsed, not a coin flip.
 * - Two branches at the same level of confidence ("A 和 B 都可以") is unparsed.
 *   Picking the first one would encode the option order as the answer.
 * - A letter outside the offered branches is not an answer to this question.
 *
 * The levels exist because a model often restates the problem before deciding.
 * "不是A，是B" contains both letters and one conclusion; the conclusion is the
 * answer. Each level is tried in order and the first level that yields a branch
 * decides — a stated answer beats a parenthesized option, which beats a bare
 * letter.
 */
const DECISION_LEVELS = [
  // An explicit answer marker. The strongest form: the model says it is answering.
  /(?:答案|作答|结论|选择|answer|choice|pick)\s*(?:是|为|is|:|：)?\s*[（(]?\s*([A-Za-z])\s*[）)]?/gu,
  // A line that contains nothing but the letter.
  /^[ \t]*[（(]?\s*([A-Za-z])\s*[）)]?[.。]?[ \t]*$/gmu,
  // A parenthesized option, as printed in the question.
  /[（(]\s*([A-Za-z])\s*[）)]/gu,
  // A conclusion verb followed by the letter: "是B", "用 B", "go with B".
  // The lookbehind keeps 不是A — a branch the model rejected — from reading as
  // a conclusion; without it, "不是A，是B" yields two branches and no answer.
  /(?:(?<!不)是|用|要|采用|应该|建议|choose|use|go with)\s*[（(]?\s*([A-Za-z])\s*[）)]?/gu
];

/** How short an answer must be for a lone letter to count as the decision. */
const DECISION_SHORT_ANSWER_CHARS = 24;

export function parseDecisionAnswer({ answer, branches = ["A", "B", "C"] }) {
  const offered = new Set(branches.map((branch) => String(branch).toUpperCase()));
  const text = String(answer ?? "").normalize("NFKC");
  if (!text.trim()) return null;

  const accept = (match) => offered.has(match[1].toUpperCase());

  for (const pattern of DECISION_LEVELS) {
    const found = new Set();
    for (const match of text.matchAll(pattern)) {
      if (accept(match)) found.add(match[1].toUpperCase());
    }
    if (found.size === 1) return [...found][0];
    // More than one branch at the same level is a restatement, not a decision.
    if (found.size > 1) return null;
  }

  // Last resort: a terse answer that mentions exactly one offered branch.
  if (text.trim().length <= DECISION_SHORT_ANSWER_CHARS) {
    const letters = new Set(
      (text.match(/[A-Za-z]/gu) ?? []).map((letter) => letter.toUpperCase()).filter((letter) => offered.has(letter))
    );
    if (letters.size === 1) return [...letters][0];
  }
  return null;
}

/** One answer, scored against the branch the lesson names. */
export function scoreDecision({ answer, expected, branches = ["A", "B", "C"] }) {
  const pick = parseDecisionAnswer({ answer, branches });
  return { pick, correct: pick !== null && pick === String(expected).toUpperCase(), unparsed: pick === null };
}

function decisionRate(entries) {
  const parsed = entries.filter((entry) => entry.pick !== null);
  if (!parsed.length) return null;
  return parsed.filter((entry) => entry.correct).length / parsed.length;
}

/**
 * Runs one decision question through the control and the treatment.
 *
 * The same two arms as `verifyFamily`, and the same reason for them: only a
 * directory with no `.agent` at all is a control, because a project with its
 * rules block removed still injects lessons through the selector.
 *
 * `repeats` exists because one answer is a sample, not a rate. A small model
 * given the same question twice may take different branches; scoring a single
 * call would report that variance as the lesson's effect. The verdict compares
 * RATES between arms, and an unparsed answer is excluded from the denominator
 * rather than counted as a wrong branch — a model that answers in prose has not
 * disagreed with the lesson, it has declined the format.
 *
 * @param {object} params
 * @param {object} params.family
 * @param {string} params.question - asked verbatim, identical in both arms
 * @param {string} params.expected - the branch this lesson names
 * @param {string[]} [params.branches]
 * @param {number} [params.repeats]
 * @param {(args: {workspace: string, prompt: string}) => Promise<string>} params.run
 * @param {(args: {family: object}) => Promise<string>} params.prepareControl
 * @param {(args: {family: object}) => Promise<string>} params.prepareTreatment
 */
export async function verifyFamilyByDecision({
  family,
  question,
  expected,
  branches = ["A", "B", "C"],
  repeats = 1,
  run,
  prepareControl,
  prepareTreatment
}) {
  const offered = branches.map((branch) => String(branch).toUpperCase());
  const wanted = String(expected).toUpperCase();
  if (!offered.includes(wanted)) {
    throw new Error(`expected branch ${expected} is not among the offered branches (${offered.join("/")})`);
  }
  if (!Number.isSafeInteger(repeats) || repeats < 1) {
    throw new TypeError("repeats must be a positive integer");
  }
  const familyKey = family.familyKey ?? family.familyKeys?.[0] ?? "(unnamed)";

  const controlWorkspace = await prepareControl({ family });
  const treatmentWorkspace = await prepareTreatment({ family });

  const controlAnswers = [];
  const treatmentAnswers = [];
  for (let index = 0; index < repeats; index += 1) {
    controlAnswers.push(await run({ workspace: controlWorkspace, prompt: question }));
  }
  for (let index = 0; index < repeats; index += 1) {
    treatmentAnswers.push(await run({ workspace: treatmentWorkspace, prompt: question }));
  }

  const controlRuns = controlAnswers.map((answer) => scoreDecision({ answer, expected: wanted, branches }));
  const treatmentRuns = treatmentAnswers.map((answer) => scoreDecision({ answer, expected: wanted, branches }));
  const control = {
    picks: controlRuns.map((entry) => entry.pick),
    correctRate: decisionRate(controlRuns),
    unparsed: controlRuns.filter((entry) => entry.unparsed).length
  };
  const treatment = {
    picks: treatmentRuns.map((entry) => entry.pick),
    correctRate: decisionRate(treatmentRuns),
    unparsed: treatmentRuns.filter((entry) => entry.unparsed).length
  };

  const distinct = new Set([...control.picks, ...treatment.picks].filter((pick) => pick !== null));
  const result = { family: familyKey, question, expected: wanted, control, treatment, flipped: distinct.size > 1 };

  // No baseline means no comparison. A treatment-only answer cannot show that
  // the lesson caused anything, so it is reported, not scored.
  if (control.correctRate === null && treatment.correctRate === null) {
    return { ...result, verdict: "unmeasurable", reason: "unparsed_answers" };
  }
  if (control.correctRate === null) {
    return { ...result, verdict: "unmeasurable", reason: "control_unparsed" };
  }
  if (treatment.correctRate === null) {
    return { ...result, verdict: "unmeasurable", reason: "treatment_unparsed" };
  }

  // Chance is the number of branches on offer: 1/2 for a binary question, 1/3
  // for a ternary one. "Already right" must mean STRICTLY above chance — a
  // model that guesses on a two-way choice scores 0.5, and reading that as
  // knowledge would demote a lesson on a coin flip. The same rate therefore
  // means different things on a ternary question, which is why chance is
  // computed rather than fixed at one half.
  const chance = 1 / offered.length;
  const controlRight = control.correctRate > chance;
  const treatmentRight = treatment.correctRate > chance;
  let verdict;
  if (treatmentRight && !controlRight) verdict = "earned";
  else if (treatmentRight && controlRight) verdict = "redundant";
  else if (!treatmentRight && controlRight) verdict = "harmful";
  else {
    // Both arms at or below chance. If they agree on a single wrong branch,
    // the question had an answer and the lesson did not land on it: `missed`.
    // If they split, the question was ambiguous or the model was guessing, and
    // no lesson should be demoted for failing a question that had no stable
    // answer: `uninformative`.
    const picks = [...control.picks, ...treatment.picks].filter((pick) => pick !== null);
    const consistentWrong = picks.length > 0 && picks.every((pick) => pick === picks[0]);
    verdict = consistentWrong ? "missed" : "uninformative";
  }
  return { ...result, verdict };
}

/**
 * The rank a verdict gets in the printed report.
 *
 * This orders the report projection; it is NOT the demotion rule. That rule
 * lives in `update-rules-tier.mjs` and acts on exactly one verdict:
 * `redundant` marks a family dormant, because the model answered correctly
 * without the lesson — a failed measurement cannot produce that by accident.
 * `missed` is deliberately NOT demoted there: it is produced both when the
 * lesson does not land and when the measurement never ran, and withdrawing a
 * lesson for the verifier's failure is worse than having no verifier.
 *
 * So `redundant` and `missed` rank below `earned` here, but only `redundant`
 * moves lifecycle state. `unmeasurable`, `uninformative` and `harmful` keep
 * full weight: an absence of evidence is not evidence of absence, and a
 * "harmful" verdict is more likely a badly chosen marker than a lesson that
 * makes answers worse.
 *
 * Deliberately conservative in one direction: nothing here DELETES a lesson. A
 * demoted family keeps its document, its history and its index name — it loses
 * the always-on instruction line, which is the part that costs every turn.
 */
export function weightForVerdict(verdict) {
  switch (verdict) {
    case "redundant":
    case "missed":
      return 0.5;
    default:
      return 1;
  }
}

/**
 * The families worth spending calls on.
 *
 * Stale first: a family whose verdict is older than `maxAgeDays`, or that has
 * never been checked. Within the stale set, the most expensive lines go first —
 * the ones whose removal would free the most budget.
 *
 * @param {{families: object[], verdicts: Record<string, {checkedAt: string}>, limit: number, lineBytesOf: (f: object) => number, now?: number, maxAgeDays?: number}} params
 */
export function selectFamiliesToVerify({
  families = [],
  verdicts = {},
  limit = 8,
  lineBytesOf = () => 0,
  now = Date.now(),
  maxAgeDays = 30
} = {}) {
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1_000;
  const stale = families.filter((family) => {
    const key = family.familyKey ?? family.familyKeys?.[0];
    const record = verdicts[key];
    if (!record) return true;
    const at = Date.parse(record.checkedAt ?? "");
    return !Number.isFinite(at) || at < cutoff;
  });
  return stale
    .map((family) => ({ family, bytes: lineBytesOf(family) }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.family);
}
