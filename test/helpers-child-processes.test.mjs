import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";

import { killTrackedChild, spawnTracked, trackedChildCount } from "./helpers/child-processes.mjs";

// A child that ignores SIGTERM/SIGINT and idles forever — the exact shape that
// leaked as a ten-day orphan. killTrackedChild must reap it with SIGKILL.
const STUBBORN_CHILD = `
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  process.stdout.write("ready\\n");
  setInterval(() => {}, 1000);
`;

test("killTrackedChild SIGKILLs a child that ignores SIGTERM", async () => {
  const before = trackedChildCount();
  const child = spawnTracked(process.execPath, ["-e", STUBBORN_CHILD], {
    stdio: ["ignore", "pipe", "ignore"]
  });
  const [ready] = await once(child.stdout, "data");
  assert.match(String(ready), /ready/u);
  assert.equal(trackedChildCount(), before + 1, "child should be tracked while alive");

  const exit = once(child, "exit");
  killTrackedChild(child);
  const [code, signal] = await exit;
  assert.equal(code, null, "SIGKILL leaves no exit code");
  assert.equal(signal, "SIGKILL");
  assert.equal(trackedChildCount(), before, "reaped child should be untracked");
});

test("killTrackedChild is a no-op on an already-exited child", async () => {
  const child = spawnTracked(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore"
  });
  await once(child, "exit");
  // Must not throw even though the child is already gone and untracked.
  killTrackedChild(child);
  killTrackedChild(null);
});
