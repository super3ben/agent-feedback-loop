# Repository Guard Authority Lifecycle Recovery Design

**Date:** 2026-07-22
**Status:** approved design, implementation not authorized
**Owns:** Task 7 `guard-unimported-legacy-remains-authoritative` and the human resolution of Task 9 `legacy-import-dry-run-has-supported-lineage-bootstrap`

## 1. Goal

Make repository identity creation, read-only status inspection, legacy Guard authority,
fresh-repository AFL use, import, and cutover separate lifecycle transitions. No command
may create identity or control state before the operator explicitly initializes lineage,
and a supported legacy Guard remains authoritative until an exact Store cutover event
commits.

## 2. Authoritative evidence

The final integration review reproduced two failures in disposable Git repositories:

1. `guard status` created `.git/afl-lineage-id` and upserted an AFL task.
2. A valid repository-bound legacy v1 Guard state with no import or cutover was resolved
   as `afl_sqlite`; an AFL `record-review` then created a new loop.

The first finding resumed the existing Task 9 fingerprint after its architecture-fix
generation had already been used. The real Review Loop Guard therefore moved it to
`blocked_human_decision`. The second finding is a Task 7 root-cause invariant in
`blocked_direction_review`.

## 3. Hard constraints

- `lineage-init --repo-root <path> --apply` is the only operation that may create
  `afl-lineage-id`.
- A lineage-free repository causes every Guard command, including read commands, to
  return a bounded uninitialized result without creating a database, task, loop, event,
  lock, or runtime file.
- `status` and `lock-status` are read-only in every repository state. A missing Store is
  reported as empty/unavailable and is never initialized for inspection.
- A supported owner-safe legacy state is the authority before Store cutover, whether or
  not it has been imported.
- A missing legacy state and an invalid/unsafe legacy state are different facts. Invalid,
  permissive, unowned, symlinked, oversized, malformed, or repository-mismatched state
  fails closed.
- `guard_cutover` in the existing authority task remains the only event that changes a
  legacy repository to `afl_sqlite`.
- A fresh repository with valid lineage and no legacy state may initialize the Store only
  when the operator runs an explicit mutating Guard command.
- No new table, schema version, registry, scheduler, service, implicit scan, dual-write,
  global Skill modification, real migration, or automatic cutover is introduced.
- Prompt hooks and ordinary user responses never call this authority path or display its
  machine status.

## 4. Alternatives considered

### 4.1 Selected: read-only preflight plus existing Store authority

Resolve repository reality before opening a writable Store. Use the existing lineage
file, legacy state, transition lock, and authority event history. This preserves the
current four-table design and makes every side effect follow an explicit command.

### 4.2 Rejected: add `guard activate --apply`

A separate fresh-repository activation command is conceptually pure but adds another
lifecycle state and user action without a competing authority. Explicit lineage followed
by an explicit write already supplies adequate authorization for a fresh repository.

### 4.3 Rejected: absence of an authority row means AFL authority

This is the current defect. Store absence says nothing about repository-local legacy
authority and cannot authorize a mutation.

## 5. Read-only repository preflight

Introduce one read-only repository preflight owned by the migration/identity boundary.
It returns a frozen projection and performs no Store creation or repository write:

```js
{
  repositoryState: "uninitialized" |
    "transition_locked" |
    "legacy_guard" |
    "fresh_afl_eligible" |
    "afl_sqlite",
  lineageId: string | null,
  legacyState: "absent" | "valid" | "invalid",
  storeState: "absent" | "valid" | "invalid",
  imported: boolean,
  cutOver: boolean
}
```

The public machine response does not expose `lineageId`, absolute paths, legacy bytes,
Store paths, or state contents.

Preflight order is fixed:

1. Securely resolve the repository root and Git common directory.
2. Read lineage through the shared read-only identity API.
3. If lineage is absent, return `uninitialized` before any database open.
4. Inspect the transition lock without creating it.
5. Inspect the canonical legacy state path as absent, valid, or invalid using the same
   owner/mode/symlink/size/schema/repository binding used by migration.
6. Inspect an existing control database read-only. Absence is not an error and does not
   create a file, WAL, SHM, migration row, task, or authority projection.
7. Combine repository reality with existing import/cutover/rollback events.

## 6. Authority lattice

| Observed state | Effective result | Writes allowed |
|---|---|---|
| No lineage | `uninitialized` | Only `lineage-init --apply` |
| Transition lock present | `transition_locked` | None |
| Lineage plus invalid/unsafe legacy state | fail-closed error | None |
| Valid legacy state, no Store/import | `legacy_guard` | Legacy Guard only |
| Valid legacy state, imported, no cutover | `legacy_guard` | Legacy Guard only |
| Valid legacy state, latest event is cutover | `afl_sqlite` | AFL Guard |
| Valid legacy state, latest event is rollback | `legacy_guard` | Legacy Guard only |
| No legacy state, valid lineage, Store absent | `fresh_afl_eligible` | Explicit AFL mutation may initialize Store |
| No legacy state, valid lineage, existing valid AFL task state | `afl_sqlite` | AFL Guard |

Copying a legacy state from another repository never changes authority: repository-ID
validation fails before a command can use it.

## 7. Command execution pipeline

The package CLI must parse the command before choosing a Store mode.

### 7.1 `lineage-init`

- Uses the existing explicit top-level command.
- Creates or reuses only the private common-directory lineage.
- Never opens the Store or reads legacy state.

### 7.2 `status` and `lock-status`

- Run preflight and, only when an existing valid Store is present, query it read-only.
- Never call `ensureRepositoryLineage`, `initializeControlStore`, `ensureTask`, task
  projection, schema migration, or any event append.
- `status --task-id` derives an in-memory task UID only when lineage exists. It reports
  zero loops when the Store/task is absent.
- `lock-status` reports the repository transition lock independently of SQLite journal
  mode; journal mode is `unknown` when no Store exists.

### 7.3 Mutating Guard commands

- `uninitialized`: fail with `lineage_not_initialized`.
- `transition_locked`: fail with `guard_authority_locked`.
- invalid repository/legacy/Store state: fail with its bounded state/safety code.
- `legacy_guard`: fail with `legacy_guard_authoritative`.
- `fresh_afl_eligible`: initialize the Store only after the explicit command and all
  authority checks succeed, then create the required task/loop/event atomically.
- `afl_sqlite`: use the existing Store and controller path.

No mutation may call a creating helper before authority resolution.

### 7.4 Migration commands

`import --dry-run`, import apply, shadow, cutover, and rollback retain their existing
explicit command boundary. Preflight is shared only for identity and authority facts; it
does not weaken snapshot, transition-lock, digest, parity, or rollback checks.

## 8. Error and logging contract

- Malformed CLI arguments remain usage errors.
- Missing lineage is a bounded initialization prerequisite, not a generic Store error.
- Unsafe lineage, legacy state, Store, or transition-lock state remains fail-closed.
- Machine output contains only state enums, bounded codes, counts, opaque IDs, and
  digests.
- Structured logs contain an action, effective state, and bounded reason only. They
  contain no raw state, absolute path, review body, prompt, token, or lineage.

## 9. Review Loop Guard bookkeeping

After the written spec is approved:

1. Close the Task 9 `blocked_human_decision` loop with a human decision reference that
   names this spec and the Task 7 root-cause invariant. Do not reopen it under a renamed
   Task 9 invariant.
2. Record a direction checkpoint for Task 7
   `guard-unimported-legacy-remains-authoritative` at
   `guard-migration/adapter-authority-before-cutover`.
3. The Task 7 checkpoint owns the combined implementation because both findings share
   the same preflight/authority root cause.
4. Authorize at most one Task 7 `architecture_fix` receipt after an implementation plan
   is approved.
5. Any re-review failure of this architecture fix returns to human decision. No local-fix
   loop, ID replacement, counter reset, or second architecture generation is allowed.

## 10. Falsifiable acceptance

1. On a lineage-free disposable Git repository, every Guard command except explicit
   `lineage-init --apply` leaves the Git common directory, HOME, Store, legacy state, and
   task/event counts unchanged.
2. After lineage initialization, `status` and `lock-status` still produce no write and no
   database creation.
3. A fresh lineage-initialized repository permits an explicit AFL mutating command and
   creates the Store only in that command.
4. A valid unimported legacy state causes every AFL mutating command to fail as
   `legacy_guard_authoritative`; Store counts remain unchanged.
5. Imported-but-not-cut-over legacy state remains legacy authoritative.
6. Only an exact committed cutover changes the adapter to AFL; rollback restores legacy
   authority.
7. Invalid, copied, unsafe, or drifting legacy state never falls through to fresh AFL.
8. Read commands never call task upsert or append an event, including under concurrency.
9. Existing import/shadow/cutover/rollback, linked-worktree identity, prompt isolation,
   and full regression tests remain green on macOS; supported Linux tests exercise the
   same state matrix when Git is available.

## 11. Stop conditions

Stop and return to human decision if the repair requires a new authority table, a new
activation service, implicit repository scans, writing during status, treating corrupt
legacy state as absent, weakening exact cutover/rollback history, modifying the global
Skill, or executing a real repository migration.
