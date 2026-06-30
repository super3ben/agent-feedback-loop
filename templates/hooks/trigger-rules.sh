#!/bin/sh

# Marker needle the Stop/AfterAgent backstop greps for in the model reply.
# Reflection must end its report with: <!--afl-reflection:done responsibility=...-->
AFL_DONE_MARKER='<!--afl-reflection:done'

agent_feedback_contains() {
  printf '%s' "$1" | grep -Eiq "$2"
}

agent_feedback_should_force_reflect() {
  payload="$1"

  force_pattern='非常不满意|生气|严重问题|严重.*现场事故|现场事故|自我反思|反思了吗|触发.*反思|大问题|太差|重做|重来|没有按规则|没按规则|没有真机测试|没真机测试|critical|blocker|very dissatisfied|angry|furious|unacceptable|serious issue|major issue|production incident|site incident'

  if agent_feedback_contains "$payload" "$force_pattern"; then
    return 0
  fi

  return 1
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
  printf '反馈检查：请语义检查最新用户消息。如果消息表达不满、纠错、重复失败、流程质疑，或要求未来防复发规则（例如“怎么又/为什么还/又…了/不要再”这类重复出错或不满的口吻也算），你必须：(a) 先执行 `touch %s` 标记本轮需要反思；(b) 遵循 %s 完成反思，把完整报告写入项目内 .agent/reflections/<时间戳>.md（目录不存在就创建），回合里只留一行摘要、不要把整篇反思贴进对话；(c) 在本轮回复结尾输出一行 `%s responsibility=<分类>-->` 作为机器可校验的完成凭据。否则忽略本检查并正常回答。反思报告默认使用中文，除非用户明确选择其他语言。' "$marker_path" "$prompt_file" "$AFL_DONE_MARKER"
}

agent_feedback_reflection_message() {
  prompt_file="$1"
  printf '反馈反思已触发（不要暂停当前工作，也不要把整篇反思贴进对话）。请：(1) 遵循 %s 完成反思（分类责任为 agent_fault/user_misunderstanding/shared_ambiguity/external_limit/insufficient_evidence），把完整报告写入项目内 .agent/reflections/<时间戳>-<短标题>.md（目录不存在就创建）；(2) 回合里只输出一行：已识别本次问题、完整反思已存到该文件，然后继续处理用户当前的修复/补救或其他请求；(3) 仅当平台提供真正的后台 subagent（如 Claude Code 的 Task）时，可把反思委托给后台 subagent 并行跑，但报告同样落文件、回合同样只留一行；(4) 完成后在回复结尾输出一行 `%s responsibility=<分类>-->` 作为机器可校验凭据。反思报告默认使用中文，除非用户明确选择其他语言。消费报告后释放后台 subagent 并记录 released_agent_ids。项目规则写入 .agent/rules/feedback-loop.md；只有 Blocker + agent_fault + 跨项目证据才可提升为全局规则。' "$prompt_file" "$AFL_DONE_MARKER"
}

# Continuation prompt the Stop/AfterAgent backstop sends when reflection was
# required this turn but the done-marker is missing.
agent_feedback_stop_reason() {
  prompt_file="$1"
  printf '检测到本轮要求反思但未见反思完成标记。请立即遵循 %s 完成反思（分类责任为 agent_fault/user_misunderstanding/shared_ambiguity/external_limit/insufficient_evidence），并在回复结尾输出一行 `%s responsibility=<分类>-->`。' "$prompt_file" "$AFL_DONE_MARKER"
}
