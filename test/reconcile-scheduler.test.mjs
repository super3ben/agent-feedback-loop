import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createLaunchdSchedulerHost,
  inspectReconcileScheduler,
  installReconcileScheduler,
  removeReconcileScheduler
} from "../src/reconcile-scheduler.mjs";
import { pathsFor } from "../src/index.mjs";

test("macOS scheduler keeps a lightweight reconciliation daemon alive", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-scheduler-"));
  const paths = pathsFor(home);
  const calls = [];
  const host = {
    install: async (input) => { calls.push(["install", input]); return { active: true }; },
    inspect: async () => ({ active: true }),
    remove: async (input) => { calls.push(["remove", input]); return { active: false }; }
  };

  const installed = await installReconcileScheduler({ paths, platform: "darwin", activate: true, host });
  assert.equal(installed.configured, true);
  assert.equal(installed.active, true);
  const plist = await readFile(paths.reconcileLaunchAgent, "utf8");
  assert.doesNotMatch(plist, /<key>StartInterval<\/key>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, new RegExp(paths.runtimeLauncher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(plist, /<string>reconcile-daemon<\/string>/);
  assert.match(plist, /AGENT_FEEDBACK_LOOP_RECONCILE_INTERVAL/);
  assert.equal(calls[0][0], "install");

  const health = await inspectReconcileScheduler({ paths, platform: "darwin", host });
  assert.deepEqual(health, { supported: true, configured: true, active: true, state: "running" });

  await removeReconcileScheduler({ paths, platform: "darwin", activate: true, host });
  assert.equal(calls.at(-1)[0], "remove");
  assert.equal((await inspectReconcileScheduler({ paths, platform: "darwin", host })).configured, false);
});

test("launchd inspection distinguishes a loaded idle job from a running daemon", async () => {
  const idle = createLaunchdSchedulerHost({ run: async () => ({ stdout: "state = not running\nactive count = 0\n" }) });
  const running = createLaunchdSchedulerHost({ run: async () => ({ stdout: "state = running\nactive count = 1\n" }) });
  assert.deepEqual(await idle.inspect({ label: "test" }), { active: false, state: "loaded_idle" });
  assert.deepEqual(await running.inspect({ label: "test" }), { active: true, state: "running" });
});

test("launchd install retries bootstrap while a prior KeepAlive service is still tearing down", async () => {
  const calls = [];
  let bootstrapAttempts = 0;
  const host = createLaunchdSchedulerHost({
    sleep: async () => {},
    run: async (_command, args) => {
      calls.push(args);
      if (args[0] === "bootstrap" && ++bootstrapAttempts < 3) {
        const error = new Error("Bootstrap failed: 5: Input/output error");
        error.code = 5;
        throw error;
      }
      return { stdout: "" };
    }
  });

  assert.deepEqual(await host.install({ plistFile: "/tmp/test.plist", label: "test" }), { active: true });
  assert.equal(bootstrapAttempts, 3);
  assert.equal(calls.filter((args) => args[0] === "bootout").length, 1);
  assert.equal(calls.filter((args) => args[0] === "kickstart").length, 1);
});

test("unsupported platforms remain hook-capable without pretending a scheduler exists", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-scheduler-unsupported-"));
  const paths = pathsFor(home);
  const result = await installReconcileScheduler({ paths, platform: "linux" });
  assert.deepEqual(result, { supported: false, configured: false, active: false, reason: "unsupported_platform" });
});
