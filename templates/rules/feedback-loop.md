# Feedback Loop Runtime Rule

This rule applies when the transactional feedback-loop runtime creates a due
reviewer job. Normal prompt capture and lesson selection are local operations and
must not call an LLM.

## Review Dispatch

1. The runtime starts a detached, lease-fenced reviewer process and derives the
   Codex, Claude Code, or Gemini provider from the captured source event.
2. Bounded redacted evidence is supplied only on stdin. Provider output crosses a
   private `0600` result-file boundary and must match `reviewer-result.schema.json`.
3. The main conversation does not perform, delegate, display, or wait for the full
   reflection. If the captured provider executable is unavailable, retry the job
   through the bounded control-store lifecycle; never substitute a main-agent reflection.
4. Process isolation proves a separate lifecycle and bounded handoff, not an OS,
   filesystem, or network sandbox. Provider-specific invocations disable tools or
   use read-only/plan policy where supported.

## Review Quality

- Accept only retrospective feedback with an exact user quote and concrete prior
  agent referent. Prospective constraints and elicited draft corrections are not
  feedback. Prefer false negatives over false positives.
- Reflection examines why the user was dissatisfied, why the working method drifted,
  which execution-time signal was missed, and why the class can recur. It does not
  invoke task-execution pipelines or Superpowers.
- Minor findings remain trend evidence and create no active lesson. Major requires a
  full causal chain, method class, and complete action card. Critical adds a decision
  timeline, counterfactual checkpoint, and recurrence effectiveness audit. Blocker
  adds impact, stop, and rollback/isolation controls.
- An applicable lesson recurrence must bind its effectiveness audit to the real
  application/delivery receipt. `emitted_unconfirmed` is not proof the model loaded
  the lesson and must not be blamed on agent execution.

## Persistence And Loading

- The control store is authoritative for the reviewer lifecycle. A successful
  lesson is published as one immutable project-scoped Markdown document; a
  no-lesson result creates no document. Automatic review stores no report,
  notification, or lesson body in SQLite.
- Only active lessons are selectable. Minor is never loaded. Major requires exact
  task/path/tool/signal scope. Critical and Blocker remain bounded by project scope
  and context epoch.
- Selection uses a conservative local token estimate and complete cards. It makes no
  provider token-count request. Low-severity cards are skipped whole when over budget;
  severe overflow becomes an explicit checkpoint hold.
- Global promotion requires independent Blocker evidence from at least two repository
  lineages. A reviewer proposal alone cannot bypass the aggregate.

## Completion Authority

A review is complete only when the fenced control row reaches
`reviewed_no_lesson`, or reaches `published` with the exact immutable document path
and SHA-256. A conversation marker, provider output, or unfenced file alone is not
completion authority.
