import { spawn } from "node:child_process";
import path from "node:path";

const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);
const SAFE_ENV_NAMES = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ"];
const MAX_PATH_BYTES = 4_096;
const MAX_JOB_ID_BYTES = 512;
const MAX_EXTRA_ENV_NAMES = 64;
const MAX_ENV_VALUE_BYTES = 16 * 1_024;
const REVIEW_LAUNCH_COOLDOWN_MS = 5_000;

function boundedString(value, maxBytes) {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function validAbsolutePath(value) {
  return boundedString(value, MAX_PATH_BYTES) && path.isAbsolute(value);
}

function validJobId(value) {
  return boundedString(value, MAX_JOB_ID_BYTES) && value === value.trim();
}

function safeEnvironment(source) {
  const input = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  const names = new Set(SAFE_ENV_NAMES);
  let extraNames = 0;
  const addExtraName = (name) => {
    if (names.has(name)) return;
    if (extraNames >= MAX_EXTRA_ENV_NAMES) return;
    names.add(name);
    extraNames += 1;
  };
  for (const name of Object.keys(input)) {
    if (name.startsWith("AFL_REVIEW_") && /^[A-Z0-9_]{1,128}$/.test(name)) addExtraName(name);
  }
  const explicit = String(input.AGENT_FEEDBACK_LOOP_REVIEWER_ENV_ALLOWLIST || "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name));
  for (const name of explicit) addExtraName(name);

  const result = {};
  for (const name of names) {
    const value = input[name];
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_ENV_VALUE_BYTES) continue;
    result[name] = value;
  }
  return result;
}

function safeReason(value) {
  const reason = String(value || "").toLowerCase();
  return /^[a-z0-9_.-]{1,128}$/.test(reason) ? reason : "spawn_failed";
}

export function launchDetachedReviewer({
  platform,
  nodeExecutable,
  cliFile,
  home,
  jobId,
  launchEpoch,
  spawnImpl = spawn,
  env = process.env
} = {}) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    return { attempted: false, reason: "unsupported_platform" };
  }
  if (!validAbsolutePath(nodeExecutable)
      || !validAbsolutePath(cliFile)
      || !validAbsolutePath(home)
      || !validJobId(jobId)
      || !Number.isSafeInteger(launchEpoch)
      || launchEpoch < 1
      || typeof spawnImpl !== "function") {
    return { attempted: false, reason: "invalid_input" };
  }

  try {
    const child = spawnImpl(nodeExecutable, [
      cliFile,
      "reviewer-run",
      "--home",
      home,
      "--job-id",
      jobId
    ], {
      cwd: path.dirname(cliFile),
      detached: true,
      stdio: "ignore",
      env: safeEnvironment(env),
      windowsHide: true
    });
    if (!child || typeof child.unref !== "function") {
      return { attempted: false, reason: "spawn_failed" };
    }
    if (typeof child.once === "function") child.once("error", () => {});
    child.unref();
    return { attempted: true, reason: "spawn_attempted" };
  } catch {
    return { attempted: false, reason: "spawn_failed" };
  }
}

export function recoverDueReviewers({ store, launchReviewer, limit = 1 } = {}) {
  const effectiveLimit = Number.isInteger(limit) && limit > 0 ? 1 : 0;
  if (!effectiveLimit || !store || typeof launchReviewer !== "function") {
    return { scanned: 0, attempted: 0 };
  }

  let due;
  try {
    due = store.listRecoverableReviewJobs({ limit: effectiveLimit });
  } catch {
    return { scanned: 0, attempted: 0 };
  }
  const job = Array.isArray(due) ? due[0] : null;
  if (!job) return { scanned: 0, attempted: 0 };

  let reservation;
  try {
    reservation = store.reserveReviewLaunch({
      jobId: job.job_id,
      cooldownMs: REVIEW_LAUNCH_COOLDOWN_MS
    });
  } catch {
    return { scanned: 1, attempted: 0 };
  }
  if (!reservation?.launch) return { scanned: 1, attempted: 0 };

  let failureReason = null;
  try {
    const result = launchReviewer(job.job_id, reservation.launchEpoch);
    if (result?.attempted === false) failureReason = safeReason(result.reason);
  } catch {
    failureReason = "spawn_failed";
  }
  if (failureReason) {
    try {
      store.recordReviewLaunchFailure({
        jobId: job.job_id,
        launchEpoch: reservation.launchEpoch,
        reasonCode: failureReason
      });
    } catch {}
  }
  return { scanned: 1, attempted: 1 };
}
