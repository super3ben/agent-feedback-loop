import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

// How many recent items each section lists. Enough to see a pattern, short
// enough to read without paging.
const RECENT_LIMIT = 8;
const LESSON_TITLE_MAX = 64;

/**
 * Guard activity. Records carry no timestamp — store_meta is key/value only —
 * so this reports counts and ordering, never a time. Saying "most recent" of an
 * insertion-ordered list is honest; printing a fabricated date would not be.
 */
export function summarizeGuard(monitors = []) {
  const summary = {
    sessions: monitors.length,
    blocked: 0,
    dispatched: 0,
    corrected: 0,
    escalated: 0,
    byCli: {},
    recent: []
  };
  for (const monitor of monitors) {
    const cli = monitor.cli ?? "unknown";
    summary.byCli[cli] = (summary.byCli[cli] ?? 0) + 1;
    if (monitor.blocks > 0) summary.blocked += 1;
    if (monitor.diagnosis) summary.dispatched += 1;
    if (monitor.corrections > 0) summary.corrected += 1;
    // Escalation is the count passing the limit, which is what the guard uses to
    // decide a person should look.
    if (monitor.blocks > 3) summary.escalated += 1;
  }
  summary.recent = monitors
    .filter((monitor) => monitor.blocks > 0)
    .slice(0, RECENT_LIMIT)
    .map((monitor) => ({
      cli: monitor.cli ?? "unknown",
      calls: monitor.count ?? 0,
      blocks: monitor.blocks ?? 0,
      corrections: monitor.corrections ?? 0,
      artifacts: Object.keys(monitor.rework ?? {}).length,
      diagnosis: monitor.diagnosis?.state ?? null,
      // The verdict is the useful part: it names what the run was told to
      // withdraw. Trimmed because it is prose, not a label.
      verdict: monitor.diagnosis?.verdict ?? null
    }));
  return summary;
}

/**
 * Reviewer job activity. These rows do carry timestamps, so this section can
 * answer "when" where the guard section cannot.
 */
export function summarizeReviews(rows = []) {
  const summary = { total: rows.length, byState: {}, recent: [] };
  for (const row of rows) {
    const state = row.state ?? "unknown";
    summary.byState[state] = (summary.byState[state] ?? 0) + 1;
  }
  summary.recent = rows.slice(0, RECENT_LIMIT).map((row) => ({
    state: row.state ?? "unknown",
    createdAt: row.created_at ?? null,
    completedAt: row.completed_at ?? null,
    publishedPath: row.published_path ?? null
  }));
  return summary;
}

function lessonTitle(fileName) {
  // Published names are "<timestamp>-<slug>-<hash>.md"; the slug is the readable
  // part and the hash is noise for a human scanning a list.
  const base = fileName.replace(/\.md$/u, "");
  const withoutStamp = base.replace(/^\d{8}-\d{6}-/u, "");
  const withoutHash = withoutStamp.replace(/-[a-f0-9]{12}$/u, "");
  return withoutHash.replace(/-/gu, " ").slice(0, LESSON_TITLE_MAX);
}

/**
 * Lessons published as project Markdown. Read from disk rather than the store,
 * because the store holds lifecycle state and the documents are the artefact.
 */
export async function listLessons(reflectionsDir, limit = RECENT_LIMIT) {
  let names = [];
  try {
    names = await readdir(reflectionsDir);
  } catch {
    return { total: 0, recent: [] };
  }
  const markdown = names.filter((name) => name.endsWith(".md"));
  const dated = [];
  for (const name of markdown) {
    try {
      const info = await stat(path.join(reflectionsDir, name));
      dated.push({ name, modifiedMs: info.mtimeMs });
    } catch {}
  }
  dated.sort((left, right) => right.modifiedMs - left.modifiedMs);
  return {
    total: markdown.length,
    recent: dated.slice(0, limit).map((entry) => ({
      title: lessonTitle(entry.name),
      fileName: entry.name,
      modifiedAt: new Date(entry.modifiedMs).toISOString()
    }))
  };
}

/**
 * The one line worth showing for a lesson: when it applies. Published documents
 * lead with a title, then `- key: value` metadata lines, so the first non-empty
 * body line is `- reflection_id: ...` — an identifier, useless in a summary.
 * `applies_when` is the field that tells a reader why the lesson would fire.
 * Returns null rather than throwing: a summary must survive an unreadable file.
 */
export async function lessonGist(reflectionsDir, fileName, maxChars = 120) {
  try {
    const text = await readFile(path.join(reflectionsDir, fileName), "utf8");
    const applies = /^-\s*applies_when:\s*(.+)$/mu.exec(text);
    if (applies) {
      // The field packs several phrasings and both languages behind pipes; the
      // first is enough to recognise the situation.
      return applies[1].split("|")[0].trim().slice(0, maxChars);
    }
    const line = text.split("\n").map((entry) => entry.trim())
      .find((entry) => entry.length > 0 && !entry.startsWith("#") && !entry.startsWith("-"));
    return line ? line.slice(0, maxChars) : null;
  } catch {
    return null;
  }
}
