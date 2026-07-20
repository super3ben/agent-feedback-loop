# Agent Feedback Loop

Local prompt-time feedback capture for Codex, Claude Code, and Gemini CLI.
[中文说明](README-zh.md)

**Runtime version: `0.8.0`**

## What runs

1. A prompt hook captures eligible feedback and immediately returns to the host.
2. A detached reviewer may inspect the bounded local context later.
3. A valid result becomes immutable project Markdown under `.agent/reflections/`.
4. A later matching prompt selects a small applicable document.

The current prompt never waits for the reviewer. Its selection cutoff is taken at
prompt handling time, so even a document published during that handling can affect
only a later matching prompt. The control SQLite database contains lifecycle state;
the immutable Markdown is the reflection document. This is direct Markdown
selection, not RAG.

There is no Stop/AfterAgent hook, session receipt, status output, RAG service, or
resident scheduler. Prompt diagnostics are opt-in with
`AGENT_FEEDBACK_LOOP_DEBUG=1`; reviewer terminal diagnostics are JSONL on stderr.

macOS and Linux are supported installation targets. This document does not claim
live provider, desktop, or Linux acceptance evidence for a particular environment.

## Install and verify

Node.js 24.15 or newer is required. Ask for authorization before a real global
installation or any change to a real HOME configuration.

```sh
npm install -g agent-feedback-loop
agent-feedback-loop install --dry-run
```

Use a temporary HOME first; this exercises only disposable configuration and data:

```sh
tmp_home="$(mktemp -d)"
agent-feedback-loop install --home "$tmp_home"
agent-feedback-loop doctor --home "$tmp_home" --live
agent-feedback-loop uninstall --home "$tmp_home"
rm -rf "$tmp_home"
```

`doctor` returns `{ version, status }`. `status.ready` is the CLI success gate;
the other status families are `promptHook`, `controlStore`,
`reflectionDirectory`, `reviewerProvider`, and `legacyStopRemoved`.

## Legacy export and rollback

Legacy export is explicit and read-only with respect to its source database:

```sh
agent-feedback-loop legacy-export --source-db /absolute/legacy.sqlite3 \
  --output-dir /absolute/export --dry-run
agent-feedback-loop legacy-export --source-db /absolute/legacy.sqlite3 \
  --output-dir /absolute/export --apply
```

Review the dry-run output before `--apply`; obtain authorization before writing an
export destination. To roll back the active integration, first inspect
`agent-feedback-loop uninstall --dry-run`, then run `uninstall` only with approval.
It disconnects the managed prompt hooks (a hooks-disabled state) and preserves
durable control data and keys unless separately removed by the operator.

## Troubleshooting

- Run `doctor --live` in a temporary HOME before inspecting a real installation.
- `reviewerProvider` shows absent optional provider executables; install or expose
  one provider before expecting `status.ready`.
- Keep user prompt and review text out of shell diagnostics. Structured logs retain
  only fixed event names, bounded codes, opaque identifiers, and document hashes.
