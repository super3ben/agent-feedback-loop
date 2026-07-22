# Task 7 Human-Directed Correction Report

## Status

Implemented the one-time user-selected correction for the two frozen Task 7 findings.
No Guard command, real repository migration, import, cutover, rollback, global Skill
change, prompt/Markdown/Stop path, or receipt path was executed or changed.

## What changed

1. `runGuardCommand` now accepts only an opaque preflight object produced by the real
   `inspectGuardRepository` boundary. Missing or caller-forged projections fail with
   `guard_preflight_required`. The optional Store-only resolver and
   `authorityResolver` fallback were removed. `executeGuardCli` remains the only
   production composition root.
2. `openControlStoreReadOnly` now copies the bounded main/WAL/SHM/journal source set
   into one owner-private mode-0700 temporary directory outside the repository Store.
   Source members are opened no-follow, owner/mode/regular-file checked, held by file
   descriptor, hashed and identity-checked before and after copying, re-opened for a
   final source-set check, and rejected as `control_store_unavailable` on drift. Only
   the snapshot is opened by SQLite. Success close and every failure path remove the
   complete snapshot tree. Lifecycle logs expose only bounded action/state/opaque ID.

The snapshot implementation follows the existing `src/legacy-export.mjs` member-set
snapshot pattern; it adds no schema, table, service, scheduler, registry, or framework.

## TDD evidence

### RED: exported adapter authority

Command:

```text
node --test --test-name-pattern='exported adapter fails closed without a verified repository preflight|exported adapter cannot bypass real unimported legacy authority' test/convergence-sdd-adapter.test.mjs
```

Initial result: `0/2` passing. The direct exported call without preflight completed
instead of rejecting (`Missing expected rejection`). The legacy fixture was then reduced
to the canonical repository-bound v1 shape before implementation; the final regression
uses that real legacy repository state and separately verifies the real preflight result.

### RED: WAL read-only source preservation

Command:

```text
node --test --test-name-pattern='read-only Store inspection leaves a closed WAL database without sidecars|read-only Store inspection reads active WAL state from a cleaned temporary snapshot|read-only Store inspection rejects source drift and cleans its snapshot' test/control-store.test.mjs
```

Initial result: `0/3` passing. The old live read created retained `-wal`/`-shm` files for
a closed WAL database, changed the real active `-shm` bytes, and ignored the injected
source drift instead of failing closed.

### GREEN

Commands and results:

```text
node --test --test-name-pattern='read-only Store inspection leaves a closed WAL database without sidecars|read-only Store inspection reads active WAL state from a cleaned temporary snapshot|read-only Store inspection rejects source drift and cleans its snapshot' test/control-store.test.mjs
# 3/3 passing

node --test --test-name-pattern='exported adapter fails closed without a verified repository preflight|exported adapter cannot bypass real unimported legacy authority' test/convergence-sdd-adapter.test.mjs
# 2/2 passing

node --test test/control-store.test.mjs test/convergence-migration.test.mjs test/convergence-sdd-adapter.test.mjs
# 141/141 passing

node --test test/cli.test.mjs
# 31/31 passing

npm test
# 456/456 passing

git diff --check
# exit 0, no output
```

The active-WAL coverage reads a committed row present only in WAL and verifies the real
Store directory's DB/WAL/SHM byte digests, inode identities, and modes remain unchanged
across both `status` and `lock-status`.

## Files changed

- `src/control-store.mjs`
- `src/convergence-migration.mjs`
- `src/convergence-sdd-adapter.mjs`
- `test/control-store.test.mjs`
- `test/convergence-migration.test.mjs`
- `test/convergence-sdd-adapter.test.mjs`

## Self-review

- Confirmed there is no `immutable` live SQLite open and no create-then-delete behavior
  in the repository Store directory.
- Confirmed the adapter contains no Store-only or injected authority resolver fallback.
- Confirmed cleanup occurs after normal close, drift rejection, schema/open failure, and
  logger/copy failure paths.
- Confirmed all tests use disposable Git repositories and temporary HOME directories.

## Unverified boundaries

- Linux behavior was not verified; the current evidence is macOS only.
- Computer Use was attempted for a visible Terminal re-run, but the platform safety
  policy denied control of `com.apple.Terminal`. The shell/process tests above did run
  on the real local macOS host.
- No real HOME, installed package, live Guard state, real migration/cutover, or production
  acceptance was exercised, by explicit task constraint.
