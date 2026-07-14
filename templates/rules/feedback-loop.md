# Feedback Loop Runtime Rule

This rule applies when the transactional feedback-loop runtime creates a due
reviewer job. Normal prompt capture and lesson selection are local operations and
must not call an LLM.

## Review Dispatch

1. The runtime starts a detached, lease-fenced reviewer process with a bounded
   `0600` context file. It auto-selects the originating Codex, Claude Code, or
   Gemini CLI in headless mode.
2. `AGENT_FEEDBACK_LOOP_REVIEWER_COMMAND` optionally replaces that built-in provider
   with an operator-owned executable. It is not required for normal use.
3. The main conversation does not perform, delegate, display, or wait for the full
   reflection. If no provider executable exists, keep the job pending and report
   `reviewer_unavailable`; never substitute a main-agent reflection.
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

- The user-level transactional data root is the source of truth. Reports, lesson
  revisions, application receipts, effectiveness events, and queue acknowledgement
  commit atomically. Project Git is not mutated by an automatic review.
- Only active lessons are selectable. Minor is never loaded. Major requires exact
  task/path/tool/signal scope. Critical and Blocker remain bounded by project scope
  and context epoch.
- Selection uses a conservative local token estimate and complete cards. It makes no
  provider token-count request. Low-severity cards are skipped whole when over budget;
  severe overflow becomes an explicit checkpoint hold.
- Global promotion requires independent Blocker evidence from at least two repository
  lineages. A reviewer proposal alone cannot bypass the aggregate.

## Completion Authority

A review is complete only after a structured receipt transaction stores the report,
lesson projection and any effectiveness event, consumes the queued evidence, and
consumes the one-time capability. A conversation marker or Markdown file alone is not
completion authority.
