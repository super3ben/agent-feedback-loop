# Legacy control-plane audit

## Scope and method

This audit records every runtime-affecting path changed by
`git diff --name-status 7d6b1e3^..9c89e00`, before the lean control store is
introduced. The old `feedback-loop.sqlite3` remains transitional-only in Task
1: it is neither opened nor migrated by the new control-store path.

| Symbol/path | Keep primitive | Delete old architecture | Replacement task |
| --- | --- | --- | --- |
| `src/schema.mjs`: `schema_migrations`, `store_meta` conventions | The generic SQLite migration metadata convention may guide the new isolated store. | Schema v9 lesson, report, receipt, notification, episode, maintenance, scheduler and long-term-body tables must not be imported into `control.sqlite3`. | Task 1 defines the isolated v1 table set; Task 13 removes the legacy schema/runtime. |
| `src/store.mjs`: transaction wrapper and bounded metadata validation | Transaction boundaries, opaque identifiers, FK use, duplicate-safe inserts and fenced-lease concepts are reusable primitives. | `openStore()` DDL/migration, notification delivery state, receipt delivery, episode router, maintenance state, resident-scheduler state and any lesson/report/card body access are legacy architecture. | Task 1 creates a non-migrating `openControlStore()`; Task 2 owns job/context/lease storage primitives, Tasks 3, 8 and 9 wire replacements, and Task 13 deletes the legacy paths. |
| `src/store.mjs`: `claimWorkerLease()` and reviewer lease fields | Fenced lease epoch and compare-and-set ownership are retained conceptually for short-lived reviewer jobs. | Global worker lease/resident reconciler ownership is not retained. | Task 2 owns short-lived job-level fenced lease/context primitives; Task 6 consumes them for detached launch/recovery; Task 13 removes the legacy implementation. |
| `src/store.mjs`: encrypted blob reference columns | Only an encrypted blob *reference* and bounded opaque metadata are allowed in the control ledger. Existing `crypto-store.mjs` roots and permissions remain unchanged. | Raw prompt, assistant output, report, lesson/card body, and redacted-text persistence in the control store are forbidden. | Task 1 captures references only; Task 2 supplies bounded reviewer context; Task 7 validates reviewer results. |
| `src/notification-delivery.mjs` and notification portions of `src/cli.mjs` | Structured reason codes and failure-safe logging are reusable. | Notification outbox/delivery transport, Codex thread delivery, OS fallback, audit delivery and receipt status are removed. | Task 3 deletes notification runtime paths. |
| `src/cli.mjs`: receipt, `hookPrompt`, `capture-stop`, Stop/reconcile commands | Prompt-hook fail-open envelope and structured logging may remain after redesign. | Receipt emission, hook prompt injection, Stop capture/reconciliation and model-visible reviewer status are removed. | Task 3 provides prompt-only orchestration. |
| `templates/hooks/core-hook.sh` | A single bounded prompt hook is retained. | Batch queue, three-event threshold and reviewer instruction injection are removed. | Task 3 replaces the active prompt hook. |
| `templates/hooks/stop-hook.sh` | None in the default installation. | Stop hook, watchdog, process-tree cleanup and all Stop receipt/capture paths are removed. | Task 3 removes managed Stop installation and path. |
| `src/reconcile-scheduler.mjs` and index installer/doctor scheduler calls | None; there is no resident service in the target architecture. | LaunchAgent/resident scheduler installation, health and maintenance/reconciliation status are removed. | Task 3 removes scheduler entrypoints; Task 12 provides read-only legacy export; Task 13 deletes remaining legacy maintenance/store architecture. |
| reviewer provider adapter/process boundaries | Provider isolation, detached child process groups, bounded context, opaque logs and no inherited host stdio remain valid. | Provider results must not produce receipts, notifications, SQLite report bodies or synchronous prompt waits. | Task 6 implements detached launch/recovery, Task 7 validates results, Task 8 publishes documents, and Task 9 wires runner terminal states. |
| Markdown rendering and existing report representation | Human-readable Markdown is the only long-term reflection fact source; atomic file publication remains valid. | SQLite lesson/card/report bodies and database long-term retrieval are removed. | Tasks 8–10 implement rendering, parsing and selection. |
| `test/notification-delivery.test.mjs` and active notification/Stop test branches | Test fixtures may serve as historical evidence only. | Tests that preserve notification delivery, receipt or Stop behavior must be removed with their runtime paths. | Task 3 deletes these tests and active branches with the prompt-only runtime. |
| `test/fixtures/schema-v8-control-plane.mjs` and legacy store/schema invariant transfer tests | Historical fixtures may support explicit legacy-export verification until their replacement coverage is complete. | Legacy control-plane schema fixtures and store invariant tests must not survive once the isolated runtime no longer imports the old store/schema. | Task 13 transfers any still-valid invariants and deletes the fixture/legacy-store tests. |

## Classification conclusion

All changed runtime paths in the audited range are classified above. The only
Task 1 runtime addition is a separate `control.sqlite3`; it uses no legacy
DDL, performs no legacy import, and must never open `feedback-loop.sqlite3`.
No notification, receipt/Stop/hookPrompt, episode, maintenance, resident
scheduler, or long-term SQLite-content path is a permitted dependency of the
new control store. Task 13 remains responsible for deleting the transitional
legacy runtime once every consumer has moved.
