# Agent Feedback Loop 中文说明

面向 Codex、Claude Code、Gemini CLI 的本地提示时反馈闭环。

**运行时版本：`0.8.0`**

## 已实现的路径

1. prompt hook 捕获合格反馈后立即返回宿主。
2. 分离的 reviewer 可在稍后读取有界本地上下文。
3. 有效结果发布为项目 `.agent/reflections/` 下不可变 Markdown。
4. 后续匹配的提示直接选择少量适用文档。

当前提示永不等待 reviewer。处理开始时确定 publication cutoff，因此处理中
新发布的文档只能影响后续匹配的提示。精简 control SQLite 数据库只保存
生命周期状态；不可变 Markdown 才是反思文档。这是直接 Markdown 选择，
不是 RAG。

没有 Stop/AfterAgent hook、会话回执或状态输出；没有 RAG 服务或常驻调度器。
`AGENT_FEEDBACK_LOOP_DEBUG=1` 才输出 prompt 诊断；reviewer 终态诊断为 stderr
上的 JSONL。

macOS 与 Linux 是支持的安装目标。本文不主张某个环境已经取得 live provider、
desktop 或 Linux 验收证据。

## 安装与临时 HOME 验证

需要 Node.js 24.15 或更高版本。真实全局安装或修改真实 HOME 配置前，必须取得授权。

```sh
npm install -g agent-feedback-loop
agent-feedback-loop install --dry-run
```

先使用临时 HOME，避免触碰真实配置和数据：

```sh
tmp_home="$(mktemp -d)"
agent-feedback-loop install --home "$tmp_home"
agent-feedback-loop doctor --home "$tmp_home" --live
agent-feedback-loop uninstall --home "$tmp_home"
rm -rf "$tmp_home"
```

`doctor` 只返回 `{ version, status }`。`status.ready` 是 CLI 成功/退出码的门；
其余 family 为 `promptHook`、`controlStore`、`reflectionDirectory`、
`reviewerProvider`、`legacyStopRemoved`。

## 旧版导出与回滚

旧版导出对源数据库只读，必须显式选择 dry-run 或 apply：

```sh
agent-feedback-loop legacy-export --source-db /absolute/legacy.sqlite3 \
  --output-dir /absolute/export --dry-run
agent-feedback-loop legacy-export --source-db /absolute/legacy.sqlite3 \
  --output-dir /absolute/export --apply
```

先审阅 dry-run，再在获得写入导出目录授权后执行 `--apply`。回滚时先运行
`agent-feedback-loop uninstall --dry-run`；获得批准后再执行 `uninstall`。
它会断开受管 prompt hooks，进入关闭 hooks 的状态，并保留 durable control 数据和
密钥，除非操作员另行处理。

## 排障

- 先在临时 HOME 运行 `doctor --live`，再排查真实安装。
- `reviewerProvider` 会显示缺失的可选 provider；至少一个可运行 provider 才可能
  使 `status.ready` 成立。
- 不要把 prompt 或报告正文放入 shell 诊断。结构化日志仅保留固定事件名、有限代码、
  opaque 标识符和文档 hash。
