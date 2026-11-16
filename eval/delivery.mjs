#!/usr/bin/env node
/**
 * Delivery coverage: of the lessons that were published, how many ever reached
 * a session?
 *
 * A published lesson that is never delivered is a file on disk. This is the
 * step between "the pipeline wrote something" and "a prompt saw it", and it
 * fails independently of both selection and behaviour — the selector can only
 * choose among documents it is given, and a document whose conditions match
 * nothing is never chosen.
 *
 * Reported separately:
 *   - published but never emitted   → unreachable, the selector never picked it
 *   - emitted at least once         → reachable in practice
 *   - emitted but to very few turns → reachable in theory, rare in practice
 *
 * Usage: node eval/delivery.mjs [--json]
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const db = new DatabaseSync(
  path.join(process.env.HOME, ".agent/feedback-loop-data/store/control.sqlite3"),
  { readOnly: true }
);

// Every published job, with how many times its document was emitted.
const rows = db.prepare(`
  SELECT job.project_id AS project,
         job.family_key AS family,
         job.published_path AS document,
         (SELECT COUNT(*) FROM reflection_emissions e
           WHERE e.document_path = job.published_path
             AND e.outcome = 'emitted' AND e.emitted_at IS NOT NULL) AS deliveries
  FROM reviewer_jobs AS job
  WHERE job.state = 'published' AND job.published_path IS NOT NULL
`).all();

const byProject = new Map();
for (const row of rows) {
  const name = row.project.split("/").pop();
  const entry = byProject.get(name) ?? { total: 0, delivered: 0, never: 0, low: 0 };
  entry.total += 1;
  if (row.deliveries === 0) entry.never += 1;
  else if (row.deliveries <= 2) entry.low += 1;
  else entry.delivered += 1;
  byProject.set(name, entry);
}

const totals = [...byProject.values()].reduce((acc, entry) => ({
  total: acc.total + entry.total,
  delivered: acc.delivered + entry.delivered,
  never: acc.never + entry.never,
  low: acc.low + entry.low
}), { total: 0, delivered: 0, never: 0, low: 0 });

const reachable = totals.delivered + totals.low;
const summary = {
  published: totals.total,
  neverDelivered: totals.never,
  lowDelivery: totals.low,
  wellDelivered: totals.delivered,
  reachable,
  reachablePct: totals.total ? Math.round((100 * reachable) / totals.total) : 0
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ summary, byProject: Object.fromEntries(byProject) }, null, 2)}\n`);
} else {
  console.log("=== 投递覆盖：已发布的教训有多少真正进过会话 ===\n");
  console.log("项目                  发布数  从未投递  投递≤2次  ≥3次");
  for (const [name, entry] of [...byProject.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(
      `${name.padEnd(20)} ${String(entry.total).padStart(6)} ${String(entry.never).padStart(9)} ` +
      `${String(entry.low).padStart(8)} ${String(entry.delivered).padStart(5)}`
    );
  }
  console.log("");
  console.log(`合计 ${summary.published} 篇`);
  console.log(`  从未投递:   ${summary.neverDelivered}  ${Math.round(100 * summary.neverDelivered / summary.published)}%`);
  console.log(`  投递 1-2 次: ${summary.lowDelivery}`);
  console.log(`  投递 ≥3 次:  ${summary.wellDelivered}`);
  console.log(`\n实际可达率: ${summary.reachablePct}%`);
}
