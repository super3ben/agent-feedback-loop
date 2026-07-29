#!/usr/bin/env node
/**
 * Backfill applies_when for legacy hand-written lessons that predate the field.
 *
 * Usage:
 *   node scripts/backfill-applies-when.mjs <project-dir> <reflection-file>...
 *
 * For each reflection file, reads its content, extracts user_complaint and
 * class_of_mistake, asks the reviewer to derive trigger-form bilingual
 * applies_when conditions, and updates the file in place.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveReviewerExecutable, runReviewerProvider } from "../src/reviewer-provider.mjs";
import { pathsFor } from "../src/index.mjs";

// Mirrors the canonical encoder in reflection-document.mjs: pipes, backslashes,
// percent signs and newlines must be escaped or the metadata line splits wrong.
const CANONICAL_ESCAPES = new Map([["%","%25"],["\\","%5C"],["|","%7C"],["\r","%0D"],["\n","%0A"]]);
function encodeCanonicalText(value) {
  return value.replace(/[%\\|\r\n]/gu, (character) => CANONICAL_ESCAPES.get(character));
}

const [, , projectDir, ...reflectionFiles] = process.argv;
if (!projectDir || reflectionFiles.length === 0) {
  console.error("Usage: backfill-applies-when.mjs <project-dir> <reflection-file>...");
  process.exit(1);
}

const paths = pathsFor();
const DERIVE_PROMPT = "/tmp/afl-backfill/prompt.md";
const DERIVE_SCHEMA = "/tmp/afl-backfill/schema.json";
const executable = await resolveReviewerExecutable({ cli: "codex", env: process.env });
if (!executable) {
  console.error("ERROR: no codex reviewer executable found");
  process.exit(1);
}

// Extract the user complaint and class of mistake from a legacy markdown file.
function parseLegacyReflection(markdown) {
  const complaintMatch = /^## [Uu]ser [Cc]omplaint[^\n]*\n\n([\s\S]+?)(?=\n##|$)/mu.exec(markdown);
  const classMatch = /^## [Cc]lass [Oo]f [Mm]istake[^\n]*\n\n([\s\S]+?)(?=\n##|$)/mu.exec(markdown);
  return {
    userComplaint: complaintMatch ? complaintMatch[1].trim() : null,
    classOfMistake: classMatch ? classMatch[1].trim() : null
  };
}

console.log(`Backfilling ${reflectionFiles.length} reflection(s) in ${projectDir}\n`);

for (const file of reflectionFiles) {
  const fullPath = path.resolve(projectDir, ".agent", "reflections", path.basename(file));
  console.log(`--- ${path.basename(file)} ---`);

  const markdown = await readFile(fullPath, "utf8");
  const { userComplaint, classOfMistake } = parseLegacyReflection(markdown);

  if (!userComplaint || !classOfMistake) {
    console.log("  SKIP: missing user_complaint or class_of_mistake\n");
    continue;
  }

  const context = { class_of_mistake: classOfMistake, user_complaint: userComplaint };

  try {
    const result = await runReviewerProvider({
      cli: "codex",
      executable,
      context,
      promptFile: DERIVE_PROMPT,
      schemaFile: DERIVE_SCHEMA,
      policyFile: paths.geminiReviewerPolicy,
      geminiSettingsFile: paths.geminiReviewerSettings,
      timeoutMs: 180000,
      env: process.env
    });

    if (!result?.applies_when?.length) {
      console.log("  SKIP: no conditions derived\n");
      continue;
    }

    // The parser reads a single pipe-joined metadata line, not a YAML list.
    const encoded = result.applies_when.map(encodeCanonicalText).join(" | ");
    const metaBlock = `- applies_when: ${encoded}`;

    let updated;
    if (/^- final_severity:/mu.test(markdown)) {
      updated = markdown.replace(/^(- final_severity:[^\n]*\n)/mu, `$1${metaBlock}\n`);
    } else {
      // Fallback: insert after the title line.
      updated = markdown.replace(/^(# .+\n)/, `$1\n${metaBlock}\n`);
    }

    await writeFile(fullPath, updated, "utf8");
    console.log(`  WROTE ${result.applies_when.length} conditions:\n`);
    for (const a of result.applies_when) console.log(`    - ${a}`);
    console.log();
  } catch (err) {
    console.log(`  ERROR: ${err.message}\n`);
  }
}

console.log("Backfill complete.");
