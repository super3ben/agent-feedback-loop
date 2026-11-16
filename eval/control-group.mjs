#!/usr/bin/env node
/**
 * The control group: did recurrence fall for families that were NEVER delivered?
 *
 * A drop in recurrence after delivery means nothing on its own. Projects change:
 * work moves to other areas, a feature stabilises, the user stops touching that
 * part of the codebase. If undelivered families fell by the same amount over the
 * same calendar window, the delivered drop is the project's trend, not the
 * lesson's effect.
 *
 * This splits every family into delivered / never-delivered and reports both,
 * then compares them. The number that matters is the DIFFERENCE.
 *
 * Usage: node eval/control-group.mjs [--json]
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const db = new DatabaseSync(
  path.join(process.env.HOME, ".agent/feedback-loop-data/store/control.sqlite3"),
  { readOnly: true }
);
const DAY = 24 * 60 * 60 * 1_000;

// Every family that ever had a review job, with the date of its first delivery
// if it ever had one.
const families = db.prepare(`
  WITH delivered AS (
    SELECT job.family_key AS family, job.project_id AS project,
           MIN(emission.emitted_at) AS first_at
    FROM reflection_emissions AS emission
    JOIN reviewer_jobs AS job ON job.published_path = emission.document_path
    WHERE emission.outcome = 'emitted' AND emission.emitted_at IS NOT NULL
    GROUP BY job.family_key, job.project_id
  ),
  agg AS (
    SELECT family_key AS family, project_id AS project,
           COUNT(*) AS n, MIN(created_at) AS earliest, MAX(created_at) AS latest
    FROM reviewer_jobs
    WHERE family_key IS NOT NULL AND family_key <> ''
    GROUP BY family_key, project_id
  )
  SELECT a.family, a.project, a.n, a.earliest, a.latest, d.first_at
  FROM agg a
  LEFT JOIN delivered d ON d.family = a.family AND d.project = a.project
`).all();

// The window used for the control: from the earliest delivery on record to the
// latest job on record. Undelivered families are measured over the same window,
// so both groups face the same calendar conditions.
const deliveries = families.map((f) => f.first_at).filter(Boolean).map(Date.parse).sort((a, b) => a - b);
if (deliveries.length === 0) {
  console.error("no deliveries recorded; nothing to compare");
  process.exit(1);
}
const windowStart = Math.min(...deliveries);
const windowEnd = Math.max(...families.map((f) => Date.parse(f.latest)).filter(Number.isFinite));

const half = (windowStart + windowEnd) / 2;

function countInRange(family, project, from, to) {
  return db.prepare(`SELECT COUNT(*) AS n FROM reviewer_jobs
    WHERE family_key=? AND project_id=? AND created_at>=? AND created_at<?`)
    .get(family, project, new Date(from).toISOString(), new Date(to).toISOString()).n;
}

const MIDPOINT = new Date(half).toISOString();
const START = new Date(windowStart).toISOString();
const END = new Date(windowEnd).toISOString();

const deliveredRows = [];
const controlRows = [];

for (const f of families) {
  const first = f.first_at ? Date.parse(f.first_at) : null;
  const beforeN = countInRange(f.family, f.project, windowStart, half);
  const afterN = countInRange(f.family, f.project, half, windowEnd);
  const beforeDays = (half - windowStart) / DAY;
  const afterDays = (windowEnd - half) / DAY;
  if (beforeDays < 1 || afterDays < 1) continue;

  const row = {
    family: f.family,
    before: beforeN / beforeDays,
    after: afterN / afterDays,
    beforeN,
    afterN
  };
  // "Delivered during the observed window" — the lesson had a chance to act.
  if (first && first < half) deliveredRows.push(row);
  else controlRows.push(row);
}

const mean = (rows, key) => rows.length
  ? rows.reduce((sum, r) => sum + r[key], 0) / rows.length
  : 0;
const deltaPct = (rows) => {
  const b = mean(rows, "before");
  const a = mean(rows, "after");
  return b === 0 ? 0 : ((a - b) / b) * 100;
};
const improvedPct = (rows) => rows.length
  ? Math.round((100 * rows.filter((r) => r.after < r.before).length) / rows.length)
  : 0;

const summary = {
  window: { start: START, end: END, midpoint: MIDPOINT },
  delivered: {
    families: deliveredRows.length,
    beforeRate: Number(mean(deliveredRows, "before").toFixed(4)),
    afterRate: Number(mean(deliveredRows, "after").toFixed(4)),
    changePct: Number(deltaPct(deliveredRows).toFixed(1)),
    improvedPct: improvedPct(deliveredRows)
  },
  control: {
    families: controlRows.length,
    beforeRate: Number(mean(controlRows, "before").toFixed(4)),
    afterRate: Number(mean(controlRows, "after").toFixed(4)),
    changePct: Number(deltaPct(controlRows).toFixed(1)),
    improvedPct: improvedPct(controlRows)
  }
};
summary.netEffectPct = Number((summary.delivered.changePct - summary.control.changePct).toFixed(1));

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  console.log("=== 对照组：同一时间窗，投递 vs 未投递 ===\n");
  console.log(`观察窗口: ${START.slice(0, 10)} → ${END.slice(0, 10)}（中点 ${MIDPOINT.slice(0, 10)}）\n`);
  console.log("                    家族数   前日均   后日均   变化     变好占比");
  for (const [label, g] of [["已投递", summary.delivered], ["未投递(对照)", summary.control]]) {
    console.log(
      `${label.padEnd(16)} ${String(g.families).padStart(6)} ${g.beforeRate.toFixed(3).padStart(8)} ` +
      `${g.afterRate.toFixed(3).padStart(8)} ${(g.changePct + "%").padStart(8)} ${(g.improvedPct + "%").padStart(8)}`
    );
  }
  console.log(`\n净效果 = 投递组变化 − 对照组变化 = ${summary.netEffectPct}%`);
  console.log(summary.netEffectPct < -10
    ? "→ 投递组下降幅度明显大于对照，教训可能有效"
    : summary.netEffectPct < 10
      ? "→ 两组变化接近，看不出教训的独立作用"
      : "→ 投递组反而更差，需要排查");
}
