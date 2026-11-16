#!/usr/bin/env node
/**
 * Does a delivered lesson actually reduce recurrence?
 *
 * The naive comparison — occurrences before delivery vs after — is misleading on
 * its own: the "after" window is usually shorter, so it counts fewer occurrences
 * for reasons that have nothing to do with the lesson working. Every rate below
 * is per day of exposure, and families with too little exposure on either side
 * are reported separately rather than folded into an average that would read as
 * evidence.
 *
 * Usage: node eval/effectiveness.mjs [--json]
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const controlDb = path.join(
  process.env.HOME,
  ".agent/feedback-loop-data/store/control.sqlite3"
);

const db = new DatabaseSync(controlDb, { readOnly: true });
const DAY = 24 * 60 * 60 * 1_000;

// One row per family per project, with the first time that family was actually
// delivered to a session. "Delivered" means the emission log recorded an emit,
// not merely that a document was published — publication without delivery never
// reaches a prompt.
const families = db.prepare(`
  WITH delivered AS (
    SELECT job.family_key AS family,
           job.project_id AS project,
           MIN(emission.emitted_at) AS first_at
    FROM reflection_emissions AS emission
    JOIN reviewer_jobs AS job ON job.published_path = emission.document_path
    WHERE emission.outcome = 'emitted' AND emission.emitted_at IS NOT NULL
    GROUP BY job.family_key, job.project_id
  )
  SELECT d.family, d.project, d.first_at,
    (SELECT COUNT(*) FROM reviewer_jobs r
      WHERE r.family_key = d.family AND r.project_id = d.project
        AND r.created_at < d.first_at) AS before_count,
    (SELECT MIN(r.created_at) FROM reviewer_jobs r
      WHERE r.family_key = d.family AND r.project_id = d.project) AS earliest,
    (SELECT MAX(r.created_at) FROM reviewer_jobs r
      WHERE r.family_key = d.family AND r.project_id = d.project) AS latest,
    (SELECT COUNT(*) FROM reviewer_jobs r
      WHERE r.family_key = d.family AND r.project_id = d.project
        AND r.created_at >= d.first_at) AS after_count
  FROM delivered d
`).all();

const rows = [];
for (const f of families) {
  if (!f.first_at || !f.earliest) continue;
  const delivery = Date.parse(f.first_at);
  const earliest = Date.parse(f.earliest);
  const latest = Date.parse(f.latest);
  if (!Number.isFinite(delivery) || !Number.isFinite(earliest)) continue;

  const beforeDays = (delivery - earliest) / DAY;
  const afterDays = (latest - delivery) / DAY;
  // Exposure below a day on either side cannot produce a rate worth comparing.
  if (beforeDays < 1 || afterDays < 1) {
    rows.push({ ...f, insufficient: true, beforeDays, afterDays });
    continue;
  }
  rows.push({
    ...f,
    insufficient: false,
    beforeDays,
    afterDays,
    beforeRate: f.before_count / beforeDays,
    afterRate: f.after_count / afterDays
  });
}

const usable = rows.filter((r) => !r.insufficient);
const improved = usable.filter((r) => r.afterRate < r.beforeRate);
const worsened = usable.filter((r) => r.afterRate > r.beforeRate);
const unchanged = usable.filter((r) => r.afterRate === r.beforeRate);

const mean = (values) => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : 0;

const summary = {
  familiesDelivered: rows.length,
  comparable: usable.length,
  insufficientExposure: rows.length - usable.length,
  improved: improved.length,
  worsened: worsened.length,
  unchanged: unchanged.length,
  improvedPct: usable.length ? Math.round((100 * improved.length) / usable.length) : 0,
  meanBeforeRatePerDay: Number(mean(usable.map((r) => r.beforeRate)).toFixed(4)),
  meanAfterRatePerDay: Number(mean(usable.map((r) => r.afterRate)).toFixed(4)),
  medianBeforeRatePerDay: Number(
    usable.map((r) => r.beforeRate).sort((a, b) => a - b)[Math.floor(usable.length / 2)]?.toFixed(4) ?? 0
  ),
  medianAfterRatePerDay: Number(
    usable.map((r) => r.afterRate).sort((a, b) => a - b)[Math.floor(usable.length / 2)]?.toFixed(4) ?? 0
  )
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ summary, rows: usable }, null, 2)}\n`);
} else {
  console.log("=== 投递后复发率变化（按天归一） ===\n");
  console.log(`投递过的家族:        ${summary.familiesDelivered}`);
  console.log(`可比对（两侧≥1天）:   ${summary.comparable}`);
  console.log(`曝光不足无法比对:     ${summary.insufficientExposure}`);
  console.log("");
  console.log(`变好（复发率下降）:   ${summary.improved}  ${summary.improvedPct}%`);
  console.log(`变差（复发率上升）:   ${summary.worsened}`);
  console.log(`持平:                ${summary.unchanged}`);
  console.log("");
  console.log(`日均复发率  投递前 ${summary.meanBeforeRatePerDay}  投递后 ${summary.meanAfterRatePerDay}`);
  console.log(`中位数      投递前 ${summary.medianBeforeRatePerDay}  投递后 ${summary.medianAfterRatePerDay}`);
  console.log("");
  console.log("=== 变化最大的家族 ===");
  const ranked = [...usable].sort((a, b) =>
    (b.afterRate - b.beforeRate) - (a.afterRate - a.beforeRate));
  for (const r of ranked.slice(0, 5)) {
    console.log(`  ↑ ${r.family.slice(0, 34).padEnd(36)} ${r.beforeRate.toFixed(3)} → ${r.afterRate.toFixed(3)} /天`);
  }
  for (const r of ranked.slice(-5)) {
    console.log(`  ↓ ${r.family.slice(0, 34).padEnd(36)} ${r.beforeRate.toFixed(3)} → ${r.afterRate.toFixed(3)} /天`);
  }
}
