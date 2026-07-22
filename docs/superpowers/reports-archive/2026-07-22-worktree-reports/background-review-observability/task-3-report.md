# Task 3 Report

## Status

Implemented and accepted the Codex main-chat receipt vertical path with real Codex desktop tasks. Gemini native `prompt_response`, Claude/Gemini expansion, native system notifications, and the audit CLI remain explicitly outside this Task 3 scope.

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
- `README.md`
- `README-zh.md`
- `package.json`
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

## Pre-Install Concerns (Historical)

- UI-level Terminal/Codex inspection was unavailable because Computer Use denied those applications. This was later closed with the Codex app's native thread API and SQLite/runtime evidence rather than terminal emulation.
- At this point in the implementation history, the real `~/.agent` hook had not yet been replaced. The final acceptance evidence below supersedes this pre-install boundary.

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

### Historical Lifecycle Boundary

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

## 0.7.6 Real Codex Acceptance

### Installed Runtime

- Installed at `2026-07-15T13:38:26.568Z` under `/Users/sunxingda/.agent/feedback-loop/versions/0.7.6` with schema `8`.
- Source and installed `src/cli.mjs` SHA-256: `b70ede1fe65a3b3676c711185aed9c48d64192772d662ae6eb625ff2ef2ab0b2`.
- Source and installed core hook SHA-256: `bcc9003d269e9f4b9d1ac5f50dc7bcbe4c1ff37a67d83a0a66b3747eadb29dd2`.
- Source and installed Stop hook SHA-256: `e526eb635767851bddc5fc2174d4a1128afe51f4effd3187c8f91c33f9581fd0`.
- Computer Use against Codex was attempted and denied with `Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.` The real checks below therefore use the Codex desktop app's native task APIs plus the installed runtime's SQLite and logs.
- The app-bundled terminal CLI was also checked separately. Its interactive prompt produced no AFL SQLite event, so it is documented as a non-equivalent host and is not used as desktop acceptance evidence.

### Ordinary New Task: Zero Job And Zero Review Receipt

- Codex task/session: `019f660d-a384-7050-9f2b-1e1ff5d2d4e4`.
- Turns: `019f660d-a778-7810-978d-917d97f96658` and `019f660e-de0e-7313-936e-a26fa423a7f5`.
- Visible replies contained no `[AFL]` line.
- Before this new session: 0 session events, 0 reviewer jobs, and 0 review receipts for the session.
- After two ordinary top-level turns: 4 captured session events, 0 reviewer jobs, 0 review lifecycle receipts, and 0 observed review receipts.
- One `lesson_delivered` audit row exists with `chat_state=suppressed`; it was neither a review lifecycle receipt nor injected into the chat.

### New Task: Full Correction To Observed Chain

- Codex task/session: `019f6611-8925-7de0-954c-7fc2e47ee5a5`.
- Active turn: `019f6611-8b2b-7b92-8bd0-5a1b881442ef`.
- The assistant first emitted `开始等待。`; the user then corrected the still-running turn with `停止刚才的等待和旧路径...`.
- Captured correction event: `codex:default:019f6611-8925-7de0-954c-7fc2e47ee5a5:generated:mrm5arht:9e679518-b0a7-45ae-b080-c7700873a309`.
- Captured assistant referent event: `codex:default:019f6611-8925-7de0-954c-7fc2e47ee5a5:message:msg_06a3918aed255dd1016a5791d1e6f0819188b94245978d8281`.
- Reviewer job: `b196ca55f3f7f705f68b4d9e1c5c30a9956ff23a60ab50bf3593bfe1692dff8f`.
- Queue receipt notification: `328c344feef1473c7359a877c8dc7d595bd38ad85dba1b9dcad3eba612da6401`.
- The parent conversation visibly emitted `[AFL] 后台反思已排队 · job=b196ca · receipt=328c34` and the exact v2 marker. Stop changed the notification from `emitted` to `observed` at `2026-07-15T13:58:13.000Z` on the active turn.
- Runtime log records `signal=active_turn_steering immediate=1`, the notification creation/emission, reviewer start, Stop observation, and reviewer completion.
- Reviewer job events: `claimed` at `2026-07-15T13:58:09.395Z`, then `completed` at `2026-07-15T13:58:47.840Z`. Both assigned queue events changed to `acknowledged`.
- Terminal notification: `37c22d8599c51414b0f94a917c54e02f62c88daff8a519f499feafd6543b49f6` (`reviewed_no_lesson`).
- Follow-up turn: `019f6613-67d5-7ae3-8e5d-b83ef5fdc480`. The parent conversation visibly emitted `[AFL] 已复核，本次未形成长期经验 · job=b196ca · receipt=37c22d`; Stop marked it `observed` at `2026-07-15T13:59:38.626Z`.
- Final per-session counts: 6 captured events, 1 reviewer job, 2 review lifecycle receipts, and both receipts observed.

### Installation-Preexisting Long-Lived Task

- Codex task/session: `019f4063-223d-7b71-837c-6bab4fa49069`, created on 2026-07-08 before the 0.7.6 install.
- Before the hot-load check, terminal notification `ea028b1f5449d6ff167c599b2f7a3f1c995cdc719a3954e687dd25b8d9d90045` for completed job `e93408b42fb84ceca771b3c1b84222a32bff9567fb7ffd936bf7ad6811272f4c` was `pending`.
- A no-tool/no-file top-level follow-up created turn `019f6614-786b-76e0-9553-127f3984aa61` and visibly emitted `[AFL] 已复核，本次未形成长期经验 · job=e93408 · receipt=ea028b` in the parent conversation.
- Stop marked the notification `observed` at `2026-07-15T14:01:01.006Z` and captured the assistant reply in the same native turn.
- This proves the pre-install desktop task loaded the current user-level hook on its later turn; no restart was needed for this tested task. It does not claim that every currently running turn can replace an already-started hook process mid-turn.

### Trigger Boundary Observed During Acceptance

- Same-turn steering and a fresh prompt after `turn_aborted` are structural immediate-review signals. They create a job and queued receipt without invoking an LLM classifier on every ordinary prompt.
- A correction sent only after a prior turn has completed is captured but is not structurally immediate; it remains in the batch queue until the normal review threshold/age policy is due. This is intentional token control, but it is also a product boundary: completed-turn dissatisfaction does not currently receive an immediate queued receipt.
- Child-agent prompt/Stop payloads are bypassed before opening the store, so they cannot capture feedback, claim a parent receipt, or mark it observed. The regression tests for both child-agent boundaries passed in the 198-test suite.

### Final Scope Result

- Task 3 Codex vertical acceptance is complete: correction -> captured -> assigned queue -> detached reviewer -> parent-chat queue receipt -> Stop observed -> terminal parent-chat receipt -> Stop observed.
- Native system notifications, audit CLI, Claude/Gemini expansion, and a semantic immediate classifier for already-completed-turn dissatisfaction remain paused by scope and are not claimed here.

### Final Verification

- Three consecutive full-suite reruns completed with `198 passed, 0 failed`; the final TAP run exited 0 in `39.7s`.
- One earlier diagnostic TAP run reported `197 passed, 1 failed`, but its failing subtest was not retained by the tail-only command and the failure did not reproduce in the next three complete runs. This remains a recorded test-flake risk rather than being omitted from the acceptance record.
- `sh -n templates/hooks/core-hook.sh templates/hooks/stop-hook.sh templates/hooks/trigger-rules.sh`: exit 0.
- `node --check src/cli.mjs`: exit 0.
- `git diff --check`: exit 0 before the report-only final update.
- `npm pack --dry-run`: exit 0, package `agent-feedback-loop@0.7.6`, 32 files.
- Installed runtime, core hook, and Stop hook SHA-256 values match the tracked source files exactly.
- Independent scoped review found no remaining Critical or Important issue in the Task 3 parent-conversation boundary.

## Task 3 v2: Remove Stop, notification, reconcile, and conversation control (2026-07-20)

### Status

DONE_WITH_CONCERNS. Commit `7f1756d2b3fc0f1a332ca4c0b7501a4a48e70dc0`
(`refactor: remove the conversation control plane`) contains only the Task 3
owned `src/`, `templates/`, and `test/` files. This report remains uncommitted.

### RED evidence

- Required RED command:
  `node --test --test-name-pattern='fresh install is prompt-only|upgrade removes only the managed AFL Stop hook|CLI exposes no receipt or reconcile control plane' test/runtime.test.mjs test/cli.test.mjs test/e2e-smoke.test.mjs`
  exited 1 with 0 passed and 3 failed. The failures showed that fresh install
  still registered/copied Stop, upgrade re-added the AFL Stop command, and help
  still exposed reconcile/reconcile-daemon/reviewer-submit receipt control.
- The upgrade fixture was then extended to an unmarked legacy Codex AFL Stop
  block. Its focused RED exited 1 because that exact AFL path survived while the
  unrelated user Stop was present. After the minimal cleanup change, the same
  focused test passed 1/1 and the user Stop remained byte-identical in meaning.

### GREEN and static evidence

- Required focused suite:
  `node --test test/runtime.test.mjs test/cli.test.mjs test/e2e-smoke.test.mjs test/codex-host.test.mjs`
  exited 0 with 27 passed, 0 failed in 5.85s on the final pre-commit run.
- Required static gate:
  `rg -n 'notification_deliver|afl-receipt|hookPrompt|capture-stop|reconcile-daemon|memory_maintenance|feedback_episode' src/cli.mjs src/index.mjs templates/hooks test/runtime.test.mjs test/cli.test.mjs test/e2e-smoke.test.mjs`
  produced no output and exited 1, the expected no-match result.
- `node --check` passed for `src/index.mjs`, `src/cli.mjs`,
  `src/codex-host.mjs`, and all four modified focused test files; `sh -n
  templates/hooks/core-hook.sh` and `git diff --check` also exited 0.
- One intermediate full focused run had 1 fake Codex app-server timeout and 26
  passes. The fixture exceeded its test-only 2s RPC deadline under parallel
  load (2.087s); raising only that fake-host deadline to the existing 8s host
  test budget produced the final 27/27 result.

### Removed and retained boundaries

- Deleted the Stop wrapper, trigger rules, notification delivery, reconcile
  scheduler/transcript runtime, and their three dedicated test files. No
  disabled imports, command branches, scheduler paths, or Stop paths remain.
- Fresh Codex/Claude/Gemini managed config contains only the native prompt event.
  Upgrade removes marked and unmarked AFL-owned Stop/AfterAgent commands while
  preserving unrelated user Stop/AfterAgent entries.
- `pathsFor()` no longer exposes Stop/reconcile runtime paths. Install,
  uninstall, doctor, Codex hook inspection, and trust synchronization depend on
  the prompt hook alone. Doctor exposes prompt hook, control-store, reflection
  directory, reviewer-provider, and legacy-Stop-removal state without scheduler
  or reconciliation health.
- `core-hook.sh` reads stdin once, calls the stable launcher without `exec`,
  copies successful output verbatim, suppresses launcher diagnostics, and maps
  failure to exact `{}` or `{"continue":true}` host no-ops.
- The transitional CLI `hook` entry is intentionally a prompt-only bounded
  no-op until Task 5 replaces orchestration. Legacy `store.mjs`, `schema.mjs`,
  and `receipt.mjs` remain isolated and untouched for Task 13. No detector,
  launcher, Markdown selector, RAG, or Task 4+ behavior was implemented early.

### Verification boundary and risk signals

- Evidence is macOS real Node/shell execution against disposable HOME/control
  databases and temporary fake host processes. No real installation, global
  hook restoration, real runtime/config/database mutation, Codex UI callback,
  Linux host, or production/field acceptance was performed or claimed.
- `task-1-report.md` and `task-2-report.md` retained their starting SHA-256
  values (`b8c92c...14761` and `ec20e5...166b`) and were not included in the
  commit.
- The prompt hook is deliberately non-learning during this transition; the
  immediate detector/spawn/document-selection value remains gated on Tasks
  4-10. This is expected sequencing, but it is the principal product risk until
  those tasks land.

## Task 3 v2 Frozen Review-Fix 1: Mixed Codex Handlers and Legacy LaunchAgent Cleanup

### Status and commit

DONE_WITH_CONCERNS. Commit `d96e77e` (`fix: preserve user hooks during legacy
cleanup`) contains exactly `src/index.mjs` and `test/cli.test.mjs`. This report
append remains uncommitted as required.

### RED evidence

- I1 focused RED:
  `node --test --test-name-pattern='upgrade removes only managed AFL handlers from mixed Codex parents' test/cli.test.mjs`
  exited 1 with 0 passed and 1 failed. The marked mixed parent lost its
  `matcher = "marked-stop-parent"` field and unrelated user sibling handler.
- I2 focused RED:
  `node --test --test-name-pattern='upgrade and uninstall remove the legacy LaunchAgent with bounded fake bootout' test/cli.test.mjs`
  exited 1 with 0 passed and 1 failed because the legacy plist remained after
  cleanup.
- During self-review, a user-handler comment mentioning the old
  `stop-hook.sh` path produced another focused RED: the mixed parent and user
  handler were deleted. Managed ownership was therefore tightened to exact
  `command =` and `prompt =` assignment values rather than arbitrary path text
  anywhere in a TOML block.

### GREEN and verification evidence

- Combined focused GREEN:
  `node --test --test-name-pattern='upgrade removes only managed AFL handlers from mixed Codex parents|upgrade and uninstall remove the legacy LaunchAgent with bounded fake bootout' test/cli.test.mjs`
  exited 0 with 2 passed and 0 failed.
- Full Task 3 suite:
  `node --test test/runtime.test.mjs test/cli.test.mjs test/e2e-smoke.test.mjs test/codex-host.test.mjs`
  exited 0 with 28 passed and 0 failed.
- The required static `rg` control-plane gate produced no output and exited 1,
  the expected no-match result.
- `node --check src/index.mjs`, `node --check test/cli.test.mjs`, `sh -n
  templates/hooks/core-hook.sh`, `git diff --check`, and the exact two-file
  code-scope check all passed before commit.

### Behavior and scope

- Legacy Codex cleanup now removes only AFL-owned nested handler blocks and
  marker lines. It preserves mixed-parent matcher/options, unrelated sibling
  handlers, comments, root values, and unrelated TOML tables; a parent is
  removed only when no handler remains after managed removal.
- Install and uninstall perform private, bounded, best-effort cleanup of the
  exact legacy macOS LaunchAgent label and plist. Dry-run does neither. The
  legacy scheduler is not restored to public paths, health, help, or CLI APIs.
- The committed diff contains only the two frozen-scope files. Task 1 and Task
  2 reports retain their starting SHA-256 values
  (`b8c92ca0e960011d863be08c78ed2feccf1439eea3b5398ea28796839aa14761`
  and `ec20e5880976e9a4037b1c4699eec738bd93fd6d4d967c1335e42f006995166b`).

### Verification boundary

- Verification used macOS Node/shell execution, disposable temporary HOME
  state, and an injected fake bootout host. No real `launchctl`, real install,
  global hook mutation, Codex UI callback, Linux host, or production/field
  acceptance was exercised or claimed.
