// Test-only safety net for spawned child processes.
//
// Tests spawn helper processes (lock holders, race contenders, hook runs) and
// normally wait for them to exit on their own. When an assertion fails early,
// a timeout fires, or the run is interrupted, that wait never completes and the
// child is left behind. A stub that ignores SIGTERM and holds an idle timer can
// then survive as an orphan indefinitely — one such leak outlived its test by
// ten days before it was noticed.
//
// Every child registered here is force-killed when the test process goes away,
// so forgetting to clean one up costs a warning instead of an orphan.

import { spawn } from "node:child_process";

const tracked = new Set();
let installed = false;

function killTracked(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // The child is already gone, or was never reaped by us; nothing to do.
  }
}

function reapAll() {
  for (const child of tracked) killTracked(child);
  tracked.clear();
}

function installReaper() {
  if (installed) return;
  installed = true;
  process.on("exit", reapAll);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      reapAll();
      process.kill(process.pid, signal);
    });
  }
}

/**
 * Spawn a child process that is guaranteed to be killed when this test process
 * exits. Same signature as `child_process.spawn`.
 */
export function spawnTracked(command, args, options) {
  installReaper();
  const child = spawn(command, args, options);
  tracked.add(child);
  child.once("exit", () => tracked.delete(child));
  return child;
}

/**
 * Force-kill a tracked child now. Safe to call on an already-exited child, so
 * it works as an unconditional `finally` cleanup.
 */
export function killTrackedChild(child) {
  if (!child) return;
  killTracked(child);
  tracked.delete(child);
}

/** Number of live tracked children. Exposed for the helper's own tests. */
export function trackedChildCount() {
  return tracked.size;
}
