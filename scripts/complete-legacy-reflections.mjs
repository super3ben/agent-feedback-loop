#!/usr/bin/env node
/**
 * Give a hand-written lesson the two sections the parser requires.
 *
 * Older reflections predate the canonical shape: they carry `facts`,
 * `user complaint` and `root cause`, but not `class of mistake` or
 * `method change`. `legacyDocument` treats those two as required and returns
 * `legacy_incomplete`, which means the document never enters the catalog and is
 * therefore NEVER injected. Measured on one project: 48 of 116 reflections were
 * in this state, including the one that says "do not use BatchMode=yes, use the
 * password" — the exact rule the user kept having to restate.
 *
 * This appends the missing sections rather than rewriting the document. Every
 * existing byte stays where it was, so the lesson's own words survive; the new
 * sections are inferred from what is already there.
 *
 * Usage:
 *   node scripts/complete-legacy-reflections.mjs <project-dir> [--apply] [--limit N]
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { readReflectionCatalog } from "../src/reflection-document.mjs";
import { resolveReviewerExecutable, runReviewerProvider } from "../src/reviewer-provider.mjs";
import { pathsFor } from "../src/index.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PROMPT_FILE = path.join(ROOT, "templates", "prompts", "complete-legacy-lesson.md");
const SCHEMA_FILE = path.join(ROOT, "templates", "schemas", "complete-legacy-lesson.schema.json");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const limitIndex = args.indexOf("--limit");
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : Number.POSITIVE_INFINITY;
const limitValueIndex = limitIndex >= 0 ? limitIndex + 1 : -1;
const projectDirs = args.filter((arg, index) => !arg.startsWith("--") && index !== limitValueIndex);

if (projectDirs.length === 0) {
  console.error("Usage: complete-legacy-reflections.mjs <project-dir> [--apply] [--limit N]");
  process.exit(1);
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const HEADING = {
  mistakeClass: ["class of mistake", "类别抽象"],
  methodChange: ["method change", "method changes", "方法改进"]
};

function hasSection(text, aliases) {
  return aliases.some((alias) => new RegExp(`^\\s*(?:-\\s*|##\\s*)${alias}\\s*:?\\s*$`, "imu").test(text));
}

function readSection(text, aliases) {
  for (const alias of aliases) {
    const match = new RegExp(`^\\s*(?:-\\s*|##\\s*)${alias}\\s*:?\\s*\\n([\\s\\S]*?)(?=\\n\\s*(?:-\\s*|##\\s*)[a-z\\u4e00-\\u9fa5][^\\n]*:\\s*\\n|\\n\\s*##\\s|$)`, "imu").exec(text);
    if (match) return match[1].trim();
  }
  return "";
}

const paths = pathsFor();
const executable = await resolveReviewerExecutable({ cli: "codex", env: process.env });
if (!executable) {
  console.error("ERROR: no codex reviewer executable found");
  process.exit(1);
}

const summary = { considered: 0, completed: 0, skipped: 0, failed: 0, documents: [] };

for (const projectDir of projectDirs) {
  const catalog = await readReflectionCatalog({
    projectDir,
    publishedBefore: new Date(Date.now() + 60_000).toISOString()
  });

  for (const omission of catalog.omissions) {
    if (omission.omission !== "legacy_incomplete") continue;
    if (summary.completed + summary.skipped >= limit) break;

    const file = omission.path;
    const markdown = await readFile(file, "utf8");
    const missingClass = !hasSection(markdown, HEADING.mistakeClass);
    const missingMethod = !hasSection(markdown, HEADING.methodChange);
    if (!missingClass && !missingMethod) continue;

    const complaint = readSection(markdown, ["user complaint in plain language", "user complaint"]);
    const rootCause = readSection(markdown, ["root cause", "根因"]);
    const facts = readSection(markdown, ["facts proven by context"]);
    // Without the complaint and the cause there is nothing to infer from, and a
    // guess would put invented text into a permanent lesson.
    if (!complaint || !rootCause) continue;

    summary.considered += 1;
    process.stderr.write(`\n[${summary.considered}] ${path.basename(file)}\n`);

    let result;
    try {
      result = await runReviewerProvider({
        cli: "codex",
        executable,
        context: {
          output_language: CJK.test(complaint) ? "Chinese (Simplified) — the language the lesson is written in" : "English",
          title: (markdown.match(/^#\s+(.+)$/mu)?.[1] ?? "").trim(),
          facts,
          user_complaint: complaint,
          root_cause: rootCause,
          has_class_of_mistake: !missingClass,
          has_method_change: !missingMethod
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

    const mistakeClass = String(result?.class_of_mistake ?? "").trim();
    const methods = (result?.method_changes ?? []).map((entry) => String(entry ?? "").trim()).filter(Boolean);
    if ((missingClass && !mistakeClass) || (missingMethod && methods.length === 0)) {
      summary.skipped += 1;
      process.stderr.write("  SKIP: the result did not fill the missing sections\n");
      continue;
    }

    if (missingClass) process.stderr.write(`  class of mistake: ${mistakeClass}\n`);
    if (missingMethod) for (const method of methods) process.stderr.write(`  method: ${method}\n`);

    if (apply) {
      // Appended, never spliced: the existing sections keep their exact bytes,
      // and the parser's list-shaped fallback reads `- name:` blocks.
      const additions = [];
      if (missingClass) additions.push("", "class of mistake:", `- ${mistakeClass}`);
      if (missingMethod) additions.push("", "method change:", ...methods.map((method) => `- ${method}`));
      const next = `${markdown.trimEnd()}\n${additions.join("\n")}\n`;
      await writeFile(file, next);
      summary.completed += 1;
      process.stderr.write("  WROTE\n");
    } else {
      summary.completed += 1;
    }

    summary.documents.push({ file: path.basename(file), mistakeClass: missingClass, methodChanges: missingMethod ? methods.length : 0 });
  }
}

process.stdout.write(`${JSON.stringify({ apply, ...summary }, null, 2)}\n`);
if (!apply) process.stderr.write("\nDry run. Re-run with --apply to write.\n");
