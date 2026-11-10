#!/usr/bin/env node
/**
 * Keeps the dsh plugin marketplace entry in sync with this repository.
 *
 * The marketplace (awesome-dsh-plugin) is PR-based and we do not have push
 * access to it: an entry can only change by opening a pull request from a fork
 * branch. So "sync the marketplace" means "open a PR when the entry differs from
 * what upstream has", never "write to main".
 *
 * Usage:
 *   node scripts/marketplace.mjs            # open a PR if the entry drifted
 *   node scripts/marketplace.mjs --dry-run  # report drift, change nothing
 *
 * The entry content lives in templates/dsh-plugin/marketplace-entry.yml so it is
 * reviewable in this repo instead of being assembled inside a script.
 */

import { execFile } from "node:child_process";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");

const UPSTREAM = "awesome-dsh-plugin/awesome-dsh-plugin";
const ENTRY_DIR = "data/plugins";
const ENTRY_NAME = "super3ben__agent-feedback-loop--templates-dsh-plugin.yml";
const ENTRY_PATH = `${ENTRY_DIR}/${ENTRY_NAME}`;
const SOURCE = path.join(ROOT, "templates", "dsh-plugin", "marketplace-entry.yml");

function step(message) {
  process.stdout.write(`\n▸ ${message}\n`);
}

function say(message) {
  process.stdout.write(`  ${message}\n`);
}

function warn(message) {
  process.stdout.write(`  ! ${message}\n`);
}

class MarketplaceError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

async function run(command, commandArgs, options = {}) {
  const { allowFailure = false, cwd = ROOT, input } = options;
  try {
    const result = await execFileAsync(command, commandArgs, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      env: process.env,
      ...(input === undefined ? {} : { input })
    });
    return result.stdout.trim();
  } catch (error) {
    if (allowFailure) return null;
    const detail = [error?.stdout, error?.stderr].filter(Boolean).join("\n").trim();
    throw new MarketplaceError(
      `${command} ${commandArgs.join(" ")} failed`,
      detail || String(error)
    );
  }
}

async function gh(args, options = {}) {
  return run("gh", args, options);
}

async function ghJson(args, options = {}) {
  const output = await gh(args, options);
  if (output === null) return null;
  try {
    return JSON.parse(output);
  } catch {
    throw new MarketplaceError(`could not parse gh output for: gh ${args.join(" ")}`);
  }
}

/** The entry as upstream currently has it, or null when it is not listed yet. */
async function fetchUpstreamEntry() {
  const raw = await gh(
    ["api", `repos/${UPSTREAM}/contents/${ENTRY_PATH}`, "--jq", ".content"],
    { allowFailure: true }
  );
  if (!raw) return null;
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  // The trailing newline is not meaningful YAML; normalizing it keeps a pure
  // whitespace difference from opening a pull request.
  return decoded.replace(/\s+$/u, "");
}

async function ensureGhReady() {
  const auth = await gh(["auth", "status"], { allowFailure: true });
  if (auth === null) {
    throw new MarketplaceError(
      "gh is not authenticated",
      "run: gh auth login"
    );
  }
  const fork = await ghJson(["api", `repos/super3ben/${UPSTREAM.split("/")[1]}`, "--jq", "{fork: .fork}"], {
    allowFailure: true
  });
  if (!fork?.fork) {
    throw new MarketplaceError(
      `no fork of ${UPSTREAM} found for this account`,
      `run: gh repo fork ${UPSTREAM} --clone=false`
    );
  }
}

/**
 * Whether an open pull request already carries this entry change. Re-opening a
 * PR for content that is already proposed just spams the maintainers, and the
 * marketplace has merged three of our PRs already under different titles.
 */
async function findOpenPullRequest(headBranch) {
  const list = await ghJson([
    "pr",
    "list",
    "--repo",
    UPSTREAM,
    "--author",
    "@me",
    "--state",
    "open",
    "--json",
    "number,title,headRefName"
  ], { allowFailure: true });
  if (!Array.isArray(list)) return null;
  return list.find((entry) => entry.headRefName === headBranch) ?? null;
}

/**
 * Opens (or updates) a pull request whose only change is the entry file.
 *
 * Work happens in a scratch clone of the fork so the developer's working tree
 * is never touched — publishing must not leave the repo dirty.
 */
async function openEntryPullRequest({ entry, previous }) {
  const scratch = await mkdtemp(path.join(tmpdir(), "afl-marketplace-"));
  const cloneDir = path.join(scratch, "fork");
  const branch = `update-agent-feedback-loop-entry`;
  try {
    step("Preparing the fork branch");
    await run("gh", ["repo", "sync", "super3ben/awesome-dsh-plugin", "--force"], {
      allowFailure: true
    });
    await run("git", [
      "clone",
      "--depth", "1",
      "--branch", "main",
      `https://github.com/super3ben/${UPSTREAM.split("/")[1]}.git`,
      cloneDir
    ], { cwd: scratch });
    await run("git", ["config", "user.name", "super3ben"], { cwd: cloneDir });
    await run("git", ["config", "user.email", "super3ben@users.noreply.github.com"], { cwd: cloneDir });

    const target = path.join(cloneDir, ENTRY_PATH);
    await writeFile(target, `${entry}\n`);
    await run("git", ["checkout", "-B", branch], { cwd: cloneDir });
    const status = await run("git", ["status", "--porcelain"], { cwd: cloneDir });
    if (!status) {
      say("fork already matches — nothing to propose");
      return { opened: false };
    }
    await run("git", ["add", ENTRY_PATH], { cwd: cloneDir });
    const verb = previous === null ? "Add" : "Refresh";
    await run("git", [
      "commit",
      "-m",
      `${verb} super3ben/agent-feedback-loop marketplace entry`,
      "-m",
      previous === null
        ? "New listing for the agent-feedback-loop dsh plugin (memory)."
        : "Entry content changed; the previous listing described an older feature set."
    ], { cwd: cloneDir });
    await run("git", ["push", "--force", "origin", branch], { cwd: cloneDir });

    const existing = await findOpenPullRequest(branch);
    if (existing) {
      say(`open pull request already exists: #${existing.number}`);
      return { opened: false, number: existing.number };
    }

    step("Opening the pull request");
    const body = [
      previous === null
        ? "Adds the agent-feedback-loop dsh plugin to the marketplace."
        : "Updates the existing agent-feedback-loop entry so it describes what the plugin does now.",
      "",
      "Checklist:",
      "- [x] One file at `data/plugins/` — the whole submission",
      "- [x] `package.json` declares `dsh.bundle`",
      "- [x] Repository has the `dsh-plugin` topic",
      "- [x] Category is `memory`",
      "- [x] Description states what the plugin does, no superlatives",
      "- [x] Published to npm (`agent-feedback-loop`)"
    ].join("\n");
    const prUrl = await run("gh", [
      "pr", "create",
      "--repo", UPSTREAM,
      "--head", `super3ben:${branch}`,
      "--base", "main",
      "--title", previous === null
        ? "Add super3ben/agent-feedback-loop (memory)"
        : "Refresh super3ben/agent-feedback-loop entry",
      "--body", body
    ], { cwd: cloneDir });
    return { opened: true, url: prUrl };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Called by scripts/publish.mjs. Reports what it did; never throws for a
 * marketplace problem, because a marketplace PR is not worth failing a release
 * that already reached npm.
 */
export async function syncMarketplace({ dryRun = false, log = true } = {}) {
  const io = log ? { step, say, warn } : { step() {}, say() {}, warn() {} };
  io.step("Checking the dsh marketplace entry");
  try {
    const local = (await readFile(SOURCE, "utf8")).replace(/\s+$/u, "");
    const upstream = await fetchUpstreamEntry();

    if (upstream === local) {
      io.say("entry matches upstream — nothing to do");
      return { status: "unchanged" };
    }

    const drift = upstream === null ? "not listed yet" : "entry differs from upstream";
    io.say(drift);

    if (dryRun) {
      io.step("Dry run: would open a marketplace pull request");
      return { status: "would_update" };
    }

    await ensureGhReady();
    const result = await openEntryPullRequest({ entry: local, previous: upstream });
    if (result.opened) io.say(`opened ${result.url}`);
    return { status: result.opened ? "opened" : "unchanged", ...result };
  } catch (error) {
    // The marketplace is a separate repository with its own maintainers; a
    // failure here says nothing about whether the release itself is sound.
    io.warn(error instanceof Error ? error.message : String(error));
    if (error?.hint) io.warn(error.hint);
    io.warn("marketplace not updated — rerun with: node scripts/marketplace.mjs");
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

// Standalone use: node scripts/marketplace.mjs [--dry-run]
if (import.meta.filename === process.argv[1]) {
  const dryRun = new Set(process.argv.slice(2)).has("--dry-run");
  const result = await syncMarketplace({ dryRun });
  if (result.status === "failed") process.exitCode = 1;
}
