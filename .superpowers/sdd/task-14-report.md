# Task 14 Report: doctor, logging, package, and installation documentation

## Scope

- Exported `RUNTIME_VERSION` from `src/index.mjs` and set package metadata to
  `0.8.0`; installer current metadata, versioned runtime paths, and `doctor`
  now use that one constant.
- Reduced the public `doctor()` contract to `{ version, status }`, with exactly
  `promptHook`, `controlStore`, `reflectionDirectory`, `reviewerProvider`,
  `legacyStopRemoved`, and `ready` in `status`. The live canary is nested under
  `status.controlStore.live`, and CLI success/exit code reads `status.ready`.
- Replaced CLI diagnostic text with a bounded JSONL structured logger. Prompt
  events remain gated by `AGENT_FEEDBACK_LOOP_DEBUG=1`; reviewer terminal events
  remain visible. Invalid events emit nothing; invalid reason/result codes are
  fixed values; document text becomes a SHA-256; unrecognised fields are dropped.
- Rewrote English/Chinese install documentation and the installed rule around the
  immediate prompt-only, detached-reviewer, immutable-Markdown pipeline.
- Added doctor-shape, privacy/adversarial logger, normal debug-event, package
  contents, documentation-contract, version, and live-doctor E2E assertions.

## RED

Command:

```sh
node --test --test-name-pattern='doctor reports only the prompt and document pipeline|structured logs never contain content|package excludes removed control plane files' test/runtime.test.mjs test/cli.test.mjs
```

Observed expected failures before implementation:

- `RUNTIME_VERSION` was not exported.
- `doctor()` retained the old wide top-level compatibility shape.
- `structuredLog` did not exist.

## GREEN and regression evidence

```sh
node --test --test-name-pattern='doctor reports only the prompt and document pipeline|structured logs never contain content|debug feedback evaluation emits normal bounded evidence|package excludes removed control plane files|documentation describes only the immediate prompt pipeline' test/runtime.test.mjs test/cli.test.mjs
# 5 passed

node --test test/runtime.test.mjs test/cli.test.mjs test/e2e-smoke.test.mjs
# 48 passed

npm pack --dry-run --json
# agent-feedback-loop@0.8.0; 31 files; required schema/document/signal files present;
# removed Stop/receipt/notification/reconcile artifacts absent

npm test
# passed (full suite)

git diff --check
# passed
```

## macOS real-machine evidence

- Used Computer Use to confirm the local Finder accessibility surface is available.
- In a disposable macOS temporary HOME, ran local `install` and `doctor --live`.
  Both exited `0`; `doctor` returned version `0.8.0`, the six status families,
  `status.ready: true`, and a healthy isolated control-store/encryption canary.
- The temporary HOME was removed afterwards. No real HOME or provider configuration
  was modified.

## Self-review

- Reviewer failure logging is `review_spawn_attempted` with `result: "failed"`,
  never `review_completed_no_lesson`.
- Normal candidate/not-candidate evaluation records a debug-only bounded event.
- Node runtime capability remains inside `status.promptHook`; no seventh status
  key or old top-level capability projection remains.
- The logger has no file, DB, network, or telemetry transport and no body-bearing
  field path. The pack test checks paths rather than invalidly banning legitimate
  legacy/synthetic parser text.
- Existing dirty Task 1/2/3 reports were not staged or modified by this task.

## Unverified boundaries

- This task does not establish Linux field acceptance, live provider behavior on
  every supported CLI, or desktop-task hot-reload acceptance. Documentation states
  those limits explicitly.

## Guarded review closeout

- Formal review `isolate-feedback-control-plane-task-14-v2-review-1` reported four
  Important invariants: incomplete doctor readiness, content-shaped family logging,
  false successful-launch diagnostics, and a missing post-claim failure event.
- The first three consumed generation-1 local-fix receipts. The terminal-event
  invariant returned `blocked_direction_review`; its recorded checkpoint selected
  exactly one new fixed event, `review_failed`, and consumed one architecture-fix
  receipt before implementation.
- Fix commit `d14731c` changed only `src/index.mjs`, `src/cli.mjs`,
  `test/cli.test.mjs`, and the fixed-event design list. Focused Task 14 regression
  passed 50/50; the full suite passed 264/264; package verification retained
  version 0.8.0 and 31 files with no removed control-plane artifact.
- A real macOS disposable-HOME install plus `doctor --live` returned the exact six
  status families, available control store/reflection directory,
  `legacyStopRemoved: true`, and `ready: true`. Real HOME was not modified.
- Frozen re-review `isolate-feedback-control-plane-task-14-v2-rereview-1` returned
  APPROVED with Critical/Important/Minor/Backlog all zero. All four Guard loops are
  closed without resetting their failure history.
