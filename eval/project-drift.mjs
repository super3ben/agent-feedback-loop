#!/usr/bin/env node
/**
 * The control measurement: how much did each project's overall activity change
 * across the same 14-day windows?
 *
 * A lesson can only be credited with a fall in recurrence if the project itself
 * did not simply go quiet. This measures total review activity per project over
 * the same before/after windows used by session-recurrence.mjs, across ALL
 * families — delivered or not. If the whole project fell by a similar amount,
 * the lesson gets no credit; the drop was the project's trend.
 *
 * Usage: node eval/project-drift.mjs [--days=14] [--json]
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

// Total activity per project, across every family.
const activity = db.prepare(`SELECT COUNT(*) AS n FROM reviewer_jobs
  WHERE project_id=? AND created_at>=? AND created_at<?
  AND family_key IS NOT NULL AND family_key <> ''`);

// Minimum activity for a window to say anything; below this a percentage change
// is noise, not a trend.
const MIN_ACTIVITY = 5;

const samples = [];
for (const delivery of deliveries) {
  const at = Date.parse(delivery.delivered_at);
  if (!Number.isFinite(at)) continue;
  const span = WINDOW_DAYS * DAY;
  const before = activity.get(
    delivery.project,
    new Date(at - span).toISOString(),
    new Date(at).toISOString()
  ).n;
  const after = activity.get(
    delivery.project,
    new Date(at).toISOString(),
    new Date(at + span).toISOString()
  ).n;
  if (before < MIN_ACTIVITY) continue;
  samples.push({ before, after, change: (after - before) / before });
}

const meanChange = samples.length
  ? samples.reduce((sum, sample) => sum + sample.change, 0) / samples.length
  : 0;
const medianChange = samples.length
  ? [...samples.map((s) => s.change)].sort((a, b) => a - b)[Math.floor(samples.length / 2)]
  : 0;

const summary = {
  windowDays: WINDOW_DAYS,
  samples: samples.length,
  meanChangePct: Number((meanChange * 100).toFixed(1)),
  medianChangePct: Number((medianChange * 100).toFixed(1))
};

if (args.includes("--json")) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  console.log(`=== 项目整体活跃度变化（同 ${WINDOW_DAYS} 天窗口，全部家族）===\n`);
  console.log(`有效样本: ${summary.samples}`);
  console.log(`项目整体变化: 均值 ${summary.meanChangePct}%  中位 ${summary.medianChangePct}%\n`);
  console.log("这是对照组。若它接近教训组的下降幅度，教训就没有独立作用；");
  console.log("若它接近 0，教训组的下降不是项目整体变安静造成的。");
}
