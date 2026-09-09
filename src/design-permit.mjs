/**
 * @module design-permit
 *
 * Resolves whether a tool call is covered by a design-phase permit.  The permit
 * is read from opaque workflow state files on disk (Comet, OpenSpec, or a
 * user-defined convention file); the agent never declares, interacts with, or
 * even learns about this module.
 *
 * A design permit suppresses the execution guard's *blocking* decision while
 * counters keep ticking.  The numbers are still tracked for observability —
 * only the enforcement is paused.
 *
 * The LRU cache is SQLite-backed (via the shared control-store) so it persists
 * across the separate Node processes that each hook invocation spawns.  The
 * agent cannot influence cache reads or writes — the key is the target hash,
 * and the value is resolved purely from filesystem state.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const DESIGN_PHASES = Object.freeze(["shape", "open", "design", "draft"]);
const PLAN_STATES = Object.freeze(["explore", "design", "draft"]);
const CONVENTION_FIELD = "phase";
const MAX_DEPTH = 20;

// ---------------------------------------------------------------------------
// LRU cache backed by control-store's store_meta table.
//
// Each hook invocation is a separate Node process, so an in-memory Map dies
// with it.  Storing permits in SQLite lets the next process hit the cache
// when two tool calls land within TTL_MS of each other.
//
// Key format:  `design_permit:<targetHash>`
// Value:       JSON { permit, expiresAt }
// TTL:         250ms
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 250;
const CACHE_MAX = 64;
const CACHE_PREFIX = "design_permit:";

function cacheKey(targetHash) {
  return `${CACHE_PREFIX}${targetHash}`;
}

function readCache(meta, targetHash) {
  try {
    const raw = meta.get(cacheKey(targetHash));
    if (!raw) return undefined;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(raw.value);
    if (Date.now() > parsed.expiresAt) {
      meta.delete(cacheKey(targetHash));
      return undefined;
    }
    return parsed.permit;
  } catch {
    return undefined;
  }
}

function writeCache(meta, targetHash, permit) {
  try {
    // Evict oldest entries when at capacity.
    const count = meta.countPrefix(CACHE_PREFIX);
    if (count >= CACHE_MAX) {
      const oldest = meta.oldestKey(CACHE_PREFIX);
      if (oldest) meta.delete(oldest);
    }
    meta.set(cacheKey(targetHash), JSON.stringify({
      permit,
      expiresAt: Date.now() + CACHE_TTL_MS
    }));
  } catch {
    // Cache write failure is never fatal.
  }
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

async function safeReadJson(filePath) {
  try {
    const data = await readFile(filePath, "utf8");
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

async function findAncestor(startDir, marker) {
  const { constants } = await import("node:fs");
  const { access } = await import("node:fs/promises");
  let current = startDir;
  for (let i = 0; i < MAX_DEPTH; i += 1) {
    try {
      await access(path.join(current, marker), constants.F_OK);
      return current;
    } catch {
      // marker not found at this level
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Workflow-specific permit resolvers
// ---------------------------------------------------------------------------

// Comet keeps the phase one level away from the pointer. `current-change.json`
// only names the active change — `{"workflow":"classic","changeName":"x"}` —
// and the phase lives in `changes/<changeName>.json`. Reading the pointer for
// a `phase` field finds nothing, so every Comet project silently lost its
// permit, including during the design phases this exists to exempt.
//
// Phase names are compared case-insensitively: Classic writes them
// capitalised ("Build", "Design"), Native writes them lowercase.
async function cometPermit(filePath) {
  const workspace = await findAncestor(path.dirname(filePath), ".comet");
  if (!workspace) return null;
  const pointer = await safeReadJson(path.join(workspace, ".comet", "current-change.json"));
  if (!pointer) return null;

  // A pointer that carries its own phase is honoured directly; otherwise the
  // named change file is the authority.
  let phase = typeof pointer.phase === "string" ? pointer.phase : null;
  if (phase === null) {
    const changeName = pointer.changeName ?? pointer.change;
    if (typeof changeName !== "string" || !changeName.trim()) return null;
    // The name indexes a file inside .comet/changes, so a separator or a
    // parent-directory hop would read outside the workspace.
    if (changeName.includes("/") || changeName.includes("\\") || changeName.includes("..")) return null;
    const change = await safeReadJson(
      path.join(workspace, ".comet", "changes", `${changeName}.json`)
    );
    if (!change || typeof change.phase !== "string") return null;
    phase = change.phase;
  }

  if (!DESIGN_PHASES.includes(phase.toLowerCase())) return null;
  return { phase, source: "comet" };
}

async function openspecPermit(filePath) {
  const workspace = await findAncestor(path.dirname(filePath), ".openspec");
  if (!workspace) return null;
  const session = await safeReadJson(path.join(workspace, ".openspec", "session.json"));
  if (!session || typeof session.state !== "string") return null;
  if (!PLAN_STATES.includes(session.state.toLowerCase())) return null;
  return { phase: session.state, source: "openspec" };
}

async function conventionPermit(filePath) {
  const workspace = await findAncestor(path.dirname(filePath), ".phase.json");
  if (!workspace) return null;
  const file = await safeReadJson(path.join(workspace, ".phase.json"));
  if (!file || typeof file[CONVENTION_FIELD] !== "string") return null;
  const phase = file[CONVENTION_FIELD];
  if (!phase) return null;
  return { phase, source: "convention" };
}

// ---------------------------------------------------------------------------
// Resolve from filesystem (cache miss path)
// ---------------------------------------------------------------------------

async function resolveFromFs(filePath) {
  const absolute = path.resolve(filePath);
  const comet = await cometPermit(absolute);
  if (comet) return comet;
  const openspec = await openspecPermit(absolute);
  if (openspec) return openspec;
  return conventionPermit(absolute);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve whether a tool call's target is covered by a design-phase permit.
 *
 * Returns { phase, source } when a permit applies, null otherwise.
 * Checks Comet → OpenSpec → convention file in order; first match wins.
 *
 * Results are cached in the control-store's store_meta table for 250ms,
 * keyed by the target hash the execution monitor already computed.  This
 * avoids redundant filesystem reads across rapid sequential tool calls
 * while letting phase changes take effect quickly.
 *
 * @param {string} filePath - path of the file being edited
 * @param {string} [targetHash] - pre-computed hash from the execution monitor;
 *   when omitted, `filePath` itself is used as the cache key
 * @param {object} [storeMeta] - the control-store's meta accessor providing
 *   `.get(key)`, `.set(key, value)`, `.delete(key)`, `.countPrefix(prefix)`,
 *   `.oldestKey(prefix)`.  When omitted, no caching is performed.
 */
export async function resolveDesignPermit(filePath, targetHash, storeMeta) {
  if (typeof filePath !== "string" || !filePath.trim()) return null;
  const cacheKey_ = targetHash ?? filePath;

  // Check cache if a meta store is available.
  if (storeMeta && typeof storeMeta.get === "function") {
    const cached = readCache(storeMeta, cacheKey_);
    if (cached !== undefined) return cached;
  }

  const permit = await resolveFromFs(filePath);

  // Write to cache if a meta store is available.
  if (storeMeta && typeof storeMeta.set === "function") {
    writeCache(storeMeta, cacheKey_, permit);
  }

  return permit;
}
