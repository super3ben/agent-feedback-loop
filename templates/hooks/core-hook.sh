#!/bin/sh
set -eu

# Parameterized feedback-loop hook shared by all model-visible CLIs.
# Flags:
#   --event <name>   value for hookEventName (default: UserPromptSubmit)
#   --continue       include "continue":true in output (Codex needs it)

EVENT="UserPromptSubmit"
WITH_CONTINUE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --event) EVENT="$2"; shift 2 ;;
    --continue) WITH_CONTINUE=1; shift ;;
    *) shift ;;
  esac
done

PROMPT_FILE="${AGENT_FEEDBACK_LOOP_PROMPT:-$HOME/.agent/feedback-loop/prompts/reflection-agent.md}"
payload="$(cat || true)"
HOOK_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

if [ "$WITH_CONTINUE" -eq 1 ]; then
  fail_open='{"continue":true}'
  continue_field='"continue":true,'
else
  fail_open='{}'
  continue_field=''
fi

if [ ! -r "$HOOK_DIR/trigger-rules.sh" ]; then
  printf '%s\n' "$fail_open"
  exit 0
fi

. "$HOOK_DIR/trigger-rules.sh"

# Extract a top-level field from the JSON payload without jq.
# Handles both "name":"value" and "name":123 forms.
afl_json_field() {
  printf '%s' "$payload" | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\{0,1\}\([^",}]*\).*/\1/p' | head -n1
}

session_id="$(afl_json_field session_id)"
turn_id="$(afl_json_field turn_id)"
marker_path="$(agent_feedback_marker_path "$session_id" "$turn_id")"

if agent_feedback_should_force_reflect "$payload"; then
  # Judgment 1 (shell write): unambiguous strong feedback -> mark this turn.
  mkdir -p "$(agent_feedback_marker_dir)" 2>/dev/null || true
  : > "$marker_path" 2>/dev/null || true
  message="$(agent_feedback_reflection_message "$PROMPT_FILE")"
else
  # Semantic gate: model self-judges and writes the marker itself if needed.
  message="$(agent_feedback_gate_message "$PROMPT_FILE" "$marker_path")"
fi

cat <<JSON
{${continue_field}"hookSpecificOutput":{"hookEventName":"${EVENT}","additionalContext":"${message}"}}
JSON
