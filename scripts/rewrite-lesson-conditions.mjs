#!/usr/bin/env node
/**
 * Rewrite the matching conditions and instructions of already-published lessons.
 *
 * The evidence in a published lesson is correct; what is wrong is how it asks to
 * be reached and what it tells the reader to do:
 *
 *   - `applies_when` quotes the one incident instead of summarising the
 *     situation, so only a user who rephrases it identically is matched.
 *   - It is written twice, once per language, and the copy that cannot match
 *     anything spends the six-condition budget.
 *   - `method_changes` says "先检查…确认是否已有…" — a pointer to look
 *     somewhere else, which a reader cannot execute. That exact shape delivered
 *     for months on the SSH credential lesson while the mistake kept recurring.
 *
 * This rewrites only those two fields. The title, facts, user complaint, root
 * cause, severity, family and identity are left byte-identical: this is not a
 * re-publication and must not look like one.
 *
 * Usage:
 *   node scripts/rewrite-lesson-conditions.mjs <project-dir> [--apply] [--limit N]
 *
 * Reads and writes one file at a time, and skips a document whose rewrite fails,
 * so an interrupted run leaves every untouched document exactly as published.
 * Progress goes to stderr; the machine-readable summary to stdout.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseReflectionMarkdown, readReflectionCatalog } from "../src/reflection-document.mjs";
import { resolveReviewerExecutable, runReviewerProvider } from "../src/reviewer-provider.mjs";
import { pathsFor } from "../src/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROMPT_FILE = path.join(ROOT, "templates", "prompts", "rewrite-lesson-conditions.md");
const SCHEMA_FILE = path.join(ROOT, "templates", "schemas", "rewrite-lesson-result.schema.json");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const limitIndex = args.indexOf("--limit");
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : Number.POSITIVE_INFINITY;
// The value after --limit is not a project directory. When --limit is absent,
// limitIndex is -1 and limitIndex + 1 is 0, which would otherwise drop the first
// real argument — that is every invocation that does not pass --limit.
const limitValueIndex = limitIndex >= 0 ? limitIndex + 1 : -1;

// Sharding, because one document costs a provider call and a project with a
// hundred of them takes hours serially. `--shard i/n` processes only the
// documents whose position modulo n is i, so n processes divide the work with
// no coordination and no shared state.
const shardIndex = args.indexOf("--shard");
let shard = null;
if (shardIndex >= 0) {
  const [of, total] = String(args[shardIndex + 1] ?? "").split("/").map(Number);
  if (!Number.isSafeInteger(of) || !Number.isSafeInteger(total) || total < 1 || of < 0 || of >= total) {
    console.error("--shard expects i/n with 0 <= i < n");
    process.exit(1);
  }
  shard = { index: of, total };
}
const shardValueIndex = shardIndex >= 0 ? shardIndex + 1 : -1;

// Documents already rewritten by an earlier run, so a restarted or re-sharded
// run resumes instead of paying for the same provider call twice.
const skipIndex = args.indexOf("--skip-list");
let skipList = new Set();
if (skipIndex >= 0) {
  const text = await readFile(args[skipIndex + 1], "utf8");
  skipList = new Set(text.split("\n").map((line) => line.trim()).filter(Boolean));
}
const skipValueIndex = skipIndex >= 0 ? skipIndex + 1 : -1;

const projectDirs = args.filter((arg, index) =>
  !arg.startsWith("--") && index !== limitValueIndex && index !== shardValueIndex && index !== skipValueIndex);

if (projectDirs.length === 0) {
  console.error("Usage: rewrite-lesson-conditions.mjs <project-dir> [--apply] [--limit N]");
  process.exit(1);
}

// Mirrors the canonical encoder in reflection-document.mjs: these characters
// must be escaped or the pipe-joined metadata line splits wrong.
const CANONICAL_ESCAPES = new Map([["%", "%25"], ["\\", "%5C"], ["|", "%7C"], ["\r", "%0D"], ["\n", "%0A"]]);
const encodeCanonicalText = (value) =>
  value.replace(/[%\\|\r\n]/gu, (character) => CANONICAL_ESCAPES.get(character));

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LATIN_PROSE = /[A-Za-z]{3,}(?:\s+[A-Za-z']{2,}){2,}/u;
// The shape that made the SSH lesson inert: an instruction that starts by
// telling the reader to go and check something somewhere else.
const POINTER_PHRASE = /^\s*(?:先|要|应|需要|务必|请)?\s*(?:检查|确认|核对|查(?:看|一下)?|核实|排查|评估|了解|弄清|回顾|审视|参考|注意)/u;
const CONCRETE_ANCHOR = /[`'"“”][^`'"“”]{2,}[`'"“”]|\b\d{1,3}(?:\.\d{1,3}){3}\b|\b[A-Za-z][A-Za-z0-9_.-]{2,}\b/u;

const EXACT_KEYS = new Set(["applies_when", "method_changes"]);

function fail(message) {
  throw new TypeError(message);
}

function validateRewrite(value, { language }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("result is not an object");
  const keys = Object.keys(value);
  if (keys.length !== EXACT_KEYS.size || keys.some((key) => !EXACT_KEYS.has(key))) {
    fail("result has unexpected fields");
  }
  const conditions = value.applies_when;
  const changes = value.method_changes;
  if (!Array.isArray(conditions) || conditions.length < 1 || conditions.length > 6) fail("applies_when out of bounds");
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 4) fail("method_changes out of bounds");

  const cleanConditions = conditions.map((entry) => String(entry ?? "").trim());
  if (cleanConditions.some((entry) => entry.length < 4 || entry.length > 160)) fail("applies_when item out of bounds");

  // One language only. The whole point of the rewrite is that the second
  // rendering cannot match anything, so a result that still carries both is
  // rejected rather than published and silently wasted.
  const carriesCjk = cleanConditions.some((entry) => CJK.test(entry));
  if (language === "cjk" && !carriesCjk) fail("applies_when is not in the user's language");
  const mixedInOne = cleanConditions.filter((entry) => CJK.test(entry) && LATIN_PROSE.test(entry));
  if (language === "cjk" && mixedInOne.length === cleanConditions.length) {
    fail("applies_when still carries an English rendering of every condition");
  }

  const cleanChanges = changes.map((entry) => String(entry ?? "").trim());
  if (cleanChanges.some((entry) => entry.length < 4 || entry.length > 300)) fail("method_changes item out of bounds");
  const actionable = cleanChanges.some((entry) => !POINTER_PHRASE.test(entry) || CONCRETE_ANCHOR.test(entry));
  if (!actionable) fail("method_changes only points elsewhere; no entry states an action");

  return { applies_when: cleanConditions, method_changes: cleanChanges };
}

/**
 * Replace exactly two regions of the document and leave every other byte alone.
 *
 * Rewriting the whole file from parsed values would be simpler and wrong: it
 * would normalise the title, the body and the trailing sections, and the
 * document hash is what the delivery log recorded.
 */
function spliceRewrite(markdown, rewritten) {
  const lines = markdown.split("\n");
  const appliesIndex = lines.findIndex((line) => line.startsWith("- applies_when: "));
  if (appliesIndex < 0) fail("document has no applies_when line");
  lines[appliesIndex] = `- applies_when: ${rewritten.applies_when.map(encodeCanonicalText).join(" | ")}`;

  const headingIndex = lines.findIndex((line) => line.trim() === "## method change");
  if (headingIndex < 0) fail("document has no method change section");
  let end = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) { end = index; break; }
  }
  const replacement = ["", ...rewritten.method_changes.map((entry, index) => `${index + 1}. ${encodeCanonicalText(entry)}`), ""];
  lines.splice(headingIndex + 1, end - headingIndex - 1, ...replacement);
  return lines.join("\n");
}

const paths = pathsFor();
const executable = await resolveReviewerExecutable({ cli: "codex", env: process.env });
if (!executable) {
  console.error("ERROR: no codex reviewer executable found");
  process.exit(1);
}

const summary = { considered: 0, rewritten: 0, skipped: 0, failed: 0, documents: [] };

for (const projectDir of projectDirs) {
  const catalog = await readReflectionCatalog({
    projectDir,
    publishedBefore: new Date(Date.now() + 60_000).toISOString()
  });
  const reflectionDir = path.join(projectDir, ".agent", "reflections");

  // The catalog gives parsed documents; each one is mapped back to the file that
  // produced it so the rewrite can splice that file rather than reserialise it.
  let position = -1;
  for (const document of catalog.documents) {
    if (summary.rewritten + summary.skipped >= limit) break;
    if (document.canonical === false) continue;
    const conditions = document.appliesWhen ?? [];
    const changes = document.methodChanges ?? [];
    if (conditions.length === 0 || changes.length === 0) continue;

    position += 1;
    if (shard && position % shard.total !== shard.index) continue;

    const names = (await readdir(reflectionDir)).filter((name) => name.endsWith(".md"));
    let target = null;
    for (const name of names) {
      const file = path.join(reflectionDir, name);
      const markdown = await readFile(file, "utf8");
      // The stored condition is canonical-encoded on disk, so the probe has to
      // be encoded the same way or a document containing a `|` or `%` is never
      // found and is silently skipped.
      if (markdown.includes(encodeCanonicalText(conditions[0]))) { target = { name, file, markdown }; break; }
    }
    if (!target) continue;

    summary.considered += 1;
    const language = conditions.some((entry) => CJK.test(entry)) ? "cjk" : "latin";
    process.stderr.write(`\n[${summary.considered}] ${document.familyId}  ${target.name}\n`);

    let result;
    try {
      result = await runReviewerProvider({
        cli: "codex",
        executable,
        context: {
          output_language: language === "cjk" ? "Chinese (Simplified) — the language the user writes in" : "English",
          class_of_mistake: document.classOfMistake ?? null,
          user_complaint: document.userComplaint ?? null,
          root_cause: document.rootCause ?? null,
          facts: document.facts ?? [],
          current_applies_when: conditions,
          current_method_changes: changes
        },
        promptFile: PROMPT_FILE,
        schemaFile: SCHEMA_FILE,
        policyFile: paths.geminiReviewerPolicy,
        geminiSettingsFile: paths.geminiReviewerSettings,
        timeoutMs: 180_000,
        env: process.env
      });
    } catch (error) {
      summary.failed += 1;
      process.stderr.write(`  ERROR: ${error.message}\n`);
      continue;
    }

    let rewritten;
    try {
      rewritten = validateRewrite(result, { language });
    } catch (error) {
      summary.skipped += 1;
      process.stderr.write(`  SKIP: ${error.message}\n`);
      continue;
    }

    process.stderr.write(`  applies_when: ${rewritten.applies_when.length} 条\n`);
    for (const entry of rewritten.applies_when) process.stderr.write(`    - ${entry}\n`);
    process.stderr.write(`  method_changes:\n`);
    for (const entry of rewritten.method_changes) process.stderr.write(`    ${entry}\n`);

    if (apply) {
      const next = spliceRewrite(target.markdown, rewritten);
      await writeFile(target.file, next);
      summary.rewritten += 1;
      process.stderr.write(`  WROTE ${target.name}\n`);
    } else {
      summary.rewritten += 1;
    }

    summary.documents.push({
      family: document.familyId,
      file: target.name,
      appliesWhen: rewritten.applies_when.length,
      methodChanges: rewritten.method_changes.length
    });
  }
}

process.stdout.write(`${JSON.stringify({ apply, ...summary }, null, 2)}\n`);
if (!apply) process.stderr.write("\nDry run. Re-run with --apply to write.\n");
