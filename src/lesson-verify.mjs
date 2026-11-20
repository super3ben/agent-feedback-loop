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
 * 3. IT MUST BE OPT-IN AND BOUNDED. Each verdict costs two model calls. Running
 *    it over thirty families on every prompt is not a maintenance task, it is a
 *    denial of service on the user's quota. The caller sets a limit, and only
 *    families whose verdict is stale get re-checked.
 */

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
 * @param {{family: object, others: object[], max?: number}} params
 * @returns {string[]}
 */
export function distinctiveMarkers({ family, others = [], max = 12 }) {
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
  return { hits, count: hits.length, reflected: hits.length >= threshold };
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
 * @returns {Promise<{family: string, verdict: string, markers: string[], control: object, treatment: object}>}
 */
export async function verifyFamily({
  family,
  others,
  prompt,
  run,
  prepareControl,
  prepareTreatment
}) {
  const markers = distinctiveMarkers({ family, others });
  const familyKey = family.familyKey ?? family.familyKeys?.[0] ?? "(unnamed)";

  // A family with no vocabulary of its own cannot be measured this way. Saying
  // so is more useful than returning a verdict produced by a marker that other
  // families also carry.
  if (markers.length < MARKER_THRESHOLD) {
    return {
      family: familyKey,
      verdict: "unmeasurable",
      reason: "no_distinctive_vocabulary",
      markers,
      control: null,
      treatment: null
    };
  }

  const controlWorkspace = await prepareControl({ family });
  const controlAnswer = await run({ workspace: controlWorkspace, prompt });
  const control = scoreAnswer({ answer: controlAnswer, markers });

  const treatmentWorkspace = await prepareTreatment({ family });
  const treatmentAnswer = await run({ workspace: treatmentWorkspace, prompt });
  const treatment = scoreAnswer({ answer: treatmentAnswer, markers });

  let verdict;
  if (treatment.reflected && !control.reflected) verdict = "earned";
  else if (treatment.reflected && control.reflected) verdict = "redundant";
  else if (!treatment.reflected && control.reflected) verdict = "harmful";
  else verdict = "missed";

  return { family: familyKey, verdict, markers, control, treatment };
}

/**
 * What a verdict means for the family's weight in the index.
 *
 * `earned` keeps its slot: this is the only category that has demonstrated a
 * behavioural difference. `redundant` does not — the model answers correctly
 * without it, so the line is spending budget on something the model already
 * knows. `missed` does not either: the lesson is present and does not land.
 *
 * `unmeasurable` and `harmful` keep their weight and are reported instead.
 * Unmeasurable is an absence of evidence, not evidence of absence; and a
 * "harmful" verdict is more likely a badly chosen marker than a lesson that
 * makes answers worse, so it must not silently remove anything.
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
