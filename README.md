# Agent Feedback Loop

Local prompt-time feedback learning for
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
   `~/.dsh/profiles/` the same way `dsh plugin add` does (node_modules symlink,
   `link:` dependency, `dsh.profile.bundles` registration) — no bridge package
   involved. The plugin feeds every prompt into `core-hook.sh`
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

#### The rules block is a projection, not an accumulating log

The managed block is rebuilt from store state on every publication and is held
under a fixed byte budget, so it cannot grow without bound and nobody has to
prune it. Three properties make that automatic:

- **Merge.** Families are merged when their rendered bodies are identical. The
  family id hashes the reviewer's free-text `family_key` alongside its method
  class, so the same lesson arrives under a new id whenever the reviewer
  phrases the key differently. One live project carried seven such duplicates,
  36.6% of its block.
- **Rank.** Surviving sections are ordered by severity, then occurrence count,
  then most recent recurrence. Without the third term a family hit 39 times
  months ago and never since outranks one hit five times this week.
- **Demote, never drop.** A family that does not fit the budget keeps a
  heading-only line, naming it and carrying its count. It is never deleted: it
  stays published, stays counted, and returns to full text automatically the
  moment it recurs and outranks something else.

The writer guarantees the block fits, which replaces a byte-slice the reader
used to apply at injection time. That slice cut mid-character and silently
dropped 44% of a live block — including five families that had qualified. An
over-budget block now means the file was written by an older version or edited
by hand; the reader then trims whole sections and logs how many it dropped.

`doctor` reports the block under `status.rulesBlock` with two separate flags:
`saturated` (the projection reached its ceiling — working as designed) and
`overBudget` (the file no longer matches what the writer produces). Neither
asks you to clean anything up.

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
control schema, and configures the prompt hooks. It does not register Stop/AfterAgent
hooks, start a service, or create a learning reader.

### DeepSeek Harness (`dsh`)

The dsh plugin is listed in the [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
marketplace (`memory` category): [entry](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/data/plugins/super3ben__agent-feedback-loop--templates-dsh-plugin.yml).

If a dsh home exists (`~/.dsh/profiles/`), `agent-feedback-loop install` also
wires the standalone native plugin into every harness profile: it copies the
plugin to `<packRoot>/dsh-plugin/`, links it into the profile's `node_modules`,
adds a `link:` dependency, and registers it in `dsh.profile.bundles` — the same
end state as `dsh plugin add`, and idempotent across reinstalls. The plugin is
activated by its own bundled patch layer; `install` never writes into the
profile's `cordis.patch.yml` (a manual row there collides with the bundle layer
on the loader entry id and the harness refuses to boot). Installs from before
bundle registration are migrated automatically: the managed patch row they
wrote is removed.

Restart the harness after installing so the running instance picks the plugin
up. The dsh home follows the install home (`~/.dsh` for the real user); pass
`--home` with a disposable directory to try the wiring without touching a real
profile.

`doctor` returns `{ version, status }`. `status.ready` remains the prompt/Markdown
pipeline gate.

Package presence and a static doctor result are not proof of live provider success
or production effectiveness.

## Reflection housekeeping

Two read-mostly commands manage the published reflections directory:

```sh
agent-feedback-loop reflections effectiveness --project /abs/project
agent-feedback-loop reflections archive --project /abs/project            # dry run
agent-feedback-loop reflections archive --project /abs/project --apply    # move files
```

`effectiveness` answers "is this lesson doing anything" from the delivery log and
the review history, and reports each family as `never_delivered`,
`recurred_after_delivery`, `too_early_to_tell`, or `quiet_since_delivery`. Its
output is labelled `causality: correlation_only`: a quiet family may mean the
lesson worked, or that the same kind of work never came up again. Do not read it
as proof of effect.

`archive` retires documents that are **both** older than `--after-days` (default
30) **and** have never been delivered to a session, moving them to
`reflections/archive/`. Delivered documents are left alone regardless of age. It
is a move, not a delete, and it defaults to a dry run.

## Legacy data export

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

Code tests, package inventory, a temporary installed runtime, and production
effectiveness are separate evidence states. Passing an earlier state must not be
reported as a later one.

Structured logs contain only fixed event names, bounded reason codes, counters, and
opaque identifiers or hashes. They do not contain raw prompts, diffs, reviewer
bodies, tokens, or absolute project paths.
