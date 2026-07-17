import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { pathsFor } from "../src/index.mjs";
import { captureObservedSession, normalizeHookEvent } from "../src/capture.mjs";
import { BlobKeyProvider, EncryptedBlobStore } from "../src/crypto-store.mjs";
import {
  CONTROL_SCHEMA_MISMATCH,
  CONTROL_STORE_UNAVAILABLE,
  initializeControlStore,
  listUserTables,
  openControlStore
} from "../src/control-store.mjs";

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

function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "afl-control-store-"));
  return { home, paths: pathsFor(home) };
}

function event(overrides = {}) {
  return {
    event_uid: "event-1",
    session_uid: "session-1",
    cli: "codex",
    project_id: "project-1",
    context_epoch: 1,
    source_event_id: "source-1",
    source_identity: "identity-1",
    role: "user",
    referent_event_uid: null,
    content_hash: "a".repeat(64),
    encrypted_raw_ref: "/private/blobs/a.enc",
    completeness: "prompt_only",
    ...overrides
  };
}

function controlCaptureFixture() {
  const { paths } = fixture();
  return {
    paths,
    store: initializeControlStore({ paths }),
    blobs: new EncryptedBlobStore({
      root: paths.blobRoot,
      keyProvider: new BlobKeyProvider({ keyRoot: paths.keyRoot })
    })
  };
}

test("fresh control schema contains only transient tables", () => {
  const { paths } = fixture();
  mkdirSync(path.dirname(paths.legacyDatabase), { recursive: true, mode: 0o700 });
  writeFileSync(paths.legacyDatabase, "legacy-sentinel", { mode: 0o600 });

  const store = initializeControlStore({ paths, now: () => new Date("2026-07-16T00:00:00.000Z") });
  assert.deepEqual(listUserTables(store.database), ALLOWED_CONTROL_TABLES);
  assert.equal(readFileSync(paths.legacyDatabase, "utf8"), "legacy-sentinel");
  store.close();
});

test("runtime open does not create a missing control database", () => {
  const { paths } = fixture();
  assert.throws(
    () => openControlStore({ paths }),
    (error) => error?.code === CONTROL_STORE_UNAVAILABLE
  );
  assert.throws(() => statSync(paths.controlDatabase), /ENOENT/);
});

test("runtime open rejects a mismatched schema without changing the database", () => {
  const { paths } = fixture();
  const initialized = initializeControlStore({ paths });
  initialized.database.prepare("DELETE FROM schema_migrations").run();
  initialized.database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (0, ?)").run("2026-07-16T00:00:00.000Z");
  initialized.close();
  const before = readFileSync(paths.controlDatabase);

  assert.throws(
    () => openControlStore({ paths }),
    (error) => error?.code === CONTROL_SCHEMA_MISMATCH
  );
  assert.deepEqual(readFileSync(paths.controlDatabase), before);
});

test("runtime open rejects a non-private control database without changing its mode", () => {
  const { paths } = fixture();
  const initialized = initializeControlStore({ paths });
  initialized.close();
  chmodSync(paths.controlDatabase, 0o644);

  assert.throws(
    () => openControlStore({ paths }),
    (error) => error?.code === CONTROL_STORE_UNAVAILABLE
  );
  assert.equal(statSync(paths.controlDatabase).mode & 0o777, 0o644);
});

test("runtime open fail-closes every control path redirect without filesystem repair", () => {
  const expectUnavailable = (paths, watched) => {
    const before = watched.map((file) => ({
      file,
      mode: lstatSync(file).mode,
      symlink: lstatSync(file).isSymbolicLink(),
      content: lstatSync(file).isFile() ? readFileSync(file) : null
    }));
    assert.throws(() => openControlStore({ paths }), (error) => error?.code === CONTROL_STORE_UNAVAILABLE);
    for (const snapshot of before) {
      const after = lstatSync(snapshot.file);
      assert.equal(after.mode, snapshot.mode);
      assert.equal(after.isSymbolicLink(), snapshot.symlink);
      if (snapshot.content) assert.deepEqual(readFileSync(snapshot.file), snapshot.content);
    }
  };

  {
    const { home, paths } = fixture();
    const initialized = initializeControlStore({ paths });
    initialized.close();
    const target = path.join(home, "redirect.sqlite3");
    renameSync(paths.controlDatabase, target);
    symlinkSync(target, paths.controlDatabase);
    expectUnavailable(paths, [paths.controlDatabase, target]);
  }
  {
    const { home, paths } = fixture();
    const target = path.join(home, "redirect-root");
    mkdirSync(target, { mode: 0o700 });
    mkdirSync(path.dirname(paths.dataRoot), { recursive: true, mode: 0o700 });
    symlinkSync(target, paths.dataRoot);
    expectUnavailable(paths, [paths.dataRoot, target]);
  }
  {
    const { paths } = fixture();
    mkdirSync(path.dirname(paths.dataRoot), { recursive: true, mode: 0o700 });
    writeFileSync(paths.dataRoot, "not-a-directory", { mode: 0o600 });
    expectUnavailable(paths, [paths.dataRoot]);
  }
  {
    const { home, paths } = fixture();
    const initialized = initializeControlStore({ paths });
    initialized.close();
    const target = path.join(home, "redirect-store");
    renameSync(path.dirname(paths.controlDatabase), target);
    symlinkSync(target, path.dirname(paths.controlDatabase));
    expectUnavailable(paths, [path.dirname(paths.controlDatabase), target]);
  }
  {
    const { home, paths } = fixture();
    const initialized = initializeControlStore({ paths });
    initialized.close();
    const agentRoot = path.dirname(paths.dataRoot);
    const target = path.join(home, "redirect-agent-root");
    renameSync(agentRoot, target);
    symlinkSync(target, agentRoot);
    expectUnavailable(paths, [agentRoot, target]);
  }
  {
    const { paths } = fixture();
    const initialized = initializeControlStore({ paths });
    initialized.close();
    chmodSync(paths.dataRoot, 0o755);
    expectUnavailable(paths, [paths.dataRoot]);
  }
  {
    const { paths } = fixture();
    const initialized = initializeControlStore({ paths });
    initialized.close();
    const escaped = { ...paths, controlDatabase: path.join(paths.dataRoot, "control.sqlite3") };
    expectUnavailable(escaped, [paths.controlDatabase]);
  }
});

test("runtime control capture waits for a short concurrent writer", async () => {
  const { paths } = fixture();
  const initialized = initializeControlStore({ paths });
  initialized.close();
  const store = openControlStore({ paths });
  const holder = spawn(process.execPath, ["-e", `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.env.AFL_TEST_CONTROL_STORE);
    db.exec("BEGIN IMMEDIATE");
    process.stdout.write("locked\\n");
    setTimeout(() => { db.exec("COMMIT"); db.close(); }, 300);
  `], {
    env: { ...process.env, AFL_TEST_CONTROL_STORE: paths.controlDatabase },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const exitPromise = once(holder, "exit");
  const [ready] = await once(holder.stdout, "data");
  assert.match(String(ready), /locked/);

  const startedAt = Date.now();
  const captured = store.captureSessionEvent(event());
  const elapsedMs = Date.now() - startedAt;
  assert.equal(captured.duplicate, false);
  assert.ok(elapsedMs >= 150, `expected control capture to wait for writer, waited ${elapsedMs}ms`);
  const [exitCode] = await exitPromise;
  assert.equal(exitCode, 0);
  store.close();
});

test("captures bounded event metadata and resolves duplicate observations", () => {
  const { paths } = fixture();
  const store = initializeControlStore({ paths });
  const captured = store.captureSessionEvent(event());
  const duplicate = store.captureSessionEvent(event());
  const observation = store.resolveEventObservation({
    observation_uid: "observation-1",
    observation_key: "codex:hook:source-1",
    event_uid: "event-1",
    capture_source: "prompt_hook"
  });
  const repeatedObservation = store.resolveEventObservation({
    observation_uid: "observation-2",
    observation_key: "codex:hook:source-1",
    event_uid: "event-1",
    capture_source: "prompt_hook"
  });

  assert.equal(captured.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(observation.duplicate, false);
  assert.equal(repeatedObservation.duplicate, true);
  assert.deepEqual(store.getSessionEvent("event-1"), {
    event_uid: "event-1",
    session_uid: "session-1",
    source_event_id: "source-1",
    source_identity: "identity-1",
    role: "user",
    referent_event_uid: null,
    content_hash: "a".repeat(64),
    encrypted_raw_ref: "/private/blobs/a.enc",
    completeness: "prompt_only"
  });
  store.close();
});

test("capture rejects raw text fields instead of storing them", () => {
  const { paths } = fixture();
  const store = initializeControlStore({ paths });
  assert.throws(() => store.assertCaptureAllowed(event({ raw_text: "must-not-persist" })), /raw text/i);
  store.close();
});

test("control capture rejects lossy identifier coercion and non-integral epochs", () => {
  const { paths } = fixture();
  const store = initializeControlStore({ paths });
  for (const invalid of [
    event({ event_uid: { id: "event-1" } }),
    event({ session_uid: 7 }),
    event({ source_event_id: ["source-1"] }),
    event({ context_epoch: 1.5 }),
    event({ context_epoch: NaN }),
    event({ context_epoch: "1" }),
    event({ context_epoch: 0 }),
    event({ context_epoch: 2_147_483_648 })
  ]) {
    assert.throws(() => store.assertCaptureAllowed(invalid), /bounded|integer|string/i);
  }
  store.close();
});

test("control store captures normalized hooks, replays observations, and rejects contradictory identities", async () => {
  const { paths, store, blobs } = controlCaptureFixture();
  const payload = {
    session_id: "capture-session",
    event_id: "first",
    turn_id: "turn-1",
    cwd: "/tmp/control-capture",
    prompt: "control-unique-redacted-text",
    timestamp: "2026-07-17T00:00:00.000Z"
  };
  const first = normalizeHookEvent({ cli: "codex", installationId: "control", payload });
  const firstResult = await captureObservedSession({ store, blobs, event: first, rawText: payload.prompt });
  assert.equal(firstResult.duplicate, false);

  const replay = normalizeHookEvent({ cli: "codex", installationId: "control", payload });
  const replayResult = await captureObservedSession({ store, blobs, event: replay, rawText: payload.prompt });
  assert.equal(replayResult.duplicate, true);
  assert.equal(replayResult.eventUid, first.event_uid);

  const transcript = normalizeHookEvent({
    cli: "codex",
    installationId: "control",
    payload: { ...payload, event_id: "transcript", turn_id: "turn-1" }
  });
  transcript.source_event_id = "message:transcript";
  transcript.source_namespace = "transcript_message";
  transcript.observation_source_id = "transcript-1";
  const alias = await captureObservedSession({ store, blobs, event: transcript, rawText: payload.prompt });
  assert.equal(alias.duplicate, true);
  assert.equal(alias.eventUid, first.event_uid);

  const second = normalizeHookEvent({
    cli: "codex",
    installationId: "control",
    payload: { ...payload, event_id: "second", turn_id: "turn-2" }
  });
  const secondResult = await captureObservedSession({ store, blobs, event: second, rawText: payload.prompt });
  assert.equal(secondResult.duplicate, false);
  assert.notEqual(second.event_uid, first.event_uid);

  assert.throws(
    () => store.captureSessionEvent({ ...second, event_uid: first.event_uid }),
    /constraint|collision/i
  );
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 2);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('session_events') WHERE name LIKE '%text%' OR name IN ('report', 'card', 'lesson')").get().count, 0);
  assert.doesNotMatch(readFileSync(paths.controlDatabase, "utf8"), /control-unique-redacted-text/);
  store.close();
});
