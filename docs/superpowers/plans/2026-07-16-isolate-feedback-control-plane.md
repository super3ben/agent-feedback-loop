---
change: isolate-feedback-control-plane
design-doc: docs/superpowers/specs/2026-07-16-isolate-feedback-control-plane-design.md
status: superseded
---

# 已废弃：Agent Feedback Loop 旧控制面实施计划

> **禁止继续执行。** 该计划原本建立在 notification delivery、Stop fail-open、feedback episode、resident scheduler、memory maintenance 和数据库长期记忆之上。用户已否决该架构，并确认改为“明确反馈立即启动 detached reviewer subagent + Markdown 文档直接记忆”。

旧计划及完成记录保留在 Git 历史中供审计，不再作为恢复入口。旧 Task 1/2/3 的完成状态不代表新架构已经实现，相关提交必须在新计划中逐项审计并删除不兼容路径。

当前唯一有效设计为：

- `openspec/changes/isolate-feedback-control-plane/`
- `docs/superpowers/specs/2026-07-16-isolate-feedback-control-plane-design.md`

待修订设计经用户审阅后，使用 writing-plans 流程重新生成完整实施计划；在此之前不得继续源码任务、恢复全局 hooks、切换 managed runtime 或迁移真实数据库。
