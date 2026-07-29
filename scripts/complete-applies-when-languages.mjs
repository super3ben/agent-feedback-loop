#!/usr/bin/env node
/**
 * Add the missing language to canonical lessons whose applies_when conditions
 * exist in only one language.
 *
 * A condition recorded only in English is unreachable from a Chinese prompt and
 * vice versa: matching is word overlap alone, so the lesson is stored but never
 * delivered. This rewrites the metadata line in place, preserving the existing
 * conditions and adding a counterpart for each.
 *
 * Usage: node scripts/complete-applies-when-languages.mjs <project-dir> [--apply]
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readReflectionCatalog } from "../src/reflection-document.mjs";
import { resolveReviewerExecutable, runReviewerProvider } from "../src/reviewer-provider.mjs";
import { pathsFor } from "../src/index.mjs";

const [, , projectDir, ...flags] = process.argv;
const apply = flags.includes("--apply");
if (!projectDir) {
  console.error("Usage: complete-applies-when-languages.mjs <project-dir> [--apply]");
  process.exit(1);
}

const PROMPT = "/tmp/afl-backfill/translate.md";
const SCHEMA = "/tmp/afl-backfill/translate-schema.json";

// Mirrors the canonical encoder in reflection-document.mjs: these characters
// must be escaped or the pipe-joined metadata line splits wrong.
const CANONICAL_ESCAPES = new Map([["%", "%25"], ["\\", "%5C"], ["|", "%7C"], ["\r", "%0D"], ["\n", "%0A"]]);
const encodeCanonicalText = (value) =>
  value.replace(/[%\\|\r\n]/gu, (character) => CANONICAL_ESCAPES.get(character));

const hasCjk = (value) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
const hasLatin = (value) => /[\p{Script=Latin}]/u.test(value);

const paths = pathsFor();
const executable = await resolveReviewerExecutable({ cli: "codex", env: process.env });
if (!executable) {
  console.error("ERROR: no codex reviewer executable found");
  process.exit(1);
}

const catalog = await readReflectionCatalog({
  projectDir,
  publishedBefore: new Date(Date.now() + 60_000).toISOString()
});

const reflectionDir = path.join(projectDir, ".agent", "reflections");
const files = (await readdir(reflectionDir)).filter((name) => name.endsWith(".md"));

// Map each canonical single-language document to the file that produced it.
const targets = [];
for (const document of catalog.documents) {
  if (document.canonical === false) continue;
  const conditions = document.appliesWhen ?? [];
  if (conditions.length === 0) continue;
  const joined = conditions.join(" ");
  if (hasCjk(joined) && hasLatin(joined)) continue;
  for (const name of files) {
    const markdown = await readFile(path.join(reflectionDir, name), "utf8");
    if (markdown.includes(conditions[0])) {
      targets.push({ name, conditions, document });
      break;
    }
  }
}

console.log(`${targets.length} canonical lesson(s) reachable from only one language\n`);
if (!apply) console.log("(dry run: pass --apply to write)\n");

for (const target of targets) {
  console.log(`--- ${target.name} ---`);
  console.log(`  currently: ${target.conditions.length} condition(s), ${hasCjk(target.conditions.join(" ")) ? "Chinese" : "English"} only`);

  let result;
  try {
    result = await runReviewerProvider({
      cli: "codex",
      executable,
      context: {
        class_of_mistake: target.document.classOfMistake,
        existing_conditions: target.conditions
      },
      promptFile: PROMPT,
      schemaFile: SCHEMA,
      policyFile: paths.geminiReviewerPolicy,
      geminiSettingsFile: paths.geminiReviewerSettings,
      timeoutMs: 180_000,
      env: process.env
    });
  } catch (error) {
    console.log(`  ERROR: ${error.message}\n`);
    continue;
  }

  const completed = result?.applies_when ?? [];
  const joined = completed.join(" ");
  if (completed.length < target.conditions.length || !hasCjk(joined) || !hasLatin(joined)) {
    console.log(`  SKIP: result is not bilingual (${completed.length} conditions)\n`);
    continue;
  }

  console.log(`  -> ${completed.length} condition(s), both languages`);
  for (const condition of completed) console.log(`     ${condition}`);

  if (apply) {
    const file = path.join(reflectionDir, target.name);
    const markdown = await readFile(file, "utf8");
    const encoded = completed.map(encodeCanonicalText).join(" | ");
    const updated = markdown.replace(/^- applies_when: .*$/mu, `- applies_when: ${encoded}`);
    if (updated === markdown) {
      console.log("  WARN: metadata line not found; left unchanged");
    } else {
      await writeFile(file, updated, "utf8");
      console.log("  WROTE");
    }
  }
  console.log();
}
