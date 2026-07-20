import assert from "node:assert/strict";
import { access, chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { assessCodexHookListing, createCodexHost } from "../src/codex-host.mjs";

test("Codex host synchronization trusts only the exact prompt command", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-codex-host-"));
  const server = path.join(home, "fake-codex.mjs");
  const trustedFile = path.join(home, "trusted");
  const promptCommand = "'/managed/core-hook.sh' '--event' 'UserPromptSubmit'";
  await writeFile(server, `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import readline from "node:readline";
const trustedFile = ${JSON.stringify(trustedFile)};
const promptCommand = ${JSON.stringify(promptCommand)};
const hooks = () => [
  { key: "other", eventName: "stop", handlerType: "command", sourcePath: ${JSON.stringify(path.join(home, ".codex", "config.toml"))}, source: "user", command: "/tmp/user-stop.sh", enabled: true, isManaged: false, currentHash: "sha256:other", trustStatus: "modified" },
  { key: "prompt", eventName: "userPromptSubmit", handlerType: "command", sourcePath: ${JSON.stringify(path.join(home, ".codex", "config.toml"))}, source: "user", command: promptCommand, enabled: true, isManaged: false, currentHash: "sha256:prompt", trustStatus: existsSync(trustedFile) ? "trusted" : "modified" }
];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id == null) return;
  if (message.method === "initialize") return console.log(JSON.stringify({ id: message.id, result: {} }));
  if (message.method === "hooks/list") return console.log(JSON.stringify({ id: message.id, result: { data: [{ cwd: message.params.cwds[0], hooks: hooks(), warnings: [], errors: [] }] } }));
  if (message.method === "config/batchWrite") {
    const state = message.params.edits[0].value;
    if (Object.keys(state).join(",") !== "prompt" || state.prompt.trusted_hash !== "sha256:prompt") return console.log(JSON.stringify({ id: message.id, error: { message: "unexpected trust scope" } }));
    writeFileSync(trustedFile, "ok");
    return console.log(JSON.stringify({ id: message.id, result: {} }));
  }
  console.log(JSON.stringify({ id: message.id, error: { message: "unsupported" } }));
});
`, { mode: 0o700 });
  await chmod(server, 0o700);

  const host = createCodexHost({ command: server, timeoutMs: 8_000, version: "test" });
  const input = { home, cwd: home, promptCommand };
  const synchronized = await host.synchronize(input);
  const inspected = await host.inspect(input);

  assert.equal(synchronized.changed, true);
  assert.equal(synchronized.runnable, true);
  assert.equal(synchronized.status, "trusted");
  assert.equal("backstop" in synchronized, false);
  assert.equal(inspected.runnable, true);
});

test("Codex hook assessment requires exact prompt identity and enabled trust", () => {
  const promptCommand = "'/managed/core-hook.sh' '--event' 'UserPromptSubmit'";
  const listing = {
    data: [{
      cwd: "/tmp/project",
      hooks: [
        { key: "lookalike", eventName: "userPromptSubmit", handlerType: "command", sourcePath: "/tmp/home/.codex/config.toml", source: "user", command: `${promptCommand} --extra`, enabled: true, isManaged: false, currentHash: "sha256:x", trustStatus: "trusted" },
        { key: "prompt", eventName: "userPromptSubmit", handlerType: "command", sourcePath: "/tmp/home/.codex/config.toml", source: "user", command: promptCommand, enabled: true, isManaged: false, currentHash: "sha256:p", trustStatus: "modified" },
        { key: "user-stop", eventName: "stop", handlerType: "command", sourcePath: "/tmp/home/.codex/config.toml", source: "user", command: "/tmp/user-stop.sh", enabled: false, isManaged: false, currentHash: "sha256:s", trustStatus: "untrusted" }
      ],
      warnings: [],
      errors: []
    }]
  };

  const result = assessCodexHookListing({ listing, cwd: "/tmp/project", home: "/tmp/home", promptCommand });

  assert.equal(result.configured, true);
  assert.equal(result.runnable, false);
  assert.equal(result.status, "modified");
  assert.equal(result.prompt.key, "prompt");
  assert.equal("backstop" in result, false);
});

test("Codex hook assessment never falls back to another cwd or wrong source", () => {
  const home = "/tmp/home";
  const promptCommand = "'/managed/core-hook.sh' '--event' 'UserPromptSubmit'";
  const wrongCwd = assessCodexHookListing({
    listing: { data: [{ cwd: "/tmp/different", hooks: [], warnings: [], errors: [] }] },
    cwd: "/tmp/project",
    home,
    promptCommand
  });
  const wrongSource = assessCodexHookListing({
    listing: { data: [{ cwd: "/tmp/project", hooks: [{ key: "prompt", eventName: "userPromptSubmit", handlerType: "command", sourcePath: "/tmp/plugin/config.toml", source: "plugin", command: promptCommand, enabled: true, isManaged: true }], warnings: [], errors: [] }] },
    cwd: "/tmp/project",
    home,
    promptCommand
  });

  assert.equal(wrongCwd.status, "cwd_missing");
  assert.equal(wrongCwd.prompt.found, false);
  assert.equal(wrongSource.status, "missing");
  assert.equal(wrongSource.configured, false);
});

test("Codex host does not fall back after an initialized desktop host operation fails", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-codex-fallback-"));
  const first = path.join(home, "first-codex.mjs");
  const second = path.join(home, "second-codex.mjs");
  const firstMarker = path.join(home, "first-started");
  const secondMarker = path.join(home, "second-started");
  await writeFile(first, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import readline from "node:readline";
writeFileSync(${JSON.stringify(firstMarker)}, "started");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id == null) return;
  if (message.method === "initialize") return console.log(JSON.stringify({ id: message.id, result: {} }));
  console.log(JSON.stringify({ id: message.id, error: { message: "desktop hooks/list failed" } }));
});
`, { mode: 0o700 });
  await writeFile(second, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(secondMarker)}, "started");
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  await chmod(first, 0o700);
  await chmod(second, 0o700);

  const host = createCodexHost({ commands: [first, second], timeoutMs: 8_000, version: "test" });
  const result = await host.inspect({ home, cwd: home, promptCommand: "prompt" });

  assert.equal(result.available, false);
  assert.match(result.reason, /desktop hooks\/list failed/);
  await access(firstMarker);
  await assert.rejects(access(secondMarker));
});
