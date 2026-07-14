#!/bin/sh

# Marker needle the Stop/AfterAgent backstop greps for in the model reply.
# A review turn must end its reply with: <!--afl-reflection:done responsibility=...-->
AFL_DONE_MARKER='<!--afl-reflection:done'
AFL_DONE_PATTERN='<!--afl-reflection:done[[:space:]][^>]*responsibility=[^[:space:]>]+[^>]*mode=background_subagent'

# Deferred-review model: no keyword matching and no per-turn semantic gate.
# Every user prompt is appended to a persistent per-project queue at zero
# token cost. A single batch review is injected only when the queue is due:
#   due = queue non-empty
#         AND seconds since last review >= cooldown
#         AND (entries >= min-entries OR seconds since last review >= max-age)
# The queue lives on disk and survives sessions, so deferred feedback is
# reviewed eventually even if the session that produced it already ended.
AFL_REVIEW_MIN_ENTRIES="${AGENT_FEEDBACK_LOOP_REVIEW_MIN_ENTRIES:-3}"
AFL_REVIEW_MAX_AGE="${AGENT_FEEDBACK_LOOP_REVIEW_MAX_AGE:-3600}"
AFL_REVIEW_COOLDOWN="${AGENT_FEEDBACK_LOOP_REVIEW_COOLDOWN:-900}"

agent_feedback_has_done_marker() {
  printf '%s' "$1" | grep -Eq "$AFL_DONE_PATTERN"
}

# Directory holding per-turn reflection markers.
agent_feedback_marker_dir() {
  printf '%s/afl-reflect' "${TMPDIR:-/tmp}"
}

# Path of the "this turn requires review" marker for a session+turn.
# Both args are sanitized to a safe filename; empty values degrade to "_".
agent_feedback_marker_path() {
  session="$(printf '%s' "${1:-}" | tr -c 'A-Za-z0-9._-' '_')"
  turn="$(printf '%s' "${2:-}" | tr -c 'A-Za-z0-9._-' '_')"
  [ -n "$session" ] || session="_"
  [ -n "$turn" ] || turn="_"
  printf '%s/%s.%s.required' "$(agent_feedback_marker_dir)" "$session" "$turn"
}

# Persistent queue of raw hook payloads, one JSON line per user prompt.
agent_feedback_queue_dir() {
  printf '%s' "${AGENT_FEEDBACK_LOOP_QUEUE_DIR:-$HOME/.agent/feedback-loop/queue}"
}

# One queue per project (sanitized cwd) so reviews and reports stay
# project-local even when several projects share the queue directory.
agent_feedback_queue_path() {
  project="$(printf '%s' "${1:-}" | tr -c 'A-Za-z0-9._-' '_')"
  [ -n "$project" ] || project="_"
  printf '%s/%s.jsonl' "$(agent_feedback_queue_dir)" "$project"
}

# Epoch-seconds stamp of the last review start for a queue file.
agent_feedback_stamp_path() {
  printf '%s.last-review' "${1%.jsonl}"
}

agent_feedback_queue_append() {
  queue="$1"
  entry="$(printf '%s' "$2" | tr '\n' ' ')"
  dedup_key="${3:-}"
  mkdir -p "$(agent_feedback_queue_dir)" 2>/dev/null || return 0
  # Dedup: some CLIs fire the prompt hook more than once for the same user
  # message (same session/text, new prompt_id), so compare the prompt text —
  # not the raw payload line — against the previous append and skip repeats.
  # Genuine repeats of the same short message later on are one queue entry;
  # the reviewer sees repetition from context, so nothing meaningful is lost.
  last_key_file="${queue%.jsonl}.last-prompt"
  if [ -n "$dedup_key" ] && [ -s "$queue" ] \
     && [ "$dedup_key" = "$(cat "$last_key_file" 2>/dev/null)" ]; then
    return 0
  fi
  printf '%s\n' "$entry" >> "$queue" 2>/dev/null || return 0
  [ -n "$dedup_key" ] && printf '%s' "$dedup_key" > "$last_key_file" 2>/dev/null
  stamp="$(agent_feedback_stamp_path "$queue")"
  # First activity starts the age clock so max-age is measured from the
  # oldest pending entry, not from the epoch.
  [ -f "$stamp" ] || date +%s > "$stamp" 2>/dev/null || true
  return 0
}

agent_feedback_queue_count() {
  count="$(wc -l < "$1" 2>/dev/null | tr -d '[:space:]')"
  printf '%s' "${count:-0}"
}

agent_feedback_review_due() {
  queue="$1"
  [ -s "$queue" ] || return 1
  stamp="$(agent_feedback_stamp_path "$queue")"
  now="$(date +%s)"
  last="$(cat "$stamp" 2>/dev/null || printf '0')"
  case "$last" in
    ''|*[!0-9]*) last=0 ;;
  esac
  elapsed=$((now - last))
  [ "$elapsed" -ge "$AFL_REVIEW_COOLDOWN" ] || return 1
  count="$(agent_feedback_queue_count "$queue")"
  case "$count" in
    ''|*[!0-9]*) count=0 ;;
  esac
  [ "$count" -ge "$AFL_REVIEW_MIN_ENTRIES" ] && return 0
  [ "$elapsed" -ge "$AFL_REVIEW_MAX_AGE" ] && return 0
  return 1
}

# Refresh the stamp when a review is injected so the cooldown suppresses
# duplicate injections while the background reviewer is still working. The
# queue itself is only cleared by the reviewer, so a failed review re-fires
# after the cooldown instead of being forgotten.
agent_feedback_mark_review_started() {
  date +%s > "$(agent_feedback_stamp_path "$1")" 2>/dev/null || true
}

agent_feedback_review_message() {
  prompt_file="$1"
  queue="$2"
  count="$3"
  printf '旧版 JSONL 反馈评审到期：队列文件 %s 已积累 %s 条记录。立即启动真正的后台评审 subagent，把 %s 和队列路径交给它；主会话不得代做。仅接受回顾性反馈：必须逐字引用用户原话并指向既有 agent 产出；前瞻要求不是反馈，agent 主动发起的澄清/评审轮次里的草稿纠正也不是反馈，除非同一纠正再次重复、用户批评流程本身或产物已经交付；宁漏报不误报。反思按严重度完成至少 5 Why 因果链、方法分类和行动卡，不得调用任务执行流水线，不得使用 run_in_background 或启动长驻进程。后台评审完成并安全落盘后清空该旧版队列，主会话只输出 `%s responsibility=<分类或none> mode=background_subagent agent_id=<后台agent_id>-->`。平台没有后台 subagent 时保持队列不变并报告 reviewer_unavailable，不允许主会话 fallback。反思默认中文。' "$queue" "$count" "$prompt_file" "$AFL_DONE_MARKER"
}

# Continuation prompt the Stop/AfterAgent backstop sends when a review was
# due this turn but the done-marker is missing.
agent_feedback_stop_reason() {
  prompt_file="$1"
  printf '检测到旧版反馈评审到期但未见后台 subagent 完成标记。请遵循 %s 启动真正的后台评审；主会话不得代做。完成后输出 `%s responsibility=<分类或none> mode=background_subagent agent_id=<后台agent_id>-->`。平台没有后台 subagent 时保持队列待处理并报告 reviewer_unavailable。' "$prompt_file" "$AFL_DONE_MARKER"
}
