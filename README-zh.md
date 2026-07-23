# Agent Feedback Loop 中文说明

面向 Codex、Claude Code、Gemini CLI 的本地提示时反馈学习与能力受限的收敛控制。

**运行时版本：`0.9.0`**

## 反馈学习

1. prompt hook 捕获合格的用户不满后立即返回宿主。
2. 分离的 feedback reviewer 可在稍后读取有界本地证据。
3. 合法 reviewer 结果发布为项目 `.agent/reflections/` 下不可变 Markdown。
4. 后续匹配的提示直接读取少量适用 Markdown 文档。

当前提示永不等待 feedback reviewer。处理开始时固定 publication cutoff，因此处理中
新发布的文档只能影响后续匹配的提示。精简 control SQLite 数据库只保存生命周期
状态，不保存 lesson 正文。这是直接 Markdown 选择，不是 RAG。

### Reviewer provider 环境

detached reviewer 在被剥离的环境中运行宿主 CLI（`codex`、`claude` 或 `gemini`）。
只有 `PATH`、`HOME`、`TMPDIR`、`LANG`、`LC_ALL`、`LC_CTYPE`、`TZ` 以及任意
`AFL_REVIEW_*` 变量会传入 reviewer 进程。若某个 provider 需要额外变量——例如经由
第三方 `ANTHROPIC_BASE_URL` 网关中转的 CLI——否则会 fail-closed 并静默超时。通过
`AGENT_FEEDBACK_LOOP_REVIEWER_ENV_ALLOWLIST`（逗号分隔的白名单）放行这些变量名；
其值还必须列出 `AGENT_FEEDBACK_LOOP_REVIEWER_ENV_ALLOWLIST` 和
`AGENT_FEEDBACK_LOOP_REVIEWER_TIMEOUT_MS` 本身，才能传入 detached 进程。单次审查
超时默认 180000 ms；真实 provider 需要更长时间时用
`AGENT_FEEDBACK_LOOP_REVIEWER_TIMEOUT_MS` 调高。

## 收敛控制

Convergence Probe 与 feedback reviewer 职责不同。reviewer 判断真实用户不满是否值得
形成可复用 Markdown 方法；Probe 只在确定性的 Convergence Breaker 触发后提供有界
语义建议。Probe 不能修改 contract、提升重要性、重置历史、创建 hard gate 或签发
continuation grant。

Breaker 根据已验证的外部事实判断，例如：决策依据未变却重复修改、同一 invariant
没有新证据、方向振荡、触及明确排除项、无依据扩大架构、验收通过后继续扩张，以及
正式 review 重复失败。`routine` 在第一次已验证的无证据扩张时暂停；`important`
至多获得一次可证伪探索预算；`critical` 每一代都必须增加与风险直接相关的新验证
证据，并不享有无限探索。

执行强度受适配器真实边界限制：

- SDD 在 review/fix 调度边界提供 `workflow_gate`。
- 已批准且 revision 匹配的 OpenSpec、Comet 在 task 之间提供 `checkpoint_gate`。
- 通用 prompt 观察仅为 `audit_only`，上限是 warning。

这些能力都不声称可以通用、实时地阻断任意工具。系统没有 Stop/AfterAgent 收敛 hook、
用户可见 grant/receipt、常驻服务、scheduler、数据库 lesson 正文或 learning/RAG reader。

独立的 convergence effectiveness → Markdown 自动发布仍然延期。它必须先具备命名的
workflow producer、有隐私边界的 evidence envelope，以及独立批准的 learning-job
authority/result contract。目前只有真实用户不满触发的 feedback reviewer 可以自动
生成 Markdown。

## 安装与诊断

需要 Node.js 24.15 或更高版本。真实全局安装或修改真实 HOME 配置前，必须取得授权。

```sh
npm install -g agent-feedback-loop
agent-feedback-loop install --dry-run
```

先使用临时 HOME；这里只安装临时 runtime 与 schema，不修改真实用户配置：

```sh
tmp_home="$(mktemp -d)"
agent-feedback-loop install --home "$tmp_home"
agent-feedback-loop doctor --home "$tmp_home" --live
agent-feedback-loop uninstall --home "$tmp_home"
rm -rf "$tmp_home"
```

安装只复制 package assets、选择 runtime、迁移所选 control schema，并配置既有 prompt
hooks。它不会注册 Stop/AfterAgent hook，不会导入 Guard state、激活 Guard authority、
切换仓库权威、启动服务或创建 learning reader。

`doctor` 返回 `{ version, status }`。`status.ready` 仍是 prompt/Markdown 路径的门。
`status.convergence` 分开报告：

- code/package 是否可用；
- 已选择的安装 runtime、schema、provider、Probe assets 和当前平台支持；
- `audit_only`、`checkpoint_gate`、`workflow_gate` 适配器能力；
- repository authority；除非另一次显式的仓库绑定检查能够证明，否则为 `unknown`。

package 存在或静态 doctor 通过，不能证明 live provider 成功、Linux 原生验收、真实
cutover、通用实时阻断或生产有效性。

## Guard 迁移与回滚

身份初始化是独立且需显式授权的步骤。它只会在 Git common directory 中创建或复用
owner-private 的 `afl-lineage-id`；不接受旧 state 或 HOME 输入，不创建 AFL control
store、不导入 state、不切换权威，也不修改 hook。然后再对旧 Guard state 做无写入检查：

```sh
agent-feedback-loop lineage-init --repo-root "$PWD" --apply
agent-feedback-loop guard --repo-root "$PWD" import \
  --state-file .superpowers/sdd/review-loop-state.json --dry-run
```

受控顺序是显式身份初始化、只读 dry-run、单独授权的 import、有界 shadow parity、
单独授权的逐仓库 cutover，以及完整 snapshot rollback。import、shadow、cutover、
rollback 都是显式的机器可读命令，不做长期双写。真实 import/cutover、全局 SDD
Skill 修改和 runtime canary 都需要各自的用户授权；安装不会自动执行。

旧反馈导出仍然显式且对源数据库只读：

```sh
agent-feedback-loop legacy-export --source-db /absolute/legacy.sqlite3 \
  --output-dir /absolute/export --dry-run
agent-feedback-loop legacy-export --source-db /absolute/legacy.sqlite3 \
  --output-dir /absolute/export --apply
```

prompt hook 回滚时，先检查 `agent-feedback-loop uninstall --dry-run`，获得授权后再执行
`uninstall`。它进入关闭 hooks 的状态，同时保留 durable control 数据和密钥，除非
操作员另行删除。

## 证据状态

代码测试、package inventory、临时安装 runtime、仓库 Guard dry-run、已授权 cutover
canary 和生产有效性是不同证据状态。前一层通过不能被报告成后一层完成。

结构化日志只包含固定事件名、有界 reason code、计数及 opaque 标识符或 hash；不得包含
原始 prompt、diff、reviewer/Probe/state 正文、token、grant artifact 内容或绝对项目路径。
