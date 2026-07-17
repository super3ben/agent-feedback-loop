import assert from "node:assert/strict";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { install, pathsFor, uninstall } from "../src/index.mjs";
import { listUserTables, openControlStore } from "../src/control-store.mjs";

const ALLOWED_CONTROL_TABLES = [
  "event_observations",
  "reflection_emissions",
  "review_job_events",
  "reviewer_jobs",
  "schema_migrations",
  "session_events",
  "sessions",
  "store_meta"
];

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

test("separates the lean control database from the legacy database", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-control-paths-"));
  const paths = pathsFor(home);

  assert.match(paths.controlDatabase, /store[\\/]control\.sqlite3$/);
  assert.match(paths.legacyDatabase, /store[\\/]feedback-loop\.sqlite3$/);
  assert.equal(paths.legacyDatabase, paths.storeFile);
  assert.notEqual(paths.controlDatabase, paths.legacyDatabase);
});

test("install initializes only the lean control database", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-control-install-"));
  const paths = pathsFor(home);
  await mkdir(path.dirname(paths.legacyDatabase), { recursive: true, mode: 0o700 });
  await writeFile(paths.legacyDatabase, "legacy-sentinel", { mode: 0o600 });

  await install({ home });
  const controlStore = openControlStore({ paths });
  assert.deepEqual(listUserTables(controlStore.database), ALLOWED_CONTROL_TABLES);
  controlStore.close();
  assert.equal(await readFile(paths.legacyDatabase, "utf8"), "legacy-sentinel");
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
  assert.equal(current.runtimeVersion, "0.7.6");
  assert.equal(current.schemaVersion, 9);
});

test("installed Stop templates contain capture only and no receipt backstop", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-stop-template-"));
  await install({ home });
  const paths = pathsFor(home);
  const stopHook = await readFile(paths.stopHook, "utf8");
  const coreHook = await readFile(paths.coreHook, "utf8");

  for (const template of [stopHook, coreHook]) {
    assert.doesNotMatch(template, /backstop/i);
    assert.doesNotMatch(template, /decision["'= :]+block/i);
    assert.doesNotMatch(template, /Output this receipt verbatim before stopping/i);
  }
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
