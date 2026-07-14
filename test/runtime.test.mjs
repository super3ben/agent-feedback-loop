import assert from "node:assert/strict";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { install, pathsFor, uninstall } from "../src/index.mjs";

test("paths separate versioned runtime from durable data and keys", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-runtime-"));
  const paths = pathsFor(home);

  assert.match(paths.runtimeRoot, /feedback-loop[\\/]versions/);
  assert.match(paths.dataRoot, /feedback-loop-data$/);
  assert.match(paths.keyRoot, /feedback-loop-keys$/);
  assert.notEqual(paths.runtimeRoot, paths.dataRoot);
  assert.notEqual(paths.dataRoot, paths.keyRoot);
  assert.match(paths.storeFile, /feedback-loop\.sqlite3$/);
});

test("stable launcher resolves an atomically selected versioned runtime", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-current-runtime-"));
  await install({ home });
  const paths = pathsFor(home);
  const launcher = await readFile(paths.runtimeLauncher, "utf8");
  const current = JSON.parse(await readFile(paths.runtimeCurrent, "utf8"));
  assert.match(launcher, /current\.json/);
  assert.doesNotMatch(launcher, /versions\/[0-9.]+\/bin\/agent-feedback-loop/);
  assert.equal(current.runtimeRoot, paths.runtimeRoot);
  assert.equal(current.schemaVersion, 6);
});

test("remove-files removes runtime but preserves durable data and keys", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-uninstall-"));
  const paths = pathsFor(home);
  await mkdir(paths.dataRoot, { recursive: true, mode: 0o700 });
  await mkdir(paths.keyRoot, { recursive: true, mode: 0o700 });
  await writeFile(path.join(paths.dataRoot, "sentinel"), "durable\n", { mode: 0o600 });
  await writeFile(path.join(paths.keyRoot, "sentinel"), "key\n", { mode: 0o600 });

  await install({ home });
  await uninstall({ home, removeFiles: true });

  await assert.rejects(access(paths.runtimeRoot));
  assert.equal(await readFile(path.join(paths.dataRoot, "sentinel"), "utf8"), "durable\n");
  assert.equal(await readFile(path.join(paths.keyRoot, "sentinel"), "utf8"), "key\n");
});

test("install rejects an unsupported Node runtime before modifying user files", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-old-node-"));
  await assert.rejects(() => install({ home, nodeVersion: "20.19.0" }), /Node 24\.15|transactional backend/i);
  await assert.rejects(access(pathsFor(home).packRoot));
});

test("install rejects symlinked runtime and durable roots before copying files", async () => {
  for (const rootName of ["packRoot", "dataRoot", "keyRoot"]) {
    const home = await mkdtemp(path.join(tmpdir(), `afl-install-${rootName}-`));
    const outside = await mkdtemp(path.join(tmpdir(), `afl-install-outside-${rootName}-`));
    const paths = pathsFor(home);
    await mkdir(path.dirname(paths[rootName]), { recursive: true });
    await symlink(outside, paths[rootName]);
    await assert.rejects(() => install({ home }), /symlink/i);
    await assert.rejects(access(path.join(outside, "prompts", "reflection-agent.md")));
  }
});
