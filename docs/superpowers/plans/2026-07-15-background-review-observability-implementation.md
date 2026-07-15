# Background Review Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every persisted feedback-review transition observable through a deterministic main-chat receipt, an independently retried operating-system notification, and an auditable CLI without moving reflection work into the user's main conversation.

**Architecture:** Add a schema-v8 transactional notification outbox beside the existing review and lesson receipts. Store methods create notifications in the same transaction as queued, completed, exhausted, and lesson-delivery state; a pure renderer turns those facts into bounded bilingual control text, prompt/Stop hooks confirm chat delivery, and a leased notifier drains final states outside the review transaction. Audit commands expose the stored state without exposing model chain of thought.

**Tech Stack:** Node.js 24.15+ ESM, built-in `node:sqlite`, built-in `node:test`, POSIX shell hooks, macOS `osascript`, Linux `notify-send`, existing Codex/Claude Code/Gemini hook adapters.

## Global Constraints

- Target package/runtime version is `0.7.5`; target SQLite schema version is `8`.
- Main-chat receipts are deterministic single lines no longer than 160 visible characters; total injected receipt control text is no longer than 512 characters.
- Receipt payloads may contain only `severity`, `lesson_count`, `reason_code`, short opaque identifiers, and language; never user text, report text, paths, credentials, or full session identifiers.
- Ordinary prompts with no outbox transition inject no receipt text and make no additional LLM request.
- `review_started` and retryable failures remain log-only; only terminal review states use an operating-system notification.
- Review persistence and notification delivery are independent: notifier failure must never roll a completed review back to pending.
- Chat and system delivery use transactional claims; duplicate hook, scheduler, or worker runs must not duplicate a semantic notification.
- Receipt text and hidden markers are synthetic control data and must be excluded from feedback capture, lesson evidence, and lesson selection.
- Stop may block at most once for a notification and may re-emit that notification in at most one later prompt.
- Logs contain opaque identifiers, counts, adapter names, and reason codes only.
- Windows system notifications remain `unsupported` until a native adapter is verified; the review path still succeeds.
- Automated tests are necessary but not sufficient: final acceptance must attempt real Codex desktop verification through Computer Use and separate new-session, long-session, scheduler recovery, failure recovery, and non-trigger evidence.

---

## File Map

- `src/schema.mjs`: schema-v8 `notification_outbox` and `reviewer_job_events` tables, constraints, and indexes.
- `src/store.mjs`: all transactional outbox producers, chat/system claim state machines, review audit queries, and delivery aggregation.
- `src/receipt.mjs`: payload validation, language choice, deterministic line/marker rendering, and receipt-control stripping; Task 1 creates the contract and Task 2 adds rendering.
- `src/notifier.mjs`: platform capability detection, safe native process execution, leases, retries, and structured notifier logs.
- `src/capture.mjs`: excludes receipt-only assistant output from captured evidence.
- `src/codex-reconcile.mjs`: excludes receipt controls from transcript reconciliation and inherits outbox-producing review transitions.
- `src/cli.mjs`: prompt receipt injection, Stop confirmation/block output, notifier draining, and `review list/show` commands.
- `templates/hooks/stop-hook.sh`: returns transactional `capture-stop` output instead of discarding it; legacy marker behavior stays isolated.
- `src/index.mjs`, `package.json`: runtime/package version `0.7.5` and installed assets.
- `test/receipt.test.mjs`: renderer, language, bounds, marker parsing, and control stripping.
- `test/notifier.test.mjs`: notifier capability, lease, success, retry, and unsupported behavior.
- `test/store.test.mjs`: outbox transactionality, idempotency, fencing, state transitions, and audit projections.
- `test/capture.test.mjs`, `test/codex-reconcile.test.mjs`: synthetic receipt exclusion.
- `test/cli.test.mjs`, `test/e2e-smoke.test.mjs`: host schemas, Stop loop guard, background completion, lesson delivery, and commands.
- `README.md`, `README-zh.md`: observable behavior, exact status semantics, commands, configuration, and platform limits.
- `docs/superpowers/verification/2026-07-15-background-review-observability.md`: actual true-machine IDs, counts, state transitions, screenshots attempted, and unavailable boundaries.

### Task 1: Schema-v8 Notification Outbox and Store State Machine

**Files:**
- Modify: `src/schema.mjs:1-194`
- Create: `src/receipt.mjs`
- Modify: `src/store.mjs:142-275`
- Modify: `src/store.mjs:598-630`
- Modify: `src/store.mjs:659-770`
- Modify: `src/store.mjs:905-1065`
- Test: `test/store.test.mjs`

**Interfaces:**
- Produces: `store.createNotification(input) -> NotificationRow`
- Produces: `store.claimChatNotification({ sessionUid, contextEpoch, nativeTurnId }) -> NotificationRow | null`
- Produces: `store.confirmChatNotification({ sessionUid, contextEpoch, nativeTurnId, transcriptText }) -> { action, notification }`
- Produces: `store.claimSystemNotifications({ ownerId, nowMs, leaseMs, limit }) -> NotificationRow[]`
- Produces: `store.completeSystemNotification({ notificationId, ownerId, leaseEpoch, deliveredAt }) -> boolean`
- Produces: `store.failSystemNotification({ notificationId, ownerId, leaseEpoch, reasonCode, nowMs }) -> boolean`
- Produces: `store.markSystemNotificationUnsupported({ notificationId, ownerId, leaseEpoch, reasonCode }) -> boolean`
- Produces: `store.listNotifications({ sessionUid, jobId }) -> NotificationRow[]`
- Produces: `store.recordDeliveries({ deliveries, sessionUid, contextEpoch, language }) -> { inserted, notification }`
- Produces: `store.setReviewerProvider({ jobId, provider }) -> boolean`
- Produces: `store.suppressClaimableChatNotifications({ sessionUid, contextEpoch }) -> number`; `suppressPendingChatNotifications` remains a compatibility wrapper with the same cancellation semantics.
- Produces: `store.suppressDueSystemNotifications({ nowMs, reasonCode }) -> number`
- Produces: `store.listReviewerJobEvents(jobId) -> ReviewerJobEvent[]`
- Produces: `validateReceiptPayload(kind, payload) -> object`
- Produces: `detectReceiptLanguage(text, override) -> 'zh' | 'en'`
- Produces: `receiptNonce(notificationId) -> string`
- Produces: `containsReceiptMarker(text, notification) -> boolean`
- Consumes: existing `transaction(fn)`, `nowIso(now)`, reviewer jobs, review receipts, session events, and delivery receipts.

`NotificationRow` is the plain object returned from `notification_outbox`; it uses the exact snake-case column names defined in Step 3 and parses no payload implicitly.

- [ ] **Step 1: Write failing schema and idempotency tests**

Add a fresh-store idempotency test and a v7-like migration test. Import `DatabaseSync` from `node:sqlite`. The fresh-store test proves one semantic notification survives duplicate insertion and reopen:

```js
test("schema v8 migrates and deduplicates semantic notifications", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-notification-schema-"));
  const paths = pathsFor(home);
  const store = openStore({ paths });
  const captured = {
    event_uid: "notification-event",
    event_seq: 1,
    context_epoch: 1,
    project_id: "project-notification",
    session_uid: "codex:install:session-notification",
    source_event_id: "notification-event",
    role: "user",
    redacted_text: "user feedback",
    content_hash: "hash-notification-event",
    capture_policy_revision: 1,
    data_class: "normal"
  };
  store.captureSessionEvent(captured);
  const input = {
    sessionUid: captured.session_uid,
    contextEpoch: 1,
    kind: "candidate_captured",
    eventUid: captured.event_uid,
    payload: {},
    language: "en"
  };
  const first = store.createNotification(input);
  const second = store.createNotification(input);
  assert.throws(
    () => store.createNotification(Object.assign({}, input, { kind: "review_queued", payload: { prompt: "must-not-persist" } })),
    /forbidden key/
  );
  assert.equal(first.notification_id, second.notification_id);
  assert.equal(store.listNotifications({ sessionUid: captured.session_uid }).length, 1);
  assert.equal(store.capability.schemaVersion, 8);
  store.close();
  const reopened = openStore({ paths });
  assert.equal(reopened.listNotifications({ sessionUid: captured.session_uid }).length, 1);
  reopened.close();
});
```

The migration test creates only the v7 metadata/session tables and a sentinel session before `openStore` applies the current schema:

```js
test("schema v8 preserves a v7 session while adding notification outbox", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-notification-migrate-"));
  const paths = pathsFor(home);
  await mkdir(path.dirname(paths.storeFile), { recursive: true, mode: 0o700 });
  const legacy = new DatabaseSync(paths.storeFile);
  legacy.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sessions (
      session_uid TEXT PRIMARY KEY,
      cli TEXT NOT NULL,
      native_session_id TEXT,
      installation_id TEXT NOT NULL,
      project_id TEXT,
      context_epoch INTEGER NOT NULL DEFAULT 1,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );
    INSERT INTO schema_migrations VALUES (7, '2026-07-14T00:00:00.000Z');
    INSERT INTO store_meta VALUES ('capture_policy_revision', '1');
    INSERT INTO store_meta VALUES ('capture_enabled', '1');
    INSERT INTO sessions VALUES (
      'codex:install:legacy-session', 'codex', 'legacy-session', 'install',
      'legacy-project', 1, '2026-07-14T00:00:00.000Z', NULL
    );
  `);
  legacy.close();
  const migrated = openStore({ paths });
  assert.equal(migrated.capability.schemaVersion, 8);
  assert.doesNotThrow(() => migrated.listNotifications({ sessionUid: "codex:install:legacy-session" }));
  migrated.close();
  const verify = new DatabaseSync(paths.storeFile);
  assert.equal(verify.prepare("SELECT session_uid FROM sessions WHERE session_uid=?").get("codex:install:legacy-session").session_uid, "codex:install:legacy-session");
  assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=8").get().count, 1);
  verify.close();
});
```

- [ ] **Step 2: Run the schema test and verify RED**

Run: `node --test --test-name-pattern="schema v8 migrates" test/store.test.mjs`

Expected: FAIL because `createNotification` is undefined and schema version is `7`.

- [ ] **Step 3: Add the schema-v8 table and deterministic semantic identity**

Set `SCHEMA_VERSION = 8`. Add `reviewer_job_events` after `reviewer_jobs`, then add `notification_outbox` after `delivery_receipts`, so every referenced table already exists:

```sql
CREATE TABLE IF NOT EXISTS reviewer_job_events (
  job_event_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES reviewer_jobs(job_id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  lease_epoch INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN (
    'claimed','requeued','completed','failed','retry_exhausted'
  )),
  provider TEXT,
  reason_code TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS reviewer_job_events_transition_idx
  ON reviewer_job_events(job_id, lease_epoch, state, IFNULL(reason_code, ''));

CREATE TABLE IF NOT EXISTS notification_outbox (
  notification_id TEXT PRIMARY KEY,
  session_uid TEXT NOT NULL REFERENCES sessions(session_uid) ON DELETE CASCADE,
  context_epoch INTEGER NOT NULL,
  job_id TEXT REFERENCES reviewer_jobs(job_id) ON DELETE CASCADE,
  event_uid TEXT REFERENCES session_events(event_uid) ON DELETE SET NULL,
  application_id TEXT REFERENCES delivery_receipts(application_id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK(kind IN (
    'candidate_captured','review_queued','review_completed','reviewed_no_lesson',
    'review_exhausted','lesson_delivered'
  )),
  payload_json TEXT NOT NULL,
  language TEXT NOT NULL CHECK(language IN ('zh','en')),
  chat_state TEXT NOT NULL DEFAULT 'pending' CHECK(chat_state IN (
    'pending','emitted','observed','emitted_unconfirmed','suppressed'
  )),
  chat_turn_id TEXT,
  chat_emit_attempts INTEGER NOT NULL DEFAULT 0,
  chat_block_attempted INTEGER NOT NULL DEFAULT 0,
  chat_emitted_at TEXT,
  chat_observed_at TEXT,
  system_state TEXT NOT NULL DEFAULT 'not_applicable' CHECK(system_state IN (
    'not_applicable','pending','delivering','delivered','failed','unsupported','suppressed'
  )),
  system_owner TEXT,
  system_lease_epoch INTEGER NOT NULL DEFAULT 0,
  system_lease_until INTEGER,
  system_attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  system_reason_code TEXT,
  system_delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_semantic_idx
  ON notification_outbox(
    session_uid, context_epoch, kind,
    IFNULL(job_id, ''), IFNULL(event_uid, ''), IFNULL(application_id, '')
  );
CREATE INDEX IF NOT EXISTS notification_outbox_chat_due_idx
  ON notification_outbox(session_uid, context_epoch, chat_state, created_at);
CREATE INDEX IF NOT EXISTS notification_outbox_system_due_idx
  ON notification_outbox(system_state, next_attempt_at, system_lease_until);
```

Add nullable `reviewer_provider TEXT` to `reviewer_jobs` in both the fresh schema and the idempotent migration list. Use SHA-256 over the semantic tuple for `notification_id`. `createNotification` must use a parameterized `INSERT` with `ON CONFLICT DO NOTHING`, then return the stored row. Set `system_state='pending'` only for `review_completed`, `reviewed_no_lesson`, and `review_exhausted`; set it to `not_applicable` for other kinds. `setReviewerProvider` accepts only `codex`, `claude`, `gemini`, `explicit_command`, or `prompt_subagent` and updates a pending/running job without altering its lease.

Insert one `reviewer_job_events` row in the same transaction as each successful claim, expired-lease requeue, completion, final/retryable failure, and retry exhaustion. Derive `job_event_id` from job id, lease epoch, state, and reason code; the unique index makes scheduler replay idempotent. Never store owner id, reviewer context, report text, or receipt payload in this table.

Create the payload/language contract before `store.mjs` imports it:

```js
import { createHash } from "node:crypto";

const PAYLOAD_KEYS = Object.freeze({
  candidate_captured: [],
  review_queued: [],
  review_completed: ["severity", "lesson_count"],
  reviewed_no_lesson: [],
  review_exhausted: ["reason_code"],
  lesson_delivered: ["lesson_count"]
});

export function validateReceiptPayload(kind, payload = {}) {
  const allowed = PAYLOAD_KEYS[kind];
  if (!allowed) throw new TypeError(`unsupported receipt kind: ${kind}`);
  const keys = Object.keys(payload);
  if (keys.some((key) => !allowed.includes(key))) throw new TypeError("receipt payload contains a forbidden key");
  if (kind === "review_completed" && !["Minor", "Major", "Critical", "Blocker"].includes(payload.severity)) {
    throw new TypeError("review_completed requires a valid severity");
  }
  if (("lesson_count" in payload) && (!Number.isInteger(payload.lesson_count) || payload.lesson_count < 0)) {
    throw new TypeError("lesson_count must be a non-negative integer");
  }
  if (("reason_code" in payload) && !/^[a-z0-9_]{1,64}$/.test(payload.reason_code)) {
    throw new TypeError("reason_code is invalid");
  }
  return Object.freeze(Object.assign({}, payload));
}

export function detectReceiptLanguage(text, override = "auto") {
  if (override === "zh" || override === "en") return override;
  if (override !== "auto") throw new TypeError("receipt language must be auto, zh, or en");
  return /[\u3400-\u9fff]/u.test(String(text || "")) ? "zh" : "en";
}

export function receiptNonce(notificationId) {
  return createHash("sha256").update(`receipt:v1\u0000${notificationId}`).digest("hex").slice(0, 16);
}

export function containsReceiptMarker(text, notification) {
  if (!notification || typeof notification !== "object" || Array.isArray(notification)) return false;
  if (!isCanonical64Hex(notification.notification_id) && !isBoundedLegacyNotificationId(notification.notification_id)) return false;
  if (!Object.hasOwn(PAYLOAD_KEYS, notification.kind)) return false;
  const marker = isCanonical64Hex(notification.notification_id)
    ? renderReceiptControl(notification).marker
    : `<!--afl-receipt id=${notification.notification_id} nonce=${receiptNonce(notification.notification_id)} state=${notification.kind}-->`;
  return String(text || "").includes(marker);
}
```

`receiptNonce` is the v1 compatibility function, not the current canonical-control nonce. `isCanonical64Hex` accepts only lowercase 64-hex IDs. `isBoundedLegacyNotificationId` exists only for observation of historical rows and accepts the proven `notification-<positive safe integer>` grammar; UUID, `msg_UUID`, colon/session, path, zero, leading-zero, and oversized forms are rejected. Task 2 makes canonical observation authoritative by re-rendering the row and requiring its exact v2 marker. Add real SQLite outbox-flow tests proving unsafe rows and canonical v1 markers do not transition to `observed`, while canonical v2 controls and the exact legacy `notification-1` v1 fixture do.

Extend `openStore` to accept `receiptLanguage = process.env.AGENT_FEEDBACK_LOOP_RECEIPT_LANGUAGE || "auto"`. Completion notifications inherit an existing job notification's language; otherwise they detect language from the referenced feedback event's redacted text. Validate every payload before it enters SQLite.

- [ ] **Step 4: Add failing chat claim/confirm and system lease tests**

Add tests with a fixed clock that assert:

```js
const claimed = store.claimChatNotification({
  sessionUid: event.session_uid,
  contextEpoch: 1,
  nativeTurnId: "turn-2"
});
assert.equal(claimed.chat_state, "emitted");
assert.equal(claimed.chat_emit_attempts, 1);

const firstStop = store.confirmChatNotification({
  sessionUid: event.session_uid,
  contextEpoch: 1,
  nativeTurnId: "turn-2",
  transcriptText: "assistant text without marker"
});
assert.equal(firstStop.action, "block");

const secondStop = store.confirmChatNotification({
  sessionUid: event.session_uid,
  contextEpoch: 1,
  nativeTurnId: "turn-2",
  transcriptText: "assistant text without marker"
});
assert.equal(secondStop.action, "pass_unconfirmed");
assert.equal(store.listNotifications({ sessionUid: event.session_uid })[0].chat_state, "emitted_unconfirmed");

const leased = store.claimSystemNotifications({ ownerId: "notifier-a", nowMs: 1_000, leaseMs: 30_000, limit: 8 });
assert.equal(leased.length, 1);
assert.equal(store.claimSystemNotifications({ ownerId: "notifier-b", nowMs: 2_000, leaseMs: 30_000, limit: 8 }).length, 0);
assert.equal(store.claimSystemNotifications({ ownerId: "notifier-b", nowMs: 31_001, leaseMs: 30_000, limit: 8 }).length, 1);
```

Add a separate disabled-delivery test with an isolated store:

```js
test("disabled receipt channels suppress rather than replay pending rows", async () => {
  const store = await storeFixture();
  const captured = {
    event_uid: "disabled-event",
    session_uid: "codex:install:disabled-session",
    event_seq: 1,
    context_epoch: 1,
    project_id: "disabled-project",
    source_event_id: "disabled-event",
    role: "user",
    redacted_text: "feedback candidate",
    content_hash: "hash-disabled-event",
    capture_policy_revision: 1,
    data_class: "normal"
  };
  store.captureSessionEvent(captured);
  store.createNotification({
    sessionUid: captured.session_uid,
    contextEpoch: 1,
    kind: "candidate_captured",
    eventUid: captured.event_uid,
    payload: {},
    language: "en"
  });
  assert.equal(store.suppressPendingChatNotifications({ sessionUid: captured.session_uid, contextEpoch: 1 }), 1);

  store.submitReviewerJob({ job_id: "job-system-suppressed", project_id: captured.project_id, prompt_version: "v1" });
  store.createNotification({
    sessionUid: captured.session_uid,
    contextEpoch: 1,
    kind: "reviewed_no_lesson",
    jobId: "job-system-suppressed",
    payload: {},
    language: "en"
  });
  assert.equal(store.suppressDueSystemNotifications({ nowMs: 31_001, reasonCode: "disabled_by_config" }), 1);
  assert.deepEqual(store.listNotifications({ sessionUid: captured.session_uid }).map((row) => row.system_state).sort(), ["not_applicable", "suppressed"]);
  store.close();
});
```

- [ ] **Step 5: Run the state-machine tests and verify RED**

Run: `node --test --test-name-pattern="chat claim|system lease" test/store.test.mjs`

Expected: FAIL because chat/system claim methods do not exist.

- [ ] **Step 6: Implement fenced chat and system transitions**

Implement the exact transitions below inside `transaction`:

```text
chat claim:
  pending -> emitted, attempts 0 -> 1, bind native turn
  emitted_unconfirmed -> emitted only when attempts == 1, attempts 1 -> 2, bind new turn
  any other state -> not claimable

chat confirm:
  marker found for bound turn -> observed
  marker absent and chat_block_attempted == 0 -> keep emitted, set chat_block_attempted=1, return block
  marker absent and chat_block_attempted == 1 -> emitted_unconfirmed, return pass_unconfirmed

system claim:
  pending/failed due now -> delivering with owner, lease, system_lease_epoch+1 and attempts+1
  expired delivering -> delivering with new owner, lease, system_lease_epoch+1 and attempts+1
  active delivering lease -> not claimable

system complete:
  delivering + matching owner + matching leaseEpoch -> delivered, clear lease and owner

system failure:
  delivering + matching owner + matching leaseEpoch -> failed, clear lease and owner,
  next_attempt_at = now + min(21600000, 60000 * 2 ** (attempts - 1))

system unsupported:
  delivering + matching owner + matching leaseEpoch -> unsupported, clear lease and owner, persist reason code
```

Every complete, fail, and unsupported call must pass `leaseEpoch` from the claimed row's `system_lease_epoch`. Owner identity alone is not a fence: tests must reclaim with the same owner and assert all three terminal methods reject the stale epoch before accepting the current epoch.

Use one chat claim per native turn. Order final review states before queue/candidate, then `lesson_delivered`, so a later terminal fact supersedes a stale progress line. When inserting `review_queued`, update matching `candidate_captured` rows to `chat_state='suppressed'`; when inserting a terminal review state, suppress pending/emitted-unconfirmed progress rows for the same session/job.

`suppressPendingChatNotifications` changes only `pending` rows for that session/epoch to `suppressed`. `suppressDueSystemNotifications` changes due `pending`/`failed` rows to `suppressed` with `system_reason_code`; neither method changes reviewer or lesson state. This prevents config re-enable from replaying a historical backlog.

- [ ] **Step 7: Add failing transaction-binding tests**

Cover rollback boundaries and structured reviewer history:

```js
assert.throws(() => store.commitReview(staleLease, validReview), /stale reviewer completion/);
assert.equal(store.listNotifications({ jobId: job.job_id }).some((row) => row.kind === "review_completed"), false);

const due = store.submitDueReview({
  projectId: event.project_id,
  minEntries: 1,
  cooldownMs: 0,
  immediateEventUid: event.event_uid
});
assert.equal(store.listNotifications({ jobId: due.job_id }).filter((row) => row.kind === "review_queued").length, 1);

store.recordDeliveries({
  deliveries: [{ application_id: "app-1", lesson_id: "lesson-1", revision: 1, nonce: "nonce-1" }],
  sessionUid: event.session_uid,
  contextEpoch: 1,
  language: "en"
});
assert.equal(store.listNotifications({ sessionUid: event.session_uid }).filter((row) => row.kind === "lesson_delivered").length, 1);
assert.deepEqual(
  store.listReviewerJobEvents(job.job_id).map((row) => row.state),
  ["claimed", "completed"]
);
```

- [ ] **Step 8: Bind queue, review, failure, and lesson transitions to outbox creation**

Make these writes occur inside their owning transactions:

1. `submitDueReview` called with `immediateEventUid` creates one `review_queued` row for the immediate event's session after assignment.
2. `commitReview` creates `review_completed` for sessions referenced by lesson `evidence_refs.feedback_event_id`; severity is the highest persisted lesson severity and `lesson_count` is the number of lessons tied to that session.
3. `commitReview` with `reviewed_no_lesson` creates `reviewed_no_lesson` only for sessions already carrying a candidate/queue notification for that job, avoiding noise from ordinary semantic batches.
4. Non-retryable `failReviewerJob` and `failExhaustedReviewerJobs` create `review_exhausted` only for sessions already carrying a candidate/queue notification.
5. `recordDeliveries` inserts/updates all delivery receipts and one aggregated `lesson_delivered` notification in one transaction. Keep `recordDelivery(input)` as a compatibility wrapper that calls `recordDeliveries` with one element and derives language from the session's latest redacted user event when legacy callers omit it.

Return `notificationRefs` shaped as `{ notification_id, kind, session_uid }[]` from `submitDueReview`, `commitReview`, final `failReviewerJob`, and `failExhaustedReviewerJobs` so the CLI can write `receipt.outbox.created` without a time-based query. Keep the existing status/count fields to avoid breaking current callers.

- [ ] **Step 9: Run store tests and commit**

Run: `node --test test/store.test.mjs`

Expected: all store tests PASS, including migration, rollback, duplicate, lease-expiry, retry history, aggregation, and retention cleanup without foreign-key failures.

```bash
git add src/schema.mjs src/receipt.mjs src/store.mjs test/store.test.mjs
git commit -m "feat: add transactional notification outbox"
```

### Task 2: Deterministic Receipt Renderer and Synthetic-Control Exclusion

**Files:**
- Modify: `src/receipt.mjs`
- Modify: `src/capture.mjs:1-340`
- Modify: `src/codex-reconcile.mjs:1-220`
- Test: `test/receipt.test.mjs`
- Test: `test/store.test.mjs`
- Test: `test/capture.test.mjs`
- Test: `test/codex-reconcile.test.mjs`

**Interfaces:**
- Consumes: `NotificationRow` from Task 1.
- Consumes: Task 1 `validateReceiptPayload` and `detectReceiptLanguage`.
- Produces: `renderReceiptLine(notification) -> string`
- Produces: `renderReceiptControl(notification) -> { line, marker, text }`
- Produces: `renderReceiptInstruction(notification) -> string`
- Produces: `stripReceiptControlText(text) -> string`
- Consumes: Task 1 legacy-v1 `receiptNonce` and `containsReceiptMarker`.
- Produces: a domain-separated v2 current-control nonce over canonical notification ID, state, and exact visible line, truncated to 16 hex.

- [ ] **Step 1: Write renderer and stripping tests**

Create `test/receipt.test.mjs` with fixed rows for every kind. Include these concrete assertions:

```js
assert.equal(detectReceiptLanguage("为什么没有触发反思", "auto"), "zh");
assert.equal(detectReceiptLanguage("why was no review started", "auto"), "en");
assert.equal(detectReceiptLanguage("why", "zh"), "zh");

const rendered = renderReceiptControl({
  notification_id: "1".repeat(64),
  job_id: `7e876e${"2".repeat(58)}`,
  kind: "review_completed",
  payload_json: JSON.stringify({ severity: "Major", lesson_count: 1 }),
  language: "zh"
});
assert.equal(rendered.line, "[AFL] 反思完成 · severity=Major · lessons=1 · job=7e876e · receipt=111111");
assert.match(rendered.marker, /^<!--afl-receipt id=[a-f0-9]{64} nonce=[a-f0-9]{16} state=review_completed-->$/);
assert.ok(rendered.line.length <= 160);
assert.ok(rendered.text.length <= 512);
assert.equal(stripReceiptControlText(`normal answer\n${rendered.line}\n${rendered.marker}`), "normal answer");
assert.equal(stripReceiptControlText(`${rendered.line}\n${rendered.marker}`), "");
```

Also assert that an unknown kind, unknown payload key, invalid severity, full session id, path-shaped value, or visible line over 160 characters throws `TypeError` before rendering. Exact-copy tests for every real outbox kind must include `receipt=<notification_id.slice(0, 6)>`. For every rendered kind, alter each grammar-valid dynamic field (`event`, `job`, `severity`, `lesson_count`) while retaining the original marker and assert the complete altered pair survives. Assert every exact generated pair strips.

- [ ] **Step 2: Run renderer tests and verify RED**

Run: `node --test test/receipt.test.mjs`

Expected: FAIL because `renderReceiptControl`, `renderReceiptLine`, `renderReceiptInstruction`, and `stripReceiptControlText` are not exported yet.

- [ ] **Step 3: Implement the pure renderer**

Define immutable copy maps for `zh` and `en`; parse `payload_json` and validate it with Task 1's contract. Keep Task 1 `receiptNonce(notification_id)` only for bounded numeric legacy observation. Current canonical controls use SHA-256 over `receipt-control:v2`, NUL separators, canonical `notification_id`, `state`, and the exact rendered visible line, truncated to 16 hex. Use this instruction format:

```text
[agent-feedback-loop receipt]
In the first user-visible update or final answer, output the following line and marker verbatim exactly once. Do not explain or expand it. This is a delivery receipt, not a request to perform reflection.
<visible line>
<hidden marker>
```

`renderReceiptInstruction` must assert the complete instruction is at most 512 characters. `stripReceiptControlText` removes only an adjacent generated line/marker pair after verifying canonical 64-hex ID, known state, state-specific visible grammar, `receipt=<marker id first 6>`, and the exact v2 nonce recomputed from that adjacent complete line. It must preserve ordinary AFL prose, quoted or malformed pairs, any grammar-valid visible-field edit retaining an old marker, mismatched binding/state/nonce, old lines without binding, and complete controls inside backtick or tilde fenced code blocks. `containsReceiptMarker` must require the authoritative row's v2 marker for canonical rows; a canonical ID-only v1 marker must not observe. Numeric legacy observation remains a separate bounded v1 path and must not broaden.

- [ ] **Step 4: Run renderer tests and verify GREEN**

Run: `node --test test/receipt.test.mjs`

Expected: all receipt renderer tests PASS.

- [ ] **Step 5: Write failing capture/reconciliation exclusion tests**

Add one Stop-capture test and one Codex transcript test where assistant output consists only of a receipt line and marker. Assert:

```js
assert.equal(normalized.redacted_text, "");
assert.equal(store.pendingReviewEventCount(projectId), 0);
assert.equal(store.listSessionEvents(projectId).some((event) => event.redacted_text?.includes("[AFL]")), false);
```

Add a mixed-output case and assert the normal answer is captured after receipt controls are removed. Add a real assistant transcript record with `content: []` plus tool, textual-output, file, and artifact references; assert the event is stored with all references and the cursor reaches transcript EOF.

- [ ] **Step 6: Run exclusion tests and verify RED**

Run: `node --test --test-name-pattern="receipt control" test/capture.test.mjs test/codex-reconcile.test.mjs`

Expected: FAIL because receipt text is currently treated as assistant evidence.

- [ ] **Step 7: Strip controls at both ingestion boundaries**

Import `stripReceiptControlText` into `capture.mjs` and apply it before redaction/hash normalization for assistant events. In `codex-reconcile.mjs`, extract structural evidence before any empty-text decision, strip controls from parsed assistant message content, and skip only when `hasCaptureEvidence` is false for semantic text plus tool/output/file/artifact references. Preserve structural-only events and source offsets/cursors; receipt-only events without structural evidence are skipped while the cursor still advances so the scheduler does not scan them forever.

- [ ] **Step 8: Run focused and full capture tests, then commit**

Run: `node --test test/receipt.test.mjs test/capture.test.mjs test/codex-reconcile.test.mjs`

Expected: all tests PASS and receipt-only events create no queue entries.

Before committing, run receipt/store focused tests and a real store-flow probe. Confirm current rendering/stripping never accepts legacy identifiers, canonical observation rejects v1 ID-only markers and requires the authoritative v2 marker, while v1 observation compatibility is limited to `notification-<positive safe integer>` and rejects UUID, `msg_UUID`, colon/session, and path-shaped rows.

```bash
git add src/receipt.mjs src/capture.mjs src/codex-reconcile.mjs test/receipt.test.mjs test/capture.test.mjs test/codex-reconcile.test.mjs
git commit -m "feat: render and filter deterministic review receipts"
```

### Task 3: Main-Chat Injection and Stop Confirmation Across Hosts

**Files:**
- Modify: `src/cli.mjs:353-397`
- Modify: `src/cli.mjs:517-642`
- Modify: `templates/hooks/stop-hook.sh:33-107`
- Test: `test/cli.test.mjs`
- Test: `test/e2e-smoke.test.mjs`

**Interfaces:**
- Consumes: Task 1 chat claims and Task 2 `renderReceiptInstruction`/`renderReceiptControl`.
- Produces: `capture-stop` host-native pass/block JSON.
- Produces: at most one receipt instruction in the hook's `additionalContext`.

- [ ] **Step 1: Write a failing immediate-queue receipt test**

Extend the interrupted-turn CLI test so a structural correction produces the existing checkpoint plus one queued receipt:

```js
assert.match(response.hookSpecificOutput.additionalContext, /\[AFL\] 后台反思已排队/);
assert.match(response.hookSpecificOutput.additionalContext, /<!--afl-receipt id=[^ ]+ nonce=[a-f0-9]{16} state=review_queued-->/);
assert.equal((response.hookSpecificOutput.additionalContext.match(/\[AFL\]/g) || []).length, 1);
```

Add an ordinary-prompt case that asserts the output remains `{ continue: true }` for Codex and `{}` for Claude/Gemini with no `[AFL]` text.

- [ ] **Step 2: Run the prompt-hook tests and verify RED**

Run: `node --test --test-name-pattern="receipt|ordinary prompt" test/cli.test.mjs`

Expected: FAIL because the hook does not claim or render chat notifications.

- [ ] **Step 3: Claim one notification after all hook producers finish**

In the `hook` command:

1. After a structural event is captured, call `createNotification({ sessionUid: event.session_uid, contextEpoch: event.context_epoch, kind: 'candidate_captured', eventUid: canonicalEventUid, payload: {}, language })`.
2. Let `submitDueReview` create/supersede it with `review_queued` transactionally.
3. Replace the per-card `recordDelivery` loop with one `recordDeliveries` call.
4. After queue and lesson producers finish, call `claimChatNotification` once using `event.session_uid`, `event.context_epoch`, and `event.native_turn_id`.
5. Append `renderReceiptInstruction(claimed)` to `injectedContexts`.

Respect `AGENT_FEEDBACK_LOOP_CHAT_RECEIPTS=0` by calling `suppressClaimableChatNotifications` and injecting nothing. Disabling cancels `pending`, `emitted`, and `emitted_unconfirmed` rows for the session/epoch without modifying `observed`; re-enabling cannot replay those historical rows. Pass `AGENT_FEEDBACK_LOOP_RECEIPT_LANGUAGE` through `detectReceiptLanguage(event.redacted_text, override)` when creating notifications. For every `notificationRefs` result, hash `session_uid` with SHA-256 to 12 hex characters and write `receipt.outbox.created notification=<id> kind=<kind> session=<hash>` through a dedicated receipt logger that is active even when general debug logging is off; never log the visible line or payload.

- [ ] **Step 4: Write failing Stop observation/loop-guard tests for all host schemas**

For Codex, Claude Code, and Gemini, run the installed Stop hook twice with a bound emitted notification and no marker. Assert first output is block/deny and second output is pass:

```js
assert.deepEqual(JSON.parse(codexFirst.stdout), { decision: "block", reason: expectedReason });
assert.deepEqual(JSON.parse(codexSecond.stdout), { continue: true });
assert.deepEqual(JSON.parse(claudeFirst.stdout), { decision: "block", reason: expectedReason });
assert.deepEqual(JSON.parse(claudeSecond.stdout), {});
assert.deepEqual(JSON.parse(geminiFirst.stdout), { decision: "deny", reason: expectedReason });
assert.deepEqual(JSON.parse(geminiSecond.stdout), {});
```

Then include the marker in `last_assistant_message` and assert the notification reaches `observed` without a block. Add a later prompt case proving `emitted_unconfirmed` can be claimed exactly once more and never blocks a second time.

- [ ] **Step 5: Run Stop tests and verify RED**

Run: `node --test --test-name-pattern="receipt Stop|receipt marker|receipt re-emission" test/cli.test.mjs`

Expected: FAIL because `capture-stop` always returns `{}` and `stop-hook.sh` discards its output.

- [ ] **Step 6: Make `capture-stop` authoritative in transactional mode**

Build confirmation text only from role-validated assistant message output parsed from the bounded transcript tail plus the bounded host `last_assistant_message`. Raw bytes, user messages, tool output, control records, and prompts are evidence-only and cannot confirm a receipt. Keep owned-file, regular-file, inode/device, and tail-size checks; log a coverage gap when a readable tail has no recognized assistant output. Call `confirmChatNotification`; when it returns `block`, render the exact line and marker in the reason and emit the native host schema:

```js
function stopResponse(cli, result) {
  if (result.action !== "block") return cli === "codex" ? { continue: true } : {};
  const reason = `Output this receipt verbatim before stopping:\n${renderReceiptControl(result.notification).text}`;
  return cli === "gemini"
    ? { decision: "deny", reason }
    : { decision: "block", reason };
}
```

Change the transactional branch of `stop-hook.sh` to capture stdout, print it, and exit immediately on success:

```sh
if [ "$legacy_mode" -eq 0 ] && [ -x "$runtime_launcher" ]; then
  if transactional_output="$(printf '%s' "$payload" | "$runtime_launcher" capture-stop --cli "$MODE" 2>>"$LOG_FILE")"; then
    printf '%s\n' "$transactional_output"
    exit 0
  fi
fi
```

Keep the existing marker-file branch reachable only in explicit legacy mode. Log `receipt.chat.emitted`, `receipt.chat.observed`, and `receipt.chat.unconfirmed` with notification id and count only.

- [ ] **Step 7: Run cross-host and end-to-end tests, then commit**

Run: `node --test test/cli.test.mjs test/e2e-smoke.test.mjs`

Expected: all tests PASS; ordinary prompts remain zero-injection; each notification blocks at most once and emits at most twice.

```bash
git add src/cli.mjs templates/hooks/stop-hook.sh test/cli.test.mjs test/e2e-smoke.test.mjs
git commit -m "feat: confirm review receipts in main conversations"
```

### Task 4: Leased Native System Notifications

**Files:**
- Create: `src/notifier.mjs`
- Modify: `src/cli.mjs:290-445`
- Modify: `src/codex-reconcile.mjs:430-580`
- Test: `test/notifier.test.mjs`
- Test: `test/e2e-smoke.test.mjs`

**Interfaces:**
- Consumes: `store.claimSystemNotifications({ ownerId, nowMs, leaseMs, limit }) -> NotificationRow[]`
- Consumes: `store.completeSystemNotification({ notificationId, ownerId, leaseEpoch: claimed.system_lease_epoch, deliveredAt }) -> boolean`
- Consumes: `store.failSystemNotification({ notificationId, ownerId, leaseEpoch: claimed.system_lease_epoch, reasonCode, nowMs }) -> boolean`
- Consumes: `store.markSystemNotificationUnsupported({ notificationId, ownerId, leaseEpoch: claimed.system_lease_epoch, reasonCode }) -> boolean`
- Consumes: Task 2 renderer.
- Produces: `createSystemNotifier({ platform, env, execFileImpl, accessImpl }) -> { adapter, supported, send }`
- Produces: `drainSystemNotifications({ store, notifier, ownerId, nowMs, leaseMs, limit, log }) -> { claimed, delivered, failed, unsupported }`

- [ ] **Step 1: Write failing adapter and drain tests**

Create `test/notifier.test.mjs` with injected process functions, never the real desktop notifier. Assert:

```js
const calls = [];
const mac = createSystemNotifier({
  platform: "darwin",
  env: {},
  accessImpl: async () => undefined,
  execFileImpl: async (file, args) => { calls.push({ file, args }); }
});
await mac.send(notification);
assert.equal(calls[0].file, "/usr/bin/osascript");
assert.equal(calls[0].args.includes("sh"), false);

const result = await drainSystemNotifications({ store, notifier: mac, ownerId: "notifier-test", nowMs: 1_000 });
assert.deepEqual(result, { claimed: 1, delivered: 1, failed: 0, unsupported: 0 });
assert.equal(store.listNotifications({ jobId })[0].system_state, "delivered");
```

Add Linux `notify-send`, Windows unsupported, process failure/backoff, two-worker lease fencing, and expired-lease recovery cases. Reclaim three rows with the same owner and assert complete, fail, and unsupported calls using each stale `system_lease_epoch` return `false`; then assert the same calls succeed with each current claimed row's epoch.

- [ ] **Step 2: Run notifier tests and verify RED**

Run: `node --test test/notifier.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/notifier.mjs`.

- [ ] **Step 3: Implement safe platform adapters**

Use `execFile`, never a shell string:

```text
darwin: /usr/bin/osascript -e with an AppleScript `display notification` statement assembled from the escaped deterministic receipt line and the fixed title `Agent Feedback Loop`
linux:  resolved notify-send executable, arguments [title, body]
win32:  supported=false, reason=adapter_unverified
other:  supported=false, reason=platform_unsupported
```

The title is `Agent Feedback Loop`; the body is the deterministic visible receipt line. Escape AppleScript backslashes and double quotes in data before passing the script as one `-e` argument. On unsupported platforms, claim each due notification and call `markSystemNotificationUnsupported({ notificationId: claimed.notification_id, ownerId, leaseEpoch: claimed.system_lease_epoch, reasonCode })` so the scheduler does not spin.

- [ ] **Step 4: Implement leased draining and structured logs**

`drainSystemNotifications` claims at most 16 rows with a 30-second lease, sends sequentially, and calls exactly one terminal store method per row. Delivery calls `completeSystemNotification` with `leaseEpoch: claimed.system_lease_epoch`; transport errors call `failSystemNotification` with that same claimed epoch; unsupported adapters call `markSystemNotificationUnsupported` with that same claimed epoch. Never look up or substitute a later epoch by notification id. Emit these log events through the provided logger:

```text
receipt.system.delivered notification=<id> adapter=<adapter>
receipt.system.failed notification=<id> reason=<reason_code>
receipt.system.unsupported notification=<id> reason=<reason_code>
```

Do not log rendered body text. Retry failures according to the backoff persisted by Task 1.

- [ ] **Step 5: Drain after reviewer completion and every reconcile pass**

In `reviewer-run`, persist `codex|claude|gemini` or `explicit_command` with `setReviewerProvider`, log returned `notificationRefs`, then call the drainer after `runner.runJob` returns and before closing the store. In `reviewer-submit`, persist `prompt_subagent`, log returned refs, and drain after the receipt commits. Make `reconcileCodexTranscripts` aggregate `notificationRefs` from due and exhaustion transitions; the `reconcile` command logs them, drains after reconciliation, and writes notifier counts into runtime status. When `AGENT_FEEDBACK_LOOP_SYSTEM_NOTIFICATIONS=0`, call `suppressDueSystemNotifications({ nowMs: Date.now(), reasonCode: 'disabled_by_config' })` and report `{ status: 'disabled', suppressed: count }` in runtime status.

If `reviewer-run` throws, do not manufacture a terminal notification; the existing reviewer failure/retry state and later exhaustion transition remain the source of truth.

- [ ] **Step 6: Add and run reviewer/reconcile integration tests**

Add an integration test in `test/notifier.test.mjs` whose fake reviewer receipt is committed to a real temporary store, whose injected notifier records a call, and whose second drain claims zero rows. Add a failed notifier case whose review remains `completed` while `system_state='failed'`. Set `AGENT_FEEDBACK_LOOP_SYSTEM_NOTIFICATIONS=0` in existing child-process reviewer tests so automated regression never displays a real desktop notification; only Task 7 enables native delivery.

Run: `node --test test/notifier.test.mjs test/e2e-smoke.test.mjs test/codex-reconcile.test.mjs`

Expected: all tests PASS; review status is independent from notifier status and no terminal notification is sent twice.

- [ ] **Step 7: Commit**

```bash
git add src/notifier.mjs src/cli.mjs src/codex-reconcile.mjs test/notifier.test.mjs test/e2e-smoke.test.mjs test/codex-reconcile.test.mjs
git commit -m "feat: deliver leased background review notifications"
```

### Task 5: Review Audit CLI

**Files:**
- Modify: `src/store.mjs:713-1065`
- Modify: `src/cli.mjs:144-190`
- Modify: `src/cli.mjs:447-516`
- Test: `test/store.test.mjs`
- Test: `test/cli.test.mjs`

**Interfaces:**
- Produces: `store.listReviews({ sessionUid, status, limit }) -> ReviewSummary[]`
- Produces: `store.showReview(jobId) -> ReviewAudit | null`
- Produces: `agent-feedback-loop review list [--session <id>] [--status <state>] [--home <path>]`
- Produces: `agent-feedback-loop review show <job-id> [--home <path>]`

- [ ] **Step 1: Write failing audit projection tests**

Build one completed job with one lesson/application and assert the summary contains only structured data:

```js
const rows = store.listReviews({ sessionUid: event.session_uid, status: "completed", limit: 10 });
assert.equal(rows.length, 1);
assert.deepEqual(Object.keys(rows[0]).sort(), [
  "attempt", "chat_states", "created_at", "job_id", "lesson_count", "provider",
  "reason_code", "session_uids", "severity", "status", "system_states", "updated_at"
].sort());

const audit = store.showReview(job.job_id);
assert.equal(audit.job.job_id, job.job_id);
assert.equal(audit.receipt.receipt_id, review.review_receipt_id);
assert.deepEqual(audit.failure_history.map((row) => row.state), ["claimed", "completed"]);
assert.equal(audit.lessons.length, 1);
assert.equal(audit.notifications.some((row) => row.kind === "review_completed"), true);
assert.equal(JSON.stringify(audit).includes("reviewer_capability"), false);
```

- [ ] **Step 2: Run audit tests and verify RED**

Run: `node --test --test-name-pattern="review audit" test/store.test.mjs test/cli.test.mjs`

Expected: FAIL because audit methods and the `review` command do not exist.

- [ ] **Step 3: Implement bounded store projections**

`listReviews` joins jobs, assigned event sessions, review receipt payloads, and notification states. Clamp `limit` to `1..200`; exact-match `status`; accept either internal `session_uid` or native session id. `showReview` returns:

```js
{
  job,
  sessions,
  evidence: { queued_event_ids, feedback_candidate_event_ids },
  failure_history,
  receipt,
  report: { content_id, content_text },
  lessons,
  deliveries,
  effectiveness,
  notifications
}
```

Use `reviewer_provider` for the provider field; never substitute the source session's CLI. Use already redacted persisted report/event content. Remove capability hash/expiry/consumption fields and encrypted raw references from output. Limit every collection to 200 rows and report truncation counts.

- [ ] **Step 4: Add CLI parsing and output tests**

Test `review list --session session-a --status completed` and `review show <job-id>`. Assert valid JSON, exact job selection, state distinction, and nonzero exit with `review job not found` for an unknown id.

- [ ] **Step 5: Implement the command and help text**

Add help entries and a `command === "review"` branch. Parse `--session` and `--status` with the existing `optionValue`; use positional `options.args[0]` for `list|show` and `options.args[1]` for the show id. Print:

```js
{ command: "review", action: "list", reviews: rows }
{ command: "review", action: "show", review: audit }
```

Do not call a reviewer or notifier from these read-only commands.

- [ ] **Step 6: Run tests and commit**

Run: `node --test test/store.test.mjs test/cli.test.mjs`

Expected: all tests PASS and audit output contains no capability secret or encrypted raw reference.

```bash
git add src/store.mjs src/cli.mjs test/store.test.mjs test/cli.test.mjs
git commit -m "feat: expose background review audit commands"
```

### Task 6: Version, Documentation, and Packaging

**Files:**
- Modify: `src/index.mjs:24-27`
- Modify: `package.json:1-8`
- Modify: `README.md`
- Modify: `README-zh.md`
- Test: `test/cli.test.mjs`

**Interfaces:**
- Consumes: all user-visible behavior from Tasks 1-5.
- Produces: installable runtime/package `0.7.5`, documented status contract and environment flags.

- [ ] **Step 1: Write a failing install/version assertion**

Extend installation tests:

```js
const current = JSON.parse(await readFile(path.join(home, ".agent", "feedback-loop", "current.json"), "utf8"));
assert.equal(current.runtimeVersion, "0.7.5");
assert.match(pathsFor(home).runtimeRoot, /versions\/0\.7\.5$/);
const versionStore = openStore({ paths: pathsFor(home) });
assert.equal(versionStore.capability.schemaVersion, 8);
versionStore.close();
```

- [ ] **Step 2: Run the version assertion and verify RED**

Run: `node --test --test-name-pattern="0.7.5|runtime version" test/cli.test.mjs`

Expected: FAIL because runtime/package still report `0.7.4`.

- [ ] **Step 3: Bump package/runtime and document exact semantics**

Set both `package.json` version and `RUNTIME_VERSION` to `0.7.5`. Update both READMEs with:

- the six receipt examples from the design;
- the distinction between captured, queued, completed, no-lesson, exhausted, emitted, and observed;
- `review list` and `review show` examples;
- `AGENT_FEEDBACK_LOOP_CHAT_RECEIPTS`, `AGENT_FEEDBACK_LOOP_SYSTEM_NOTIFICATIONS`, and `AGENT_FEEDBACK_LOOP_RECEIPT_LANGUAGE` defaults;
- macOS/Linux/Windows notification capability limits;
- the guarantee that full reflection remains in the background reviewer process;
- the cross-host boundary that terminal completion is delivered immediately by a system notification and appended to the main conversation only on that session's next real prompt unless a verified native chat adapter exists;
- the statement that a healthy doctor/config file does not prove a hook event, reviewer receipt, or visible chat receipt;
- the token bound: ordinary prompts add zero receipt text, and one active receipt adds at most 512 control characters.

- [ ] **Step 4: Verify package contents and docs**

Run: `npm pack --dry-run`

Expected: package includes `src/receipt.mjs`, `src/notifier.mjs`, both READMEs, hook templates, and reports version `0.7.5`.

Run: `rg -n "0\.7\.4|Windows.*(supported=true|available)" README.md README-zh.md src/index.mjs package.json`

Expected: no stale `0.7.4`; docs do not promise hidden reasoning or verified Windows notifications.

- [ ] **Step 5: Run full automated regression and commit**

Run: `npm test`

Expected: the complete suite passes with zero failures.

```bash
git add src/index.mjs package.json README.md README-zh.md test/cli.test.mjs
git commit -m "docs: publish observable background review workflow"
```

### Task 7: Installed Runtime and True-Machine Acceptance

**Files:**
- Create: `docs/superpowers/verification/2026-07-15-background-review-observability.md`
- Modify when acceptance exposes a defect: the smallest owning source/test file from Tasks 1-6

**Interfaces:**
- Consumes: packaged runtime `0.7.5`, all host hooks, scheduler, reviewer adapters, notification outbox, and audit commands.
- Produces: reproducible acceptance evidence with real IDs, counts, before/after state, and explicit unavailable boundaries.

Tasks 1-6 must use disposable `--home` roots and must not install a partial branch into the real `~/.agent`. Task 7 owns the first atomic replacement of the user-level runtime after the complete package is assembled. It must record the pre-install `current.json` and hook hashes, install once, verify the installed version/schema and template hashes, and prove transactional Stop stdout forwarding from the real installed hook before any L1 claim.

- [ ] **Step 1: Establish a clean automated baseline**

Run:

```bash
npm test
node ./bin/agent-feedback-loop.mjs install --home "$HOME"
node ./bin/agent-feedback-loop.mjs doctor --home "$HOME" --live
node ./bin/agent-feedback-loop.mjs review list --home "$HOME"
```

Expected: tests pass; the atomic install replaces the previously recorded runtime, installed current runtime is `0.7.5`, schema is `8`, installed hook hashes match the packaged templates, a bound receipt proves the real installed Stop hook forwards transactional stdout, `doctor --live` reports only capabilities it actually tested, and `review list` returns valid JSON.

- [ ] **Step 2: Prove a new Codex task and a non-trigger control**

Create a fresh Codex desktop task rooted in a new empty temporary project so old queue events cannot contaminate the control. First send one ordinary implementation request and record before/after counts showing no immediate reviewer job and no notification. Next start a response, interrupt that active turn, and send a concrete correction referring to the visible assistant mistake; this supplies the structural `active_turn_steering`/`prior_turn_interrupted` signal without relying on language keywords. Record:

```text
native session id
user event uid
reviewer job id
review receipt id
notification id
job status before/after
chat_state before/after
system_state before/after
lesson count
```

Use Computer Use to inspect the task and verify exactly one `[AFL]` line appears for the queued state and one terminal line appears on the next available turn. Capture a screenshot only after confirming the IDs in SQLite/`review show` match the visible short id.

- [ ] **Step 3: Prove an existing long-running Codex task**

Use a task that existed before the runtime installation. Send a concrete correction and run the scheduler twice:

```bash
node ./bin/agent-feedback-loop.mjs reconcile --home "$HOME" --scheduled
node ./bin/agent-feedback-loop.mjs reconcile --home "$HOME" --scheduled
```

Record whether the existing host hot-loaded the prompt hook. If it did not, prove transcript reconciliation, persisted event/job/outbox, system notification, and next-prompt delivery separately; do not label chat delivery observed until the hidden marker is present in that task's transcript.

- [ ] **Step 4: Prove failure and expired-lease recovery**

Use a disposable home and deterministic reviewer fixture to force one retryable provider failure, expire its lease, and then allow a successful review. Run reconcile twice and record `attempt`, `lease_epoch`, unique receipt count, and unique notification count. Assert the stale worker cannot commit and the final job has exactly one terminal outbox row.

Run the focused regression after the fixture:

```bash
node --test --test-name-pattern="expired|retry|stale reviewer|notification" test/store.test.mjs test/notifier.test.mjs test/codex-reconcile.test.mjs test/e2e-smoke.test.mjs
```

Expected: all focused recovery tests PASS.

- [ ] **Step 5: Attempt Claude Code and Gemini CLI acceptance independently**

For each installed/authenticated CLI, run one ordinary prompt and one concrete correction in a new session. Record native event availability, event persistence, job/receipt/outbox ids, Stop marker observation, and visible receipt. If a CLI, authentication, transcript, or event is unavailable, record the exact command/error and mark only that host row `unavailable` or `unverified`; never infer support from Codex.

- [ ] **Step 6: Write the evidence document with actual results**

The verification document must contain:

1. exact commit and runtime versions;
2. full automated command results and pass counts;
3. one table per host with actual session/job/receipt/notification ids;
4. before/after counts for events, jobs, review receipts, lessons, deliveries, and notifications;
5. scheduler run 1/run 2 results;
6. retry/lease recovery evidence;
7. Computer Use attempt and visible-result status;
8. explicit L0 automated versus L1 live acceptance labels;
9. defects found and the test added before each repair.

- [ ] **Step 7: Re-run verification after any acceptance repair**

For each defect, add a failing automated test, observe RED, apply the smallest owning fix, observe GREEN, rerun `npm test`, reinstall runtime `0.7.5`, and repeat the affected true-machine row. Do not replace the original failed evidence; append the repaired run so the transition remains auditable.

- [ ] **Step 8: Final review and commit**

Run:

```bash
npm test
git diff --check
git status --short
node ./bin/agent-feedback-loop.mjs doctor --home "$HOME" --live
```

Expected: full suite passes, no whitespace errors, only intended verification/source changes remain, and live doctor truthfully reports host capability without standing in for event/receipt proof.

```bash
git add docs/superpowers/verification/2026-07-15-background-review-observability.md
git add src test templates README.md README-zh.md package.json
git commit -m "test: verify observable background reviews"
```

## Final Acceptance Checklist

- [ ] Schema migration from v7 to v8 preserves all prior reviews, lessons, deliveries, and sessions.
- [ ] Immediate structural feedback creates one queued notification and launches at most one reviewer wake.
- [ ] Terminal review notification is committed with the review receipt, not before it.
- [ ] A rejected/stale review commit creates no terminal success notification.
- [ ] Ordinary prompts produce no notification row, no extra injected text, and no extra reviewer request.
- [ ] Receipt-only assistant output cannot become feedback evidence or lesson-selector input.
- [ ] Chat receipt binds to one native turn, is observed only by nonce evidence, blocks once, and re-emits once at most.
- [ ] System notifier uses leases, retries independently, and cannot change a completed reviewer job.
- [ ] Lesson delivery receipt and aggregated user-visible notification share one transaction.
- [ ] `review list/show` distinguish job, review receipt, lesson, delivery, effectiveness, chat, and system states without secrets.
- [ ] `review show` reports persisted claim/requeue/failure/completion history rather than reconstructing it from the final job row.
- [ ] New and existing Codex tasks have separate real evidence; Claude Code and Gemini are not inferred from Codex.
- [ ] Scheduler repeat, provider failure, lease expiry, stale worker fencing, and no-trigger control are evidenced.
- [ ] Computer Use is attempted and the visible UI result or exact access limitation is recorded.
- [ ] Full tests, installed `doctor --live`, actual event rows, final review receipt, and visible/system receipt are reported as separate proof layers.
- [ ] The real `~/.agent` runtime is replaced only in Task 7 and its installed Stop hook is proven to forward transactional stdout.
