/**
 * Detects a memory index that has fallen behind the memories it indexes.
 *
 * The failure this exists for, measured on a live session: MEMORY.md described
 * the production server as "key auth works since 2026-09-11". The memory body
 * had been corrected on 2026-11-02 to say key auth was dead and a password
 * wrapper was the way in. The index was four days and eight hours newer than
 * its own body but older than the correction, so every session that opened with
 * the index was told the wrong thing, and the agent spent twelve minutes
 * rediscovering that key auth fails.
 *
 * The index is what reaches a session at startup; the bodies do not. So a stale
 * index is not a cosmetic mismatch — it is the wrong instruction, delivered
 * first and with authority.
 *
 * Two design constraints shaped this:
 *
 * 1. It must not cost context. Reading and comparing files happens in the hook
 *    process; what reaches the model is at most one short line naming the
 *    drifted memories. Injecting the bodies would be the very bloat the size
 *    limits exist to prevent, and it would still be stale next turn.
 * 2. It must not depend on the model choosing to check. The comparison is a
 *    mtime read, not a suggestion to look something up.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const INDEX_NAME = "MEMORY.md";
const MAX_REPORTED = 5;

/**
 * @param {{memoryDir: string}} params
 * @returns {Promise<{indexPath: string, stale: Array<{name: string, modifiedAt: string}>,
 *   indexModifiedAt: string|null}|null>}
 *   null when there is nothing to compare (no directory, no index, unreadable).
 */
export async function inspectMemoryIndex({ memoryDir }) {
  if (typeof memoryDir !== "string" || !path.isAbsolute(memoryDir)) return null;
  const indexPath = path.join(memoryDir, INDEX_NAME);
  let indexInfo;
  try {
    indexInfo = await stat(indexPath);
  } catch {
    // No index at all is not drift: a project that never wrote one has nothing
    // to be out of date against, and reporting it every turn would be noise.
    return null;
  }
  if (!indexInfo.isFile()) return null;

  let entries;
  try {
    entries = await readdir(memoryDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const stale = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    if (entry.name === INDEX_NAME) continue;
    let info;
    try {
      info = await stat(path.join(memoryDir, entry.name));
    } catch {
      continue;
    }
    // Strictly newer: an index written in the same second as its body is the
    // normal result of one edit touching both, and flagging it would make every
    // correctly-maintained memory look broken.
    if (info.mtimeMs > indexInfo.mtimeMs) {
      stale.push({
        name: entry.name.replace(/\.md$/u, ""),
        modifiedAt: new Date(info.mtimeMs).toISOString()
      });
    }
  }

  stale.sort((left, right) => (left.modifiedAt < right.modifiedAt ? 1 : -1));
  return {
    indexPath,
    stale: stale.slice(0, MAX_REPORTED),
    staleCount: stale.length,
    indexModifiedAt: new Date(indexInfo.mtimeMs).toISOString()
  };
}

/**
 * The one-line notice a drifted index earns.
 *
 * Deliberately short: it names the drifted memories and says the index is not
 * authoritative, then stops. The corrective content lives in the body, and the
 * body is one Read away — the cost of sending it every turn is the cost this
 * module exists to avoid.
 *
 * @param {{stale: Array<{name: string}>, staleCount?: number}|null} report
 */
export function renderMemoryDriftNotice(report) {
  if (!report || !Array.isArray(report.stale) || report.stale.length === 0) return null;
  const names = report.stale.map((entry) => entry.name);
  const more = Number(report.staleCount) > names.length
    ? ` 等 ${report.staleCount} 条`
    : "";
  return [
    "【记忆索引已过期 — 索引内容不可作为结论】",
    `以下记忆正文比 MEMORY.md 更新：${names.join(", ")}${more}。`,
    "动手前先读对应正文，不要按索引里的旧结论执行。"
  ].join("\n");
}

/**
 * Where a project's memory directory lives for a session.
 *
 * Claude Code keeps one directory per project under a slugified cwd. The hook
 * payload carries a transcript path whose directory IS that slug dir, which is
 * the reliable handle; deriving the slug from cwd is the fallback, and a
 * different home layout is a miss rather than a wrong answer.
 *
 * @param {{transcriptPath?: string|null, home?: string, cwd?: string|null,
 *   slugRoot?: string|null}} params
 */
export function resolveMemoryDir({ transcriptPath = null, home = null, cwd = null, slugRoot = null } = {}) {
  if (typeof transcriptPath === "string" && path.isAbsolute(transcriptPath)) {
    return path.join(path.dirname(transcriptPath), "memory");
  }
  const root = slugRoot
    ?? (typeof home === "string" && home
      ? path.join(home, ".claude", "projects")
      : null);
  if (!root || typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  const slug = cwd.replace(/[/.]/gu, "-");
  return path.join(root, slug, "memory");
}
