import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  EXECUTION_MONITOR_THRESHOLDS,
  deriveExecutionMonitorId,
  inspectExecutionTranscript
} from "../src/execution-monitor.mjs";
import { handleExecutionHook } from "../src/execution-hook.mjs";
import { runExecutionMonitorProbe } from "../src/execution-probe-runner.mjs";
import { initializeControlStore, openControlStore } from "../src/control-store.mjs";
import { pathsFor } from "../src/index.mjs";

const STOP_MESSAGE = "Stop tool use now. Report verified results and finish with the smallest necessary next step.";
const RESULT = Object.freeze({
  assessment: "overdesigned",
  action: "simplify_current_generation",
  unmet_user_value: "The requested result is already bounded",
  wrong_assumption: "More tool calls are required",
  unnecessary_scope: ["additional implementation"],
  minimal_next_step: "Report the verified result",
  falsification_test: "Name one unmet acceptance criterion"
});

async function fixture(t, initialNow = "2026-07-28T00:00:00.000Z") {
  const home = await mkdtemp(path.join(tmpdir(), "afl-execution-monitor-"));
  let currentNow = new Date(initialNow);
  const paths = pathsFor(home);
  const store = initializeControlStore({ paths, now: () => new Date(currentNow) });
  t.after(async () => {
    try { store.close(); } catch {}
    await rm(home, { recursive: true, force: true });
  });
  return {
    home,
    paths,
    store,
    advance(milliseconds) { currentNow = new Date(currentNow.getTime() + milliseconds); }
  };
}

function assistantRecord(timestamp, content) {
  return { timestamp, type: "assistant", message: { role: "assistant", content } };
}

function thresholdRecords({ toolCalls = 32, elapsedMs = 45 * 60 * 1_000 } = {}) {
  const start = Date.parse("2026-07-28T00:00:00.000Z");
  const records = [
    { timestamp: new Date(start).toISOString(), type: "user", message: { role: "user", content: "begin" } },
    assistantRecord(new Date(start + 1_000).toISOString(), [{ type: "text", text: "Starting the bounded work." }])
  ];
  for (let index = 0; index < toolCalls; index += 1) {
    const offset = Math.round((elapsedMs * (index + 1)) / toolCalls);
    records.push(assistantRecord(new Date(start + offset).toISOString(), [
      { type: "tool_use", name: "bounded-tool", input: { omitted: true } }
    ]));
    if (index === 15 && toolCalls >= 32) {
      records.push(assistantRecord(new Date(start + offset + 1).toISOString(), [
        { type: "text", text: "Visible progress checkpoint." }
      ]));
    }
  }
  return records;
}

async function writeTranscript(directory, records, name = "transcript.jsonl") {
  const file = path.join(directory, name);
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
  return file;
}

function thresholdPayload(transcriptPath, sessionId = "execution-session-private") {
  return { session_id: sessionId, transcript_path: transcriptPath, tool_name: "bounded-tool" };
}

test("secure transcript inspection computes the frozen multi-signal threshold metrics", async (t) => {
  const context = await fixture(t);
  const transcriptPath = await writeTranscript(context.home, thresholdRecords());

  const inspected = await inspectExecutionTranscript({ transcriptPath });

  assert.deepEqual(EXECUTION_MONITOR_THRESHOLDS, {
    toolCallCount: 32,
    elapsedMs: 45 * 60 * 1_000,
    consecutiveNoProgress: 16
  });
  assert.deepEqual(inspected.metrics, {
    turnCount: 1,
    toolCallCount: 32,
    elapsedMs: 45 * 60 * 1_000,
    consecutiveNoProgress: 16
  });
  assert.equal(inspected.thresholdReached, true);
  assert.match(inspected.snapshotDigest, /^[a-f0-9]{64}$/u);
});

test("Codex response-item JSON arrays use visible agent progress without double-counting turns", async (t) => {
  const context = await fixture(t);
  const start = Date.parse("2026-07-28T00:00:00.000Z");
  const records = [{
    timestamp: new Date(start).toISOString(),
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "begin" }] }
  }];
  for (let index = 0; index < 32; index += 1) {
    records.push({
      timestamp: new Date(start + Math.round((2_700_000 * (index + 1)) / 32)).toISOString(),
      type: "response_item",
      payload: { type: "function_call", name: "bounded-tool", arguments: "{}" }
    });
    if (index === 15) {
      records.push({
        timestamp: new Date(start + Math.round((2_700_000 * (index + 1)) / 32) + 1).toISOString(),
        type: "event_msg",
        payload: { type: "agent_message", message: "Visible progress checkpoint." }
      });
    }
  }
  const transcriptPath = path.join(context.home, "codex-transcript.json");
  await writeFile(transcriptPath, JSON.stringify(records), { mode: 0o600 });

  const inspected = await inspectExecutionTranscript({ transcriptPath });

  assert.equal(inspected.metrics.turnCount, 1);
  assert.equal(inspected.metrics.toolCallCount, 32);
  assert.equal(inspected.metrics.consecutiveNoProgress, 16);
  assert.equal(inspected.thresholdReached, true);
});

test("unsafe symlinks and malformed transcripts fail open before state mutation", async (t) => {
  const context = await fixture(t);
  const target = await writeTranscript(context.home, thresholdRecords(), "target.jsonl");
  const linked = path.join(context.home, "linked.jsonl");
  await symlink(target, linked);
  const malformed = path.join(context.home, "malformed.jsonl");
  await writeFile(malformed, '{"timestamp":"2026-07-28T00:00:00.000Z"}\nnot-json\n', { mode: 0o600 });
  const oversized = path.join(context.home, "oversized.jsonl");
  await writeFile(oversized, "x".repeat(8 * 1024 * 1024 + 1), { mode: 0o600 });

  for (const transcriptPath of [linked, malformed, oversized]) {
    let launches = 0;
    const response = await handleExecutionHook({
      payload: thresholdPayload(transcriptPath),
      cli: "codex",
      controlStore: context.store,
      launchProbe() { launches += 1; return { attempted: true }; }
    });
    assert.deepEqual(response, { continue: true });
    assert.equal(launches, 0);
  }
  assert.equal(context.store.database.prepare(
    "SELECT COUNT(*) AS count FROM store_meta WHERE key LIKE 'execution_monitor:v1:%'"
  ).get().count, 0);
});

test("below-threshold execution hooks make zero provider or spawn calls", async (t) => {
  const context = await fixture(t);
  const transcriptPath = await writeTranscript(context.home, thresholdRecords({
    toolCalls: 31,
    elapsedMs: 44 * 60 * 1_000
  }));
  let launches = 0;
  let providers = 0;

  const response = await handleExecutionHook({
    payload: thresholdPayload(transcriptPath),
    cli: "codex",
    controlStore: context.store,
    launchProbe() { launches += 1; return { attempted: true }; },
    provider() { providers += 1; return RESULT; }
  });

  assert.deepEqual(response, { continue: true });
  assert.equal(launches, 0);
  assert.equal(providers, 0);
  const row = context.store.database.prepare(
    "SELECT key, value FROM store_meta WHERE key LIKE 'execution_monitor:v1:%'"
  ).get();
  assert.match(row.key, /^execution_monitor:v1:[a-f0-9]{64}$/u);
  assert.doesNotMatch(row.value, /execution-session-private|transcript\.jsonl|Starting the bounded work/u);
});

test("one threshold snapshot returns one stop message and reserves one detached Probe", async (t) => {
  const context = await fixture(t);
  const transcriptPath = await writeTranscript(context.home, thresholdRecords());
  let launches = 0;
  const launchProbe = ({ monitorId, reservationEpoch }) => {
    launches += 1;
    assert.match(monitorId, /^[a-f0-9]{64}$/u);
    assert.equal(reservationEpoch, 1);
    return { attempted: true };
  };

  const first = await handleExecutionHook({
    payload: thresholdPayload(transcriptPath), cli: "codex", controlStore: context.store, launchProbe
  });
  const duplicate = await handleExecutionHook({
    payload: thresholdPayload(transcriptPath), cli: "codex", controlStore: context.store, launchProbe
  });

  assert.deepEqual(first, { continue: true, systemMessage: STOP_MESSAGE });
  assert.deepEqual(duplicate, { continue: true });
  assert.equal(launches, 1);
  const monitorId = deriveExecutionMonitorId({ cli: "codex", sessionId: "execution-session-private" });
  const monitor = context.store.getExecutionMonitor({ monitorId });
  assert.equal(monitor.probeState, "reserved");
  assert.equal(monitor.reservationEpoch, 1);
  assert.equal(monitor.failureCount, 0);
});

test("concurrent duplicate hooks have one winner and complete without deadlock", async (t) => {
  const context = await fixture(t);
  const transcriptPath = await writeTranscript(context.home, thresholdRecords());
  const secondStore = openControlStore({ paths: context.paths, now: () => new Date("2026-07-28T00:00:00.000Z") });
  t.after(() => { try { secondStore.close(); } catch {} });
  let launches = 0;
  const launchProbe = () => { launches += 1; return { attempted: true }; };

  const responses = await Promise.race([
    Promise.all([context.store, secondStore].map((controlStore) => handleExecutionHook({
      payload: thresholdPayload(transcriptPath), cli: "codex", controlStore, launchProbe
    }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error("execution hook deadlock")), 2_000))
  ]);

  assert.equal(responses.filter((response) => response.systemMessage === STOP_MESSAGE).length, 1);
  assert.equal(launches, 1);
});

test("stale reservations retry with a new epoch while live reservations stay deduplicated", async (t) => {
  const context = await fixture(t);
  const monitorId = deriveExecutionMonitorId({ cli: "claude", sessionId: "lease-session" });
  const metrics = { turnCount: 1, toolCallCount: 32, elapsedMs: 2_700_000, consecutiveNoProgress: 16 };
  const snapshotDigest = "a".repeat(64);

  const first = context.store.observeExecutionMonitor({
    monitorId, cli: "claude", metrics, snapshotDigest, thresholdReached: true, reservationMs: 60_000
  });
  const liveDuplicate = context.store.observeExecutionMonitor({
    monitorId, cli: "claude", metrics, snapshotDigest, thresholdReached: true, reservationMs: 60_000
  });
  const staleSnapshot = context.store.observeExecutionMonitor({
    monitorId,
    cli: "claude",
    metrics: { ...metrics, toolCallCount: 31, elapsedMs: 2_699_999 },
    snapshotDigest: "f".repeat(64),
    thresholdReached: false,
    reservationMs: 60_000
  });
  context.advance(60_001);
  const retry = context.store.observeExecutionMonitor({
    monitorId, cli: "claude", metrics, snapshotDigest, thresholdReached: true, reservationMs: 60_000
  });

  assert.deepEqual([first.reserved, liveDuplicate.reserved, retry.reserved], [true, false, true]);
  assert.deepEqual([first.reservationEpoch, liveDuplicate.reservationEpoch, retry.reservationEpoch], [1, 1, 2]);
  assert.equal(staleSnapshot.reason, "stale_snapshot");
  assert.equal(context.store.getExecutionMonitor({ monitorId }).metrics.toolCallCount, 32);
});

test("monitor identity isolates CLI sessions and retained store_meta state is globally bounded", async (t) => {
  const context = await fixture(t);
  assert.notEqual(
    deriveExecutionMonitorId({ cli: "codex", sessionId: "same-session" }),
    deriveExecutionMonitorId({ cli: "claude", sessionId: "same-session" })
  );
  for (let index = 0; index < 129; index += 1) {
    const monitorId = deriveExecutionMonitorId({ cli: "codex", sessionId: `session-${index}` });
    context.store.observeExecutionMonitor({
      monitorId,
      cli: "codex",
      metrics: { turnCount: 1, toolCallCount: index, elapsedMs: index, consecutiveNoProgress: index },
      snapshotDigest: index.toString(16).padStart(64, "0"),
      thresholdReached: false,
      reservationMs: 60_000
    });
  }
  assert.equal(context.store.database.prepare(
    "SELECT COUNT(*) AS count FROM store_meta WHERE key LIKE 'execution_monitor:v1:%'"
  ).get().count, 128);
});

test("detached Probe completion validates result and controls the bounded failure count", async (t) => {
  const context = await fixture(t);
  const monitorId = deriveExecutionMonitorId({ cli: "gemini", sessionId: "runner-session" });
  const metrics = { turnCount: 2, toolCallCount: 32, elapsedMs: 2_700_000, consecutiveNoProgress: 16 };
  const reserved = context.store.observeExecutionMonitor({
    monitorId,
    cli: "gemini",
    metrics,
    snapshotDigest: "b".repeat(64),
    thresholdReached: true,
    reservationMs: 60_000
  });
  let providerContext;

  const completed = await runExecutionMonitorProbe({
    store: context.store,
    monitorId,
    reservationEpoch: reserved.reservationEpoch,
    ownerId: "execution-probe-owner",
    provider: async (...args) => { providerContext = args; return RESULT; }
  });

  assert.equal(completed.assessment, "overdesigned");
  assert.equal(completed.failureCount, 1);
  assert.equal(providerContext[1].resultKind, "convergence_probe");
  assert.deepEqual(Object.keys(providerContext[0]), ["status", "evidence"]);
  assert.doesNotMatch(JSON.stringify(providerContext), /runner-session|transcript|tool input/u);
  const monitor = context.store.getExecutionMonitor({ monitorId });
  assert.equal(monitor.failureCount, 1);
  assert.equal(monitor.probeState, "completed");

  assert.throws(() => context.store.completeExecutionMonitorProbe({
    monitorId,
    ownerId: "stale-owner",
    reservationEpoch: reserved.reservationEpoch,
    assessment: "wrong_direction",
    resultDigest: "c".repeat(64)
  }), (error) => error?.code === "execution_probe_lease_lost");
  assert.equal(context.store.getExecutionMonitor({ monitorId }).failureCount, 1);

  for (let index = 0; index < 4; index += 1) {
    const next = context.store.observeExecutionMonitor({
      monitorId,
      cli: "gemini",
      metrics: { ...metrics, toolCallCount: 33 + index },
      snapshotDigest: String(index + 1).repeat(64),
      thresholdReached: true,
      reservationMs: 60_000
    });
    await runExecutionMonitorProbe({
      store: context.store,
      monitorId,
      reservationEpoch: next.reservationEpoch,
      ownerId: `bounded-owner-${index}`,
      provider: async () => ({ ...RESULT, assessment: "scope_drift" })
    });
  }
  assert.equal(context.store.getExecutionMonitor({ monitorId }).failureCount, 3);
});

test("non-failure Probe assessments never increment the monitor failure count", async (t) => {
  for (const assessment of ["aligned_and_necessary", "insufficient_evidence"]) {
    const context = await fixture(t);
    const monitorId = deriveExecutionMonitorId({ cli: "codex", sessionId: `neutral-${assessment}` });
    const reserved = context.store.observeExecutionMonitor({
      monitorId,
      cli: "codex",
      metrics: { turnCount: 1, toolCallCount: 32, elapsedMs: 2_700_000, consecutiveNoProgress: 16 },
      snapshotDigest: assessment === "aligned_and_necessary" ? "d".repeat(64) : "e".repeat(64),
      thresholdReached: true,
      reservationMs: 60_000
    });
    const result = await runExecutionMonitorProbe({
      store: context.store,
      monitorId,
      reservationEpoch: reserved.reservationEpoch,
      ownerId: `owner-${assessment}`,
      provider: async () => ({ ...RESULT, assessment })
    });
    assert.equal(result.failureCount, 0);
  }
});
