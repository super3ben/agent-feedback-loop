/**
 * Compiles published lessons into the project's rules file once a family has
 * recurred enough to be worth a standing rule.
 *
 * A lesson in `.agent/reflections/` only reaches a session if the selector picks
 * it and the model chooses to follow it — that is advisory. A rule in
 * `.agent/rules/` is read every turn. Measured: an SSH credential lesson existed
 * from 2026-07-01, was selected, was injected, and the same mistake still
 * recurred four times. Repetition is the signal that advice is not enough.
 */
import { readFile } from "node:fs/promises";

import { parseReflectionMarkdown } from "./reflection-document.mjs";
import { buildRulesBlock, qualifyForRules, writeAflRulesBlock } from "./rules-writer.mjs";

// Blocker outranks Critical outranks Major, then more recurrences first. The
// order decides what survives if the block is ever capped.
const SEVERITY_RANK = { Blocker: 0, Critical: 1, Major: 2 };

/**
 * Rebuilds the whole managed block from current state rather than appending to
 * it, so a family that stops qualifying disappears and the file cannot drift
 * away from what the store actually holds.
 */
export async function maybeUpdateRulesTier({ store, projectId, projectDir }) {
  if (!store || !projectId || !projectDir) return { updated: false, reason: "missing_input" };

  let recurrence;
  try {
    recurrence = store.listFamilyRecurrenceByProject({ projectId, limit: 128 });
  } catch {
    return { updated: false, reason: "recurrence_unavailable" };
  }

  const qualified = [];
  for (const { familyKey, occurrences } of recurrence) {
    let job;
    try {
      job = store.getLatestPublishedJobForFamily({ projectId, familyKey });
    } catch {
      continue;
    }
    // Severity is null for rows published before it was recorded. Those cannot
    // be graded, so they stay out rather than defaulting into the rules file.
    if (!job?.final_severity || !qualifyForRules(job.final_severity, occurrences)) continue;

    let document;
    try {
      document = parseReflectionMarkdown(await readFile(job.published_path, "utf8"), {
        path: job.published_path
      });
    } catch {
      continue;
    }
    if (!document?.eligible || !document.methodChanges?.length) continue;

    qualified.push({
      familyKey,
      severity: job.final_severity,
      occurrences,
      incidentSummary: document.classOfMistake ?? null,
      methodChanges: document.methodChanges
    });
  }

  if (!qualified.length) return { updated: false, reason: "none_qualified" };

  qualified.sort((left, right) => {
    const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
    return bySeverity !== 0 ? bySeverity : right.occurrences - left.occurrences;
  });

  const block = buildRulesBlock(qualified);
  if (!block) return { updated: false, reason: "empty_block" };

  const written = await writeAflRulesBlock(projectDir, block);
  return { updated: true, path: written.path, familyCount: qualified.length };
}
