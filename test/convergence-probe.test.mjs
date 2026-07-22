import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import * as cliModule from "../src/cli.mjs";
import { evaluateAndAdvance } from "../src/convergence-controller.mjs";
import { ConvergenceProbeContextStore } from "../src/convergence-probe-context.mjs";
import { digestDecisionBasis, projectContract } from "../src/convergence-identity.mjs";
import { launchDetachedConvergenceProbe } from "../src/convergence-probe-launcher.mjs";
import { runConvergenceProbeJob } from "../src/convergence-probe-runner.mjs";
import { BlobKeyProvider } from "../src/crypto-store.mjs";
import { initializeControlStore, openControlStore } from "../src/control-store.mjs";
import { pathsFor } from "../src/index.mjs";

const { main } = cliModule;

const DIGEST = "a".repeat(64);
const CONTEXT_DIGEST = "b".repeat(64);
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

function evidence(overrides = {}) {
  return Object.freeze({
    identity: Object.freeze({
      taskUid: "task-1",
      fingerprint: "fingerprint-1",
      boundaryId: "task-5",
      canonicalInvariantId: "probe-isolation"
    }),
    contract: Object.freeze({ contractRevision: DIGEST }),
    trigger: Object.freeze({
      currentGeneration: 2,
      decisionBasisDigest: DIGEST
    }),
    ...overrides
  });
}

function binding(overrides = {}) {
  return {
    contextDigest: CONTEXT_DIGEST,
    contractRevision: DIGEST,
    currentGeneration: 2,
    decisionBasisDigest: DIGEST,
    ...overrides
  };
}

function contextStoreHarness({ value = evidence(), readError = null, removeError = null, timeline = null } = {}) {
  const calls = [];
  return {
    calls,
    contextStore: {
      read(contextDigest) {
        calls.push(["read", contextDigest]);
        timeline?.push("read");
        if (readError) throw readError;
        return value;
      },
      remove(contextDigest) {
        calls.push(["remove", contextDigest]);
        timeline?.push("remove");
        if (removeError) throw removeError;
      }
    }
  };
}

function storeHarness({
  completeError = null,
  failError = null,
  failResult = null,
  probeBinding = binding(),
  timeline = null
} = {}) {
  const calls = [];
  const claimed = status();
  const record = (name, input) => {
    calls.push([name, input]);
    timeline?.push(name);
  };
  return {
    calls,
    store: {
      claimConvergenceProbe(input) {
        record("claim", input);
        return claimed;
      },
      getConvergenceStatus(input) {
        record("status", input);
        return status();
      },
      getConvergenceProbeContextBinding(input) {
        record("binding", input);
        return probeBinding;
      },
      completeConvergenceProbe(input) {
        record("complete", input);
        if (completeError) throw completeError;
        return status({ probeState: "completed", probeOwnerId: null });
      },
      failConvergenceProbe(input) {
        record("fail", input);
        if (failError) throw failError;
        return failResult ?? status({ probeState: "failed", probeOwnerId: null });
      }
    }
  };
}

test("runner consumes one real Store lease and completes through its owner and epoch fence", async () => {
  const harness = storeHarness();
  const evidenceValue = evidence();
  const context = contextStoreHarness({ value: evidenceValue });
  let providerCall;

  const result = await runConvergenceProbeJob({
    store: harness.store,
    contextStore: context.contextStore,
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
  assert.deepEqual(harness.calls.map(([name]) => name), ["claim", "status", "binding", "complete"]);
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
  assert.deepEqual(harness.calls[2][1], { taskUid: "task-1", fingerprint: "fingerprint-1" });
  assert.deepEqual(
    { ...harness.calls[3][1], eventUid: "<opaque>", resultDigest: "<digest>" },
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
  assert.equal(providerCall.length, 2);
  assert.deepEqual(Object.keys(providerCall[0]), ["status", "evidence"]);
  assert.deepEqual(providerCall[1], { resultKind: "convergence_probe" });
  assert.equal(providerCall[0].status.decisionBasisDigest, DIGEST);
  assert.equal(providerCall[0].status.failureCount, 1);
  assert.equal(providerCall[0].evidence, evidenceValue);
  assert.equal(Object.hasOwn(providerCall[0].status, "activeGrantId"), false);
  assert.equal(JSON.stringify(providerCall[0]).includes("must-not-reach-provider"), false);
  assert.deepEqual(context.calls.map(([name]) => name), ["read", "remove"]);
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
    const context = contextStoreHarness();
    await runConvergenceProbeJob({
      store: harness.store,
      contextStore: context.contextStore,
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
  const harness = storeHarness({
    failResult: status({ probeState: "retryable", probeOwnerId: null })
  });
  const context = contextStoreHarness();
  const providerError = Object.assign(new Error("sensitive provider output"), {
    code: "reviewer_timeout"
  });

  await assert.rejects(
    runConvergenceProbeJob({
      store: harness.store,
      contextStore: context.contextStore,
      taskUid: "task-1",
      fingerprint: "fingerprint-1",
      ownerId: "probe-owner-1",
      provider: async () => { throw providerError; }
    }),
    (error) => error === providerError
  );

  assert.deepEqual(harness.calls.map(([name]) => name), ["claim", "status", "binding", "fail"]);
  assert.deepEqual(
    { ...harness.calls[3][1], eventUid: "<opaque>" },
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
  assert.doesNotMatch(JSON.stringify(harness.calls[3][1]), /sensitive/u);
  assert.deepEqual(context.calls.map(([name]) => name), ["read"]);
});

test("completion lease loss is propagated without attempting a stale failure write", async () => {
  const lost = Object.assign(new Error("probe_lease_lost"), { code: "probe_lease_lost" });
  const harness = storeHarness({ completeError: lost });
  const context = contextStoreHarness();

  await assert.rejects(
    runConvergenceProbeJob({
      store: harness.store,
      contextStore: context.contextStore,
      taskUid: "task-1",
      fingerprint: "fingerprint-1",
      ownerId: "probe-owner-1",
      provider: async () => RESULT
    }),
    (error) => error === lost
  );
  assert.deepEqual(harness.calls.map(([name]) => name), ["claim", "status", "binding", "complete"]);
  assert.deepEqual(context.calls.map(([name]) => name), ["read"]);
});

test("runner rejects stale or malformed live bindings before the provider", async () => {
  const invalidBindings = [
    binding({ contractRevision: "c".repeat(64) }),
    binding({ currentGeneration: 3 }),
    binding({ decisionBasisDigest: "d".repeat(64) }),
    binding({ contextDigest: "not-a-digest" })
  ];

  for (const probeBinding of invalidBindings) {
    const harness = storeHarness({ probeBinding });
    const context = contextStoreHarness();
    let providerCalls = 0;
    await assert.rejects(
      runConvergenceProbeJob({
        store: harness.store,
        contextStore: context.contextStore,
        taskUid: "task-1",
        fingerprint: "fingerprint-1",
        ownerId: "probe-owner-1",
        provider: async () => { providerCalls += 1; return RESULT; }
      }),
      (error) => error.code === "context_invalid"
    );
    assert.equal(providerCalls, 0);
    assert.deepEqual(harness.calls.map(([name]) => name), ["claim", "status", "binding", "fail"]);
  }
});

test("runner maps an unreadable context to a terminal bounded failure before the provider", async () => {
  const harness = storeHarness();
  const context = contextStoreHarness({ readError: new Error("private context path") });
  let providerCalls = 0;

  await assert.rejects(
    runConvergenceProbeJob({
      store: harness.store,
      contextStore: context.contextStore,
      taskUid: "task-1",
      fingerprint: "fingerprint-1",
      ownerId: "probe-owner-1",
      provider: async () => { providerCalls += 1; return RESULT; }
    }),
    (error) => error.code === "context_invalid"
  );

  assert.equal(providerCalls, 0);
  assert.deepEqual(harness.calls.map(([name]) => name), ["claim", "status", "binding", "fail"]);
  assert.deepEqual(context.calls.map(([name]) => name), ["read", "remove"]);
});

test("runner removes terminal context only after its Store transition and logs bounded cleanup failure", async () => {
  const providerError = Object.assign(new Error("provider body must not be logged"), {
    code: "provider_invalid"
  });
  const timeline = [];
  const harness = storeHarness({ timeline });
  const context = contextStoreHarness({
    removeError: new Error("private context path"),
    timeline
  });
  const logs = [];
  let providerCalls = 0;

  await assert.rejects(
    runConvergenceProbeJob({
      store: harness.store,
      contextStore: context.contextStore,
      taskUid: "task-1",
      fingerprint: "fingerprint-1",
      ownerId: "probe-owner-1",
      provider: async () => { providerCalls += 1; throw providerError; },
      logger: (entry) => logs.push(entry)
    }),
    (error) => error === providerError
  );

  assert.equal(providerCalls, 1);
  assert.deepEqual(timeline, ["claim", "status", "binding", "read", "fail", "remove"]);
  assert.deepEqual(harness.calls.map(([name]) => name), ["claim", "status", "binding", "fail"]);
  assert.deepEqual(context.calls.map(([name]) => name), ["read", "remove"]);
  assert.deepEqual(logs, [{ action: "probe_context_cleanup_failed", reason: "context_cleanup_failed" }]);
});

test("third retryable provider failure follows the Store terminal transition and removes context", async () => {
  const timeline = [];
  const harness = storeHarness({
    failResult: status({ probeState: "failed", probeOwnerId: null }),
    timeline
  });
  const context = contextStoreHarness({ timeline });
  const providerError = Object.assign(new Error("bounded timeout"), { code: "provider_timeout" });

  await assert.rejects(runConvergenceProbeJob({
    store: harness.store,
    contextStore: context.contextStore,
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    ownerId: "probe-owner-1",
    provider: async () => { throw providerError; }
  }), (error) => error === providerError);

  assert.deepEqual(timeline, ["claim", "status", "binding", "read", "fail", "remove"]);
});

test("completion cleanup failure emits one bounded lifecycle log", async () => {
  const harness = storeHarness();
  const context = contextStoreHarness({ removeError: new Error("private context path") });
  const logs = [];

  await runConvergenceProbeJob({
    store: harness.store,
    contextStore: context.contextStore,
    taskUid: "task-1",
    fingerprint: "fingerprint-1",
    ownerId: "probe-owner-1",
    provider: async () => RESULT,
    logger: (entry) => logs.push(entry)
  });

  assert.deepEqual(logs, [
    { action: "probe_context_cleanup_failed", reason: "context_cleanup_failed" }
  ]);
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

test("real CLI Probe runner opens the encrypted context store and performs terminal cleanup", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-probe-cli-runner-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = pathsFor(home);
  const store = initializeControlStore({ paths });
  const contextStore = new ConvergenceProbeContextStore({
    root: paths.probeContextRoot,
    keyProvider: new BlobKeyProvider({ keyRoot: paths.keyRoot })
  });
  const contract = projectContract({
    sourceKind: "approved_plan",
    sourceRef: "task-5-cli-runner",
    sourceRevision: "v1",
    requirements: [],
    exclusions: [],
    importance: "routine",
    importanceAuthority: "approved_plan"
  });
  const policyRevision = createHash("sha256").update("convergence-policy-v2").digest("hex");
  const basis = digestDecisionBasis({ basis: "cli-runner" });
  const evidenceDigest = digestDecisionBasis({ evidence: "cli-runner" });
  const task = store.upsertConvergenceTask({
    eventUid: "cli-runner-contract",
    taskUid: "cli-runner-task",
    lineageDigest: "1".repeat(64),
    adapterKind: "sdd",
    adapterCapability: "workflow_gate",
    nativeTaskDigest: "2".repeat(64),
    contractSourceKind: contract.sourceKind,
    contractSourceRefDigest: contract.sourceRefDigest,
    contractRevision: contract.revision,
    policyRevision,
    importance: contract.importance,
    importanceAuthority: contract.importanceAuthority
  });
  const loop = store.recordConvergenceReview({
    eventUid: "cli-runner-review",
    taskUid: task.taskUid,
    fingerprint: "cli-runner-fingerprint",
    boundaryId: "task-5",
    canonicalInvariantId: "probe-context",
    verdict: "changes_required",
    severity: "important",
    directionSignal: "none",
    decisionBasisDigest: basis,
    evidenceDigest,
    generation: 0
  });
  const request = {
    adapterCapability: task.adapterCapability,
    contract,
    previousDecisionBasisDigest: basis,
    decisionBasisDigest: basis,
    currentGeneration: 0,
    requestedGeneration: 1,
    failureCount: 1,
    lastGrantPurpose: null,
    acceptanceSatisfied: true,
    addsArchitecture: true,
    touchesExplicitExclusion: false,
    oscillationDetected: false,
    sameInvariant: true,
    explorationRequested: false,
    explorationUsed: false,
    riskHypothesis: null,
    falsificationTest: null,
    evidenceQuality: "none",
    evidenceChanged: false,
    fileSaveCount: 0,
    semanticRecommendation: null
  };
  await evaluateAndAdvance({
    store,
    contextStore,
    task,
    loop,
    request,
    probeContext: {
      producer: "sdd",
      goalSummary: "Deliver a bounded semantic Probe input",
      acceptanceCriteria: ["The real CLI runner decrypts the bound context"],
      exclusions: ["No semantic body enters SQLite"],
      importance: contract.importance,
      importanceAuthority: contract.importanceAuthority,
      contractRevision: contract.revision,
      generationObservations: [],
      reviewEvidence: {
        severity: "important",
        verdict: "changes_required",
        hypothesis: "The CLI runner may omit the context store",
        newEvidence: "The detached runner needs encrypted context access",
        falsificationTest: "Run through the exported real CLI runner",
        evidenceDigest,
        decisionBasisDigest: basis
      }
    },
    launchProbe: () => ({ attempted: false, reason: "test_deferred" })
  });
  const contextDigest = store.getConvergenceProbeContextBinding({
    taskUid: task.taskUid,
    fingerprint: loop.fingerprint
  }).contextDigest;
  store.close();

  await cliModule.executeConvergenceProbeRun({
    home,
    taskUid: task.taskUid,
    fingerprint: loop.fingerprint
  }, {
    provider: async () => RESULT
  });

  const reopened = openControlStore({ paths });
  t.after(() => reopened.close());
  assert.equal(reopened.getConvergenceStatus({
    taskUid: task.taskUid,
    fingerprint: loop.fingerprint
  }).probeState, "completed");
  await assert.rejects(contextStore.read(contextDigest));
});
