#!/bin/sh
set -eu

# Parameterized feedback-loop hook shared by all model-visible CLIs.
#
# Transactional mode captures each prompt locally with zero review tokens and
# launches a short-lived reviewer process only when review is due. It never asks
# the main conversation to perform reflection. The JSONL branch below is an
# explicit legacy compatibility mode and retains its historical prompt contract.
#
# Flags:
#   --event <name>   value for hookEventName (default: UserPromptSubmit)
#   --continue       include "continue":true in output (Codex needs it)

EVENT="UserPromptSubmit"
WITH_CONTINUE=0
CLI="unknown"
while [ $# -gt 0 ]; do
  case "$1" in
    --event) EVENT="$2"; shift 2 ;;
    --cli) CLI="$2"; shift 2 ;;
    --continue) WITH_CONTINUE=1; shift ;;
    *) shift ;;
  esac
done

PROMPT_FILE="${AGENT_FEEDBACK_LOOP_PROMPT:-$HOME/.agent/feedback-loop/prompts/reflection-agent.md}"
payload="$(cat || true)"
HOOK_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
LOG_FILE="${AGENT_FEEDBACK_LOOP_LOG:-$HOME/.agent/feedback-loop-data/logs/runtime.log}"
if [ "$LOG_FILE" != "/dev/null" ]; then
  max_log_bytes="${AGENT_FEEDBACK_LOOP_MAX_LOG_BYTES:-5242880}"
  case "$max_log_bytes" in *[!0-9]*|'') max_log_bytes=5242880 ;; esac
  if [ -L "$LOG_FILE" ]; then
    LOG_FILE="/dev/null"
  elif [ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE" 2>/dev/null || printf 0)" -gt "$max_log_bytes" ]; then
    rm -f "$LOG_FILE.1" 2>/dev/null || true
    mv "$LOG_FILE" "$LOG_FILE.1" 2>/dev/null || LOG_FILE="/dev/null"
  fi
  if [ "$LOG_FILE" != "/dev/null" ] && { ! mkdir -p "$(dirname -- "$LOG_FILE")" 2>/dev/null || ! touch "$LOG_FILE" 2>/dev/null; }; then
    LOG_FILE="/dev/null"
  elif [ "$LOG_FILE" != "/dev/null" ]; then
    chmod 0600 "$LOG_FILE" 2>/dev/null || true
  fi
fi

if [ "$WITH_CONTINUE" -eq 1 ]; then
  fail_open='{"continue":true}'
  continue_field='"continue":true,'
else
  fail_open='{}'
  continue_field=''
fi

# New capture path: the stable launcher stores a normalized event and encrypted
# evidence. Any failure is deliberately fail-open; the legacy queue below is
# used only when the caller explicitly opts into that compatibility mode.
runtime_launcher="$HOME/.agent/feedback-loop/bin/afl-hook"
runtime_available=0
capture_ok=0
legacy_mode=0
[ -n "${AGENT_FEEDBACK_LOOP_QUEUE_DIR:-}" ] || [ "${AGENT_FEEDBACK_LOOP_LEGACY_QUEUE:-0}" = "1" ] && legacy_mode=1
if [ "$legacy_mode" -eq 0 ] && [ -x "$runtime_launcher" ]; then
  runtime_available=1
  launcher_output="$(mktemp "${TMPDIR:-/tmp}/afl-hook.XXXXXX")"
  if [ "$WITH_CONTINUE" -eq 1 ]; then
    printf '%s' "$payload" | "$runtime_launcher" hook --cli "$CLI" --event "$EVENT" --continue >"$launcher_output" 2>>"$LOG_FILE" && capture_ok=1
  else
    printf '%s' "$payload" | "$runtime_launcher" hook --cli "$CLI" --event "$EVENT" >"$launcher_output" 2>>"$LOG_FILE" && capture_ok=1
  fi
  if [ "$capture_ok" -eq 1 ]; then
    # Explicit legacy mode keeps the historical JSONL contract for callers and
    # tests that opt in. Normal installs return the launcher's JSON response.
    if [ "$legacy_mode" -eq 0 ] && [ -r "$HOOK_DIR/trigger-rules.sh" ]; then
      cat "$launcher_output"
      rm -f "$launcher_output"
      exit 0
    fi
  fi
  rm -f "$launcher_output"
fi

# JSONL is an explicit legacy compatibility mode only. It is never written in
# parallel with a successful SQLite capture, and callers must opt in with a
# queue directory or AFL_LEGACY_QUEUE=1.
if [ "$runtime_available" -eq 1 ] && [ -z "${AGENT_FEEDBACK_LOOP_QUEUE_DIR:-}" ] && [ "${AGENT_FEEDBACK_LOOP_LEGACY_QUEUE:-0}" != "1" ]; then
  printf '%s\n' "$fail_open"
  exit 0
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
# Skip machine-generated payloads (background-task notifications, local
# command echoes) — they are harness artifacts, not user messages, and they
# inflate the queue count toward the review threshold.
# Dedup key = session + prompt text (NOT the raw payload: duplicate hook
# firings for one user message carry a fresh prompt_id, so raw lines differ).
prompt_text="$(afl_json_field prompt)"
case "$payload" in
  *'<task-notification>'*|*'<local-command-caveat>'*|*'<command-name>'*)
    afl_debug_log "skip-machine"
    printf '%s\n' "$fail_open"
    exit 0
    ;;
esac
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
