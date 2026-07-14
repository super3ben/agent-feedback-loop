import { chmod, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProcessWithInput } from "./reviewer-provider.mjs";

export class ReviewerUnavailableError extends Error {}

function validateReceipt(value) {
  if (!value || typeof value !== "object" || value.write_complete !== true
    || typeof value.review_receipt_id !== "string" || typeof value.report_content_id !== "string"
    || typeof value.report_content !== "string" || value.report_content.trim().length < 24
    || !["reviewed", "reviewed_no_lesson"].includes(value.status) || !Array.isArray(value.lessons)) {
    throw new Error("invalid reviewer receipt");
  }
  return value;
}

function reviewerEnvironment(source = process.env) {
  const result = {};
  const allowed = new Set(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]);
  for (const name of String(source.AGENT_FEEDBACK_LOOP_REVIEWER_ENV_ALLOWLIST || "").split(",").map((item) => item.trim()).filter(Boolean)) allowed.add(name);
  for (const name of allowed) {
    if (source[name] !== undefined) result[name] = source[name];
  }
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith("AFL_REVIEW_")) result[name] = value;
  }
  return result;
}

export async function runIsolatedReview({ command, args = [], cwd, timeoutMs = 30_000, env = process.env }) {
  const { stdout } = await runProcessWithInput({ command, args, cwd, env: reviewerEnvironment(env), input: "", timeoutMs });
  return validateReceipt(JSON.parse(stdout));
}

export class ReviewerRunner {
  constructor({ store, mode = "isolated_cli_process", capability = "supported" }) {
    this.store = store;
    this.mode = mode;
    this.capability = capability;
  }

  submit(job) {
    this.store.submitReviewerJob(job);
    if (this.capability !== "supported") return { status: "pending", reason: "reviewer_unavailable" };
    return { status: "pending", reason: "review_due", mode: this.mode };
  }

  claim(jobId, ownerId, leaseUntil, attempt) {
    return this.store.claimReviewerJob(jobId, ownerId, leaseUntil, attempt);
  }

  heartbeat(jobId, ownerId, attempt, leaseEpoch, leaseUntil) {
    return this.store.heartbeatReviewerJob(jobId, ownerId, attempt, leaseEpoch, leaseUntil);
  }

  complete(jobId, ownerId, attempt, leaseEpoch, receiptId) {
    return this.store.completeReviewerJob(jobId, ownerId, attempt, leaseEpoch, receiptId);
  }

  fail(jobId, ownerId, attempt, leaseEpoch, retryable, reasonCode) {
    return this.store.failReviewerJob(jobId, ownerId, attempt, leaseEpoch, retryable, reasonCode);
  }

  async runJob({ jobId, ownerId, command, args = [], review = null, cwd, timeoutMs = 30_000, contextRoot = path.join(cwd, "reviewer-contexts"), promptFile = "", env = process.env }) {
    if (this.capability !== "supported") return { status: "pending", reason: "reviewer_unavailable" };
    const job = this.store.getReviewerJob(jobId);
    if (!job) throw new Error(`reviewer job not found: ${jobId}`);
    const attempt = Number(job.attempt) + 1;
    const lease = this.claim(jobId, ownerId, Date.now() + timeoutMs + 5_000, attempt);
    let contextFile = null;
    try {
      const context = this.store.getReviewerContext(jobId);
      const serializedContext = JSON.stringify(context);
      const maxContextBytes = Number(context.context_limits?.max_serialized_bytes || 512 * 1024);
      if (Buffer.byteLength(serializedContext, "utf8") > maxContextBytes) {
        const error = new Error("bounded reviewer context exceeds the absolute serialized size limit");
        error.code = "reviewer_context_too_large";
        throw error;
      }
      await mkdir(contextRoot, { recursive: true, mode: 0o700 });
      const rootInfo = await lstat(contextRoot);
      if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("reviewer context root must be a real directory");
      if (typeof process.getuid === "function" && rootInfo.uid !== process.getuid()) throw new Error("reviewer context root must be owned by the current user");
      await chmod(contextRoot, 0o700);
      contextFile = path.join(contextRoot, `${jobId}.${lease.lease_epoch}.json`);
      await writeFile(contextFile, serializedContext, { mode: 0o600, flag: "wx" });
      await chmod(contextFile, 0o600);
      const reviewEnv = {
        ...env,
        AFL_REVIEW_JOB_ID: jobId,
        AFL_REVIEW_CONTEXT_FILE: contextFile,
        AFL_REVIEW_PROMPT_FILE: promptFile,
        AFL_REVIEW_SUBMIT_PROTOCOL: "stdout_json_receipt"
      };
      const receipt = review
        ? validateReceipt(await review({ contextFile, promptFile, cwd, timeoutMs, env: reviewerEnvironment(reviewEnv) }))
        : await runIsolatedReview({ command, args, cwd, timeoutMs, env: reviewEnv });
      return this.store.commitReview({ jobId, ownerId, attempt, leaseEpoch: lease.lease_epoch }, receipt);
    } catch (error) {
      try { this.fail(jobId, ownerId, attempt, lease.lease_epoch, true, error.code || "reviewer_failed"); } catch {}
      throw error;
    } finally {
      if (contextFile) await rm(contextFile, { force: true });
    }
  }
}
