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

Agent Feedback Loop makes an AI coding agent reflect when the user says it repeatedly made mistakes, missed context, skipped required process, or caused strong dissatisfaction. The full reflection is written to a file (`.agent/reflections/`) and the agent leaves only a one-line acknowledgement in the conversation, then **keeps working on the fix** — reflection never blocks the user's remediation and never floods the main session. It installs lightweight hooks that inject this reflection instruction into the model's context.

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
3. Connect a Codex `UserPromptSubmit` hook + a `Stop` backstop.
4. Connect a Claude Code `UserPromptSubmit` hook + a `Stop` backstop.
5. Connect a Gemini CLI `BeforeAgent` hook + an `AfterAgent` backstop.

The prompt-time hooks share one `core-hook.sh`; the backstops share one `stop-hook.sh`. Each entry just passes the flags that CLI needs.

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
    stop-hook.sh
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

## Two Layers: Soft Gate + Hard Backstop

Deciding "does this turn warrant reflection?" can never be 100% reliable up front — a semantic gate can misjudge, and a keyword list can never be exhaustive (you can always phrase dissatisfaction a new way). So coverage does not rely on getting that one judgment perfect. There are two layers:

**Layer 1 — soft gate (prompt time, `core-hook.sh`).** Every prompt gets a short semantic gate asking the model to reflect when the message shows dissatisfaction, correction, repeated failure, or process criticism (`怎么又…` / "why again" phrasing counts). When reflection is warranted, the marker for "this turn requires reflection" is written two ways: the model writes it (semantic long tail, no word list), and the shell writes it on an unmistakable keyword match (`critical`, `blocker`, `现场事故`, …). The keyword list is intentionally tiny — it is a hard-trigger floor, not a coverage mechanism.

**Layer 2 — hard backstop (turn end, `stop-hook.sh`).** After the model replies, a `Stop` (Codex/Claude) or `AfterAgent` (Gemini) hook checks two deterministic things — never re-doing the semantic judgment in shell:

- **Was reflection required?** → the per-turn marker file from Layer 1 exists.
- **Did the model reflect?** → the reply contains the receipt line `<!--afl-reflection:done responsibility=...-->`.

If required but the receipt is missing, the backstop forces exactly one continuation turn telling the model to reflect. A loop guard (`stop_hook_active`, or a file counter on Gemini where that flag is broken in 0.30.0) ensures it blocks at most once.

**Honest boundary:** the guarantee is only as good as "did Layer 1 mark the turn." The shell-keyword path is a hard guarantee; the model-written marker is still soft (the model might miss it). The backstop turns "reflection silently skipped" from undetectable into mostly-caught — it does not make detection perfect.

## Reflection Contract

Hooks inject a short semantic feedback gate on every prompt. The gate asks the active model to inspect the latest user message in any language and only run reflection when it expresses dissatisfaction, correction, repeated failure, process criticism, or a future prevention rule/preference.

The shell hook keeps only a small force-reflection fallback for unmistakable blocker-level language or explicit future-prevention preferences such as `critical`, `blocker`, `非常不满意`, `严重问题`, `现场事故`, `自我反思`, or `不要询问要不要/默认就要`. It does not try to enumerate every Chinese or English dissatisfaction phrase — the backstop, not a bigger word list, is what catches the long tail.

Reflection reports default to Chinese unless the user explicitly selected another language in the current request or setup.

When triggered, the prompt requires the agent to classify responsibility as exactly one:

- `agent_fault`
- `user_misunderstanding`
- `shared_ambiguity`
- `external_limit`
- `insufficient_evidence`

It also requires:

- evidence before rule changes;
- the full reflection written to `.agent/reflections/<timestamp>.md`, with only a one-line summary plus the completion marker left in the turn — the report is never pasted inline;
- a true background subagent only as an optional enhancement where the platform exposes one (e.g. Claude Code's Task tool); the file-write default already keeps the main session clear everywhere else;
- subagent close/release after reflection reports are consumed, when one was used;
- `released_agent_ids` or an explicit CLI limitation note;
- project-specific rules in `.agent/rules/feedback-loop.md`;
- project rules are written by default, without asking again, when the finding is `agent_fault` with evidence, medium/high confidence, and a concrete future prevention constraint;
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

当用户表达重复出错、漏上下文、跳过流程或强烈不满时，agent 会反思:**完整反思写进文件**(`.agent/reflections/`),回合里**只留一行**“已识别问题、反思已存到某文件”的摘要,然后**继续处理当前的修复**——反思既不打断用户的补救,也不会用一墙报告淹没主会话。平台有真正的后台 subagent(如 Claude Code 的 Task)时可选择委托后台跑,但这只是增强,不是必需。每次用户提交时，CLI hook 都只注入一条很短的语义 gate，让当前模型判断最新消息是否表达了不满、纠错、重复失败、流程质疑，或要求未来防复发规则。普通请求会忽略这条 gate 正常回答。

hook 只保留极少数强触发兜底，例如 `critical`、`blocker`、`非常不满意`、`严重问题`、`现场事故`、`自我反思`、`不要询问要不要/默认就要`。它不再维护大规模中英文触发词表。

### 两层防护:软 gate + 硬兜底

"这轮该不该反思"这个判断永远做不到 100% 准——语义 gate 会误判,词表也永远列不全(不满总能有新说法)。所以覆盖**不依赖把这个判断做到完美**,而是分两层:

- **第一层 软 gate(提示时,`core-hook.sh`)**:每轮注入语义 gate,让模型在不满/纠错/重复出错/流程质疑("怎么又…"也算)时反思。判定要反思时,"本轮要反思"的标记**双写**:模型写(覆盖语义长尾,无需词表)+ shell 命中极小硬词表时写(`critical`/`现场事故` 等)。词表只是无歧义硬触发的地板,不再用来追求覆盖。
- **第二层 硬兜底(回合结束,`stop-hook.sh`)**:模型答完后,`Stop`(Codex/Claude)/`AfterAgent`(Gemini)hook 做两个**确定性**检查(绝不在 shell 里重做语义判断):① 本轮该反思吗 → 第一层的标记文件在不在;② 模型反思了吗 → 回复里有没有凭据行 `<!--afl-reflection:done responsibility=...-->`。**该反思却没凭据 → 强制重来一轮**,防死循环保证只打回一次。

**诚实边界**:保证强度 = 第一层有没有标记上。shell 硬词那条是硬保证,模型自己写标记那条仍是软的(可能漏)。兜底把"反思被悄悄跳过"从不可察变成大部分能抓——但不等于 100%。

反思报告默认使用中文；如果用户在接入或当前请求里明确指定其他语言，则按用户选择的语言输出。

核心原则：

- 不启动后台服务。
- 不用 JavaScript 调大模型。
- shell hook 不能自己创建 Codex/Claude/Gemini 内部 subagent；它只注入硬性要求，当前 agent 默认把完整反思写进文件、回合只留一行，平台支持时才可选地用后台 subagent。
- 不把反思逻辑写死在代码里。
- hook 只负责注入短 gate 和极强信号兜底，Markdown prompt 负责完整反思流程。
- 非程序员也可以直接维护 `reflection-agent.md` 和 `feedback-loop.md`。
- 子 agent 分析完必须关闭/释放，并记录 `released_agent_ids` 或说明 CLI 不支持释放。
- 项目规则写到 `.agent/rules/feedback-loop.md`，避免 `AGENTS.md` / `CLAUDE.md` 无限膨胀。
- 当结论是 `agent_fault` 且有证据、中高置信度、具备具体防复发约束时，项目规则默认直接写入，不再询问用户“要不要写”。

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
