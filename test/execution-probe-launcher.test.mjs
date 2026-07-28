import assert from "node:assert/strict";
import { test } from "node:test";

import { launchDetachedExecutionProbe } from "../src/execution-probe-launcher.mjs";

test("execution Probe launcher passes only opaque fenced identity to a detached child", () => {
  const calls = [];
  const result = launchDetachedExecutionProbe({
    platform: "darwin",
    nodeExecutable: "/opt/node",
    cliFile: "/opt/agent-feedback-loop.mjs",
    home: "/private/disposable-home",
    monitorId: "a".repeat(64),
    reservationEpoch: 4,
    env: {
      HOME: "/private/disposable-home",
      PATH: "/usr/bin",
      AFL_REVIEW_CANARY: "bounded",
      PRIVATE_TRANSCRIPT: "/private/transcript.jsonl"
    },
    spawnImpl(...args) {
      calls.push(args);
      return { once() {}, unref() {} };
    }
  });

  assert.deepEqual(result, { attempted: true, reason: "spawn_attempted" });
  assert.deepEqual(calls[0][1], [
    "/opt/agent-feedback-loop.mjs",
    "execution-probe-run",
    "--home", "/private/disposable-home",
    "--monitor-id", "a".repeat(64),
    "--reservation-epoch", "4"
  ]);
  assert.deepEqual(calls[0][2], {
    cwd: "/opt",
    detached: true,
    stdio: "ignore",
    env: { PATH: "/usr/bin", HOME: "/private/disposable-home", AFL_REVIEW_CANARY: "bounded" },
    windowsHide: true
  });
  assert.doesNotMatch(JSON.stringify(calls), /PRIVATE_TRANSCRIPT|transcript\.jsonl/u);
});
