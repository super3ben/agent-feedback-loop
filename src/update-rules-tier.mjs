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
import {
  buildRulesBlock,
  qualifyForRules,
  readRulesBlockBudget,
  rulesBlockIsCurrent,
  writeAflRulesBlock
} from "./rules-writer.mjs";

/**
 * Rebuilds the whole managed block from current state rather than appending to
 * it. Selection happens under a fixed byte budget inside buildRulesBlock, so
 * the block cannot grow without bound and nobody has to prune it by hand: a
 * family that stops qualifying leaves, and one that recurs outranks whichever
 * family it displaces. Demotion is a projection, not a deletion — the lesson
 * stays published, stays counted, and returns on its next recurrence.
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
      // The projection ranks on recency as well as count, so a family that was
      // hit 39 times months ago and has not recurred since yields to one hit
      // five times this week. A lesson that stopped recurring may have been
      // learned; one that keeps recurring has not.
      latestRecurrenceAt: job.completed_at ?? null,
      incidentSummary: document.classOfMistake ?? null,
      methodChanges: document.methodChanges
    });
  }

  if (!qualified.length) return { updated: false, reason: "none_qualified" };

  const block = buildRulesBlock(qualified);
  if (!block) return { updated: false, reason: "empty_block" };

  const budget = readRulesBlockBudget(block);
  // The projection is deterministic, so an unchanged store produces an
  // unchanged block and the file's mtime need not move.
  if (await rulesBlockIsCurrent(projectDir, block)) {
    return { updated: false, reason: "already_current", familyCount: qualified.length, budget };
  }

  const written = await writeAflRulesBlock(projectDir, block);
  return { updated: true, path: written.path, familyCount: qualified.length, budget };
}
