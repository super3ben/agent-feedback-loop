import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { pathsFor } from "../src/index.mjs";
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
