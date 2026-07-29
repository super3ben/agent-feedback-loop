import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  EXECUTION_MUTATION_LIMIT,
  deriveExecutionMonitorId,
  executionToolLabel,
  isMutatingTool
} from "../src/execution-monitor.mjs";
import { EXECUTION_STOP_REASON, handleExecutionHook, resetExecutionMonitorForPrompt } from "../src/execution-hook.mjs";
import { initializeControlStore } from "../src/control-store.mjs";
import { pathsFor } from "../src/index.mjs";

async function storeFixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "afl-exec-"));
  const store = initializeControlStore({ paths: pathsFor(home) });
  t.after(async () => {
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  return store;
}

function payload({ sessionId = "session-a", toolName = "Bash" } = {}) {
  return { session_id: sessionId, tool_name: toolName, hook_event_name: "PreToolUse" };
}

async function callHook(controlStore, input, limit = EXECUTION_MUTATION_LIMIT) {
  const written = [];
  const response = await handleExecutionHook({
    payload: input,
    cli: "codex",
    controlStore,
    writeResponse: async (value) => { written.push(value); return value; },
    limit
  });
  assert.equal(written.length, 1, "the host must receive exactly one response");
  assert.deepEqual(written[0], response);
  return response;
}

// The probe that let 20 files through enumerated Write/Bash/Edit and silently
// allowed apply_patch. Anything unrecognised has to count as mutating.
test("unknown tools are treated as mutating so an unenumerated writer cannot slip past", () => {
  assert.equal(isMutatingTool("apply_patch"), true);
  assert.equal(isMutatingTool("collaborationspawn_agent"), true);
  assert.equal(isMutatingTool("mcp__something__write"), true);
  assert.equal(isMutatingTool("a_tool_nobody_has_seen"), true);
  assert.equal(isMutatingTool(undefined), true);
  assert.equal(isMutatingTool(""), true);
  assert.equal(isMutatingTool("update_plan"), false);
});

test("tool labels stay bounded and reject unusable names", () => {
  assert.equal(executionToolLabel("apply_patch"), "apply_patch");
  assert.equal(executionToolLabel("mcp__codegraph__codegraph_explore"), "mcp__codegraph__codegraph_explore");
  assert.equal(executionToolLabel(""), "unknown");
  assert.equal(executionToolLabel(undefined), "unknown");
  assert.equal(executionToolLabel("bad name with spaces"), "unsupported");
  assert.equal(executionToolLabel("x".repeat(200)).length, 64);
});

test("monitor identity separates CLIs and sessions", () => {
  const a = deriveExecutionMonitorId({ cli: "codex", sessionId: "s1" });
  assert.notEqual(a, deriveExecutionMonitorId({ cli: "codex", sessionId: "s2" }));
  assert.notEqual(a, deriveExecutionMonitorId({ cli: "claude", sessionId: "s1" }));
  assert.throws(() => deriveExecutionMonitorId({ cli: "codex", sessionId: "" }), TypeError);
});

test("calls under the limit are allowed and cost no block decision", async (t) => {
  const store = await storeFixture(t);
  for (let index = 0; index < 4; index += 1) {
    const response = await callHook(store, payload(), 5);
    assert.deepEqual(response, { continue: true }, "under the limit the run proceeds untouched");
  }
  const monitor = store.getExecutionMonitor({
    monitorId: deriveExecutionMonitorId({ cli: "codex", sessionId: "session-a" })
  });
  assert.equal(monitor.count, 4);
  assert.equal(monitor.overLimit, false);
});

// A post-run hook cannot stop a mutation that already happened, and an advisory
// message does not stop this agent: told to review its own direction it wrote a
// review, approved itself, and continued. Only a pre-run block works.
test("crossing the limit blocks the mutating call with a hard decision", async (t) => {
  const store = await storeFixture(t);
  for (let index = 0; index < 3; index += 1) await callHook(store, payload(), 3);
  const blocked = await callHook(store, payload(), 3);
  assert.deepEqual(blocked, { decision: "block", reason: EXECUTION_STOP_REASON });
  assert.equal("continue" in blocked, false, "a block must not also tell the host to continue");
});

test("a read-only call still runs past the limit so the agent can hand back", async (t) => {
  const store = await storeFixture(t);
  for (let index = 0; index < 3; index += 1) await callHook(store, payload(), 3);
  const read = await callHook(store, payload({ toolName: "update_plan" }), 3);
  assert.deepEqual(read, { continue: true });
  const mutation = await callHook(store, payload({ toolName: "apply_patch" }), 3);
  assert.equal(mutation.decision, "block");
});

test("the block persists until the user speaks, then the counter clears", async (t) => {
  const store = await storeFixture(t);
  for (let index = 0; index < 4; index += 1) await callHook(store, payload(), 3);
  assert.equal((await callHook(store, payload(), 3)).decision, "block");

  const reset = resetExecutionMonitorForPrompt({
    payload: { session_id: "session-a" },
    cli: "codex",
    controlStore: store
  });
  assert.equal(reset.reset, true);
  assert.equal(store.getExecutionMonitor({
    monitorId: deriveExecutionMonitorId({ cli: "codex", sessionId: "session-a" })
  }), null);

  const afterPrompt = await callHook(store, payload(), 3);
  assert.deepEqual(afterPrompt, { continue: true }, "the user intervening rearms the run");
});

test("sessions are counted independently", async (t) => {
  const store = await storeFixture(t);
  for (let index = 0; index < 4; index += 1) await callHook(store, payload({ sessionId: "busy" }), 3);
  assert.equal((await callHook(store, payload({ sessionId: "busy" }), 3)).decision, "block");
  assert.deepEqual(await callHook(store, payload({ sessionId: "fresh" }), 3), { continue: true });
});

// The tool inventory is the point: it answers what the real vocabulary is by
// shipping rather than by guessing it in advance.
test("every observed tool name is recorded for the inventory", async (t) => {
  const store = await storeFixture(t);
  for (const toolName of ["Bash", "apply_patch", "apply_patch", "update_plan"]) {
    await callHook(store, payload({ toolName }));
  }
  const monitor = store.getExecutionMonitor({
    monitorId: deriveExecutionMonitorId({ cli: "codex", sessionId: "session-a" })
  });
  assert.deepEqual(monitor.seenTools, { Bash: 1, apply_patch: 2, update_plan: 1 });
});

test("claude and gemini are observed by no execution guard", async (t) => {
  const store = await storeFixture(t);
  for (const cli of ["claude", "gemini"]) {
    const response = await handleExecutionHook({
      payload: payload(), cli, controlStore: store, limit: 1
    });
    assert.deepEqual(response, { continue: true });
  }
  assert.equal(store.getExecutionMonitor({
    monitorId: deriveExecutionMonitorId({ cli: "claude", sessionId: "session-a" })
  }), null, "an unguarded CLI records no state at all");
});

test("a broken guard fails open instead of breaking the run", async (t) => {
  const store = await storeFixture(t);
  const throwingStore = {
    recordExecutionToolCall() { throw new Error("store is down"); }
  };
  assert.deepEqual(await callHook(throwingStore, payload()), { continue: true });
  assert.deepEqual(await callHook(store, null), { continue: true });
  assert.deepEqual(await callHook(store, payload({ sessionId: "" })), { continue: true });
});

test("a session cannot change CLI underneath its monitor id", async (t) => {
  const store = await storeFixture(t);
  const monitorId = deriveExecutionMonitorId({ cli: "codex", sessionId: "session-a" });
  store.recordExecutionToolCall({ monitorId, cli: "codex", mutating: true, toolLabel: "Bash", limit: 4 });
  assert.throws(
    () => store.recordExecutionToolCall({ monitorId, cli: "claude", mutating: true, toolLabel: "Bash", limit: 4 }),
    /execution monitor collision/u
  );
});

test("retained monitor state is globally bounded", async (t) => {
  const store = await storeFixture(t);
  for (let index = 0; index < 140; index += 1) {
    store.recordExecutionToolCall({
      monitorId: deriveExecutionMonitorId({ cli: "codex", sessionId: `session-${index}` }),
      cli: "codex",
      mutating: true,
      toolLabel: "Bash",
      limit: 4
    });
  }
  const live = store.getExecutionMonitor({
    monitorId: deriveExecutionMonitorId({ cli: "codex", sessionId: "session-139" })
  });
  assert.equal(live.count, 1, "the newest monitor survives pruning");
});
