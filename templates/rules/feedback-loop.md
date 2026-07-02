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

Reflection must never block the user, and its full report must never flood the conversation. The main session keeps working on the user's current remediation the whole time.

1. Do not pause normal execution. Give the user one short visible line: a major issue was caught and the full reflection was saved to a file, then keep going.
2. When the platform exposes a true background subagent tool, the main agent must first start a background reflection subagent. It must not perform the full reflection in the main conversation. 中文会话里也一样：必须先启动一个后台反思 subagent。
3. The background subagent writes the full reflection (per `prompts/reflection-agent.md`) to `.agent/reflections/<timestamp>-<slug>.md` in the project. The turn reply stays to one line plus the completion marker — do not paste the full report inline.
4. Fallback to main-agent file writing only when no true background subagent tool exists. In that case record the limitation in `released_agent_ids` and use `mode=fallback_no_subagent` in the completion marker.
5. Classify responsibility as `agent_fault`, `user_misunderstanding`, `shared_ambiguity`, `external_limit`, or `insufficient_evidence`.
6. If a background subagent was used, close/release it after consuming the report and record `released_agent_ids`.
7. When the finding is an `agent_fault` with evidence, medium/high confidence, and a concrete future constraint, default directly write the project rule to `.agent/rules/feedback-loop.md`. Do not ask the user whether to write it. 中文会话也按同一规则：默认直接写入项目规则。
8. Write project-specific rules to `.agent/rules/feedback-loop.md`, not to `AGENTS.md` or `CLAUDE.md`.
9. Do not auto-write low-confidence, insufficient-evidence, or global personal rules; record the reason in the reflection report instead.
10. Only promote to global personal rules for Blocker-level, generalizable, cross-project agent faults.

## Severity Policy

Severity affects how prominently the one-line conclusion is surfaced, not whether the user is blocked. No severity pauses the main session or pastes the full report inline.

- Minor: record trend only; no visible interruption needed.
- Major: reflect (to file); surface the one-line conclusion when ready.
- Critical: reflect in the background immediately; surface the conclusion prominently once ready.
- Blocker: reflect in the background immediately; surface the conclusion prominently and make the root cause and rule decision explicit. The user is still free to continue remediation in parallel.
