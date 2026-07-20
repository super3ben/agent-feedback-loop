# Feedback Loop Runtime Rule

The prompt hook is prompt-only: it captures eligible feedback, starts no visible
conversation work, and returns immediately. A detached reviewer may later create
one immutable project Markdown document in `.agent/reflections/`. The publication
cutoff means that document is considered only by a later matching prompt, never by
the prompt that was already being handled.

Use the lean control database only for reviewer lifecycle state. Select applicable
immutable Markdown directly; do not add RAG, a resident scheduler, Stop/AfterAgent
hooks, session receipts, or status output.

Legacy export is explicit and source-read-only: require `--dry-run` or `--apply`.
Real installation, export writes, and changing a real HOME require operator
authorization. For rollback, inspect `uninstall --dry-run` and, once approved,
run `uninstall` to leave hooks disabled while preserving durable data.

macOS and Linux are supported targets. Do not infer live-provider, desktop, or
platform acceptance from this rule; record that evidence separately.
