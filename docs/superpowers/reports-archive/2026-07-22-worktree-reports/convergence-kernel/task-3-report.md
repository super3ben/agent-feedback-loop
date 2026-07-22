# Task 3 Implementation Report

## Status

DONE

- Commit: `b1d96bd` (`feat: persist convergence state and one-shot grants`)
- Base verified before work: `4512fe1d7fbaf93ca9d33b90e713ed0f87dea9ba`
- Commit scope: exactly the six Task 3 code/test files.
- `.superpowers/sdd/task-1-report.md` and `.superpowers/sdd/task-2-report.md` were preserved as pre-existing uncommitted user/agent changes and were not staged or committed.

## Implemented Scope

- Exact schema v2 with the four frozen convergence tables; fresh v2 has exactly twelve user tables.
- Exact canonical v1 verification and one `BEGIN IMMEDIATE` v1 to v2 migration; schema creation and version replacement roll back together.
- Convergence API composed onto the existing control-store connection; no second SQLite connection is opened by the store.
- Append-only canonical events with immutable event UID replay checks and event-before-projection transactions.
- Stable review fingerprint, alias collision rejection, evidence-backed distinct declarations, trusted evidence basis updates, closed regression history retention, checkpoint/generation transitions, evaluated-decision binding, Probe lease epoch fencing, one-shot grants, resolve, and transactional Guard import.
- Grant token hashes only in SQLite; contract/policy/basis/scope/generation/evidence bindings are checked on consume, and revision changes revoke active grants.
- Input/facts validators are bounded and reject unknown fields. No prompt, reviewer text, diff, command output, evidence body, or token is persisted in event facts.

## TDD Evidence

### RED observed

1. Migration RED:
   - Command: `node --test test/convergence-store.test.mjs test/control-store.test.mjs`
   - Observed: 81 pass / 3 fail.
   - Expected causes: `V1_SCHEMA_SQL` missing and fresh schema still exposed only eight v1 tables.
2. Event/store RED:
   - Command: `node --test test/convergence-store.test.mjs`
   - Observed successively: missing `upsertConvergenceTask`, then missing review/alias/evidence/decision methods, then missing checkpoint/Probe methods, then missing grant methods, and finally missing resolve/import methods.
   - Each group was implemented only after its focused failure was observed.
3. Migration rollback RED:
   - A first resource-limit fixture did not trigger the intended SQLite failure and was rejected as invalid evidence.
   - Replaced with a deterministic same-connection TEMP trigger at the version replacement write; observed failure before adding the testable migration seam, then verified the rollback path.

### GREEN observed

- Focused convergence suite: `17/17` passing after the deterministic migration rollback case was added.
- Brief regression command:
  - `node --test test/convergence-store.test.mjs test/control-store.test.mjs test/runtime.test.mjs`
  - Fresh final result: `111/111` pass, `0` fail.
- Full repository suite:
  - `npm test`
  - Result: `326/326` pass, `0` fail.
- `git diff --check`: clean before commit.

## Native macOS Disposable-State Evidence

- Host: macOS `26.5.1` (`25F80`), Darwin arm64.
- Runtime: Node `v26.0.0`, built-in SQLite `3.53.1`.
- Disposable-state smoke command selected only destructive/atomicity-sensitive tests:
  - migration write failure rolls back both new tables and schema version;
  - convergence event insertion failure rolls back projection;
  - concurrent grant consumers across separate SQLite connections have exactly one winner.
- Smoke result: `3/3` pass, `0` fail. Fixtures use temporary homes/databases and did not access the real HOME control database.
- Computer Use was attempted for a visible Terminal confirmation as required by repository instructions, but the Computer Use host returned: `Computer Use is not allowed to use the app 'com.apple.Terminal' for safety reasons.` No UI result is claimed, and UI was not substituted for the automated macOS evidence.
- Linux was not tested or claimed; it remains Task 9 scope.

## Risks and Boundaries

- No global installation, real hook state, real user database, cutover, service, scheduler, RAG/vector layer, second store connection, or user-visible receipt was added or changed.
- Task 4+ adapters/CLI/cutover/probe runner remain unimplemented by design.
- `transactionalGuardImport` accepts only a bounded canonical import projection; Task 4 still owns legacy-file parsing and parity mapping.
- The exact schema intentionally uses the frozen four-table definition. Active-grant uniqueness is enforced by `BEGIN IMMEDIATE`, loop `active_grant_id`, state-conditional updates, and cross-connection tests rather than an extra undeclared table/index.
- Tests, disposable macOS runtime evidence, installed runtime behavior, live hooks, Linux, and production acceptance remain separate verification layers.

## Receipt-Gated Review Fix Run

- Review receipt: `Review-Run-ID: convergence-kernel-task-3-review-1`.
- Scope remained limited to `src/convergence-store.mjs` and `test/convergence-store.test.mjs`; no schema or Task 4 code changed.
- Finding 1 preserves the canonical loop across aliases and de-duplicates a failed review whose evidence digest already exists anywhere in that loop's event history.
- Finding 2 makes accepted write payloads collision-bound and replays state-changing writes before current projection guards. A continuation grant token is returned only on the first successful issue; an exact issue replay returns `{ grantId, replayed: true, tokenAvailable: false }` and neither stores nor reconstructs the secret.
- Finding 3 removes policy derivation from the store. The store validates the supplied evaluation shape and binds capability, contract/policy revision, failure count, current/requested generation, and decision basis to the persisted snapshot before projection.
- Finding 4 reclaims expired running Probe leases with a new owner/epoch, fences stale owners, and stops after three real attempts in `probe_state=failed` / `status=checkpoint_required` without creating a fourth claim.
- Finding 5 binds each Guard import source to a canonical content digest, applies event-specific facts allowlists, and rejects more than one active grant per fingerprint before import writes.

### Review-fix RED/GREEN evidence

- Finding 1: alias review initially created/selected `fingerprint-escaped`; the focused regression then passed with the canonical fingerprint and unchanged historical failure count.
- Finding 2: five focused tests initially exposed task-event field omissions, post-transition replay failures, grant re-issuance, and incomplete consume binding; all `5/5` passed after the bounded fix.
- Finding 3: the two focused tests were `0/2` RED (`evaluateConvergence` still called and mismatched snapshots reported `decision_not_evaluated`), then `2/2` GREEN.
- Finding 4: expired owner-1 lease reclaim was RED with `probe_not_due`; the final Probe-focused run was `6/6` GREEN, including exhausted terminal replay.
- Finding 5: canonical import collision, cross-event facts, and duplicate-active-grant tests were `0/3` RED, then `3/3` GREEN.

### Fresh review-fix verification

- Brief three-file regression: `122/122` pass, `0` fail.
- Full repository suite: the first run was `337/338`; the only failure was the unrelated existing busy-writer e2e time threshold at about `3089ms`. Its isolated rerun passed at about `1901ms`, and a fresh full rerun passed `338/338`, `0` fail.
- Disposable macOS atomic/concurrency/reclaim smoke: `4/4` pass on macOS `26.5.1` arm64, Node `v26.0.0`, SQLite `3.53.1`. The four cases covered migration rollback, event/projection rollback, expired Probe reclaim/exhaustion, and two-connection single-winner grant consumption.
- `git diff --check`: clean before the review-fix commit.
- The earlier Computer Use Terminal safety block was retained as the truthful UI boundary and was not retried; no UI verification is claimed.

## Architecture-Fix Generation

- Re-review receipt: `Review-Run-ID: convergence-kernel-task-3-rereview-1`.
- Direction checkpoints: `canonical-loop-history-preserved` and `write-event-replay-is-immutable-and-idempotent` both selected one bounded canonical review envelope rather than another per-field replay patch.
- Commit: `0bc8e126b5706c28b0aad1c65c00a001eec42f59` (`fix: canonicalize convergence review events`).
- Scope: only `src/convergence-store.mjs` and `test/convergence-store.test.mjs`; no schema, Task 4, runtime, service, token/security, or other API abstraction changed.
- Raw review input is validated first. The store then resolves the task/boundary submitted invariant to its canonical or alias target and forms one bounded envelope containing event/task/boundary, submitted fingerprint/invariant, canonical fingerprint/invariant, generation, severity, verdict, direction signal, evidence digest, and decision-basis digest.
- The envelope SHA-256 in the existing `source_digest` column plus event type/task/canonical fingerprint is the sole review replay identity. The previous selected-field replay matcher and fingerprint-only digest were removed. Exact replay returns the canonical loop before evidence/projection work; only a new event reaches historical evidence de-duplication, append, and projection.

### Architecture-fix RED/GREEN evidence

- Focused RED matrix: `0/1`; it reported all re-review reproductions together: `exact alias retry: event_collision`, `boundaryId: changed request was accepted`, and `canonicalInvariantId: changed request was accepted`.
- Focused GREEN matrix: `1/1`. It verifies exact alias replay and one-at-a-time changes to task, boundary, submitted invariant, submitted fingerprint, verdict, severity, direction signal, decision basis, evidence, and generation. Every collision preserves the complete review-event set, canonical loop row, event/loop counts, failure count, generation, and version.
- Store suite: `28/28` pass.
- Task 3 three-file regression: `122/122` pass.
- Full repository suite: `338/338` pass.
- Disposable macOS replay zero-mutation smoke: `1/1` pass on macOS `26.5.1` arm64, Node `v26.0.0`, SQLite `3.53.1`; temporary fixture databases only, no real HOME state.
- `git diff --check`: clean before commit. The prior Computer Use Terminal safety block was not retried, so no UI verification is claimed.
