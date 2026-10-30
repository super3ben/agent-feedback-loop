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
 * The injection budget the reader already enforces (`RULES_BLOCK_MAX_BYTES` in
 * cli.mjs). The writer must produce a block that fits it, so the reader's cap
 * stops being the place where rules quietly disappear.
 */
export const RULES_BLOCK_BUDGET_BYTES = 6 * 1_024;

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
function bodyOf(family) {
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
  const clipped = chars.slice(0, max).join("");
  // Prefer ending on a complete clause; fall back to the hard cut.
  const boundary = Math.max(
    clipped.lastIndexOf("；"),
    clipped.lastIndexOf("。"),
    clipped.lastIndexOf("，"),
    clipped.lastIndexOf("; ")
  );
  return `${(boundary > max * 0.5 ? clipped.slice(0, boundary) : clipped).trimEnd()}…`;
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
  if (family.incidentSummary) {
    lines.push(trimToChars(family.incidentSummary, Math.min(400, summaryBudget)), "");
  }
  lines.push("**Do not repeat this mistake:**");
  for (const change of family.methodChanges) lines.push(`- ${trimToChars(change, 300)}`);
  lines.push("");

  let rendered = lines.join("\n");
  // Cap by dropping trailing method changes, never by cutting a line in half:
  // a truncated method change reads as a complete instruction while missing
  // the part that made it actionable.
  while (byteLength(rendered) > MAX_SECTION_BYTES && lines.length > 4) {
    const lastChange = lines.map((line, index) => (line.startsWith("- ") ? index : -1))
      .filter((index) => index >= 0)
      .pop();
    if (lastChange === undefined) break;
    lines.splice(lastChange, 1);
    rendered = lines.join("\n");
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
 * Builds the managed block within `maxBytes`.
 *
 * Selection is a projection under a byte budget, not an accumulation: families
 * that fit keep their full text, families that do not are demoted to their
 * heading rather than dropped. A demoted family is therefore never lost — it
 * stays visible, keeps its recurrence count, and returns automatically the
 * moment it recurs and outranks something else.
 *
 * @param {Array<{familyKey: string, severity: string, occurrences: number,
 *   incidentSummary?: string, methodChanges?: string[],
 *   latestRecurrenceAt?: string|null}>} families
 * @param {{maxBytes?: number}} [options]
 */
export function buildRulesBlock(families, { maxBytes = RULES_BLOCK_BUDGET_BYTES } = {}) {
  if (!Array.isArray(families) || families.length === 0) return null;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256) {
    throw new TypeError("maxBytes must be a safe integer of at least 256");
  }

  const merged = rankFamilies(mergeFamilies(families));
  const reserve = Math.max(INDEX_RESERVE_MIN_BYTES, Math.floor(maxBytes * INDEX_RESERVE_FRACTION));
  const fullBudget = maxBytes - reserve;

  const sections = [];
  const demoted = [];
  let used = byteLength(AFL_RULES_START) + byteLength(AFL_RULES_END) + 2;
  for (const family of merged) {
    const section = renderSection(family, false);
    const cost = byteLength(section);
    // Merge before evicting: a family only demotes once its section genuinely
    // does not fit, which is why the dedupe pass above runs first.
    if (used + cost > fullBudget) {
      demoted.push(family);
      continue;
    }
    used += cost;
    sections.push(section);
  }

  // Demoted families keep a heading-only line so the block still names them.
  // An index entry that would itself overflow the reserve is dropped, but the
  // count is recorded so the loss is visible rather than silent.
  let unlisted = 0;
  const indexLines = [];
  for (const family of demoted) {
    const section = renderSection(family, true);
    if (used + byteLength(section) > maxBytes) { unlisted += 1; continue; }
    used += byteLength(section);
    indexLines.push(section);
  }

  const lines = [AFL_RULES_START, "", budgetLine(used, demoted.length + unlisted, maxBytes)];
  lines.push(...sections.map((section) => section.trimEnd()));
  if (indexLines.length) {
    lines.push("");
    lines.push("_Demoted: over budget, still counted. A recurrence moves them back up._");
    lines.push("");
    lines.push(...indexLines.map((section) => section.trimEnd()));
  }
  lines.push("");
  lines.push(AFL_RULES_END);

  const block = lines.join("\n");
  if (byteLength(block) > maxBytes) {
    // The invariant is what the reader relied on the byte-slice for; failing
    // loudly here is better than emitting a block that gets cut mid-character.
    throw new Error("rules block exceeds budget after projection");
  }
  return block;
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
