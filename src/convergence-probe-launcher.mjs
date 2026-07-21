import { spawn } from "node:child_process";
import path from "node:path";

const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);
const SAFE_ENV_NAMES = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ"];
const MAX_PATH_BYTES = 4_096;
const MAX_ENV_VALUE_BYTES = 16 * 1_024;
const MAX_EXTRA_ENV_NAMES = 64;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function absolutePath(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= MAX_PATH_BYTES && path.isAbsolute(value);
}

function identifier(value) {
  return typeof value === "string" && ID.test(value);
}

function safeProbeEnvironment(source) {
  const input = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  const names = new Set(SAFE_ENV_NAMES);
  let extraNames = 0;
  const add = (name) => {
    if (names.has(name) || extraNames >= MAX_EXTRA_ENV_NAMES) return;
    names.add(name);
    extraNames += 1;
  };
  for (const name of Object.keys(input)) {
    if (/^AFL_REVIEW_[A-Z0-9_]{1,118}$/u.test(name)) add(name);
  }
  for (const name of String(input.AGENT_FEEDBACK_LOOP_REVIEWER_ENV_ALLOWLIST || "")
    .split(",").map((item) => item.trim())
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name))) {
    add(name);
  }
  const result = {};
  for (const name of names) {
    if (typeof input[name] === "string"
        && Buffer.byteLength(input[name], "utf8") <= MAX_ENV_VALUE_BYTES) {
      result[name] = input[name];
    }
  }
  return result;
}

export function launchDetachedConvergenceProbe({
  platform,
  nodeExecutable,
  cliFile,
  home,
  taskUid,
  fingerprint,
  spawnImpl = spawn,
  env = process.env
} = {}) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    return { attempted: false, reason: "unsupported_platform" };
  }
  if (!absolutePath(nodeExecutable) || !absolutePath(cliFile) || !absolutePath(home)
      || !identifier(taskUid) || !identifier(fingerprint) || typeof spawnImpl !== "function") {
    return { attempted: false, reason: "invalid_input" };
  }
  try {
    const child = spawnImpl(nodeExecutable, [
      cliFile,
      "convergence-probe-run",
      "--home", home,
      "--task-uid", taskUid,
      "--fingerprint", fingerprint
    ], {
      cwd: path.dirname(cliFile),
      detached: true,
      stdio: "ignore",
      env: safeProbeEnvironment(env),
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
