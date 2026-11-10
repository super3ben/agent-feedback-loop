import { Worker } from "node:worker_threads";

// A detached reviewer that finishes its work but never exits keeps a whole core
// at 99% and ~127MB resident until someone notices. Five such processes ran for
// nineteen hours on one machine — their jobs had all reached "published", so the
// work was over and only the process remained.
//
// The existing provider timeout cannot catch this: it is a `setTimeout` on the
// main thread, and the shape that hangs is a flood of promise microtasks, which
// starve the timer queue entirely (sampled stack: repeated Array.prototype.join
// inside a FileHandle close callback). Anything that lives on the stalled thread
// is unreachable by definition, so the deadline has to live on a second one.
//
// A worker thread has its own event loop, so it keeps running while the main
// thread is stuck. On expiry it signals the whole process — SIGTERM first in
// case anything is still able to handle it, then SIGKILL, which cannot be
// ignored. This is a floor under every other timeout, not a replacement for
// them: the provider timeout still produces the ordinary error path, and this
// only fires when that path itself is unreachable.

const WATCHDOG_SOURCE = `
  const { parentPort, workerData } = require("node:worker_threads");
  const { pid, hardCapMs, graceMs } = workerData;
  const signal = (name) => {
    try { process.kill(pid, name); } catch {}
  };
  const term = setTimeout(() => signal("SIGTERM"), hardCapMs);
  const kill = setTimeout(() => signal("SIGKILL"), hardCapMs + graceMs);
  if (typeof term.unref === "function") term.unref();
  if (typeof kill.unref === "function") kill.unref();
  parentPort.on("message", (message) => {
    if (message === "stop") {
      clearTimeout(term);
      clearTimeout(kill);
    }
  });
`;

/**
 * Runs `fn` (or returns immediately when no deadline applies) under a hard
 * wall-clock cap enforced from a separate thread.
 *
 * Returns `{ stop }` so a normal, well-behaved caller can release the watchdog
 * and let its process exit as usual.
 */
export function startProcessWatchdog({
  hardCapMs,
  graceMs = 5_000,
  pid = process.pid,
  workerFactory = (source, options) => new Worker(source, options)
} = {}) {
  if (!Number.isSafeInteger(hardCapMs) || hardCapMs <= 0) {
    return { stop() {}, active: false };
  }
  let worker;
  try {
    worker = workerFactory(WATCHDOG_SOURCE, {
      eval: true,
      workerData: { pid, hardCapMs, graceMs },
      stdout: true,
      stderr: true
    });
  } catch {
    // A watchdog that cannot start must not break the run it guards.
    return { stop() {}, active: false };
  }
  if (typeof worker?.unref === "function") worker.unref();
  if (typeof worker?.on === "function") worker.on("error", () => {});
  let stopped = false;
  return {
    active: true,
    stop() {
      if (stopped) return;
      stopped = true;
      try { worker.postMessage("stop"); } catch {}
      try { worker.terminate?.(); } catch {}
    }
  };
}

/**
 * The deadline for a detached job. The provider timeout bounds the model call;
 * this adds room for the work around it (claim, context build, publish) without
 * leaving a runaway process unbounded.
 */
export function hardCapFor(timeoutMs, { floorMs = 240_000, graceMs = 300_000 } = {}) {
  const base = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : floorMs;
  return Math.max(floorMs, base + graceMs);
}
