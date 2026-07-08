# Feedback Loop Rule

Use this rule when a deferred feedback review comes due and real retrospective feedback is found in the queue.

Do not assume user anger means the agent was wrong.

## Trigger Model (deferred review, no keywords)

- The hook never judges message content and injects nothing on normal turns: every user prompt is appended to a persistent per-project queue at `~/.agent/feedback-loop/queue/<project>.jsonl` (zero token cost).
- A single batch-review instruction is injected only when the queue is due: enough entries accumulated, or the oldest pending entry is old enough, and the review cooldown has passed. Thresholds are tunable via `AGENT_FEEDBACK_LOOP_REVIEW_MIN_ENTRIES` / `AGENT_FEEDBACK_LOOP_REVIEW_MAX_AGE` / `AGENT_FEEDBACK_LOOP_REVIEW_COOLDOWN`.
- The queue survives sessions, so reflection is delayed but never forgotten; the reviewer clears the queue only after a successful review.
- Feedback is **retrospective only**: the message must point at something the agent already produced and call it wrong/unsatisfactory, or repeat an earlier requirement. Prospective constraints on new tasks (“记得一定要…”, “不要…” inside a task description) are normal instructions, never feedback. When uncertain, prefer skipping over reflecting.
- Most reviews finding zero real feedback is the expected, healthy outcome (`responsibility=none`); do not write a report or rule in that case.
- Reflection reports default to Chinese unless the user explicitly selected another language for reflection reports.

## Required Response

Reflection must never block the user, and its full report must never flood the conversation. The main session keeps working on the user's current remediation the whole time.

1. Do not pause normal execution. Give the user one short visible line: a major issue was caught and the full reflection was saved to a file, then keep going.
2. When the platform exposes a true background subagent tool, the main agent must first start a background reflection subagent. It must not perform the full reflection in the main conversation. 中文会话里也一样：必须先启动一个后台反思 subagent。
3. The background subagent writes the full reflection (per `prompts/reflection-agent.md`) to `.agent/reflections/<timestamp>-<slug>.md` in the project. The turn reply stays to one line plus the completion marker — do not paste the full report inline.
4. Fallback to main-agent file writing only when no true background subagent tool exists. In that case record the limitation in `released_agent_ids` and use `mode=fallback_no_subagent` in the completion marker.
5. Classify responsibility as `agent_fault`, `user_misunderstanding`, `shared_ambiguity`, `external_limit`, or `insufficient_evidence`.
6. For every `agent_fault` / `shared_ambiguity`, the report must go deep, not wide: a 5-Whys causal chain down to a process/assumption-level root cause, an abstraction to the general *class* of mistake, and a reusable "do this going forward" method change — not a shallow restatement plus a narrow "don't do X" line. A reflection that would not change how the agent approaches a whole class of future tasks has failed its purpose. See `prompts/reflection-agent.md` › Analysis Depth.
7. Reflection is analysis, not a test run. The reviewer must not launch background or long-running processes (`run_in_background`, test watchers, `tail -f`, dev servers); any evidence command runs synchronously, bounded, non-interactive. Before finishing it must leave no running child process or open shell — a leaked background shell is itself an agent fault.
8. If a background subagent was used, close/release it after consuming the report and record `released_agent_ids`.
9. When the finding is an `agent_fault` with evidence, medium/high confidence, and a concrete future constraint, default directly write the project rule to `.agent/rules/feedback-loop.md`. Do not ask the user whether to write it. 中文会话也按同一规则：默认直接写入项目规则。
10. Write project-specific rules to `.agent/rules/feedback-loop.md`, not to `AGENTS.md` or `CLAUDE.md`.
11. Do not auto-write low-confidence, insufficient-evidence, or global personal rules; record the reason in the reflection report instead.
12. Only promote to global personal rules for Blocker-level, generalizable, cross-project agent faults.

## Severity Policy

Severity affects how prominently the one-line conclusion is surfaced, not whether the user is blocked. No severity pauses the main session or pastes the full report inline.

- Minor: record trend only; no visible interruption needed.
- Major: reflect (to file); surface the one-line conclusion when ready.
- Critical: reflect in the background immediately; surface the conclusion prominently once ready.
- Blocker: reflect in the background immediately; surface the conclusion prominently and make the root cause and rule decision explicit. The user is still free to continue remediation in parallel.
