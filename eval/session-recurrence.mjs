#!/usr/bin/env node
/**
 * Did delivery reduce recurrence, counted per SESSION rather than per job?
 *
 * Two earlier attempts were wrong in instructive ways:
 *
 * 1. Comparing delivered families against never-delivered ones over one shared
 *    window. 123 of the 210 control families first appeared after that window's
 *    midpoint, so their "before" was structurally zero and the control read as a
 *    184% increase regardless of what the lessons did.
 *
 * 2. Counting review JOBS as occurrences. One session produced 22 rows for a
 *    single family: the same conversation kept re-triggering review jobs for the
 *    same complaint. Counting rows measures how chatty a session was, not how
 *    often the problem recurred.
 *
 * This counts distinct sessions per family — one conversation that hit the same
 * problem is one recurrence, however many messages it contained.
 *
 * Usage: node eval/session-recurrence.mjs [--days=14] [--json]
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

// Distinct sessions, not jobs.
const sessions = db.prepare(`
  SELECT COUNT(DISTINCT event.session_uid) AS n
  FROM reviewer_jobs AS job
  JOIN session_events AS event ON event.event_uid = job.source_event_uid
  WHERE job.family_key=? AND job.project_id=?
    AND job.created_at>=? AND job.created_at<?
`);

function sessionCount(family, project, fromMs, toMs) {
  return sessions.get(
    family, project,
    new Date(fromMs).toISOString(),
    new Date(toMs).toISOString()
  ).n;
}

const paired = [];
const quiet = [];

for (const d of deliveries) {
  const at = Date.parse(d.delivered_at);
  if (!Number.isFinite(at)) continue;
  const span = WINDOW_DAYS * DAY;
  const before = sessionCount(d.family, d.project, at - span, at);
  const after = sessionCount(d.family, d.project, at, at + span);
  if (before === 0) {
    quiet.push({ ...d, before, after });
    continue;
  }
  paired.push({ ...d, before, after, delta: after - before });
}

const improved = paired.filter((r) => r.after < r.before).length;
const worsened = paired.filter((r) => r.after > r.before).length;
const unchanged = paired.filter((r) => r.after === r.before).length;
const totalBefore = paired.reduce((sum, r) => sum + r.before, 0);
const totalAfter = paired.reduce((sum, r) => sum + r.after, 0);

const summary = {
  windowDays: WINDOW_DAYS,
  familiesWithDelivery: deliveries.length,
  comparable: paired.length,
  excludedQuietBefore: quiet.length,
  improved,
  worsened,
  unchanged,
  improvedPct: paired.length ? Math.round((100 * improved) / paired.length) : 0,
  totalSessionsBefore: totalBefore,
  totalSessionsAfter: totalAfter,
  reductionPct: totalBefore ? Number((((totalBefore - totalAfter) / totalBefore) * 100).toFixed(1)) : 0
};

if (args.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ summary, pairs: paired }, null, 2)}\n`);
} else {
  console.log(`=== 按会话计数：同一家族前后 ${WINDOW_DAYS} 天 ===\n`);
  console.log(`有投递记录:         ${summary.familiesWithDelivery}`);
  console.log(`可比对（前有复发）:   ${summary.comparable}`);
  console.log(`排除（前无复发）:     ${summary.excludedQuietBefore}\n`);
  console.log(`减少:  ${summary.improved}  ${summary.improvedPct}%`);
  console.log(`增加:  ${summary.worsened}`);
  console.log(`持平:  ${summary.unchanged}\n`);
  console.log(`会话数  投递前 ${summary.totalSessionsBefore} → 投递后 ${summary.totalSessionsAfter}  (${summary.reductionPct}%)\n`);

  const ranked = [...paired].sort((a, b) => a.delta - b.delta);
  console.log("=== 变化最大 ===");
  for (const r of ranked.slice(0, 4)) console.log(`  ↓ ${r.family.slice(0, 32).padEnd(34)} ${r.before} → ${r.after}`);
  for (const r of ranked.slice(-4)) console.log(`  ↑ ${r.family.slice(0, 32).padEnd(34)} ${r.before} → ${r.after}`);
}
