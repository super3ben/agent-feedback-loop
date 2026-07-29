import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  EXECUTION_REWORK_LIMIT,
  deriveExecutionMonitorId,
  deriveReworkTarget,
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

function payload({ sessionId = "session-a", toolName = "apply_patch", file = "a.txt" } = {}) {
  const patch = ["*** Begin Patch", "*** Update File: " + file, "*** End Patch"].join("\n");
  return {
    session_id: sessionId,
    tool_name: toolName,
    tool_input: file === null ? {} : { command: patch },
    hook_event_name: "PreToolUse"
  };
}

async function callHook(controlStore, input, limit = EXECUTION_REWORK_LIMIT) {
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

// The signal is rework, not activity. A busy task that touches many different
// files is healthy; one that rewrites a single file over and over without new
// input is circling. The previous shape counted tool calls and would have
// stopped the first while letting the second run.
test("many files edited once each never trips the guard", async (t) => {
  const store = await storeFixture(t);
  for (let index = 0; index < 40; index += 1) {
    const response = await callHook(store, payload({ file: `file-${index}.txt` }), 3);
    assert.deepEqual(response, { continue: true }, "breadth of work is not rework");
  }
});

test("one file rewritten past the limit trips it", async (t) => {
  const store = await storeFixture(t);
  for (let index = 0; index < 3; index += 1) {
    assert.deepEqual(await callHook(store, payload({ file: "same.txt" }), 3), { continue: true });
  }
  const blocked = await callHook(store, payload({ file: "same.txt" }), 3);
  assert.equal(blocked.decision, "block");
});

// A file circling does not make the rest of the run unusable.
test("an unrelated file still proceeds while another is over the limit", async (t) => {
  const store = await storeFixture(t);
  for (let index = 0; index < 4; index += 1) await callHook(store, payload({ file: "hot.txt" }), 3);
  assert.equal((await callHook(store, payload({ file: "hot.txt" }), 3)).decision, "block");
  assert.deepEqual(await callHook(store, payload({ file: "other.txt" }), 3), { continue: true });
});

// Creating a file is first work; only editing existing content is rework.
test("repeated file creation is not counted as rework", async (t) => {
  const store = await storeFixture(t);
  const add = (index) => ({
    session_id: "session-a",
    tool_name: "apply_patch",
    tool_input: { command: ["*** Begin Patch", `*** Add File: new-${index}.txt`, "*** End Patch"].join("\n") },
    hook_event_name: "PreToolUse"
  });
  for (let index = 0; index < 10; index += 1) {
    assert.deepEqual(await callHook(store, add(index), 3), { continue: true });
  }
});

test("rework targets are opaque and identify the artifact, not its path", () => {
  const patch = (file) => ({ command: ["*** Begin Patch", `*** Update File: ${file}`, "*** End Patch"].join("\n") });
  const a = deriveReworkTarget({ toolName: "apply_patch", toolInput: patch("src/secret-project/a.txt") });
  const b = deriveReworkTarget({ toolName: "apply_patch", toolInput: patch("src/secret-project/a.txt") });
  const c = deriveReworkTarget({ toolName: "apply_patch", toolInput: patch("src/secret-project/b.txt") });
  assert.equal(a, b, "the same artifact yields the same key");
  assert.notEqual(a, c);
  assert.match(a, /^[a-f0-9]{16}$/u, "the key carries no path text");

  // Claude Code passes an explicit path field instead of a patch script.
  assert.match(deriveReworkTarget({ toolName: "Edit", toolInput: { file_path: "/tmp/x.txt" } }), /^[a-f0-9]{16}$/u);
  // A read, or a call with nothing identifiable to rework, is not counted.
  assert.equal(deriveReworkTarget({ toolName: "update_plan", toolInput: { file_path: "/tmp/x.txt" } }), null);
  assert.equal(deriveReworkTarget({ toolName: "Bash", toolInput: { command: "ls -la" } }), null);
});

// A progress log is meant to be appended to as work proceeds. Counting it as
// rework stopped a run that was converging: the agent had made two code passes
// and was recording evidence for each review item, and the guard read those
// bookkeeping writes as the same file being refined over and over.
test("bookkeeping files are never counted as rework", () => {
  const patch = (file) => ({
    command: ["*** Begin Patch", `*** Update File: ${file}`, "*** End Patch"].join("\n")
  });
  const target = (file) => deriveReworkTarget({ toolName: "apply_patch", toolInput: patch(file) });

  for (const file of [
    "openspec/changes/feature/.comet/subagent-progress.md",
    ".comet/subagent-progress.md",
    ".superpowers/state.md",
    "openspec/changes/feature/tasks.md",
    ".agent/reflections/20260729-lesson.md",
    "build/run.log",
    "events.jsonl"
  ]) {
    assert.equal(target(file), null, `${file} records progress; it is not rework`);
  }

  for (const file of ["src/index.mjs", "lib/handler.ts", "docs/design.md", "README.md"]) {
    assert.match(target(file) ?? "", /^[a-f0-9]{16}$/u, `${file} is real work and still counts`);
  }
});

test("a run editing only progress files is never stopped", async (t) => {
  const store = await storeFixture(t);
  const progress = {
    session_id: "session-a",
    tool_name: "apply_patch",
    tool_input: {
      command: ["*** Begin Patch", "*** Update File: .comet/subagent-progress.md", "*** End Patch"].join("\n")
    },
    hook_event_name: "PreToolUse"
  };
  for (let index = 0; index < 20; index += 1) {
    assert.deepEqual(await callHook(store, progress, 2), { continue: true });
  }
});
