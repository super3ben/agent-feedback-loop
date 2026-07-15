# Agent Feedback Loop

<p align="center">
  <img src="assets/hero.svg" alt="Agent Feedback Loop overview" width="100%" />
</p>

Local, severity-aware feedback memory for **Codex**, **Claude Code**, and
**Gemini CLI**. [中文说明](README-zh.md)

**Current repository version: `0.7.5`**

The plugin captures bounded conversation evidence, reviews retrospective user
feedback in the background, compiles proven agent faults into scoped action cards,
and injects only relevant cards into later work. Normal turns perform local SQLite
reads/writes only: no per-turn classifier and no token-count API request.

## Closed Loop

```text
prompt/stop hooks
  -> normalized user + assistant evidence (encrypted raw, redacted index)
  -> delayed reviewer job (once-per-job wake + lease)
  -> short-lived isolated CLI reviewer (Codex / Claude / Gemini / override)
  -> authenticated structured receipt
  -> report + lesson revision + active projection in one transaction
  -> local severity/scope selector
  -> application + delivery observation receipt
  -> recurrence effectiveness audit
```

Completion is not a Markdown file or a hidden conversation marker. A review is
complete only when the store transaction persists the report and lesson state,
acknowledges the queued evidence, and consumes the reviewer authority.

## Install

Requirements:

- Node.js 24.15 or newer (the durable backend uses `node:sqlite`)
- Codex, Claude Code, and/or Gemini CLI

Install the current GitHub version:

```bash
npm install -g github:super3ben/agent-feedback-loop#main
agent-feedback-loop install
agent-feedback-loop doctor --live
```

Install the latest version already published to npm:

```bash
npm install -g agent-feedback-loop
agent-feedback-loop install
agent-feedback-loop doctor --live
```

The npm registry can lag behind this repository. `doctor --live` reports both the
selected runtime version and schema version, so verify those values before debugging
hook behavior after an upgrade.

`install` backs up and updates the supported CLI configuration files, installs one
shared prompt hook and one shared Stop/AfterAgent hook, and preserves user data on
upgrade or uninstall. On macOS it also installs a lightweight `KeepAlive` LaunchAgent
daemon. The daemon starts one bounded reconciliation child every 60 seconds, waits
for it to finish, and performs no model call unless a review is actually due. This
process structure avoids relying on one-shot `StartInterval` delivery.

For Codex, writing a hook into `config.toml` is not enough: unmanaged hooks run only
after their exact current definition is trusted. The installer therefore asks a
newly spawned local Codex `app-server` for `hooks/list`, approves only the two commands it just
generated, writes their current hashes through `config/batchWrite`, and verifies
them again. Identity includes the exact cwd, user `config.toml`, source, event name,
handler type, and command; unrelated or lookalike hooks are never approved. An
RPC/configuration failure after that inspector has initialized is not hidden by
falling back to another CLI binary. This does **not** prove that an already-running
Desktop task reloaded the hook: `doctor` reports `inspectionScope=spawned_app_server`
and `activeDesktopState=not_observed`, while transcript reconciliation catches up
those tasks. `doctor` reports `configured` and `runnable` separately; `modified`,
`untrusted`, `disabled`, or an unavailable inspector is unhealthy even when paths
are present. Set
`AGENT_FEEDBACK_LOOP_CODEX_COMMAND` only when an explicit host binary is required.

Prompt hooks use a five-second native timeout on Codex/Claude and 5000 ms on Gemini.
This is a failure ceiling for local encrypted evidence and SQLite work, not a delay
added to every turn; hook failures remain fail-open and are written to the local
runtime log.

## When Review Triggers

- Ordinary prompts are captured locally with zero model tokens. A review becomes due
  at three pending entries by default, or when the oldest entry reaches the configured
  maximum age.
- A new prompt immediately following an interrupted prior turn is elevated to an
  immediate review candidate. This uses the host transcript lifecycle event
  (`turn_aborted`) within a 15-minute freshness window, not Chinese/English complaint
  keywords and not an LLM classifier.
- If Codex receives another real user message in an active turn after assistant
  output, that message becomes a structural steering candidate. This deliberately
  favors recall; it is not yet a verdict that the user was dissatisfied. Additive
  user messages sent before any assistant output are captured but do not use the
  immediate path. Before the reviewer can start, the latest visible assistant
  message from that turn is durably captured as the referent; the correction can
  never consume its job first and leave the reviewer with prompt-only evidence. The
  same turn receives only a compact correction checkpoint: apply the user's correction
  and stop the superseded path. The full review remains invisible and runs in the
  detached reviewer process.
- A 60-second incremental reconciler catches active Codex tasks whose hook was
  missed during an upgrade/reload race. Native message ids are preferred; stable
  byte offsets are used otherwise. Hook and transcript observations alias to one
  canonical event without collapsing repeated same-text messages. If Codex has
  already compacted those messages out of ordinary `response_item` records, the
  parser accepts only structurally identified `compacted` records up to 8 MiB and
  recovers at most the latest 24 real user messages from `replacement_history`.
  Control/system records are excluded and the full compacted history is never
  injected into a reviewer.
- Multiple immediate corrections found for one project in a single pass are
  persisted first and coalesced into one reviewer job, so historical catch-up does
  not spend one model call per correction. Transcript cursors keep structural
  turn/id/offset state only and never retain conversation text.
- The immediate event is transactionally guaranteed to be in reviewer context and
  bypasses the normal project review cooldown. An unprompted bounded job is reused by
  displacing its oldest assigned event without deleting that evidence. If the prior
  job was already prompted or is running, a fresh immediate job is created so a
  reviewer that already read context cannot miss the correction. A host-provided
  event id remains idempotent; when the host provides no event id, each hook call is
  treated as a distinct occurrence so two identical same-turn messages are not lost.
- Each reconciliation pass also requeues expired reviewer leases and retryable
  failures without requiring a new user message. After three attempts by default,
  the job becomes `retry_exhausted` instead of looping forever. A completion receipt
  must include a non-empty substantive report; an empty or marker-only response does
  not clear evidence.
- A first ordinary prompt does not trigger. An older interruption followed by a
  completed turn does not trigger the fast path. The background reviewer still decides
  whether the candidate is real retrospective feedback; prospective requests are not
  promoted into lessons.

Codex receives both hook capture and macOS transcript reconciliation. Claude Code
and Gemini CLI use their native prompt/stop hooks for newly launched sessions after
installation; this release does not claim Codex-style historical transcript catch-up
for those hosts. On non-macOS systems hooks still work, but there is no bundled
scheduled transcript reconciler yet.

## Reviewer Modes

### Built-in isolated providers (zero configuration)

When a batch becomes due, the hook starts a detached `reviewer-run` process and
returns immediately. It auto-selects the originating Codex, Claude Code, or Gemini
CLI in headless mode, receives evidence through a bounded `0600` file, returns one
schema-validated receipt, and exits. The main conversation receives no reflection
instruction, does not wait, and never writes the report. If the provider executable
is unavailable, the job remains pending and logs `reviewer_unavailable`; there is
no main-agent fallback.

Codex runs ephemerally with user hooks/rules disabled and read-only sandbox mode;
Claude runs non-persistent with tools disabled; Gemini runs with an explicit
admin-tier deny-all policy and hooks/skills/extensions disabled. These are provider controls plus process
lifecycle isolation, not an OS or network sandbox.

`doctor` reports hook configuration, hook runnability, reviewer availability,
scheduler state, and reconciliation freshness separately. In real-home macOS mode,
healthy requires a running scheduler, a successful reconciliation no older than five
minutes, and at least one operational reviewer provider. Missing optional providers
are reported as degraded instead of being hidden by another available CLI. A
`completed_with_errors` pass is diagnostic evidence, not success, and therefore
cannot satisfy real-home health even when the scheduler process is alive.

### Short-lived reviewer command (optional process boundary)

`AGENT_FEEDBACK_LOOP_REVIEWER_COMMAND` is not a missing dependency. It optionally
replaces the selected built-in provider with an operator-owned executable. The
process receives:

```text
AFL_REVIEW_JOB_ID
AFL_REVIEW_CONTEXT_FILE   # bounded redacted JSON, mode 0600
AFL_REVIEW_PROMPT_FILE
AFL_REVIEW_SUBMIT_PROTOCOL=stdout_json_receipt
```

It prints one structured JSON receipt to stdout and exits. Configure arguments with
`AGENT_FEEDBACK_LOOP_REVIEWER_ARGS_JSON` and timeout with
`AGENT_FEEDBACK_LOOP_REVIEWER_TIMEOUT_MS`. The child receives a scrubbed environment;
additional variables require an explicit comma-separated
`AGENT_FEEDBACK_LOOP_REVIEWER_ENV_ALLOWLIST`.

This mode isolates lifecycle and stdout handoff only. It is still a same-user process
with ordinary filesystem and network access, not an OS sandbox. Use an operator-owned
sandbox/container as the configured command when that stronger boundary is required.

## Reflection Quality

Feedback must be retrospective and quote both the user complaint and the prior agent
referent. Prospective task constraints and corrections inside an agent-requested
draft review are skipped. The reviewer defaults to Chinese unless the user selected
another language.

Depth is field-driven, not word-count-driven:

| Severity | Persisted behavior |
| --- | --- |
| Minor | Trend/report only; never becomes an active lesson |
| Major | 5-Why process cause, method class, complete action card |
| Critical | Major fields plus decision timeline, counterfactual checkpoint, and recurrence audit |
| Blocker | Critical fields plus impact, stop condition, rollback/isolation, and promotion evidence |

An applicable lesson that recurs must bind its effectiveness audit to the real
application/delivery receipt. `emitted_unconfirmed` is not treated as proof that the
model observed the lesson; it remains eligible for re-emission and late nonce
confirmation.

## Long-Term Memory Without Context Bloat

- Raw evidence is encrypted locally and retained for 10 days by default. Pending
  review sessions (including nearby assistant referents) are not deleted by retention
  GC. Compact review receipts, reports, incidents, and lessons remain as the durable
  audit/memory layer after transcript evidence expires. Incremental cursor state
  contains no user or assistant transcript text.
- Reports and transcripts are never injected into ordinary turns. Only complete,
  compact action cards are selectable.
- Minor is never loaded. Major requires task/path relevance, an explicit scoped
  signal/tool mention, or a stronger local phrase overlap with the card's `when`
  trigger; one generic CJK word is insufficient. Missing host metadata is
  unknown, not a mismatch; a known conflicting value still excludes the card. A
  lesson produced from the current task is eligible once on its next prompt, including
  a bare `continue`. Critical and Blocker are loaded within their applicable project
  scope and context epoch.
- Token cost is estimated locally with a conservative CJK-aware estimator. Budgets
  are calibrated from whole cards; cards are never cut mid-field. Oversized Major
  cards are skipped whole, while severe overflow creates an explicit checkpoint hold.
- Project and promoted global copies of one lesson family are deduplicated.
- Global promotion requires Blocker + agent fault + generalizable evidence from at
  least two independent repository lineages.

Vector search is intentionally optional. Structured scope and receipts are the
correctness boundary. An embedding backend may later improve candidate recall for a
large memory corpus, but it must not decide severity, promotion, or whether a lesson
was delivered. The current release does not require or ship a vector database.

## Security And Storage

```text
~/.agent/feedback-loop/              # versioned runtime and editable prompt pack
~/.agent/feedback-loop-data/
  store/feedback-loop.sqlite3        # transactional index and receipts
  blobs/sha256/                       # AES-GCM encrypted raw evidence
  reviewer-contexts/                  # short-lived 0600 context files
  logs/reconcile.log                  # scheduler/reconciliation diagnostics
~/.agent/feedback-loop-keys/          # mode 0700; fallback key mode 0600
```

Legacy prompt-created receipts must be regular, current-user-owned `0600` files with
`write_complete=true`, a real background agent id, and a valid one-time capability.
Capabilities expire, are hashed at rest, and are consumed in the completion
transaction. Context and receipt text are treated as untrusted evidence.
Credential assignments such as `password=...`, English `password is ...`, and
Chinese `密码是...` are removed from the searchable index and logs. In credential
reminder context, mixed credential-like tokens are redacted as well, so phrasing such
as "already shared" does not leave the value searchable. Raw evidence stays encrypted
under the configured retention policy; host-owned transcripts remain the host's
responsibility.

Managed runtime and reconciliation logs rotate at 5 MiB by default and never include
raw prompt/report bodies. Immediate hook outcomes and detached reviewer lifecycle
transitions include timestamps and job ids. `memory explain <session-id>` separates
delivery of lessons produced by that session (`emitted/observed`) from pre-existing
lessons delivered into it (`delivered_into_session/observed_in_session`), without
returning event text.

## Commands

```bash
agent-feedback-loop install [--dry-run] [--home <path>]
agent-feedback-loop doctor [--live] [--home <path>]
agent-feedback-loop paths
agent-feedback-loop capture status|on|off
agent-feedback-loop memory list [project-id]
agent-feedback-loop memory explain <session-id> [--verbose]
agent-feedback-loop memory promote <lesson-id> [project-id]
agent-feedback-loop gc status|run
agent-feedback-loop reconcile [--home <path>]
agent-feedback-loop reviewer-context --job-id <id>
agent-feedback-loop reviewer-submit --job-id <id> --receipt-file <path>
agent-feedback-loop uninstall [--remove-files]
```

Useful settings:

```text
AGENT_FEEDBACK_LOOP_REVIEW_MIN_ENTRIES       default 3
AGENT_FEEDBACK_LOOP_REVIEW_BATCH_MAX         default 24
AGENT_FEEDBACK_LOOP_REVIEW_MAX_AGE           default 3600 seconds
AGENT_FEEDBACK_LOOP_REVIEW_COOLDOWN          default 900 seconds
AGENT_FEEDBACK_LOOP_REVIEW_WAKE_COOLDOWN     default 300 seconds
AGENT_FEEDBACK_LOOP_INTERRUPTION_WINDOW      default 900 seconds
AGENT_FEEDBACK_LOOP_RECONCILE_LOOKBACK       default 900 seconds
AGENT_FEEDBACK_LOOP_RECONCILE_INTERVAL       default 60 seconds (minimum 30)
AGENT_FEEDBACK_LOOP_RECONCILE_KILL_GRACE_MS  default 2000 milliseconds
AGENT_FEEDBACK_LOOP_REVIEW_MAX_ATTEMPTS      default 3
AGENT_FEEDBACK_LOOP_RETENTION_DAYS           default 10
AGENT_FEEDBACK_LOOP_MAX_LOG_BYTES            default 5242880
AGENT_FEEDBACK_LOOP_MEMORY_BUDGET             optional absolute local override
AGENT_FEEDBACK_LOOP_DEBUG=1                   operational transition logs on stderr
AGENT_FEEDBACK_LOOP_LOG=<path>                default data/logs/runtime.log (0600)
AGENT_FEEDBACK_LOOP_REVIEWER_ENV_ALLOWLIST     optional names passed to reviewer
```

The JSONL queue/backstop remains only for explicit compatibility via
`AGENT_FEEDBACK_LOOP_QUEUE_DIR` or `AGENT_FEEDBACK_LOOP_LEGACY_QUEUE=1`. It is not
written in parallel with the SQLite runtime.

## Honest Boundaries

- JavaScript does not call an LLM. A reviewer is invoked only when a batch is due.
- The built-in reviewer is a short-lived same-user process, not a security boundary
  against the provider itself. Use an operator-owned sandbox/container override when
  stronger isolation is required.
- A spawned Codex app-server can validate persisted hook configuration but cannot
  certify hook state inside an already-running Desktop task. Reconciliation closes
  the evidence gap; it does not pretend to hot-reload that process.
- Prompt-only hosts cannot claim a hard tool gate. Severe overflow produces a
  checkpoint hold, not a false claim that dangerous calls are technically blocked.
- The plugin deletes only its own managed evidence; it does not delete host CLI
  transcripts, OS backups, or user exports.

## Development

```bash
npm test
npm pack --dry-run
node ./bin/agent-feedback-loop.mjs install --home /tmp/afl-home
node ./bin/agent-feedback-loop.mjs doctor --home /tmp/afl-home --live
```

The suite includes a three-turn end-to-end lesson case, exact Codex trust-scope tests,
modified-hook health checks, same-turn steering controls, hook/transcript race
deduplication, bounded compaction recovery, referent-before-review ordering, reviewer
lease recovery, scheduler liveness and forced child cleanup, strict degraded-health
checks, timeout-unit checks, and credential-redaction regressions. Run it locally
instead of relying on a static test-count badge.

## License

MIT
