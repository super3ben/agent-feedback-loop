# Task 3 Implementation Report

## Status: Complete

## Commit
`afcd555` on worktree `agent-aba72162330361602` (branch `worktree-agent-aba72162330361602`)

**Different from coordinator worktree**: Yes -- this worktree is `agent-aba72162330361602`, NOT `semantic-dissatisfaction-gate`. The coordinator will need to cherry-pick commit `afcd555`.

## Files Changed
4 files, 121 insertions, 8 deletions

### 1. `src/control-store.mjs` (store infrastructure)
- **`createReviewCandidate`**: Added optional `reasonCode` parameter (defaults to `"explicit_feedback"`). Existing callers (no reasonCode argument) use the same behavior as before. The expanded recall test passes `reasonCode: "expanded_feedback"` to simulate jobs from the coarse-recall path.
- **`getReviewCandidateEvent(jobId)`**: New read-only method that queries `review_job_events` for the `candidate_created` event and returns the reason_code.

### 2. `src/reviewer-runner.mjs` (core changes)
- **`semanticGateProjection(context)`**: New deterministic, rule-based function that extracts a frozen projection from the review context for the semantic gate. Fields: `prompt`, `referent`, `provider`, `sessionUid`, `projectId`, `reasonCodes`, `priorEmission`, `recurrenceObserved`.
- **`buildReviewContext`**: Extended to include `candidate: { source }` in the returned context. Reads the candidate event from the store via `getReviewCandidateEvent`:
  - `reason_code === "expanded_feedback"` → `candidate.source = "expanded_coarse_recall"`
  - Default (including all existing jobs) → `candidate.source = "explicit_legacy_hit"`
- **`runReviewJob`**: Gate-first routing:
  - `candidate.source === "expanded_coarse_recall"`: Calls provider with `semanticGateProjection(context)` and `{ resultKind: "semantic_dissatisfaction_gate" }`. If `is_dissatisfaction` is falsy, calls `completeReviewNoLesson` and returns early. If `is_dissatisfaction` is truthy, falls through to the full reviewer.
  - Otherwise (explicit_legacy_hit or undefined): Calls provider with original context and `{ resultKind: "reviewer" }` (existing behavior with `resultKind` threading).

### 3. `src/cli.mjs` (resultKind threading)
- **`reviewer-run` command**: Provider callback now accepts `(context, { resultKind })`:
  - When `resultKind === "semantic_dissatisfaction_gate"`: calls `runReviewerProvider` with only `resultKind` (no `promptFile`/`schemaFile`).
  - Default (full reviewer): calls `runReviewerProvider` with `promptFile`/`schemaFile` as before (no `resultKind`).

### 4. `test/reviewer-runner.test.mjs` (tests)
- **`reviewFixture`**: Added optional `candidateReasonCode` parameter to support expanded-recall test setup.
- **`candidateReasonCode`**: When provided, passed as `reasonCode` to `createReviewCandidate`.
- **New test: "semantic gate stops the job before full reviewer when candidate is expanded but not real dissatisfaction"**: Creates a job with `reasonCode: "expanded_feedback"`. Provider records calls and returns `{ is_dissatisfaction: false }` for `resultKind: "semantic_dissatisfaction_gate"`. Asserts only the gate was called, result is `"reviewed_no_lesson"`, job state is `"reviewed_no_lesson"`.
- **New test: "existing explicit dissatisfaction path still reaches the full reviewer directly"**: Creates a job with default (explicit) reasonCode. Provider records calls and returns `{ outcome: "no_lesson" }` for `resultKind: "reviewer"`. Asserts only `"reviewer"` was called (gate bypassed), job state is `"reviewed_no_lesson"`.

## Test Results
```
node --test test/reviewer-runner.test.mjs
  pass 16 (all tests including 14 existing + 2 new)
  fail 0

node --test test/reviewer-provider.test.mjs (focused subset)
  pass 20 (semantic gate profile still works)
  fail 0
```

## Key Design Decisions
- **Candidate source stored via `reasonCode` in `review_job_events`**: Uses existing schema -- no schema migration needed. The event's `reason_code` field is the carrier. `"explicit_feedback"` = legacy explicit path, `"expanded_feedback"` = expanded coarse-recall path.
- **Gate context is a deterministic projection**: `semanticGateProjection` produces a frozen object with only the fields the semantic gate needs (text, referent, provider metadata, reason codes). It does not include raw `encrypted_raw_ref` or blob data.
- **Gate failure is treated as provider failure**: If the semantic gate provider throws, the standard `providerFailure` error handling applies (same as full reviewer failure).
- **Expanded + is_dissatisfaction = true falls through**: When the gate confirms dissatisfaction, the full reviewer runs with the original (non-projected) context and `{ resultKind: "reviewer" }`.

## Concerns
- The `candidateReasonCode` logic in `buildReviewContext` uses a try-catch; if the store method doesn't exist (hypothetical older store), it defaults to "explicit_legacy_hit" without crashing.
- No e2e-level test was added for the full hook-to-gate chain (per task scope constraint: "Do not touch capture/e2e/provider assets yet").
