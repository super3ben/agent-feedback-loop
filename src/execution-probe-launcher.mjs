import { spawn } from "node:child_process";
import path from "node:path";

const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);
const SAFE_ENV_NAMES = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ"];
const DIGEST = /^[a-f0-9]{64}$/u;

function absolutePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096
    && path.isAbsolute(value) && !value.includes("\0");
}

function safeEnvironment(source) {
  const names = new Set(SAFE_ENV_NAMES);
  for (const name of Object.keys(source || {})) {
    if (/^AFL_REVIEW_[A-Z0-9_]{1,118}$/u.test(name)) names.add(name);
  }
  for (const name of String(source?.AGENT_FEEDBACK_LOOP_REVIEWER_ENV_ALLOWLIST || "")
    .split(",").map((item) => item.trim())
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name))) names.add(name);
  const result = {};
  for (const name of names) {
    if (typeof source?.[name] === "string" && Buffer.byteLength(source[name], "utf8") <= 16_384) {
      result[name] = source[name];
    }
  }
  return result;
}

export function launchDetachedExecutionProbe({
  platform,
  nodeExecutable,
  cliFile,
  home,
  monitorId,
  reservationEpoch,
  spawnImpl = spawn,
  env = process.env
} = {}) {
  if (!SUPPORTED_PLATFORMS.has(platform)) return { attempted: false, reason: "unsupported_platform" };
  if (!absolutePath(nodeExecutable) || !absolutePath(cliFile) || !absolutePath(home)
      || !DIGEST.test(monitorId) || !Number.isSafeInteger(reservationEpoch) || reservationEpoch < 1
      || typeof spawnImpl !== "function") return { attempted: false, reason: "invalid_input" };
  try {
    const child = spawnImpl(nodeExecutable, [
      cliFile,
      "execution-probe-run",
      "--home", home,
      "--monitor-id", monitorId,
      "--reservation-epoch", String(reservationEpoch)
    ], {
      cwd: path.dirname(cliFile),
      detached: true,
      stdio: "ignore",
      env: safeEnvironment(env),
      windowsHide: true
    });
    if (!child || typeof child.unref !== "function") return { attempted: false, reason: "spawn_failed" };
    if (typeof child.once === "function") child.once("error", () => {});
    child.unref();
    return { attempted: true, reason: "spawn_attempted" };
  } catch {
    return { attempted: false, reason: "spawn_failed" };
  }
}
