import assert from "node:assert/strict";
import { test } from "node:test";

import { detectAllReviewerAdapters, detectReviewerAdapter } from "../src/reviewer-adapter.mjs";

test("reviewer adapter reports explicit and built-in providers as isolated processes", async () => {
  const configured = await detectReviewerAdapter({ cli: "claude", command: process.execPath });
  assert.equal(configured.available, true);
  assert.equal(configured.mode, "isolated_cli_process");
  assert.equal(configured.assurance, "process_lifecycle_isolated");
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

test("a missing reviewer command is unavailable even when configured by bare name", async () => {
  const adapter = await detectReviewerAdapter({ cli: "codex", command: "definitely-missing-afl-reviewer-command" });
  assert.equal(adapter.available, false);
  assert.equal(adapter.assurance, "unavailable");
});
