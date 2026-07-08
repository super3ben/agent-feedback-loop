#!/bin/sh

# Marker needle the Stop/AfterAgent backstop greps for in the model reply.
# A review turn must end its reply with: <!--afl-reflection:done responsibility=...-->
AFL_DONE_MARKER='<!--afl-reflection:done'
AFL_DONE_PATTERN='<!--afl-reflection:done[[:space:]][^>]*responsibility=[^[:space:]>]+[^>]*mode=(background_subagent|fallback_no_subagent)'

# Deferred-review model: no keyword matching and no per-turn semantic gate.
# Every user prompt is appended to a persistent per-project queue at zero
# token cost. A single batch review is injected only when the queue is due:
#   due = queue non-empty
#         AND seconds since last review >= cooldown
#         AND (entries >= min-entries OR seconds since last review >= max-age)
# The queue lives on disk and survives sessions, so deferred feedback is
# reviewed eventually even if the session that produced it already ended.
AFL_REVIEW_MIN_ENTRIES="${AGENT_FEEDBACK_LOOP_REVIEW_MIN_ENTRIES:-5}"
AFL_REVIEW_MAX_AGE="${AGENT_FEEDBACK_LOOP_REVIEW_MAX_AGE:-14400}"
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
  printf '反馈评审到期：队列文件 %s 已积累 %s 条用户消息记录。请立即启动一个后台评审 subagent（不得由主会话自己完成评审），把 %s 和该队列文件路径交给它：由它读取队列，按「回顾性反馈」标准筛选——仅当消息针对 agent 既有产出表达不满/纠正，或同一要求被重复提出时才算反馈；对新任务的前置要求、约束、偏好一律不算，宁漏报不误报；判为反馈必须能逐字引用用户原话并指明所指的既有产出，引用不出就不算；结论为「无新过错/预防性提醒」时严禁写规则或改既有规则、也不归档报告。忽略普通消息；仅对真实反馈按该提示完成反思。反思必须有深度：对每条真实反馈做 5 Why 逐层追因到「过程/默认假设」层的系统性根因，抽象成可复用的方法论类别，并给出「以后要这样做」的方法改进（不是单条「不要再犯 X」）；浅层复述或只加一条窄规则视为不合格。评审是分析不是跑测试：严禁启动后台或长驻进程（不得用 run_in_background、测试 watch、tail -f、dev server），确需取证只能同步、有超时、非交互地跑一次，结束前必须确保没有遗留运行中的子进程或 shell。报告写入对应项目 .agent/reflections/<时间戳>-<短标题>.md；agent_fault 且有证据、中高置信度、具备具体防复发约束时默认直接写入该项目 .agent/rules/feedback-loop.md，无需询问用户。评审完成后清空该队列文件。主会话继续处理用户当前请求，仅在回复结尾输出一行 `%s responsibility=<分类或none> mode=background_subagent agent_id=<后台agent_id>-->`。若当前平台确实没有后台 subagent 工具，才允许主会话自行快速评审并输出 `%s responsibility=<分类或none> mode=fallback_no_subagent reason=<原因>-->`。反思报告默认使用中文，除非用户明确选择其他语言。' "$queue" "$count" "$prompt_file" "$AFL_DONE_MARKER" "$AFL_DONE_MARKER"
}

# Continuation prompt the Stop/AfterAgent backstop sends when a review was
# due this turn but the done-marker is missing.
agent_feedback_stop_reason() {
  prompt_file="$1"
  printf '检测到本轮反馈评审到期但未见合格完成标记。请立即启动一个后台评审 subagent，遵循 %s 处理积压反馈队列；不得由主会话自己完成完整评审。完成后输出 `%s responsibility=<分类或none> mode=background_subagent agent_id=<后台agent_id>-->`。若当前平台确实没有后台 subagent 工具，才允许主会话 fallback 并输出 `%s responsibility=<分类或none> mode=fallback_no_subagent reason=<原因>-->`。agent_fault 且有证据、中高置信度、具备具体防复发约束时，默认直接写入项目 .agent/rules/feedback-loop.md，无需再询问用户。' "$prompt_file" "$AFL_DONE_MARKER" "$AFL_DONE_MARKER"
}
