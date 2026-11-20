/**
 * Does a lesson's VOCABULARY survive into an answer, for families whose lesson
 * is Chinese?
 *
 * lesson-verify.mjs measures a family by Latin identifiers — `draft.json`,
 * `8766`, `L1-contract`. Those are what a model copies verbatim, but an
 * identifier only counts as a marker when it is unique to one family. On the
 * live 58-family corpus, 14 families yield no such marker: every identifier in
 * them is shared with another family or already in the prompt. This script runs
 * the same A/B those families need: one arm with no `.agent` at all, one arm
 * with only the family's rules block, both asked the family's own trigger
 * condition, and both scored by how many of the family's project-specific terms
 * they contain (src/lesson-structure.mjs).
 *
 * The number that decides whether the signal is worth anything is not the
 * treatment count. It is the gap between the two conditions against the gap
 * between two runs of the SAME condition: a lesson that moves an answer by two
 * terms is not demonstrated if the same prompt moves it by two terms on its own.
 *
 *   node eval/structure-ab.mjs --project <dir> --family <id> [--family <id>] \
 *     [--repeat 2] [--out /tmp/structure-ab.json]
 *
 * Every answer is written to the output file, so scoring can be re-run against a
 * different extractor without paying for the model calls again.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { loadReflectionDocuments } from "../src/selector.mjs";
import { buildRulesBlock } from "../src/rules-writer.mjs";
import { resolveReviewerExecutable } from "../src/reviewer-provider.mjs";
import { buildVocabulary, extractObjects, scoreObjects } from "../src/lesson-structure.mjs";

function optionValues(args, name) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && index + 1 < args.length) out.push(args[index + 1]);
  }
  return out;
}

function optionValue(args, name, fallback) {
  return optionValues(args, name)[0] ?? fallback;
}

const runOne = ({ claudeBin, workspace, prompt }) => new Promise((resolve) => {
  const child = spawn(claudeBin, [
    "-p", prompt,
    // No tools. The question is answered from context alone, so neither arm can
    // reach the repository as a second source of truth.
    "--disallowedTools", "Read", "Grep", "Glob", "Bash"
  ], { cwd: workspace, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += String(chunk); });
  child.on("error", () => resolve({ answer: "", error: "spawn_failed" }));
  child.on("close", (code) => resolve({ answer: out, exitCode: code }));
});

/** Runs tasks with a cap, so a six-call run does not open six model sessions. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

const args = process.argv.slice(2);
const projectDir = optionValue(args, "--project", "");
const familyIds = optionValues(args, "--family");
const repeat = Number(optionValue(args, "--repeat", "2"));
const concurrency = Number(optionValue(args, "--concurrency", "3"));
const outPath = optionValue(args, "--out", "");
if (!projectDir) throw new Error("--project <dir> is required");
if (!familyIds.length) throw new Error("--family <id> is required (repeatable)");

const { documents } = await loadReflectionDocuments({
  projectDir,
  publishedBefore: new Date(Date.now() + 1_000).toISOString()
});

// The vocabulary is built from EVERY family, not just the three under test: the
// whole point of the generic list is what the rest of the project says.
const vocabulary = buildVocabulary(documents);
const families = new Map(documents.map((document) => [document.familyId, document]));

const claudeBin = await resolveReviewerExecutable({ cli: "claude" });
if (!claudeBin) throw new Error("claude executable not found");

const workRoot = await mkdtemp(path.join(tmpdir(), "afl-structure-ab-"));

const planned = [];
for (const familyId of familyIds) {
  const document = families.get(familyId);
  if (!document) throw new Error(`family not found: ${familyId}`);
  const family = {
    familyKey: document.familyId,
    severity: document.severity,
    occurrences: 3,
    incidentSummary: document.classOfMistake,
    appliesWhen: document.appliesWhen,
    methodChanges: document.methodChanges
  };
  const rawPrompt = String(document.appliesWhen?.[0] ?? document.classOfMistake ?? familyId);
  const prompt = rawPrompt.replace(/^\s*[-*+]\s+/u, "").trim() || familyId;
  const objects = extractObjects({ family, vocabulary, prompt, max: 10 });
  const block = buildRulesBlock([family]);

  const controlDir = path.join(workRoot, `${familyId}-control`);
  const treatmentDir = path.join(workRoot, `${familyId}-treatment`);
  await mkdir(controlDir, { recursive: true });
  await mkdir(path.join(treatmentDir, ".agent", "rules"), { recursive: true });
  await writeFile(path.join(treatmentDir, ".agent", "rules", "feedback-loop.md"), block, "utf8");

  for (let round = 1; round <= repeat; round += 1) {
    planned.push({ familyId, condition: "control", round, workspace: controlDir, prompt });
    planned.push({ familyId, condition: "treatment", round, workspace: treatmentDir, prompt });
  }
  planned.push({ meta: true, familyId, prompt, objects, blockBytes: Buffer.byteLength(block) });
}

const meta = planned.filter((entry) => entry.meta);
const runs = planned.filter((entry) => !entry.meta);

const answers = await mapLimit(runs, concurrency, async (entry) => {
  const { answer, exitCode } = await runOne({
    claudeBin,
    workspace: entry.workspace,
    prompt: entry.prompt
  });
  return { ...entry, answer, exitCode };
});

const scored = answers.map((entry) => {
  const { objects } = meta.find((item) => item.familyId === entry.familyId);
  const score = scoreObjects({ answer: entry.answer, terms: objects });
  return {
    family: entry.familyId,
    condition: entry.condition,
    round: entry.round,
    exitCode: entry.exitCode,
    answerChars: entry.answer.length,
    count: score.count,
    hits: score.hits,
    missing: objects.filter((term) => !score.hits.includes(term)),
    answer: entry.answer
  };
});

const summary = meta.map((item) => {
  const rows = scored.filter((entry) => entry.family === item.familyId);
  const pick = (condition) => rows.filter((row) => row.condition === condition).map((row) => row.count);
  const control = pick("control");
  const treatment = pick("treatment");
  const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
  const spread = (values) => (values.length > 1 ? Math.max(...values) - Math.min(...values) : 0);
  return {
    family: item.familyId,
    prompt: item.prompt,
    objects: item.objects,
    controlCounts: control,
    treatmentCounts: treatment,
    controlMean: mean(control),
    treatmentMean: mean(treatment),
    separation: mean(treatment) - mean(control),
    controlNoise: spread(control),
    treatmentNoise: spread(treatment),
    sameConditionNoise: Math.max(spread(control), spread(treatment)),
    beatsNoise: Math.abs(mean(treatment) - mean(control)) > Math.max(spread(control), spread(treatment))
  };
});

const report = {
  checkedAt: new Date().toISOString(),
  projectDir,
  repeat,
  families: summary,
  answers: scored
};

if (outPath) await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await rm(workRoot, { recursive: true, force: true });

console.log(JSON.stringify({
  projectDir,
  repeat,
  outPath: outPath || null,
  families: summary.map((entry) => ({
    family: entry.family,
    objects: entry.objects,
    control: entry.controlCounts,
    treatment: entry.treatmentCounts,
    separation: entry.separation,
    sameConditionNoise: entry.sameConditionNoise,
    beatsNoise: entry.beatsNoise
  })),
  perAnswer: scored.map((entry) => ({
    family: entry.family,
    condition: entry.condition,
    round: entry.round,
    count: entry.count,
    chars: entry.answerChars,
    hits: entry.hits,
    exitCode: entry.exitCode
  }))
}, null, 2));
