#!/usr/bin/env node
/**
 * The whole effectiveness picture, in one run.
 *
 * Answers four different questions, because they fail independently:
 *
 *   1. RECALL      — when the user hits a known problem, does the lesson get
 *                    selected into the prompt at all?
 *   2. PRECISION   — does it stay out of unrelated work?
 *   3. DELIVERY    — once published, does it actually reach sessions?
 *   4. BEHAVIOUR   — does recurrence actually fall after delivery, against a
 *                    baseline that rules out the project simply going quiet?
 *
 * Each is measured here. Nothing is reported as "working" on the strength of a
 * different number: a lesson can be selected and still change nothing, and a
 * falling recurrence rate can be the project's trend rather than the lesson.
 *
 * Usage: node eval/run-all.mjs
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname);

async function run(name, file, args = []) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [path.join(ROOT, file), ...args], {
      maxBuffer: 32 * 1024 * 1024
    });
    return { name, ok: true, output: stdout.trim() };
  } catch (error) {
    return { name, ok: false, output: String(error?.stderr ?? error?.message ?? error) };
  }
}

const sections = [];

// 1 + 2. Recall and precision, from the labelled corpus.
sections.push(await run("召回率 / 精确率", "recall-precision.mjs"));

// 3. Delivery: was the lesson ever actually emitted to a session?
sections.push(await run("投递覆盖", "delivery.mjs"));

// 4. Behaviour: recurrence before vs after delivery, per session, with the
// project-wide drift reported alongside so the two can be compared.
sections.push(await run("复发变化（14 天）", "session-recurrence.mjs", ["--days=14"]));
sections.push(await run("复发变化（30 天）", "session-recurrence.mjs", ["--days=30"]));
sections.push(await run("项目整体漂移（对照）", "project-drift.mjs"));
sections.push(await run("净效果（扣除项目趋势）", "net-effect.mjs"));

let failed = 0;
for (const section of sections) {
  console.log(`\n${"█".repeat(68)}`);
  console.log(`█ ${section.name}`);
  console.log("█".repeat(68));
  if (!section.ok) {
    failed += 1;
    console.log(section.output);
    continue;
  }
  console.log(section.output);
}
if (failed) console.log(`\n${failed} 个度量失败`);
