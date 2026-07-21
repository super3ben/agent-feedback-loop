import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { main } from "../src/cli.mjs";
import { launchDetachedConvergenceProbe } from "../src/convergence-probe-launcher.mjs";
import { runConvergenceProbeJob } from "../src/convergence-probe-runner.mjs";

const DIGEST = "a".repeat(64);
const RESULT = Object.freeze({
  assessment: "overdesigned",
  action: "simplify_current_generation",
  unmet_user_value: "No user-visible convergence protection is missing",
  wrong_assumption: "A resident scheduler is needed",
  unnecessary_scope: ["resident scheduler"],
  minimal_next_step: "Use the existing detached one-shot provider",
  falsification_test: "Demonstrate an unlaunchable candidate without a resident process"
});

function status(overrides = {}) {
  return {
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    boundaryId: "task-5",
    canonicalInvariantId: "probe-isolation",
    status: "probe_running",
    failureCount: 1,
    currentGeneration: 2,
    fixGenerations: [1, 2],
    decisionBasisDigest: DIGEST,
    decision: "reflection_required",
    directionGeneration: 0,
    aliases: [],
    activeGrantId: "must-not-reach-provider",
    probeKind: "convergence_reflection",
    probeState: "running",
    probeAttempt: 1,
    probeOwnerId: "probe-owner-1",
    probeLeaseEpoch: 4,
    probeLeaseUntil: "2099-01-01T00:04:00.000Z",
    probeNextAttemptAt: null,
    probeResultDigest: null,
    version: 7,
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    mainConversation: "must-not-reach-provider",
    hookPrompt: "must-not-reach-provider",
    ...overrides
  };
}

function storeHarness({ completeError = null, failError = null } = {}) {
  const calls = [];
  const claimed = status();
  return {
    calls,
    store: {
      claimConvergenceProbe(input) {
        calls.push(["claim", input]);
        return claimed;
      },
      getConvergenceStatus(input) {
        calls.push(["status", input]);
        return status();
      },
      completeConvergenceProbe(input) {
        calls.push(["complete", input]);
        if (completeError) throw completeError;
        return status({ probeState: "completed", probeOwnerId: null });
      },
      failConvergenceProbe(input) {
        calls.push(["fail", input]);
        if (failError) throw failError;
        return status({ probeState: "failed", probeOwnerId: null });
      }
    }
  };
}

test("runner consumes one real Store lease and completes through its owner and epoch fence", async () => {
  const harness = storeHarness();
  let providerCall;

  const result = await runConvergenceProbeJob({
    store: harness.store,
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    ownerId: "probe-owner-1",
    provider: async (...args) => {
      providerCall = args;
      return RESULT;
    }
  });

  assert.deepEqual(result, {
    outcome: "overdesigned",
    action: "simplify_current_generation",
    resultDigest: result.resultDigest
  });
  assert.match(result.resultDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(harness.calls.map(([name]) => name), ["claim", "status", "complete"]);
  assert.deepEqual(
    { ...harness.calls[0][1], eventUid: "<opaque>" },
    {
      eventUid: "<opaque>",
      taskUid: "task-1",
      fingerprint: "fingerprint-1",
      ownerId: "probe-owner-1",
      leaseMs: 240_000
    }
  );
  assert.match(harness.calls[0][1].eventUid, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
  assert.deepEqual(harness.calls[1][1], { taskUid: "task-1", fingerprint: "fingerprint-1" });
  assert.deepEqual(
    { ...harness.calls[2][1], eventUid: "<opaque>", resultDigest: "<digest>" },
    {
      eventUid: "<opaque>",
      taskUid: "task-1",
      fingerprint: "fingerprint-1",
      ownerId: "probe-owner-1",
      leaseEpoch: 4,
      action: "simplify_current_generation",
      resultDigest: "<digest>"
    }
  );
  assert.deepEqual(providerCall[1], { resultKind: "convergence_probe" });
  assert.deepEqual(Object.keys(providerCall[0]), ["status"]);
  assert.equal(providerCall[0].status.decisionBasisDigest, DIGEST);
  assert.equal(providerCall[0].status.failureCount, 1);
  assert.equal(Object.hasOwn(providerCall[0].status, "activeGrantId"), false);
  assert.equal(JSON.stringify(providerCall[0]).includes("must-not-reach-provider"), false);
});

test("runner preserves all six recommendations only as completion advice", async () => {
  const actions = [
    "continue_once",
    "simplify_current_generation",
    "rollback_to_generation",
    "direction_checkpoint",
    "human_decision",
    "finish_now"
  ];
  for (const action of actions) {
    const harness = storeHarness();
    await runConvergenceProbeJob({
      store: harness.store,
      taskUid: "task-1",
      fingerprint: "fingerprint-1",
      ownerId: "probe-owner-1",
      provider: async () => ({ ...RESULT, action })
    });
    const completion = harness.calls.find(([name]) => name === "complete")[1];
    assert.equal(completion.action, action);
    assert.equal(Object.hasOwn(completion, "outcome"), false);
  }
});

test("runner records only one bounded lease-fenced failure and never completes invalid output", async () => {
  const harness = storeHarness();
  const providerError = Object.assign(new Error("sensitive provider output"), {
    code: "reviewer_timeout"
  });

  await assert.rejects(
    runConvergenceProbeJob({
      store: harness.store,
      taskUid: "task-1",
      fingerprint: "fingerprint-1",
      ownerId: "probe-owner-1",
      provider: async () => { throw providerError; }
    }),
    (error) => error === providerError
  );

  assert.deepEqual(harness.calls.map(([name]) => name), ["claim", "status", "fail"]);
  assert.deepEqual(
    { ...harness.calls[2][1], eventUid: "<opaque>" },
    {
      eventUid: "<opaque>",
      taskUid: "task-1",
      fingerprint: "fingerprint-1",
      ownerId: "probe-owner-1",
      leaseEpoch: 4,
      reasonCode: "provider_timeout",
      retryable: true,
      backoffMs: 30_000
    }
  );
  assert.doesNotMatch(JSON.stringify(harness.calls[2][1]), /sensitive/u);
});

test("completion lease loss is propagated without attempting a stale failure write", async () => {
  const lost = Object.assign(new Error("probe_lease_lost"), { code: "probe_lease_lost" });
  const harness = storeHarness({ completeError: lost });

  await assert.rejects(
    runConvergenceProbeJob({
      store: harness.store,
      taskUid: "task-1",
      fingerprint: "fingerprint-1",
      ownerId: "probe-owner-1",
      provider: async () => RESULT
    }),
    (error) => error === lost
  );
  assert.deepEqual(harness.calls.map(([name]) => name), ["claim", "status", "complete"]);
});

test("darwin and linux launcher use one exact detached direct-spawn contract", () => {
  for (const platform of ["darwin", "linux"]) {
    const calls = [];
    const child = {
      once(event, listener) { calls.push(["once", event, typeof listener]); },
      unref() { calls.push(["unref"]); }
    };
    const spawnImpl = (...args) => {
      calls.push(["spawn", ...args]);
      return child;
    };
    const result = launchDetachedConvergenceProbe({
      platform,
      nodeExecutable: "/opt/node/bin/node",
      cliFile: "/opt/afl/bin/agent-feedback-loop.mjs",
      home: "/tmp/afl-home",
      taskUid: "task-1",
      fingerprint: "fingerprint-1",
      spawnImpl,
      env: {
        PATH: "/usr/bin",
        HOME: "/Users/example",
        AFL_REVIEW_TRACE: "opaque",
        AGENT_FEEDBACK_LOOP_REVIEWER_ENV_ALLOWLIST: "AGENT_FEEDBACK_LOOP_CODEX_COMMAND",
        AGENT_FEEDBACK_LOOP_CODEX_COMMAND: "/tmp/fake-codex",
        SECRET: "must-not-reach-child"
      }
    });

    assert.deepEqual(result, { attempted: true, reason: "spawn_attempted" });
    assert.deepEqual(calls[0][1], "/opt/node/bin/node");
    assert.deepEqual(calls[0][2], [
      "/opt/afl/bin/agent-feedback-loop.mjs",
      "convergence-probe-run",
      "--home", "/tmp/afl-home",
      "--task-uid", "task-1",
      "--fingerprint", "fingerprint-1"
    ]);
    assert.deepEqual(calls[0][3], {
      cwd: path.dirname("/opt/afl/bin/agent-feedback-loop.mjs"),
      detached: true,
      stdio: "ignore",
      env: {
        PATH: "/usr/bin",
        HOME: "/Users/example",
        AFL_REVIEW_TRACE: "opaque",
        AGENT_FEEDBACK_LOOP_CODEX_COMMAND: "/tmp/fake-codex"
      },
      windowsHide: true
    });
    assert.deepEqual(calls.slice(1).map((call) => call[0]), ["once", "unref"]);
  }
});

test("launcher rejects unsupported platforms and invalid inputs before spawn", () => {
  let spawns = 0;
  const base = {
    platform: "darwin",
    nodeExecutable: "/opt/node/bin/node",
    cliFile: "/opt/afl/bin/agent-feedback-loop.mjs",
    home: "/tmp/afl-home",
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    spawnImpl: () => { spawns += 1; }
  };
  assert.deepEqual(
    launchDetachedConvergenceProbe({ ...base, platform: "win32" }),
    { attempted: false, reason: "unsupported_platform" }
  );
  for (const input of [
    { nodeExecutable: "node" },
    { cliFile: "cli.mjs" },
    { home: "relative-home" },
    { taskUid: "task with spaces" },
    { fingerprint: "" }
  ]) {
    assert.deepEqual(
      launchDetachedConvergenceProbe({ ...base, ...input }),
      { attempted: false, reason: "invalid_input" }
    );
  }
  assert.equal(spawns, 0);
});

test("internal convergence-probe-run routes once without writing user-visible stdout", async () => {
  let observed = null;
  let writes = 0;
  await main([
    "convergence-probe-run",
    "--home", "/tmp/disposable-afl-home",
    "--task-uid", "task-1",
    "--fingerprint", "fingerprint-1"
  ], {
    runConvergenceProbeCommand: async (input) => { observed = input; },
    stdoutWrite: () => { writes += 1; }
  });

  assert.deepEqual(observed, {
    home: "/tmp/disposable-afl-home",
    taskUid: "task-1",
    fingerprint: "fingerprint-1"
  });
  assert.equal(writes, 0);
});
