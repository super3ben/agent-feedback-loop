# Task 15 Fix 1 Report

Date: 2026-07-20

## Status and scope

Implemented the single authorized generation-1 Task 15 acceptance fix for the four frozen findings. The change is test/docs-only:

- `test/platform-smoke.test.mjs`
- `docs/verification/2026-07-16-immediate-subagent-reflection-build.md`
- `.superpowers/sdd/task-15-fix-1-report.md`

No production source, schema, scheduler, RAG/index, service, Stop/receipt/notification path, Windows path, desktop installation, managed runtime selection, or real database was changed.

The pre-existing user-owned modifications in `.superpowers/sdd/task-1-report.md`, `.superpowers/sdd/task-2-report.md`, and `.superpowers/sdd/task-3-report.md` were preserved and excluded from staging.

## Finding 1: detached launch proof

The deterministic provider fixture now writes a private `started` marker, blocks until a private `release` marker exists, and cannot publish its result before release. The platform test starts the installed hook, waits until the provider is confirmed started, then awaits the hook response. Before creating `release`, it asserts:

- hook elapsed time is under two seconds;
- native response is `{ continue: true }` with no AFL control text;
- exactly one durable reviewer job exists;
- zero reflection Markdown documents exist.

It then creates `release` and observes the durable job reach `published` with one canonical immutable Markdown document. A synchronous implementation would remain blocked until the hook process timeout and fail the test.

RED:

```text
node --test test/platform-smoke.test.mjs
exit: 1
tests: 1, pass: 0, fail: 1
failure: deterministic_provider_started_timeout
duration: 2.361 s
```

GREEN after adding only the fixture coordination:

```text
node --test test/platform-smoke.test.mjs
exit: 0
tests: 1, pass: 1, fail: 0
duration: 2.980 s
```

## Finding 2: exact current-cutoff proof

The first stricter attempt prepublished a matching document with the ordinary wall clock. It failed because the hook cutoff occurred later and therefore correctly admitted the document; this demonstrated that a loose timing scenario cannot prove strict equality.

RED:

```text
node --test test/platform-smoke.test.mjs
exit: 1
tests: 1, pass: 0, fail: 1
failure: expected current response hookSpecificOutput absence; actual presence was true
duration: 2.977 s
```

The minimal fixture correction adds a test-only Node preload. When `AFL_PLATFORM_NOW` is present it freezes `Date` only inside the spawned test hook process. The canonical matching document is prepublished at `2030-01-02T03:04:05.000Z`, the current hook runs at exactly that cutoff and excludes it, and a later otherwise-equivalent prompt runs at `2030-01-02T03:04:05.001Z` and emits the exact document hash.

Two intermediate harness mistakes were rejected before GREEN: the preload helper was initially inserted inside the generated provider template, producing a syntax error, and the first parser assertion omitted the required path option. Neither represented or changed production behavior.

GREEN:

```text
node --test test/platform-smoke.test.mjs
exit: 0
tests: 1, pass: 1, fail: 0
duration: 3.285 s
```

## Finding 3: deterministic Top-4 proof

The Top-4 fixtures now use five isolated, identifiable families with monotonically increasing creation timestamps. The expected exact order is fixture `4`, `3`, `2`, `1`; fixture `0` is the fifth omission. The test compares both document hashes and method strings in order and asserts the omitted hash is absent.

The first repeat intentionally reused the same session/context/task tuple. RED showed that prior-emission suppression removed the earlier Top-4 and promoted the fifth hash, which is a different contract from ordering stability.

RED:

```text
node --test test/platform-smoke.test.mjs
exit: 1
tests: 1, pass: 0, fail: 1
failure: repeated equivalent prompt produced one promoted fifth hash instead of the expected four hashes
duration: 3.479 s
```

The minimal GREEN uses a fresh session while keeping prompt and task fingerprint equivalent. It then asserts the exact same four hashes and methods in the same order and again asserts the fifth hash is absent.

GREEN:

```text
node --test test/platform-smoke.test.mjs
exit: 0
tests: 1, pass: 1, fail: 0
duration: 3.976 s
```

## Finding 4: guarded real-state proof

The coordinator-provided before snapshot and this fix's read-only after command are recorded verbatim in `docs/verification/2026-07-16-immediate-subagent-reflection-build.md`. Each contains SHA-256 plus size and mtime for all five guarded paths. `diff -u` exited `0` with empty stdout/stderr. No file contents were printed and AFL was not invoked against any real guarded database path.

## Final verification

```text
node --test test/e2e-smoke.test.mjs test/platform-smoke.test.mjs
exit: 0
tests: 11, pass: 11, fail: 0
duration: 10.915 s

npm test
exit: 0
tests: 268, pass: 268, fail: 0
duration: 15.876 s
```

## Self-review

- Every changed behavior is confined to the deterministic acceptance harness; real-provider mode still returns before the deterministic-only cutoff and Top-4 scenarios.
- The provider release marker is written in test cleanup as a fail-safe, so a failed assertion cannot leave the deterministic child blocked indefinitely.
- The frozen clock activates only when the fixture-specific environment variable is present; normal host and real-provider clocks are unchanged.
- The exact cutoff document is already present before selection and exactly matches the current prompt, isolating cutoff exclusion from relevance and publication races.
- The later Top-4 prompt uses a different session to isolate ranking stability from the accepted prior-emission suppression contract.
- The fifth fixture is explicitly asserted absent in both Top-4 emissions; count-only assertions were removed.
- No production file changed and the authoritative logical reviewer schema remains untouched.
- Only the three scoped files listed above are candidates for staging; the three user-owned dirty reports remain unstaged.

## Concerns

None within the authorized acceptance-fix scope. Codex desktop visibility and production rollout remain pending and unauthorized, as before.
