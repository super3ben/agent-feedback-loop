# Long-Term Memory Closed-Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven-development for every behavior change. This plan is executed inline in the current session because the user explicitly requested completion.

**Goal:** Turn the existing capture/job/lesson framework into an evidence-complete, once-per-job, authenticated reviewer loop that improves later sessions without unnecessary context growth.

**Architecture:** Prompt-time hooks capture user events and Stop/AfterAgent hooks capture assistant, transcript, tool, and artifact evidence into one transactional store. A scheduled Codex transcript reconciler closes upgrade, restart, and same-turn steering gaps with message-level identities and durable cursors. A reviewer job owns a monotonic wake state and one-time capability; an isolated Codex, Claude, or Gemini CLI process receives bounded evidence over a secure file/stdin boundary. Runtime validation commits the report, projects safe rules, and promotes only independently repeated Blocker lessons.

**Tech Stack:** Node.js ESM, `node:sqlite`, POSIX hooks, AES-GCM blobs, random one-time capabilities stored as SHA-256 verifiers, Node test runner.

## Global Constraints

- Preserve runtime/data/key root separation and existing dirty-worktree changes.
- Normal prompt capture and lesson selection must not call an LLM.
- Pending evidence is never deleted by retention GC.
- Receipt and wake transitions are transactional, idempotent, and lease fenced.
- Reviewer execution never falls back to the user's active conversation. Built-in providers run as separate CLI processes with hooks, skills, tools, and persistence disabled where each provider supports those controls.
- Hook capture and transcript reconciliation are complementary observations of one message; observation aliases deduplicate the same message without collapsing identical repeated messages.
- Same-turn steering is a structural signal only after assistant output. Multiple additive user messages before assistant output do not force an immediate review.
- Vector retrieval remains optional candidate generation; structured scope is the correctness boundary.

---

### Task 1: Evidence-complete capture

**Files:** `src/schema.mjs`, `src/capture.mjs`, `src/store.mjs`, `src/cli.mjs`, `templates/hooks/stop-hook.sh`, `test/capture.test.mjs`, `test/e2e-smoke.test.mjs`

**Produces:** `normalizeStopEvent()`, transcript/tool/artifact metadata columns, `getReviewerContext()` containing both user and assistant evidence with completeness labels.

- [x] Write failing tests proving a complaint can reference a preceding assistant output and that prompt-only evidence is marked partial.
- [x] Run the focused tests and confirm they fail because stop evidence is absent.
- [x] Implement Stop/AfterAgent capture through the stable launcher and normalized event schema.
- [x] Run focused tests and retain only bounded, redacted reviewer context.

### Task 2: Once-per-job wake state

**Files:** `src/schema.mjs`, `src/store.mjs`, `src/cli.mjs`, `test/store.test.mjs`, `test/e2e-smoke.test.mjs`

**Produces:** `claimReviewerWake({jobId, cooldownMs})` returning `inject | suppressed | retry`, persisted wake attempt and next retry time.

- [x] Write failing tests showing the same pending job injects once, suppresses immediate repeats, and retries after cooldown.
- [x] Run focused tests and confirm repeated injection currently fails.
- [x] Add transactional wake fields and monotonic attempts.
- [x] Replace status-only prompt injection with the wake decision and verify the focused tests.

### Task 3: Authenticated atomic receipt

**Files:** `src/reviewer-auth.mjs`, `src/store.mjs`, `src/cli.mjs`, `test/reviewer-auth.test.mjs`, `test/store.test.mjs`

**Produces:** one-time random capability bound to job/wake/expiry through its stored SHA-256 verifier; `readSecureReceipt()` requiring regular file, owner uid, mode `0600`, bounded size, atomic-ready marker, agent id, and capability.

- [x] Write failing tests for invalid token, reused token, symlink, permissive mode, partial file, and valid atomic receipt.
- [x] Run focused tests and confirm the security boundary is missing.
- [x] Implement capability issue/consume and secure receipt loading.
- [x] Verify invalid receipts leave the job retryable instead of stranded in `running`.

### Task 4: External reviewer context delivery

**Files:** `src/reviewer-runner.mjs`, `src/cli.mjs`, `test/reviewer-runner.test.mjs`

**Produces:** short-lived reviewer environment variables `AFL_REVIEW_JOB_ID`, `AFL_REVIEW_CONTEXT_FILE`, `AFL_REVIEW_PROMPT_FILE`, scrubbed inherited environment, and bounded secure context file cleanup. This is a lifecycle boundary, not an OS sandbox.

- [x] Write a failing executable-reviewer test that asserts it received the job id and readable context file.
- [x] Run it and confirm current fixed args provide neither.
- [x] Materialize a `0600` context file and pass the environment to the short-lived process.
- [x] Verify cleanup, lease completion, and retry behavior.

### Task 5: Quality, projection, promotion, and outcomes

**Files:** `src/lessons.mjs`, `src/store.mjs`, `src/selector.mjs`, `test/store.test.mjs`, `test/selector.test.mjs`

**Produces:** validated responsibility/severity/5-Why/method fields, trusted report and project-rule projection, two-project Blocker promotion, and recurrence-based delivery outcomes.

- [x] Write failing tests rejecting shallow reviewed receipts and preventing rule writes without proven `agent_fault`.
- [x] Write failing tests for two independent projects promoting one Blocker family and for recurrence marking a delivered lesson ineffective.
- [x] Implement trusted rendering and promotion/outcome transactions.
- [x] Verify Minor/Major lessons never auto-promote and global candidates remain bounded by token budget.

### Task 6: Acceptance

**Files:** `README.md`, `README-zh.md`, all tests, installed user runtime.

- [x] Run focused suites, then `npm test`, then `git diff --check`.
- [x] Reinstall into the real user home and run `doctor --live`.
- [x] Exercise a three-turn due-review flow and verify only one prompt wake, complete user+assistant context, secure submit, report persistence, and later lesson injection.
- [x] Attempt Computer Use against an allowed app and report any app-specific safety restriction separately from plugin behavior.

### Task 7: Codex transcript reconciliation and isolated built-in reviewers

**Files:** `src/codex-reconcile.mjs`, `src/reconcile-scheduler.mjs`, `src/codex-host.mjs`, `src/reviewer-provider.mjs`, `src/cli.mjs`, `src/schema.mjs`, `src/store.mjs`, `test/codex-reconcile.test.mjs`, `test/reconcile-scheduler.test.mjs`, `test/reviewer-provider.test.mjs`

**Produces:** message-level transcript capture, hook/transcript observation reconciliation, durable byte cursors, a macOS LaunchAgent catch-up pass, and isolated Codex/Claude/Gemini reviewer adapters that cannot consume the user's main conversation.

- [x] Reproduce the missed Codex task and prove that the old parser discarded later user messages in the same turn.
- [x] Add failing tests for same-turn steering, additive user messages, repeated identical messages, missing native message ids, control records, oversized records, symlinks, capture-off mode, and cursor races.
- [x] Implement bounded incremental JSONL reconciliation with native-id-or-byte-offset identity and structural control-record filtering.
- [x] Reconcile hook and transcript observations transactionally while preserving source chronology and explicit coverage gaps.
- [x] Add a low-frequency LaunchAgent scheduler so hook activation gaps are caught without an LLM call on every turn.
- [x] Add fail-closed built-in reviewer adapters and process-group timeout cleanup for Codex, Claude, and Gemini CLIs.
- [x] Run the full regression suite, reinstall the real user runtime, inspect the scheduler/doctor state, and verify an actual isolated reviewer completion.

### Task 8: Reconciliation liveness and missed-correction recovery

**Files:** `src/codex-reconcile.mjs`, `src/reconcile-scheduler.mjs`, `src/capture.mjs`, `src/store.mjs`, `src/cli.mjs`, `src/index.mjs`, related tests and READMEs.

**Produces:** a continuously observed scheduler rather than a loaded-but-idle one-shot job, same-active-turn structural steering candidates, bidirectional hook/transcript aliasing, and automatic recovery for retryable or expired reviewer jobs.

- [x] Reproduce the real task lag and prove the LaunchAgent was loaded but had run only once.
- [x] Add regression tests for active-turn steering, transcript-first aliasing, stale leases, retry exhaustion, and oversized record cursor progress.
- [x] Replace one-shot scheduling with a lightweight `KeepAlive` daemon that spawns bounded reconciliation children.
- [x] Require a running scheduler plus a fresh successful reconciliation in real-home doctor status.
- [x] Run the full suite, reinstall the real runtime, observe multiple scheduled passes, and verify the affected task reaches an isolated reviewer.

Acceptance evidence (2026-07-14): `150/150` tests passed; task
`019f4063-223d-7b71-837c-6bab4fa49069` recovered 22 previously missed events from
bounded Codex compaction history, launched one isolated reviewer, completed on its
strict retry with a 679-character report and one six-link Major lesson, and selected
that lesson as one approximately 693-token action card for a matching later task.
The KeepAlive scheduler advanced its reconciliation timestamp and child fork count
across a real 60-second interval. `doctor --live` passed its isolated store/encryption
canary. Computer Use access to `com.openai.codex` was attempted separately and denied
by the desktop safety policy; that app-specific UI restriction did not affect hook,
transcript, reviewer, or delivery verification.
