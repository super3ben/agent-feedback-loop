import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { runGuardCommand } from "../src/convergence-sdd-adapter.mjs";
import { initializeControlStore } from "../src/control-store.mjs";
import { pathsFor } from "../src/index.mjs";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "guard");
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(name) {
  return JSON.parse(await readFile(path.join(FIXTURES, `${name}.json`), "utf8"));
}

async function harness(name) {
  const state = await fixture(name);
  const root = await mkdtemp(path.join(tmpdir(), "afl-sdd-adapter-"));
  cleanups.push(root);
  const repoRoot = path.join(root, "repo");
  const home = path.join(root, "home");
  await mkdir(repoRoot, { mode: 0o700 });
  await mkdir(path.join(repoRoot, ".superpowers", "sdd"), { recursive: true, mode: 0o700 });
  execFileSync("git", ["init", "-q", repoRoot]);
  let currentTime = new Date("2026-07-21T00:00:00.000Z");
  const now = () => new Date(currentTime);
  const store = initializeControlStore({ paths: pathsFor(home), now });

  const key = [
    "--task-id", state.task_id,
    "--invariant-id", state.invariant_id,
    "--boundary", state.boundary
  ];
  const command = (args) => runGuardCommand({ args, repoRoot, store, now });
  const review = ({ run, verdict = "changes_required", evidence = `evidence-${run}` }) => command([
    "record-review", ...key,
    "--review-run-id", run,
    "--severity", "Important",
    "--verdict", verdict,
    "--commit", `commit-${run}`,
    "--review-ref", `reviews/${run}.md`,
    ...(verdict === "changes_required" ? [
      "--hypothesis", `hypothesis-${run}`,
      "--new-evidence", evidence,
      "--falsification-test", `falsification-${run}`,
      "--failure-next-action", "direction_review"
    ] : [])
  ]);
  const authorize = (mode, file, checkpoint = null, fileFlag = "--grant-file") => command([
    "authorize-fix", ...key, "--mode", mode, fileFlag, file,
    ...(checkpoint ? ["--checkpoint-file", checkpoint] : [])
  ]);
  const consume = (file, briefRef) => command([
    "consume-grant", "--grant-file", file, "--brief-ref", briefRef
  ]);

  return {
    state,
    repoRoot,
    store,
    key,
    command,
    review,
    authorize,
    consume,
    advance(milliseconds) { currentTime = new Date(currentTime.getTime() + milliseconds); }
  };
}

async function checkpointFile(repoRoot, key) {
  const file = path.join(repoRoot, ".superpowers", "sdd", "direction-checkpoint.md");
  const values = Object.fromEntries(Array.from({ length: key.length / 2 }, (_, index) => [key[index * 2], key[index * 2 + 1]]));
  await writeFile(file, [
    "# Review Loop Architecture Checkpoint",
    "",
    `- Task ID: ${values["--task-id"]}`,
    `- Invariant ID: ${values["--invariant-id"]}`,
    `- Boundary: ${values["--boundary"]}`,
    "- Business goal: preserve one durable authority",
    "- Hard constraints: keep one SQLite store",
    "- Failed assumption: a local patch was sufficient",
    "- Authoritative state or evidence: two independent failed reviews",
    "- Options considered: patch; change direction; stop",
    "- Selected direction: change the architecture seam",
    "- Shared root cause: authority was split",
    "- Wrong abstraction or state source: duplicate state",
    "- New invariant: one authoritative store",
    "- New falsifiable invariant: one transaction owns each transition",
    "- Paths to remove or change: bounded Task 4 paths",
    "- Bounded implementation scope: SDD adapter only",
    "- Explicit exclusions: no service or scheduler",
    "- Validation proving the new boundary: adapter and oracle tests",
    "- Stop or rollback condition: a second state authority appears",
    ""
  ].join("\n"), { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

test("first failure authorizes one local fix and the second requires direction review", async (t) => {
  const firstFixture = await fixture("open-first-failure");
  const secondFixture = await fixture("second-failure-direction");
  const h = await harness("open-first-failure");
  t.after(() => h.store.close());

  const first = await h.review({ run: "review-1" });
  assert.equal(first.action, firstFixture.expected.action);
  assert.equal(first.exitCode, firstFixture.expected.exit_code);
  assert.equal(first.failure_count, firstFixture.expected.failure_count);

  const grantFile = path.join(h.repoRoot, ".superpowers", "sdd", "local-grant.json");
  const authorized = await h.authorize("local_fix", grantFile);
  assert.equal(authorized.continuation_grant.purpose, "local_fix");
  await h.consume(grantFile, "brief-task-4-fix-1");

  const second = await h.review({ run: "review-2" });
  assert.equal(second.action, secondFixture.expected.action);
  assert.equal(second.exitCode, secondFixture.expected.exit_code);
  assert.equal(second.failure_count, secondFixture.expected.failure_count);
});

test("closed regression keeps identity and architecture failure goes human", async (t) => {
  const regressionFixture = await fixture("closed-regression");
  const architectureFixture = await fixture("architecture-failed");
  const h = await harness("closed-regression");
  t.after(() => h.store.close());

  const first = await h.review({ run: "review-1", evidence: "initial-gap" });
  const localGrant = path.join(h.repoRoot, ".superpowers", "sdd", "local-grant.json");
  await h.authorize("local_fix", localGrant);
  await h.consume(localGrant, "brief-local-fix");
  await h.review({ run: "review-approved", verdict: "approved" });

  const regression = await h.review({ run: "review-regression", evidence: "production-counterexample" });
  assert.equal(regression.fingerprint, first.fingerprint);
  assert.equal(regression.action, regressionFixture.expected.action);
  assert.equal(regression.exitCode, regressionFixture.expected.exit_code);
  assert.equal(regression.failure_count, regressionFixture.expected.failure_count);
  assert.deepEqual(regression.fix_generations, [1]);

  const checkpoint = await checkpointFile(h.repoRoot, h.key);
  await h.command(["checkpoint", ...h.key, "--file", checkpoint]);
  const architectureGrant = path.join(h.repoRoot, ".superpowers", "sdd", "architecture-grant.json");
  await h.authorize("architecture_fix", architectureGrant, checkpoint);
  await h.consume(architectureGrant, "brief-architecture-fix");

  const failed = await h.review({ run: "review-architecture", evidence: "architecture-counterexample" });
  assert.equal(failed.fingerprint, first.fingerprint);
  assert.equal(failed.action, architectureFixture.expected.action);
  assert.equal(failed.exitCode, architectureFixture.expected.exit_code);
  assert.equal(failed.architecture_fix_count, architectureFixture.expected.architecture_fix_count);
});

test("exact review replay is idempotent and a changed review-run collides", async (t) => {
  const h = await harness("open-first-failure");
  t.after(() => h.store.close());

  const first = await h.review({ run: "stable-review", evidence: "evidence-a" });
  const replay = await h.review({ run: "stable-review", evidence: "evidence-a" });
  assert.deepEqual(replay, first);
  await assert.rejects(
    h.review({ run: "stable-review", evidence: "changed-evidence" }),
    (error) => error.code === "event_collision"
  );
  const status = await h.command(["status", "--task-id", h.state.task_id]);
  assert.equal(status.loops[0].failure_count, 1);
  assert.deepEqual(status.loops[0].seen_review_run_ids, ["stable-review"]);
});

test("alias rewrite retains canonical identity and distinct findings require reason plus evidence", async (t) => {
  const h = await harness("open-first-failure");
  t.after(() => h.store.close());
  const first = await h.review({ run: "review-canonical", evidence: "canonical-evidence" });

  await h.command([
    "add-alias", "--alias", "renamed-writer", "--canonical", h.state.invariant_id
  ]);
  const aliasReview = await h.command([
    "record-review",
    "--task-id", h.state.task_id,
    "--invariant-id", "renamed-writer",
    "--boundary", h.state.boundary,
    "--review-run-id", "review-alias",
    "--severity", "Critical",
    "--verdict", "changes_required",
    "--commit", "commit-alias",
    "--review-ref", "reviews/alias.md",
    "--hypothesis", "renaming hid the same writer",
    "--new-evidence", "alias-counterexample",
    "--falsification-test", "prove independent authority",
    "--failure-next-action", "direction_review"
  ]);
  assert.equal(aliasReview.fingerprint, first.fingerprint);
  assert.equal(aliasReview.failure_count, 2);

  await assert.rejects(
    h.command([
      "declare-distinct", ...h.key.slice(0, 2),
      "--invariant-id", "lost-update", "--boundary", h.state.boundary,
      "--reason", "independent-failure"
    ]),
    (error) => error.code === "guard_invalid_arguments"
  );
  const distinct = await h.command([
    "declare-distinct", "--task-id", h.state.task_id,
    "--invariant-id", "lost-update", "--boundary", h.state.boundary,
    "--reason", "independent-failure", "--evidence", "lost-update-proof"
  ]);
  assert.notEqual(distinct.fingerprint, first.fingerprint);
  const sameRunDistinct = await h.command([
    "record-review", "--task-id", h.state.task_id,
    "--invariant-id", "lost-update", "--boundary", h.state.boundary,
    "--review-run-id", "review-canonical", "--severity", "Important",
    "--verdict", "changes_required", "--commit", "distinct-commit",
    "--review-ref", "reviews/distinct.md", "--hypothesis", "a separate update was lost",
    "--new-evidence", "distinct-counterexample", "--falsification-test", "prove independent write",
    "--failure-next-action", "direction_review"
  ]);
  assert.equal(sameRunDistinct.fingerprint, distinct.fingerprint);
  assert.equal(sameRunDistinct.failure_count, 1);
});

test("an undeclared invariant and any historical evidence reuse cannot evade the loop", async (t) => {
  const h = await harness("open-first-failure");
  t.after(() => h.store.close());
  await h.review({ run: "review-a", evidence: "evidence-a" });

  await assert.rejects(
    h.command([
      "record-review", "--task-id", h.state.task_id,
      "--invariant-id", "renamed-without-alias", "--boundary", h.state.boundary,
      "--review-run-id", "review-renamed", "--severity", "Important",
      "--verdict", "changes_required", "--commit", "renamed-commit",
      "--review-ref", "reviews/renamed.md", "--hypothesis", "the name changed",
      "--new-evidence", "renamed-evidence", "--falsification-test", "classify identity",
      "--failure-next-action", "direction_review"
    ]),
    (error) => error.code === "invariant_classification_required"
  );

  await h.review({ run: "review-b", evidence: "evidence-b" });
  await assert.rejects(
    h.review({ run: "review-c", evidence: "evidence-a" }),
    (error) => error.code === "evidence_not_new"
  );
  const status = await h.command(["status", "--task-id", h.state.task_id]);
  assert.equal(status.loops.length, 1);
  assert.equal(status.loops[0].failure_count, 2);
  assert.deepEqual(status.loops[0].seen_review_run_ids, ["review-a", "review-b"]);
});

test("grant artifact is private, token-free on stdout, single-use, and parser-compatible", async (t) => {
  const h = await harness("open-first-failure");
  t.after(() => h.store.close());
  await h.review({ run: "review-private" });
  const grantFile = path.join(h.repoRoot, ".superpowers", "sdd", "compat-grant.json");

  const authorized = await h.authorize("local_fix", grantFile, null, "--receipt-file");
  assert.equal(JSON.stringify(authorized).includes("token"), false);
  assert.equal((await stat(grantFile)).mode & 0o777, 0o600);
  const artifact = JSON.parse(await readFile(grantFile, "utf8"));
  assert.equal(typeof artifact.continuation_grant.token, "string");
  const replayed = await h.authorize("local_fix", grantFile, null, "--receipt-file");
  assert.deepEqual(replayed, authorized);
  const replayedArtifact = JSON.parse(await readFile(grantFile, "utf8"));
  assert.equal(replayedArtifact.continuation_grant.token, artifact.continuation_grant.token);
  assert.equal(h.store.database.prepare(
    "SELECT COUNT(*) AS count FROM continuation_grants"
  ).get().count, 1);
  assert.deepEqual(
    (await readdir(path.dirname(grantFile))).filter((name) => name.endsWith(".tmp")),
    []
  );

  const consumed = await h.command([
    "consume-receipt", "--receipt-file", grantFile, "--brief-ref", "compat-fix-brief"
  ]);
  assert.equal(consumed.action, "continuation_grant_consumed");
  await assert.rejects(stat(grantFile), (error) => error.code === "ENOENT");
});

test("expired, changed, and checkpoint-stale grants fail closed without deleting evidence", async (t) => {
  const expired = await harness("open-first-failure");
  t.after(() => expired.store.close());
  await expired.review({ run: "review-expired" });
  const expiredFile = path.join(expired.repoRoot, ".superpowers", "sdd", "expired.json");
  await expired.authorize("local_fix", expiredFile);
  expired.advance(5 * 60_000 + 1);
  await assert.rejects(
    expired.consume(expiredFile, "expired-brief"),
    (error) => error.code === "grant_expired"
  );
  assert.equal((await stat(expiredFile)).isFile(), true);

  const changed = await harness("open-first-failure");
  t.after(() => changed.store.close());
  await changed.review({ run: "review-changed" });
  const changedFile = path.join(changed.repoRoot, ".superpowers", "sdd", "changed.json");
  await changed.authorize("local_fix", changedFile);
  const changedArtifact = JSON.parse(await readFile(changedFile, "utf8"));
  changedArtifact.continuation_grant.token = "changed-token";
  await writeFile(changedFile, `${JSON.stringify(changedArtifact)}\n`, { mode: 0o600 });
  await chmod(changedFile, 0o600);
  await assert.rejects(
    changed.consume(changedFile, "changed-brief"),
    (error) => error.code === "grant_not_found"
  );

  const checkpoint = await harness("closed-regression");
  t.after(() => checkpoint.store.close());
  await checkpoint.review({ run: "review-1", evidence: "first-gap" });
  const localFile = path.join(checkpoint.repoRoot, ".superpowers", "sdd", "local.json");
  await checkpoint.authorize("local_fix", localFile);
  await checkpoint.consume(localFile, "local-brief");
  await checkpoint.review({ run: "review-2", evidence: "second-gap" });
  const checkpointPath = await checkpointFile(checkpoint.repoRoot, checkpoint.key);
  await checkpoint.command(["checkpoint", ...checkpoint.key, "--file", checkpointPath]);
  const architectureFile = path.join(checkpoint.repoRoot, ".superpowers", "sdd", "architecture.json");
  await checkpoint.authorize("architecture_fix", architectureFile, checkpointPath);
  await writeFile(checkpointPath, `${await readFile(checkpointPath, "utf8")}changed\n`, { mode: 0o600 });
  await chmod(checkpointPath, 0o600);
  await assert.rejects(
    checkpoint.consume(architectureFile, "architecture-brief"),
    (error) => error.code === "checkpoint_changed"
  );
});

test("status and lock-status are bounded Store projections and strict parsing rejects extras", async (t) => {
  const h = await harness("open-first-failure");
  t.after(() => h.store.close());
  await h.review({ run: "review-status" });

  const statusResult = await h.command(["status", "--task-id", h.state.task_id]);
  assert.equal(statusResult.authority, "afl_sqlite");
  assert.equal(statusResult.loops.length, 1);
  assert.equal(statusResult.loops[0].failure_count, 1);
  const lock = await h.command(["lock-status"]);
  assert.equal(lock.authority, "afl_sqlite");
  assert.equal(lock.locked, false);
  assert.match(lock.journal_mode, /^(?:delete|wal)$/u);
  assert.equal(lock.exitCode, 0);

  for (const args of [
    ["status", "--task-id", h.state.task_id, "--unknown", "value"],
    ["record-review", ...h.key, "--task-id", h.state.task_id],
    ["probe", "--task-id", h.state.task_id]
  ]) {
    await assert.rejects(h.command(args), (error) => error.code === "guard_invalid_arguments");
  }
});
