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

Agent Feedback Loop makes an AI coding agent reflect when the user's messages show it repeatedly made mistakes, missed context, skipped required process, or caused dissatisfaction. Instead of judging every keystroke, hooks silently record each prompt to a per-project queue and periodically hand the backlog to a background reviewer — so normal turns cost zero tokens and real feedback is reviewed with hindsight, delayed but never forgotten. The full reflection is written to a file (`.agent/reflections/`) and the agent leaves only a one-line acknowledgement in the conversation, then **keeps working on the fix** — reflection never blocks the user's remediation and never floods the main session.

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

- **Hooks** record every prompt to a per-project queue and inject one batch-review instruction when it comes due.
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
  queue/            # created at runtime: one <project>.jsonl per project
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

## Deferred Review: Queue + Hard Backstop

Judging "is this single message feedback?" per turn can never be reliable — a semantic gate misjudges prospective task constraints as corrections, and a keyword list can never be exhaustive (you can always phrase dissatisfaction a new way). Per-turn judging also costs tokens on every prompt. So the design defers the judgment instead of trying to perfect it:

**Layer 1 — silent queue (prompt time, `core-hook.sh`).** Every user prompt is appended to a persistent per-project queue at `~/.agent/feedback-loop/queue/<project>.jsonl`. Nothing is injected into the model's context on normal turns — zero token cost, zero false positives. There is no keyword matching and no per-turn semantic gate at all.

**Layer 2 — due batch review (prompt time, same hook).** When the queue is due — enough entries accumulated (`AGENT_FEEDBACK_LOOP_REVIEW_MIN_ENTRIES`, default 5), or the oldest pending entry is older than `AGENT_FEEDBACK_LOOP_REVIEW_MAX_AGE` (default 4h), and the review cooldown (`AGENT_FEEDBACK_LOOP_REVIEW_COOLDOWN`, default 15min) has passed — the hook injects one batch-review instruction. The model hands the queue file to a background reviewer subagent, which reads all pending messages **with hindsight**: it can see whether a requirement was later repeated, whether the user pushed back on an output, whether a complaint recurred. Feedback is defined retrospectively (points at existing output, or repeats an earlier requirement); prospective task constraints are explicitly not feedback. The reviewer reflects only on real feedback, then clears the queue. The queue lives on disk and survives sessions — reflection is delayed, never forgotten.

**Layer 3 — hard backstop (turn end, `stop-hook.sh`).** On a review-due turn the hook writes a per-turn marker file. After the model replies, a `Stop` (Codex/Claude) or `AfterAgent` (Gemini) hook checks two deterministic things — never re-doing any semantic judgment in shell:

- **Was a review required?** → the per-turn marker file exists.
- **Did the model run it through the right path?** → the reply contains a receipt line with either `mode=background_subagent` or, only when no subagent tool exists, `mode=fallback_no_subagent`.

If required but the receipt is missing, the backstop forces exactly one continuation turn. A loop guard (`stop_hook_active`, or a file counter on Gemini where that flag is broken in 0.30.0) ensures it blocks at most once. And because the queue is only cleared by a successful review, a review that silently dies simply re-fires after the cooldown.

**Honest boundary:** whether the reviewer classifies each queued message correctly is still a model judgment — but it now happens once per batch with full hindsight, instead of once per keystroke with none, and a wrong "skip" costs nothing (the message stays reviewable in history) while a wrong "reflect" no longer interrupts your work.

## Reflection Contract

Nothing is injected on normal turns. When a batch review comes due, the injected instruction requires the active model to start a background reviewer subagent, which inspects the queued messages in any language and reflects only on those that are retrospective feedback: dissatisfaction with, or correction of, something the agent already produced, or a requirement repeated because it was previously ignored. Prospective constraints on new tasks (“must include…”, “记得一定要…”) are normal instructions, never feedback; when uncertain the reviewer must prefer skipping. A review that finds zero real feedback is the expected healthy outcome and produces no report and no rule.

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
- a true background subagent as the default path wherever the active agent exposes one (for example Claude Code Task or Codex multi-agent tools); the main session must not perform the full reflection itself when that tool is available;
- no-subagent fallback only when the runtime exposes no true background subagent tool, recorded with `mode=fallback_no_subagent`;
- subagent close/release after reflection reports are consumed, when the runtime exposes a close/release operation;
- `released_agent_ids` or an explicit CLI limitation note;
- project-specific rules in `.agent/rules/feedback-loop.md`;
- project rules are written by default, without asking again, when the finding is `agent_fault` with evidence, medium/high confidence, and a concrete future prevention constraint;
- global promotion only for `Blocker + agent_fault + generalizable + cross-project evidence`.

## What It Does Not Do

- It does not start a background service.
- It does not call an LLM from JavaScript.
- It cannot create a Codex/Claude/Gemini subagent from shell by itself; it injects a hard requirement, and the active agent must use platform subagent tools when available. Codex command hooks currently do not run `agent` handlers, Claude `type:"agent"` hooks are blocking rather than no-impact background work, and Gemini hooks currently support command hooks only, so the portable path is command-hook injection plus a Stop/AfterAgent backstop.
- It does not upload conversation content.
- It does not force every correction into a rule.
- It does not edit `AGENTS.md` or `CLAUDE.md` by default.

## Supported Platforms

### How it works in one sentence

The moment you press enter, the hook silently records your message to the queue. When a batch review comes due, it slips a short instruction ("review the queued messages for real feedback — reflect on what you find") into the message **before it reaches the model**. The model reads that instruction and delegates the review. The whole thing lives or dies on one thing: **can we get text in front of the model?**

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

当用户表达重复出错、漏上下文、跳过流程或强烈不满时，agent 会反思:**完整反思写进文件**(`.agent/reflections/`),回合里**只留一行**“已识别问题、反思已存到某文件”的摘要,然后**继续处理当前的修复**——反思既不打断用户的补救,也不会用一墙报告淹没主会话。平台有真正的后台 subagent(如 Claude Code 的 Task 或 Codex multi-agent 工具)时,必须先委托后台跑,不能由主会话自己做完整反思；只有运行时没有真正后台 subagent 工具时,才允许文件报告 fallback。

触发方式是**延迟批量评审**,不是逐条判断:hook 不判断任何消息内容,只把每条用户消息静默记录到 `~/.agent/feedback-loop/queue/<项目>.jsonl`(零 token 成本)。只有队列到期时(默认攒够 5 条、或最早一条超过 4 小时,且距上次评审超过 15 分钟)才注入一条批量评审指令,由后台 subagent 带着"事后视角"通读积压消息,只对**回顾性反馈**反思——即针对 agent 既有产出的不满/纠正,或被重复提出的要求;对新任务的前置要求("记得一定要…"、"不要…")一律不算反馈,拿不准就跳过。评审完成后清空队列。队列落在磁盘上、跨会话存活:反思会延迟,但不会被忘记。

### 三层结构:静默队列 + 到期评审 + 硬兜底

"这条消息是不是反馈"逐条判永远判不准——词表列不全,语义 gate 又会把前置约束误判成纠错,而且每轮都烧 token。所以干脆不逐条判:

- **第一层 静默队列(提示时,`core-hook.sh`)**:每条消息追加进项目队列,普通回合**什么都不注入**。没有词表,没有语义 gate,没有误报。
- **第二层 到期评审(提示时,同一个 hook)**:队列到期才注入一条批量评审指令,并写下"本轮要评审"的标记文件。评审 subagent 看的是一段时间内的全部消息,能看到"要求有没有被重复提"、"用户有没有对产出提出不满",判断天然比单条准。阈值可用 `AGENT_FEEDBACK_LOOP_REVIEW_MIN_ENTRIES` / `AGENT_FEEDBACK_LOOP_REVIEW_MAX_AGE` / `AGENT_FEEDBACK_LOOP_REVIEW_COOLDOWN` 调。
- **第三层 硬兜底(回合结束,`stop-hook.sh`)**:模型答完后,`Stop`(Codex/Claude)/`AfterAgent`(Gemini)hook 做两个**确定性**检查(绝不在 shell 里做语义判断):① 本轮要评审吗 → 标记文件在不在;② 评审跑了吗 → 回复里有没有凭据行 `<!--afl-reflection:done responsibility=...-->`。**该评审却没凭据 → 强制重来一轮**,防死循环保证只打回一次。队列只由评审成功后清空,评审悄悄失败的话冷却期过后会自动重新触发。

**诚实边界**:评审 subagent 对每条消息的分类仍是模型判断——但它从"每次按键都无上下文地判一次"变成了"每批带完整前后文判一次";判成"跳过"错了没有任何代价(消息还留在历史里),判成"反思"错了也不再打断你的工作。

反思报告默认使用中文；如果用户在接入或当前请求里明确指定其他语言，则按用户选择的语言输出。

核心原则：

- 不启动后台服务。
- 不用 JavaScript 调大模型。
- shell hook 不能自己创建 Codex/Claude/Gemini 内部 subagent；它只注入硬性要求，当前 agent 必须优先调用平台提供的后台 subagent 工具。没有后台 subagent 能力时才允许 `mode=fallback_no_subagent`。
- 不把反思逻辑写死在代码里。
- hook 只负责记录队列和注入到期评审指令，Markdown prompt 负责完整反思流程。
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

如果要调整评审阈值文案或到期评审指令，再改共享规则文件：

```text
~/.agent/feedback-loop/hooks/trigger-rules.sh
```

`core-hook.sh` 通过 `--event` / `--continue` 参数为三个 CLI 输出各自需要的 JSON。

### 支持哪些 CLI（大白话）

**这套机制的命根子:能不能往「模型的上下文」里塞字。** 你按下回车那一刻,hook 先把消息静默记进队列;等评审到期,它在消息送进模型之前偷偷塞进一段指令(「把积压的消息交给后台评审,发现真反馈就反思」)。模型读到这段字,评审才会发生。

```
用户输入 ──▶ [hook 塞入反思指令] ──▶ 模型看到「你的消息 + 反思指令」
```

字塞不进去,模型就看不到,这工具就是个摆设 —— 这正是最初「没生效」的原因:Codex 当时用的字段只显示在界面上,模型根本读不到。

**Tier A —— CLI 给了塞字的口子(接入即可用):** Codex / Claude / Gemini 都提供「模型可见 hook」,我们的文字能真的进模型上下文。三家共用一个 `core-hook.sh`,再加一个这类 CLI 只需在 `src/index.mjs` 注册表里**加一行**。

**Tier B —— 没有这个口子:** 有些 CLI 要么没有 hook,要么 hook 只能动界面/日志、塞不进模型上下文。结果一样:指令到不了模型,反思不会发生。**这是那个 CLI 自己的设计边界,不是更聪明的代码能绕过的 —— 所以叫外部限制。** 唯一退路是外层 wrapper(`afl run -- <cli>`,把 CLI 包在外面自己拼 prompt),但要逐个适配、且要改用 `afl run` 启动,不算「接入即可用」,本次也没做。

## License

MIT
