#!/usr/bin/env node
/**
 * Restore `applies_when` on documents that a previous rewrite contaminated.
 *
 * The rewrite prompt carried worked examples of how a complaint is rephrased —
 * 「连不上」「登不进去」「又问我要密码」「密码不是给过吗」. Those examples came
 * from one SSH incident, and the model copied the phrase list into the
 * conditions of eleven documents that have nothing to do with SSH: an Excel
 * parse failure, a release-worktree rule, a review-loop lesson. Their conditions
 * now claim that a user reporting a connection problem should reach a lesson
 * about spreadsheet parsing.
 *
 * The damage is not cosmetic. Selection spends four slots per turn, and these
 * documents now compete for the SSH complaint's slot while carrying an unrelated
 * instruction. The user asks about credentials and receives a lesson about
 * spreadsheet parsing.
 *
 * What this restores is ONLY the `applies_when` line, from the pre-rewrite
 * backup. Every other field keeps whatever the rewrite produced, because those
 * changes were improvements — it is the copied phrase list that was wrong.
 *
 * Usage:
 *   node scripts/restore-contaminated-conditions.mjs <project-dir> <backup-dir> [--apply]
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const positional = args.filter((arg) => !arg.startsWith("--"));
const [projectDir, backupDir] = positional;

if (!projectDir || !backupDir) {
  console.error("Usage: restore-contaminated-conditions.mjs <project-dir> <backup-dir> [--apply]");
  process.exit(1);
}

// The phrase list that leaked out of the rewrite prompt. A condition carrying
// these words on a document whose subject is not credentials is the signature.
const LEAKED_PHRASES = ["又问我要密码", "密码不是给过吗", "登不进去"];
const CREDENTIAL_SUBJECT = /ssh|SSH|BatchMode|凭据|credential|密码|密钥/u;

const APPLIES_LINE = /^- applies_when: (.*)$/u;

function conditionText(markdown) {
  const line = markdown.split("\n").find((entry) => APPLIES_LINE.test(entry));
  return line ? line : null;
}

const reflectionsDir = path.join(projectDir, ".agent", "reflections");
let names;
try {
  names = (await readdir(reflectionsDir)).filter((name) => name.endsWith(".md"));
} catch {
  console.error(`no reflections directory at ${reflectionsDir}`);
  process.exit(1);
}

const restored = [];
const skipped = [];

for (const name of names.sort()) {
  const currentPath = path.join(reflectionsDir, name);
  const current = await readFile(currentPath, "utf8");
  const currentLine = conditionText(current);
  if (!currentLine) continue;

  const leaked = LEAKED_PHRASES.filter((phrase) => currentLine.includes(phrase));
  if (leaked.length === 0) continue;

  // A document whose subject really is credentials is allowed to mention them.
  // Judged on the fields that describe the incident, not on the condition that
  // is itself suspect — otherwise every contaminated document justifies itself.
  const subject = [
    current.match(/^# (.+)$/mu)?.[1] ?? "",
    (current.match(/^class of mistake:[\s\S]{0,400}/mu)?.[0] ?? ""),
    (current.match(/^method change:[\s\S]{0,800}/mu)?.[0] ?? "")
  ].join("\n");
  if (CREDENTIAL_SUBJECT.test(subject)) continue;

  let backup;
  try {
    backup = await readFile(path.join(backupDir, name), "utf8");
  } catch {
    skipped.push({ name, reason: "no backup for this document" });
    continue;
  }
  const backupLine = conditionText(backup);
  if (!backupLine) {
    skipped.push({ name, reason: "backup has no applies_when to restore" });
    continue;
  }
  if (backupLine.includes(LEAKED_PHRASES[0])) {
    skipped.push({ name, reason: "backup already carried the leaked phrase" });
    continue;
  }

  if (apply) {
    // Replace that one line in place. Reconstructing the file from parsed values
    // would normalise the body as well, and the body is not what was damaged.
    const next = current.split("\n").map((line) =>
      APPLIES_LINE.test(line) ? backupLine : line).join("\n");
    await writeFile(currentPath, next);
  }
  restored.push({ name, leaked });
}

console.log(`\n${apply ? "APPLIED" : "DRY RUN"} — ${restored.length} 篇恢复`);
for (const entry of restored) console.log(`  ✓ ${entry.name.slice(0, 50)}  [${entry.leaked.join(",")}]`);
if (skipped.length) {
  console.log(`\n跳过 ${skipped.length} 篇:`);
  for (const entry of skipped) console.log(`  · ${entry.name.slice(0, 50)} — ${entry.reason}`);
}
if (!apply) console.log("\n加 --apply 才会写入。");
