import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile
} from "node:fs/promises";
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
  const command = (args, artifactHooks) => runGuardCommand({ args, repoRoot, store, now, artifactHooks });
  const review = ({
    run,
    verdict = "changes_required",
    evidence = `evidence-${run}`,
    severity = "Important"
  }) => command([
    "record-review", ...key,
    "--review-run-id", run,
    "--severity", severity,
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

test("minor changes-required is audited without authorizing or consuming failure count", async (t) => {
  const h = await harness("open-first-failure");
  t.after(() => h.store.close());

  const minor = await h.review({ run: "review-minor", severity: "Minor" });
  assert.equal(minor.action, "review_recorded");
  assert.equal(minor.failure_count, 0);
  const grantFile = path.join(h.repoRoot, ".superpowers", "sdd", "minor-grant.json");
  await assert.rejects(
    h.authorize("local_fix", grantFile),
    (error) => error.code === "transition_invalid"
  );

  const important = await h.review({ run: "review-important", severity: "Important" });
  assert.equal(important.action, "local_fix_allowed");
  assert.equal(important.failure_count, 1);
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

test("review replay binds the complete normalized audit envelope before mutation", async (t) => {
  const h = await harness("open-first-failure");
  t.after(() => h.store.close());
  const base = [
    "record-review", ...h.key,
    "--review-run-id", "audit-review",
    "--severity", "Important",
    "--verdict", "changes_required",
    "--commit", "commit-a",
    "--review-ref", "reviews/audit.md",
    "--hypothesis", "hypothesis-a",
    "--new-evidence", "evidence-audit",
    "--falsification-test", "falsification-a",
    "--failure-next-action", "direction_review",
    "--direction-signal", "none"
  ];
  const first = await h.command(base);
  const normalizedReplay = base.map((value, index) => {
    const previous = base[index - 1];
    return ["--severity", "--verdict", "--commit", "--review-ref", "--hypothesis",
      "--new-evidence", "--falsification-test", "--failure-next-action", "--direction-signal"]
      .includes(previous) ? `  ${value}  ` : value;
  });
  assert.deepEqual(await h.command(normalizedReplay), first);

  const state = () => ({
    events: h.store.database.prepare("SELECT COUNT(*) AS count FROM convergence_events").get().count,
    loops: h.store.database.prepare("SELECT COUNT(*) AS count FROM convergence_loops").get().count,
    status: h.store.getConvergenceStatus({ taskUid: first.task_id, fingerprint: first.fingerprint })
  });
  const before = state();
  const changes = new Map([
    ["--severity", "Critical"],
    ["--verdict", "approved"],
    ["--commit", "commit-b"],
    ["--review-ref", "reviews/changed.md"],
    ["--hypothesis", "hypothesis-b"],
    ["--new-evidence", "evidence-changed"],
    ["--falsification-test", "falsification-b"],
    ["--failure-next-action", "stop"],
    ["--direction-signal", "structural_blocked"]
  ]);
  for (const [flag, changed] of changes) {
    const args = [...base];
    args[args.indexOf(flag) + 1] = changed;
    await assert.rejects(h.command(args), (error) => error.code === "event_collision", flag);
    assert.deepEqual(state(), before, `${flag} collision mutated Store state`);
  }

  for (const flag of ["--hypothesis", "--new-evidence", "--falsification-test"]) {
    const args = [...base];
    args[args.indexOf(flag) + 1] = "   ";
    args[args.indexOf("--review-run-id") + 1] = `empty-${flag.slice(2)}`;
    await assert.rejects(h.command(args), (error) => error.code === "review_evidence_required", flag);
  }
  for (const flag of ["--commit", "--review-ref"]) {
    const args = [...base];
    args[args.indexOf(flag) + 1] = "   ";
    args[args.indexOf("--review-run-id") + 1] = `empty-${flag.slice(2)}`;
    await assert.rejects(h.command(args), (error) => error.code === "guard_invalid_arguments", flag);
  }
});

test("the same SDD loop coordinates remain isolated across repository lineages", async (t) => {
  const state = await fixture("open-first-failure");
  const root = await mkdtemp(path.join(tmpdir(), "afl-sdd-repository-scope-"));
  cleanups.push(root);
  const home = path.join(root, "shared-home");
  const store = initializeControlStore({
    paths: pathsFor(home),
    now: () => new Date("2026-07-21T00:00:00.000Z")
  });
  t.after(() => store.close());
  const repos = [path.join(root, "repo-a"), path.join(root, "repo-b")];
  for (const repoRoot of repos) {
    await mkdir(repoRoot, { mode: 0o700 });
    execFileSync("git", ["init", "-q", repoRoot]);
  }
  const args = [
    "record-review",
    "--task-id", state.task_id,
    "--invariant-id", state.invariant_id,
    "--boundary", state.boundary,
    "--review-run-id", "shared-review",
    "--severity", "Important",
    "--verdict", "changes_required",
    "--commit", "shared-commit",
    "--review-ref", "reviews/shared.md",
    "--hypothesis", "the same coordinates can exist in independent repositories",
    "--new-evidence", "repository-specific evidence",
    "--falsification-test", "prove each lineage has an independent loop",
    "--failure-next-action", "direction_review"
  ];

  const first = await runGuardCommand({ args, repoRoot: repos[0], store });
  const second = await runGuardCommand({ args, repoRoot: repos[1], store });
  assert.notEqual(first.task_id, second.task_id);
  assert.notEqual(first.fingerprint, second.fingerprint);
  for (const [index, result] of [first, second].entries()) {
    const projection = await runGuardCommand({
      args: ["status", "--task-id", state.task_id],
      repoRoot: repos[index],
      store
    });
    assert.deepEqual(projection.loops.map((loop) => loop.fingerprint), [result.fingerprint]);
    assert.equal(projection.loops[0].failure_count, 1);
  }
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
  const duplicateFile = path.join(h.repoRoot, ".superpowers", "sdd", "compat-grant-copy.json");
  await writeFile(duplicateFile, await readFile(grantFile), { mode: 0o600 });
  await chmod(duplicateFile, 0o600);
  const beforeConsume = await stat(grantFile);
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
  const tombstone = await stat(grantFile);
  assert.equal(tombstone.dev, beforeConsume.dev);
  assert.equal(tombstone.ino, beforeConsume.ino);
  assert.equal(tombstone.size, 0);
  assert.equal(tombstone.mode & 0o777, 0o000);
  await assert.rejects(
    h.consume(duplicateFile, "compat-fix-brief-replay"),
    (error) => error.code === "grant_consumed"
  );
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

test("artifact lifecycle rejects symlink components and inode replacement without clobbering evidence", async (t) => {
  const linked = await harness("open-first-failure");
  t.after(() => linked.store.close());
  await linked.review({ run: "review-linked" });
  const realDirectory = path.join(linked.repoRoot, ".superpowers", "sdd", "real-artifacts");
  const linkedDirectory = path.join(linked.repoRoot, ".superpowers", "sdd", "linked-artifacts");
  await mkdir(realDirectory, { mode: 0o700 });
  await symlink(realDirectory, linkedDirectory);
  await assert.rejects(
    linked.authorize("local_fix", path.join(linkedDirectory, "grant.json")),
    (error) => error.code === "artifact_unsafe"
  );
  assert.equal(linked.store.database.prepare(
    "SELECT COUNT(*) AS count FROM continuation_grants"
  ).get().count, 0);
  const leafSource = path.join(realDirectory, "leaf-source.json");
  const leafLink = path.join(linked.repoRoot, ".superpowers", "sdd", "leaf-link.json");
  await writeFile(leafSource, "{}\n", { mode: 0o600 });
  await chmod(leafSource, 0o600);
  await symlink(leafSource, leafLink);
  await assert.rejects(
    linked.authorize("local_fix", leafLink),
    (error) => error.code === "artifact_unsafe"
  );
  assert.equal(linked.store.database.prepare(
    "SELECT COUNT(*) AS count FROM continuation_grants"
  ).get().count, 0);

  const opened = await harness("open-first-failure");
  t.after(() => opened.store.close());
  await opened.review({ run: "review-opened-replacement" });
  const openedFile = path.join(opened.repoRoot, ".superpowers", "sdd", "opened.json");
  await opened.authorize("local_fix", openedFile);
  const openedOriginal = await stat(openedFile);
  const parkedFile = `${openedFile}.parked`;
  const openedReplacement = "opened-replacement-must-survive\n";
  const openedConsumed = await opened.command(
    ["consume-grant", "--grant-file", openedFile, "--brief-ref", "opened-replacement"],
    {
      async afterArtifactOpen() {
        await rename(openedFile, parkedFile);
        await writeFile(openedFile, openedReplacement, { mode: 0o600 });
        await chmod(openedFile, 0o600);
      }
    }
  );
  assert.equal(openedConsumed.action, "continuation_grant_consumed");
  assert.equal(await readFile(openedFile, "utf8"), openedReplacement);
  assert.equal((await stat(openedFile)).mode & 0o777, 0o600);
  const parked = await stat(parkedFile);
  assert.equal(parked.dev, openedOriginal.dev);
  assert.equal(parked.ino, openedOriginal.ino);
  assert.equal(parked.size, 0);
  assert.equal(parked.mode & 0o777, 0o000);
  assert.notEqual(opened.store.database.prepare(
    "SELECT consumed_at FROM continuation_grants"
  ).get().consumed_at, null);

  const ancestor = await harness("open-first-failure");
  t.after(() => ancestor.store.close());
  await ancestor.review({ run: "review-ancestor-replacement" });
  const ancestorDirectory = path.join(ancestor.repoRoot, ".superpowers", "sdd", "ancestor-artifacts");
  const parkedAncestor = `${ancestorDirectory}.parked`;
  const replacementDirectory = path.join(ancestor.repoRoot, ".superpowers", "sdd", "replacement-artifacts");
  await mkdir(ancestorDirectory, { mode: 0o700 });
  const ancestorFile = path.join(ancestorDirectory, "grant.json");
  await ancestor.authorize("local_fix", ancestorFile);
  const ancestorOriginal = await stat(ancestorFile);
  const ancestorReplacement = "ancestor-replacement-must-survive\n";
  const ancestorConsumed = await ancestor.command(
    ["consume-grant", "--grant-file", ancestorFile, "--brief-ref", "ancestor-replacement"],
    {
      async afterArtifactOpen() {
        await rename(ancestorDirectory, parkedAncestor);
        await mkdir(replacementDirectory, { mode: 0o700 });
        await writeFile(path.join(replacementDirectory, "grant.json"), ancestorReplacement, { mode: 0o600 });
        await chmod(path.join(replacementDirectory, "grant.json"), 0o600);
        await symlink(replacementDirectory, ancestorDirectory);
      }
    }
  );
  assert.equal(ancestorConsumed.action, "continuation_grant_consumed");
  assert.equal((await lstat(ancestorDirectory)).isSymbolicLink(), true);
  assert.equal(await readFile(ancestorFile, "utf8"), ancestorReplacement);
  assert.equal((await stat(ancestorFile)).mode & 0o777, 0o600);
  const ancestorParked = await stat(path.join(parkedAncestor, "grant.json"));
  assert.equal(ancestorParked.dev, ancestorOriginal.dev);
  assert.equal(ancestorParked.ino, ancestorOriginal.ino);
  assert.equal(ancestorParked.size, 0);
  assert.equal(ancestorParked.mode & 0o777, 0o000);

  const publish = await harness("open-first-failure");
  t.after(() => publish.store.close());
  await publish.review({ run: "review-publish-race" });
  const publishFile = path.join(publish.repoRoot, ".superpowers", "sdd", "publish.json");
  const sentinel = "concurrent-owner\n";
  await assert.rejects(
    publish.command(
      ["authorize-fix", ...publish.key, "--mode", "local_fix", "--grant-file", publishFile],
      {
        async beforeArtifactPublish() {
          await writeFile(publishFile, sentinel, { flag: "wx", mode: 0o600 });
          await chmod(publishFile, 0o600);
        }
      }
    ),
    (error) => error.code === "grant_artifact_exists"
  );
  assert.equal(await readFile(publishFile, "utf8"), sentinel);
  assert.deepEqual(
    (await readdir(path.dirname(publishFile))).filter((name) => name.endsWith(".tmp")),
    []
  );
});

test("artifact neutralization failure is bounded after truthful Store consumption", async (t) => {
  const h = await harness("open-first-failure");
  t.after(() => h.store.close());
  await h.review({ run: "review-neutralization-failure" });
  const grantFile = path.join(h.repoRoot, ".superpowers", "sdd", "neutralization-failure.json");
  await h.authorize("local_fix", grantFile);

  await assert.rejects(
    h.command(
      ["consume-grant", "--grant-file", grantFile, "--brief-ref", "neutralization-failure"],
      { beforeArtifactNeutralize() { throw new Error("unbounded-test-error"); } }
    ),
    (error) => error.code === "artifact_neutralization_failed"
  );
  assert.notEqual(h.store.database.prepare(
    "SELECT consumed_at FROM continuation_grants"
  ).get().consumed_at, null);
  assert.equal((await stat(grantFile)).mode & 0o777, 0o600);
  assert.match(await readFile(grantFile, "utf8"), /"token"/u);
});

test("status and lock-status are bounded Store projections and strict parsing rejects extras", async (t) => {
  const h = await harness("open-first-failure");
  t.after(() => h.store.close());
  const recorded = await h.review({ run: "review-status" });
  assert.deepEqual(Object.keys(recorded).sort(), [
    "action", "architecture_fix_count", "boundary", "canonical_invariant_id",
    "direction_signal", "exitCode", "failure_count", "fingerprint", "status", "task_id"
  ]);

  const statusResult = await h.command(["status", "--task-id", h.state.task_id]);
  assert.deepEqual(Object.keys(statusResult).sort(), ["authority", "exitCode", "loops", "task_id"]);
  assert.equal(statusResult.authority, "afl_sqlite");
  assert.equal(statusResult.loops.length, 1);
  assert.equal(statusResult.loops[0].failure_count, 1);
  assert.deepEqual(Object.keys(statusResult.loops[0]).sort(), [
    "aliases", "architecture_fix_count", "boundary", "canonical_invariant_id", "decision",
    "failure_count", "fingerprint", "seen_review_run_ids", "status", "task_id"
  ]);
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
