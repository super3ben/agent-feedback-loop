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
