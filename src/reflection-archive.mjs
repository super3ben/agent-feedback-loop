/**
 * Retires reflection documents that will never reach a session.
 *
 * `.agent/reflections/` only ever grows: on a live project it held 101 files /
 * 680KB, of which 37% had never been injected even once. Every one of them is
 * re-parsed on every prompt by readReflectionCatalog, and the ones that cannot
 * be selected only dilute the catalog.
 *
 * Archiving is a move, not a delete. The file keeps its content and its name,
 * it simply leaves the directory the catalog scans — so the decision is
 * reversible by moving it back, and nothing that was ever emitted is touched.
 */
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_ARCHIVE_AFTER_DAYS = 30;

/**
 * Selects the files to retire. A file qualifies only when it is BOTH old and
 * has never been delivered: an old document that is still being injected is
 * doing its job, and a never-injected document that is new may simply not have
 * matched yet.
 *
 * @param {object} params
 * @param {string} params.reflectionsDir
 * @param {Set<string>} params.emittedPaths - absolute paths that appear in the
 *   emission log. Anything here has reached a session and is left alone.
 * @param {number} [params.afterDays]
 * @param {number} [params.now]
 */
export async function selectArchivableReflections({
  reflectionsDir,
  emittedPaths = new Set(),
  afterDays = DEFAULT_ARCHIVE_AFTER_DAYS,
  now = Date.now()
}) {
  const cutoffMs = now - afterDays * 24 * 60 * 60 * 1_000;
  let entries;
  try {
    entries = await readdir(reflectionsDir, { withFileTypes: true });
  } catch {
    return { candidates: [], scanned: 0 };
  }

  const candidates = [];
  let scanned = 0;
  for (const entry of entries) {
    // Subdirectories (including the archive itself) are not catalog content.
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    scanned += 1;
    const filePath = path.join(reflectionsDir, entry.name);
    if (emittedPaths.has(filePath)) continue;
    let info;
    try {
      info = await stat(filePath);
    } catch {
      continue;
    }
    if (info.mtimeMs > cutoffMs) continue;
    candidates.push({
      name: entry.name,
      path: filePath,
      bytes: info.size,
      modifiedAt: new Date(info.mtimeMs).toISOString()
    });
  }
  candidates.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
  return { candidates, scanned };
}

/** Moves the selected files under `archive/`, creating it on first use. */
export async function archiveReflections({
  reflectionsDir,
  candidates,
  dryRun = true
}) {
  const archiveDir = path.join(reflectionsDir, "archive");
  const moved = [];
  if (!dryRun && candidates.length) {
    await mkdir(archiveDir, { recursive: true, mode: 0o700 });
  }
  for (const candidate of candidates) {
    const target = path.join(archiveDir, candidate.name);
    if (dryRun) {
      moved.push({ ...candidate, target, moved: false });
      continue;
    }
    try {
      await rename(candidate.path, target);
      moved.push({ ...candidate, target, moved: true });
    } catch {
      // A file that vanished or is locked stays put; archiving is best-effort
      // and must never fail the command over one entry.
    }
  }
  return { archiveDir, moved, movedCount: moved.filter((entry) => entry.moved).length };
}
