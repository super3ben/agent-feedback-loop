#!/usr/bin/env node
/**
 * Why each never-delivered lesson never matched.
 *
 * For every published document that no session ever received, this reports the
 * concrete reason rather than a category: which prompts came close, what score
 * it actually reached, and what the highest-scoring prompt had in common with
 * its conditions (and what it did not).
 *
 * The distinction matters because "not applicable" covers several different
 * failures that need different fixes:
 *
 *   - conditions describe the COMPLAINT instead of the trigger, so they only
 *     match after the mistake has already happened
 *   - conditions are in a vocabulary nobody types
 *   - conditions are so long that no prompt shares enough of them
 *   - the document competes with a higher-scoring family every time
 *
 * Usage: node eval/why-unmatched.mjs [--project=<path>] [--limit=N] [--json]
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { loadReflectionDocuments, selectReflections, estimateGuidanceTokens } from "../src/selector.mjs";
import { EncryptedBlobStore, BlobKeyProvider } from "../src/crypto-store.mjs";

const args = process.argv.slice(2);
const projectArg = args.find((a) => a.startsWith("--project="))?.split("=")[1];
const limitArg = args.find((a) => a.startsWith("--limit="))?.split("=")[1];
const LIMIT = limitArg ? Number(limitArg) : 30;

const db = new DatabaseSync(
  path.join(process.env.HOME, ".agent/feedback-loop-data/store/control.sqlite3"),
  { readOnly: true }
);
const blobs = new EncryptedBlobStore({
  root: path.join(process.env.HOME, ".agent/feedback-loop-data/blobs/sha256"),
  keyProvider: new BlobKeyProvider({ keyRoot: path.join(process.env.HOME, ".agent/feedback-loop-keys") })
});

// Documents that were published and never emitted to any session.
const neverDelivered = db.prepare(`
  SELECT job.project_id AS project, job.published_path AS doc, job.family_key AS family
  FROM reviewer_jobs AS job
  WHERE job.state = 'published' AND job.published_path IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM reflection_emissions e
      WHERE e.document_path = job.published_path
        AND e.outcome = 'emitted' AND e.emitted_at IS NOT NULL)
`).all();

const projects = [...new Set(neverDelivered.map((r) => r.project))]
  .filter((p) => !projectArg || p === projectArg);

function features(value) {
  const norm = String(value ?? "").normalize("NFKC").toLocaleLowerCase("en-US");
  const latin = new Set(norm.match(/[\p{Script=Latin}\p{Number}]+/gu) ?? []);
  const cjk = new Set();
  for (const run of norm.match(/[\p{Script=Han}]+/gu) ?? []) {
    const points = Array.from(run);
    for (let i = 0; i + 1 < points.length; i += 1) cjk.add(points[i] + points[i + 1]);
  }
  return { latin, cjk };
}

const overlap = (a, b) => {
  let n = 0;
  for (const t of a.latin) if (b.latin.has(t)) n += 1;
  for (const t of a.cjk) if (b.cjk.has(t)) n += 1;
  return n;
};

const report = [];

for (const project of projects) {
  let catalog;
  try {
    catalog = await loadReflectionDocuments({
      projectDir: project,
      publishedBefore: new Date().toISOString()
    });
  } catch {
    continue;
  }
  const byPath = new Map(catalog.documents.map((d) => [d.path, d]));

  // Real user prompts from this project, newest first.
  const refs = db.prepare(`
    SELECT DISTINCT e.encrypted_raw_ref AS ref
    FROM session_events e JOIN sessions s ON s.session_uid = e.session_uid
    WHERE s.project_id = ? AND e.role = 'user'
    ORDER BY e.created_at DESC LIMIT 60`).all(project);
  const prompts = [];
  for (const row of refs) {
    try {
      const text = await blobs.read(row.ref);
      if (text) prompts.push(String(text).replace(/\s+/g, " ").slice(0, 300));
    } catch {}
  }

  for (const record of neverDelivered.filter((r) => r.project === project).slice(0, LIMIT)) {
    const doc = byPath.get(record.doc);
    if (!doc) {
      report.push({ project, family: record.family, status: "文件不在 catalog（解析失败）" });
      continue;
    }

    // Best overlap any real prompt achieved with this document's conditions.
    const conditionFeatures = features((doc.appliesWhen ?? []).join(" "));
    let best = { prompt: null, score: 0 };
    for (const prompt of prompts) {
      const score = overlap(features(prompt), conditionFeatures);
      if (score > best.score) best = { prompt, score };
    }

    // Cost: does it fit at all?
    const cost = estimateGuidanceTokens(JSON.stringify({
      appliesWhen: (doc.appliesWhen ?? []).slice(0, 3),
      methodChanges: (doc.methodChanges ?? []).slice(0, 2)
    }));

    // Would it be selected if a prompt genuinely were about it? Simulated with
    // its own first condition, which is the most favourable prompt possible.
    const selfProbe = (doc.appliesWhen ?? [])[0] ?? "";
    const probe = selectReflections({
      documents: catalog.documents,
      prompt: selfProbe,
      session: {},
      task: {},
      budget: { maxCards: 6, maxDocumentTokens: 640, maxTotalTokens: 2400 },
      publishedBefore: new Date().toISOString(),
      familyRecurrence: {}
    });
    const selfReachable = probe.selected.some((d) => d.path === doc.path);

    report.push({
      project: project.split("/").pop(),
      family: record.family,
      conditions: (doc.appliesWhen ?? []).length,
      conditionChars: (doc.appliesWhen ?? []).join("").length,
      cost,
      bestScore: best.score,
      bestPrompt: best.prompt,
      selfReachable
    });
  }
}

if (args.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const unreachable = report.filter((r) => r.selfReachable === false).length;
  const zeroOverlap = report.filter((r) => r.bestScore === 0).length;
  const weakOverlap = report.filter((r) => r.bestScore > 0 && r.bestScore < 3).length;

  console.log(`=== ${report.length} 篇从未投递的文档 ===\n`);
  console.log(`即使拿它自己的条件当提示也选不中（竞争不过）: ${unreachable}`);
  console.log(`与全部真实提示零重叠（词汇表对不上）:        ${zeroOverlap}`);
  console.log(`重叠 1-2 个词（信号太弱）:                    ${weakOverlap}\n`);

  console.log("家族                                    条件 字数  成本  最佳重叠  自探测");
  for (const row of report) {
    if (row.status) {
      console.log(`${String(row.family).slice(0, 38).padEnd(40)} ${row.status}`);
      continue;
    }
    console.log(
      `${String(row.family).slice(0, 38).padEnd(40)} ${String(row.conditions).padStart(3)} ` +
      `${String(row.conditionChars).padStart(5)} ${String(row.cost).padStart(5)} ` +
      `${String(row.bestScore).padStart(6)}  ${row.selfReachable ? "✓" : "✗"}`
    );
  }
}
