#!/bin/sh
set -eu

# Parameterized feedback-loop hook shared by all model-visible CLIs.
#
# Deferred-review model: every user prompt is appended to a persistent
# per-project queue (zero tokens injected). Only when the queue is due for
# review does the hook inject a single batch-review instruction, so most
# turns cost nothing and reflection still cannot be forgotten.
#
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
project_dir="$(afl_json_field cwd)"
[ -n "$project_dir" ] || project_dir="$(pwd)"
marker_path="$(agent_feedback_marker_path "$session_id" "$turn_id")"
queue_path="$(agent_feedback_queue_path "$project_dir")"

afl_debug_log() {
  [ "${AGENT_FEEDBACK_LOOP_DEBUG:-}" = "1" ] || return 0
  decision="$1"
  printf 'agent-feedback-loop: event=%s decision=%s session=%s turn=%s queue=%s\n' \
    "$EVENT" "$decision" "${session_id:-_}" "${turn_id:-_}" "$queue_path" >&2
}

# Record this prompt for the deferred batch review. Never blocks the turn.
# Dedup key = session + prompt text (NOT the raw payload: duplicate hook
# firings for one user message carry a fresh prompt_id, so raw lines differ).
prompt_text="$(afl_json_field prompt)"
agent_feedback_queue_append "$queue_path" "$payload" "${session_id}:${prompt_text}"

if agent_feedback_review_due "$queue_path"; then
  # Review due -> mark this turn (backstop enforces completion) and inject
  # the single batch-review instruction.
  mkdir -p "$(agent_feedback_marker_dir)" 2>/dev/null || true
  : > "$marker_path" 2>/dev/null || true
  agent_feedback_mark_review_started "$queue_path"
  afl_debug_log "review"
  message="$(agent_feedback_review_message "$PROMPT_FILE" "$queue_path" "$(agent_feedback_queue_count "$queue_path")")"
  cat <<JSON
{${continue_field}"hookSpecificOutput":{"hookEventName":"${EVENT}","additionalContext":"${message}"}}
JSON
  exit 0
fi

# Not due: zero tokens injected, the turn proceeds untouched.
afl_debug_log "queue"
printf '%s\n' "$fail_open"
exit 0
