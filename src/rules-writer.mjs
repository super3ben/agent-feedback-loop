/**
 * Reads published lessons' metadata and writes a managed block into the
 * project's .agent/rules/feedback-loop.md.  The block is delimited by
 * afl:rules:start/end so it never touches user-written content.
 *
 * Tier gate: Major+3 / Critical+2 / Blocker+1 → write rules.
 */
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";

const AFL_RULES_START = "<!-- afl:rules:start -->";
const AFL_RULES_END = "<!-- afl:rules:end -->";
const SEVERITY_ORDER = { Blocker: 0, Critical: 1, Major: 2 };
const SEVERITY_THRESHOLDS = { Major: 3, Critical: 2, Blocker: 1 };

export function qualifyForRules(severity, occurrences) {
  if (!severity || !SEVERITY_ORDER.hasOwnProperty(severity)) return false;
  return occurrences >= (SEVERITY_THRESHOLDS[severity] ?? Infinity);
}

export function buildRulesBlock(families) {
  if (!families.length) return null;
  const lines = [AFL_RULES_START, ""];
  for (const f of families) {
    lines.push(`### ${f.familyKey} (${f.occurrences}×, ${f.severity})`);
    lines.push("");
    if (f.incidentSummary) lines.push(f.incidentSummary);
    lines.push("");
    lines.push("**Do not repeat this mistake:**");
    for (const change of f.methodChanges) lines.push(`- ${change}`);
    lines.push("");
  }
  lines.push(AFL_RULES_END);
  return lines.join("\n");
}

export async function getRulesPath(projectDir) {
  return path.join(projectDir, ".agent", "rules", "feedback-loop.md");
}

export async function writeAflRulesBlock(projectDir, block) {
  const filePath = await getRulesPath(projectDir);
  let existing = "";
  try { existing = await readFile(filePath, "utf8"); } catch {}
  const hadBlock = existing.includes(AFL_RULES_START);
  let content = existing;
  if (hadBlock) {
    const before = existing.slice(0, existing.indexOf(AFL_RULES_START));
    const after = existing.slice(existing.indexOf(AFL_RULES_END) + AFL_RULES_END.length);
    content = before + block + after;
  } else {
    content = existing.trimEnd() + "\n\n" + block + "\n";
  }
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, content, "utf8");
  return { path: filePath, replaced: hadBlock };
}
