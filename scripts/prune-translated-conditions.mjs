#!/usr/bin/env node
/**
 * Remove translated `applies_when` conditions from published reflections.
 *
 * A lesson is written in the language the user writes in. A second rendering in
 * another language can never be matched by anything that user types — matching
 * is word overlap — so it is pure cost: it spends the per-document condition
 * budget (capped at six) on strings that will never be reached, and it dilutes
 * the score of the ones that can, because selection divides by the number of
 * terms it had to consider.
 *
 * Measured on four live projects before this ran: 322 conditions across 180
 * documents, 87% carried an English rendering and 206 of them duplicated a
 * Chinese one. The SSH credential lesson scored 5 against the complaint
 * 「这个服务器怎么又连不上」 while an unrelated family scored 17 and took the
 * injection slot; with the English dropped and the conditions rewritten it
 * scored 40.
 *
 * Usage:
 *   node scripts/prune-translated-conditions.mjs <project-dir> [<project-dir>...]           # dry run
 *   node scripts/prune-translated-conditions.mjs <project-dir> [...] --apply               # rewrite
 *
 * Only the metadata line is touched. The document body, its hash, and its
 * publication record are left exactly as published — this is not a re-publication
 * and must not look like one.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const projectDirs = args.filter((arg) => !arg.startsWith("--"));

if (projectDirs.length === 0) {
  console.error("Usage: prune-translated-conditions.mjs <project-dir> [...] [--apply]");
  process.exit(1);
}

const APPLIES_LINE = /^- applies_when: (.*)$/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// A condition counts as "a translation" when it has no CJK at all but enough
// latin prose to be a sentence. Identifiers such as `BatchMode=yes` or
// `192.168.100.1` are not prose and must survive.
const LATIN_PROSE = /[A-Za-z]{3,}(?:\s+[A-Za-z']{2,}){2,}/u;

function decode(value) {
  return value;
}

function isTranslation(condition) {
  if (CJK.test(condition)) return false;
  return LATIN_PROSE.test(condition);
}

let totalDocuments = 0;
let changedDocuments = 0;
let removedConditions = 0;

for (const projectDir of projectDirs) {
  const dir = path.join(projectDir, ".agent", "reflections");
  let names;
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".md"));
  } catch {
    console.log(`\n${projectDir}\n  (no reflections directory)`);
    continue;
  }

  const changed = [];
  for (const name of names.sort()) {
    const file = path.join(dir, name);
    const text = await readFile(file, "utf8");
    const lines = text.split("\n");
    const index = lines.findIndex((line) => APPLIES_LINE.test(line));
    if (index < 0) continue;
    totalDocuments += 1;

    const match = APPLIES_LINE.exec(lines[index]);
    const conditions = match[1].split(/\s*\|\s*/u).map(decode).filter(Boolean);
    const kept = conditions.filter((condition) => !isTranslation(condition));
    if (kept.length === conditions.length) continue;
    // Never leave a document with no reachable condition: that trades a
    // matched-but-wasteful document for an unreachable one, which is worse.
    if (kept.length === 0) continue;

    changedDocuments += 1;
    removedConditions += conditions.length - kept.length;
    changed.push({ name, before: conditions.length, after: kept.length });

    if (apply) {
      lines[index] = `- applies_when: ${kept.join(" | ")}`;
      await writeFile(file, lines.join("\n"));
    }
  }

  console.log(`\n${projectDir}`);
  console.log(`  ${names.length} documents, ${changed.length} with translated conditions`);
  for (const entry of changed.slice(0, 8)) {
    console.log(`    ${entry.name}: ${entry.before} → ${entry.after} conditions`);
  }
  if (changed.length > 8) console.log(`    ... and ${changed.length - 8} more`);
}

console.log(`\n${apply ? "APPLIED" : "DRY RUN"}: ${changedDocuments}/${totalDocuments} documents, ${removedConditions} translated conditions removed`);
if (!apply) console.log("Re-run with --apply to rewrite.");
