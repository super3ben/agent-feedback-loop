#!/bin/sh
set -u

with_continue=0
for argument in "$@"; do
  if [ "$argument" = "--continue" ]; then
    with_continue=1
  fi
done

if [ "$with_continue" -eq 1 ]; then
  fail_open='{"continue":true}'
else
  fail_open='{}'
fi

payload="$(cat || true)"
runtime_launcher="$HOME/.agent/feedback-loop/bin/afl-hook"
launcher_output="$(mktemp "${TMPDIR:-/tmp}/afl-hook.XXXXXX" 2>/dev/null || true)"

if [ -n "$launcher_output" ]; then
  trap 'rm -f "$launcher_output"' EXIT HUP INT TERM
fi

if [ -n "$launcher_output" ] && [ -x "$runtime_launcher" ]; then
  if printf '%s' "$payload" | "$runtime_launcher" hook "$@" >"$launcher_output" 2>/dev/null; then
    cat "$launcher_output"
    exit 0
  fi
fi

printf '%s\n' "$fail_open"
exit 0
