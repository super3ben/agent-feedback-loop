# Long-Term Memory Closed-Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven-development for every behavior change. This plan is executed inline in the current session because the user explicitly requested completion.

**Goal:** Turn the existing capture/job/lesson framework into an evidence-complete, once-per-job, authenticated reviewer loop that improves later sessions without unnecessary context growth.

**Architecture:** Prompt-time hooks capture user events and Stop/AfterAgent hooks capture assistant, transcript, tool, and artifact evidence into one transactional store. A reviewer job owns a monotonic wake state and one-time capability; either an isolated CLI receives a bounded context file or the active model is prompted once to delegate to a native background subagent. Runtime validation commits the report, projects safe rules, and promotes only independently repeated Blocker lessons.

**Tech Stack:** Node.js ESM, `node:sqlite`, POSIX hooks, AES-GCM blobs, random one-time capabilities stored as SHA-256 verifiers, Node test runner.

## Global Constraints

- Preserve runtime/data/key root separation and existing dirty-worktree changes.
- Normal prompt capture and lesson selection must not call an LLM.
- Pending evidence is never deleted by retention GC.
- Receipt and wake transitions are transactional, idempotent, and lease fenced.
- Prompt delegation is honest: it requires a native subagent but cannot claim platform attestation.
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
