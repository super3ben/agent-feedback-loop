/**
 * Reads published lessons' metadata and writes a managed block into the
 * project's .agent/rules/feedback-loop.md.  The block is delimited by
 * afl:rules:start/end so it never touches user-written content.
 *
 * Tier gate: Major+3 / Critical+2 / Blocker+1 → write rules.
 *
 * The block is a projection, not a log. Every write rebuilds it from current
 * store state under a fixed byte budget, so it cannot grow without bound and
 * an operator never has to prune it by hand. Measured on a real project: 12
 * families reached 10,928 B against a 6,144 B injection cap, and the reader's
 * byte-slice silently dropped 44% of them — including 7 sections whose bodies
 * were byte-identical because the family id hashes the reviewer's free-text
 * family key alongside its method class.
 */
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";

const AFL_RULES_START = "<!-- afl:rules:start -->";
const AFL_RULES_END = "<!-- afl:rules:end -->";
const SEVERITY_ORDER = { Blocker: 0, Critical: 1, Major: 2 };
const SEVERITY_THRESHOLDS = { Major: 3, Critical: 2, Blocker: 1 };

/**
 * The injection budget the reader enforces (`RULES_BLOCK_MAX_BYTES` in
 * cli.mjs). Kept exported because `doctor` reports against it and older callers
 * pass it; the writer itself no longer projects to this size.
 */
export const RULES_BLOCK_BUDGET_BYTES = 6 * 1_024;

/**
 * How large the FILE may grow.
 *
 * Separate from the injection budget on purpose. The file stores the full
 * instruction text for every qualified family so the injector has something to
 * expand into; the injection then sends only the families the current prompt
 * touches. Bounding both by 6 KB is what forced the writer to discard
 * instructions that a relevant turn then could not use.
 *
 * 64 KB holds roughly 100 full sections at the measured 613-byte average, which
 * is far more than any project here has produced. It is a runaway guard, not a
 * working limit.
 */
export const RULES_FILE_BUDGET_BYTES = 64 * 1_024;

/**
 * Marks the start of the L0 index inside the managed block. The parser keys on
 * the one-line entries rather than this heading, so a block without it still
 * parses; it exists so a person reading the file can tell the layers apart.
 */
const INDEX_HEADING = "**本项目已记录的全部教训家族**";

/**
 * Reserve for the demoted index, so evicting families cannot starve the index
 * that is supposed to keep them findable. Proportional rather than fixed: a
 * flat reserve would swallow a small budget whole, which matters because the
 * budget is a parameter the tests and future callers may tighten.
 */
const INDEX_RESERVE_FRACTION = 1 / 4;
const INDEX_RESERVE_MIN_BYTES = 64;

/**
 * A single full section may not exceed this. Without a cap one verbose lesson
 * takes a quarter of the block and pushes several shorter lessons down to
 * headings; capping trades detail nobody reads for coverage that everybody gets.
 */
const MAX_SECTION_BYTES = 1_200;

/**
 * How much of a demoted family's first method change survives compression.
 * A demoted family used to render as a bare heading, which is not an
 * instruction — it names a rule without saying what to do. Measured on a live
 * project: six families, including the one that had just recurred seven times,
 * were headings only. Compression keeps the imperative and drops the prose.
 */
const DEMOTED_CHANGE_MAX_CHARS = 110;

/**
 * How many trigger conditions a section renders.
 *
 * They exist to be matched against a future prompt, and the injector scores on
 * them, so a few well-chosen ones beat all of them: the document carries up to
 * sixteen, most of them generic restatements ("当用户表达不满时") that match
 * everything and therefore discriminate nothing.
 */
const APPLIES_WHEN_MAX = 4;

export function qualifyForRules(severity, occurrences) {
  if (!severity || !SEVERITY_ORDER.hasOwnProperty(severity)) return false;
  return occurrences >= (SEVERITY_THRESHOLDS[severity] ?? Infinity);
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Two sections are the same lesson when their bodies AND their method class
 * match.
 *
 * Body alone was not enough. The escalation path publishes one shared
 * boilerplate body ("the review kept declining this as not worth learning")
 * for every family it rescues, so fifteen unrelated problems merged into a
 * single 91x section whose text described none of them. The method class is
 * what actually distinguishes "declined too often" applied to a card
 * regression from the same sentence applied to a deploy confirmation.
 *
 * Families published before method_class was recorded carry null, which
 * compares equal to other nulls and so keeps the old behaviour for them.
 */
/**
 * The text that decides whether two families are the same lesson.
 *
 * Body alone was not enough: the escalation path publishes one shared
 * boilerplate class_of_mistake for every family it rescues ("the review kept
 * declining this as not worth learning"), so unrelated problems merged into a
 * single section whose text described none of them. The method class is what
 * actually distinguishes "declined too often" applied to a card regression from
 * the same sentence applied to a deploy confirmation.
 *
 * But including `methodClass` verbatim has the opposite failure: every escalated
 * family carries the SAME literal ("recurring_decline_after_user_feedback"), so
 * the class contributes nothing there and the merge key collapses to
 * incidentSummary + methodChanges — which for escalated families is also
 * boilerplate. That is how a live project ended up with seven distinct problems
 * sharing one 67× section whose body described the review process rather than
 * any of the seven.
 *
 * The fix is to key an escalated family on the incident itself. When the family
 * was synthesized from declines, its identity is what the user complained about,
 * not the fact that it was declined. Families published normally keep the old
 * key, so their behaviour does not change.
 */
function bodyOf(family) {
  const escalatedClass = family.methodClass === "recurring_decline_after_user_feedback";
  if (escalatedClass) {
    // Deliberately excludes methodChanges: those are the same two template
    // sentences for every escalated family, and including them re-merges
    // everything the incident key just separated.
    return [family.incidentSummary ?? "", family.familyKeys?.[0] ?? ""].join("\n").trim();
  }
  return [
    family.methodClass ?? "",
    family.incidentSummary ?? "",
    ...(family.methodChanges ?? [])
  ].join("\n").trim();
}

/**
 * Collapses families that carry the same lesson into one section.
 *
 * The family id is derived from `methodClass` + the reviewer's free-text
 * `proposedFamilyKey`, so the same lesson arrives under a new id whenever the
 * reviewer phrases the key differently. Seven such duplicates were live in one
 * project and accounted for 36.6% of the block.
 */
function mergeFamilies(families) {
  const groups = new Map();
  for (const family of families) {
    const body = bodyOf(family);
    const existing = groups.get(body);
    if (!existing) {
      groups.set(body, {
        severity: family.severity,
        occurrences: family.occurrences,
        incidentSummary: family.incidentSummary ?? null,
        methodClass: family.methodClass ?? null,
        methodChanges: family.methodChanges ?? [],
        // Carried through the merge, not just into it. This is the surface the
        // injector matches a new prompt against; dropping it here made every
        // section render without trigger conditions and left relevance scoring
        // with nothing but the incident narrative to match on.
        appliesWhen: family.appliesWhen ?? [],
        familyKeys: [family.familyKey],
        latestRecurrenceAt: family.latestRecurrenceAt ?? null
      });
      continue;
    }
    // Occurrences are summed: the families are the same lesson, so the user hit
    // it that many times total. Keeping only the max would understate how
    // established the lesson is.
    existing.occurrences += family.occurrences;
    existing.familyKeys.push(family.familyKey);
    // Union the trigger conditions: a merged family is reachable by any of its
    // members' triggers, so dropping the incoming ones would make the merge
    // invisible to prompts that mention only the second family.
    for (const condition of family.appliesWhen ?? []) {
      if (!existing.appliesWhen.includes(condition)) existing.appliesWhen.push(condition);
    }
    for (const key of [family.latestRecurrenceAt, existing.latestRecurrenceAt]) {
      if (!key) continue;
      if (!existing.latestRecurrenceAt || Date.parse(key) > Date.parse(existing.latestRecurrenceAt)) {
        existing.latestRecurrenceAt = key;
      }
    }
    // Severity rises to the worst member's: the group is only as safe as its
    // most severe instance.
    if ((SEVERITY_ORDER[family.severity] ?? 99) < (SEVERITY_ORDER[existing.severity] ?? 99)) {
      existing.severity = family.severity;
    }
  }
  return [...groups.values()];
}

/**
 * Rank order for the budget. Severity dominates, then how often the user hit
 * it, then how recently.
 *
 * Recency matters because the alternative — pure occurrence count — lets a
 * family that was hit 39 times six months ago and has not recurred since
 * outrank one hit five times this week. A lesson that stopped recurring may
 * have been learned; one that keeps recurring has not.
 */
function rankFamilies(families) {
  return [...families].sort((left, right) => {
    const bySeverity = (SEVERITY_ORDER[left.severity] ?? 99) - (SEVERITY_ORDER[right.severity] ?? 99);
    if (bySeverity !== 0) return bySeverity;
    if (left.occurrences !== right.occurrences) return right.occurrences - left.occurrences;
    const leftAt = left.latestRecurrenceAt ? Date.parse(left.latestRecurrenceAt) : 0;
    const rightAt = right.latestRecurrenceAt ? Date.parse(right.latestRecurrenceAt) : 0;
    if (leftAt !== rightAt) return rightAt - leftAt;
    return String(left.familyKeys[0]).localeCompare(String(right.familyKeys[0]), "en-US");
  });
}

/**
 * Trims a string to at most `max` characters, cutting at a sentence or clause
 * boundary rather than mid-word.
 */
function trimToChars(value, max) {
  const text = String(value ?? "").trim();
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  // The ellipsis is part of the budget. Clipping to `max` and then appending
  // "…" returned max+1 characters, so this function had a fixed point ABOVE
  // its own limit: trimming a 121-character result asked for ≤120 produced the
  // same 121-character string again, forever. That is what hung five detached
  // reviewers at 99% CPU for nineteen hours — the shrink loop in renderFamily
  // treats "still over the limit" as "made progress" and never exits.
  const budget = Math.max(0, max - 1);
  if (budget === 0) return "…";
  const clipped = chars.slice(0, budget).join("");
  // Prefer ending on a complete clause; fall back to the hard cut.
  const boundary = Math.max(
    clipped.lastIndexOf("；"),
    clipped.lastIndexOf("。"),
    clipped.lastIndexOf("，"),
    clipped.lastIndexOf("; ")
  );
  return `${(boundary > budget * 0.5 ? clipped.slice(0, boundary) : clipped).trimEnd()}…`;
}

/**
 * Renders one family.
 *
 * A demoted family is no longer a bare heading. A heading names a rule without
 * saying what to do, which is not an instruction the model can follow — the
 * live project had six of them, including the family that had recurred seven
 * times since its lesson was published. Demoted sections now carry the first
 * method change, compressed, so the block always states an action.
 *
 * A full section is capped too. One verbose lesson used to take a quarter of
 * the budget and demote several shorter ones; capping detail nobody reads buys
 * coverage everybody gets.
 */
function renderSection(family, demoted) {
  const label = family.familyKeys.join(", ");
  const lines = [`### ${label} (${family.occurrences}×, ${family.severity})`, ""];
  if (demoted) {
    const first = (family.methodChanges ?? [])[0];
    if (first) {
      lines.push(`→ ${trimToChars(first, DEMOTED_CHANGE_MAX_CHARS)}`, "");
    }
    return lines.join("\n");
  }

  const summaryBudget = Math.floor(MAX_SECTION_BYTES * 0.35);
  const heading = `### ${label} (${family.occurrences}×, ${family.severity})`;
  // The trigger conditions come first on purpose. They are what the injector
  // matches a new prompt against, so a reader skimming a section sees when it
  // applies before seeing what happened once. Rendering only the incident made
  // a "页面样式不一致" prompt match a diagram lesson on an incidental word.
  let conditions = (family.appliesWhen ?? []).slice(0, APPLIES_WHEN_MAX)
    .map((condition) => trimToChars(condition, 160));
  let summary = family.incidentSummary
    ? trimToChars(family.incidentSummary, Math.min(400, summaryBudget))
    : null;
  let changes = (family.methodChanges ?? []).map((change) => trimToChars(change, 300));

  const compose = () => {
    const out = [heading, ""];
    if (conditions.length) {
      out.push("**何时适用：**");
      for (const condition of conditions) out.push(`- ${condition}`);
      out.push("");
    }
    if (summary) out.push(summary, "");
    out.push("**Do not repeat this mistake:**");
    for (const change of changes) out.push(`- ${change}`);
    out.push("");
    return out.join("\n");
  };

  // Shrinking is ordered by what the section is FOR. The method changes are the
  // instruction; everything else is context for it. The previous cap removed
  // trailing "- " lines without knowing which list they belonged to, so on a
  // long section it stripped every method change and kept the narrative — a
  // live section rendered as a heading, an incident paragraph and an empty
  // "Do not repeat this mistake:" with nothing under it. A rule with no
  // instruction is the one outcome this must never produce.
  //
  // Order: shorten the narrative, then drop extra trigger conditions (keeping
  // one), then drop the narrative, then drop trailing method changes but never
  // the first.
  let rendered = compose();
  const shrinkSteps = [
    () => {
      if (!summary || Array.from(summary).length <= 120) return false;
      summary = trimToChars(summary, 120);
      return true;
    },
    () => {
      if (conditions.length <= 1) return false;
      conditions = conditions.slice(0, -1);
      return true;
    },
    () => {
      if (!summary) return false;
      summary = null;
      return true;
    },
    () => {
      if (changes.length <= 1) return false;
      changes = changes.slice(0, -1);
      return true;
    }
  ];
  // The loop must make progress or stop. "Still over the limit" is not the
  // same as "the step shrank something": trimToChars used to return a fixed
  // point just above the limit it was given, so step 0 reported success while
  // changing nothing and this loop never exited. Comparing the rendered length
  // between iterations catches that class of bug for any future step, instead
  // of depending on each step's guard being exactly right.
  for (const step of shrinkSteps) {
    while (byteLength(rendered) > MAX_SECTION_BYTES) {
      const before = rendered;
      if (!step()) break;
      rendered = compose();
      if (rendered === before) break;
    }
    if (byteLength(rendered) <= MAX_SECTION_BYTES) break;
  }
  return rendered;
}

function budgetLine(used, demotedCount, maxBytes) {
  return `<!-- afl:rules:budget ${used}/${maxBytes} demoted=${demotedCount} -->`;
}

const BUDGET_LINE = /<!-- afl:rules:budget (\d+)\/(\d+) demoted=(\d+) -->/u;

/**
 * Reads the budget comment buildRulesBlock writes.
 *
 * Kept machine-readable so `doctor` and `status` can report how close a block
 * is to its ceiling without parsing the sections. A block at its ceiling is not
 * an error — it is the projection working — but knowing how many families were
 * demoted is what tells an operator the tier is saturated rather than quiet.
 */
export function readRulesBlockBudget(block) {
  const match = BUDGET_LINE.exec(String(block ?? ""));
  if (!match) return null;
  return { usedBytes: Number(match[1]), maxBytes: Number(match[2]), demotedCount: Number(match[3]) };
}

/**
 * Builds the managed block.
 *
 * This used to be a projection under one flat byte budget: families that fit
 * kept their full text and the rest were demoted to a heading. That worked
 * until it didn't. On a live project 16 families saturated the block at 97%,
 * 12 of them were demoted to a single line, and the section that did survive
 * was a merged 7-family paragraph describing the review process rather than any
 * of the seven. The root cause was not the budget: it was that every turn got
 * the same list regardless of what had been asked.
 *
 * The block now holds two layers, and the file is allowed to be larger than the
 * injection because only part of it is ever injected:
 *
 * - L1 sections carry the full instruction text for every qualified family.
 * - L0 carries a one-line index of the same families.
 *
 * The file is the durable record; what reaches a turn is decided at injection
 * time by lesson-layers.mjs, which picks the L1 sections the prompt actually
 * touches and always includes L0. Storing all of L1 on disk is the point — the
 * old budget forced the writer to throw instructions away, so a family that was
 * relevant had nothing left to expand into.
 *
 * `maxBytes` now bounds the FILE, not the injection. The injection has its own
 * budget (RULES_BLOCK_MAX_BYTES in cli.mjs) and is bounded by L0 plus a couple
 * of L1 sections, which is far smaller than this.
 *
 * @param {Array<{familyKey: string, severity: string, occurrences: number,
 *   incidentSummary?: string, methodChanges?: string[],
 *   latestRecurrenceAt?: string|null}>} families
 * @param {{maxBytes?: number}} [options]
 */
export function buildRulesBlock(families, { maxBytes = RULES_FILE_BUDGET_BYTES } = {}) {
  if (!Array.isArray(families) || families.length === 0) return null;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256) {
    throw new TypeError("maxBytes must be a safe integer of at least 256");
  }

  const merged = rankFamilies(mergeFamilies(families));

  // Every family that fits the file budget gets a full section. Shedding the
  // tail here is a file-size concern only; it no longer decides what a turn
  // sees, because L0 below still lists what was shed.
  const sections = [];
  const overflowed = [];
  let used = byteLength(AFL_RULES_START) + byteLength(AFL_RULES_END) + 8;
  for (const family of merged) {
    const section = renderSection(family, false);
    const cost = byteLength(section);
    if (used + cost > maxBytes) {
      overflowed.push(family);
      continue;
    }
    used += cost;
    sections.push({ family, text: section });
  }

  // L0 names every family, including any whose full section did not fit. This is
  // the guarantee the flat budget could not give: a family is never invisible.
  const index = merged.map((family) => ({
    familyKey: family.familyKeys[0],
    occurrences: family.occurrences
  }));

  const compose = (bodySections) => {
    const lines = [
      AFL_RULES_START,
      "",
      budgetLine(0, overflowed.length, maxBytes),
      ""
    ];
    for (const section of bodySections) lines.push(section.text.trimEnd(), "");
    lines.push(INDEX_HEADING, "");
    for (const entry of index) lines.push(`- ${entry.familyKey} (${entry.occurrences}×)`);
    lines.push("");
    lines.push(AFL_RULES_END);
    return lines;
  };

  // Shrink until the file fits. The index goes last because it is the cheap
  // layer: dropping a full section costs detail a reader can still reach through
  // the index, while dropping an index line costs the visibility entirely.
  let body = [...sections];
  for (;;) {
    const lines = compose(body);
    const measured = byteLength(lines.join("\n"));
    lines[2] = budgetLine(measured, merged.length - body.length, maxBytes);
    const final = lines.join("\n");
    if (byteLength(final) <= maxBytes) return final;
    if (!body.length) {
      // Even the index alone does not fit. Returning null beats throwing: the
      // caller keeps its previous block instead of freezing on an exception.
      return null;
    }
    body = body.slice(0, -1);
  }
}

export async function getRulesPath(projectDir) {
  return path.join(projectDir, ".agent", "rules", "feedback-loop.md");
}

export async function writeAflRulesBlock(projectDir, block) {
  const filePath = await getRulesPath(projectDir);
  let existing = "";
  try { existing = await readFile(filePath, "utf8"); } catch {}
  const hadBlock = existing.includes(AFL_RULES_START);
  let content = existing;
  if (hadBlock) {
    const before = existing.slice(0, existing.indexOf(AFL_RULES_START));
    const after = existing.slice(existing.indexOf(AFL_RULES_END) + AFL_RULES_END.length);
    content = before + block + after;
  } else {
    content = existing.trimEnd() + "\n\n" + block + "\n";
  }
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, content, "utf8");
  return { path: filePath, replaced: hadBlock };
}

/**
 * Whether the on-disk block is already the block we would write.
 *
 * The projection is deterministic, so an unchanged store can skip the write.
 * That keeps a no-op publication from touching the file's mtime.
 */
export async function rulesBlockIsCurrent(projectDir, block) {
  const filePath = await getRulesPath(projectDir);
  let info;
  try { info = await stat(filePath); } catch { return false; }
  if (!info.isFile()) return false;
  const existing = await readFile(filePath, "utf8");
  const start = existing.indexOf(AFL_RULES_START);
  const end = existing.indexOf(AFL_RULES_END);
  if (start < 0 || end <= start) return false;
  return existing.slice(start, end + AFL_RULES_END.length).trimEnd() === block.trimEnd();
}
