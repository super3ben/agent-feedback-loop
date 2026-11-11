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
import { distinctTerms } from "./reviewer-escalate.mjs";
import {
  buildRulesBlock,
  qualifyForRules,
  readRulesBlockBudget,
  rulesBlockIsCurrent,
  writeAflRulesBlock
} from "./rules-writer.mjs";

/**
 * Recognises the trigger condition the old escalation template wrote.
 *
 * It echoed ~100 characters of the incident and appended a catch-all tail
 * ("或按群类型/项目归属/现场归属/日志时间窗下判断之前"). Two problems, both fatal
 * to matching: the echo is a paragraph rather than a handle, and the tail
 * matches nearly every prompt, so the condition scored everywhere and
 * distinguished nowhere. Measured on a live project, six of sixteen sections
 * still carried it.
 *
 * Both language variants have to be recognised. The template always emitted a
 * Chinese condition AND an English one; matching only the Chinese left the
 * English echo in place, which still scored against every prompt and kept the
 * family ranked on noise.
 */
/**
 * How often a never-published family must have recurred before it earns an
 * index line.
 *
 * Three, matching the Major threshold the published path uses: a class hit
 * three times has proven it recurs, and recurrence is the whole point of the
 * tier. Requiring a publication as well is what hid these families entirely.
 */
const UNPUBLISHED_RECURRENCE_THRESHOLD = 3;

/**
 * How recently an unclassified complaint counts as evidence a family is alive.
 *
 * A family is only as dormant as the review pipeline is healthy. When reviews
 * fail before classifying — 82 jobs died on provider_invalid in one month on a
 * live project, none of them ever naming a family — a live family looks silent,
 * and fading it would withdraw exactly the entry that was needed. This window is
 * the guard against that: silence plus recent unclassified complaints is not
 * silence.
 */
const UNCLASSIFIED_GRACE_DAYS = 21;

/**
 * Whether the review pipeline is healthy enough for silence to mean anything.
 *
 * Fading a family says "this stopped happening". That inference is only valid
 * when reviews actually complete — a failing pipeline produces silence that is
 * indistinguishable from a class that went away. Measured on a live project:
 * 221 of 255 review jobs in three weeks died before naming a family, and the
 * SSH family's last classified recurrence was 81 days old while the complaint
 * was raised again that same week.
 *
 * Matching unclassified complaints back to a family by text was tried first and
 * abandoned: with Chinese complaints the anchor overlap scored an unrelated
 * group-permission complaint above the real SSH one, so the guard would have
 * protected the wrong families. The pipeline's health is measurable without
 * that guess, and it is the same judgement for every family.
 */
function pipelineTrustworthy({ total, unclassified, maxUnclassifiedRatio = 0.3 }) {
  if (!total) return false;
  return unclassified / total <= maxUnclassifiedRatio;
}

const LEGACY_CONDITION = /^当要处理「([\s\S]*)」同类问题/u;
const LEGACY_CONDITION_EN = /^when handling the same class of problem as 「([\s\S]*)」,/u;

/**
 * Rewrites a legacy trigger condition into one built from distinctive terms.
 *
 * Done at projection time rather than by editing the document, because the
 * document's hash is its identity: `documentHash = sha256(bytes)` keys the
 * emission log that decides which lessons were delivered. Rewriting a published
 * file in place would silently split its history in two — the emitted record
 * would point at bytes that no longer exist.
 *
 * @param {string[]} conditions
 * @returns {string[]}
 */
export function normalizeAppliesWhen(conditions) {
  if (!Array.isArray(conditions)) return [];
  const rewritten = [];
  for (const condition of conditions) {
    const text = String(condition ?? "").trim();
    const legacy = LEGACY_CONDITION.exec(text) ?? LEGACY_CONDITION_EN.exec(text);
    if (!legacy) {
      rewritten.push(condition);
      continue;
    }
    // Rebuild from the same incident text, keeping only the distinctive terms.
    const terms = distinctTerms(legacy[1], 3);
    if (!terms.length) continue;
    const echo = terms.join("、");
    rewritten.push(`当任务涉及「${echo}」时，或用户以相近说法指出同类问题时`);
    rewritten.push(`when the task involves ${echo}, or the user raises the same class of problem in similar words`);
  }
  // A catch-all condition matches every prompt and therefore ranks nothing. It
  // is dropped when a specific one exists; kept alone it is better than nothing.
  const isGeneric = (condition) => /当用户对 agent 的工作表达明确不满/u.test(condition)
    || /when the user explicitly expresses dissatisfaction/u.test(condition);
  const specific = rewritten.filter((condition) => !isGeneric(condition));
  return [...new Set(specific)].slice(0, 8);
}

/**
 * Rebuilds the whole managed block from current state rather than appending to
 * it. Selection happens under a fixed byte budget inside buildRulesBlock, so
 * the block cannot grow without bound and nobody has to prune it by hand: a
 * family that stops qualifying leaves, and one that recurs outranks whichever
 * family it displaces. Demotion is a projection, not a deletion — the lesson
 * stays published, stays counted, and returns on its next recurrence.
 */
export async function maybeUpdateRulesTier({ store, projectId, projectDir, readBlob = null }) {
  if (!store || !projectId || !projectDir) return { updated: false, reason: "missing_input" };

  let recurrence;
  try {
    recurrence = store.listFamilyRecurrenceByProject({ projectId, limit: 128 });
  } catch {
    return { updated: false, reason: "recurrence_unavailable" };
  }

  const qualified = [];
  // Families that qualify on recurrence but have never published.
  //
  // The tier used to require a published lesson, which deadlocked the families
  // that needed it most: a class declined every time never publishes, so it
  // never entered the rules block, so the next session had nothing telling it
  // the class existed, so it was declined again. Measured on a live project:
  // ten families, 54 declared occurrences, all invisible — including the SSH
  // credential family that had been declined five times across four months.
  //
  // Recurrence is the signal that advice is not getting through, whether or not
  // a reviewer ever agreed to write it down.
  // Read the unclassified complaints once, then decide per family. This is the
  // counter-evidence that keeps a live-but-unmeasured family from being faded:
  // a failing review pipeline produces silence that looks exactly like a class
  // that stopped happening.
  let unclassified = [];
  if (typeof store.listRecentUnclassifiedEvents === "function") {
    try {
      const since = new Date(Date.now() - UNCLASSIFIED_GRACE_DAYS * 24 * 60 * 60 * 1_000).toISOString();
      unclassified = store.listRecentUnclassifiedEvents({ projectId, since });
    } catch {
      unclassified = [];
    }
  }
  // How much of the recent pipeline actually completed a review. Dormancy is
  // only inferred when this is healthy; otherwise every family looks quiet
  // because nothing is being classified, and fading on that would withdraw the
  // entries the failed reviews were supposed to update.
  let recentTotal = unclassified.length;
  if (typeof store.countRecentReviewJobs === "function") {
    try {
      const since = new Date(Date.now() - UNCLASSIFIED_GRACE_DAYS * 24 * 60 * 60 * 1_000).toISOString();
      recentTotal = store.countRecentReviewJobs({ projectId, since });
    } catch {
      recentTotal = unclassified.length;
    }
  }
  const allowDormancy = pipelineTrustworthy({
    total: recentTotal,
    unclassified: unclassified.length
  });

  const unpublished = [];
  for (const { familyKey, occurrences, lastSeenAt } of recurrence) {
    let job;
    try {
      job = store.getLatestPublishedJobForFamily({ projectId, familyKey });
    } catch {
      continue;
    }
    if (!job) {
      // No published lesson. If the family recurred enough to be worth a rule,
      // it still belongs in the index — the index is what makes it visible at
      // all, and invisibility is the failure being fixed here.
      if (occurrences >= UNPUBLISHED_RECURRENCE_THRESHOLD) {
        unpublished.push({ familyKey, occurrences, lastSeenAt });
      }
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

    // Every published document for this family, not only the newest. A family
    // that keeps recurring accumulates one document per incident, and each
    // records the words of the complaint it came from: measured on a live
    // project, remote-server-log-diagnosis had six, and the phrase users
    // actually type — 「更新失败了」「看下日志是什么问题」 — was in the
    // 2026-08-21 one, while the newest talked about normalize_diff_scalar and
    // state.json. Reading only the latest made the family unmatchable by the
    // words a user uses for it.
    let familyJobs = [job];
    try {
      const all = typeof store.listPublishedJobsForFamily === "function"
        ? store.listPublishedJobsForFamily({ projectId, familyKey })
        : null;
      if (Array.isArray(all) && all.length) familyJobs = all;
    } catch {
      familyJobs = [job];
    }
    const unionConditions = [];
    const seenCondition = new Set();
    for (const familyJob of familyJobs) {
      let familyDocument;
      try {
        familyDocument = parseReflectionMarkdown(await readFile(familyJob.published_path, "utf8"), {
          path: familyJob.published_path
        });
      } catch {
        continue;
      }
      for (const condition of normalizeAppliesWhen(familyDocument?.appliesWhen)) {
        const key = String(condition).trim();
        if (!key || seenCondition.has(key)) continue;
        seenCondition.add(key);
        unionConditions.push(key);
      }
    }

    qualified.push({
      familyKey,
      severity: job.final_severity,
      occurrences,
      // The projection ranks on recency as well as count, so a family that was
      // hit 39 times months ago and has not recurred since yields to one hit
      // five times this week. A lesson that stopped recurring may have been
      // learned; one that keeps recurring has not.
      latestRecurrenceAt: job.completed_at ?? null,
      // When the family last actually recurred, which is when its statement was
      // last corroborated. The index uses this to tell a live fact from one
      // nobody has confirmed in months.
      lastSeenAt: lastSeenAt ?? job.completed_at ?? null,
      // What the user actually complained about, not the reviewer's class label.
      //
      // class_of_mistake is what the section renders, and for escalated families
      // it is one shared boilerplate sentence ("the review kept declining this
      // as not worth learning"). Rendering that as the summary is why a live
      // project's largest section described the review process itself while
      // naming seven unrelated problems in its heading: every one of the seven
      // had the identical body, so the merge key joined them.
      //
      // user_complaint is per-incident, so two escalated families stay distinct
      // and each section says something the reader can act on.
      incidentSummary: document.userComplaint ?? document.classOfMistake ?? null,
      // applies_when is the field written specifically to be matched against the
      // next prompt — the selector weights it highest for exactly that reason.
      // It was never carried into the rules block, so the block had no matching
      // surface but the incident narrative: a prompt about "页面样式" matched a
      // diagram lesson on an incidental word, while the lesson whose trigger
      // literally describes UI style scored zero.
      //
      // Normalised on the way through, so documents published under the old
      // template stop poisoning the match without being rewritten on disk.
      appliesWhen: unionConditions.length ? unionConditions : normalizeAppliesWhen(document.appliesWhen),
      // Dormant only when quiet AND nothing unclassified suggests it is live.
      // The published path says whether the family recurred; the unclassified
      // complaints say whether it might be recurring without being seen.
      dormant: false,
      methodChanges: document.methodChanges
    });
  }

  // A never-published family gets an index entry carrying the user's own words,
  // pulled from the captured turn. It has no lesson document to project from —
  // that is what "never published" means — but the complaint text is durable and
  // is exactly what the next session needs to recognise the situation.
  //
  // Degrades to an index line without a fact when the blob cannot be read: an
  // entry that names the family is still better than the invisibility this
  // replaces, and the caller keeps its previous block on a hard failure.
  for (const { familyKey, occurrences, lastSeenAt } of unpublished) {
    let quote = null;
    if (typeof store.listFamilySourceEvents === "function" && readBlob) {
      try {
        const events = store.listFamilySourceEvents({ projectId, familyKey, limit: 3 });
        for (const event of events) {
          if (!event.encrypted_raw_ref) continue;
          const text = await readBlob(event.encrypted_raw_ref);
          const cleaned = String(text ?? "").replace(/\s+/gu, " ").trim();
          if (cleaned) { quote = cleaned; break; }
        }
      } catch {
        quote = null;
      }
    }
    qualified.push({
      familyKey,
      severity: null,
      occurrences,
      latestRecurrenceAt: null,
      lastSeenAt: lastSeenAt ?? null,
      incidentSummary: quote,
      appliesWhen: quote ? [quote] : [],
      // No lesson was ever written, so there is no method change to carry. The
      // index entry states the fact and the reader decides; inventing an
      // instruction here would be the escalation template problem again.
      methodChanges: [],
      unpublished: true,
      dormant: allowDormancy,
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
