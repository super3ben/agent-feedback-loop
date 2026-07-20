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

The first real-Codex attempt then failed before reviewer execution with HTTP 400 `invalid_json_schema`: the Task 7 logical schema has a top-level `oneOf`, while Codex Structured Outputs requires a root object and rejects that composition. The bounded correction keeps the installed logical schema byte-identical, derives a private per-invocation Codex transport schema with a required `result` envelope and nested `anyOf`, securely reads and unwraps that envelope, and leaves the existing JavaScript semantic validator authoritative. Focused RED was 7/9 and GREEN was 9/9; the provider/result-file/result/runner regression passed 47/47.

Linux acceptance exposed two test-only portability/synchronization defects before the final accepted run. The adapter fixture implicitly expected the macOS application fallback to exist on Linux; it now uses an explicit provider-specific executable. A later default-concurrency run proved that the platform smoke treated Markdown rename visibility as reviewer completion; the wait now requires the corresponding control jobs to be terminal `published`. Production code was not changed for either Linux finding, and no further repair round was needed.

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
tests: 268, pass: 268, fail: 0
duration: 14.636 s
```

The full suite includes schema v8 and v9 legacy-copy fixtures. For each version it proves a side-effect-free dry-run, one successful export, an idempotent second export, and unchanged source DB/WAL/SHM hashes.

```text
npm pack --dry-run --json
exit: 0
package: agent-feedback-loop@0.8.0
entryCount: 31
packed bytes: 72830
unpacked bytes: 298867
```

## Final coordinator platform evidence

The macOS real-provider path used the installed temporary runtime and the already-authenticated real Codex CLI without selecting or modifying the user's managed AFL runtime:

```text
node ./bin/agent-feedback-loop.mjs install --home "$TMP_HOME"
AFL_SMOKE_HOME="$TMP_HOME" AFL_REAL_PROVIDER=1 node --test test/platform-smoke.test.mjs
exit: 0
tests: 1, pass: 1, fail: 0
duration: 37.911 s
```

The real provider published canonical Markdown and a later prompt received the method. A separate doctor invocation from a disposable project with `.agent/reflections` present returned `version=0.8.0`, `ready=true`, and `legacyStopRemoved=true`. This is protocol/process/filesystem proof on a real macOS host, not Codex desktop UI visibility proof.

The accepted Linux run used official `node:24-bookworm-slim` (Node v24.18.0), disabled network access, a read-only repository mount, and a disposable writable HOME/TMP:

```text
npm test
tests: 268, pass: 267, fail: 0, skipped: 1
duration: 11.772 s

node ./bin/agent-feedback-loop.mjs install --home /state/home
AFL_SMOKE_HOME=/state/home node --test test/platform-smoke.test.mjs
tests: 1, pass: 1, fail: 0
duration: 0.664 s
```

The single full-suite skip is the explicitly macOS-only detached-parent test; the Linux platform smoke exercises the shared detached launcher, lease/terminal publication, private SQLite/filesystem state, Markdown selection, recurrence, and Top-4 behavior.

Finally, the coordinator repeated SHA-256, size, and mtime reads for the real Codex config, managed runtime pointer, and legacy SQLite DB/WAL/SHM. All five records matched the pre-Task-15 snapshot exactly. Global AFL hooks remained disabled; no real runtime selection or database migration occurred.

## Acceptance matrix

| Boundary | State | Evidence |
| --- | --- | --- |
| macOS deterministic temporary-home build | passed | Installed hook, detached process, SQLite, encrypted evidence, Markdown, selection/emission and recurrence exercised by the commands above |
| macOS real provider | passed | Real authenticated Codex CLI completed the temporary-HOME protocol chain and published/injected Markdown; desktop UI visibility is still separate |
| Linux container build | passed | Official Node v24.18.0 image passed the default-concurrency full suite and installed platform smoke with a read-only repository mount |
| Guarded real-state after diff | passed | Config, runtime pointer, and legacy DB/WAL/SHM SHA-256, size, and mtime matched the pre-task snapshot exactly |
| Codex desktop visibility | pending user-authorized verify | Protocol/build success is not desktop UI evidence |
| Production rollout | not authorized | Global hooks, managed runtime pointer, and real databases remain outside this build task |

## Scope audit

Task 15 adds the platform tests/evidence and one bounded Codex-only transport compatibility correction in `src/reviewer-provider.mjs`. The authoritative logical schema, runner semantic validator, Claude/Gemini behavior, database schema, services, scheduler, RAG/index, post-turn hook, receipt/notification transport, Windows boundary, and real user state are unchanged. Temporary projects, providers, containers, and homes were removed after verification.
