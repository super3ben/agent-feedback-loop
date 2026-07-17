import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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

test("runtime open rejects a same-version control schema missing identity metadata", () => {
  const { paths } = fixture();
  mkdirSync(path.dirname(paths.controlDatabase), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(paths.controlDatabase);
  for (const table of ALLOWED_CONTROL_TABLES) database.exec(`CREATE TABLE ${table}(id TEXT)`);
  database.exec("DROP TABLE schema_migrations; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
  database.exec("INSERT INTO schema_migrations(version, applied_at) VALUES (1, '2026-07-17T00:00:00.000Z')");
  database.close();
  chmodSync(paths.controlDatabase, 0o600);
  const before = readFileSync(paths.controlDatabase);

  assert.throws(() => openControlStore({ paths }), (error) => error?.code === CONTROL_SCHEMA_MISMATCH);
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
    const agentRoot = path.dirname(paths.dataRoot);
    chmodSync(agentRoot, 0o777);
    expectUnavailable(paths, [agentRoot]);
    assert.equal(statSync(agentRoot).mode & 0o777, 0o777);
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
    provider: "codex",
    sessionUid: "session-1",
    contextEpoch: 1,
    sourceNamespace: "transcript_message",
    sourceId: "transcript-1",
    eventUid: "event-1",
    nativeTurnId: null,
    role: "user",
    contentHash: "a".repeat(64),
    sourceTimestamp: null
  });
  const repeatedObservation = store.resolveEventObservation({
    provider: "codex",
    sessionUid: "session-1",
    contextEpoch: 1,
    sourceNamespace: "transcript_message",
    sourceId: "transcript-1",
    eventUid: "event-1",
    nativeTurnId: null,
    role: "user",
    contentHash: "a".repeat(64),
    sourceTimestamp: null
  });

  assert.equal(captured.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(observation.duplicate, false);
  assert.equal(repeatedObservation.duplicate, true);
  assert.deepEqual(store.getSessionEvent("event-1"), {
    event_uid: "event-1",
    session_uid: "session-1",
    source_event_id: "source-1",
    source_identity: '["codex","session-1",1,"hook","source-1"]',
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
  for (const field of ["source_namespace", "observation_source_id", "completeness", "capture_completeness"]) {
    for (const invalid of ["", false, 0, { value: field }]) {
      assert.throws(
        () => store.assertCaptureAllowed(event({ [field]: invalid })),
        /bounded|non-empty|string/i,
        `${field} should reject ${JSON.stringify(invalid)}`
      );
    }
  }
  store.close();
});

test("control observations bind host source ids to session epoch and immutable event content", () => {
  const { paths } = fixture();
  const store = initializeControlStore({ paths });
  const first = event({
    event_uid: "event-session-a",
    session_uid: "session-a",
    source_event_id: "reused-host-id",
    source_identity: undefined,
    source_namespace: "prompt_hook",
    observation_source_id: "reused-host-id",
    native_turn_id: "turn-1",
    source_timestamp: "2026-07-17T00:00:00.000Z"
  });
  const secondSession = event({
    ...first,
    event_uid: "event-session-b",
    session_uid: "session-b"
  });
  assert.equal(store.captureSessionEvent(first).duplicate, false);
  assert.equal(store.captureSessionEvent(secondSession).duplicate, false);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 2);

  assert.throws(
    () => store.captureSessionEvent({ ...first, content_hash: "b".repeat(64) }),
    (error) => error?.code === "control_observation_collision"
  );
  assert.equal(store.getSessionEvent(first.event_uid).content_hash, first.content_hash);
  store.close();
});

test("control observation alias requires a unique same-turn candidate inside its timestamp window", () => {
  const { paths } = fixture();
  const store = initializeControlStore({ paths });
  const canonical = event({
    event_uid: "canonical",
    source_identity: undefined,
    source_event_id: "prompt-1",
    source_namespace: "prompt_hook",
    observation_source_id: "prompt-1",
    native_turn_id: "turn-1",
    source_timestamp: "2026-07-17T00:00:00.000Z"
  });
  store.captureSessionEvent(canonical);

  const positive = store.resolveEventObservation({
    provider: "codex",
    sessionUid: canonical.session_uid,
    contextEpoch: canonical.context_epoch,
    sourceNamespace: "transcript_alt",
    sourceId: "transcript-positive",
    nativeTurnId: "turn-1",
    role: canonical.role,
    contentHash: canonical.content_hash,
    sourceTimestamp: "2026-07-17T00:04:00.000Z"
  });
  assert.equal(positive.event_uid, canonical.event_uid);

  const crossTurn = store.resolveEventObservation({
    provider: "codex",
    sessionUid: canonical.session_uid,
    contextEpoch: canonical.context_epoch,
    sourceNamespace: "transcript_outside_window",
    sourceId: "transcript-cross-turn",
    nativeTurnId: "turn-2",
    role: canonical.role,
    contentHash: canonical.content_hash,
    sourceTimestamp: "2026-07-17T00:04:00.000Z"
  });
  assert.equal(crossTurn, null);

  const outsideWindow = store.resolveEventObservation({
    provider: "codex",
    sessionUid: canonical.session_uid,
    contextEpoch: canonical.context_epoch,
    sourceNamespace: "transcript_message",
    sourceId: "transcript-outside-window",
    nativeTurnId: null,
    role: canonical.role,
    contentHash: canonical.content_hash,
    sourceTimestamp: "2026-07-17T00:06:00.000Z"
  });
  assert.equal(outsideWindow, null);
  store.close();
});

test("control observation collisions reject explicit conflicting events and ambiguous aliases", () => {
  const { paths } = fixture();
  const store = initializeControlStore({ paths });
  const first = event({
    event_uid: "first",
    source_identity: undefined,
    source_event_id: "source-first",
    source_namespace: "prompt_hook",
    observation_source_id: "shared-source",
    native_turn_id: "turn-1",
    source_timestamp: "2026-07-17T00:00:00.000Z"
  });
  const second = event({
    ...first,
    event_uid: "second",
    source_event_id: "source-second",
    observation_source_id: "second-source",
    native_turn_id: "turn-2"
  });
  store.captureSessionEvent(first);
  store.captureSessionEvent(second);

  assert.throws(
    () => store.resolveEventObservation({
      provider: "codex",
      sessionUid: first.session_uid,
      contextEpoch: first.context_epoch,
      sourceNamespace: "prompt_hook",
      sourceId: "shared-source",
      eventUid: second.event_uid,
      nativeTurnId: first.native_turn_id,
      role: first.role,
      contentHash: first.content_hash,
      sourceTimestamp: first.source_timestamp
    }),
    (error) => error?.code === "control_observation_collision"
  );

  const ambiguous = store.resolveEventObservation({
    provider: "codex",
    sessionUid: first.session_uid,
    contextEpoch: first.context_epoch,
    sourceNamespace: "transcript_message",
    sourceId: "ambiguous-same-text",
    nativeTurnId: null,
    role: first.role,
    contentHash: first.content_hash,
    sourceTimestamp: first.source_timestamp
  });
  assert.equal(ambiguous, null);
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
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('session_events') WHERE (name LIKE '%text%' AND name != 'context_epoch') OR name IN ('report', 'card', 'lesson')").get().count, 0);
  assert.doesNotMatch(readFileSync(paths.controlDatabase, "utf8"), /control-unique-redacted-text/);
  store.close();
});
