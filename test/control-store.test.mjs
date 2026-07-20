import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { pathsFor } from "../src/index.mjs";
import { captureObservedSession, captureSession, normalizeHookEvent } from "../src/capture.mjs";
import { SCHEMA_SQL } from "../src/control-schema.mjs";
import { BlobKeyProvider, EncryptedBlobStore } from "../src/crypto-store.mjs";
import * as controlStoreModule from "../src/control-store.mjs";
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

function reviewJobFixture(initialNow = "2026-07-20T00:00:00.000Z") {
  const { paths } = fixture();
  let currentNow = new Date(initialNow);
  const store = initializeControlStore({ paths, now: () => new Date(currentNow) });
  let sequence = 0;
  return {
    paths,
    store,
    now() {
      return new Date(currentNow);
    },
    advance(milliseconds) {
      currentNow = new Date(currentNow.getTime() + milliseconds);
      return new Date(currentNow);
    },
    capture(overrides = {}) {
      sequence += 1;
      const suffix = String(sequence).padStart(4, "0");
      return store.captureSessionEvent(event({
        event_uid: `review-event-${suffix}`,
        session_uid: "review-session",
        source_event_id: `review-source-${suffix}`,
        content_hash: createHash("sha256").update(`review-${suffix}`).digest("hex"),
        encrypted_raw_ref: `/private/blobs/review-${suffix}.enc`,
        ...overrides
      }));
    }
  };
}

function canonicalAliasEvent(overrides = {}) {
  return event({
    event_uid: "alias-matrix-event",
    session_uid: "alias-matrix-session",
    cli: "codex",
    context_epoch: 7,
    source_event_id: "alias-matrix-source-event",
    source_namespace: "prompt_hook",
    observation_source_id: "alias-matrix-source",
    source_offset: 11,
    capture_source: "prompt_hook",
    native_turn_id: "alias-matrix-turn",
    source_timestamp: "2026-07-20T01:00:00.000Z",
    referent_event_uid: "alias-matrix-referent",
    content_hash: "b".repeat(64),
    completeness: "prompt_only",
    encrypted_raw_ref: "/private/blobs/alias-matrix.enc",
    source_identity: undefined,
    ...overrides
  });
}

const CAPTURE_ALIAS_CASES = [
  [
    "source_provider/provider/cli",
    { source_provider: "codex", provider: "codex", cli: "codex" },
    { source_provider: "codex", provider: "claude", cli: "codex" }
  ],
  [
    "session_uid/sessionUid",
    { session_uid: "alias-matrix-session", sessionUid: "alias-matrix-session" },
    { session_uid: "alias-matrix-session", sessionUid: "other-session" }
  ],
  [
    "context_epoch/contextEpoch",
    { context_epoch: 7, contextEpoch: 7 },
    { context_epoch: 7, contextEpoch: 8 }
  ],
  [
    "source_event_id/sourceEventId",
    { source_event_id: "alias-matrix-source-event", sourceEventId: "alias-matrix-source-event" },
    { source_event_id: "alias-matrix-source-event", sourceEventId: "other-source-event" }
  ],
  [
    "source_namespace/sourceNamespace",
    { source_namespace: "prompt_hook", sourceNamespace: "prompt_hook" },
    { source_namespace: "prompt_hook", sourceNamespace: "transcript_message" }
  ],
  [
    "source_id/sourceId/observation_source_id",
    {
      source_id: "alias-matrix-source",
      sourceId: "alias-matrix-source",
      observation_source_id: "alias-matrix-source"
    },
    {
      source_id: "alias-matrix-source",
      sourceId: "other-source",
      observation_source_id: "alias-matrix-source"
    }
  ],
  [
    "event_uid/eventUid",
    { event_uid: "alias-matrix-event", eventUid: "alias-matrix-event" },
    { event_uid: "alias-matrix-event", eventUid: "other-event" }
  ],
  [
    "source_offset/sourceOffset",
    { source_offset: 11, sourceOffset: 11 },
    { source_offset: 11, sourceOffset: 12 }
  ],
  [
    "native_turn_id/nativeTurnId/native_turn",
    {
      native_turn_id: "alias-matrix-turn",
      nativeTurnId: "alias-matrix-turn",
      native_turn: "alias-matrix-turn"
    },
    {
      native_turn_id: "alias-matrix-turn",
      nativeTurnId: "other-turn",
      native_turn: "alias-matrix-turn"
    }
  ],
  [
    "source_timestamp/sourceTimestamp",
    {
      source_timestamp: "2026-07-20T01:00:00.000Z",
      sourceTimestamp: "2026-07-20T01:00:00.000Z"
    },
    {
      source_timestamp: "2026-07-20T01:00:00.000Z",
      sourceTimestamp: "2026-07-20T01:01:00.000Z"
    }
  ],
  [
    "referent_event_uid/referentEventUid",
    { referent_event_uid: "alias-matrix-referent", referentEventUid: "alias-matrix-referent" },
    { referent_event_uid: "alias-matrix-referent", referentEventUid: "other-referent" }
  ],
  [
    "content_hash/contentHash",
    { content_hash: "b".repeat(64), contentHash: "b".repeat(64) },
    { content_hash: "b".repeat(64), contentHash: "c".repeat(64) }
  ],
  [
    "completeness/capture_completeness",
    { completeness: "prompt_only", capture_completeness: "prompt_only" },
    { completeness: "prompt_only", capture_completeness: "partial" }
  ],
  [
    "capture_source/captureSource",
    { capture_source: "prompt_hook", captureSource: "prompt_hook" },
    { capture_source: "prompt_hook", captureSource: "transcript_payload" }
  ],
  [
    "encrypted_raw_ref/encryptedRawRef",
    {
      encrypted_raw_ref: "/private/blobs/alias-matrix.enc",
      encryptedRawRef: "/private/blobs/alias-matrix.enc"
    },
    {
      encrypted_raw_ref: "/private/blobs/alias-matrix.enc",
      encryptedRawRef: "/private/blobs/other.enc"
    }
  ]
];

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

test("runtime open rejects every malformed canonical v1 schema signature", () => {
  const mutations = [
    [
      "required column",
      ["outcome TEXT NOT NULL, reason_code TEXT, UNIQUE(document_sha256", "outcome TEXT NOT NULL, UNIQUE(document_sha256"]
    ],
    [
      "column type",
      ["sessions(session_uid TEXT PRIMARY KEY, cli TEXT NOT NULL, project_id TEXT, context_epoch INTEGER NOT NULL", "sessions(session_uid TEXT PRIMARY KEY, cli TEXT NOT NULL, project_id TEXT, context_epoch TEXT NOT NULL"]
    ],
    [
      "not-null constraint",
      ["store_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)", "store_meta(key TEXT PRIMARY KEY, value TEXT)"]
    ],
    [
      "default value",
      ["attempt INTEGER NOT NULL DEFAULT 0, launch_epoch", "attempt INTEGER NOT NULL DEFAULT 1, launch_epoch"]
    ],
    [
      "primary key",
      ["store_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)", "store_meta(key TEXT, value TEXT NOT NULL)"]
    ],
    [
      "unique constraint",
      ["reviewer_jobs(job_id TEXT PRIMARY KEY, source_identity TEXT NOT NULL UNIQUE", "reviewer_jobs(job_id TEXT PRIMARY KEY, source_identity TEXT NOT NULL"]
    ],
    [
      "foreign key",
      ["session_events(event_uid TEXT PRIMARY KEY, session_uid TEXT NOT NULL REFERENCES sessions(session_uid)", "session_events(event_uid TEXT PRIMARY KEY, session_uid TEXT NOT NULL"]
    ]
  ];

  for (const [label, [original, replacement]] of mutations) {
    const { paths } = fixture();
    mkdirSync(path.dirname(paths.controlDatabase), { recursive: true, mode: 0o700 });
    const malformedSchema = SCHEMA_SQL.replace(original, replacement);
    assert.notEqual(malformedSchema, SCHEMA_SQL, `${label} mutation must alter the schema fixture`);
    const database = new DatabaseSync(paths.controlDatabase);
    database.exec(malformedSchema);
    database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(1, "2026-07-17T00:00:00.000Z");
    database.close();
    chmodSync(paths.controlDatabase, 0o600);
    const before = readFileSync(paths.controlDatabase);

    assert.throws(
      () => openControlStore({ paths }),
      (error) => error?.code === CONTROL_SCHEMA_MISMATCH,
      `${label} mismatch must fail closed with the fixed schema error`
    );
    assert.deepEqual(readFileSync(paths.controlDatabase), before, `${label} mismatch must not mutate the database`);
  }
});

test("runtime open rejects undeclared generated columns", () => {
  const { paths } = fixture();
  mkdirSync(path.dirname(paths.controlDatabase), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(paths.controlDatabase);
  database.exec(SCHEMA_SQL);
  database.exec("ALTER TABLE store_meta ADD COLUMN shadow TEXT GENERATED ALWAYS AS (value) VIRTUAL");
  database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(1, "2026-07-17T00:00:00.000Z");
  database.close();
  chmodSync(paths.controlDatabase, 0o600);
  const before = readFileSync(paths.controlDatabase);

  assert.throws(
    () => openControlStore({ paths }),
    (error) => error?.code === CONTROL_SCHEMA_MISMATCH
  );
  assert.deepEqual(readFileSync(paths.controlDatabase), before);
});

test("runtime open rejects noncanonical unique index collation", () => {
  const { paths } = fixture();
  mkdirSync(path.dirname(paths.controlDatabase), { recursive: true, mode: 0o700 });
  const replacement = "reviewer_jobs(job_id TEXT PRIMARY KEY, source_identity TEXT COLLATE NOCASE NOT NULL UNIQUE";
  const schema = SCHEMA_SQL.replace(
    "reviewer_jobs(job_id TEXT PRIMARY KEY, source_identity TEXT NOT NULL UNIQUE",
    replacement
  );
  assert.notEqual(schema, SCHEMA_SQL, "collation mutation must alter the schema fixture");
  const database = new DatabaseSync(paths.controlDatabase);
  database.exec(schema);
  database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(1, "2026-07-17T00:00:00.000Z");
  database.close();
  chmodSync(paths.controlDatabase, 0o600);
  const before = readFileSync(paths.controlDatabase);

  assert.throws(
    () => openControlStore({ paths }),
    (error) => error?.code === CONTROL_SCHEMA_MISMATCH
  );
  assert.deepEqual(readFileSync(paths.controlDatabase), before);
});

test("runtime open rejects undeclared CHECK constraints", () => {
  const { paths } = fixture();
  mkdirSync(path.dirname(paths.controlDatabase), { recursive: true, mode: 0o700 });
  const schema = SCHEMA_SQL.replace(
    "cli TEXT NOT NULL, project_id TEXT",
    "cli TEXT NOT NULL CHECK(cli='claude'), project_id TEXT"
  );
  assert.notEqual(schema, SCHEMA_SQL, "CHECK mutation must alter the schema fixture");
  const database = new DatabaseSync(paths.controlDatabase);
  database.exec(schema);
  database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(1, "2026-07-17T00:00:00.000Z");
  database.close();
  chmodSync(paths.controlDatabase, 0o600);
  const before = readFileSync(paths.controlDatabase);

  assert.throws(
    () => openControlStore({ paths }),
    (error) => error?.code === CONTROL_SCHEMA_MISMATCH
  );
  assert.deepEqual(readFileSync(paths.controlDatabase), before);
});

test("runtime open rejects undeclared user triggers", () => {
  const { paths } = fixture();
  mkdirSync(path.dirname(paths.controlDatabase), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(paths.controlDatabase);
  database.exec(SCHEMA_SQL);
  database.exec("CREATE TRIGGER reject_sessions BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'blocked'); END");
  database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(1, "2026-07-17T00:00:00.000Z");
  database.close();
  chmodSync(paths.controlDatabase, 0o600);
  const before = readFileSync(paths.controlDatabase);

  assert.throws(
    () => openControlStore({ paths }),
    (error) => error?.code === CONTROL_SCHEMA_MISMATCH
  );
  assert.deepEqual(readFileSync(paths.controlDatabase), before);
});

test("runtime open rejects undeclared user views", () => {
  const { paths } = fixture();
  const initialized = initializeControlStore({ paths });
  initialized.database.exec("CREATE VIEW session_projection AS SELECT session_uid, cli FROM sessions");
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

test("direct observation resolution enforces and adopts the persisted encrypted ref", () => {
  const { paths } = fixture();
  const store = initializeControlStore({ paths });
  const canonical = event({
    event_uid: "direct-ref-event",
    source_identity: undefined,
    source_event_id: "direct-ref-source",
    source_namespace: "prompt_hook",
    observation_source_id: "direct-ref-observation",
    native_turn_id: "direct-ref-turn",
    source_timestamp: "2026-07-17T00:00:00.000Z",
    encrypted_raw_ref: "/private/blobs/direct-ref.enc"
  });
  store.captureSessionEvent(canonical);
  const observation = {
    provider: canonical.cli,
    sessionUid: canonical.session_uid,
    contextEpoch: canonical.context_epoch,
    sourceNamespace: "transcript_message",
    eventUid: canonical.event_uid,
    nativeTurnId: canonical.native_turn_id,
    role: canonical.role,
    contentHash: canonical.content_hash,
    sourceTimestamp: canonical.source_timestamp
  };

  assert.throws(
    () => store.resolveEventObservation({
      ...observation,
      sourceId: "direct-ref-mismatch",
      encryptedRawRef: "/private/blobs/different.enc"
    }),
    (error) => error?.code === "control_observation_collision"
  );
  const adopted = store.resolveEventObservation({
    ...observation,
    sourceId: "direct-ref-adopted"
  });
  assert.equal(adopted.encrypted_raw_ref, canonical.encrypted_raw_ref);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count, 2);
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

test("control observation exact-turn alias replay is idempotent", () => {
  const { paths } = fixture();
  const store = initializeControlStore({ paths });
  const canonical = event({
    event_uid: "canonical-exact-replay",
    source_identity: undefined,
    source_event_id: "prompt-exact-replay",
    source_namespace: "prompt_hook",
    observation_source_id: "prompt-exact-replay",
    native_turn_id: "turn-exact-replay",
    source_timestamp: "2026-07-17T00:00:00.000Z"
  });
  const observation = {
    provider: "codex",
    sessionUid: canonical.session_uid,
    contextEpoch: canonical.context_epoch,
    sourceNamespace: "transcript_exact_replay",
    sourceId: "transcript-exact-replay",
    nativeTurnId: canonical.native_turn_id,
    role: canonical.role,
    contentHash: canonical.content_hash,
    sourceTimestamp: "2026-07-17T00:04:00.000Z"
  };
  store.captureSessionEvent(canonical);

  const first = store.resolveEventObservation(observation);
  const replay = store.resolveEventObservation(observation);

  assert.equal(first.event_uid, canonical.event_uid);
  assert.equal(first.duplicate, false);
  assert.equal(replay.event_uid, canonical.event_uid);
  assert.equal(replay.duplicate, true);
  store.close();
});

test("control observation null-turn fallback replay is idempotent", () => {
  const { paths } = fixture();
  const store = initializeControlStore({ paths });
  const canonical = event({
    event_uid: "canonical-null-replay",
    source_identity: undefined,
    source_event_id: "prompt-null-replay",
    source_namespace: "prompt_hook",
    observation_source_id: "prompt-null-replay",
    native_turn_id: null,
    source_timestamp: "2026-07-17T00:00:00.000Z"
  });
  const observation = {
    provider: "codex",
    sessionUid: canonical.session_uid,
    contextEpoch: canonical.context_epoch,
    sourceNamespace: "transcript_null_replay",
    sourceId: "transcript-null-replay",
    nativeTurnId: "turn-null-fallback",
    role: canonical.role,
    contentHash: canonical.content_hash,
    sourceTimestamp: canonical.source_timestamp
  };
  store.captureSessionEvent(canonical);

  const first = store.resolveEventObservation(observation);
  const replay = store.resolveEventObservation(observation);

  assert.equal(first.event_uid, canonical.event_uid);
  assert.equal(first.duplicate, false);
  assert.equal(replay.event_uid, canonical.event_uid);
  assert.equal(replay.duplicate, true);
  store.close();
});

test("control observation replay preserves an omitted optional context epoch", () => {
  const { paths } = fixture();
  const store = initializeControlStore({ paths });
  const canonical = event({
    event_uid: "canonical-null-context-replay",
    source_identity: undefined,
    source_event_id: "prompt-null-context-replay",
    source_namespace: "prompt_hook",
    observation_source_id: "prompt-null-context-replay",
    native_turn_id: "turn-null-context-replay",
    source_timestamp: "2026-07-17T00:00:00.000Z"
  });
  const observation = {
    provider: "codex",
    sessionUid: canonical.session_uid,
    sourceNamespace: "transcript_null_context_replay",
    sourceId: "transcript-null-context-replay",
    nativeTurnId: canonical.native_turn_id,
    role: canonical.role,
    contentHash: canonical.content_hash,
    sourceTimestamp: canonical.source_timestamp
  };
  store.captureSessionEvent(canonical);

  const first = store.resolveEventObservation(observation);
  const replay = store.resolveEventObservation(observation);

  assert.equal(first.event_uid, canonical.event_uid);
  assert.equal(first.duplicate, false);
  assert.equal(replay.event_uid, canonical.event_uid);
  assert.equal(replay.duplicate, true);
  store.close();
});

test("control observation alias replay rejects changed immutable input", () => {
  const { paths } = fixture();
  const store = initializeControlStore({ paths });
  const canonical = event({
    event_uid: "canonical-replay-collision",
    source_identity: undefined,
    source_event_id: "prompt-replay-collision",
    source_namespace: "prompt_hook",
    observation_source_id: "prompt-replay-collision",
    native_turn_id: "turn-replay-collision",
    source_timestamp: "2026-07-17T00:00:00.000Z"
  });
  const observation = {
    provider: "codex",
    sessionUid: canonical.session_uid,
    contextEpoch: canonical.context_epoch,
    sourceNamespace: "transcript_replay_collision",
    sourceId: "transcript-replay-collision",
    nativeTurnId: canonical.native_turn_id,
    role: canonical.role,
    contentHash: canonical.content_hash,
    sourceTimestamp: "2026-07-17T00:04:00.000Z"
  };
  store.captureSessionEvent(canonical);
  store.resolveEventObservation(observation);

  for (const mutation of [
    { nativeTurnId: "different-turn" },
    { sourceTimestamp: "2026-07-17T00:03:00.000Z" },
    { role: "assistant" },
    { contentHash: "b".repeat(64) },
    { captureSource: "codex:different_capture_source" }
  ]) {
    assert.throws(
      () => store.resolveEventObservation({ ...observation, ...mutation }),
      (error) => error?.code === "control_observation_collision"
    );
  }
  store.close();
});

test("public control capture replay rejects changed bounded event identity", async () => {
  const { store, blobs } = controlCaptureFixture();
  const immutableEvent = event({
    event_uid: "public-identity-event",
    source_identity: undefined,
    source_event_id: "public-source-one",
    source_namespace: "prompt_hook",
    observation_source_id: "public-observation-one",
    source_offset: 100,
    referent_event_uid: "assistant-one",
    native_turn_id: "turn-public-identity",
    source_timestamp: "2026-07-17T04:00:00.000Z",
    encrypted_raw_ref: null
  });

  const first = await captureObservedSession({
    store,
    blobs,
    event: { ...immutableEvent },
    rawText: "bounded public identity"
  });
  const replay = await captureObservedSession({
    store,
    blobs,
    event: { ...immutableEvent },
    rawText: "bounded public identity"
  });

  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  const outcomes = [];
  for (const [label, mutation] of [
    ["referent", { referent_event_uid: "assistant-two" }],
    ["source event", { source_event_id: "public-source-two" }],
    ["completeness", { completeness: "partial" }],
    ["source offset", { source_offset: 101 }],
    ["invalid source offset", { source_offset: "100" }]
  ]) {
    try {
      const result = await captureObservedSession({
        store,
        blobs,
        event: { ...immutableEvent, ...mutation },
        rawText: "bounded public identity"
      });
      outcomes.push([label, result.duplicate ? "duplicate" : "new"]);
    } catch (error) {
      outcomes.push([
        label,
        error?.code || (/source_offset.*bounded non-negative integer/i.test(error?.message || "")
          ? "invalid_source_offset"
          : error?.message)
      ]);
    }
  }
  assert.deepEqual(outcomes, [
    ["referent", "control_observation_collision"],
    ["source event", "control_observation_collision"],
    ["completeness", "control_observation_collision"],
    ["source offset", "control_observation_collision"],
    ["invalid source offset", "invalid_source_offset"]
  ]);
  assert.deepEqual(store.getSessionEvent(immutableEvent.event_uid), {
    event_uid: immutableEvent.event_uid,
    session_uid: immutableEvent.session_uid,
    source_event_id: immutableEvent.source_event_id,
    source_identity: JSON.stringify([
      immutableEvent.cli,
      immutableEvent.session_uid,
      immutableEvent.context_epoch,
      immutableEvent.source_namespace,
      immutableEvent.observation_source_id
    ]),
    role: immutableEvent.role,
    referent_event_uid: immutableEvent.referent_event_uid,
    content_hash: immutableEvent.content_hash,
    encrypted_raw_ref: first.blobPath,
    completeness: immutableEvent.completeness
  });
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 1);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count, 1);
  store.close();
});

test("public control capture treats capture source as bounded canonical identity", async () => {
  const { store, blobs } = controlCaptureFixture();
  const canonical = event({
    event_uid: "public-capture-source-event",
    source_identity: undefined,
    source_event_id: "public-capture-source-event",
    source_namespace: "prompt_hook",
    observation_source_id: "public-capture-source-observation",
    capture_source: "prompt_hook",
    source_offset: 4,
    native_turn_id: "public-capture-source-turn",
    source_timestamp: "2026-07-17T08:00:00.000Z",
    encrypted_raw_ref: null
  });

  const first = await captureObservedSession({
    store,
    blobs,
    event: { ...canonical },
    rawText: "public capture source evidence"
  });

  assert.equal(first.duplicate, false);
  await assert.rejects(
    captureObservedSession({
      store,
      blobs,
      event: { ...canonical, capture_source: "transcript_payload" },
      rawText: "public capture source evidence"
    }),
    (error) => error?.code === "control_observation_collision"
  );
  await assert.rejects(
    captureObservedSession({
      store,
      blobs,
      event: { ...canonical, capture_source: "x".repeat(257) },
      rawText: "public capture source evidence"
    }),
    /capture_source.*bounded non-empty string/i
  );
  assert.deepEqual(
    { ...store.database.prepare(`SELECT capture_source FROM event_observations
      WHERE source_id=?`).get(canonical.observation_source_id) },
    { capture_source: canonical.capture_source }
  );
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 1);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count, 1);
  store.close();
});

test("direct control capture replay compares the complete canonical identity", () => {
  const { paths } = fixture();
  const store = initializeControlStore({ paths });
  const canonical = event({
    event_uid: "direct-canonical-event",
    source_identity: undefined,
    source_event_id: "direct-source-one",
    source_namespace: "prompt_hook",
    observation_source_id: "direct-observation-one",
    source_offset: 8,
    capture_source: "prompt_hook",
    native_turn_id: "direct-canonical-turn",
    source_timestamp: "2026-07-17T08:10:00.000Z"
  });

  assert.equal(store.captureSessionEvent({ ...canonical }).duplicate, false);
  assert.equal(store.captureSessionEvent({ ...canonical }).duplicate, true);
  for (const mutation of [
    { source_event_id: "direct-source-two" },
    { source_offset: 9 },
    { capture_source: "transcript_payload" }
  ]) {
    assert.throws(
      () => store.captureSessionEvent({ ...canonical, ...mutation }),
      (error) => error?.code === "control_observation_collision"
    );
  }
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 1);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count, 1);
  store.close();
});

test("prepared capture freezes the body-free identity and keeps raw blob hashing separate", () => {
  const callerEvent = event({
    event_uid: "prepared-event",
    source_identity: undefined,
    source_event_id: "prepared-source",
    source_namespace: "prompt_hook",
    observation_source_id: "prepared-observation",
    capture_source: "prompt_hook",
    encrypted_raw_ref: null,
    content_hash: "a".repeat(64)
  });
  const prepared = controlStoreModule.prepareCapture({
    event: callerEvent,
    rawText: "raw evidence with a wider payload"
  });
  callerEvent.capture_source = "caller-mutated";
  callerEvent.content_hash = "b".repeat(64);

  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.identity), true);
  assert.equal(prepared.identity.capture_source, "prompt_hook");
  assert.equal(prepared.identity.content_hash, "a".repeat(64));
  assert.equal(
    prepared.blobContentHash,
    createHash("sha256").update("raw evidence with a wider payload").digest("hex")
  );
  assert.notEqual(prepared.blobContentHash, prepared.identity.content_hash);
  assert.equal("rawText" in prepared, false);
  assert.equal("encrypted_raw_ref" in prepared.identity, false);
});

test("public capture rejects a supplied encrypted ref mismatch before database resolution", async () => {
  const { store } = controlCaptureFixture();
  let blobWrites = 0;
  const blobs = {
    async write() {
      blobWrites += 1;
      return "/private/blobs/writer-authoritative.enc";
    }
  };
  const callerEvent = event({
    event_uid: "supplied-ref-mismatch",
    source_identity: undefined,
    source_event_id: "supplied-ref-source",
    source_namespace: "prompt_hook",
    observation_source_id: "supplied-ref-observation",
    encrypted_raw_ref: "/private/blobs/caller-supplied.enc"
  });

  await assert.rejects(
    captureObservedSession({ store, blobs, event: callerEvent, rawText: "reference mismatch evidence" }),
    (error) => error?.code === "control_observation_collision"
  );
  assert.equal(blobWrites, 1);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 0);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count, 0);
  store.close();
});

test("public control capture rejects invalid blob writer refs before store resolution", async () => {
  for (const [caseName, writerRef] of [
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["non-string", 42],
    ["overlong", "/private/blobs/" + "x".repeat(4096)]
  ]) {
    const { store } = controlCaptureFixture();
    let blobWrites = 0;
    let resolveCalls = 0;
    store.resolveOrInsertCapture = () => {
      resolveCalls += 1;
      throw new Error("public writer ref reached the control store");
    };
    const blobs = {
      async write() {
        blobWrites += 1;
        return writerRef;
      }
    };

    await assert.rejects(
      captureObservedSession({
        store,
        blobs,
        event: event({
          event_uid: `invalid-writer-ref-${caseName}`,
          source_identity: undefined,
          source_event_id: `invalid-writer-source-${caseName}`,
          source_namespace: "prompt_hook",
          observation_source_id: `invalid-writer-observation-${caseName}`,
          encrypted_raw_ref: null
        }),
        rawText: "invalid writer reference evidence"
      }),
      /authoritativeEncryptedRef must be a bounded non-empty string/
    );
    assert.equal(blobWrites, 1);
    assert.equal(resolveCalls, 0);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 0);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count, 0);
    store.close();
  }
});

test("control captureSession returns the frozen atomic event view", async () => {
  const { store } = controlCaptureFixture();
  let blobWrites = 0;
  const blobs = {
    async write() {
      blobWrites += 1;
      return "/private/blobs/control-capture-session.enc";
    }
  };
  const callerEvent = event({
    event_uid: "control-capture-session-event",
    source_identity: undefined,
    source_event_id: "control-capture-session-source",
    source_namespace: "prompt_hook",
    observation_source_id: "control-capture-session-observation",
    encrypted_raw_ref: null
  });

  const result = await captureSession({ store, blobs, event: callerEvent, rawText: "control capture evidence" });

  assert.equal(blobWrites, 2);
  assert.equal(result.kind, "new");
  assert.equal(result.eventUid, callerEvent.event_uid);
  assert.equal(result.event, result.eventView);
  assert.notEqual(result.event, callerEvent);
  assert.equal(result.eventView.encrypted_raw_ref, "/private/blobs/control-capture-session.enc");
  assert.equal(callerEvent.encrypted_raw_ref, null);
  store.close();
});

test("public and direct exact replay return one persisted event and blob ref", async () => {
  const { store, blobs } = controlCaptureFixture();
  const canonical = event({
    event_uid: "consistent-replay-event",
    source_identity: undefined,
    source_event_id: "consistent-replay-source",
    source_namespace: "prompt_hook",
    observation_source_id: "consistent-replay-observation",
    source_offset: 12,
    capture_source: "prompt_hook",
    referent_event_uid: "consistent-replay-referent",
    native_turn_id: "consistent-replay-turn",
    source_timestamp: "2026-07-17T08:20:00.000Z",
    encrypted_raw_ref: null
  });
  const first = await captureObservedSession({
    store, blobs, event: { ...canonical }, rawText: "consistent raw evidence"
  });
  const publicReplay = await captureObservedSession({
    store,
    blobs,
    event: { ...canonical, encrypted_raw_ref: first.blobPath },
    rawText: "consistent raw evidence"
  });
  const directReplay = store.captureSessionEvent({
    ...canonical,
    encrypted_raw_ref: first.blobPath
  });

  for (const result of [first, publicReplay, directReplay]) {
    assert.equal(result.eventUid, canonical.event_uid);
    assert.equal(result.event_uid, canonical.event_uid);
    assert.equal(result.blobPath, first.blobPath);
    assert.equal(result.eventView.encrypted_raw_ref, first.blobPath);
    assert.equal(result.event, result.eventView);
    assert.notEqual(result.event, canonical);
  }
  assert.equal(first.kind, "new");
  assert.equal(publicReplay.kind, "exact_replay");
  assert.equal(directReplay.kind, "exact_replay");
  assert.deepEqual([first.duplicate, publicReplay.duplicate, directReplay.duplicate], [false, true, true]);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 1);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count, 1);
  store.close();
});

test("invalid canonical capture identity is rejected before blob or database side effects", async () => {
  for (const mutation of [
    { event_uid: "" },
    { content_hash: "" },
    { content_hash: "a".repeat(129) },
    { capture_source: "" },
    { capture_source: "x".repeat(257) },
    { capture_source: "prompt_hook", captureSource: "transcript_payload" }
  ]) {
    const { store } = controlCaptureFixture();
    let blobWrites = 0;
    const blobs = {
      async write() {
        blobWrites += 1;
        return "/private/blobs/unexpected.enc";
      }
    };
    const invalid = event({
      event_uid: "invalid-canonical-event",
      source_identity: undefined,
      source_event_id: "invalid-canonical-source",
      source_namespace: "prompt_hook",
      observation_source_id: "invalid-canonical-observation",
      encrypted_raw_ref: null,
      ...mutation
    });

    await assert.rejects(
      captureObservedSession({ store, blobs, event: invalid, rawText: "must not be written" }),
      /event_uid|content_hash|capture_source|captureSource/i
    );
    assert.equal(blobWrites, 0);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 0);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count, 0);
    store.close();
  }
});

test("public capture rejects conflicting aliases before blob or database side effects", async (t) => {
  for (const [caseName, , conflictingAliases] of CAPTURE_ALIAS_CASES) {
    await t.test(caseName, async () => {
      const { store } = controlCaptureFixture();
      let blobWrites = 0;
      const blobs = {
        async write() {
          blobWrites += 1;
          return "/private/blobs/alias-matrix.enc";
        }
      };
      let rejected = false;
      try {
        await captureObservedSession({
          store,
          blobs,
          event: canonicalAliasEvent(conflictingAliases),
          rawText: "conflicting alias evidence"
        });
      } catch {
        rejected = true;
      }
      const outcome = {
        rejected,
        blobWrites,
        sessions: store.database.prepare("SELECT COUNT(*) AS count FROM sessions").get().count,
        events: store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count,
        observations: store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count
      };
      store.close();

      assert.deepEqual(outcome, {
        rejected: true,
        blobWrites: 0,
        sessions: 0,
        events: 0,
        observations: 0
      });
    });
  }
});

test("direct capture uses the shared conflict-validating alias normalizer", () => {
  const { paths } = fixture();
  const store = initializeControlStore({ paths });
  let rejected = false;
  try {
    store.captureSessionEvent(canonicalAliasEvent({
      event_uid: "alias-matrix-event",
      eventUid: "other-event"
    }));
  } catch {
    rejected = true;
  }
  const outcome = {
    rejected,
    sessions: store.database.prepare("SELECT COUNT(*) AS count FROM sessions").get().count,
    events: store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count,
    observations: store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count
  };
  store.close();

  assert.deepEqual(outcome, {
    rejected: true,
    sessions: 0,
    events: 0,
    observations: 0
  });
});

test("equivalent duplicate aliases normalize identically in public and direct capture", async () => {
  const { store } = controlCaptureFixture();
  const equivalentAliases = CAPTURE_ALIAS_CASES.reduce(
    (aliases, [, equivalent]) => Object.assign(aliases, equivalent),
    {}
  );
  let blobWrites = 0;
  const blobs = {
    async write() {
      blobWrites += 1;
      return "/private/blobs/alias-matrix.enc";
    }
  };
  const canonical = canonicalAliasEvent(equivalentAliases);

  const first = await captureObservedSession({
    store,
    blobs,
    event: { ...canonical },
    rawText: "equivalent alias evidence"
  });
  const directReplay = store.captureSessionEvent({ ...canonical });

  assert.equal(blobWrites, 2);
  assert.equal(first.kind, "new");
  assert.equal(directReplay.kind, "exact_replay");
  assert.equal(directReplay.eventUid, first.eventUid);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 1);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count, 1);
  store.close();
});

test("public capture uses one frozen snapshot across the blob await", async () => {
  const { store } = controlCaptureFixture();
  let firstWriteStartedResolve;
  let releaseFirstWriteResolve;
  const firstWriteStarted = new Promise((resolve) => { firstWriteStartedResolve = resolve; });
  const releaseFirstWrite = new Promise((resolve) => { releaseFirstWriteResolve = resolve; });
  let blobWrites = 0;
  const blobs = {
    async write() {
      blobWrites += 1;
      if (blobWrites === 1) {
        firstWriteStartedResolve();
        await releaseFirstWrite;
      }
      return "/private/blobs/frozen-snapshot.enc";
    }
  };
  const callerEvent = event({
    event_uid: "frozen-event",
    session_uid: "frozen-session",
    project_id: "frozen-project",
    source_identity: undefined,
    source_event_id: "frozen-source",
    source_namespace: "prompt_hook",
    observation_source_id: "frozen-observation",
    capture_source: "prompt_hook",
    content_hash: "a".repeat(64),
    encrypted_raw_ref: null
  });
  const pending = captureObservedSession({ store, blobs, event: callerEvent, rawText: "frozen raw evidence" });
  await firstWriteStarted;
  Object.assign(callerEvent, {
    event_uid: "mutated-event",
    project_id: "mutated-project",
    capture_source: "",
    content_hash: "b".repeat(64),
    encrypted_raw_ref: "/private/blobs/mutated.enc"
  });
  releaseFirstWriteResolve();
  const result = await pending;

  assert.equal(blobWrites, 2);
  assert.equal(result.kind, "new");
  assert.equal(result.eventUid, "frozen-event");
  assert.equal(result.blobPath, "/private/blobs/frozen-snapshot.enc");
  assert.notEqual(result.event, callerEvent);
  assert.deepEqual(store.getSessionEvent("frozen-event"), {
    event_uid: "frozen-event",
    session_uid: "frozen-session",
    source_event_id: "frozen-source",
    source_identity: '["codex","frozen-session",1,"prompt_hook","frozen-observation"]',
    role: "user",
    referent_event_uid: null,
    content_hash: "a".repeat(64),
    encrypted_raw_ref: "/private/blobs/frozen-snapshot.enc",
    completeness: "prompt_only"
  });
  assert.equal(
    store.database.prepare("SELECT project_id FROM sessions WHERE session_uid=?").get("frozen-session").project_id,
    "frozen-project"
  );
  assert.equal(store.getSessionEvent("mutated-event"), null);
  store.close();
});

test("control observation alias checks the complete timestamp window before bounding candidates", () => {
  const { paths } = fixture();
  const store = initializeControlStore({ paths });
  for (let index = 0; index < 31; index += 1) {
    store.captureSessionEvent(event({
      event_uid: `older-${index}`,
      source_identity: undefined,
      source_event_id: `older-source-${index}`,
      source_namespace: "prompt_hook",
      observation_source_id: `older-source-${index}`,
      native_turn_id: "turn-shared",
      source_timestamp: `2026-07-17T00:${String(index).padStart(2, "0")}:00.000Z`,
      encrypted_raw_ref: `/private/blobs/older-${index}.enc`
    }));
  }
  for (const [eventUid, sourceTimestamp] of [
    ["qualifying-before-old-limit", "2026-07-17T00:56:00.000Z"],
    ["qualifying-after-old-limit", "2026-07-17T01:00:00.000Z"]
  ]) {
    store.captureSessionEvent(event({
      event_uid: eventUid,
      source_identity: undefined,
      source_event_id: `${eventUid}-source`,
      source_namespace: "prompt_hook",
      observation_source_id: `${eventUid}-source`,
      native_turn_id: "turn-shared",
      source_timestamp: sourceTimestamp,
      encrypted_raw_ref: `/private/blobs/${eventUid}.enc`
    }));
  }

  const resolved = store.resolveEventObservation({
    provider: "codex",
    sessionUid: "session-1",
    contextEpoch: 1,
    sourceNamespace: "transcript_message",
    sourceId: "ambiguous-beyond-old-limit",
    nativeTurnId: "turn-shared",
    role: "user",
    contentHash: "a".repeat(64),
    sourceTimestamp: "2026-07-17T01:00:00.000Z"
  });

  assert.equal(resolved, null);
  assert.equal(
    store.database.prepare("SELECT COUNT(*) AS count FROM event_observations WHERE source_id=?").get("ambiguous-beyond-old-limit").count,
    0
  );
  store.close();
});

test("control observation exact-turn alias never crosses provider identity", () => {
  const { paths } = fixture();
  const store = initializeControlStore({ paths });
  const claudeEvent = event({
    event_uid: "claude-exact-turn",
    cli: "claude",
    source_identity: undefined,
    source_event_id: "claude-exact-source",
    source_namespace: "prompt_hook",
    observation_source_id: "claude-exact-source",
    native_turn_id: "shared-turn",
    source_timestamp: "2026-07-17T03:00:00.000Z"
  });
  store.captureSessionEvent(claudeEvent);

  const resolved = store.resolveEventObservation({
    provider: "codex",
    sessionUid: claudeEvent.session_uid,
    contextEpoch: claudeEvent.context_epoch,
    sourceNamespace: "transcript_exact",
    sourceId: "codex-exact-source",
    nativeTurnId: claudeEvent.native_turn_id,
    role: claudeEvent.role,
    contentHash: claudeEvent.content_hash,
    sourceTimestamp: "2026-07-17T03:01:00.000Z"
  });

  assert.equal(resolved, null);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations WHERE source_provider='codex'").get().count, 0);
  store.close();
});

test("control observation null-turn fallback never crosses provider identity", () => {
  const { paths } = fixture();
  const store = initializeControlStore({ paths });
  const claudeEvent = event({
    event_uid: "claude-null-turn",
    cli: "claude",
    source_identity: undefined,
    source_event_id: "claude-null-source",
    source_namespace: "prompt_hook",
    observation_source_id: "claude-null-source",
    native_turn_id: null,
    source_timestamp: "2026-07-17T03:00:00.000Z"
  });
  store.captureSessionEvent(claudeEvent);

  const resolved = store.resolveEventObservation({
    provider: "codex",
    sessionUid: claudeEvent.session_uid,
    contextEpoch: claudeEvent.context_epoch,
    sourceNamespace: "transcript_fallback",
    sourceId: "codex-fallback-source",
    nativeTurnId: "codex-turn-with-null-fallback",
    role: claudeEvent.role,
    contentHash: claudeEvent.content_hash,
    sourceTimestamp: "2026-07-17T03:01:00.000Z"
  });

  assert.equal(resolved, null);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations WHERE source_provider='codex'").get().count, 0);
  store.close();
});

test("control observation explicit target rejects a different provider", () => {
  const { paths } = fixture();
  const store = initializeControlStore({ paths });
  const claudeEvent = event({
    event_uid: "claude-explicit-target",
    cli: "claude",
    source_identity: undefined,
    source_event_id: "claude-explicit-source",
    source_namespace: "prompt_hook",
    observation_source_id: "claude-explicit-source",
    native_turn_id: "shared-turn",
    source_timestamp: "2026-07-17T03:00:00.000Z"
  });
  store.captureSessionEvent(claudeEvent);

  assert.throws(
    () => store.resolveEventObservation({
      provider: "codex",
      sessionUid: claudeEvent.session_uid,
      contextEpoch: claudeEvent.context_epoch,
      sourceNamespace: "transcript_explicit",
      sourceId: "codex-explicit-source",
      eventUid: claudeEvent.event_uid,
      nativeTurnId: claudeEvent.native_turn_id,
      role: claudeEvent.role,
      contentHash: claudeEvent.content_hash,
      sourceTimestamp: claudeEvent.source_timestamp
    }),
    (error) => error?.code === "control_observation_collision"
  );
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations WHERE source_provider='codex'").get().count, 0);
  store.close();
});

test("control observation replay rejects an existing cross-provider target", () => {
  const { paths } = fixture();
  const store = initializeControlStore({ paths });
  const claudeEvent = event({
    event_uid: "claude-existing-target",
    cli: "claude",
    source_identity: undefined,
    source_event_id: "claude-existing-source",
    source_namespace: "prompt_hook",
    observation_source_id: "claude-existing-source",
    native_turn_id: "shared-turn",
    source_timestamp: "2026-07-17T03:00:00.000Z"
  });
  store.captureSessionEvent(claudeEvent);
  const sourceNamespace = "transcript_existing";
  const sourceId = "codex-existing-source";
  const observationKey = JSON.stringify(["codex", claudeEvent.session_uid, claudeEvent.context_epoch, sourceNamespace, sourceId]);
  store.database.prepare(`INSERT INTO event_observations
    (observation_uid, observation_key, observation_signature, source_provider, session_uid, context_epoch,
     source_namespace, source_id, observed_event_uid, event_uid, capture_source, observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "legacy-cross-provider-observation", observationKey, "legacy-cross-provider-signature", "codex", claudeEvent.session_uid,
    claudeEvent.context_epoch, sourceNamespace, sourceId, claudeEvent.event_uid,
    claudeEvent.event_uid, "codex:transcript_existing", "2026-07-17T03:01:00.000Z"
  );

  assert.throws(
    () => store.resolveEventObservation({
      provider: "codex",
      sessionUid: claudeEvent.session_uid,
      contextEpoch: claudeEvent.context_epoch,
      sourceNamespace,
      sourceId,
      eventUid: claudeEvent.event_uid,
      nativeTurnId: claudeEvent.native_turn_id,
      role: claudeEvent.role,
      contentHash: claudeEvent.content_hash,
      sourceTimestamp: claudeEvent.source_timestamp
    }),
    (error) => error?.code === "control_observation_collision"
  );
  store.close();
});

test("public control capture keeps one immutable provider per session UID", async () => {
  const { store, blobs } = controlCaptureFixture();
  const sharedSession = "shared-public-session";
  const first = event({
    event_uid: "shared-codex-one",
    session_uid: sharedSession,
    cli: "codex",
    project_id: "project-one",
    context_epoch: 1,
    source_identity: undefined,
    source_event_id: "shared-codex-source-one",
    source_namespace: "prompt_hook",
    observation_source_id: "shared-codex-source-one",
    encrypted_raw_ref: null
  });
  const sameProviderUpdate = event({
    ...first,
    event_uid: "shared-codex-two",
    project_id: "project-two",
    context_epoch: 2,
    source_event_id: "shared-codex-source-two",
    observation_source_id: "shared-codex-source-two",
    content_hash: "b".repeat(64)
  });
  const crossProvider = event({
    ...sameProviderUpdate,
    event_uid: "shared-claude-three",
    cli: "claude",
    project_id: "project-three",
    context_epoch: 3,
    source_event_id: "shared-claude-source-three",
    observation_source_id: "shared-claude-source-three",
    content_hash: "c".repeat(64)
  });

  const firstResult = await captureObservedSession({
    store,
    blobs,
    event: { ...first },
    rawText: "first same-provider event"
  });
  const updateResult = await captureObservedSession({
    store,
    blobs,
    event: { ...sameProviderUpdate },
    rawText: "second same-provider event"
  });
  let crossProviderOutcome;
  try {
    const result = await captureObservedSession({
      store,
      blobs,
      event: { ...crossProvider },
      rawText: "cross-provider event"
    });
    crossProviderOutcome = result.duplicate ? "duplicate" : "new";
  } catch (error) {
    crossProviderOutcome = error?.code || error?.message;
  }

  assert.deepEqual({
    firstDuplicate: firstResult.duplicate,
    updateDuplicate: updateResult.duplicate,
    crossProviderOutcome,
    session: { ...store.database.prepare(`SELECT session_uid, cli, project_id, context_epoch
      FROM sessions WHERE session_uid=?`).get(sharedSession) },
    events: store.database.prepare(`SELECT event_uid, source_provider FROM session_events
      WHERE session_uid=? ORDER BY event_uid`).all(sharedSession).map((row) => ({ ...row }))
  }, {
    firstDuplicate: false,
    updateDuplicate: false,
    crossProviderOutcome: "control_observation_collision",
    session: {
      session_uid: sharedSession,
      cli: "codex",
      project_id: "project-two",
      context_epoch: 2
    },
    events: [
      { event_uid: "shared-codex-one", source_provider: "codex" },
      { event_uid: "shared-codex-two", source_provider: "codex" }
    ]
  });
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

test("concurrent exact capture replay reports one new event and one duplicate", async () => {
  const { store, blobs } = controlCaptureFixture();
  let initialWrites = 0;
  let releaseInitialWrites;
  const initialWriteBarrier = new Promise((resolve) => {
    releaseInitialWrites = resolve;
  });
  const barrieredBlobs = {
    async write(...args) {
      if (initialWrites < 2) {
        initialWrites += 1;
        if (initialWrites === 2) releaseInitialWrites();
        await initialWriteBarrier;
      }
      return blobs.write(...args);
    }
  };
  const immutableEvent = event({
    event_uid: "concurrent-event",
    source_identity: undefined,
    source_event_id: "concurrent-source",
    source_namespace: "prompt_hook",
    observation_source_id: "concurrent-source",
    native_turn_id: "turn-concurrent",
    source_timestamp: "2026-07-17T02:00:00.000Z",
    encrypted_raw_ref: null
  });

  const results = await Promise.all([
    captureObservedSession({ store, blobs: barrieredBlobs, event: { ...immutableEvent }, rawText: "concurrent evidence" }),
    captureObservedSession({ store, blobs: barrieredBlobs, event: { ...immutableEvent }, rawText: "concurrent evidence" })
  ]);

  assert.equal(initialWrites, 2);
  assert.deepEqual(results.map((result) => result.duplicate).sort(), [false, true]);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 1);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count, 1);
  store.close();
});

test("concurrent different first aliases resolve to one event and two observations", async () => {
  const { store, blobs } = controlCaptureFixture();
  let initialWrites = 0;
  let releaseInitialWrites;
  const initialWriteBarrier = new Promise((resolve) => { releaseInitialWrites = resolve; });
  const barrieredBlobs = {
    async write(...args) {
      if (initialWrites < 2) {
        initialWrites += 1;
        if (initialWrites === 2) releaseInitialWrites();
        await initialWriteBarrier;
      }
      return blobs.write(...args);
    }
  };
  const shared = {
    session_uid: "different-alias-session",
    source_identity: undefined,
    native_turn_id: "different-alias-turn",
    source_timestamp: "2026-07-17T09:00:00.000Z",
    content_hash: "d".repeat(64),
    encrypted_raw_ref: null
  };
  const hook = event({
    ...shared,
    event_uid: "different-alias-hook-event",
    source_event_id: "different-alias-hook-source",
    source_namespace: "prompt_hook",
    observation_source_id: "different-alias-hook-observation",
    capture_source: "prompt_hook"
  });
  const transcript = event({
    ...shared,
    event_uid: "different-alias-transcript-event",
    source_event_id: "different-alias-transcript-source",
    source_namespace: "transcript_message",
    observation_source_id: "different-alias-transcript-observation",
    capture_source: "transcript_payload"
  });

  const results = await Promise.all([
    captureObservedSession({ store, blobs: barrieredBlobs, event: hook, rawText: "shared raw evidence" }),
    captureObservedSession({ store, blobs: barrieredBlobs, event: transcript, rawText: "shared raw evidence" })
  ]);

  assert.equal(initialWrites, 2);
  assert.deepEqual(results.map((result) => result.kind).sort(), ["alias", "new"]);
  assert.deepEqual(results.map((result) => result.duplicate).sort(), [false, true]);
  assert.equal(new Set(results.map((result) => result.eventUid)).size, 1);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 1);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count, 2);
  assert.deepEqual(
    store.database.prepare(`SELECT observed_event_uid FROM event_observations
      ORDER BY observed_event_uid`).all().map((row) => row.observed_event_uid),
    ["different-alias-hook-event", "different-alias-transcript-event"]
  );
  store.close();
});

test("public completeness-incompatible alias becomes a replayable new event", async () => {
  const { store } = controlCaptureFixture();
  const blobs = {
    async write() {
      return "/private/blobs/completeness-shared.enc";
    }
  };
  const shared = {
    session_uid: "completeness-session",
    source_identity: undefined,
    native_turn_id: "completeness-turn",
    source_timestamp: "2026-07-20T02:00:00.000Z",
    content_hash: "d".repeat(64),
    encrypted_raw_ref: null
  };
  const prompt = event({
    ...shared,
    event_uid: "completeness-prompt-event",
    source_event_id: "completeness-prompt-source",
    source_namespace: "prompt_hook",
    observation_source_id: "completeness-prompt-observation",
    capture_source: "prompt_hook",
    completeness: "prompt_only"
  });
  const partial = event({
    ...shared,
    event_uid: "completeness-partial-event",
    source_event_id: "completeness-partial-source",
    source_namespace: "transcript_message",
    observation_source_id: "completeness-partial-observation",
    capture_source: "transcript_payload",
    completeness: "partial"
  });

  const first = await captureObservedSession({ store, blobs, event: prompt, rawText: "shared evidence" });
  const second = await captureObservedSession({ store, blobs, event: partial, rawText: "shared evidence" });
  const replay = await captureObservedSession({ store, blobs, event: { ...partial }, rawText: "shared evidence" });

  assert.equal(first.kind, "new");
  assert.equal(second.kind, "new");
  assert.equal(replay.kind, "exact_replay");
  assert.equal(replay.eventUid, second.eventUid);
  assert.notEqual(second.eventUid, first.eventUid);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 2);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count, 2);
  store.close();
});

test("public target-compatible alias attaches and exact replay succeeds", async () => {
  const { store } = controlCaptureFixture();
  const blobs = {
    async write() {
      return "/private/blobs/compatible-alias.enc";
    }
  };
  const shared = {
    session_uid: "compatible-alias-session",
    source_identity: undefined,
    native_turn_id: "compatible-alias-turn",
    source_timestamp: "2026-07-20T02:10:00.000Z",
    content_hash: "e".repeat(64),
    completeness: "prompt_only",
    encrypted_raw_ref: null
  };
  const prompt = event({
    ...shared,
    event_uid: "compatible-prompt-event",
    source_event_id: "compatible-prompt-source",
    source_namespace: "prompt_hook",
    observation_source_id: "compatible-prompt-observation",
    capture_source: "prompt_hook"
  });
  const transcript = event({
    ...shared,
    event_uid: "compatible-transcript-event",
    source_event_id: "compatible-transcript-source",
    source_namespace: "transcript_message",
    observation_source_id: "compatible-transcript-observation",
    capture_source: "transcript_payload"
  });

  const first = await captureObservedSession({ store, blobs, event: prompt, rawText: "compatible evidence" });
  const alias = await captureObservedSession({ store, blobs, event: transcript, rawText: "compatible evidence" });
  const replay = await captureObservedSession({ store, blobs, event: { ...transcript }, rawText: "compatible evidence" });

  assert.equal(first.kind, "new");
  assert.equal(alias.kind, "alias");
  assert.equal(replay.kind, "exact_replay");
  assert.equal(alias.eventUid, first.eventUid);
  assert.equal(replay.eventUid, first.eventUid);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 1);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count, 2);
  store.close();
});

test("timezone-less source timestamp is rejected before blob or database side effects", async () => {
  const { store } = controlCaptureFixture();
  let blobWrites = 0;
  const blobs = {
    async write() {
      blobWrites += 1;
      return "/private/blobs/timezone-less.enc";
    }
  };

  await assert.rejects(
    captureObservedSession({
      store,
      blobs,
      event: event({
        event_uid: "timezone-less-event",
        source_identity: undefined,
        source_event_id: "timezone-less-source",
        source_namespace: "prompt_hook",
        observation_source_id: "timezone-less-observation",
        capture_source: "prompt_hook",
        native_turn_id: "timezone-less-turn",
        source_timestamp: "2026-07-20T02:11:00.000",
        encrypted_raw_ref: null
      }),
      rawText: "timezone-less evidence"
    }),
    /source_timestamp/
  );

  assert.equal(blobWrites, 0);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 0);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count, 0);
  store.close();
});

test("timezone-offset alias normalizes to UTC and exact replay succeeds", async () => {
  const { store } = controlCaptureFixture();
  const blobs = {
    async write() {
      return "/private/blobs/timezone-offset-alias.enc";
    }
  };
  const canonicalTimestamp = "2026-07-20T02:10:00.000Z";
  const shared = {
    session_uid: "timezone-offset-alias-session",
    source_identity: undefined,
    native_turn_id: "timezone-offset-alias-turn",
    content_hash: "d".repeat(64),
    completeness: "prompt_only",
    encrypted_raw_ref: null
  };
  const canonical = event({
    ...shared,
    event_uid: "timezone-offset-canonical-event",
    source_event_id: "timezone-offset-canonical-source",
    source_namespace: "prompt_hook",
    observation_source_id: "timezone-offset-canonical-observation",
    capture_source: "prompt_hook",
    source_timestamp: canonicalTimestamp
  });
  const alias = event({
    ...shared,
    event_uid: "timezone-offset-alias-event",
    source_event_id: "timezone-offset-alias-source",
    source_namespace: "transcript_message",
    observation_source_id: "timezone-offset-alias-observation",
    capture_source: "transcript_payload",
    source_timestamp: "2026-07-20T10:10:00.000+08:00"
  });

  const first = await captureObservedSession({ store, blobs, event: canonical, rawText: "timezone-offset evidence" });
  const attached = await captureObservedSession({ store, blobs, event: alias, rawText: "timezone-offset evidence" });
  const replay = await captureObservedSession({ store, blobs, event: { ...alias }, rawText: "timezone-offset evidence" });
  const preparedAlias = controlStoreModule.prepareCapture({ event: alias, rawText: "timezone-offset evidence" });
  const canonicalAlias = controlStoreModule.prepareCapture({
    event: { ...alias, source_timestamp: canonicalTimestamp },
    rawText: "timezone-offset evidence"
  });

  assert.equal(first.kind, "new");
  assert.equal(attached.kind, "alias");
  assert.equal(replay.kind, "exact_replay");
  assert.equal(attached.eventUid, first.eventUid);
  assert.equal(replay.eventUid, first.eventUid);
  assert.equal(preparedAlias.identity.source_timestamp, canonicalTimestamp);
  assert.equal(preparedAlias.signature, canonicalAlias.signature);
  assert.equal(store.database.prepare("SELECT source_timestamp FROM session_events").get().source_timestamp, canonicalTimestamp);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 1);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count, 2);
  store.close();
});

test("public alias candidate applies completeness compatibility before LIMIT", async () => {
  const { store } = controlCaptureFixture();
  const shared = {
    session_uid: "completeness-limit-session",
    source_identity: undefined,
    native_turn_id: "completeness-limit-turn",
    content_hash: "f".repeat(64)
  };
  for (const [eventUid, sourceTimestamp, completeness, encryptedRawRef] of [
    ["incompatible-before-limit-a", "2026-07-20T03:00:00.000Z", "partial", "/private/blobs/incompatible-a.enc"],
    ["incompatible-before-limit-b", "2026-07-20T03:01:00.000Z", "partial", "/private/blobs/incompatible-b.enc"],
    ["compatible-after-limit", "2026-07-20T03:02:00.000Z", "prompt_only", "/private/blobs/compatible-after-limit.enc"]
  ]) {
    const seeded = store.captureSessionEvent(event({
      ...shared,
      event_uid: eventUid,
      source_event_id: `${eventUid}-source`,
      source_namespace: "prompt_hook",
      observation_source_id: `${eventUid}-observation`,
      capture_source: "prompt_hook",
      source_timestamp: sourceTimestamp,
      completeness,
      encrypted_raw_ref: encryptedRawRef
    }));
    assert.equal(seeded.kind, "new");
  }
  const blobs = {
    async write() {
      return "/private/blobs/compatible-after-limit.enc";
    }
  };
  const incoming = event({
    ...shared,
    event_uid: "incoming-after-completeness-limit",
    source_event_id: "incoming-after-completeness-limit-source",
    source_namespace: "transcript_message",
    observation_source_id: "incoming-after-completeness-limit-observation",
    capture_source: "transcript_payload",
    source_timestamp: "2026-07-20T03:03:00.000Z",
    completeness: "prompt_only",
    encrypted_raw_ref: null
  });

  const alias = await captureObservedSession({ store, blobs, event: incoming, rawText: "limit evidence" });
  const replay = await captureObservedSession({ store, blobs, event: { ...incoming }, rawText: "limit evidence" });
  const directInput = {
    provider: "codex",
    sessionUid: shared.session_uid,
    contextEpoch: 1,
    sourceNamespace: "transcript_direct",
    sourceId: "direct-after-completeness-limit-observation",
    nativeTurnId: shared.native_turn_id,
    role: "user",
    contentHash: shared.content_hash,
    sourceTimestamp: "2026-07-20T03:04:00.000Z",
    completeness: "prompt_only",
    encryptedRawRef: "/private/blobs/compatible-after-limit.enc"
  };
  const directAlias = store.resolveEventObservation(directInput);
  const directReplay = store.resolveEventObservation({ ...directInput });

  assert.equal(alias.kind, "alias");
  assert.equal(alias.eventUid, "compatible-after-limit");
  assert.equal(replay.kind, "exact_replay");
  assert.equal(replay.eventUid, "compatible-after-limit");
  assert.equal(directAlias.event_uid, "compatible-after-limit");
  assert.equal(directAlias.duplicate, false);
  assert.equal(directReplay.event_uid, "compatible-after-limit");
  assert.equal(directReplay.duplicate, true);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 3);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count, 5);
  store.close();
});

test("direct alias does not attach a completeness-incompatible target", () => {
  const { paths } = fixture();
  const store = initializeControlStore({ paths });
  const canonical = event({
    event_uid: "direct-completeness-target",
    session_uid: "direct-completeness-session",
    source_identity: undefined,
    source_event_id: "direct-completeness-source",
    source_namespace: "prompt_hook",
    observation_source_id: "direct-completeness-observation",
    capture_source: "prompt_hook",
    native_turn_id: "direct-completeness-turn",
    source_timestamp: "2026-07-20T03:20:00.000Z",
    completeness: "prompt_only",
    encrypted_raw_ref: "/private/blobs/direct-completeness.enc"
  });
  store.captureSessionEvent(canonical);

  assert.throws(
    () => store.resolveEventObservation({
      provider: "codex",
      sessionUid: canonical.session_uid,
      contextEpoch: canonical.context_epoch,
      sourceNamespace: "transcript_explicit",
      sourceId: "direct-completeness-explicit-incompatible",
      eventUid: canonical.event_uid,
      nativeTurnId: canonical.native_turn_id,
      role: canonical.role,
      contentHash: canonical.content_hash,
      sourceTimestamp: canonical.source_timestamp,
      completeness: "partial",
      encryptedRawRef: canonical.encrypted_raw_ref
    }),
    (error) => error?.code === "control_observation_collision"
  );

  const resolved = store.resolveEventObservation({
    provider: "codex",
    sessionUid: canonical.session_uid,
    contextEpoch: canonical.context_epoch,
    sourceNamespace: "transcript_message",
    sourceId: "direct-completeness-incompatible",
    nativeTurnId: canonical.native_turn_id,
    role: canonical.role,
    contentHash: canonical.content_hash,
    sourceTimestamp: canonical.source_timestamp,
    completeness: "partial",
    encryptedRawRef: canonical.encrypted_raw_ref
  });

  assert.equal(resolved, null);
  assert.equal(
    store.database.prepare(`SELECT COUNT(*) AS count FROM event_observations
      WHERE source_id IN (?, ?)`).get(
      "direct-completeness-explicit-incompatible",
      "direct-completeness-incompatible"
    ).count,
    0
  );
  store.close();
});

test("public capture inserts a new event for an alias with incompatible encrypted storage", async () => {
  const { store, blobs } = controlCaptureFixture();
  const shared = {
    session_uid: "incompatible-alias-session",
    source_identity: undefined,
    native_turn_id: "incompatible-alias-turn",
    source_timestamp: "2026-07-17T09:10:00.000Z",
    content_hash: "e".repeat(64),
    encrypted_raw_ref: null
  };
  const first = await captureObservedSession({
    store,
    blobs,
    event: event({
      ...shared,
      event_uid: "incompatible-hook-event",
      source_event_id: "incompatible-hook-source",
      source_namespace: "prompt_hook",
      observation_source_id: "incompatible-hook-observation",
      capture_source: "prompt_hook"
    }),
    rawText: "raw evidence A"
  });
  const second = await captureObservedSession({
    store,
    blobs,
    event: event({
      ...shared,
      event_uid: "incompatible-transcript-event",
      source_event_id: "incompatible-transcript-source",
      source_namespace: "transcript_message",
      observation_source_id: "incompatible-transcript-observation",
      capture_source: "transcript_payload"
    }),
    rawText: "raw evidence B"
  });

  assert.equal(first.kind, "new");
  assert.equal(second.kind, "new");
  assert.equal(second.duplicate, false);
  assert.notEqual(second.eventUid, first.eventUid);
  assert.notEqual(second.blobPath, first.blobPath);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 2);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count, 2);
  store.close();
});

test("public exact replay preserves an alias with a null observation timestamp", async () => {
  const { paths } = fixture();
  const store = initializeControlStore({
    paths,
    now: () => new Date("2026-07-17T09:20:00.000Z")
  });
  const blobs = {
    async write() {
      return "/private/blobs/null-timestamp-alias.enc";
    }
  };
  const shared = {
    session_uid: "null-timestamp-alias-session",
    source_identity: undefined,
    native_turn_id: "null-timestamp-alias-turn",
    content_hash: "f".repeat(64),
    encrypted_raw_ref: null
  };
  const first = event({
    ...shared,
    event_uid: "null-timestamp-hook-event",
    source_event_id: "null-timestamp-hook-source",
    source_namespace: "prompt_hook",
    observation_source_id: "null-timestamp-hook-observation",
    capture_source: "prompt_hook",
    source_timestamp: "2026-07-17T09:20:00.000Z"
  });
  const alias = event({
    ...shared,
    event_uid: "null-timestamp-transcript-event",
    source_event_id: "null-timestamp-transcript-source",
    source_namespace: "transcript_message",
    observation_source_id: "null-timestamp-transcript-observation",
    capture_source: "transcript_payload",
    source_timestamp: null
  });

  const firstResult = await captureObservedSession({ store, blobs, event: first, rawText: "null timestamp evidence" });
  const aliasResult = await captureObservedSession({ store, blobs, event: alias, rawText: "null timestamp evidence" });
  const replayResult = await captureObservedSession({ store, blobs, event: { ...alias }, rawText: "null timestamp evidence" });

  assert.equal(firstResult.kind, "new");
  assert.equal(aliasResult.kind, "alias");
  assert.equal(replayResult.kind, "exact_replay");
  assert.equal(aliasResult.eventUid, firstResult.eventUid);
  assert.equal(replayResult.eventUid, firstResult.eventUid);
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

test("candidate identity is replay-idempotent", () => {
  const { store, capture } = reviewJobFixture();
  const source = capture({ event_uid: "candidate-source" });
  const referent = capture({ event_uid: "candidate-referent", role: "assistant" });
  const other = capture({ event_uid: "candidate-other" });
  const candidate = {
    sourceEventUid: source.eventUid,
    referentEventUid: referent.eventUid,
    sourceIdentity: "codex:s1:e1:r1",
    projectId: "project-1"
  };

  const first = store.createReviewCandidate(candidate);
  const replay = store.createReviewCandidate(candidate);
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.jobId, first.jobId);

  for (const contradiction of [
    { sourceEventUid: other.eventUid },
    { referentEventUid: null },
    { projectId: "project-2" }
  ]) {
    assert.throws(
      () => store.createReviewCandidate({ ...candidate, ...contradiction }),
      (error) => error?.code === "review_candidate_collision"
    );
  }
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM reviewer_jobs").get().count, 1);
  store.close();
});

test("different sessions are never text-deduplicated", () => {
  const { store, capture } = reviewJobFixture();
  const sharedHash = createHash("sha256").update("same complaint").digest("hex");
  const firstSource = capture({
    event_uid: "session-one-source",
    session_uid: "session-one",
    source_event_id: "complaint",
    content_hash: sharedHash
  });
  const secondSource = capture({
    event_uid: "session-two-source",
    session_uid: "session-two",
    source_event_id: "complaint",
    content_hash: sharedHash
  });

  const first = store.createReviewCandidate({
    sourceEventUid: firstSource.eventUid,
    sourceIdentity: "codex:session-one:complaint:none"
  });
  const second = store.createReviewCandidate({
    sourceEventUid: secondSource.eventUid,
    sourceIdentity: "codex:session-two:complaint:none"
  });

  assert.equal(first.created, true);
  assert.equal(second.created, true);
  assert.notEqual(first.jobId, second.jobId);
  store.close();
});

test("launch reservation is bounded", () => {
  const fixture = reviewJobFixture();
  const source = fixture.capture({ event_uid: "launch-source" });
  const candidate = fixture.store.createReviewCandidate({
    sourceEventUid: source.eventUid,
    sourceIdentity: "codex:launch:source:none"
  });

  const wake1 = fixture.store.reserveReviewLaunch({ jobId: candidate.jobId, cooldownMs: 5_000 });
  const wake2 = fixture.store.reserveReviewLaunch({ jobId: candidate.jobId, cooldownMs: 5_000 });
  assert.deepEqual([wake1.launch, wake2.launch], [true, false]);
  assert.equal(wake1.launchEpoch, 1);
  assert.equal(wake2.reason, "cooldown");

  fixture.advance(5_001);
  const wake3 = fixture.store.reserveReviewLaunch({ jobId: candidate.jobId, cooldownMs: 5_000 });
  assert.equal(wake3.launchEpoch, 2);
  assert.deepEqual(
    fixture.store.recordReviewLaunchFailure({ jobId: candidate.jobId, launchEpoch: 1, reasonCode: "spawn_failed" }),
    { released: false }
  );
  assert.deepEqual(
    fixture.store.recordReviewLaunchFailure({ jobId: candidate.jobId, launchEpoch: 2, reasonCode: "spawn_failed" }),
    { released: true }
  );
  assert.equal(fixture.store.reserveReviewLaunch({ jobId: candidate.jobId, cooldownMs: 5_000 }).launchEpoch, 3);
  fixture.store.close();
});

test("stale reviewer owners cannot publish", () => {
  const fixture = reviewJobFixture();
  const source = fixture.capture({ event_uid: "fenced-source" });
  const candidate = fixture.store.createReviewCandidate({
    sourceEventUid: source.eventUid,
    sourceIdentity: "codex:fenced:source:none"
  });

  const ownerA = fixture.store.claimReviewJob({ jobId: candidate.jobId, ownerId: "owner-a", leaseMs: 1_000 });
  assert.equal(ownerA.leaseEpoch, 1);
  fixture.advance(1_001);
  const ownerB = fixture.store.claimReviewJob({ jobId: candidate.jobId, ownerId: "owner-b", leaseMs: 30_000 });
  assert.equal(ownerB.leaseEpoch, 2);
  assert.equal(ownerB.job.attempt, 2);

  assert.throws(
    () => fixture.store.completeReviewPublished({
      jobId: candidate.jobId,
      ownerId: "owner-a",
      leaseEpoch: ownerA.leaseEpoch,
      path: "/tmp/stale.md",
      sha256: "a".repeat(64)
    }),
    (error) => error?.code === "review_lease_lost"
  );
  assert.throws(
    () => fixture.store.assertReviewLease({ jobId: candidate.jobId, ownerId: "owner-a", leaseEpoch: ownerA.leaseEpoch }),
    (error) => error?.code === "review_lease_lost"
  );

  const renewed = fixture.store.renewReviewLease({
    jobId: candidate.jobId,
    ownerId: "owner-b",
    leaseEpoch: ownerB.leaseEpoch,
    leaseMs: 45_000
  });
  assert.equal(renewed.leaseEpoch, ownerB.leaseEpoch);
  assert.equal(fixture.store.assertReviewLease({
    jobId: candidate.jobId,
    ownerId: "owner-b",
    leaseEpoch: ownerB.leaseEpoch
  }).job_id, candidate.jobId);
  const completed = fixture.store.completeReviewPublished({
    jobId: candidate.jobId,
    ownerId: "owner-b",
    leaseEpoch: ownerB.leaseEpoch,
    path: "/tmp/current.md",
    sha256: "b".repeat(64)
  });
  assert.equal(completed.state, "published");
  assert.equal(fixture.store.claimReviewJob({
    jobId: candidate.jobId,
    ownerId: "owner-c"
  }).job, null);
  fixture.store.close();
});

test("review failures retry after 30 and 120 seconds then exhaust at attempt three", () => {
  const fixture = reviewJobFixture();
  const source = fixture.capture({ event_uid: "retry-source" });
  const candidate = fixture.store.createReviewCandidate({
    sourceEventUid: source.eventUid,
    sourceIdentity: "codex:retry:source:none"
  });

  const first = fixture.store.claimReviewJob({ jobId: candidate.jobId, ownerId: "owner-1" });
  const failedOnce = fixture.store.failReviewJob({
    jobId: candidate.jobId,
    ownerId: "owner-1",
    leaseEpoch: first.leaseEpoch,
    reasonCode: "provider_timeout"
  });
  assert.equal(failedOnce.state, "retryable");
  assert.equal(Date.parse(failedOnce.next_attempt_at) - fixture.now().getTime(), 30_000);
  assert.equal(fixture.store.claimReviewJob({ jobId: candidate.jobId, ownerId: "too-early" }).job, null);

  fixture.advance(30_000);
  const second = fixture.store.claimReviewJob({ jobId: candidate.jobId, ownerId: "owner-2" });
  const failedTwice = fixture.store.failReviewJob({
    jobId: candidate.jobId,
    ownerId: "owner-2",
    leaseEpoch: second.leaseEpoch,
    reasonCode: "provider_unavailable"
  });
  assert.equal(failedTwice.state, "retryable");
  assert.equal(Date.parse(failedTwice.next_attempt_at) - fixture.now().getTime(), 120_000);

  fixture.advance(120_000);
  const third = fixture.store.claimReviewJob({ jobId: candidate.jobId, ownerId: "owner-3" });
  const exhausted = fixture.store.failReviewJob({
    jobId: candidate.jobId,
    ownerId: "owner-3",
    leaseEpoch: third.leaseEpoch,
    reasonCode: "provider_invalid"
  });
  assert.equal(exhausted.state, "failed");
  assert.equal(exhausted.next_attempt_at, null);
  assert.equal(fixture.store.claimReviewJob({ jobId: candidate.jobId, ownerId: "owner-4" }).job, null);
  assert.throws(
    () => fixture.store.failReviewJob({
      jobId: candidate.jobId,
      ownerId: "owner-3",
      leaseEpoch: third.leaseEpoch,
      reasonCode: "provider_invalid"
    }),
    (error) => error?.code === "review_lease_lost"
  );
  fixture.store.close();
});

test("recoverable review jobs are due, stable and hard-capped at eight", () => {
  const fixture = reviewJobFixture();
  for (let index = 0; index < 10; index += 1) {
    const source = fixture.capture({ event_uid: `recoverable-source-${index}` });
    fixture.store.createReviewCandidate({
      sourceEventUid: source.eventUid,
      sourceIdentity: `codex:recoverable:${index}:none`
    });
  }
  const expected = fixture.store.database.prepare(
    "SELECT job_id FROM reviewer_jobs ORDER BY created_at, job_id LIMIT 8"
  ).all().map((row) => row.job_id);
  const actual = fixture.store.listRecoverableReviewJobs({ limit: 100, now: fixture.now() });
  assert.equal(actual.length, 8);
  assert.deepEqual(actual.map((row) => row.job_id), expected);

  const reservation = fixture.store.reserveReviewLaunch({ jobId: actual[0].job_id, cooldownMs: 5_000 });
  assert.equal(fixture.store.listRecoverableReviewJobs({ limit: 8, now: fixture.now() })
    .some((row) => row.job_id === actual[0].job_id), false);
  assert.equal(fixture.store.recordReviewLaunchFailure({
    jobId: actual[0].job_id,
    launchEpoch: reservation.launchEpoch,
    reasonCode: "spawn_failed"
  }).released, true);
  assert.equal(fixture.store.listRecoverableReviewJobs({ limit: 8, now: fixture.now() })
    .some((row) => row.job_id === actual[0].job_id), true);

  const running = fixture.store.claimReviewJob({ jobId: actual[0].job_id, ownerId: "expiring", leaseMs: 1_000 });
  assert.equal(fixture.store.listRecoverableReviewJobs({ limit: 8, now: fixture.now() })
    .some((row) => row.job_id === running.job.job_id), false);
  fixture.advance(1_001);
  assert.equal(fixture.store.listRecoverableReviewJobs({ limit: 8, now: fixture.now() })
    .some((row) => row.job_id === running.job.job_id), true);
  fixture.store.close();
});

test("review context is opaque, chronological and bounded", () => {
  const fixture = reviewJobFixture();
  const prior = fixture.capture({ event_uid: "context-prior", role: "assistant" });
  fixture.advance(1);
  const referent = fixture.capture({ event_uid: "context-referent", role: "assistant" });
  fixture.advance(1);
  const source = fixture.capture({
    event_uid: "context-source",
    role: "user",
    referent_event_uid: referent.eventUid
  });
  fixture.advance(1);
  const following = fixture.capture({ event_uid: "context-following", role: "assistant" });
  fixture.advance(1);
  fixture.capture({ event_uid: "context-following-omitted", role: "user" });
  const candidate = fixture.store.createReviewCandidate({
    sourceEventUid: source.eventUid,
    referentEventUid: referent.eventUid,
    sourceIdentity: "codex:context:source:referent",
    projectId: "project-context"
  });

  const context = fixture.store.getReviewContext({
    jobId: candidate.jobId,
    priorLimit: 1,
    followingLimit: 1
  });
  assert.equal(context.source.event_uid, source.eventUid);
  assert.equal(context.referent.event_uid, referent.eventUid);
  assert.deepEqual(context.prior.map((row) => row.event_uid), [prior.eventUid]);
  assert.deepEqual(context.following.map((row) => row.event_uid), [following.eventUid]);
  for (const row of [context.source, context.referent, ...context.prior, ...context.following]) {
    assert.deepEqual(Object.keys(row).sort(), [
      "completeness",
      "content_hash",
      "created_at",
      "encrypted_raw_ref",
      "event_uid",
      "referent_event_uid",
      "role",
      "session_uid",
      "source_provider",
      "source_timestamp"
    ]);
  }
  const contextKeys = [];
  JSON.stringify(context, (key, value) => {
    if (key) contextKeys.push(key);
    return value;
  });
  assert.deepEqual(
    contextKeys.filter((key) => ["raw_text", "rawText", "prompt", "report", "method", "lesson", "card"].includes(key)),
    []
  );
  fixture.store.close();
});

test("review no-lesson completion is terminal and fenced", () => {
  const fixture = reviewJobFixture();
  const source = fixture.capture({ event_uid: "no-lesson-source" });
  const candidate = fixture.store.createReviewCandidate({
    sourceEventUid: source.eventUid,
    sourceIdentity: "codex:no-lesson:source:none"
  });
  const claim = fixture.store.claimReviewJob({ jobId: candidate.jobId, ownerId: "no-lesson-owner" });
  const completed = fixture.store.completeReviewNoLesson({
    jobId: candidate.jobId,
    ownerId: "no-lesson-owner",
    leaseEpoch: claim.leaseEpoch
  });
  assert.equal(completed.state, "reviewed_no_lesson");
  assert.equal(completed.result_code, "reviewed_no_lesson");
  assert.equal(fixture.store.reserveReviewLaunch({ jobId: candidate.jobId, cooldownMs: 0 }).launch, false);
  assert.equal(fixture.store.claimReviewJob({ jobId: candidate.jobId, ownerId: "late-owner" }).job, null);
  fixture.store.close();
});
