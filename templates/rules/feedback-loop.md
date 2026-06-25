# Feedback Loop Rule

Use this rule when the user expresses strong dissatisfaction, anger, repeated errors, or a serious process violation.

Do not assume user anger means the agent was wrong.

## Trigger Model

- Every hook invocation injects a short semantic gate.
- The active model must inspect the latest user message in any language.
- Run reflection when the message expresses dissatisfaction, correction, repeated failure, process criticism, or a future prevention rule/preference.
- Ignore the gate for normal requests.
- Shell hooks keep only a small force-reflection fallback for unmistakable blocker-level language such as "critical", "blocker", "非常不满意", "严重问题", and similar high-severity wording.

## Required Response

1. Pause normal execution and run the reflection process in `prompts/reflection-agent.md`.
2. Classify responsibility as `agent_fault`, `user_misunderstanding`, `shared_ambiguity`, `external_limit`, or `insufficient_evidence`.
3. If subagents are available, start one independent reflection subagent with the reflection prompt and current context.
4. After consuming the subagent report, close/release completed reflection subagents and record `released_agent_ids`.
5. Only write a project rule when the finding is an `agent_fault` with evidence and a concrete future constraint.
6. Write project-specific rules to `.agent/rules/feedback-loop.md`, not to `AGENTS.md` or `CLAUDE.md`.
7. Only promote to global personal rules for Blocker-level, generalizable, cross-project agent faults.

## Severity Policy

- Minor: record trend only.
- Major: reflect before continuing substantive work.
- Critical: reflect immediately and summarize findings before proceeding.
- Blocker: reflect immediately; do not continue implementation until the root cause and rule decision are explicit.
