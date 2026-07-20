import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { captureObservedSession } from "../src/capture.mjs";
import { initializeControlStore } from "../src/control-store.mjs";
import { BlobKeyProvider, EncryptedBlobStore } from "../src/crypto-store.mjs";
import { pathsFor } from "../src/index.mjs";
import {
  publishReflectionDocument,
  validateReflectionModel
} from "../src/reflection-document.mjs";
import { runReviewJob } from "../src/reviewer-runner.mjs";

const VALID_LESSON = Object.freeze({
  outcome: "lesson",
  final_severity: "Major",
  responsibility: "agent_fault",
  method_class: "requirements_before_architecture",
  family_id: null,
  proposed_family_key: "requirements-before-architecture",
  applies_when: ["changing an existing architecture"],
  facts: ["The prior answer introduced machinery before checking the requirement."],
  user_complaint: "The design became heavier before the requirement was checked.",
  root_cause: "Architecture was selected before validating the smallest value path.",
  class_of_mistake: "solution-first architecture",
  method_changes: ["Audit requirement, prior delivery, evidence, and unmet item before changing architecture."],
  repeated_pattern_evidence: [],
  recurrence_of: []
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function reviewFixture(t, { initialNow = "2026-07-20T00:00:00.000Z" } = {}) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "afl-review-runner-home-")));
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "afl-review-runner-project-")));
  t.after(() => Promise.all([
    rm(home, { recursive: true, force: true }),
    rm(projectDir, { recursive: true, force: true })
  ]));
  const paths = pathsFor(home);
  let currentNow = new Date(initialNow);
  const store = initializeControlStore({ paths, now: () => new Date(currentNow) });
  t.after(() => store.close());
  const blobs = new EncryptedBlobStore({
    root: paths.blobRoot,
    keyProvider: new BlobKeyProvider({ keyRoot: paths.keyRoot })
  });
  let sequence = 0;
  const capture = async ({ role, rawText, referentEventUid = null, sourceTimestamp = null }) => {
    sequence += 1;
    const id = `event-${String(sequence).padStart(2, "0")}`;
    const result = await captureObservedSession({
      store,
      blobs,
      event: {
        event_uid: id,
        session_uid: "session-1",
        cli: "codex",
        project_id: projectDir,
        context_epoch: 1,
        source_namespace: "hook",
        source_id: id,
        source_event_id: id,
        source_offset: sequence,
        capture_source: "prompt_hook",
        native_turn_id: `turn-${sequence}`,
        source_timestamp: sourceTimestamp,
        role,
        referent_event_uid: referentEventUid,
        content_hash: sha256(rawText),
        completeness: "complete"
      },
      rawText
    });
    currentNow = new Date(currentNow.getTime() + 1_000);
    return result.eventUid;
  };
  for (let index = 0; index < 8; index += 1) {
    await capture({ role: index % 2 ? "assistant" : "user", rawText: `prior-${index}` });
  }
  const referentEventUid = await capture({
    role: "assistant",
    rawText: "Prior delivery included token=raw-secret and should be rechecked."
  });
  const sourceEventUid = await capture({
    role: "user",
    rawText: "The previous response ignored the requirement. Authorization: Bearer raw-secret",
    referentEventUid,
    sourceTimestamp: "2026-07-20T08:09:10+08:00"
  });
  await capture({ role: "assistant", rawText: "following-1" });
  await capture({ role: "user", rawText: "following-2" });
  await capture({ role: "assistant", rawText: "following-3-must-not-appear" });
  const candidate = store.createReviewCandidate({
    sourceEventUid,
    referentEventUid,
    sourceIdentity: "codex:session-1:feedback-event-10",
    projectId: projectDir
  });
  return {
    home,
    paths,
    projectDir,
    store,
    blobs,
    jobId: candidate.jobId,
    advance(milliseconds) { currentNow = new Date(currentNow.getTime() + milliseconds); },
    now() { return new Date(currentNow); }
  };
}

async function reflectionFiles(projectDir) {
  try {
    return (await readdir(path.join(projectDir, ".agent", "reflections")))
      .filter((name) => name.endsWith(".md"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

test("runReviewJob commits no_lesson without creating a reflection document", async (t) => {
  const fixture = await reviewFixture(t);
  const result = await runReviewJob({
    ...fixture,
    ownerId: "owner-no-lesson",
    provider: async () => ({ outcome: "no_lesson" })
  });

  assert.deepEqual(result, { outcome: "reviewed_no_lesson", documentPath: null });
  assert.deepEqual(await reflectionFiles(fixture.projectDir), []);
  const job = fixture.store.getReviewJob(fixture.jobId);
  assert.equal(job.state, "reviewed_no_lesson");
  assert.equal(job.published_path, null);
  assert.equal(job.published_sha256, null);
});

test("runReviewJob publishes one stable Markdown document and only updates control state", async (t) => {
  const fixture = await reviewFixture(t);
  let observedContext;
  const result = await runReviewJob({
    ...fixture,
    ownerId: "owner-publish",
    provider: async (context) => {
      observedContext = context;
      return { ...VALID_LESSON };
    }
  });

  assert.equal(result.outcome, "published");
  assert.equal((await reflectionFiles(fixture.projectDir)).length, 1);
  const bytes = await readFile(result.documentPath);
  const job = fixture.store.getReviewJob(fixture.jobId);
  assert.equal(job.state, "published");
  assert.equal(job.published_path, result.documentPath);
  assert.equal(job.published_sha256, sha256(bytes));
  assert.equal(observedContext.job.source_identity, "codex:session-1:feedback-event-10");
  assert.equal(observedContext.source.sourceIdentity, "codex:session-1:feedback-event-10");
  assert.equal(observedContext.source.createdAt, "2026-07-20T00:09:10.000Z");
  assert.equal(observedContext.source.publishedAt, job.created_at);
  assert.equal(observedContext.prior.length, 6);
  assert.equal(observedContext.following.length, 2);
  assert.doesNotMatch(JSON.stringify(observedContext), /raw-secret|encrypted_raw_ref|following-3-must-not-appear/i);
});

test("invalid provider output is retryable with the fixed provider_invalid reason", async (t) => {
  const fixture = await reviewFixture(t);
  await assert.rejects(
    runReviewJob({
      ...fixture,
      ownerId: "owner-invalid",
      provider: async () => ({ outcome: "lesson", invented: "body-must-not-leak" })
    }),
    (error) => error.code === "provider_invalid" && !error.message.includes("body-must-not-leak")
  );
  const job = fixture.store.getReviewJob(fixture.jobId);
  assert.equal(job.state, "retryable");
  assert.equal(job.error_code, "provider_invalid");
  assert.deepEqual(await reflectionFiles(fixture.projectDir), []);
});

test("an existing reflection identity with conflicting bytes is never overwritten", async (t) => {
  const fixture = await reviewFixture(t);
  const job = fixture.store.getReviewJob(fixture.jobId);
  const context = fixture.store.getReviewContext({ jobId: fixture.jobId });
  const source = {
    sourceIdentity: job.source_identity,
    createdAt: context.source.source_timestamp ?? context.source.created_at,
    publishedAt: job.created_at
  };
  const conflictingModel = validateReflectionModel({
    ...VALID_LESSON,
    root_cause: "A different immutable document already owns this reflection identity."
  }, source);
  const conflicting = await publishReflectionDocument({ projectDir: fixture.projectDir, model: conflictingModel });
  const before = await readFile(conflicting.path);

  await assert.rejects(
    runReviewJob({ ...fixture, ownerId: "owner-collision", provider: async () => ({ ...VALID_LESSON }) }),
    (error) => error.code === "publication_collision"
  );
  assert.deepEqual(await readFile(conflicting.path), before);
  assert.equal((await reflectionFiles(fixture.projectDir)).length, 1);
  assert.equal(fixture.store.getReviewJob(fixture.jobId).error_code, "publication_collision");
});

test("a lease expiring during provider work creates no canonical document", async (t) => {
  const fixture = await reviewFixture(t);
  await assert.rejects(
    runReviewJob({
      ...fixture,
      ownerId: "owner-expired",
      leaseMs: 10,
      provider: async () => {
        fixture.advance(11);
        return { ...VALID_LESSON };
      }
    }),
    (error) => error.code === "lease_lost"
  );
  assert.deepEqual(await reflectionFiles(fixture.projectDir), []);
});

test("a stale owner cannot publish after a new owner claims the expired lease", async (t) => {
  const fixture = await reviewFixture(t);
  await assert.rejects(
    runReviewJob({
      ...fixture,
      ownerId: "owner-stale",
      leaseMs: 10,
      provider: async () => {
        fixture.advance(11);
        const replacement = fixture.store.claimReviewJob({
          jobId: fixture.jobId,
          ownerId: "owner-current",
          leaseMs: 30_000
        });
        assert.ok(replacement.job);
        return { ...VALID_LESSON };
      }
    }),
    (error) => error.code === "lease_lost"
  );
  assert.deepEqual(await reflectionFiles(fixture.projectDir), []);
  assert.equal(fixture.store.getReviewJob(fixture.jobId).owner_id, "owner-current");
});

test("a retry adopts identical bytes after a crash following visible publication", async (t) => {
  const fixture = await reviewFixture(t);
  const crashingStore = new Proxy(fixture.store, {
    get(target, property, receiver) {
      if (property === "completeReviewPublished") {
        return () => { throw Object.assign(new Error("simulated process death"), { code: "simulated_crash" }); };
      }
      if (property === "failReviewJob") return () => { throw new Error("process died before failure bookkeeping"); };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  await assert.rejects(runReviewJob({
    ...fixture,
    store: crashingStore,
    ownerId: "owner-crashed",
    leaseMs: 10,
    provider: async () => ({ ...VALID_LESSON })
  }));
  const [visibleName] = await reflectionFiles(fixture.projectDir);
  assert.ok(visibleName);
  const visiblePath = path.join(fixture.projectDir, ".agent", "reflections", visibleName);
  const before = await readFile(visiblePath);

  fixture.advance(30_001);
  const retried = await runReviewJob({
    ...fixture,
    ownerId: "owner-retry",
    provider: async () => ({ ...VALID_LESSON })
  });
  assert.equal(retried.documentPath, visiblePath);
  assert.deepEqual(await readFile(visiblePath), before);
  assert.equal((await reflectionFiles(fixture.projectDir)).length, 1);
  assert.equal(fixture.store.getReviewJob(fixture.jobId).published_sha256, sha256(before));
});
