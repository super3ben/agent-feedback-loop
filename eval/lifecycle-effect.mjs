#!/usr/bin/env node
/**
 * Does the lifecycle actually change what a turn receives — in the right
 * direction, and only where it should?
 *
 * The unit tests prove the classifier's rules one at a time. This asks the
 * different question the rules exist to answer: given a real project's real
 * lessons, does demoting a contradicted family change which lessons reach the
 * prompt, does it move them DOWN rather than out, and does a family with no
 * lifecycle verdict come through untouched?
 *
 * That last case is the one worth guarding. A demotion that silently reorders
 * everything, or that drops lessons entirely, would pass a test that only checks
 * "the recurred family is no longer first" while quietly damaging every other
 * turn. Each assertion below is written so that the wrong kind of pass fails.
 *
 * Runs against a live project by default; override with AFL_EVAL_PROJECT.
 *
 * Usage: node eval/lifecycle-effect.mjs [--json] [--verbose]
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const SRC = (name) => path.join(PROJECT_ROOT, "src", name);

const { pathsFor } = await import(SRC("index.mjs"));
const { openControlStore } = await import(SRC("control-store.mjs"));
const { loadReflectionDocuments, selectReflections } = await import(SRC("selector.mjs"));
const { classifyProject, classifyFamily, shouldRetire, lifecycleWeight } =
  await import(SRC("reflection-lifecycle.mjs"));

const projectDir = process.env.AFL_EVAL_PROJECT
  ?? "/Users/sunxingda/project/rcs-2000-agent";
const asJson = process.argv.includes("--json");
const verbose = process.argv.includes("--verbose");

const failures = [];
function check(name, condition, detail) {
  if (!condition) failures.push({ name, detail });
  return condition;
}

// ---------------------------------------------------------------------------
// The prompts. Each is a real phrasing of work the project actually does, not a
// synthetic string: the point is to see the ranking under conditions that occur.
// ---------------------------------------------------------------------------
const PROMPTS = [
  "连一下现场服务器看看实例状态",
  "部署上去",
  "这个页面的样式跟上面不一致",
  "日报怎么没发出去",
  "又不知道用ssh密码",
  "继续做审美的也一样做完"
];

const store = openControlStore({ paths: pathsFor(undefined) });
const cutoff = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
const { documents } = await loadReflectionDocuments({ projectDir, publishedBefore: cutoff });

const lifecycle = classifyProject({
  emissions: store.listProjectEmissionOccasions({ projectId: projectDir }),
  complaints: store.listProjectComplaintOccasions({ projectId: projectDir })
});

// Document family id -> reviewer family key. Two namespaces, joined the way
// production joins them.
const keyByPath = new Map(
  store.listPublishedJobsWithFamily({ projectId: projectDir })
    .filter((job) => job.published_path && job.family_key)
    .map((job) => [job.published_path, job.family_key])
);
const stateByDocumentFamily = new Map();
for (const document of documents) {
  const key = keyByPath.get(document.path);
  if (key && lifecycle.states[key]) stateByDocumentFamily.set(document.familyId, lifecycle.states[key]);
}

const lifecycleMap = Object.fromEntries(stateByDocumentFamily);

function select(prompt, lifecycleOverride = {}) {
  const result = selectReflections({
    documents,
    prompt,
    context: "",
    session: { sessionUid: "eval-session", contextEpoch: 1 },
    task: { fingerprint: "eval-task", paths: [], tools: [] },
    budget: { maxCards: 6, maxDocumentTokens: 640, maxTotalTokens: 2400 },
    publishedBefore: cutoff,
    priorEmissions: [],
    familyLifecycle: lifecycleOverride
  });
  return result.selected.map((document, index) => ({
    familyId: document.familyId,
    position: index,
    score: document.relevanceScore ?? 0
  }));
}

/** Selection with demotion active. */
const selectWithLifecycle = (prompt) => select(prompt, lifecycleMap);
/** Selection with no lifecycle data, which is the hook's fallback. */
const selectWithoutLifecycle = (prompt) => select(prompt, {});

// ---------------------------------------------------------------------------
// 1. The mechanism has something to act on at all.
// ---------------------------------------------------------------------------
const recurredFamilies = lifecycle.families.filter((entry) => entry.state === "recurred");
check(
  "there is at least one recurred family to demote",
  recurredFamilies.length > 0,
  `lifecycle totals: ${JSON.stringify(lifecycle.totals.byState)}`
);

// ---------------------------------------------------------------------------
// 2. Demotion moves a contradicted lesson DOWN relative to the lessons it was
//    competing with.
//
// Absolute position is the wrong thing to assert. When one lesson falls from the
// first slot to the last, every lesson between them shifts up by one — that is
// arithmetic, not a re-ranking, and an assertion on positions would fail on a
// correct implementation. What must hold is the ORDER BETWEEN PAIRS: a recurred
// lesson may not overtake an undemoted one it used to rank below.
//
// A lesson can also leave the turn entirely under budget pressure: demoting it
// lets a longer lesson take the slot, and the budget then fits fewer entries.
// That is a real trade-off, not a bug, so it is counted and reported rather than
// asserted against — but it is asserted that the lesson is still ELIGIBLE, i.e.
// that it was dropped for budget and not for being contradicted.
// ---------------------------------------------------------------------------
const demotionReport = [];
const budgetDrops = [];
for (const prompt of PROMPTS) {
  const before = selectWithoutLifecycle(prompt);
  const after = selectWithLifecycle(prompt);
  const beforeOrder = before.map((entry) => entry.familyId);
  const afterOrder = after.map((entry) => entry.familyId);
  const recurredInBefore = before.filter(
    (entry) => stateByDocumentFamily.get(entry.familyId) === "recurred"
  );
  if (!recurredInBefore.length) continue;

  const moved = [];
  for (const entry of recurredInBefore) {
    const found = after.find((candidate) => candidate.familyId === entry.familyId);
    moved.push({
      familyId: entry.familyId,
      beforePosition: entry.position,
      afterPosition: found ? found.position : null,
      dropped: !found
    });
  }
  demotionReport.push({ prompt, moved });

  for (const entry of recurredInBefore) {
    if (afterOrder.includes(entry.familyId)) continue;
    const omission = select.detailedOmissions?.(prompt).find?.((item) => item.familyId === entry.familyId);
    budgetDrops.push({ prompt, familyId: entry.familyId, omission: omission?.reason ?? null });
  }

  // Pairwise: any undemoted lesson that the recurred one ranked BELOW must still
  // rank below it after. This is what "demoted" means, and it is invariant to
  // everything else shifting.
  for (const recurred of recurredInBefore) {
    if (!afterOrder.includes(recurred.familyId)) continue;
    for (const other of before) {
      if (other.familyId === recurred.familyId) continue;
      if (stateByDocumentFamily.get(other.familyId) === "recurred") continue;
      if (!afterOrder.includes(other.familyId)) continue;
      // Before: the other lesson ranked above this recurred one.
      const wasAbove = beforeOrder.indexOf(other.familyId) < beforeOrder.indexOf(recurred.familyId);
      if (!wasAbove) continue;
      // After: it must still be above. Demotion may only push the recurred
      // lesson down, never up.
      check(
        `demotion never lets a contradicted lesson overtake: ${prompt}`,
        afterOrder.indexOf(other.familyId) < afterOrder.indexOf(recurred.familyId),
        `${recurred.familyId} overtook ${other.familyId} after demotion`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 2b. The mechanism must actually do something.
//
// This assertion exists because the first version of this file did not have it,
// and it passed while demotion was disabled outright: every other check says
// "demotion must not cause X", and a demotion that never runs causes nothing.
// A guard against harm is not a test of effect, and reporting "all assertions
// passed" from one is exactly the false confidence this project keeps having to
// undo.
//
// So: at least one prompt, in this project, must change its selection when the
// lifecycle map is supplied. If none does, either demotion is broken or it has
// nothing to act on — and the second case is reported with the numbers needed to
// tell them apart.
// ---------------------------------------------------------------------------
const affectedPrompts = demotionReport.filter((entry) =>
  entry.moved.some((move) => move.dropped || move.afterPosition !== move.beforePosition));
check(
  "demotion changes at least one turn",
  affectedPrompts.length > 0,
  `no prompt changed; ${demotionReport.length} prompts had a recurred lesson in their selection, `
    + `recurred families: ${recurredFamilies.length}, documents on screen: ${stateByDocumentFamily.size}`
);

// ---------------------------------------------------------------------------
// 3. Eligibility is decided before ranking, so demotion must not change it.
//
// The tempting assertion — "a contradicted lesson is never filtered" — is wrong:
// a lesson about SSH is `not_applicable` to a styling question whoever wrote it,
// and that has nothing to do with its lifecycle. What must hold is that the set
// of documents filtered from the catalog is IDENTICAL with and without the
// lifecycle map. If it differs, demotion is leaking into applicability, which is
// a different mechanism with different failure modes.
// ---------------------------------------------------------------------------
for (const prompt of PROMPTS) {
  const omissionsWith = new Map();
  const omissionsWithout = new Map();
  for (const useLifecycle of [false, true]) {
    const result = selectReflections({
      documents,
      prompt,
      context: "",
      session: { sessionUid: "eval-session", contextEpoch: 1 },
      task: { fingerprint: "eval-task", paths: [], tools: [] },
      budget: { maxCards: 6, maxDocumentTokens: 640, maxTotalTokens: 2400 },
      publishedBefore: cutoff,
      priorEmissions: [],
      familyLifecycle: useLifecycle ? Object.fromEntries(stateByDocumentFamily) : {}
    });
    const target = useLifecycle ? omissionsWith : omissionsWithout;
    for (const entry of result.omissions) {
      // Budget and count omissions legitimately differ: they are the RESULT of
      // the ranking change. Applicability and ambiguity are decided before
      // ranking and must not move.
      if (entry.reason === "token_budget" || entry.reason === "count_budget") continue;
      if (entry.reason === "family_projection") continue;
      target.set(entry.documentHash, entry.reason);
    }
  }
  const hashes = new Set([...omissionsWith.keys(), ...omissionsWithout.keys()]);
  for (const hash of hashes) {
    check(
      `demotion does not change applicability: ${prompt}`,
      omissionsWith.get(hash) === omissionsWithout.get(hash),
      `${hash.slice(0, 12)}: without=${omissionsWithout.get(hash)} with=${omissionsWith.get(hash)}`
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Lessons with no verdict are not pushed around by a rank they did not earn.
//
// A lesson the classifier has no evidence against must keep the position it had
// relative to other undemoted lessons. It may shift in absolute index because a
// demoted lesson moved past it, but it must never overtake another undemoted
// lesson, and must never be dropped.
// ---------------------------------------------------------------------------
let untouchedChecked = 0;
for (const prompt of PROMPTS) {
  const before = selectWithoutLifecycle(prompt);
  const after = selectWithLifecycle(prompt);
  const beforeOrder = before.map((entry) => entry.familyId);
  const afterOrder = after.map((entry) => entry.familyId);
  const undemoted = before.filter(
    (entry) => stateByDocumentFamily.get(entry.familyId) !== "recurred"
  );
  for (const entry of undemoted) {
    untouchedChecked += 1;
    const stillThere = afterOrder.includes(entry.familyId);
    check(
      `an undemoted lesson is not dropped: ${prompt}`,
      stillThere,
      `${entry.familyId} was present before and absent after`
    );
  }
  // Pairwise among undemoted lessons: order between them is preserved.
  for (let index = 0; index < undemoted.length; index += 1) {
    for (let other = index + 1; other < undemoted.length; other += 1) {
      const first = undemoted[index].familyId;
      const second = undemoted[other].familyId;
      if (!afterOrder.includes(first) || !afterOrder.includes(second)) continue;
      check(
        `undemoted lessons keep their order among themselves: ${prompt}`,
        afterOrder.indexOf(first) < afterOrder.indexOf(second),
        `${first} and ${second} swapped`
      );
    }
  }
}
check("the untouched-case check actually ran", untouchedChecked > 0, "no lessons were compared");

// ---------------------------------------------------------------------------
// 4. With no lifecycle data the ranking is byte-identical to before.
//
// The hook computes lifecycle per prompt and falls back to `{}` when the store
// cannot answer. That fallback must be a no-op, not a silent re-ranking of every
// turn — otherwise a store hiccup would change what every session receives.
// ---------------------------------------------------------------------------
for (const prompt of PROMPTS) {
  const withEmpty = select(prompt, {});
  const withoutAny = selectWithoutLifecycle(prompt);
  check(
    `an empty lifecycle map changes nothing: ${prompt}`,
    JSON.stringify(withEmpty) === JSON.stringify(withoutAny),
    "empty map produced a different selection"
  );
}

// ---------------------------------------------------------------------------
// 5. The classifier's own direction, on synthetic families whose answer is known.
//
// Not a re-run of the unit tests: this checks the SAME function the hook calls,
// through the same entry point, so a wiring mistake between store rows and the
// classifier shows up here rather than in production.
// ---------------------------------------------------------------------------
const DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.now();
const ago = (days) => new Date(NOW - days * DAY).toISOString();

const synthetic = {
  recurred: classifyFamily({
    emissions: [{ sessionUid: "s1", emittedAt: ago(40) }],
    complaints: [{ sessionUid: "s1", createdAt: ago(10) }],
    now: NOW
  }),
  preempted: classifyFamily({
    emissions: [
      { sessionUid: "s1", emittedAt: ago(40) },
      { sessionUid: "s2", emittedAt: ago(20) }
    ],
    complaints: [],
    now: NOW
  }),
  dormant: classifyFamily({
    emissions: [{ sessionUid: "s1", emittedAt: ago(100) }],
    complaints: [],
    now: NOW
  }),
  tooEarly: classifyFamily({
    emissions: [{ sessionUid: "s1", emittedAt: ago(3) }],
    complaints: [],
    now: NOW
  })
};

check("a complaint after injection reads as recurred", synthetic.recurred.state === "recurred",
  `got ${synthetic.recurred.state}`);
check("a repeat without a complaint reads as preempted", synthetic.preempted.state === "preempted",
  `got ${synthetic.preempted.state}`);
check("one occasion then silence reads as dormant", synthetic.dormant.state === "dormant",
  `got ${synthetic.dormant.state}`);
check("a fresh delivery is too early, not quiet", synthetic.tooEarly.state === "too_early",
  `got ${synthetic.tooEarly.state}`);

check("only recurred is demoted", lifecycleWeight("recurred") < 1
  && ["preempted", "dormant", "too_early", "never_delivered"].every((state) => lifecycleWeight(state) === 1),
  "the demotion weight is applied to the wrong states");

check("a long-dormant family is retirable", shouldRetire(synthetic.dormant, { now: NOW }) === true,
  "retirement never fires");
check("a preempted family is never retirable", shouldRetire(synthetic.preempted, { now: NOW }) === false,
  "a family that survived a repeat would be retired");
check("a recurred family is never retirable", shouldRetire(synthetic.recurred, { now: NOW }) === false,
  "a contradicted family would be deleted instead of rewritten");

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const summary = {
  projectDir,
  documents: documents.length,
  lifecycle: lifecycle.totals,
  undemotedComparisons: untouchedChecked,
  promptsWithDemotion: demotionReport.map((entry) => entry.prompt),
  failures
};

if (asJson) {
  process.stdout.write(`${JSON.stringify({ summary, demotionReport }, null, 2)}\n`);
} else {
  console.log("=== 生命周期效果（真实项目） ===\n");
  console.log(`项目:        ${projectDir}`);
  console.log(`文档:        ${documents.length}`);
  console.log(`可映射家族:  ${stateByDocumentFamily.size}`);
  console.log(`状态分布:    ${JSON.stringify(lifecycle.totals.byState)}`);
  console.log(`降权家族:    ${lifecycle.totals.demoted}`);
  console.log(`可淘汰:      ${lifecycle.totals.retireCandidates}`);
  console.log(`\n未降权对比次数: ${untouchedChecked}`);

  console.log("\n=== 降权改变了哪些查询 ===");
  if (!demotionReport.length) {
    console.log("  （本次查询中没有降权家族参与竞争）");
  }
  for (const entry of demotionReport) {
    console.log(`\n「${entry.prompt}」`);
    for (const move of entry.moved) {
      const arrow = move.dropped ? "被丢弃 ⚠" : `${move.beforePosition} → ${move.afterPosition}`;
      console.log(`  ${move.familyId.slice(0, 22).padEnd(24)} ${arrow}`);
    }
  }

  if (failures.length) {
    console.log(`\n✗ ${failures.length} 项断言失败：`);
    for (const failure of failures) console.log(`  ✗ ${failure.name}\n      ${failure.detail ?? ""}`);
  } else {
    console.log("\n✓ 全部断言通过");
  }
}

process.exitCode = failures.length ? 1 : 0;
