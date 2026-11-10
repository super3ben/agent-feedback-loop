#!/usr/bin/env node
/**
 * Publish the current version to npm, after syncing it to GitHub.
 *
 * Usage:
 *   node scripts/publish.mjs              # push to origin, then npm publish
 *   node scripts/publish.mjs --dry-run    # run every check, publish nothing
 *   node scripts/publish.mjs --skip-tests # skip the suite (not recommended)
 *
 * The registry token is NOT in this file and must never be. It lives in
 * ~/.npmrc (outside the repository, mode 0600), so nothing here can leak it
 * into git history — a token that reached GitHub could publish as the owner.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const skipTests = args.has("--skip-tests");

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
  const whoami = await run("npm", ["whoami"], { allowFailure: true });
  if (!whoami) {
    fail("not authenticated to npm", "set a token in ~/.npmrc (outside the repo) or run npm login");
  }
  say(`authenticated as ${whoami}`);

  const published = await run("npm", ["view", name, "version"], { allowFailure: true });
  if (published === version) {
    fail(`${name}@${version} is already published`, "bump the version in package.json first");
  }
  say(`registry has ${published ?? "(nothing)"}, publishing ${version}`);

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
    step("Dry run: nothing pushed, nothing published");
    return;
  }

  step("Pushing to origin");
  await run("git", ["push", "origin", "main"], { capture: false });
  say("pushed");

  step("Publishing to npm");
  await run("npm", ["publish"], { capture: false });

  step("Verifying");
  const live = await run("npm", ["view", name, "version"], { allowFailure: true });
  if (live !== version) {
    fail(`published, but the registry still reports ${live ?? "(nothing)"}`, "check npmjs.com for the package");
  }
  say(`${name}@${version} is live`);

  process.stdout.write(`\n✓ ${name}@${version} pushed to GitHub and published to npm\n`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
