#!/usr/bin/env node
/**
 * Retire publication records whose document is gone.
 *
 * A reviewer job records `published_path` pointing at a Markdown file under the
 * project. When the project directory itself is removed — a worktree torn down, a
 * sub-project archived, a scratch directory cleaned — the row survives and points
 * at nothing. Those rows are not harmless: the delivery report counts them as
 * "published but never reached a session", which reads as a pipeline failure when
 * it is really a record about a project that no longer exists.
 *
 * Detection is deliberately narrow. A row is retired only when its PROJECT
 * directory is gone, never merely because the file is missing: a file deleted
 * inside a living project is a real loss worth investigating, and silently
 * retiring it would hide that.
 *
 * Usage:
 *   node scripts/retire-missing-publications.mjs [--apply] [--json]
 *
 * Retiring is a state change to `reviewer_jobs`, not a delete: the row keeps its
 * history and gains `state='retired_missing_project'` so nothing silently
 * disappears from the record.
 */

import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const apply = args.includes("--apply");

const db = new DatabaseSync(
  path.join(process.env.HOME, ".agent/feedback-loop-data/store/control.sqlite3"),
  { readOnly: !apply }
);

const rows = db.prepare(`
  SELECT job_id, project_id, published_path, completed_at
  FROM reviewer_jobs
  WHERE state = 'published' AND published_path IS NOT NULL
`).all();

function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

const missingProject = [];
const missingFileOnly = [];

for (const row of rows) {
  if (!isDirectory(row.project_id)) {
    missingProject.push(row);
    continue;
  }
  try {
    statSync(row.published_path);
  } catch {
    missingFileOnly.push(row);
  }
}

const summary = {
  published: rows.length,
  missingProject: missingProject.length,
  missingFileInLiveProject: missingFileOnly.length,
  applied: apply
};

if (apply && missingProject.length) {
  const update = db.prepare(`
    UPDATE reviewer_jobs
    SET state = 'retired_missing_project'
    WHERE job_id = ? AND state = 'published'
  `);
  for (const row of missingProject) update.run(row.job_id);
}

if (args.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ summary, missingProject, missingFileOnly }, null, 2)}\n`);
} else {
  console.log(`=== 已发布记录 ${summary.published} 条 ===\n`);
  console.log(`项目目录已删除:              ${summary.missingProject}`);
  console.log(`项目仍在但文件缺失（需排查）: ${summary.missingFileInLiveProject}\n`);

  const byProject = new Map();
  for (const row of missingProject) {
    byProject.set(row.project_id, (byProject.get(row.project_id) ?? 0) + 1);
  }
  if (byProject.size) {
    console.log("项目目录已不存在的记录：");
    for (const [project, count] of byProject) {
      console.log(`  ${count} 条  ${project}`);
    }
  }
  if (missingFileOnly.length) {
    console.log("\n项目仍在、但文件缺失（这些才是真正的丢失，未处理）：");
    for (const row of missingFileOnly.slice(0, 10)) {
      console.log(`  ${row.published_path.split("/").pop()}  (${row.completed_at?.slice(0, 10)})`);
    }
  }
  console.log(apply
    ? `\n已退役 ${summary.missingProject} 条（state → retired_missing_project）。`
    : "\n预演，加 --apply 才会写入。");
}
