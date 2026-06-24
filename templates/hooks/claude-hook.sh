#!/bin/sh
set -eu

PROMPT_FILE="${AGENT_FEEDBACK_LOOP_PROMPT:-$HOME/.agent/feedback-loop/prompts/reflection-agent.md}"
payload="$(cat || true)"

case "$payload" in
  *"非常不满意"*|*"生气"*|*"严重问题"*|*"大问题"*|*"每次"*|*"反复"*|*"重复"*|*"又一次"*|*"总是"*|*"漏了"*|*"没理解"*|*"理解错"*|*"没有按规则"*|*"没有真机测试"*|*"critical"*|*"blocker"*|*"repeated"*|*"recurring"*)
    cat <<JSON
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Feedback reflection triggered. Before continuing, follow ${PROMPT_FILE}. Classify responsibility as agent_fault, user_misunderstanding, shared_ambiguity, external_limit, or insufficient_evidence. If reflection subagents are used, close/release completed ones and record released_agent_ids. Project rules go to .agent/rules/feedback-loop.md; global promotion requires Blocker agent_fault with cross-project evidence."}}
JSON
    ;;
  *)
    printf '{}\n'
    ;;
esac
