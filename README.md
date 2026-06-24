# Agent Feedback Loop

Prompt-first feedback reflection hooks for Codex and Claude Code.

Agent Feedback Loop helps an AI coding agent pause and reflect when a user says it repeatedly made mistakes, missed context, skipped required process, or caused strong dissatisfaction. The package installs lightweight hooks that inject a reflection prompt. The reflection logic stays in Markdown, so users can maintain it without editing JavaScript or Python.

## English

### What It Does

- Adds prompt-first feedback reflection to Codex and Claude Code.
- Detects strong dissatisfaction or repeated-error language before the agent continues.
- Injects a reflection prompt that requires responsibility classification:
  - `agent_fault`
  - `user_misunderstanding`
  - `shared_ambiguity`
  - `external_limit`
  - `insufficient_evidence`
- Requires reflection subagents to be closed/released after their reports are consumed.
- Keeps project-specific rules isolated in `.agent/rules/feedback-loop.md`.
- Promotes global rules only for Blocker-level, generalizable, cross-project agent faults.

### What It Does Not Do

- It does not run a background service.
- It does not call an LLM from JavaScript.
- It does not force every correction into a rule.
- It does not store secrets or upload conversation content.

The npm package is only an installer and health checker. The actual reflection behavior lives in Markdown prompts and shell hooks.

### Install

From GitHub:

```bash
npm install -g github:super3ben/agent-feedback-loop
agent-feedback-loop install
```

When published to npm:

```bash
npm install -g agent-feedback-loop
agent-feedback-loop install
```

Without global install:

```bash
npx github:super3ben/agent-feedback-loop install
```

### Commands

```bash
agent-feedback-loop install
agent-feedback-loop doctor
agent-feedback-loop uninstall
```

Useful options:

```bash
agent-feedback-loop install --dry-run
agent-feedback-loop install --home /tmp/test-home
agent-feedback-loop uninstall --remove-files
```

### Installed Files

```text
~/.agent/feedback-loop/
  hooks/codex-hook.sh
  hooks/claude-hook.sh
  prompts/reflection-agent.md
  rules/feedback-loop.md
```

The installer patches:

```text
~/.codex/config.toml
~/.claude/settings.json
```

Backups are created before config changes:

```text
~/.codex/config.toml.backup-YYYYMMDDHHMMSS
~/.claude/settings.json.backup-YYYYMMDDHHMMSS
```

### How It Works

1. The user sends a prompt in Codex or Claude Code.
2. The CLI calls the installed `UserPromptSubmit` hook.
3. The shell hook checks for strong feedback language.
4. If triggered, the hook injects the Markdown reflection prompt.
5. The agent classifies responsibility and decides whether any rule should be updated.

### Development

```bash
npm test
npm pack --dry-run
node ./bin/agent-feedback-loop.mjs install --home /tmp/afl-home
```

## 中文

### 这个工具做什么

Agent Feedback Loop 是一套面向 Codex 和 Claude Code 的“提示词优先”自动反思机制。

当用户表达强烈不满、指出重复错误、说 agent 漏上下文或没有按流程执行时，它会通过 CLI hook 注入反思提示，让 agent 在继续执行前先复盘。

它会要求 agent 判断责任归因：

- `agent_fault`：agent 确实漏读、误判、跳过流程、没有测试或重复犯错。
- `user_misunderstanding`：用户不满，但证据显示 agent 没有错，或用户理解了错误边界。
- `shared_ambiguity`：双方需求不清，agent 也没有及时澄清。
- `external_limit`：权限、工具、网络、CLI 或外部服务限制导致。
- `insufficient_evidence`：证据不足，不能强行判断。

### 设计原则

- 不启动后台服务。
- 不用 JavaScript 调大模型。
- 不把反思逻辑写死在代码里。
- hook 只负责触发，Markdown prompt 负责流程。
- 非程序员也可以直接维护 `reflection-agent.md` 和 `feedback-loop.md`。
- 子 agent 分析完必须关闭/释放，并记录 `released_agent_ids` 或说明 CLI 不支持释放。
- 项目规则写到 `.agent/rules/feedback-loop.md`，避免 `AGENTS.md` / `CLAUDE.md` 无限膨胀。

### 安装

从 GitHub 安装：

```bash
npm install -g github:super3ben/agent-feedback-loop
agent-feedback-loop install
```

如果以后发布到 npm：

```bash
npm install -g agent-feedback-loop
agent-feedback-loop install
```

也可以不全局安装：

```bash
npx github:super3ben/agent-feedback-loop install
```

### 常用命令

```bash
agent-feedback-loop install      # 安装并接入 Codex / Claude Code
agent-feedback-loop doctor       # 检查是否安装成功
agent-feedback-loop uninstall    # 移除 hook 配置，保留 prompt 文件
```

测试安装：

```bash
agent-feedback-loop install --dry-run
agent-feedback-loop install --home /tmp/test-home
```

彻底移除文件：

```bash
agent-feedback-loop uninstall --remove-files
```

### 安装后文件

```text
~/.agent/feedback-loop/
  hooks/codex-hook.sh
  hooks/claude-hook.sh
  prompts/reflection-agent.md
  rules/feedback-loop.md
```

安装器会修改：

```text
~/.codex/config.toml
~/.claude/settings.json
```

修改前会自动备份：

```text
~/.codex/config.toml.backup-YYYYMMDDHHMMSS
~/.claude/settings.json.backup-YYYYMMDDHHMMSS
```

### 维护方式

你通常只需要改这两个 Markdown 文件：

```text
~/.agent/feedback-loop/prompts/reflection-agent.md
~/.agent/feedback-loop/rules/feedback-loop.md
```

如果要调整触发词，再改：

```text
~/.agent/feedback-loop/hooks/codex-hook.sh
~/.agent/feedback-loop/hooks/claude-hook.sh
```

### 开发

```bash
npm test
npm pack --dry-run
node ./bin/agent-feedback-loop.mjs install --home /tmp/afl-home
```

## License

MIT
