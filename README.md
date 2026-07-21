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

None of these claims generic real-time blocking of arbitrary tools. There is no
Stop/AfterAgent convergence hook, user-visible grant or receipt, resident service,
scheduler, database lesson body, or learning/RAG reader.

Independent convergence-effectiveness to Markdown publication is deferred. It
requires a named workflow producer, a bounded evidence envelope, and an independently
approved learning-job authority and result contract. Today, the real-dissatisfaction
feedback reviewer remains the only automatic Markdown producer.

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
control schema, and configures only the existing prompt hooks. It does not register
Stop/AfterAgent hooks, import Guard state, activate Guard authority, cut over a
repository, start a service, or create a learning reader.

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

Inspect a repository's legacy Guard state without writing AFL or legacy state:

```sh
agent-feedback-loop guard --repo-root "$PWD" import \
  --state-file .superpowers/sdd/review-loop-state.json --dry-run
```

The controlled sequence is dry-run, explicitly authorized import, bounded shadow
parity, explicitly authorized per-repository cutover, and exact snapshot rollback.
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
