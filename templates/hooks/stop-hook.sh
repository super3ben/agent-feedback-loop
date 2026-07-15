#!/bin/sh
set -eu

# Post-turn backstop shared by all model-visible CLIs.
# If this turn required reflection (judgment 1: per-turn marker file written by
# core-hook or by the model) but the model's reply has no done-marker
# (judgment 2: grep), force one continuation turn. Loop-guarded so it blocks at
# most once per real stop.
#
# Flags:
#   --mode codex|claude|gemini   selects output schema + loop-guard strategy

MODE="codex"
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    *) shift ;;
  esac
done

PROMPT_FILE="${AGENT_FEEDBACK_LOOP_PROMPT:-$HOME/.agent/feedback-loop/prompts/reflection-agent.md}"
payload="$(cat || true)"
HOOK_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
LOG_FILE="${AGENT_FEEDBACK_LOOP_LOG:-$HOME/.agent/feedback-loop-data/logs/runtime.log}"
if [ "$LOG_FILE" != "/dev/null" ]; then
  if ! mkdir -p "$(dirname -- "$LOG_FILE")" 2>/dev/null || ! touch "$LOG_FILE" 2>/dev/null; then
    LOG_FILE="/dev/null"
  else
    chmod 0600 "$LOG_FILE" 2>/dev/null || true
  fi
fi

# Capture assistant-visible output and explicit transcript/tool references before
# evaluating the backstop. Capture is fail-open and never changes stop output.
runtime_launcher="$HOME/.agent/feedback-loop/bin/afl-hook"
legacy_mode=0
[ -n "${AGENT_FEEDBACK_LOOP_QUEUE_DIR:-}" ] || [ "${AGENT_FEEDBACK_LOOP_LEGACY_QUEUE:-0}" = "1" ] && legacy_mode=1

# pass = allow the agent to stop normally (no-op output per CLI schema).
afl_pass() {
  case "$MODE" in
    codex) printf '%s\n' '{"continue":true}' ;;
    *)     printf '%s\n' '{}' ;;
  esac
  exit 0
}

if [ "$legacy_mode" -eq 0 ]; then
  if [ -x "$runtime_launcher" ]; then
    if transactional_output="$(printf '%s' "$payload" | "$runtime_launcher" capture-stop --cli "$MODE" 2>>"$LOG_FILE")"; then
      printf '%s\n' "$transactional_output"
      exit 0
    fi
  fi
  afl_pass
fi

# Without shared rules we cannot evaluate; fail open (allow stop).
[ -r "$HOOK_DIR/trigger-rules.sh" ] || afl_pass
. "$HOOK_DIR/trigger-rules.sh"

afl_json_field() {
  printf '%s' "$payload" | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\{0,1\}\([^",}]*\).*/\1/p' | head -n1
}

session_id="$(afl_json_field session_id)"
turn_id="$(afl_json_field turn_id)"
stop_active="$(afl_json_field stop_hook_active)"
transcript_path="$(afl_json_field transcript_path)"

marker_path="$(agent_feedback_marker_path "$session_id" "$turn_id")"
retries_path="${marker_path%.required}.retries"

afl_cleanup() {
  rm -f "$marker_path" "$retries_path" 2>/dev/null || true
}

# Judgment 1: was reflection required this turn?
[ -f "$marker_path" ] || afl_pass

# Judgment 2: did the model reflect? grep the reply/transcript for the marker.
done=1
if agent_feedback_has_done_marker "$payload"; then
  done=0
elif [ -n "$transcript_path" ] && [ -r "$transcript_path" ] \
     && grep -Eq "$AFL_DONE_PATTERN" "$transcript_path" 2>/dev/null; then
  done=0
fi
if [ "$done" -eq 0 ]; then
  afl_cleanup
  afl_pass
fi

# Loop guard: block at most once per real stop.
case "$MODE" in
  gemini)
    # stop_hook_active is unreliable on Gemini (0.30.0 bug); use a file counter.
    if [ -f "$retries_path" ]; then afl_cleanup; afl_pass; fi
    : > "$retries_path" 2>/dev/null || true
    ;;
  *)
    case "$stop_active" in
      true|True|1) afl_cleanup; afl_pass ;;
    esac
    ;;
esac

# Required but not reflected, and not yet retried -> force one continuation.
reason="$(agent_feedback_stop_reason "$PROMPT_FILE")"
case "$MODE" in
  gemini) printf '{"decision":"deny","reason":"%s"}\n' "$reason" ;;
  *)      printf '{"decision":"block","reason":"%s"}\n' "$reason" ;;
esac
exit 0
