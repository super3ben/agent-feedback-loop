# Immediate Subagent Reflection Build Evidence

Date: 2026-07-20

This record covers the release-candidate build boundary only. It does not claim a live Codex desktop installation, production visibility, or modification of the user's active AFL runtime.

## Implemented smoke boundary

`test/platform-smoke.test.mjs` is one bounded host-platform harness. In deterministic mode it uses a disposable controller home and project, the installed prompt hook, a real detached child process, the real control SQLite database, the real encrypted evidence store, and atomic Markdown publication. Only the reviewer executable is a deterministic local fixture.

The harness proves this vertical chain:

1. `reviewer job 是干嘛的？` returns the native host response and creates no job or reflection document.
2. The specified completed-turn Chinese dissatisfaction returns in under two seconds, emits no AFL control text, and leaves exactly one durable review job.
3. A detached reviewer publishes one immutable project Markdown document after the prompt cutoff; the originating prompt receives no guidance.
4. A later matching prompt receives the published method and records an emitted row.
5. A distinct later dissatisfaction is reviewer-confirmed into the same family, creates a second immutable document with `recurrence_after_emission`, and leaves the first document byte-identical.
6. The following matching prompt emits the newest family method and not the older method.
7. Five applicable severe families produce four guidance cards; overflow remains an omission and does not create a global hold.

`AFL_REAL_PROVIDER=1` is a separate code path. It does not create or put the deterministic provider on `PATH`. It invokes the installed versioned runtime with `--home "$AFL_SMOKE_HOME"`, preserves the caller's provider authentication `HOME`, and relies on the runtime's Codex arguments `--ephemeral --ignore-user-config --ignore-rules --sandbox read-only`. Missing executable/authentication is reported as the fixed `real_provider_unavailable` failure rather than being replaced by a fake success.

## RED and diagnostic evidence

The first command issued before the new file existed was not counted as RED: Node v26 silently ignored the missing explicit test path and ran only the nine existing E2E tests.

After the full behavior test existed, this command produced the valid RED:

```text
node --test test/e2e-smoke.test.mjs test/platform-smoke.test.mjs
exit: 1
tests: 11
pass: 10
fail: 1
failure: expected the distinct recurrence prompt to create job 2, observed job count 1
```

Diagnosis: the initial recurrence fixture said “没有先核对”, which did not satisfy the frozen detector's negative-evaluation vocabulary. Changing it to the still-natural “没有考虑用户目标” made the intended evidence explicit. No production file changed.

The first full-suite run was also diagnostic rather than accepted evidence: 265/266 passed, with one duplicated `<2s` assertion on an older test that simultaneously launches a new job and recovers an old one. The required deadline remains on the single target prompt in the platform harness; the overloaded duplicate was removed without weakening the vertical acceptance.

## Current local evidence

Host: Darwin arm64, Node v26.0.0.

```text
node --test test/platform-smoke.test.mjs
exit: 0
tests: 1, pass: 1, fail: 0
duration: 2.934 s
```

The caller-owned-home branch was also exercised after a real CLI install into a fresh temporary directory:

```text
node ./bin/agent-feedback-loop.mjs install --home "$TMP_HOME"
AFL_SMOKE_HOME="$TMP_HOME" node --test test/platform-smoke.test.mjs
exit: 0
tests: 1, pass: 1, fail: 0
duration: 5.002 s
cleanup: temporary home absent after the command trap
```

```text
node --test test/e2e-smoke.test.mjs test/platform-smoke.test.mjs
exit: 0
tests: 11, pass: 11, fail: 0
duration: 10.832 s
```

```text
npm test
exit: 0
tests: 266, pass: 266, fail: 0
duration: 20.552 s
```

The full suite includes schema v8 and v9 legacy-copy fixtures. For each version it proves a side-effect-free dry-run, one successful export, an idempotent second export, and unchanged source DB/WAL/SHM hashes.

```text
npm pack --dry-run --json
exit: 0
package: agent-feedback-loop@0.8.0
entryCount: 31
packed bytes: 72116
unpacked bytes: 296057
```

## Acceptance matrix

| Boundary | State | Evidence |
| --- | --- | --- |
| macOS deterministic temporary-home build | passed | Installed hook, detached process, SQLite, encrypted evidence, Markdown, selection/emission and recurrence exercised by the commands above |
| macOS real provider | pending | Coordinator must run `AFL_REAL_PROVIDER=1`; deterministic provider cannot satisfy this row |
| Linux container build | pending | Coordinator must run the same default smoke in the declared official Node image with a read-only repository mount and disposable writable HOME/TMP |
| Guarded real-state after diff | pending | Before snapshot exists outside this implementation dispatch; after snapshot and diff have not been run here |
| Codex desktop visibility | pending user-authorized verify | Protocol/build success is not desktop UI evidence |
| Production rollout | not authorized | Global hooks, managed runtime pointer, and real databases remain outside this build task |

## Scope audit

Task 15 adds tests and this evidence only, plus OpenSpec/Comet bookkeeping. It changes no production source, schema, service, scheduler, RAG/index, post-turn hook, receipt/notification transport, Windows path, or real user state. Temporary projects and deterministic providers are removed by test cleanup; a caller-supplied `AFL_SMOKE_HOME` remains caller-owned for the surrounding install/doctor cleanup sequence.
