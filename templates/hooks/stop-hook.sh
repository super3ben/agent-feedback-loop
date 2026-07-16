#!/bin/sh
set -eu

# Bounded post-turn capture shared by all model-visible CLIs.
# Capture is observational only: every state and every failure returns the
# native host pass schema.

MODE="codex"
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    *) shift ;;
  esac
done

payload="$(cat || true)"
LOG_FILE="${AGENT_FEEDBACK_LOOP_LOG:-$HOME/.agent/feedback-loop-data/logs/runtime.log}"
if [ "$LOG_FILE" != "/dev/null" ]; then
  if ! mkdir -p "$(dirname -- "$LOG_FILE")" 2>/dev/null || ! touch "$LOG_FILE" 2>/dev/null; then
    LOG_FILE="/dev/null"
  else
    chmod 0600 "$LOG_FILE" 2>/dev/null || true
  fi
fi

runtime_launcher="$HOME/.agent/feedback-loop/bin/afl-hook"

afl_pass() {
  case "$MODE" in
    codex) printf '%s\n' '{"continue":true}' ;;
    *)     printf '%s\n' '{}' ;;
  esac
  exit 0
}

afl_log_non_interference() {
  [ "$LOG_FILE" = "/dev/null" ] || printf '%s\n' \
    "agent-feedback-loop: $(date -u +%Y-%m-%dT%H:%M:%SZ) hook.non_interference event=stop result=pass capture=failed reason=$1" >>"$LOG_FILE" 2>/dev/null || true
}

[ -x "$runtime_launcher" ] || {
  afl_log_non_interference runtime_unavailable
  afl_pass
}

timeout_ms="${AGENT_FEEDBACK_LOOP_STOP_CAPTURE_TIMEOUT_MS:-1000}"
case "$timeout_ms" in *[!0-9]*|'') timeout_ms=1000 ;; esac
[ "$timeout_ms" -ge 50 ] 2>/dev/null || timeout_ms=50
[ "$timeout_ms" -le 4000 ] 2>/dev/null || timeout_ms=4000

umask 077
payload_file="$(mktemp "${TMPDIR:-/tmp}/afl-stop-payload.XXXXXX" 2>/dev/null || true)"
diagnostic_file="$(mktemp "${TMPDIR:-/tmp}/afl-stop-diagnostic.XXXXXX" 2>/dev/null || true)"
[ -n "$payload_file" ] && [ -n "$diagnostic_file" ] || {
  rm -f "$payload_file" "$diagnostic_file" 2>/dev/null || true
  afl_log_non_interference runtime_unavailable
  afl_pass
}
afl_cleanup() {
  rm -f "$payload_file" "$diagnostic_file" 2>/dev/null || true
}
trap afl_cleanup EXIT HUP INT TERM
printf '%s' "$payload" >"$payload_file" || {
  afl_log_non_interference runtime_unavailable
  afl_pass
}
# Keep runtime and shell job-control diagnostics private. Only fixed
# non-interference reason codes may be copied into the runtime log below.
exec 2>>"$diagnostic_file"

capture_group=0
if command -v setsid >/dev/null 2>&1; then
  setsid "$runtime_launcher" capture-stop --cli "$MODE" <"$payload_file" >/dev/null 2>>"$diagnostic_file" &
  capture_group=1
else
  "$runtime_launcher" capture-stop --cli "$MODE" <"$payload_file" >/dev/null 2>>"$diagnostic_file" &
fi
capture_pid=$!

afl_collect_descendants() {
  descendant_pids=""
  frontier="$capture_pid"
  depth=0
  while [ -n "$frontier" ] && [ "$depth" -lt 32 ]; do
    next_frontier=""
    for parent_pid in $frontier; do
      children="$(ps -eo pid=,ppid= 2>/dev/null | awk -v parent="$parent_pid" '$2 == parent { print $1 }' || true)"
      for child_pid in $children; do
        case " $descendant_pids " in
          *" $child_pid "*) continue ;;
        esac
        descendant_pids="$child_pid $descendant_pids"
        next_frontier="$next_frontier $child_pid"
      done
    done
    frontier="$next_frontier"
    depth=$((depth + 1))
  done
}

afl_signal_tree() {
  signal_name="$1"
  if [ "$capture_group" -eq 1 ]; then
    kill -s "$signal_name" "-$capture_pid" 2>/dev/null || true
  fi
  for tree_pid in $descendant_pids; do
    kill -s "$signal_name" "$tree_pid" 2>/dev/null || true
  done
  kill -s "$signal_name" "$capture_pid" 2>/dev/null || true
}

elapsed_ms=0
while kill -0 "$capture_pid" 2>/dev/null && [ "$elapsed_ms" -lt "$timeout_ms" ]; do
  sleep 0.05
  elapsed_ms=$((elapsed_ms + 50))
done

if kill -0 "$capture_pid" 2>/dev/null; then
  afl_collect_descendants
  afl_signal_tree TERM
  sleep 0.2
  afl_collect_descendants
  afl_signal_tree KILL
  afl_log_non_interference capture_timeout
else
  if wait "$capture_pid"; then
    if [ "$LOG_FILE" != "/dev/null" ]; then
      grep -E '^agent-feedback-loop: [^ ]+ hook\.non_interference event=stop result=pass capture=failed reason=(invalid_input|store_unavailable|capture_failed|observation_failed)$' \
        "$diagnostic_file" >>"$LOG_FILE" 2>/dev/null || true
    fi
  else
    afl_log_non_interference runtime_failed
  fi
fi

afl_pass
