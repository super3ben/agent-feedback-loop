# Agent Feedback Loop

<p align="center">
  <img src="assets/hero.svg" alt="Agent Feedback Loop overview" width="100%" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/agent-feedback-loop"><img alt="npm version" src="https://img.shields.io/npm/v/agent-feedback-loop?color=cb3837"></a>
  <a href="https://www.npmjs.com/package/agent-feedback-loop"><img alt="npm downloads" src="https://img.shields.io/npm/dw/agent-feedback-loop?color=1f883d"></a>
  <a href="#development"><img alt="Tests: node --test" src="https://img.shields.io/badge/tests-node--test-0969da"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
</p>

```text
 █████╗  ███████╗ ██╗
██╔══██╗ ██╔════╝ ██║
███████║ █████╗   ██║
██╔══██║ ██╔══╝   ██║
██║  ██║ ██║      ███████╗
╚═╝  ╚═╝ ╚═╝      ╚══════╝
Agent Feedback Loop
```

> 中文版：见 [中文](#中文)

Prompt-first feedback reflection hooks for **Codex**, **Claude Code**, and **Gemini CLI**.

Agent Feedback Loop makes an AI coding agent reflect in the **background** when the user says it repeatedly made mistakes, missed context, skipped required process, or caused strong dissatisfaction. The agent tells the user it noticed the major issue and started reflecting, but **keeps working on the fix** — reflection never blocks the user's remediation. It installs lightweight hooks that inject this reflection instruction into the model's context.

The key design choice: **the reflection logic lives in Markdown, not in JavaScript or Python.**

## Important

`0.1.0` is the first public release:

- npm install works directly from the registry.
- Codex, Claude Code, and Gemini CLI hooks are installed by one command.
- No background service is started.
- The package does not call an LLM from JavaScript.
- Project rules stay isolated in `.agent/rules/feedback-loop.md`.

## Why Agent Feedback Loop

AI coding agents are good at moving fast, but they can also repeat the same mistake: ignoring context, skipping a required test, claiming completion too early, or answering defensively when the user is clearly unhappy.

Most teams solve this by adding more rules to `AGENTS.md` or `CLAUDE.md`. That works for a while, then the file becomes a wall of warnings and every project inherits too much baggage.

Agent Feedback Loop separates the concern:

- **Hooks** detect strong feedback and inject a reflection prompt.
- **Markdown prompts** define the reflection process.
- **The agent** classifies responsibility and decides whether a rule is justified.
- **Project rules** stay in `.agent/rules/feedback-loop.md`.
- **Global rules** are reserved for repeated, generalizable, cross-project agent faults.

## What You'll Learn

This repository is intentionally small so it can serve as a reference for:

- How to distribute AI-agent workflow hooks through npm.
- How to keep prompt logic editable by non-programmers.
- How to support Codex, Claude Code, and Gemini CLI without a daemon.
- How to fail open when hooks cannot run.
- How to require the agent to distinguish `agent_fault` from `user_misunderstanding`.
- How to make subagent cleanup part of the reflection contract.

## Install

Requirements:

- Node.js 18+
- npm/npx
- Codex, Claude Code, and/or Gemini CLI if you want automatic hook integration

```bash
npm install -g agent-feedback-loop
agent-feedback-loop install
```

Without global install:

```bash
npx agent-feedback-loop install
```

## Quick Start

```bash
agent-feedback-loop install
agent-feedback-loop doctor
```

`agent-feedback-loop install` will:

1. Copy the prompt pack to `~/.agent/feedback-loop`.
2. Back up `~/.codex/config.toml`, `~/.claude/settings.json`, and `~/.gemini/settings.json` if they exist.
3. Connect a Codex `UserPromptSubmit` hook.
4. Connect a Claude Code `UserPromptSubmit` hook.
5. Connect a Gemini CLI `BeforeAgent` hook.

All three CLIs are wired to one shared `core-hook.sh`; each entry just passes the flags that CLI needs.

## Screenshots

<p align="center">
  <img src="assets/terminal.svg" alt="Terminal quick start" width="100%" />
</p>

Install and diagnose the prompt-first feedback loop in one minute.

<p align="center">
  <img src="assets/flow.svg" alt="Feedback reflection workflow" width="100%" />
</p>

Strong feedback becomes an explicit reflection step instead of another warning buried in project instructions.

## Commands

`agent-feedback-loop install` — Install prompt pack and hook integrations.

```bash
agent-feedback-loop install
agent-feedback-loop install --dry-run
agent-feedback-loop install --home /tmp/test-home
```

`agent-feedback-loop doctor` — Check prompt files, hook files, and CLI config connections.

```bash
agent-feedback-loop doctor
agent-feedback-loop doctor --home /tmp/test-home
```

`agent-feedback-loop uninstall` — Remove hook integrations while preserving prompt files.

```bash
agent-feedback-loop uninstall
agent-feedback-loop uninstall --remove-files
```

`agent-feedback-loop paths` — Print resolved install paths.

```bash
agent-feedback-loop paths
```

## Installed Files

```text
~/.agent/feedback-loop/
  hooks/
    core-hook.sh
    trigger-rules.sh
  prompts/
    reflection-agent.md
  rules/
    feedback-loop.md
```

The installer patches:

```text
~/.codex/config.toml
~/.claude/settings.json
~/.gemini/settings.json
```

Backups are created before config changes:

```text
~/.codex/config.toml.backup-YYYYMMDDHHMMSS
~/.claude/settings.json.backup-YYYYMMDDHHMMSS
~/.gemini/settings.json.backup-YYYYMMDDHHMMSS
```

## Reflection Contract

Hooks inject a short semantic feedback gate on every prompt. The gate asks the active model to inspect the latest user message in any language and only run reflection when it expresses dissatisfaction, correction, repeated failure, process criticism, or a future prevention rule/preference.

The shell hook keeps only a small force-reflection fallback for unmistakable blocker-level language such as `critical`, `blocker`, `非常不满意`, `严重问题`, `现场事故`, or `自我反思`. It does not try to enumerate every Chinese or English dissatisfaction phrase.

Reflection reports default to Chinese unless the user explicitly selected another language in the current request or setup.

When triggered, the prompt requires the agent to classify responsibility as exactly one:

- `agent_fault`
- `user_misunderstanding`
- `shared_ambiguity`
- `external_limit`
- `insufficient_evidence`

It also requires:

- evidence before rule changes;
- when the platform exposes subagents, the main conversation must start one independent background reflection subagent before writing the full reflection itself;
- if subagents are unavailable from the current surface, the agent must record that limitation before using main-conversation fallback reflection;
- subagent close/release after reflection reports are consumed;
- `released_agent_ids` or an explicit CLI limitation note;
- project-specific rules in `.agent/rules/feedback-loop.md`;
- global promotion only for `Blocker + agent_fault + generalizable + cross-project evidence`.

## What It Does Not Do

- It does not start a background service.
- It does not call an LLM from JavaScript.
- It cannot create a Codex/Claude/Gemini subagent from shell by itself; it injects the requirement, and the active agent must use platform subagent tools when available.
- It does not upload conversation content.
- It does not force every correction into a rule.
- It does not edit `AGENTS.md` or `CLAUDE.md` by default.

## Supported Platforms

### How it works in one sentence

The moment you press enter, this tool slips a short instruction ("check if the user is unhappy — if so, reflect") into the message **before it reaches the model**. The model reads that instruction and reflects. The whole thing lives or dies on one thing: **can we get text in front of the model?**

```
your input ──▶ [hook slips in the reflection instruction] ──▶ model sees "your message + instruction"
```

If the text can't get in, the model never sees it, and the tool does nothing. (That was the original "it didn't work" bug: Codex was given the text via a field that only shows in the UI — the model couldn't read it.)

### Tier A — the CLI gives us that opening (works out of the box)

These CLIs expose a **model-visible hook**: a place where our text actually reaches the model's context for the turn. All three share one `core-hook.sh`; adding another such CLI is **one line** in the registry in `src/index.mjs`.

| Platform | Hook event | Field that reaches the model |
| --- | --- | --- |
| Codex | `UserPromptSubmit` | `hookSpecificOutput.additionalContext` |
| Claude Code | `UserPromptSubmit` | `hookSpecificOutput.additionalContext` |
| Gemini CLI | `BeforeAgent` | `hookSpecificOutput.additionalContext` |

### Tier B — no such opening

Some CLIs either have no hooks at all, or have hooks that can only touch the UI/logs but **can't put text in front of the model** (like Codex's old `systemMessage`). Either way, the instruction never reaches the model, so reflection never happens.

**This is the CLI's design boundary, not something cleverer code can get around.** We can run any script and print any JSON, but if the CLI won't feed our text to the model, nothing we do changes that — so it's an external limit.

The only fallback is an **external wrapper** (`afl run -- <cli>`): instead of using the CLI's hooks, we wrap the CLI and splice the instruction into the prompt ourselves before launching it. It's a fallback, not a peer: the user has to launch via `afl run`, and every wrapped CLI needs its own adapter. Not promised as "install and go," and not built yet.

## Project Rule Isolation

Project-specific feedback rules should live here:

```text
<project>/.agent/rules/feedback-loop.md
```

Keep `AGENTS.md` and `CLAUDE.md` small. They should point to project rules, not become a long incident log.

## Development

```bash
git clone https://github.com/super3ben/agent-feedback-loop.git
cd agent-feedback-loop
npm test
npm pack --dry-run
node ./bin/agent-feedback-loop.mjs install --home /tmp/afl-home
```

## 中文

Agent Feedback Loop 是一套面向 Codex、Claude Code 和 Gemini CLI 的“提示词优先”自动反思机制。

当用户表达重复出错、漏上下文、跳过流程或强烈不满时，agent 会在**后台**反思:先给用户一句“已识别到重大问题、反思已在后台启动”的可见提示,然后**继续处理当前的修复**——反思不打断用户的补救。每次用户提交时，CLI hook 都只注入一条很短的语义 gate，让当前模型判断最新消息是否表达了不满、纠错、重复失败、流程质疑，或要求未来防复发规则。普通请求会忽略这条 gate 正常回答。

hook 只保留极少数强触发兜底，例如 `critical`、`blocker`、`非常不满意`、`严重问题`、`现场事故`、`自我反思`。它不再维护大规模中英文触发词表。

反思报告默认使用中文；如果用户在接入或当前请求里明确指定其他语言，则按用户选择的语言输出。

核心原则：

- 不启动后台服务。
- 不用 JavaScript 调大模型。
- shell hook 不能自己创建 Codex/Claude/Gemini 内部 subagent；它只注入硬性要求，当前 agent 必须在平台支持时启动后台反思 subagent。
- 不把反思逻辑写死在代码里。
- hook 只负责注入短 gate 和极强信号兜底，Markdown prompt 负责完整反思流程。
- 非程序员也可以直接维护 `reflection-agent.md` 和 `feedback-loop.md`。
- 子 agent 分析完必须关闭/释放，并记录 `released_agent_ids` 或说明 CLI 不支持释放。
- 项目规则写到 `.agent/rules/feedback-loop.md`，避免 `AGENTS.md` / `CLAUDE.md` 无限膨胀。

### 安装

```bash
npm install -g agent-feedback-loop
agent-feedback-loop install
agent-feedback-loop doctor
```

### 常用命令

```bash
agent-feedback-loop install      # 安装并接入 Codex / Claude Code / Gemini CLI
agent-feedback-loop doctor       # 检查是否安装成功
agent-feedback-loop uninstall    # 移除 hook 配置，保留 prompt 文件
```

### 维护方式

通常只需要改这两个 Markdown 文件：

```text
~/.agent/feedback-loop/prompts/reflection-agent.md
~/.agent/feedback-loop/rules/feedback-loop.md
```

如果要调整短 gate 文案或极强兜底词，再改共享规则文件：

```text
~/.agent/feedback-loop/hooks/trigger-rules.sh
```

`core-hook.sh` 通过 `--event` / `--continue` 参数为三个 CLI 输出各自需要的 JSON。

### 支持哪些 CLI（大白话）

**这套机制的命根子:能不能往「模型的上下文」里塞字。** 你按下回车那一刻,在消息送进模型之前,这个工具偷偷塞进一段指令(「检查用户是不是在表达不满,是的话就反思」)。模型读到这段字,才会去反思。

```
用户输入 ──▶ [hook 塞入反思指令] ──▶ 模型看到「你的消息 + 反思指令」
```

字塞不进去,模型就看不到,这工具就是个摆设 —— 这正是最初「没生效」的原因:Codex 当时用的字段只显示在界面上,模型根本读不到。

**Tier A —— CLI 给了塞字的口子(接入即可用):** Codex / Claude / Gemini 都提供「模型可见 hook」,我们的文字能真的进模型上下文。三家共用一个 `core-hook.sh`,再加一个这类 CLI 只需在 `src/index.mjs` 注册表里**加一行**。

**Tier B —— 没有这个口子:** 有些 CLI 要么没有 hook,要么 hook 只能动界面/日志、塞不进模型上下文。结果一样:指令到不了模型,反思不会发生。**这是那个 CLI 自己的设计边界,不是更聪明的代码能绕过的 —— 所以叫外部限制。** 唯一退路是外层 wrapper(`afl run -- <cli>`,把 CLI 包在外面自己拼 prompt),但要逐个适配、且要改用 `afl run` 启动,不算「接入即可用」,本次也没做。

## License

MIT
