# Task 2 Report

## Status

Implemented deterministic review-receipt rendering and synthetic-control exclusion.

## RED Evidence

1. `node --test test/receipt.test.mjs`
   - Failed because `renderReceiptControl` was not exported from `src/receipt.mjs`.
2. `node --test --test-name-pattern="receipt control" test/capture.test.mjs test/codex-reconcile.test.mjs`
   - Failed because Stop normalization retained the receipt text and Codex reconciliation captured the synthetic assistant output.
3. `node --test test/receipt.test.mjs`
   - Failed after adding strict identifier-type coverage because numeric `notification_id` reached rendering instead of being rejected before formatting.
4. `node --test --test-name-pattern="receipt-only assistant transcript" test/capture.test.mjs`
   - Failed because a receipt-only Codex message was treated as an `active_turn_steering` referent.

## Files

- `src/receipt.mjs`
- `src/capture.mjs`
- `src/codex-reconcile.mjs`
- `test/receipt.test.mjs`
- `test/capture.test.mjs`
- `test/codex-reconcile.test.mjs`

## Decisions

- The renderer uses immutable `zh` and `en` copy maps. It accepts only Task 1 notification kinds and payload keys, requires the fields rendered for each kind, and exposes only a six-character safe job reference.
- Notification IDs, job IDs, payload JSON, visible lines, receipt controls, and instructions are bounded before rendering. IDs are strings with a safe identifier grammar; full colon-delimited session IDs and path-shaped values are rejected.
- A receipt control contains the exact Task 1 nonce marker. The stripping function removes only whole lines beginning with `[AFL] ` or exact receipt markers; ordinary text containing `AFL` remains unchanged.
- Stop normalization strips controls before redaction and hashing. Codex reconciliation strips them before assistant state aggregation, skips receipt-only assistant events, preserves mixed semantic text, and advances the transcript cursor normally.
- Structural referent detection also strips controls before deciding whether a same-turn assistant message can trigger an immediate review. Delivery-observation code continues to see the original transcript marker.
- Receipt values are intentionally not logged. Logging their identifiers or raw controls would add a privacy surface without helping deterministic rendering or diagnosis.

## Tests And Results

- `node --test test/receipt.test.mjs`: 5 passed, 0 failed.
- `node --test --test-name-pattern="receipt control" test/capture.test.mjs test/codex-reconcile.test.mjs`: 2 passed, 0 failed.
- `node --test --test-name-pattern="receipt-only assistant transcript|receipt control" test/capture.test.mjs test/codex-reconcile.test.mjs`: 3 passed, 0 failed.
- `node --test test/receipt.test.mjs test/capture.test.mjs test/codex-reconcile.test.mjs`: 49 passed, 0 failed.
- `npm test`: passed with exit code 0 on the local macOS Node/SQLite runtime.
- `git diff --check`: passed before the implementation commit.
- Renderer boundary probe: visible line 52 characters, receipt control 144 characters, and instruction 378 characters; mixed output reduced to `normal answer`.
- Computer Use attempted a local Terminal inspection but the safety layer denied access to `com.apple.Terminal`. The full Node suite, including installed-hook and reconciliation tests, still ran on the real local runtime.

## Commit SHA

- Implementation: `11b6bd734a3cabd42f1189ded2f3901ac09d4c98`

## Concerns

- No functional concerns found in the Task 2 ownership boundary.
- UI-level Computer Use verification was blocked by the host safety policy; this task has no UI surface, and local real-runtime tests provide the available machine evidence.

## Review Fixes

### Status

All Task 2 review findings, including the Critical structural-evidence loss, are fixed in implementation commit `036b58c1c9a8d423bf39fef293dae786ec90a542`.

### RED Evidence

Command:

```text
node --test test/receipt.test.mjs test/capture.test.mjs test/codex-reconcile.test.mjs test/cli.test.mjs
```

Initial result: 67 passed, 5 failed.

1. Real `candidate_captured` outbox row failed with `TypeError: receipt job id is invalid` because its Task 1 `job_id` is `null`.
2. Standalone `[AFL] This is legitimate standalone prose` was reduced to an empty string.
3. UUID and `msg_UUID` notification identifiers were accepted by the old broad safe-ID grammar.
4. Receipt-only Codex text with tool/file/artifact references produced `eventsCaptured=0` instead of preserving the structural event.
5. Real `capture-stop` with receipt-only text and file/artifact references wrote no event row.

The first full-suite run then exposed one Task 1 compatibility fixture in `containsReceiptMarker`: 180 passed, 1 failed. Compatibility was retained only for that observation helper; renderer emission and stripping remain canonical-ID-only.

### Fixes And Self-Review

- Renderer tests now construct all six inputs from actual schema-v8 store outbox rows. Candidate rows use a six-hex SHA-256 event reference, review states use the canonical job prefix, and `lesson_delivered` exposes no job/event reference.
- Chinese visible text matches `docs/superpowers/specs/2026-07-15-background-review-observability-design.md` exactly. English copy follows the same state distinctions.
- Receipt emission accepts only canonical 64-hex Task 1 notification/job IDs. Candidate event UIDs are never exposed directly; UUID, `msg_UUID`, path, and session-shaped values are rejected in notification/job positions.
- Stripping requires an adjacent recognized visible line plus an exact canonical marker whose nonce and state match. Standalone, quoted, embedded, malformed, native-message-shaped, and wrong-nonce content remains intact.
- One shared `hasCaptureEvidence` predicate gates Codex reconciliation and real Stop CLI capture. Tool refs, textual output refs, file refs, and artifact hashes are extracted before the skip decision and persisted even when receipt stripping leaves no semantic text.
- Cursor regression proves a structural-only Codex message advances to the transcript file size without losing the stored event.
- Privacy review found no visible or hidden session/message identifier path. The hidden marker contains only the canonical notification ID plus deterministic nonce/state control fields.

### Verification

- `node --test test/receipt.test.mjs test/capture.test.mjs test/codex-reconcile.test.mjs test/cli.test.mjs`: 72 passed, 0 failed.
- `node --test test/e2e-smoke.test.mjs`: 14 passed, 0 failed.
- `node --test --test-name-pattern="receipt|structural references|payload validation and markers" test/receipt.test.mjs test/capture.test.mjs test/codex-reconcile.test.mjs test/cli.test.mjs test/store.test.mjs`: 15 passed, 0 failed.
- `npm test`: 181 passed, 0 failed.
- `git diff --check` and `git diff --cached --check`: passed.
- Computer Use attempted `com.apple.Terminal`; the host safety layer returned `Computer Use is not allowed to use the app 'com.apple.Terminal' for safety reasons.` Local macOS CLI, installed-hook, reconciliation, SQLite, and e2e tests are the available real-machine evidence.

### Concerns

- UI-level verification remains unavailable because Computer Use cannot access Terminal on this host. There is no Task 2 product UI surface.
- `containsReceiptMarker` still recognizes its legacy Task 1 fixed-ID test shape for compatibility. Generated controls and synthetic-control stripping are stricter and accept only canonical 64-hex notification IDs.

## Receipt Protocol Re-review Fixes

### Status

Both remaining Task 2 re-review findings are fixed in implementation commit `1b5fcc290a3bdf72ea21baa6087f41181415ba15`.

### RED Evidence

1. `node --test test/receipt.test.mjs test/store.test.mjs`: 51 passed, 5 failed.
   - All six real outbox exact-copy assertions lacked the authoritative short receipt binding.
   - A complete receipt pair inside a backtick fence was stripped.
   - UUID/native-message-shaped markers were accepted by `containsReceiptMarker`.
   - A real SQLite outbox row mutated to a UUID transitioned from `emitted` to `observed`.
2. `node --test --test-name-pattern="fenced, fabricated" test/receipt.test.mjs`: 0 passed, 1 failed.
   - Self-review proved mixed fence characters such as `three backticks followed by ~` incorrectly closed a backtick fence and exposed the following pair to stripping.

### GREEN Evidence

- `node --test test/receipt.test.mjs test/store.test.mjs`: 56 passed, 0 failed.
- `node --test test/receipt.test.mjs test/store.test.mjs test/capture.test.mjs test/codex-reconcile.test.mjs test/cli.test.mjs`: 122 passed, 0 failed.
- `npm test -- --test-reporter=dot`: 184 test points, exit code 0.
- `git diff --check` and `git diff --cached --check`: passed before the implementation commit.
- Boundary probe: visible line 69 characters, control 202 characters, instruction 436 characters; limits remain 160/512 and no session/message/path shape appeared.
- Real store-flow coverage confirms canonical 64-hex and exact legacy `notification-1` rows can reach `observed`; UUID, `msg_UUID`, colon/session, and path rows return `block` and remain `emitted`.

### Protocol And Self-review

- Every generated visible line now carries `receipt=<first 6 canonical notification_id>`; stripping verifies that binding with the adjacent marker ID, known state, deterministic nonce, and state-specific line grammar.
- Backtick and tilde fenced content, quoted pairs, malformed markers, old unbound lines, mixed fence characters, and mismatched ID/state/nonce/binding pairs are preserved.
- New rendering and stripping remain canonical 64-hex only. Observation compatibility is bounded to `notification-<positive safe integer>`; zero, leading-zero, oversized, UUID, `msg_UUID`, colon/session, path, and unknown-state forms are rejected.
- No receipt value is added to logs. The short binding is deterministic and non-sensitive; full session/message/path identifiers remain absent from visible and hidden controls.
- The design and implementation plan are updated. Ignored generated working artifacts `.superpowers/sdd/task-1-brief.md` and `.superpowers/sdd/task-2-brief.md` were regenerated from the affected plan sections.

### SHAs

- Re-review implementation: `1b5fcc290a3bdf72ea21baa6087f41181415ba15`
- Reviewed baseline implementation: `036b58c1c9a8d423bf39fef293dae786ec90a542`
- Previous Task 2 report: `d61f3fb37d22f0ffa6fdc1374378a0fab65f2878`

### Concerns

- Computer Use was attempted through the local Mac runtime but returned: `The Mac is locked and automatic unlock could not unlock it. Ask the user to unlock the Mac manually before continuing.` There is no Task 2 UI surface; local macOS installed-hook, SQLite, reconciliation, CLI, and full-suite tests are the available real-machine evidence.
- No functional or privacy concern remains inside the Task 2 ownership boundary.

## Final Exact-line Commitment Fixes

### Status

The final two Task 2 findings are fixed in implementation commit `f0295b13011a79be30a6f15144d76c3f782397ca`.

### RED Evidence

- `node --test test/receipt.test.mjs test/store.test.mjs test/codex-reconcile.test.mjs`: 75 passed, 3 failed.
- Grammar-valid `candidate_captured` event mutation retained the old marker and was stripped instead of preserved.
- A canonical 64-hex row carrying the old ID-only v1 marker transitioned to `observed` instead of remaining `emitted`.
- A real Codex assistant transcript event with `content: []` plus tool/output/file/artifact refs produced `eventsCaptured=0` instead of one durable event.

### Implementation And Self-review

- Current canonical controls now use a domain-separated SHA-256 v2 nonce over canonical `notification_id`, `state`, and the exact rendered visible line, truncated to 16 hex. The fixed fixture commits to nonce `03941ce38a08b1dc`.
- `renderReceiptControl` emits the v2 marker. Stripping recomputes v2 from the adjacent exact line, so grammar-valid changes to event, job, severity, or lesson count preserve the complete pair while every exact generated pair strips.
- Canonical observation re-renders the authoritative outbox row and accepts only its exact v2 marker. A canonical ID-only v1 marker no longer observes.
- `receiptNonce` remains the isolated v1 compatibility path for exact `notification-<positive safe integer>` rows. Zero, leading-zero, oversized, UUID, `msg_UUID`, colon/session, path, and unknown-state forms remain rejected.
- Codex reconciliation extracts structural refs before its evidence decision and skips only when `hasCaptureEvidence` is false. The `content: []` regression stores tool/output/file/artifact refs and advances the cursor to transcript EOF.
- The tracked design and implementation plan describe the v2/v1 boundary and structural-only cursor contract. Task 1 and Task 2 briefs were regenerated to 427 and 107 lines and matched fresh generator output byte-for-byte.

### Verification

- Focused receipt/Codex/store suite: 78 passed, 0 failed.
- Complete Task 2 suite (`receipt`, `capture`, `codex-reconcile`, `cli`, `store`): 124 passed, 0 failed; the final dot-reporter rerun exited 0 after the exact nonce assertion was pinned.
- `npm test`: 185 passed, 0 failed.
- `git diff --check` and `git diff --cached --check`: passed before the implementation commit.
- Computer Use attempted `com.apple.Terminal`; the host safety layer returned `Computer Use is not allowed to use the app 'com.apple.Terminal' for safety reasons.` Task 2 has no product UI; installed-hook, local macOS CLI, SQLite, transcript reconciliation, and full-suite tests are the real-machine evidence.

### SHAs

- Exact-line implementation/docs/tests: `f0295b13011a79be30a6f15144d76c3f782397ca`
- Prior receipt-protocol implementation: `1b5fcc290a3bdf72ea21baa6087f41181415ba15`
- Prior Task 2 report: `aadc7d3`

### Concerns

- UI-level Terminal inspection remains unavailable because the Computer Use safety policy denies Terminal access. No Task 2 product UI exists.
- No functional, backward-compatibility, forged-control, privacy, or structural-cursor concern remains inside the requested ownership boundary.

## Final CRLF Preservation Fix

### Status

The final Task 2 CRLF preservation finding is fixed in implementation commit `b282d194b078afd254e9cfa3a601494b8ffd69de`.

### RED Evidence

- `node --test test/receipt.test.mjs`: 8 passed, 1 failed.
  - Ordinary CRLF evidence was rewritten from `\r\n` to `\n` even when no receipt control was present.

### GREEN Evidence

- `node --test test/receipt.test.mjs`: 9 passed, 0 failed.
- Complete Task 2 suite (`receipt`, `capture`, `codex-reconcile`, `cli`, `store`): 125 passed, 0 failed.
- `npm test`: 186 passed, 0 failed.
- `git diff --check`: passed before the implementation commit.

### Implementation And Self-review

- `stripReceiptControlText` now scans the original source into line ranges and deletes only exact, validated receipt-control byte ranges.
- Ordinary CRLF, mixed LF/CRLF, backtick/tilde fenced controls, and mismatched controls are returned byte-for-byte unchanged.
- Exact beginning, middle, and end controls retain the prior deterministic removal behavior while preserving every unrelated line delimiter in its original form.
- v2 nonce validation, visible-line binding, fence handling, legacy observation compatibility, structural-evidence handling, and the no-receipt-logging privacy boundary remain unchanged.

### Concerns

- Computer Use attempted `com.apple.Terminal`, but the host safety policy denied it. There is no Task 2 product UI; local macOS Node, SQLite, installed-hook, CLI, reconciliation, and full-suite tests are the available real-machine evidence.
- No functional or protocol concern remains in the requested ownership boundary.
