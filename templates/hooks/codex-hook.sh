#!/bin/sh
set -eu

PROMPT_FILE="${AGENT_FEEDBACK_LOOP_PROMPT:-$HOME/.agent/feedback-loop/prompts/reflection-agent.md}"
payload="$(cat || true)"
HOOK_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

if [ ! -r "$HOOK_DIR/trigger-rules.sh" ]; then
  printf '{"continue":true}\n'
  exit 0
fi

. "$HOOK_DIR/trigger-rules.sh"

if agent_feedback_should_force_reflect "$payload"; then
  message="$(agent_feedback_reflection_message "$PROMPT_FILE")"
else
  message="$(agent_feedback_gate_message "$PROMPT_FILE")"
fi

cat <<JSON
{"continue":true,"systemMessage":"${message}"}
JSON
