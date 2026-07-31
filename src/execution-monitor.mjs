import { createHash } from "node:crypto";

// How many times one artifact may be rewritten while the user stays silent.
// Creating a file is free; only edits to existing content count. At 2 the third
// rewrite is stopped, which is where refining an artifact nobody asked to
// refine starts to look like circling rather than converging.
//
// The signal is rework, not activity: a task that runs 44 tools and finishes is
// healthy, while one that rewrites the same file again and again without new
// input is circling. Advanced models reach this state by review-then-improve
// loops that never fail — each pass looks reasonable, and nothing ever errors.
//
// The user speaking resets it, because a new instruction is new evidence.
export const EXECUTION_REWORK_LIMIT = 2;

// How many distinct artifacts may be rewritten in one session before the
// direction itself is stopped, rather than any single file.
//
// Per-file counting alone misses the shape that actually costs the most. A real
// session rewrote 20 different artifacts, each one or two times, and never
// tripped the per-file limit: it had turned "make one ledger candidate
// traceable" into a general git-lineage policy across every package. Circling
// in place and spreading sideways are both non-convergence; only the second one
// keeps every individual counter low.
//
// 8 is set from observed sessions: the spreading run reached 20 distinct
// rewritten artifacts, while a healthy 160-call run touched 3.
export const EXECUTION_SPREAD_LIMIT = 8;

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

// Repeated writes to one file come in two shapes, and only one is rework.
//
// Recording progress appends: each write adds lines and removes none, because
// the file's purpose is to accumulate. Reworking rewrites: the agent deletes
// what it wrote before and replaces it, which is what circling looks like.
//
// Deciding on content rather than on a list of "bookkeeping paths" matters
// because that list is an open set. A run was once stopped for updating
// .comet/subagent-progress.md; excluding that path would have left the same
// mistake waiting under notes.md, report.md, or any name not yet enumerated.
const PATCH_ADDED_LINE = /^\+(?!\+\+)/u;
const PATCH_REMOVED_LINE = /^-(?!--)/u;

/**
 * Whether a patch replaces existing content rather than only adding to it.
 * A pure append is the file doing its job; deleting prior lines to write them
 * differently is the signal this guard is looking for.
 */
export function rewritesExistingContent(command) {
  if (typeof command !== "string" || !command) return false;
  let removed = 0;
  for (const line of command.split("\n")) {
    if (PATCH_REMOVED_LINE.test(line)) removed += 1;
  }
  return removed > 0;
}

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

// Codex sends the patch as an argv array — its own tool instructions read
// {"command":["apply_patch","*** Begin Patch\n..."]} — so reading `command` as a
// string found nothing and every Codex edit went uncounted. A live run rewrote
// one file five times and the guard recorded one, which is why it never fired.
// Both shapes are accepted: the array member carrying the patch, or a plain
// string for callers that send one.
function patchScript(command) {
  if (typeof command === "string") return command;
  if (!Array.isArray(command)) return "";
  for (const part of command) {
    if (typeof part === "string" && part.includes("*** Begin Patch")) return part;
  }
  return "";
}

function hashedTarget(value) {
  // The path is hashed: rework only needs to know that the same artifact came
  // back, and a file path can carry information that should not be stored.
  return createHash("sha256").update(String(value).slice(0, MAX_TARGET_LABEL), "utf8")
    .digest("hex").slice(0, 16);
}

// Rewriting one file repeatedly is what red-green-refactor looks like, so the
// shape the guard counts is also the shape of the discipline it must not
// punish. What separates them is not the file — paths are hashed here, and a
// name like `foo.test.mjs` proves nothing anyway — but whether a suite actually
// ran in between. Running one is a real act with a real cost; talking about
// testing is free, and a measured run wrote a 37KB "testing strategy" section
// while never invoking a suite once.
//
// So this looks for a command that runs tests, not for the word. It is used to
// forgive a rewrite, never to cause a block: a false negative just leaves the
// ordinary counters in charge.
const TEST_COMMAND = new RegExp([
  "(?:^|[;&|]\\s*|\\s)(?:",
  [
    "(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?test",
    "node\\s+--test",
    "(?:python3?\\s+-m\\s+)?pytest",
    "python3?\\s+-m\\s+unittest",
    "(?:cargo|go|mvn|gradle|swift|dotnet)\\s+test",
    "(?:npx\\s+)?(?:vitest|jest|mocha|ava|tap|rspec|phpunit|ctest)",
    // Usually invoked by path, as ./gradlew or ./mvnw.
    "(?:[.~]?[\\w./-]*/)?(?:gradlew|mvnw)\\s+(?:[\\w:.-]+\\s+)*(?:test|check|verify)",
    "make\\s+(?:test|check)"
  ].join("|"),
  ")"
].join(""), "u");

/**
 * Whether a tool call runs a test suite. Reads the command a shell tool is
 * about to execute; anything else is not a test run.
 */
export function runsTests({ toolName, toolInput } = {}) {
  if (typeof toolName !== "string" || !toolInput || typeof toolInput !== "object"
      || Array.isArray(toolInput)) return false;
  const { command } = toolInput;
  const text = typeof command === "string"
    ? command
    : Array.isArray(command) ? command.filter((part) => typeof part === "string").join(" ") : "";
  if (!text) return false;
  return TEST_COMMAND.test(text.slice(0, 4096));
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

  // An explicit edit tool names its target and always replaces content.
  for (const field of ["file_path", "filePath", "path", "notebook_path"]) {
    const value = toolInput[field];
    if (typeof value !== "string" || !value.trim()) continue;
    // A write that only appends is accumulating, not reworking.
    const appendOnly = toolInput.old_string === "" || toolInput.mode === "append";
    return appendOnly ? null : hashedTarget(value.trim());
  }

  const command = patchScript(toolInput.command);
  if (!command) return null;
  // Creating a file is first work, never rework.
  const updated = /^\*\*\* Update File: (.+)$/mu.exec(command);
  if (!updated) return null;
  return rewritesExistingContent(command) ? hashedTarget(updated[1].trim()) : null;
}
