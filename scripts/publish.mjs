#!/usr/bin/env node
/**
 * Cut a release: verify it, push it, tag it, and let CI publish it.
 *
 * Usage:
 *   node scripts/publish.mjs              # push main, tag vX.Y.Z, wait for CI
 *   node scripts/publish.mjs --dry-run    # run every check, push and publish nothing
 *   node scripts/publish.mjs --skip-tests # skip the suite (not recommended)
 *   node scripts/publish.mjs --skip-wait  # tag and return without waiting for CI
 *
 * This script does NOT run `npm publish`. Since npm began retiring 2FA-bypass
 * tokens for direct publishing (account changes from August 2026, direct
 * publishing from January 2027), a long-lived ~/.npmrc token is no longer a
 * durable release path. Publication now happens in
 * .github/workflows/publish.yml, which authenticates as the workflow over OIDC —
 * no stored secret, nothing to rotate, nothing that can leak into git history.
 *
 * So the local job is: make sure the tree is releasable, push the commit, and
 * push a `v*` tag. The tag is the release trigger, which also means a release
 * is always traceable to an immutable git object.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { syncMarketplace } from "./marketplace.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const skipTests = args.has("--skip-tests");
const skipWait = args.has("--skip-wait");

function step(message) {
  process.stdout.write(`\n▸ ${message}\n`);
}

function say(message) {
  process.stdout.write(`  ${message}\n`);
}

function fail(message, hint) {
  process.stderr.write(`\n✗ ${message}\n`);
  if (hint) process.stderr.write(`  ${hint}\n`);
  process.exit(1);
}

async function run(command, commandArgs, { allowFailure = false, capture = true } = {}) {
  try {
    const result = await execFileAsync(command, commandArgs, {
      cwd: ROOT,
      maxBuffer: 32 * 1024 * 1024,
      env: process.env
    });
    return capture ? result.stdout.trim() : "";
  } catch (error) {
    if (allowFailure) return null;
    const detail = [error?.stdout, error?.stderr].filter(Boolean).join("\n").trim();
    fail(`${command} ${commandArgs.join(" ")} failed`, detail || String(error));
  }
}

/**
 * Block until the tag's `push` event has produced a workflow run.
 *
 * The tag push and the run's creation are not atomic: for a second or two after
 * the push there is simply nothing to watch, and treating that as failure would
 * report a broken release that is in fact about to start.
 */
async function waitForWorkflowStart({ name, version, attempts = 40, intervalMs = 3_000 }) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const raw = await run("gh", [
      "run", "list", "--workflow=publish.yml", "--limit=1", "--json=databaseId,headBranch,headSha,event,status"
    ], { allowFailure: true });
    if (raw) {
      try {
        const [latest] = JSON.parse(raw);
        if (latest?.databaseId) return latest.databaseId;
      } catch {
        // A transient read error is not a verdict; retry.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  fail(`no publish workflow run appeared for ${name}@${version}`, "check: gh run list --workflow=publish.yml");
}

/** Follow a run to its conclusion. `--exit-status` reports failure as a non-zero exit. */
async function watchWorkflow(runId) {
  const raw = await run("gh", ["run", "watch", String(runId), "--exit-status", "--interval=10"], {
    allowFailure: true
  });
  // `gh run watch` prints progress to stderr and exits non-zero on failure, so
  // the authoritative answer is the run's own conclusion, read back afterwards.
  void raw;
  const detail = await run("gh", ["run", "view", String(runId), "--json=conclusion,status"], {
    allowFailure: true
  });
  try {
    const parsed = JSON.parse(detail ?? "{}");
    return parsed.conclusion ?? parsed.status ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function main() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const { name, version } = pkg;

  step(`Publishing ${name}@${version}${dryRun ? " (dry run)" : ""}`);

  // A dirty tree means the pushed commit and the published tarball could differ.
  // Anything unpublished is then untraceable to a commit, which is the one
  // thing a release must never be.
  step("Checking the working tree is clean");
  const status = await run("git", ["status", "--porcelain"]);
  if (status) {
    fail("the working tree has uncommitted changes", `commit or stash them first:\n${status}`);
  }
  say("clean");

  step("Checking npm authentication");
  // Only a READ is needed locally now: publication happens in CI. `whoami` is
  // still checked because an expired token makes `npm view` below fail in a way
  // that reads like "the package does not exist" rather than "you are logged
  // out", and an anonymous read is enough for every check here.
  const whoami = await run("npm", ["whoami"], { allowFailure: true });
  if (!whoami) {
    warn("not authenticated to npm — reads may be limited, publication is unaffected");
  } else {
    say(`authenticated as ${whoami} (read-only use)`);
  }

  const published = await run("npm", ["view", name, "version"], { allowFailure: true });
  if (published === version) {
    fail(`${name}@${version} is already published`, "bump the version in package.json first");
  }
  say(`registry has ${published ?? "(nothing)"}, releasing ${version}`);

  // A tag that already exists means this version was cut before. Pushing it
  // again would either fail or, worse, silently point at a different commit
  // than the one that was reviewed.
  const existingTag = await run("git", ["rev-parse", "--verify", "--quiet", `refs/tags/v${version}`], {
    allowFailure: true
  });
  if (existingTag) {
    fail(`tag v${version} already exists locally`, "bump the version, or delete the tag if it was never pushed");
  }
  const remoteTag = await run("git", ["ls-remote", "--tags", "origin", `refs/tags/v${version}`], {
    allowFailure: true
  });
  if (remoteTag) {
    fail(`tag v${version} already exists on origin`, "bump the version in package.json first");
  }
  say(`tag v${version} is available`);

  if (!skipTests) {
    step("Running the test suite");
    // The suite is the only thing that catches a change that merely looks
    // correct, and a broken release is not recoverable — npm allows unpublish
    // only within 72 hours.
    await run("npm", ["test"], { capture: false });
    say("passed");
  } else {
    step("Skipping tests (--skip-tests)");
  }

  step("Checking what the tarball will contain");
  const pack = await run("npm", ["pack", "--dry-run", "--json"]);
  let packed;
  try {
    const [first] = JSON.parse(pack);
    packed = first;
  } catch {
    fail("could not read npm pack output");
  }
  say(`${packed.entryCount} files, ${(packed.unpackedSize / 1024).toFixed(0)} KB unpacked`);
  const suspicious = packed.files
    .map((file) => file.path)
    .filter((file) => /(^|\/)(\.env|\.npmrc|test\/|\.agent\/|\.comet\/|docs\/)/u.test(file));
  if (suspicious.length) {
    fail("the package would ship files that must stay local", suspicious.join("\n"));
  }
  say("no credentials, tests or workflow state included");

  if (dryRun) {
    step("Dry run: nothing pushed, nothing tagged, nothing published");
    return;
  }

  step("Pushing to origin");
  await run("git", ["push", "origin", "main"], { capture: false });
  say("pushed");

  // The tag is the release trigger. It is pushed as its own step so a rejected
  // tag (for example a protected-tag rule) cannot leave the branch half-released.
  step(`Tagging v${version}`);
  await run("git", ["tag", "-a", `v${version}`, "-m", `${name}@${version}`], { capture: false });
  await run("git", ["push", "origin", `refs/tags/v${version}`], { capture: false });
  say(`tagged v${version}`);

  if (skipWait) {
    step("Skipping the wait (--skip-wait)");
    say(`CI publishes on the tag; watch it with: gh run list --workflow=publish.yml`);
    return;
  }

  step("Waiting for the publish workflow");
  say("the workflow runs the suite, publishes over OIDC, then verifies the registry");
  const runId = await waitForWorkflowStart({ name, version });
  const conclusion = await watchWorkflow(runId, { name, version });
  if (conclusion !== "success") {
    fail(`the publish workflow finished as "${conclusion}"`,
      `inspect it with: gh run view ${runId} --log-failed`);
  }
  say(`${name}@${version} is live`);

  // Runs last on purpose: the marketplace is a separate repository with its own
  // maintainers, so a problem there must not fail a release that already
  // reached npm. It opens a pull request; it never writes to their main.
  const marketplace = await syncMarketplace({ dryRun: false });

  const summary = [
    `✓ ${name}@${version}`,
    "  GitHub   pushed",
    "  npm      published"
  ];
  summary.push(
    marketplace.status === "opened"
      ? `  dsh      pull request opened (${marketplace.url})`
      : marketplace.status === "unchanged"
        ? "  dsh      entry already current"
        : "  dsh      not updated — see the warning above"
  );
  process.stdout.write(`\n${summary.join("\n")}\n`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
