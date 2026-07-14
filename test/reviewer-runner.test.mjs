import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { pathsFor } from "../src/index.mjs";
import { ReviewerRunner, runIsolatedReview } from "../src/reviewer-runner.mjs";
import { openStore } from "../src/store.mjs";

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "afl-reviewer-"));
  const paths = pathsFor(home);
  return openStore({ paths });
}

test("reviewer runner owns the job lifecycle and rejects stale completion", async () => {
  const store = await fixture();
  const runner = new ReviewerRunner({ store, mode: "isolated_cli_process" });
  runner.submit({ job_id: "job-1", project_id: "project-a", prompt_version: "v1" });
  const lease = runner.claim("job-1", "worker-a", Date.now() + 10_000, 1);
  assert.equal(lease.lease_epoch, 1);
  assert.throws(() => runner.complete("job-1", "worker-b", 1, 1, "receipt"), /lease|stale/i);
  runner.complete("job-1", "worker-a", 1, lease.lease_epoch, "receipt");
  store.close();
});

test("isolated reviewer accepts only a bounded structured receipt", async () => {
  const result = await runIsolatedReview({
    command: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify({write_complete:true,review_receipt_id:'r1',report_content_id:'report-1',report_content:'No durable lesson was proven from the bounded evidence.',status:'reviewed_no_lesson',lessons:[]}))"],
    cwd: process.cwd(),
    timeoutMs: 2_000
  });
  assert.equal(result.write_complete, true);
  assert.equal(result.review_receipt_id, "r1");
});

test("isolated reviewer rejects a nominal receipt with an empty report", async () => {
  await assert.rejects(() => runIsolatedReview({
    command: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify({write_complete:true,review_receipt_id:'r-empty',report_content_id:'report-empty',report_content:'',status:'reviewed_no_lesson',lessons:[]}))"],
    cwd: process.cwd(),
    timeoutMs: 2_000
  }), /invalid reviewer receipt|report/i);
});

test("runJob executes a short-lived reviewer and commits its structured receipt", async () => {
  const store = await fixture();
  store.captureSessionEvent({ event_uid: "runner-user", session_uid: "runner-session", event_seq: 1, context_epoch: 1, project_id: "project-a", source_event_id: "runner-user", role: "user", redacted_text: "the previous answer was wrong", content_hash: "runner-user-hash", capture_policy_revision: 1, data_class: "normal", capture_source: "prompt_hook", capture_completeness: "prompt_only" });
  store.captureSessionEvent({ event_uid: "runner-assistant", session_uid: "runner-session", event_seq: 2, context_epoch: 1, project_id: "project-a", source_event_id: "runner-assistant", role: "assistant", redacted_text: "unsupported claim", content_hash: "runner-assistant-hash", capture_policy_revision: 1, data_class: "normal", capture_source: "stop_payload", capture_completeness: "partial" });
  const job = store.submitDueReview({ projectId: "project-a", minEntries: 1, cooldownMs: 0 });
  const runner = new ReviewerRunner({ store, mode: "isolated_cli_process" });
  const result = await runner.runJob({
    jobId: job.job_id,
    ownerId: "worker-run",
    command: process.execPath,
    args: ["-e", "const fs=require('fs'); const c=JSON.parse(fs.readFileSync(process.env.AFL_REVIEW_CONTEXT_FILE,'utf8')); if(process.env.AFL_REVIEW_JOB_ID!==c.job.job_id||!c.events.some(e=>e.role==='assistant')||process.env.AFL_TEST_SECRET) process.exit(9); process.stdout.write(JSON.stringify({write_complete:true,review_receipt_id:'r-run',report_content_id:'report-run',report_content:'The bounded evidence did not prove a durable reusable lesson.',status:'reviewed_no_lesson',lessons:[]}))"],
    cwd: process.cwd(),
    timeoutMs: 2_000,
    contextRoot: path.join(tmpdir(), "afl-review-contexts"),
    env: { ...process.env, AFL_TEST_SECRET: "must-not-reach-reviewer" }
  });
  assert.equal(result.status, "completed");
  store.close();
});

test("context preparation failure returns the claimed reviewer job to pending", async () => {
  const store = await fixture();
  store.captureSessionEvent({ event_uid: "prep-user", session_uid: "prep-session", event_seq: 1, context_epoch: 1, project_id: "project-prep", source_event_id: "prep-user", role: "user", redacted_text: "previous output was wrong", content_hash: "prep-hash", capture_policy_revision: 1, data_class: "normal" });
  const job = store.submitDueReview({ projectId: "project-prep", minEntries: 1, cooldownMs: 0 });
  const blockedRoot = path.join(await mkdtemp(path.join(tmpdir(), "afl-context-blocked-")), "not-a-directory");
  await writeFile(blockedRoot, "file", { mode: 0o600 });
  const runner = new ReviewerRunner({ store });
  await assert.rejects(() => runner.runJob({
    jobId: job.job_id,
    ownerId: "worker-prep",
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    cwd: process.cwd(),
    contextRoot: path.join(blockedRoot, "child")
  }));
  assert.equal(store.getReviewerJob(job.job_id).status, "pending");
  assert.equal(store.submitDueReview({ projectId: "project-prep", minEntries: 1, cooldownMs: 0 }).status, "pending");
  store.close();
});

test("runJob can invoke a built-in isolated provider without shelling through a main-session prompt", async () => {
  const store = await fixture();
  store.captureSessionEvent({ event_uid: "provider-user", session_uid: "provider-session", event_seq: 1, context_epoch: 1, project_id: "project-provider", source_event_id: "provider-user", role: "user", redacted_text: "the previous behavior was wrong", content_hash: "provider-hash", capture_policy_revision: 1, data_class: "normal" });
  const job = store.submitDueReview({ projectId: "project-provider", minEntries: 1, cooldownMs: 0 });
  const runner = new ReviewerRunner({ store, mode: "isolated_cli_process" });
  let called = 0;
  const result = await runner.runJob({
    jobId: job.job_id,
    ownerId: "worker-provider",
    cwd: process.cwd(),
    timeoutMs: 2_000,
    contextRoot: path.join(tmpdir(), "afl-provider-contexts"),
    promptFile: "/tmp/reflection-agent.md",
    review: async ({ contextFile, promptFile, env, timeoutMs }) => {
      called += 1;
      assert.equal(promptFile, "/tmp/reflection-agent.md");
      assert.equal(env.AFL_REVIEW_JOB_ID, job.job_id);
      assert.equal(env.AFL_REVIEW_CONTEXT_FILE, contextFile);
      assert.equal(timeoutMs, 2_000);
      return {
        write_complete: true,
        review_receipt_id: "provider-receipt",
        report_content_id: "provider-report",
        report_content: "No proven retrospective feedback.",
        status: "reviewed_no_lesson",
        lessons: []
      };
    }
  });
  assert.equal(called, 1);
  assert.equal(result.status, "completed");
  store.close();
});

test("unsupported native mode is explicit and never falls back", async () => {
  const store = await fixture();
  const runner = new ReviewerRunner({ store, mode: "native_background_agent", capability: "unavailable" });
  const result = runner.submit({ job_id: "job-2", project_id: "project-a", prompt_version: "v1" });
  assert.deepEqual(result, { status: "pending", reason: "reviewer_unavailable" });
  store.close();
});
