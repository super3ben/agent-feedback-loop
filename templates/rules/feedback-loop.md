# Feedback Loop Rule

Use this rule when the user expresses strong dissatisfaction, anger, repeated errors, or a serious process violation.

Do not assume user anger means the agent was wrong.

## Trigger Model

- Every hook invocation injects a short semantic gate.
- The active model must inspect the latest user message in any language.
- Run reflection when the message expresses dissatisfaction, correction, repeated failure, process criticism, or a future prevention rule/preference.
- Ignore the gate for normal requests.
- Shell hooks keep only a small force-reflection fallback for unmistakable blocker-level language such as "critical", "blocker", "非常不满意", "严重问题", "现场事故", "自我反思", and similar high-severity wording.
- Reflection reports default to Chinese unless the user explicitly selected another language for reflection reports.

## Required Response

Reflection runs in the **background** and must never block the user. The main session keeps working on the user's current remediation or other request the whole time.

1. Do not pause normal execution. First, give the user one visible line acknowledging that a major issue was detected and that reflection has started in the background, so the user knows the model noticed without losing momentum.
2. Immediately start one independent background reflection subagent with `prompts/reflection-agent.md` and the current context. Do not wait for it — continue the user's current task in parallel.
3. When the subagent report is ready, asynchronously fold a short conclusion summary back to the user. The main conversation must not replace that report with its own unsupported reflection while a background reflection subagent can run.
4. If a CLI genuinely cannot start a background subagent from this surface, record that limitation explicitly and run the reflection inline at the end of the current turn instead — still without interrupting the user's in-progress remediation.
5. Classify responsibility as `agent_fault`, `user_misunderstanding`, `shared_ambiguity`, `external_limit`, or `insufficient_evidence`.
6. After consuming the subagent report, close/release completed reflection subagents and record `released_agent_ids`.
7. Only write a project rule when the finding is an `agent_fault` with evidence and a concrete future constraint.
8. Write project-specific rules to `.agent/rules/feedback-loop.md`, not to `AGENTS.md` or `CLAUDE.md`.
9. Only promote to global personal rules for Blocker-level, generalizable, cross-project agent faults.

## Severity Policy

Severity affects how prominently the conclusion is surfaced, not whether the user is blocked. No severity pauses the main session.

- Minor: record trend only; no visible interruption needed.
- Major: reflect in the background; surface the conclusion when ready.
- Critical: reflect in the background immediately; surface the conclusion prominently once ready.
- Blocker: reflect in the background immediately; surface the conclusion prominently and make the root cause and rule decision explicit. The user is still free to continue remediation in parallel.
