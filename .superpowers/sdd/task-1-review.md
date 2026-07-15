# Task 1 Independent Review

## Review Range

- Base: `3416d18`
- Head: `d8df227`
- Reviewer: independent fresh agent

## Findings

No Critical findings.

Important findings requiring correction:

1. Overlapping delivery batches reused an earlier aggregate notification and lost the expanded `lesson_count` semantics.
2. Bounded evidence replacement left stale queue notifications eligible for later terminal notifications.
3. System notification leases were fenced only by owner ID, so a stale worker could commit after the same owner reclaimed an expired lease.
4. Notification language inheritance leaked across sessions sharing a reviewer job.
5. The schema-v8 return contract caused a real Codex reconciliation compatibility regression, and the runtime schema assertion remained stale.

## Required Verification

- Add regression tests for every finding before fixes and observe RED.
- Preserve schema-v8 migration idempotency and verify foreign keys.
- Restore a fully green repository test suite before Task 2.

## Resolution

- Delivery identity now covers the complete sorted application set.
- Displaced evidence is suppressed and excluded from terminal recipients.
- System notification terminal transitions require owner plus lease epoch.
- Language is scoped to the exact reviewed assignment.
- Codex compatibility and schema-v8 runtime assertions are green.
- Retention deletes only notifications bound to events selected for GC, preventing `NULL`-identity collisions.

## Status

APPROVED after fresh final review. No Critical or Important findings remain. Full suite: 170 passed, 0 failed.
