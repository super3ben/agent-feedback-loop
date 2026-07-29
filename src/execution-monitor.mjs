import { createHash } from "node:crypto";

// How many tool calls may run without the user intervening before the guard
// stops the run. The prompt hook resets the counter, so this is literally
// "tool calls since the user last spoke" — a defined signal, unlike a
// transcript-derived "no progress" heuristic.
export const EXECUTION_MUTATION_LIMIT = 48;

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
