# Task 1 Report: Repository Lineage and Contract Projection

## Implementation summary

Added the pure `src/convergence-identity.mjs` module and focused Node test file.

- `ensureRepositoryLineage` supports only macOS/Linux, resolves the Git common directory for a repository/worktree, rejects unsafe ownership/mode/symlink targets before a write, and persists a private `0600` 256-bit lineage ID once per Git common directory.
- `deriveTaskUid` uses a SHA-256 digest of length-prefixed canonical identifiers, so adjacent field boundaries cannot collide.
- `projectContract` canonicalizes source and clause metadata, gives hard status only to explicit/approved/verified authorities, and forces inferred or unknown importance to `routine`.
- `digestDecisionBasis` creates a deterministic SHA-256 digest of stable JSON object ordering. Input boundaries reject NULs, unsafe IDs, excessive values, and non-plain records where records are required.

No database, hook, runtime-install, HOME, global SDD, or existing project modules were changed.

## RED evidence

Command:

```sh
node --test test/convergence-identity.test.mjs
```

Exact output:

```text
exit=1
node:internal/modules/esm/resolve:271
    throw new ERR_MODULE_NOT_FOUND(
          ^

Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/sunxingda/project/agent-feedback-loop/.worktrees/convergence-kernel/src/convergence-identity.mjs' imported from /Users/sunxingda/project/agent-feedback-loop/.worktrees/convergence-kernel/test/convergence-identity.test.mjs
    at finalizeResolution (node:internal/modules/esm/resolve:271:11)
    at moduleResolve (node:internal/modules/esm/resolve:861:10)
    at defaultResolve (node:internal/modules/esm/resolve:988:11)
    at #cachedDefaultResolve (node:internal/modules/esm/loader:700:20)
    at ModuleLoader.resolveSync (node:internal/modules/esm/loader:749:52)
    at #resolve (node:internal/modules/esm/loader:682:17)
    at ModuleLoader.getOrCreateModuleJob (node:internal/modules/esm/loader:162:33)
    at ModuleJob.syncLink (node:internal/modules/esm/module_job:162:33)
    at ModuleJob.link (node:internal/modules/esm/module_job:252:17) {
  code: 'ERR_MODULE_NOT_FOUND',
  url: 'file:///Users/sunxingda/project/agent-feedback-loop/.worktrees/convergence-kernel/src/convergence-identity.mjs'
}

Node.js v26.0.0
✖ test/convergence-identity.test.mjs (57.934666ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 61.985333

✖ failing tests:

test at test/convergence-identity.test.mjs:1:1
✖ test/convergence-identity.test.mjs (57.934666ms)
  'test failed'
```

This was expected: the test was written first and its ESM import targeted the not-yet-created production module. It therefore demonstrated an absent feature rather than a malformed assertion.

## GREEN evidence

Focused command:

```sh
node --test test/convergence-identity.test.mjs
```

Focused result: 4 tests passed; 0 failed; duration 260.541208ms. This included a real local macOS Git repository plus detached linked worktree and asserted the created lineage file's `0600` mode.

Full-suite command:

```sh
npm test
```

Full-suite result: 276 tests passed; 0 failed; 0 skipped; duration 20007.178958ms.

## Files changed

- `src/convergence-identity.mjs` (new)
- `test/convergence-identity.test.mjs` (new)
- `.superpowers/sdd/task-1-report.md` (new required task report; intentionally not part of the source/test commit)

## Self-review

- The module has no imports from project code and does not establish a database, hook, scheduler, service, notification transport, recovery surface, or lesson body.
- The only side effect is creation of `afl-lineage-id` after platform, repository directory, Git common directory, ownership, mode, and symlink validation. Creation uses exclusive `wx` and re-reads the winning file to handle a concurrent creator.
- Existing lineage files must be current-user-owned, regular, non-symlinked, and exactly `0600`; unsafe files fail closed.
- Worktree sharing is intentionally keyed on `git rev-parse --git-common-dir`, while independent repositories retain distinct random lineage IDs.
- Contract projection never permits inferred/unknown authority to create a hard clause or elevate importance.

## Concerns

None. The implementation is deliberately limited to the task's pure identity/contract boundary; connecting it to any runtime, persistence, hooks, or Guard behavior is deferred to later tasks.

## Guarded fix: canonical-domain and authority-registry invariants

### RED evidence

Command:

```sh
node --test --test-name-pattern 'decision-basis digests reject sparse arrays' test/convergence-identity.test.mjs
```

Exact output:

```text
✖ decision-basis digests reject sparse arrays instead of colliding with empty arrays (1.074292ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 67.394333

✖ failing tests:

test at test/convergence-identity.test.mjs:89:1
✖ decision-basis digests reject sparse arrays instead of colliding with empty arrays (1.074292ms)
  AssertionError [ERR_ASSERTION]: Missing expected exception.
      at TestContext.<anonymous> (file:///Users/sunxingda/project/agent-feedback-loop/.worktrees/convergence-kernel/test/convergence-identity.test.mjs:90:10)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1201:25)
      at startSubtestAfterBootstrap (node:internal/test_runner/test:1096:17) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: undefined,
    operator: 'throws',
    diff: 'simple'
  }
```

The assertion proves a sparse array was accepted before the serializer correction.

Command:

```sh
node --test --test-name-pattern 'exported authority registry cannot mutate contract normalization in a fresh process' test/convergence-identity.test.mjs
```

Exact output:

```text
✖ exported authority registry cannot mutate contract normalization in a fresh process (58.384166ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 125.072167

✖ failing tests:

test at test/convergence-identity.test.mjs:96:1
✖ exported authority registry cannot mutate contract normalization in a fresh process (58.384166ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected

    {
  +   containsMutation: true,
  +   projectionUnchanged: false
  -   containsMutation: false,
  -   projectionUnchanged: true
    }

      at TestContext.<anonymous> (file:///Users/sunxingda/project/agent-feedback-loop/.worktrees/convergence-kernel/test/convergence-identity.test.mjs:115:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1208:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/test:1208:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: { containsMutation: true, projectionUnchanged: false },
    expected: { containsMutation: false, projectionUnchanged: true },
    operator: 'deepStrictEqual',
    diff: 'simple'
  }
```

The fresh-process regression temporarily restored the reviewed mutable implementation solely to verify the test's falsification behavior, then restored the minimal correction before GREEN verification.

### GREEN evidence

- Sparse-array focused regression: 1 passed, 0 failed.
- Fresh-process authority-registry focused regression: 1 passed, 0 failed.
- Final Task 1 focused command, `node --test test/convergence-identity.test.mjs`: 6 passed, 0 failed, 0 skipped; duration 315.497959ms.
- Final full command, `npm test`: 278 passed, 0 failed, 0 skipped; duration 17749.3155ms.

### Files changed

- `src/convergence-identity.mjs`
- `test/convergence-identity.test.mjs`
- `.superpowers/sdd/task-1-report.md` (this report section only; intentionally uncommitted)

### Self-review

- `stableJson` now checks every array index with `Object.hasOwn` and rejects sparse arrays as `invalid_decision_basis`; accepted arrays therefore cannot silently omit holes from their canonical preimage.
- The authority vocabulary used by `normalizeAuthority` is a module-private whitelist. The exported representation has only a non-mutating `has` view and inert `add`, so import history cannot alter projection or its revision.
- The authority test launches a new Node ESM process, checks membership and projection before/after a consumer-side `add`, and leaves no state shared with the test runner.
- No filesystem-safety coverage was added, per the bounded instruction to defer the review's Minor suggestion. No runtime, HOME, Guard, receipt, database, hook, or other task files were modified.

## Architecture fix

### RED evidence

The decorated-array falsification regression was added before any production change.

Command:

```sh
node --test --test-name-pattern 'decision-basis digests reject decorated arrays' test/convergence-identity.test.mjs
```

Exact output:

```text
exit_code=1
✖ decision-basis digests reject decorated arrays instead of erasing own properties (1.1555ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 76.159375

✖ failing tests:

test at test/convergence-identity.test.mjs:96:1
✖ decision-basis digests reject decorated arrays instead of erasing own properties (1.1555ms)
  AssertionError [ERR_ASSERTION]: Missing expected exception.
      at TestContext.<anonymous> (file:///Users/sunxingda/project/agent-feedback-loop/.worktrees/convergence-kernel/test/convergence-identity.test.mjs:100:10)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1201:25)
      at Test.start (node:internal/test_runner/test:1096:17)
      at startSubtestAfterBootstrap (node:internal/test_runner/harness:385:3) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: undefined,
    operator: 'throws',
    diff: 'simple'
  }
```

This is the required direct evidence that the prior serializer accepted an array with an own `semantic_tag` property and silently omitted that structure instead of returning `invalid_decision_basis`.

### Focused and final GREEN evidence

- Strict-domain command, `node --test --test-name-pattern 'decision-basis' test/convergence-identity.test.mjs`: 9 passed, 0 failed, 0 skipped; duration 74.5825ms.
- Final Task 1 command, `node --test test/convergence-identity.test.mjs`: 14 passed, 0 failed, 0 skipped; duration 341.170459ms. This ran the real macOS Git linked-worktree and `0600` mode checks.
- Final full command, `npm test`: 286 passed, 0 failed, 0 skipped; duration 17573.747917ms.
- Syntax and diff checks, `node --check src/convergence-identity.mjs`, `git diff --check`, and `git diff --cached --check`, all exited 0.

### Files and commit

- Commit: `0d625ef` (`fix: enforce strict decision basis domain`)
- Committed: `src/convergence-identity.mjs`
- Committed: `test/convergence-identity.test.mjs`
- Uncommitted coordination report: `.superpowers/sdd/task-1-report.md`

### Self-review

- `stableJson` is one recursive validator/canonicalizer. It snapshots each value's complete `Reflect.ownKeys` set and property descriptors, validates shape and descriptors, and only then recursively encodes descriptor values; getters are rejected without invocation.
- Accepted arrays have `Array.prototype`, the canonical `length` property, and exactly one enumerable data descriptor for every dense canonical index. Sparse arrays, extra string keys, symbols, accessors, non-enumerable elements, proxies, and unsupported array prototypes fail closed.
- Accepted records have exactly `Object.prototype` and only enumerable string data properties. Symbol keys, non-enumerable properties, accessors, cycles, proxies, and unsupported prototypes return `invalid_decision_basis`.
- Accepted scalar roots are `null`, booleans, finite numbers, and bounded strings; unsupported scalar types return `invalid_decision_basis`. Record keys use deterministic code-unit sorting, so insertion order does not change the digest.
- The commit changes only the two Task 1 files and keeps every public export intact. It does not address the review's Minor lineage-coverage item and does not touch Guard state, receipts, plans/specs, database, hooks, runtime, global SDD, or real HOME.
