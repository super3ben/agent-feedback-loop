#!/bin/sh

# Marker needle the Stop/AfterAgent backstop greps for in the model reply.
# Reflection must end its report with: <!--afl-reflection:done responsibility=...-->
AFL_DONE_MARKER='<!--afl-reflection:done'
AFL_DONE_PATTERN='<!--afl-reflection:done[[:space:]][^>]*responsibility=[^[:space:]>]+[^>]*mode=(background_subagent|fallback_no_subagent)'

agent_feedback_contains() {
  printf '%s' "$1" | grep -Eiq "$2"
}

agent_feedback_should_force_reflect() {
  payload="$1"

  force_pattern='非常不满意|生气|严重问题|严重.*现场事故|现场事故|自我反思|反思了吗|触发.*反思|没用到.*subagent|没有用到.*subagent|反思.*subagent|subagent.*反思|反思.*主会话|主会话.*反思|反思.*后台|后台.*反思|占用.*主会话|不要询问.*要不要|不要问.*要不要|别问.*要不要|默认就要|大问题|太差|重做|重来|没有按规则|没按规则|没有真机测试|没真机测试|critical|blocker|very dissatisfied|angry|furious|unacceptable|serious issue|major issue|production incident|site incident'

  if agent_feedback_contains "$payload" "$force_pattern"; then
    return 0
  fi

  return 1
}

agent_feedback_has_done_marker() {
  printf '%s' "$1" | grep -Eq "$AFL_DONE_PATTERN"
}

# Directory holding per-turn reflection markers.
agent_feedback_marker_dir() {
  printf '%s/afl-reflect' "${TMPDIR:-/tmp}"
}

# Path of the "this turn requires reflection" marker for a session+turn.
# Both args are sanitized to a safe filename; empty values degrade to "_".
agent_feedback_marker_path() {
  session="$(printf '%s' "${1:-}" | tr -c 'A-Za-z0-9._-' '_')"
  turn="$(printf '%s' "${2:-}" | tr -c 'A-Za-z0-9._-' '_')"
  [ -n "$session" ] || session="_"
  [ -n "$turn" ] || turn="_"
  printf '%s/%s.%s.required' "$(agent_feedback_marker_dir)" "$session" "$turn"
}

agent_feedback_gate_message() {
  prompt_file="$1"
  marker_path="$2"
  printf '反馈检查：请语义检查最新用户消息。如果消息表达不满、纠错、重复失败、流程质疑，或要求未来防复发规则（例如“怎么又/为什么还/又…了/不要再”这类重复出错或不满的口吻也算），你必须：(a) 先执行 `touch %s` 标记本轮需要反思；(b) 必须先启动一个后台反思 subagent，并把 %s 和当前反馈上下文交给它，主会话继续处理用户当前问题；不得由主会话自己完成完整反思；(c) 若当前平台确实没有后台 subagent 工具，才允许主会话按文件报告 fallback 执行，并在报告中记录限制；(d) 若结论是 agent_fault 且有证据、中高置信度、具备具体防复发约束，默认直接写入 .agent/rules/feedback-loop.md，无需再询问用户是否写入；(e) 在本轮回复结尾输出一行 `%s responsibility=<分类> mode=background_subagent agent_id=<后台agent_id>-->`。无后台能力时输出 `%s responsibility=<分类> mode=fallback_no_subagent reason=<原因>-->`。否则忽略本检查并正常回答。反思报告默认使用中文，除非用户明确选择其他语言。' "$marker_path" "$prompt_file" "$AFL_DONE_MARKER" "$AFL_DONE_MARKER"
}

agent_feedback_reflection_message() {
  prompt_file="$1"
  printf '反馈反思已触发（不要暂停当前工作，也不要把整篇反思贴进对话）。请：(1) 必须先启动一个后台反思 subagent，并把 %s 和当前反馈上下文交给它；主会话继续处理用户当前的修复/补救或其他请求，不得由主会话自己完成完整反思；(2) 后台 subagent 遵循该提示完成反思（分类责任为 agent_fault/user_misunderstanding/shared_ambiguity/external_limit/insufficient_evidence），把完整报告写入项目内 .agent/reflections/<时间戳>-<短标题>.md（目录不存在就创建）；(3) 回合里只输出一行：已识别本次问题、完整反思已存到该文件；(4) 完成后在回复结尾输出一行 `%s responsibility=<分类> mode=background_subagent agent_id=<后台agent_id>-->` 作为机器可校验凭据。若当前平台确实没有后台 subagent 工具，才允许主会话按文件报告 fallback 执行，并输出 `%s responsibility=<分类> mode=fallback_no_subagent reason=<原因>-->`。反思报告默认使用中文，除非用户明确选择其他语言。消费报告后释放后台 subagent 并记录 released_agent_ids。agent_fault 且有证据、中高置信度、具备具体防复发约束时，项目规则默认直接写入 .agent/rules/feedback-loop.md，无需再询问用户是否写入；只有低置信/证据不足或 Blocker + agent_fault + 跨项目证据的全局个人规则才提案。' "$prompt_file" "$AFL_DONE_MARKER" "$AFL_DONE_MARKER"
}

# Continuation prompt the Stop/AfterAgent backstop sends when reflection was
# required this turn but the done-marker is missing.
agent_feedback_stop_reason() {
  prompt_file="$1"
  printf '检测到本轮要求反思但未见合格完成标记。请立即先启动一个后台反思 subagent，遵循 %s 完成反思；不得由主会话自己完成完整反思。完成后输出 `%s responsibility=<分类> mode=background_subagent agent_id=<后台agent_id>-->`。若当前平台确实没有后台 subagent 工具，才允许文件报告 fallback，并输出 `%s responsibility=<分类> mode=fallback_no_subagent reason=<原因>-->`。若结论是 agent_fault 且有证据、中高置信度、具备具体防复发约束，默认直接写入 .agent/rules/feedback-loop.md，无需再询问用户是否写入。' "$prompt_file" "$AFL_DONE_MARKER" "$AFL_DONE_MARKER"
}
