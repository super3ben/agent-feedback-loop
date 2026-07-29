import { createHash } from "node:crypto";

// How many times one artifact may be rewritten while the user stays silent.
//
// The signal is rework, not activity: a task that runs 44 tools and finishes is
// healthy, while one that rewrites the same file eight times without new input
// is circling. Advanced models reach this state by review-then-improve loops
// that never fail — each pass looks reasonable, and nothing ever errors.
//
// The user speaking resets it, because a new instruction is new evidence.
export const EXECUTION_REWORK_LIMIT = 6;

// Tool calls that cannot change anything. Everything else — including every
// tool this list has never heard of — counts as mutating.
//
// This default-deny shape is deliberate. A probe that allowed unknown tools
// enumerated only Write/Bash/Edit and let `apply_patch` through, which wrote 20
// files while the guard reported itself active. Unknown tools must fail closed.
const READ_ONLY_TOOLS = new Set([
  "update_plan",
  "view_image"
]);

const MAX_TARGET_LABEL = 200;

function boundedIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0");
}

export function deriveExecutionMonitorId({ cli, sessionId } = {}) {
  if (!boundedIdentity(cli) || !boundedIdentity(sessionId)) {
    throw new TypeError("cli and sessionId must be bounded identities");
  }
  return createHash("sha256").update(JSON.stringify([cli, sessionId]), "utf8").digest("hex");
}

/**
 * Whether a tool call can change state. Unknown tool names are treated as
 * mutating so a tool nobody enumerated cannot slip past the guard.
 */
export function isMutatingTool(toolName) {
  if (typeof toolName !== "string" || toolName.length === 0) return true;
  return !READ_ONLY_TOOLS.has(toolName);
}

/**
 * Bounded tool-name label for the seen-tool inventory. Keeping the inventory is
 * how the real tool vocabulary gets answered by shipping rather than by
 * guessing it up front.
 */
export function executionToolLabel(toolName) {
  if (typeof toolName !== "string" || toolName.length === 0) return "unknown";
  const trimmed = toolName.slice(0, 64);
  return /^[A-Za-z0-9_.:-]+$/u.test(trimmed) ? trimmed : "unsupported";
}

function hashedTarget(value) {
  // The path is hashed: rework only needs to know that the same artifact came
  // back, and a file path can carry information that should not be stored.
  return createHash("sha256").update(String(value).slice(0, MAX_TARGET_LABEL), "utf8")
    .digest("hex").slice(0, 16);
}

/**
 * The artifact a tool call is about to change, as an opaque key. Returns null
 * when the call changes nothing identifiable, which is not counted as rework.
 *
 * Codex passes edits as an apply_patch script, so the changed paths are read
 * out of its `Update File:` / `Add File:` directives rather than a path field.
 */
export function deriveReworkTarget({ toolName, toolInput } = {}) {
  if (!isMutatingTool(toolName)) return null;
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return null;

  for (const field of ["file_path", "filePath", "path", "notebook_path"]) {
    const value = toolInput[field];
    if (typeof value === "string" && value.trim()) return hashedTarget(value.trim());
  }

  const command = typeof toolInput.command === "string" ? toolInput.command : "";
  if (!command) return null;
  // Only an edit to existing content is rework; creating a file is first work.
  const updated = /^\*\*\* Update File: (.+)$/mu.exec(command);
  if (updated) return hashedTarget(updated[1].trim());
  return null;
}
