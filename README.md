# Agent Feedback Loop

Local prompt-time feedback learning for
Codex, Claude Code, and Gemini CLI. [中文说明](README-zh.md)

**Runtime version: `0.10.0`**

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
- The prompt hook injects that managed block into every prompt's context, so a
  rule that has recurred enough is seen each turn mechanically rather than
  depending on the model choosing to open the file. The block is layered, and
  only part of it is injected — see below.

#### The rules block is layered: index always, instructions on demand

The block holds two layers, and the file is deliberately allowed to be larger
than any single injection:

- **L0 — the index.** One line per family (`- family-key (N×)`), always
  injected. Its job is to guarantee nothing is ever invisible: every family this
  project has learned about is named on every turn, at roughly 40 bytes each.
- **L1 — the instructions.** The full text for each family: when it applies, what
  the incident was, and what to do differently. Only the sections the current
  prompt actually touches are injected, at most two per turn.
- **L2 — the reflection document.** The complete incident, under
  `.agent/reflections/`. Never injected; it is where a reader goes when L1 is not
  enough.

Measured on a live project, the previous flat design saturated one 6 KB block at
97%, demoted 12 of 16 families to a one-line heading with no instruction at all,
and still showed the same 6 KB to every turn regardless of what was asked. The
file now carries every family in full (17 KB) while a typical injection is
2–5 KB, and an ordinary turn that matches nothing costs about 800 bytes.

#### When a lesson is injected at all

L1 is gated on what the user is doing, not on whether the words look similar:

- **Shown when the user reports a problem or objects** — 「今天的日报没有发出去」,
  「你这个详细设计也太简单了」, 「之前密码不是给你了怎么又问我」. A lesson records a
  problem that was reported before, so this is its moment.
- **Held back for ordinary instructions** — 「把这个汇总报告存到 docs/ 下」,
  「继续做审美的也一样做完」. No lesson applies however many words overlap.

The distinction matters because lexical similarity cannot make it. Measured on
real messages, 「之前密码不是给你了怎么又问我」 and 「继续做审美的也一样做完」 scored
identically (2.4), and every threshold on the score traded one error for the
other, topping out at 15/21. Gating on the user's intent instead scores 39/40 on
40 real user messages. Holding back is cheap: L0 still names every family, and
the saved 2 KB would have been an instruction that did not apply.

Both channels obey the same gate — the layered block and the reflection-document
selector. Before that, gating only the block left the selector shipping two
unrelated documents (3 KB) on an ordinary instruction.

#### The rules block is a projection, not an accumulating log

The managed block is rebuilt from store state on every publication, so it cannot
grow without bound and nobody has to prune it. Four properties make that
automatic:

- **Merge.** Families are merged when their rendered bodies are identical. The
  family id hashes the reviewer's free-text `family_key` alongside its method
  class, so the same lesson arrives under a new id whenever the reviewer
  phrases the key differently. One live project carried seven such duplicates,
  36.6% of its block.
- **Merge on the incident, not the template.** Escalated families all carry the
  same `method_class` literal and the same boilerplate prose, so keying the merge
  on those collapsed seven unrelated problems into one section whose text
  described the review process rather than any of the seven. They are keyed on
  the user's own complaint instead.
- **Rank.** Families are ordered by severity, then occurrence count, then most
  recent recurrence. Without the third term a family hit 39 times months ago and
  never since outranks one hit five times this week.
- **Union the trigger conditions.** A family that recurs gets a new document per
  incident, and each records the words of the complaint it came from. Reading
  only the newest threw the rest away: one family had six documents, and the
  phrase users actually type lived in the oldest. All published documents for a
  family now contribute conditions.

#### What each turn actually received is recorded

Every injection writes a telemetry row — which families were expanded, at what
score, how many bytes went out, and why the gate did or did not open
(`not_a_problem`, `no_match`, `no_distinctive_term`). Reading it:

```bash
sqlite3 ~/.agent/feedback-loop-data/store/control.sqlite3 \
  "select value from store_meta where key like 'injection_telemetry:%' order by rowid desc limit 5;"
```

This exists because every previous change to the selection logic had to be judged
on a hand-labelled corpus, and that corpus turned out to contain 11 of 47 rows
whose text appears verbatim inside the documents being searched — the measurement
flattered itself by about 17 points, and no smaller difference was distinguishable
from noise. Real traffic is the only place the answer exists.

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

The message the plugin injects carries a `source` whose `kind` must be a
producer-owned kind — `plugin:<package>` — not the retired
`{ kind: "plugin", plugin }` wrapper. DSH's durable session format owns that
syntax: format v4 rejects the wrapper during row admission
(`format v4 message requires a producer-owned source kind`), and the throw ends
the whole turn, so the user sees a failed turn with no assistant message at all.
The plugin reads the session's format version and emits the matching shape, and
falls back to the v4 form when the version is absent — guessing "old" recreates
the failure, while guessing "new" at worst emits a kind a v3 log tolerates.

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
