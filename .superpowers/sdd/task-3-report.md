# Task 3 Report

## Status

Implemented main-chat receipt injection and authoritative transactional Stop confirmation. The current acceptance scope is the Codex vertical path; Gemini native `prompt_response` confirmation is explicitly deferred until after real Codex proof.

## RED Evidence

1. `node --test --test-name-pattern="receipt|ordinary prompt" test/cli.test.mjs`
   - The first run did not select the interrupted-turn test because its name lacked `receipt`; after correcting the test name, the rerun produced 2 passed and 1 failed.
   - The structural correction output contained only the checkpoint and lacked the queued `[AFL]` line and v2 marker.
2. `node --test --test-name-pattern="receipt Stop|receipt marker|receipt re-emission" test/cli.test.mjs`
   - 0 passed and 3 failed.
   - Transactional Stop always passed because `capture-stop` returned `{}` and `stop-hook.sh` discarded its stdout; marker observation and re-emission state changes were not authoritative.
3. `node --test --test-name-pattern="receipt marker is observed from the bounded tail" test/cli.test.mjs`
   - 0 passed and 1 failed.
   - A transcript larger than 2 MiB was skipped instead of reading a bounded tail, so an exact marker at EOF caused an incorrect block.
4. `node --test --test-name-pattern="immediate background review receipt" test/cli.test.mjs`
   - 0 passed and 1 failed after adding the dedicated chat-log schema assertion.
   - `receipt.chat.emitted` logged `attempt=1` rather than the required `count=1` field.

## Files

- `src/cli.mjs`
- `src/store.mjs`
- `src/capture.mjs`
- `templates/hooks/stop-hook.sh`
- `test/cli.test.mjs`
- `test/store.test.mjs`
- `test/e2e-smoke.test.mjs`
- `docs/superpowers/plans/2026-07-15-background-review-observability-implementation.md`
- `.superpowers/sdd/task-3-report.md`

`test/e2e-smoke.test.mjs` now contains disposable-home install proof that the repository template forwards transactional Stop stdout. This is packaging fixture evidence, not proof about the real user-level installation.

## Decisions

- Structural captures create `candidate_captured` before `submitDueReview`; the store transaction supersedes it with `review_queued`. Lesson deliveries use one aggregate `recordDeliveries` call.
- All queue, lesson, and hold producers finish before one `claimChatNotification` call for the native turn. Ordinary prompts remain zero-injection.
- `AGENT_FEEDBACK_LOOP_CHAT_RECEIPTS=0` suppresses every claimable row (`pending`, `emitted`, and `emitted_unconfirmed`) for the session/epoch and does not replay them when re-enabled. Observed rows remain unchanged. `AGENT_FEEDBACK_LOOP_RECEIPT_LANGUAGE` is resolved through `detectReceiptLanguage` before notification creation.
- Dedicated receipt logs are active without debug mode. Creation logs contain only notification ID, kind, and a 12-hex SHA-256 session hash; chat logs contain only notification ID and count.
- Transactional `capture-stop` parses only role-validated assistant message output from a 128 KiB owned regular-file transcript tail and combines it with a 32 KiB bounded `last_assistant_message`. Tool output, user messages, control records, prompts, malformed JSON, and arbitrary raw bytes cannot observe a receipt. The tail reader validates owner and inode/device after opening and never loads the complete transcript; missing recognized assistant output is logged as a coverage gap.
- Stop responses use native host schemas: Codex pass is `{ "continue": true }`, Claude/Gemini pass is `{}`, Gemini block is `deny`, and Codex/Claude block is `block` with the exact Task 2 v2 line and marker.
- The first emission can block once. An unconfirmed notification can be claimed once more, but its second emission advances to unconfirmed without another block. Store fencing keeps the maximum at two emissions.
- `stop-hook.sh` forwards successful transactional stdout and exits. Marker-file behavior is reachable only through explicit legacy configuration.

## Tests And Results

- `node --test --test-name-pattern="receipt|ordinary prompt" test/cli.test.mjs`: 7 passed, 0 failed before the later bounded-tail addition.
- `node --test --test-name-pattern="receipt Stop|receipt marker|receipt re-emission" test/cli.test.mjs`: 3 passed, 0 failed after transactional Stop implementation.
- `node --test --test-name-pattern="receipt marker is observed from the bounded tail" test/cli.test.mjs`: 1 passed, 0 failed after bounded tail reading.
- Pre-review `node --test test/cli.test.mjs test/e2e-smoke.test.mjs`: 41 passed, 0 failed.
- Pre-review `npm test`: 192 passed, 0 failed.
- `sh -n templates/hooks/stop-hook.sh`, `sh -n templates/hooks/core-hook.sh`, and `node --check src/cli.mjs`: exit code 0.
- `git diff --check`: exit code 0 before the implementation commit.
- Pre-review Computer Use was attempted against Terminal and Codex, but the host safety policy denied both applications. Those runs did not prove the real user-level hook.

## Commit SHA

- Implementation: `10abc9e7e35798316696d3222c4f39c7cc1714c7`

## Concerns

- UI-level Terminal/Codex inspection is unavailable because Computer Use denies those applications. Task 3 has no L1 product/runtime acceptance claim.
- The real `~/.agent` hook is intentionally not replaced by this partial branch. Task 7 owns atomic installed-runtime acceptance after Tasks 1-6.

## Review Fixes

### RED Evidence

1. `node --test --test-name-pattern="non-assistant Codex|role-validated assistant|disabling receipts|disabled receipt channels|forwards transactional" test/cli.test.mjs test/store.test.mjs test/e2e-smoke.test.mjs`
   - 2 passed and 3 failed.
   - A v2 receipt copied into `custom_tool_call_output`, user, event/control, and prompt records falsely observed the notification; disabling after the first block/pass sequence replayed `emitted_unconfirmed`; the new store API was absent.
2. `node --test --test-name-pattern="disabled receipt channels" test/store.test.mjs`
   - 0 passed and 1 failed with `store.suppressClaimableChatNotifications is not a function` after correcting fixture identifiers.

### Fixes

- `a08ccc60e4f74e14e32461e21cc1c8c76a09a973` builds confirmation text only from bounded, structured assistant output and the bounded host assistant field. The exact receipt in tool/user/control/prompt records now blocks and remains `emitted`; a genuine Codex assistant `output_text` record observes.
- `suppressClaimableChatNotifications` terminalizes `pending`, `emitted`, and `emitted_unconfirmed` for one session/epoch while preserving `observed`. `suppressPendingChatNotifications` remains a compatibility wrapper.
- The disabled/re-enabled CLI sequence proves no historical receipt claim. The installed e2e fixture proves the copied repository hook forwards transactional block stdout in a disposable home.
- The lesson-delivery fixture now observes its nonce from role-validated assistant output instead of injected system context.
- Task 3 and Task 7 briefs were regenerated from the clarified tracked plan; `.superpowers/sdd/.gitignore` intentionally keeps generated briefs untracked.

### Verification

- Focused review regressions: 5 passed, 0 failed.
- `node --test test/cli.test.mjs test/store.test.mjs test/e2e-smoke.test.mjs`: 93 passed, 0 failed.
- `npm test`: 195 passed, 0 failed.
- `sh -n templates/hooks/stop-hook.sh templates/hooks/core-hook.sh`: exit code 0.
- `node --check src/cli.mjs`, `src/store.mjs`, and `src/capture.mjs`: exit code 0.
- `git diff --check`: exit code 0 before the implementation commit.
- Computer Use attempt against Codex: denied by host policy with `Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.`

### Lifecycle Boundary

- No install command targeted `/Users/sunxingda/.agent` during these review fixes.
- The current real user runtime remains stale relative to this branch: `/Users/sunxingda/.agent/feedback-loop/current.json` reports runtime `0.7.4`, schema `7`, status `configured_unverified`.
- Repository `templates/hooks/stop-hook.sh` SHA-256 is `e526eb635767851bddc5fc2174d4a1128afe51f4effd3187c8f91c33f9581fd0`; real installed hook SHA-256 is `fa72d35012bc5ee7793a4d7516e66eca6a9a95dfb7621b93ebe53f3ac1b216f2`.
- Task 7 must atomically replace the real `~/.agent` runtime after the complete package is assembled, verify version/schema and installed-template hashes, and prove transactional Stop stdout forwarding from that real installed runtime before claiming L1 acceptance.

### Scoped Final Review

- Codex receipt confirmation, role filtering, disabled-channel suppression, one-block/two-emission fencing, native JSON, zero-injection, and v2 controls passed independent review.
- A remaining Gemini-specific gap is known: native `AfterAgent` output arrives as `prompt_response`, while the confirmation path currently reads `last_assistant_message`. Per the vertical-first execution decision, Gemini expansion is paused until a real Codex main-chat receipt reaches `observed`.
- This report does not claim cross-host or real-user acceptance. The next step is an atomic `0.7.5` install and true Codex session evidence.

### First Real Install Finding

- Runtime `0.7.5` was installed to the real user home and the installed Stop hook hash matched the packaged template.
- A new ordinary Codex task (`019f65db-5414-77a1-a851-065a6e4a6123`) created no reviewer job, but incorrectly displayed a `lesson_delivered` receipt (`aee8c25f75b2d94d0956174a6740d18ff2092631ab8bc9484d53458db0eb5e37`).
- The receipt was observed, proving hook forwarding, but it violated the required ordinary-prompt zero-receipt baseline.
- `lesson_delivered` remains in the notification outbox for audit but now starts with `chat_state=suppressed`, so only feedback/review lifecycle states can claim the main-chat receipt channel.
