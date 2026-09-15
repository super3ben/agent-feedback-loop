# Agent Feedback Loop

Local prompt-time feedback learning and capability-bounded convergence control for
Codex, Claude Code, and Gemini CLI. [中文说明](README-zh.md)

**Runtime version: `0.9.0`**

## Feedback learning

1. A prompt hook captures eligible user dissatisfaction and immediately returns to
   the host.
2. A detached feedback reviewer may inspect bounded local evidence later.
3. A valid reviewer result becomes immutable project Markdown under
   `.agent/reflections/`.
4. A later matching prompt reads a small set of applicable Markdown documents.

The current prompt never waits for the feedback reviewer. Its publication cutoff is
fixed at prompt handling time, so a document published during that handling can
affect only a later matching prompt. The control SQLite database contains lifecycle
state, not lesson bodies. This is direct Markdown selection, not RAG.

### Natural-language dissatisfaction coverage

Recognizing dissatisfaction no longer requires a fixed negative keyword such as
"做错了" or "不合理". Three layers cover the gap between wordlists and judgment:

1. **Expanded wordlist routes.** Natural-language complaints — being asked to
   restate already-known information, frustration about a recurring problem, and
   rhetorical accountability ("how is this unknown again?") — are admitted for the
   detached full reviewer directly.
2. **LLM fallback classifier.** A message the wordlist misses but that carries an
   assistant referent goes to a detached binary classifier (`classify-feedback`),
   which answers reason-first and then `{"dissatisfied": true/false}`. Yes admits
   the job to the reviewer; no discards it. The classifier is told the agent's own
   excuse must not count as evidence the user is satisfied — a deflection ("连
   不通") cannot sway the verdict. Pure operation turns ("继续", "好的", "等等")
   skip the call entirely. Because the classifier runs per referent-backed
   prompt, codex invocations inject the same gateway routing the reviewer uses;
   without it every codex classification wedged until timeout.
3. **Deterministic escalation.** A reviewer that keeps declining the same
   recurring family — each time with a fresh excuse (post-hoc correction, "not
   deployed yet", prospective request) — no longer gets the last word: once a
   family has been declined 3+ times inside a 14-day window, the next decline is
   replaced by a synthesized Major lesson built from the accumulated decline
   summaries and published directly. A family that already has a published
   lesson is left to normal recurrence machinery instead of piling up duplicate
   meta-lessons.

   **DeepSeek Harness (`dsh`) coverage:** `install` ships a standalone native
   harness plugin (`dsh-plugin/`) and wires it into every profile under
   `~/.dsh/profiles/` (symlink, `link:` dependency, managed patch row) — no
   bridge package involved. The plugin feeds every prompt into `core-hook.sh`
   and injects the compiled rules context back into the harness. The harness
   exposes no transcript, so prompts from a dialect that cannot supply one go
   to the classifier instead of being silently dropped; prompts in sessions
   that can carry a transcript but have no referent yet (first turn) stay
   skipped. Reviewer and classifier subprocesses for dsh-sourced jobs run on a
   host CLI (claude, then codex, then gemini).

### From published lesson to later session

Publication is not delivery. Three channels carry a lesson forward:

- The reviewer contract treats the user's explicit statement of fact as a
  factual claim the agent must verify before contesting, and treats scope
  overreach as agent fault even when the agent later corrects it.
- Families that reach `Major+3` / `Critical+2` / `Blocker+1` occurrences are
  compiled into the managed block of `.agent/rules/feedback-loop.md`.
- The prompt hook injects that managed block into every prompt's context
  (bounded to 6 KB), so a rule that has recurred enough is seen each turn
  mechanically rather than depending on the model choosing to open the file.

### Reviewer provider environment

The detached reviewer runs the host CLI (`codex`, `claude`, or `gemini`) in a
scrubbed environment. Only `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`,
and `TZ`, plus any `AFL_REVIEW_*` variable, reach the reviewer process. A CLI that
authenticates from its own persistent credentials (for example `~/.codex/auth.json`
or a token in `~/.claude/settings.json`) works with no extra configuration, because
that state is loaded by the CLI itself rather than inherited from the shell. Only a
provider that authenticates purely through shell environment variables — such as an
`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` pair exported into the shell rather than
stored in the CLI's own config — needs those names passed through
`AGENT_FEEDBACK_LOOP_REVIEWER_ENV_ALLOWLIST` (a comma-separated allowlist whose value
must also list `AGENT_FEEDBACK_LOOP_REVIEWER_ENV_ALLOWLIST` and
`AGENT_FEEDBACK_LOOP_REVIEWER_TIMEOUT_MS` themselves so they survive into the detached
process). The per-review timeout defaults to 300000 ms and the claim lease scales
from it, so a big-evidence review that legitimately runs minutes is not cut off
mid-generation or discarded as lease-lost; raise it further with
`AGENT_FEEDBACK_LOOP_REVIEWER_TIMEOUT_MS` when a real provider needs longer.

## Convergence control

The convergence Probe is separate from the feedback reviewer. The reviewer decides
whether real user dissatisfaction justifies a reusable Markdown method. The Probe is
a bounded semantic adviser after a deterministic Convergence Breaker fires; its
advice cannot change the contract, raise importance, reset history, create a hard
gate, or issue a continuation grant.

The Breaker evaluates verified external facts such as unchanged-basis repeated
mutation, evidence-free work on the same invariant, oscillation, explicit exclusion
violations, unjustified architecture expansion, scope growth after acceptance, and
repeated formal review failure. `routine` tasks pause at the first verified
evidence-free expansion. `important` tasks may receive one falsifiable exploration
budget. `critical` tasks require new verified risk evidence for every generation;
they do not receive unlimited exploration.

Enforcement is limited by the adapter's real seam:

- SDD provides a `workflow_gate` at review/fix dispatch boundaries.
- Approved OpenSpec and Comet revisions provide a `checkpoint_gate` between tasks.
- Generic prompt observations are `audit_only` with warning as their maximum.

None of these claims generic real-time blocking of arbitrary tools; there is no
tool-level guard. There is no Stop/AfterAgent convergence hook, user-visible grant
or receipt, resident service, scheduler, database lesson body, or learning/RAG
reader.

Independent convergence-effectiveness to Markdown publication is deferred. It
requires a named workflow producer, a bounded evidence envelope, and an independently
approved learning-job authority and result contract. Today, the real-dissatisfaction
feedback reviewer remains the only automatic Markdown producer.

## Execution guard (retired)

A `PreToolUse` execution guard — a per-artifact rewrite counter with warn-then-block
escalation and a background direction review — was retired on 2026-08-31. It was
built for GPT-era runs that circle in review-then-improve loops; measured on live
sessions its false blocks cost more than the circling it caught. The `PreToolUse`
hooks are uninstalled from both hosts and the runtime dispatch is commented out in
`src/cli.mjs`, so even a reinstalled hook passes every call through. The store, hook
logic, and their tests remain in the tree; reviving means restoring that dispatch and
reinstalling the hooks.

## Install and diagnose

Node.js 24.15 or newer is required. Ask for authorization before a real global
installation or any change to a real HOME configuration.

```sh
npm install -g agent-feedback-loop
agent-feedback-loop install --dry-run
```

Use a temporary HOME first; this installs a disposable runtime and schema without
changing real user configuration:

```sh
tmp_home="$(mktemp -d)"
agent-feedback-loop install --home "$tmp_home"
agent-feedback-loop doctor --home "$tmp_home" --live
agent-feedback-loop uninstall --home "$tmp_home"
rm -rf "$tmp_home"
```

Installation copies package assets, selects the runtime, migrates the selected
control schema, and configures the prompt hooks. It does not register Stop/AfterAgent hooks,
import Guard state, activate Guard authority, cut over a repository, start a
service, or create a learning reader.

`doctor` returns `{ version, status }`. `status.ready` remains the prompt/Markdown
pipeline gate. `status.convergence` separately reports:

- code/package availability;
- selected installed runtime, schema, provider, Probe assets, and current-platform
  support;
- `audit_only`, `checkpoint_gate`, and `workflow_gate` adapter capabilities;
- repository authority as `unknown` unless a separate explicit repository-bound
  check proves it.

Package presence and a static doctor result are not proof of live provider success,
native Linux acceptance, real cutover, generic real-time blocking, or production
effectiveness.

## Guard migration and rollback

Repository identity initialization is a separate, explicitly authorized step. It
creates or reuses only the owner-private `afl-lineage-id` in the Git common directory;
it does not accept legacy state or HOME input and does not create an AFL control store,
import state, change authority, or modify hooks. Then inspect the legacy Guard state
without writing AFL or legacy state:

```sh
agent-feedback-loop lineage-init --repo-root "$PWD" --apply
agent-feedback-loop guard --repo-root "$PWD" import \
  --state-file .superpowers/sdd/review-loop-state.json --dry-run
```

The controlled sequence is explicit identity initialization, read-only dry-run,
explicitly authorized import, bounded shadow parity, explicitly authorized
per-repository cutover, and exact snapshot rollback.
Import, shadow, cutover, and rollback are explicit machine-readable commands; no
long-term dual write is used. Real import or cutover, global SDD Skill changes, and a
runtime canary each require separate user authorization. Installation never performs
them automatically.

The legacy export of feedback data remains explicit and source-read-only:

```sh
agent-feedback-loop legacy-export --source-db /absolute/legacy.sqlite3 \
  --output-dir /absolute/export --dry-run
agent-feedback-loop legacy-export --source-db /absolute/legacy.sqlite3 \
  --output-dir /absolute/export --apply
```

For prompt-hook rollback, inspect `agent-feedback-loop uninstall --dry-run`, then
run `uninstall` only with approval. It leaves hooks disabled while preserving durable
control data and keys unless the operator separately removes them.

## Evidence states

Code tests, package inventory, a temporary installed runtime, a repository Guard
dry-run, an authorized cutover canary, and production effectiveness are separate
evidence states. Passing an earlier state must not be reported as a later one.

Structured logs contain only fixed event names, bounded reason codes, counters, and
opaque identifiers or hashes. They do not contain raw prompts, diffs, reviewer or
Probe bodies, state bodies, tokens, grant artifact contents, or absolute project
paths.
