#!/usr/bin/env node
/**
 * Same-family before/after around the moment a lesson was delivered.
 *
 * The previous attempt compared delivered families against never-delivered ones
 * over one shared calendar window. That comparison is invalid: 123 of the 210
 * never-delivered families first appeared AFTER that window's midpoint, so their
 * "before" rate was structurally zero and they read as a 184% increase no matter
 * what the lessons did.
 *
 * This measures each family against ITS OWN baseline instead: the N days before
 * its lesson was delivered versus the N days after. Same family, same project,
 * same length — the only thing that changed is that a lesson arrived.
 *
 * A family that was quiet before delivery has no rate to improve on, so those are
 * excluded rather than counted as successes. The comparison therefore answers
 * "among families that were actively recurring, did delivery reduce it".
 *
 * Usage: node eval/before-after.mjs [--days=14] [--json]
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const args = process.argv.slice(2);
const daysArg = args.find((arg) => arg.startsWith("--days="));
const WINDOW_DAYS = daysArg ? Number(daysArg.split("=")[1]) : 14;
const DAY = 24 * 60 * 60 * 1_000;

const db = new DatabaseSync(
  path.join(process.env.HOME, ".agent/feedback-loop-data/store/control.sqlite3"),
  { readOnly: true }
);

const deliveries = db.prepare(`
  SELECT job.family_key AS family, job.project_id AS project,
         MIN(emission.emitted_at) AS delivered_at
  FROM reflection_emissions AS emission
  JOIN reviewer_jobs AS job ON job.published_path = emission.document_path
  WHERE emission.outcome = 'emitted' AND emission.emitted_at IS NOT NULL
    AND job.family_key IS NOT NULL AND job.family_key <> ''
  GROUP BY job.family_key, job.project_id
`).all();

const count = db.prepare(`SELECT COUNT(*) AS n FROM reviewer_jobs
  WHERE family_key=? AND project_id=? AND created_at>=? AND created_at<?`);

function occurrences(family, project, fromMs, toMs) {
  return count.get(
    family, project,
    new Date(fromMs).toISOString(),
    new Date(toMs).toISOString()
  ).n;
}

const paired = [];
const excluded = [];

for (const d of deliveries) {
  const at = Date.parse(d.delivered_at);
  if (!Number.isFinite(at)) continue;
  const windowMs = WINDOW_DAYS * DAY;
  const before = occurrences(d.family, d.project, at - windowMs, at);
  const after = occurrences(d.family, d.project, at, at + windowMs);
  // Quiet before delivery means there is no baseline to improve on. Counting it
  // as "still zero, therefore a success" would inflate the result with families
  // the lesson never had to hold back.
  if (before === 0) {
    excluded.push({ ...d, before, after, reason: "投递前安静，无基线" });
    continue;
  }
  paired.push({ ...d, before, after, delta: after - before });
}

const improved = paired.filter((r) => r.after < r.before).length;
const worsened = paired.filter((r) => r.after > r.before).length;
const same = paired.filter((r) => r.after === r.before).length;
const sumBefore = paired.reduce((sum, r) => sum + r.before, 0);
const sumAfter = paired.reduce((sum, r) => sum + r.after, 0);

const summary = {
  windowDays: WINDOW_DAYS,
  familiesWithDelivery: deliveries.length,
  comparable: paired.length,
  excludedQuietBefore: excluded.length,
  improved,
  worsened,
  unchanged: same,
  improvedPct: paired.length ? Math.round((100 * improved) / paired.length) : 0,
  worsenedPct: paired.length ? Math.round((100 * worsened) / paired.length) : 0,
  totalBefore: sumBefore,
  totalAfter: sumAfter,
  reductionPct: sumBefore ? Number((((sumBefore - sumAfter) / sumBefore) * 100).toFixed(1)) : 0,
  meanBefore: paired.length ? Number((sumBefore / paired.length).toFixed(2)) : 0,
  meanAfter: paired.length ? Number((sumAfter / paired.length).toFixed(2)) : 0
};

if (args.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ summary, pairs: paired }, null, 2)}\n`);
} else {
  console.log(`=== 同一家族前后 ${WINDOW_DAYS} 天对比（以投递时刻为界） ===\n`);
  console.log(`有投递记录的家族:   ${summary.familiesWithDelivery}`);
  console.log(`可比对（投递前有复发）: ${summary.comparable}`);
  console.log(`排除（投递前安静）:   ${summary.excludedQuietBefore}\n`);
  console.log(`减少复发:  ${summary.improved}  ${summary.improvedPct}%`);
  console.log(`增加复发:  ${summary.worsened}  ${summary.worsenedPct}%`);
  console.log(`持平:      ${summary.unchanged}\n`);
  console.log(`总复发次数  投递前 ${summary.totalBefore} → 投递后 ${summary.totalAfter}  (${summary.reductionPct}%)`);
  console.log(`均值        投递前 ${summary.meanBefore} → 投递后 ${summary.meanAfter}\n`);

  if (paired.length) {
    console.log("=== 明细（变化最大的） ===");
    const ranked = [...paired].sort((a, b) => a.delta - b.delta);
    for (const r of ranked.slice(0, 4)) {
      console.log(`  ↓ ${r.family.slice(0, 32).padEnd(34)} ${r.before} → ${r.after}`);
    }
    for (const r of ranked.slice(-4)) {
      console.log(`  ↑ ${r.family.slice(0, 32).padEnd(34)} ${r.before} → ${r.after}`);
    }
  }
}
