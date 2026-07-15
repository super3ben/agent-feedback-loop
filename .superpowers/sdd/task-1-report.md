# Task 1 Report

## Status

Implemented the schema-v8 notification outbox and store state-machine contract in commit `ef262971eec2abd3e0778bd87e94798cc5471ec5`.

## RED Evidence

1. `node --test --test-name-pattern="schema v8 migrates" test/store.test.mjs`
   - Result: 0 passed, 1 failed.
   - Expected failure: `TypeError: store.createNotification is not a function`.
2. `node --test --test-name-pattern="chat claim|system lease" test/store.test.mjs`
   - Result: 0 passed, 2 failed.
   - Expected failures: `store.claimChatNotification` and `store.claimSystemNotifications` were undefined.
3. `node --test --test-name-pattern="successful retry|transaction-bound" test/store.test.mjs`
   - Result: 0 passed, 2 failed.
   - Expected failures: `store.listReviewerJobEvents` was undefined and no transaction-bound `review_queued` notification existed.
4. Self-review regressions: `node --test --test-name-pattern="chat claim|terminal chat suppression" test/store.test.mjs`
   - Result before predicate fixes: 0 passed, 2 failed.
   - Expected failures proved that one native turn could claim twice and terminal suppression affected an unrelated candidate.

## Files Changed

- `src/schema.mjs`
- `src/receipt.mjs`
- `src/store.mjs`
- `test/store.test.mjs`
- `.superpowers/sdd/task-1-report.md`

## Design Decisions

- Schema v8 is additive and idempotent. Fresh schema creation and v7 migration use the same SQL, while `reviewer_provider` remains in the duplicate-column-safe migration list.
- Notification IDs are SHA-256 hashes of the exact semantic tuple. Payloads are allowlisted and validated before any SQLite write; notification rows remain unparsed snake-case database objects.
- Reviewer job transition IDs are deterministic over job, lease epoch, state, and reason. Transition rows are written inside the same transaction as claims, requeues, completion, failures, and retry exhaustion, and exclude owner/context/report/receipt content.
- Chat delivery allows one claim per native turn, one block before unconfirmed pass-through, and one retry. Terminal suppression is scoped through matching queue assignments or queue notifications.
- System delivery uses owner-fenced leases, expired-lease takeover, capped exponential backoff, explicit unsupported state, and suppression that prevents historical replay after configuration changes.
- Queue, review, failure, exhaustion, and aggregated lesson-delivery notifications are created inside their owning transactions. Public return values expose deterministic `notificationRefs` without time-based follow-up queries.
- `recordDelivery` remains a compatibility wrapper over transaction-bound `recordDeliveries`; missing legacy sessions receive a minimal local session row so notification foreign keys remain valid.

## Tests And Results

- `node --test --test-name-pattern="schema v8" test/store.test.mjs`: 2 passed, 0 failed.
- `node --test --test-name-pattern="chat claim|system lease|disabled receipt" test/store.test.mjs`: 3 passed, 0 failed.
- `node --test --test-name-pattern="successful retry|transaction-bound" test/store.test.mjs`: 2 passed, 0 failed.
- `node --test --test-name-pattern="chat claim|terminal chat suppression" test/store.test.mjs`: 2 passed, 0 failed after predicate fixes.
- `node --test --test-name-pattern="context preparation failure" test/reviewer-runner.test.mjs`: 1 passed, 0 failed.
- `node --test test/store.test.mjs`: 40 passed, 0 failed.
- `npm test`: 160 passed, 2 failed. Both failures are outside Task 1 ownership and assert pre-Task-1 contracts:
  - `test/codex-reconcile.test.mjs` expects numeric `failExhaustedReviewerJobs()` instead of the required `{ count, notificationRefs }` result.
  - `test/runtime.test.mjs` expects schema version 7 instead of schema version 8.
- `git diff --check`: passed with no whitespace errors before the implementation commit.
- Computer Use real-machine attempt: Terminal UI access was prohibited by the safety layer, and the subsequent app inspection reported that the Mac was locked. Host macOS Node tests above still executed against the real local SQLite runtime.

## Commit SHA

- Implementation: `ef262971eec2abd3e0778bd87e94798cc5471ec5`

## Residual Concerns

- The two other-owned tests listed above must be updated by their owning tasks before the repository-wide suite can be fully green.
- UI-level real-machine verification could not proceed while the Mac was locked; no UI behavior is part of this store-only task.

## Review Fixes

### Status

All five Important findings from the independent Task 1 review are fixed in implementation commit `2caf297bc529124e4a05b726bcc681158bfba98b`.

### RED Evidence

1. `node --test --test-name-pattern="delivery notification identity|bounded immediate replacement|system lease epoch|languages stay scoped|exhausted reviewer job fails visibly" test/store.test.mjs test/codex-reconcile.test.mjs`
   - Result before production changes: 0 passed, 5 failed.
   - Delivery-set failure: expanded and overlapping batches returned the first batch's notification ID.
   - Queue replacement failure: the displaced session's `review_queued` row remained `pending`.
   - Lease failure: claimed rows had no `system_lease_epoch`, so same-owner reuse had no fencing token.
   - Language failure: the English session inherited `zh` from another session on the shared job.
   - Compatibility failure: `exhaustedReviewerJobs` was `{ count, notificationRefs }` instead of numeric `1`.
2. `node --test --test-name-pattern="realistic v7|delivery writes roll back|reviewer provider and retry exhaustion|retention GC deletes old evidence" test/store.test.mjs`
   - Result before production changes: 3 passed, 1 failed.
   - Expected migration failure: the reopened schema-v8 outbox lacked `semantic_key` and `system_lease_epoch`.

### Fixes

- Aggregated delivery identity now includes the complete sorted application-ID set; reordered batches deduplicate while expanded or overlapping sets create distinct payloads.
- Bounded replacement suppresses the displaced queue notification, and terminal recipients require a current `queue_events` assignment plus a matching candidate/queue notification for that exact event.
- System notification claims increment a durable monotonic `system_lease_epoch`; completion, failure, and unsupported transitions require owner plus epoch.
- Event-bound language detection uses the referenced event, while terminal inheritance is constrained by job, session, and context epoch.
- Codex reconciliation keeps `exhaustedReviewerJobs` numeric and aggregates notification references separately in `notificationRefs`.
- Schema version remains 8. Both realistic v7 reopen and pre-fence v8 same-version migration preserve rows, reopen idempotently, and pass `PRAGMA foreign_key_check`.

### Tests And Results

- Targeted five-finding GREEN command above: 5 passed, 0 failed.
- `node --test --test-name-pattern="realistic v7|delivery writes roll back|reviewer provider and retry exhaustion|retention GC deletes old evidence|system lease expires" test/store.test.mjs`: 5 passed, 0 failed.
- `node --test --test-name-pattern="pre-fence v8" test/store.test.mjs`: 1 passed, 0 failed.
- `node --test test/store.test.mjs test/codex-reconcile.test.mjs test/runtime.test.mjs`: 69 passed, 0 failed.
- `npm test`: 168 passed, 0 failed.
- `git diff --check`: passed with no whitespace errors.
- Computer Use real-machine attempt: the Mac was locked and automatic unlock failed. The host macOS Node/SQLite tests above ran on the real machine; this task has no UI behavior.

### Remaining Concerns

- A pre-fix v8 multi-application notification did not store its full application set, so that exact legacy aggregate cannot be reconstructed during migration. It is retained under a legacy semantic key; a later replay creates one fresh, correct set-based notification rather than reusing stale payload.
- Task 4's system notifier must pass each claimed row's `system_lease_epoch` into completion, failure, and unsupported transitions. No notifier call site exists in the current Task 1 code.

## Important Re-review Fixes

### Status

Both remaining Important Task 1 re-review findings are fixed in implementation commit `02f98a054e3e9c4674cb5d6af453b0761464d63f`.

### RED Evidence

- `node --test --test-name-pattern="terminal language follows the assigned candidate" test/store.test.mjs`
  - Result before the store fix: 0 passed, 1 failed.
  - Exact assertion: actual `zh`, expected `en`.
  - The fixture had an English candidate notification assigned to the job, no `review_queued` row, and a later unrelated Chinese user event in the same session.

### Fixes

- Terminal no-lesson and exhausted notifications now receive language explicitly from the exact current queue assignment's candidate/queue notification. Review-completed notifications receive language explicitly from the validated feedback evidence event assigned to the same job. No terminal path in this change falls back to the session's latest unrelated user event.
- The tracked implementation plan now requires `leaseEpoch` for complete, fail, and unsupported store transitions, documents `system_lease_epoch`, requires every Task 4 notifier call to pass the claimed row's epoch, and requires stale same-owner writes to fail for all three terminal methods.
- Regenerated `.superpowers/sdd/task-1-brief.md` and `.superpowers/sdd/task-4-brief.md` with `/Users/sunxingda/.codex/skills/subagent-driven-development/scripts/task-brief`. The generated outputs were 420 and 93 lines respectively and matched fresh temporary generator output byte-for-byte.

### Tests And Results

- Focused RED-to-GREEN rerun: `node --test --test-name-pattern="terminal language follows the assigned candidate" test/store.test.mjs`: 1 passed, 0 failed.
- Focused language and lease-contract run: `node --test --test-name-pattern="terminal language follows the assigned candidate|system lease epoch fences stale transitions" test/store.test.mjs`: 2 passed, 0 failed.
- Full store run: `node --test test/store.test.mjs`: 47 passed, 0 failed.
- Full repository run: `npm test`: 169 passed, 0 failed, 0 skipped.
- `git diff --check`: passed with no whitespace errors before the implementation commit.
- Self-review confirmed only `src/store.mjs`, `test/store.test.mjs`, and the tracked implementation plan were included in the implementation commit; generated briefs remain ignored derived artifacts.
- Computer Use real-machine attempt: controlling `com.apple.Terminal` was denied by the Computer Use safety runtime. The macOS host Node/SQLite tests above executed locally; Task 1 has no native system-notifier UI to exercise.

### Commit SHA

- Implementation: `02f98a054e3e9c4674cb5d6af453b0761464d63f`

### Remaining Concerns

- Task 4 has not been implemented yet, so native notification delivery is outside this Task 1 re-review. Its regenerated brief now carries the required claimed-row lease-epoch contract.
