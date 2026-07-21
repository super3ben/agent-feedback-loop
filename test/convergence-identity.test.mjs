import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  deriveTaskUid,
  digestDecisionBasis,
  ensureRepositoryLineage,
  projectContract
} from "../src/convergence-identity.mjs";

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
  return execFileAsync("git", ["-C", cwd, ...args]);
}

async function gitFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "afl-convergence-identity-"));
  await git(["init"], root);
  await git(["config", "user.email", "convergence@example.test"], root);
  await git(["config", "user.name", "Convergence Test"], root);
  await git(["commit", "--allow-empty", "-m", "fixture"], root);
  return { root };
}

async function addLinkedWorktree(root) {
  const linked = await mkdtemp(path.join(tmpdir(), "afl-convergence-linked-"));
  await rm(linked, { recursive: true, force: true });
  await git(["worktree", "add", "--detach", linked, "HEAD"], root);
  return linked;
}

async function removeFixture(root) {
  await rm(root, { recursive: true, force: true });
}

test("linked worktrees share one private lineage while separate clones do not", async (t) => {
  const first = await gitFixture();
  const linked = await addLinkedWorktree(first.root);
  const second = await gitFixture();
  t.after(async () => {
    await removeFixture(first.root);
    await removeFixture(linked);
    await removeFixture(second.root);
  });

  const a = await ensureRepositoryLineage({ repoRoot: first.root });
  const b = await ensureRepositoryLineage({ repoRoot: linked });
  const c = await ensureRepositoryLineage({ repoRoot: second.root });
  assert.equal(a.lineageId, b.lineageId);
  assert.notEqual(a.lineageId, c.lineageId);
  assert.match(a.lineageId, /^[a-f0-9]{64}$/u);
  assert.equal((await lstat(path.join(a.commonDir, "afl-lineage-id"))).mode & 0o777, 0o600);
});

test("inferred requirements remain advisory and cannot raise importance", () => {
  const projected = projectContract({
    sourceKind: "user_request",
    sourceRef: "turn-7",
    sourceRevision: "rev-1",
    requirements: [{ id: "main-chat-safe", authority: "explicit_user" }],
    exclusions: [{ id: "no-scheduler", authority: "approved_spec" }],
    importance: "critical",
    importanceAuthority: "inferred_advisory"
  });
  assert.equal(projected.importance, "routine");
  assert.equal(projected.requirements[0].hard, true);
  assert.equal(projected.exclusions[0].hard, true);
  assert.equal(projected.revision.length, 64);
});

test("task UIDs and decision digests frame values to avoid ambiguous concatenation", () => {
  const lineageId = "a".repeat(64);
  assert.notEqual(
    deriveTaskUid({ lineageId, adapterKind: "ab", nativeTaskId: "c" }),
    deriveTaskUid({ lineageId, adapterKind: "a", nativeTaskId: "bc" })
  );
  assert.equal(
    digestDecisionBasis({ beta: ["x", { z: 1, a: true }], alpha: "value" }),
    digestDecisionBasis({ alpha: "value", beta: ["x", { a: true, z: 1 }] })
  );
});

test("projection rejects unsafe identifiers and retains only known clause authorities", () => {
  assert.throws(() => projectContract({
    sourceKind: "user\u0000request",
    sourceRef: "turn-7",
    sourceRevision: "rev-1"
  }), /invalid_identifier/u);

  const projected = projectContract({
    sourceKind: "user_request",
    sourceRef: "turn-7",
    sourceRevision: "rev-1",
    requirements: [{ id: "advisory", authority: "inferred_advisory" }, { id: "unknown", authority: "unknown" }]
  });
  assert.deepEqual(projected.requirements, [
    { id: "advisory", authority: "inferred_advisory", hard: false },
    { id: "unknown", authority: "inferred_advisory", hard: false }
  ]);
});
