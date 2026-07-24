# Task 4 Implementation Report — Capture Fail-Open Diagnostics

## Worktree note

This task was implemented in `/Users/sunxingda/project/agent-feedback-loop/.claude/worktrees/agent-afd3f7b4d5e838587`, not the coordinator worktree named in the brief path (`.../worktrees/semantic-dissatisfaction-gate`). Harness pinning gave write access only to this worktree. The coordinator should cherry-pick commit `89e0476` from this worktree's branch (`worktree-agent-afd3f7b4d5e838587`) if it needs the change on the coordinator branch.

## Goal

When prompt-event durability fails inside the capture path, the prompt hook must still fail open to the host, but the failure must leave a bounded, queryable diagnostic trail so capture misses are not silent forever.

## Design

- Reused the existing `store_meta` key/value table — no schema migration.
- Added two constants in `src/control-store.mjs`: `CAPTURE_FAIL_OPEN_META_KEY` and `MAX_CAPTURE_FAIL_OPEN_RECORDS` (50).
- Added `recordCaptureFailOpen({ eventType, reasonCode, sourceProvider, sessionUid, eventUid, createdAt })` and `listCaptureFailOpen()` methods on the control store. Records are stored as a JSON array under one `store_meta` row, capped to the most recent 50 entries (bounded ring buffer, oldest evicted first).
- Rejected reusing `review_job_events`: it has a NOT NULL foreign key to `reviewer_jobs(job_id)`, which does not exist yet at prompt-capture time. Using it would require inserting spurious `reviewer_jobs` rows and would violate existing job-count invariants.
- In `src/capture.mjs`, wrapped the `store.resolveOrInsertCapture(...)` call inside `capturePreparedControlSession` in a try/catch. On failure, a new `recordCaptureFailOpen` helper writes a best-effort diagnostic record (bounded reason code, source provider, session uid, event uid, timestamp) and then rethrows the original error unchanged.
- The reason code is derived from `ControlStoreError.code` when available (validated against `/^[a-z][a-z0-9_]{0,63}$/`), else falls back to a fixed default (`session_event_write_failed`) — this keeps the reason code always bounded and safe to persist even for unexpected error shapes.
- The diagnostic write itself is wrapped in its own try/catch so that if `store.recordCaptureFailOpen` throws (e.g. diagnostics backend unavailable), the original durability error still propagates unchanged. This is explicitly covered by a test that monkey-patches `recordCaptureFailOpen` to throw.
- `captureSession` / `captureObservedSession` gained an optional `now` parameter (default `() => new Date()`) for deterministic timestamps in tests. This is purely additive; existing call sites are unaffected.
- `normalizeHookEvent({ cli, payload, installationId, timeout, timeoutUnit, capturePolicyRevision })` was not touched — signature and behavior preserved.
- No changes to `src/cli.mjs`, reviewer/provider/runner/e2e files — out of scope per brief, confirmed untouched (`git status` shows only the three intended files).

## Tests added (`test/capture.test.mjs`)

1. `capture durability failure records a bounded queryable fail-open reason code` — forces a `session_events` insert abort via a temp SQLite trigger, asserts the original error still surfaces to the caller, and asserts exactly one fail-open record is stored with the expected shape (`event_type`, bounded `reason_code`, `session_uid`, `created_at`).
2. `capture fail-open log is bounded and keeps the most recent records` — forces 55 consecutive failures and asserts the stored log never exceeds 50 records (ring buffer eviction works).
3. `capture fail-open recording never masks the original durability error` — monkey-patches `store.recordCaptureFailOpen` to throw, and asserts the original forced abort error is still the one that propagates to the caller.

## Test summary

- Focused run: `node --test test/capture.test.mjs` → 29/29 pass (26 pre-existing + 3 new).
- Full run: `npm test` (full `node --test` suite) → 525/525 pass, 0 failures. No regressions.

## Status

Done. Commit `89e0476` on branch `worktree-agent-afd3f7b4d5e838587` in this worktree.

## Concerns

- None blocking. One note for the coordinator: the coordinator's own worktree (`semantic-dissatisfaction-gate`) will need this commit cherry-picked since it was not directly writable from this session.
- The bound of 50 records for the fail-open ring buffer is a reasonable default for diagnosability without unbounded growth, but it is a judgment call (not specified in the brief) — flagging in case the coordinator wants a different retention size.
