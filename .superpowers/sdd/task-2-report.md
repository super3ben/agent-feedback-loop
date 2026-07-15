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
