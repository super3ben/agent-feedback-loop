import assert from "node:assert/strict";
import { test } from "node:test";

import { detectAllReviewerAdapters, detectReviewerAdapter } from "../src/reviewer-adapter.mjs";

test("reviewer adapter derives capability from the captured provider and ignores the legacy generic command", async () => {
  const configured = await detectReviewerAdapter({
    cli: "claude",
    command: process.execPath,
    pathValue: "",
    env: { PATH: "" }
  });
  assert.equal(configured.available, false);
  const builtIn = await detectReviewerAdapter({ cli: "codex", command: null });
  assert.equal(builtIn.available, true);
  assert.equal(builtIn.mode, "isolated_cli_process");
  assert.equal(builtIn.assurance, "process_lifecycle_isolated");
  assert.match(builtIn.reason, /short-lived/i);
});

test("all supported CLIs have an adapter capability record", async () => {
  const adapters = await detectAllReviewerAdapters({ command: null });
  assert.deepEqual(Object.keys(adapters).sort(), ["claude", "codex", "gemini"]);
  assert.equal(Object.values(adapters).every((adapter) => typeof adapter.available === "boolean"), true);
  assert.equal(Object.values(adapters).every((adapter) => ["process_lifecycle_isolated", "unavailable"].includes(adapter.assurance)), true);
});

test("a missing provider executable is unavailable", async () => {
  const adapter = await detectReviewerAdapter({ cli: "codex", pathValue: "", env: { PATH: "", AGENT_FEEDBACK_LOOP_CODEX_COMMAND: "/definitely/missing" } });
  assert.equal(adapter.available, false);
  assert.equal(adapter.assurance, "unavailable");
});
