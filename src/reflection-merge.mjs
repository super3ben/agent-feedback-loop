/**
 * Collapses documents that describe the same class of mistake into one entry.
 *
 * The catalog accumulates one file per reviewed incident, so a class the user
 * keeps hitting arrives as N files that say almost the same thing. Measured on
 * a live project: 62 documents, but two classes alone accounted for 25 of them —
 * 17 files sharing one class_of_mistake sentence and 8 sharing another. Each
 * file competed for the same injection budget as a genuinely different lesson,
 * and the repeated ones crowded out the specific ones.
 *
 * Merging is a read-time projection, not a rewrite. The newest member keeps its
 * identity — its path and its document hash — because that hash keys the
 * emission log that records what was actually delivered. Giving the merged entry
 * a synthesized hash would point the delivery history at bytes that no longer
 * exist. The other members are recorded in `mergedFrom` so the full incidents
 * stay reachable on disk.
 */
import path from "node:path";

/** How much of class_of_mistake decides "same class". */
const GROUP_KEY_CHARS = 60;
/** Cap on merged method changes, matching the write-side schema bound. */
const MAX_MERGED_CHANGES = 5;
/** Prefix length used to treat two method changes as the same instruction. */
const DEDUPE_PREFIX_CHARS = 40;

/**
 * Normalizes a class_of_mistake into a grouping key.
 *
 * Punctuation and whitespace are stripped because reviewers write the same
 * sentence with different trailing punctuation and spacing, and those variants
 * must land in the same group or the merge does nothing.
 */
export function groupKeyOf(document) {
  return String(document?.classOfMistake ?? "")
    .replace(/[\s\p{P}]/gu, "")
    .slice(0, GROUP_KEY_CHARS);
}

function changesOf(document) {
  return (document?.methodChanges ?? []).filter((entry) => String(entry ?? "").trim());
}

/**
 * Merges one group into a single document.
 *
 * The newest member supplies the identity and the matching surface
 * (applies_when, class_of_mistake); method changes are unioned across every
 * member, newest first, because two incidents of the same class usually
 * contribute different concrete instructions and dropping either loses a fix.
 */
function mergeGroup(documents) {
  const sorted = [...documents].sort((left, right) => {
    const byTime = Date.parse(left.createdAt ?? 0) - Date.parse(right.createdAt ?? 0);
    if (byTime !== 0) return byTime;
    return String(left.documentHash ?? "").localeCompare(String(right.documentHash ?? ""), "en-US");
  });
  if (sorted.length === 1) return null;

  // Within one family, a later document SUPERSEDES the earlier one rather than
  // adding to it: that is what a recurrence looks like when the reviewer
  // restates the lesson. Unioning those would resurrect an instruction the newer
  // review deliberately replaced. Cross-family duplicates are the opposite case
  // — different reviewers described the same class independently — so only
  // those are unioned below.
  const byFamily = new Map();
  for (const document of sorted) {
    const family = document.familyId ?? document.path ?? "";
    const existing = byFamily.get(family);
    if (!existing || Date.parse(document.createdAt ?? 0) >= Date.parse(existing.createdAt ?? 0)) {
      byFamily.set(family, document);
    }
  }
  const survivors = [...byFamily.values()].sort((left, right) =>
    Date.parse(left.createdAt ?? 0) - Date.parse(right.createdAt ?? 0));
  const newest = survivors[survivors.length - 1];

  // No cross-family duplication: the group is one family's own history, which
  // the selector already projects to its newest member.
  if (survivors.length === 1) {
    return {
      ...newest,
      mergedFrom: sorted.filter((document) => document !== newest).map((document) => document.path).filter(Boolean),
      mergedCount: sorted.length
    };
  }

  const seen = new Set();
  const mergedChanges = [];
  for (const document of [...survivors].reverse()) {
    for (const change of changesOf(document)) {
      const key = change.slice(0, DEDUPE_PREFIX_CHARS);
      if (seen.has(key)) continue;
      seen.add(key);
      mergedChanges.push(change);
      if (mergedChanges.length >= MAX_MERGED_CHANGES) break;
    }
    if (mergedChanges.length >= MAX_MERGED_CHANGES) break;
  }

  return {
    ...newest,
    // Union of every member's instructions, newest first. Falls back to the
    // skeleton's own list when every member repeats the same instruction.
    methodChanges: mergedChanges.length ? mergedChanges : newest.methodChanges,
    mergedFrom: sorted
      .filter((document) => document !== newest)
      .map((document) => document.path)
      .filter(Boolean),
    mergedCount: sorted.length
  };
}

/**
 * @param {Array<object>} documents
 * @returns {{documents: Array<object>, mergedGroups: Array<{key: string, count: number, kept: string, dropped: string[]}>}}
 */
export function mergeReflectionDocuments(documents) {
  if (!Array.isArray(documents) || documents.length === 0) {
    return { documents: [], mergedGroups: [] };
  }

  const groups = new Map();
  const ungrouped = [];
  for (const document of documents) {
    const key = groupKeyOf(document);
    // A document with no class_of_mistake has no basis for grouping; it stays
    // on its own rather than being lumped with every other empty one.
    if (!key) {
      ungrouped.push(document);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(document);
  }

  const merged = [...ungrouped];
  const mergedGroups = [];
  for (const [key, members] of groups) {
    if (members.length === 1) {
      merged.push(members[0]);
      continue;
    }
    const collapsed = mergeGroup(members);
    if (!collapsed) {
      merged.push(members[0]);
      continue;
    }
    merged.push(collapsed);
    mergedGroups.push({
      key,
      count: members.length,
      kept: path.basename(String(collapsed.path ?? "")),
      dropped: collapsed.mergedFrom.map((value) => path.basename(String(value)))
    });
  }

  return { documents: merged, mergedGroups };
}
