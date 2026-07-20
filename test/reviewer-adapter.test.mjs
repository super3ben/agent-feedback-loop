import assert from "node:assert/strict";
import { test } from "node:test";

import { detectAllReviewerAdapters, detectReviewerAdapter } from "../src/reviewer-adapter.mjs";

test("reviewer adapter uses provider-specific configuration and ignores the legacy generic command", async () => {
  const legacyOnly = await detectReviewerAdapter({
    cli: "claude",
    command: process.execPath,
    pathValue: "",
    env: { PATH: "" }
  });
  assert.equal(legacyOnly.available, false);
  assert.equal(legacyOnly.command, null);

  const providerSpecific = await detectReviewerAdapter({
    cli: "codex",
    command: null,
    pathValue: "",
    env: { PATH: "", AGENT_FEEDBACK_LOOP_CODEX_COMMAND: process.execPath }
  });
  assert.equal(providerSpecific.available, true);
  assert.equal(providerSpecific.command, process.execPath);
  assert.equal(providerSpecific.mode, "isolated_cli_process");
  assert.equal(providerSpecific.assurance, "process_lifecycle_isolated");
  assert.match(providerSpecific.reason, /short-lived/i);
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
