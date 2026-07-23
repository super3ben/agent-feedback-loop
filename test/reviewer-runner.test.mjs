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
  parseReflectionMarkdown,
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

async function reviewFixture(t, {
  initialNow = "2030-07-20T00:00:00.000Z",
  sourceTimestamp = "2026-07-20T08:09:10+08:00",
  sourceRawText = "The previous response ignored the requirement. Authorization: Bearer raw-secret",
  candidateReasonCode
} = {}) {
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
    rawText: sourceRawText,
    referentEventUid,
    sourceTimestamp
  });
  await capture({ role: "assistant", rawText: "following-1" });
  await capture({ role: "user", rawText: "following-2" });
  await capture({ role: "assistant", rawText: "following-3-must-not-appear" });
  const candidate = store.createReviewCandidate({
    sourceEventUid,
    referentEventUid,
    sourceIdentity: "codex:session-1:feedback-event-10",
    projectId: projectDir,
    ...(candidateReasonCode ? { reasonCode: candidateReasonCode } : {})
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

async function publishPriorSameFamily(fixture) {
  const model = validateReflectionModel({ ...VALID_LESSON }, {
    sourceIdentity: "codex:session-prior:feedback-prior",
    createdAt: "2026-07-20T00:00:04.000Z",
    publishedAt: "2026-07-20T00:00:05.000Z"
  });
  const published = await publishReflectionDocument({ projectDir: fixture.projectDir, model });
  return { model, published };
}

function sameFamilyLesson(model, overrides = {}) {
  return {
    ...VALID_LESSON,
    family_id: model.family_id,
    proposed_family_key: null,
    recurrence_of: [model.reflection_id],
    ...overrides
  };
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

test("same family after emission is negative evidence", async (t) => {
  const fixture = await reviewFixture(t, { sourceTimestamp: "2030-07-20T01:00:00.000Z" });
  const prior = await publishPriorSameFamily(fixture);
  const emissionId = fixture.store.recordReflectionSelected({
    document: {
      path: prior.published.path,
      documentHash: prior.published.sha256,
      familyId: prior.model.family_id
    },
    familyId: prior.model.family_id,
    sessionUid: "codex:default:prior-session",
    contextEpoch: 1,
    taskFingerprint: "prior-task"
  });
  fixture.store.markReflectionEmitted({ emissionId });
  const emission = fixture.store.getReflectionEmission(emissionId);
  const providerEvidence = Array.from({ length: 8 }, (_, index) => `provider recurrence evidence ${index}`);
  let providerContext;

  const result = await runReviewJob({
    ...fixture,
    ownerId: "owner-recurrence-after-emission",
    provider: async (context) => {
      providerContext = context;
      return sameFamilyLesson(prior.model, { repeated_pattern_evidence: providerEvidence });
    }
  });

  assert.equal(
    providerContext.reflectionCatalog.find((entry) => entry.reflectionId === prior.model.reflection_id).sha256,
    prior.published.sha256,
    "the reviewer catalog must carry the exact-byte hash loaded by the controller"
  );
  const parsed = parseReflectionMarkdown(await readFile(result.documentPath, "utf8"), { path: result.documentPath });
  assert.equal(parsed.effectiveness, "recurrence_after_emission");
  assert.equal(parsed.repeatedPatternEvidence.length, 8, "controller evidence must preserve the existing bound");
  assert.deepEqual(parsed.repeatedPatternEvidence.slice(0, 7), providerEvidence.slice(0, 7));
  const controllerEntry = JSON.parse(parsed.repeatedPatternEvidence.at(-1));
  assert.deepEqual(controllerEntry, {
    family_id: prior.model.family_id,
    document_sha256: prior.published.sha256,
    emitted_at: emission.emitted_at
  });
  assert.deepEqual(Object.keys(controllerEntry), ["family_id", "document_sha256", "emitted_at"]);
});

test("absence of recurrence remains unknown when publication has no emission", async (t) => {
  const fixture = await reviewFixture(t);
  const prior = await publishPriorSameFamily(fixture);
  const providerEvidence = ["provider catalog establishes ordinary same-family recurrence"];

  const result = await runReviewJob({
    ...fixture,
    ownerId: "owner-recurrence-without-emission",
    provider: async () => sameFamilyLesson(prior.model, {
      repeated_pattern_evidence: providerEvidence
    })
  });

  const parsed = parseReflectionMarkdown(await readFile(result.documentPath, "utf8"), { path: result.documentPath });
  assert.equal(parsed.effectiveness, "unknown");
  assert.deepEqual(parsed.repeatedPatternEvidence, providerEvidence);
  assert.equal(fixture.store.findPriorFamilyEmission({
    familyId: prior.model.family_id,
    before: "2030-07-20T00:09:10.000Z"
  }), null);
});

for (const { name, sourceRawText, secret, normalText } of [
  {
    name: "English natural-language assignment",
    sourceRawText: "The previous response ignored the requirement. The password is SyntheticOnly-456+ for this test",
    secret: "SyntheticOnly-456+",
    normalText: "The previous response ignored the requirement."
  },
  {
    name: "Chinese natural-language assignment",
    sourceRawText: "上次回答没有遵守要求。服务器密码是 SyntheticOnly-123+ 请直接连接",
    secret: "SyntheticOnly-123+",
    normalText: "上次回答没有遵守要求。"
  },
  {
    name: "reminder-style credential context",
    sourceRawText: "The previous response ignored the requirement. The password was already shared for operator SyntheticReminder-842+",
    secret: "SyntheticReminder-842+",
    normalText: "The previous response ignored the requirement."
  }
]) {
  test(`encrypted reviewer context redacts ${name}`, async (t) => {
    const fixture = await reviewFixture(t, { sourceRawText });
    let observedContext;

    await runReviewJob({
      ...fixture,
      ownerId: `owner-redaction-${name}`,
      provider: async (context) => {
        observedContext = context;
        return { outcome: "no_lesson" };
      }
    });

    assert.ok(observedContext);
    assert.doesNotMatch(observedContext.source.text, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(observedContext.source.text, /\[REDACTED\]/);
    assert.match(observedContext.source.text, new RegExp(normalText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
}

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

test("publication renews the owner lease at the visibility fence", async (t) => {
  const fixture = await reviewFixture(t);
  let renewalCount = 0;
  let assertionCount = 0;
  const timedStore = new Proxy(fixture.store, {
    get(target, property, receiver) {
      if (property === "renewReviewLease") {
        return (input) => {
          renewalCount += 1;
          const renewed = target.renewReviewLease(input);
          fixture.advance(renewalCount === 1 ? 29_990 : 20);
          return renewed;
        };
      }
      if (property === "assertReviewLease") {
        return (input) => {
          assertionCount += 1;
          const asserted = target.assertReviewLease(input);
          if (renewalCount === 1 && assertionCount === 2) fixture.advance(20);
          return asserted;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  const result = await runReviewJob({
    ...fixture,
    store: timedStore,
    ownerId: "owner-visibility-fence",
    provider: async () => ({ ...VALID_LESSON })
  });

  assert.equal(result.outcome, "published");
  assert.equal(renewalCount, 2);
  assert.equal((await reflectionFiles(fixture.projectDir)).length, 1);
});

test("an expired owner loses callback renewal before any canonical file is visible", async (t) => {
  const fixture = await reviewFixture(t);
  let renewalCount = 0;
  let assertionCount = 0;
  const expiredStore = new Proxy(fixture.store, {
    get(target, property, receiver) {
      if (property === "renewReviewLease") {
        return (input) => {
          renewalCount += 1;
          return target.renewReviewLease(input);
        };
      }
      if (property === "assertReviewLease") {
        return (input) => {
          assertionCount += 1;
          const asserted = target.assertReviewLease(input);
          if (assertionCount === 1) fixture.advance(30_001);
          return asserted;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  await assert.rejects(
    runReviewJob({
      ...fixture,
      store: expiredStore,
      ownerId: "owner-expired-at-fence",
      provider: async () => ({ ...VALID_LESSON })
    }),
    (error) => error.code === "lease_lost"
  );

  assert.equal(renewalCount, 2);
  assert.deepEqual(await reflectionFiles(fixture.projectDir), []);
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

test("semantic gate stops the job before full reviewer when candidate is expanded but not real dissatisfaction", async (t) => {
  const fixture = await reviewFixture(t, { candidateReasonCode: "expanded_feedback" });
  const calls = [];
  const result = await runReviewJob({
    ...fixture,
    ownerId: "reviewer-gate-no-dissatisfaction",
    provider: async (_context, { resultKind }) => {
      calls.push(resultKind);
      if (resultKind === "semantic_dissatisfaction_gate") {
        return { is_dissatisfaction: false, confidence: "high", reason_class: "not_dissatisfaction" };
      }
      throw new Error("full reviewer should not run");
    }
  });

  assert.deepEqual(calls, ["semantic_dissatisfaction_gate"]);
  assert.equal(result.outcome, "reviewed_no_lesson");
  assert.equal(result.documentPath, null);
  const job = fixture.store.getReviewJob(fixture.jobId);
  assert.equal(job.state, "reviewed_no_lesson");
});

test("existing explicit dissatisfaction path still reaches the full reviewer directly", async (t) => {
  const fixture = await reviewFixture(t);
  const calls = [];
  await runReviewJob({
    ...fixture,
    ownerId: "reviewer-explicit-hit",
    provider: async (_context, { resultKind }) => {
      calls.push(resultKind);
      if (resultKind === "reviewer") return { outcome: "no_lesson" };
      throw new Error("semantic gate should be bypassed for explicit hits");
    }
  });

  assert.deepEqual(calls, ["reviewer"]);
  const job = fixture.store.getReviewJob(fixture.jobId);
  assert.equal(job.state, "reviewed_no_lesson");
});
