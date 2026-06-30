#!/bin/sh

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

agent_feedback_gate_message() {
  prompt_file="$1"
  printf '反馈检查：请语义检查最新用户消息。如果消息表达不满、纠错、重复失败、流程质疑，或要求未来防复发规则，请遵循 %s；否则忽略本检查并正常回答。反思报告默认使用中文，除非用户明确选择其他语言。' "$prompt_file"
}

agent_feedback_reflection_message() {
  prompt_file="$1"
  printf '反馈反思已触发（后台模式，不要暂停当前工作）。请按顺序：(1) 先给用户一行可见提示，说明已识别到本次重大问题、反思已在后台启动，你会继续处理当前任务；(2) 立即启动一个独立的 background reflection subagent，把 %s 和当前上下文交给它；(3) 不要等待该 subagent，继续推进用户当前的修复/补救或其他请求；(4) 当 subagent 报告就绪后，再异步把结论摘要补充给用户，主会话不要用自己未经支撑的反思替代该报告。反思报告默认使用中文，除非用户明确选择其他语言。必须分类责任为 agent_fault、user_misunderstanding、shared_ambiguity、external_limit 或 insufficient_evidence。消费报告后关闭/释放已完成的反思 subagent，并记录 released_agent_ids。项目规则写入 .agent/rules/feedback-loop.md；只有 Blocker + agent_fault + 跨项目证据才可提升为全局规则。' "$prompt_file"
}
