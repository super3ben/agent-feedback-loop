# Agent Feedback Loop

<p align="center">
  <img src="assets/hero.svg" alt="Agent Feedback Loop overview" width="100%" />
</p>

Local, severity-aware feedback memory for **Codex**, **Claude Code**, and
**Gemini CLI**. [中文说明](README-zh.md)

**Current repository version: `0.7.0`**

The plugin captures bounded conversation evidence, reviews retrospective user
feedback in the background, compiles proven agent faults into scoped action cards,
and injects only relevant cards into later work. Normal turns perform local SQLite
reads/writes only: no per-turn classifier and no token-count API request.

## Closed Loop

```text
prompt/stop hooks
  -> normalized user + assistant evidence (encrypted raw, redacted index)
  -> delayed reviewer job (once-per-job wake + lease)
  -> background reviewer (prompt delegation or isolated CLI process)
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
upgrade or uninstall.

## Reviewer Modes

### Prompt delegation (zero configuration)

All three supported CLIs expose a model-visible prompt hook. When a batch becomes
due, the hook asks the active host exactly once to create a real background subagent.
The main conversation may submit the resulting receipt, but must not perform the
full reflection. If the host exposes no subagent tool, the job remains pending and
reports `reviewer_unavailable`; there is no main-agent fallback.

This mode is usable out of the box. Its assurance is deliberately reported as
`delegated_unattested`: the runtime can validate a one-time, replay-resistant receipt,
but a shell hook cannot cryptographically prove that a claimed id came from the
host's native subagent scheduler.

### Short-lived reviewer command (optional process boundary)

`AGENT_FEEDBACK_LOOP_REVIEWER_COMMAND` is not a missing dependency. It is an optional
executable used when an operator wants a detached reviewer process instead of prompt
delegation. The process receives:

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
  audit/memory layer after transcript evidence expires.
- Reports and transcripts are never injected into ordinary turns. Only complete,
  compact action cards are selectable.
- Minor is never loaded. Major requires exact task/path/tool/signal relevance.
  Critical and Blocker are loaded within their applicable project scope and context
  epoch.
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
  reviewer-receipts/                  # atomic prompt-delegation handoff
~/.agent/feedback-loop-keys/          # mode 0700; fallback key mode 0600
```

Prompt-created receipts must be regular, current-user-owned `0600` files with
`write_complete=true`, a real background agent id, and a valid one-time capability.
Capabilities expire, are hashed at rest, and are consumed in the completion
transaction. Context and receipt text are treated as untrusted evidence.

## Commands

```bash
agent-feedback-loop install [--dry-run] [--home <path>]
agent-feedback-loop doctor [--live] [--home <path>]
agent-feedback-loop paths
agent-feedback-loop capture status|on|off
agent-feedback-loop memory list [project-id]
agent-feedback-loop memory promote <lesson-id> [project-id]
agent-feedback-loop gc status|run
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
AGENT_FEEDBACK_LOOP_RETENTION_DAYS           default 10
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
- Prompt delegation can require a native subagent but cannot attest its platform
  identity. A configured command is only a short-lived same-user process unless the
  operator places that command inside a real sandbox/container.
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

The `0.7.0` implementation is covered by 89 automated tests, including a three-turn
end-to-end case that captures feedback, commits a verified lesson, and injects that
lesson into the next matching task. Run the suite locally instead of relying on this
count as a permanent badge; the count will change as coverage grows.

## License

MIT
