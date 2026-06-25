#!/bin/sh

agent_feedback_contains() {
  printf '%s' "$1" | grep -Eiq "$2"
}

agent_feedback_should_force_reflect() {
  payload="$1"

  force_pattern='非常不满意|生气|严重问题|大问题|太差|重做|重来|没有按规则|没按规则|没有真机测试|没真机测试|critical|blocker|very dissatisfied|angry|furious|unacceptable|serious issue|major issue'

  if agent_feedback_contains "$payload" "$force_pattern"; then
    return 0
  fi

  return 1
}

agent_feedback_gate_message() {
  prompt_file="$1"
  printf 'Feedback gate: Semantically inspect the latest user message in any language. If it expresses dissatisfaction, correction, repeated failure, process criticism, or asks for a future prevention rule/preference, follow %s; otherwise ignore this gate and answer normally.' "$prompt_file"
}

agent_feedback_reflection_message() {
  prompt_file="$1"
  printf 'Feedback reflection triggered. Before continuing, follow %s. Classify responsibility as agent_fault, user_misunderstanding, shared_ambiguity, external_limit, or insufficient_evidence. If reflection subagents are used, close/release completed ones and record released_agent_ids. Project rules go to .agent/rules/feedback-loop.md; global promotion requires Blocker agent_fault with cross-project evidence.' "$prompt_file"
}
