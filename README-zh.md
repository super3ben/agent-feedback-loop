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

### 自然语言不满覆盖

识别不满不再依赖固定的负面关键词（如"做错了""不合理"）。三层机制覆盖词表与判断
之间的空隙：

1. **扩展词表路由。** 自然语言表达的抱怨——被要求重复已知信息、对反复出现的
   问题不耐烦、以及质问式追责（"怎么又不知道了"）——直接进入 detached full
   reviewer。
2. **LLM 回退分类器。** 词表未命中但带助手 referent 的消息交给 detached 二元
   分类器（`classify-feedback`），先给理由再输出 `{"dissatisfied": true/false}`。
   Yes 放行给 reviewer，No 丢弃。分类器被明确告知：助手的辩解不能作为用户没有
   不满的理由——一句"连不通"糊弄不了判定。纯操作对话（"继续""好的""等等"）
   整句命中即跳过，不发调用。由于分类器按每条带 referent 的消息触发，codex
   调用会注入与 reviewer 相同的网关路由；缺了它所有 codex 分类都会挂到超时。
3. **确定性升级。** reviewer 反复用新借口（事后纠正、"还没部署"、前瞻建议）
   拒绝沉淀同一家族时，不再由它说了算：同族在 14 天窗口内被拒 ≥3 次后，下一次
   拒绝会被替换为用累计拒绝记录合成的 Major 经验并直接发布。已有已发布教训的
   家族交给正常复发机制，不堆积重复的 meta-lesson。

   **DeepSeek Harness（`dsh`）覆盖：** `install` 自带一个独立的 dsh 原生插件
   （`dsh-plugin/`），并按 `dsh plugin add` 的同一方式接线到 `~/.dsh/profiles/`
   下的每个 profile（node_modules symlink、`link:` 依赖、
   `dsh.profile.bundles` 登记）——不依赖任何桥接包。插件把每条
   prompt 喂给 `core-hook.sh`，并把编译好的规则区块注入回 harness。harness 不
   暴露 transcript，因此无法携带 transcript 的方言，其 prompt 也会送分类器
   而不是被静默丢弃；能带 transcript 的会话在尚无 referent 时（首轮）仍保持
   跳过。dsh 来源的评审/分类子进程运行在宿主 CLI 上（claude，其次 codex、
   gemini）。

### 从发布到下次会话生效

发布不等于送达。三条通道把教训带给后续会话：

- reviewer 合同把用户的明确事实陈述当作必须先核查再反驳的主张，把超出用户
  明确范围的扩大执行（即使事后纠正）判定为 agent 责任。
- 达到 `Major+3` / `Critical+2` / `Blocker+1` 复发次数的家族会被编译进
  `.agent/rules/feedback-loop.md` 的托管区块。
- prompt hook 每轮把该托管区块注入上下文（上限 6KB），复发足够多的规则每一轮
  都被看到——机械保证，不依赖模型自觉打开文件。

### Reviewer provider 环境

detached reviewer 在被剥离的环境中运行宿主 CLI（`codex`、`claude` 或 `gemini`）。
只有 `PATH`、`HOME`、`TMPDIR`、`LANG`、`LC_ALL`、`LC_CTYPE`、`TZ` 以及任意
`AFL_REVIEW_*` 变量会传入 reviewer 进程。若某个 CLI 用自己的持久化凭据认证（例如
`~/.codex/auth.json`，或 `~/.claude/settings.json` 里的 token），则无需额外配置即可
工作，因为这类状态由 CLI 自身加载，不依赖从 shell 继承。只有当某 provider 纯粹靠
shell 环境变量认证时——例如把 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` export
到 shell 而不是存在 CLI 自己的配置里——才需要通过
`AGENT_FEEDBACK_LOOP_REVIEWER_ENV_ALLOWLIST`（逗号分隔的白名单）放行这些变量名；
其值还必须列出 `AGENT_FEEDBACK_LOOP_REVIEWER_ENV_ALLOWLIST` 和
`AGENT_FEEDBACK_LOOP_REVIEWER_TIMEOUT_MS` 本身，才能传入 detached 进程。单次审查
超时默认 300000 ms，claim lease 跟随超时伸缩，大证据量的审查跑几分钟也不会被
中途掐断或以 lease 丢失作废；真实 provider 需要更长时间时用
`AGENT_FEEDBACK_LOOP_REVIEWER_TIMEOUT_MS` 再调高。

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

执行守卫已退役（2026-08-31）。它为 GPT 时代在 review-then-improve 循环里绕圈的运行
设计；实测当前会话中误拦截的代价高于它抓到的真复发。两端的 `PreToolUse` hook 均已
卸载，运行时调度也已在 `src/cli.mjs` 中注释——即使 hook 被重装，所有调用都会直接
放行。store、hook 逻辑与测试保留在代码库中；恢复需要还原该调度并重装 hook。

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

### DeepSeek Harness（`dsh`）

若存在 dsh home（`~/.dsh/profiles/`），`agent-feedback-loop install` 还会把独立
原生插件接线到每个 harness profile：插件复制到 `<packRoot>/dsh-plugin/`，链入
profile 的 `node_modules`，添加 `link:` 依赖，并在 `dsh.profile.bundles` 登记
——与 `dsh plugin add` 的最终状态一致，且重复安装幂等。插件由自带的 bundle
patch 层激活；`install` 绝不写 profile 的 `cordis.patch.yml`（那里的手动行会与
bundle 层在 loader entry id 上冲突，harness 将拒绝启动）。bundle 登记机制之前
的旧安装会被自动迁移：其写入的托管 patch 行会被移除。

安装后需重启 harness，运行中的实例才会加载插件。dsh home 跟随安装 home
（真实用户即 `~/.dsh`）；用 `--home` 指向一次性目录即可在不触碰真实 profile
的情况下试接线。

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
