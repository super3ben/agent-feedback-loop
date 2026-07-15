# Agent Feedback Loop 中文说明

面向 **Codex、Claude Code、Gemini CLI** 的本地长期反馈记忆插件。

**当前仓库版本：`0.7.5`**

它不是简单“记录一份反思 Markdown”，而是形成可验证闭环：

```text
采集用户与助手证据
  -> 延迟批量评审
  -> 后台 reviewer
  -> 结构化安全回执
  -> 报告与 active lesson 事务落库
  -> 后续任务按严重度/范围选择行动卡
  -> 记录 application / delivery observation
  -> 同类复发时审计学习控制链为何失效
```

普通回合只做本地 SQLite 读写和选择，不逐条调用模型判断“用户是否不满”，也不调用远程 token API。

## 安装

需要 Node.js 24.15 或更高版本：

安装 GitHub 当前版本：

```bash
npm install -g github:super3ben/agent-feedback-loop#main
agent-feedback-loop install
agent-feedback-loop doctor --live
```

安装 npm registry 已发布的最新版本：

```bash
npm install -g agent-feedback-loop
agent-feedback-loop install
agent-feedback-loop doctor --live
```

npm registry 版本可能晚于 GitHub 仓库。升级后应先看 `doctor --live` 输出的 runtime version 和
schema version，再排查 hook 行为，避免把旧安装态当成当前源码问题。

安装器会备份并接入 `~/.codex/config.toml`、`~/.claude/settings.json`、
`~/.gemini/settings.json`。卸载/升级不会删除长期记忆数据库和密钥。
macOS 还会安装一个轻量 `KeepAlive` LaunchAgent daemon：每 60 秒启动一个有界补扫子进程并等待其结束。
没有到期评审批次时不会调用模型；采用常驻本地调度进程，是为了不再依赖实际运行中可能只执行一次的
`StartInterval`。它不是常驻模型进程。

Codex 仅把 hook 路径写进 `config.toml` 仍然不会执行：非托管 hook 的当前定义必须被信任。安装器会新启动
一个本机 Codex `app-server` 调用 `hooks/list`，只批准刚生成的 prompt/stop 两条完整命令，用
`config/batchWrite` 写入当前 hash，再次读取确认。身份校验同时包含精确 cwd、当前用户 `config.toml`、
source、event name、handler type 和 command，不会顺带信任其他或相似 hook。检查进程完成初始化后若
RPC/配置写入失败，不会再回退到另一版 CLI 制造假健康。但它不能证明已经打开的 Desktop 任务热加载了
新 hook，因此 `doctor` 明确显示 `inspectionScope=spawned_app_server` 与
`activeDesktopState=not_observed`，旧任务由 transcript 补扫兜底。`doctor` 现在分别显示
`configured` 和 `runnable`，只要状态是 `modified`、`untrusted`、`disabled` 或宿主不可检查，即使路径存在
也判为不健康。需要指定明确宿主二进制时可设置 `AGENT_FEEDBACK_LOOP_CODEX_COMMAND`。

Codex/Claude 的 prompt hook 原生超时为 5 秒，Gemini 为 5000 ms。它是本地加密写入与 SQLite 事务的
失败上限，不是每轮固定增加 5 秒；异常仍保持 fail-open，并写入本地受限日志。

## 什么情况触发，什么情况不触发

- 普通提示只做本地采集，不调用模型、不产生额外 token；默认累计 3 条 pending 证据或最老证据达到
  max age 后才建立评审批次。
- 如果新提示紧跟在上一轮 `turn_aborted` 之后，会立即成为评审候选。这只读取 transcript 生命周期事件，
  默认要求中断发生在最近 15 分钟内；不匹配中英文抱怨词，也不逐轮调用 LLM 分类。
- Codex 同一活跃 turn 内可能继续收到用户消息。若 assistant 已经输出，再出现的真实用户消息会成为结构性
  纠偏候选；这是为了提高召回率，并不等于已经判定用户不满。assistant 尚未输出前连续补充两条要求只采集、
  不立即反思。启动 reviewer 之前，hook 会先把该 turn 最近一条可见 assistant 回复作为 referent 持久化，
  不允许纠正事件先消费 job、再让 reviewer 只看到 prompt 而看不到被纠正内容。同一轮只向模型注入一条很短的
  纠偏检查点：立即采用用户纠正并停止已失效路径；完整反思仍由后台 reviewer 无感执行，不在主会话展开。
- 每 60 秒的增量补扫覆盖升级/重载竞态中漏掉 hook 的旧 Codex 任务。优先使用原生 message id，没有 id 时
  使用稳定字节偏移；hook 与 transcript 通过 observation 别名合并，同文重复消息仍保持为两个事件。如果
  Codex 已把消息压缩出普通 `response_item`，解析器只接受结构明确且不超过 8 MiB 的 `compacted` 记录，
  最多恢复 `replacement_history` 中最近 24 条真实用户消息，过滤控制/系统记录，也不会把整段压缩历史注入 reviewer。
- 一次补扫中同一项目出现多条即时纠正时，先完整入库再合并为一个 reviewer job，只启动一个后台模型；
  不会按纠正条数重复消耗 token。补扫游标只保存 turn/id/offset 等结构状态，不保存 transcript 文本。
- 快通道会在同一事务中保证本次纠正进入 reviewer 上下文，并跳过普通项目 review cooldown。尚未唤醒的
  有界 pending job 会被复用，最老已分配证据退回待处理队列而不会删除；如果旧 job 已经唤醒或正在运行，
  则建立独立立即 job，避免已经读取过上下文的 reviewer 漏掉本次纠正。宿主提供 event id 时保持幂等；宿主
  没有提供 event id 时，每次 hook 调用按独立 occurrence 处理，避免同 turn 两条同文消息被错误折叠。
- 每次补扫还会自动重新排队过期 lease 和可重试失败，不需要等下一条用户消息；默认三次后标记
  `retry_exhausted`，不会无限重试。完成回执必须包含非空且有实质内容的报告，空报告或 marker 不能清队列。
- 首条普通提示不会触发；旧中断后已有正常完成回合，也不会走快通道。候选进入后台 reviewer 后仍需判断
  是否真的是对既有产出的回顾性反馈，前瞻新需求不能晋升为 lesson。

Codex 同时使用 hook 与 macOS transcript 补扫。Claude Code、Gemini CLI 在安装后新启动的会话中使用各自
原生 prompt/stop hook；当前版本不宣称为它们提供 Codex 式历史 transcript 补扫。非 macOS 平台仍可使用
hook，但暂未内置定时 transcript reconciler。

Codex 的 `[AFL]` 回执只允许顶层用户 turn 领取。内部子 agent 的 prompt/Stop hook 不采集为用户反馈，
也不能领取或确认父会话回执，因此回执不会再藏进折叠的 subagent 通知。排队回执可在纠正当轮显示；若
reviewer 在该轮结束后才完成，完成回执会在下一次顶层交互显示，因为 hook 不能异步向空闲会话主动插入消息。

## reviewer 执行方式

### 零配置独立 CLI reviewer

评审批次到期后，hook 启动独立的 `reviewer-run` 后台进程并立即返回。运行时自动选择来源对应的 Codex、
Claude Code 或 Gemini CLI 进行 headless 评审，通过受限 `0600` 文件接收证据，输出 schema 校验回执后退出。
主会话不会收到反思提示、不等待、不代写报告。provider 不可用时 job 保持 pending，并记录
`reviewer_unavailable`，不回退主会话。

Codex 使用 ephemeral、忽略用户 hook/rule、只读 sandbox；Claude 禁用工具与会话持久化；Gemini 使用
admin-tier deny-all policy 并关闭 hook/skill/extension。它们是 provider 控制和进程生命周期隔离，不是 OS/网络沙箱。

`doctor` 会分别报告 hook 配置、可运行性、reviewer 可用性、调度器状态和最近一次补扫新鲜度。真实用户目录的
macOS 模式只有在调度器正在运行、五分钟内有成功补扫、且至少一个 reviewer provider 可用时才判 healthy；
缺失的可选 provider 会显示 degraded，不会被另一个可用 CLI 掩盖。`completed_with_errors` 只表示有诊断结果，
不能冒充成功补扫，也不能满足真实用户目录的 healthy 条件。

### 可选短生命周期 reviewer 进程

`AGENT_FEEDBACK_LOOP_REVIEWER_COMMAND` 不是错误或必填项，而是可选的 operator reviewer 覆盖。配置后，
它替代内置 provider，并通过以下环境变量接收受限上下文：

```text
AFL_REVIEW_JOB_ID
AFL_REVIEW_CONTEXT_FILE
AFL_REVIEW_PROMPT_FILE
AFL_REVIEW_SUBMIT_PROTOCOL=stdout_json_receipt
```

进程向 stdout 输出一个结构化 JSON 回执后退出。默认环境会剔除凭据变量；只有
`AGENT_FEEDBACK_LOOP_REVIEWER_ENV_ALLOWLIST` 明确列出的变量会额外传入。这个模式只提供生命周期与
stdout 交接边界，仍然是同一用户权限、可访问普通文件和网络的进程，不是 OS sandbox。需要更强隔离时，
应把 operator 自己的 sandbox/container 命令配置为 reviewer command。

## 反思不是走过场

只有能逐字引用用户回顾性反馈、并指向具体既有 agent 产出的事件才进入反思。新任务前置要求、agent
主动征求草稿意见时的正常纠正都不算反馈；拿不准时宁漏报不误报。

反思深度按字段和证据校验，不按固定字数/token 截断：

| 严重度 | 最低闭环 |
| --- | --- |
| Minor | 只记趋势/报告，不生成 active lesson |
| Major | 完整 5 Why 到过程假设、方法分类、行动卡 |
| Critical | Major + 决策时间线 + 反事实检查点 + 复发 effectiveness |
| Blocker | Critical + 影响面 + 停止条件 + 回滚/隔离 + 全局晋升证据 |

已有 lesson 复发时，reviewer 必须绑定真实 `application_id` 和数据库里的 delivery 状态。
`emitted_unconfirmed` 只能说明 hook 输出过卡片，不能证明模型读到，更不能直接归责 agent 没执行。
它仍可在后续匹配任务中重投，也允许迟到的 nonce 证据把状态更新为 `observed`。

## 避免上下文膨胀和 token 浪费

- 原始证据本地加密，默认保留 10 天；未完成评审的整个 session（含相邻 assistant 参照）不会被 GC 删除。
  transcript 到期后，精简的 review receipt、report、incident 和 lesson 仍作为长期审计/记忆层保留。
- 普通会话不加载完整 transcript、反思报告或 5 Why，只加载完整的小行动卡。
- Minor 永不加载；Major 必须命中任务类型、路径、明确 scope signal/工具名，或与行动卡 `when` 形成
  较强的本地短语重合；单个泛化中文词不会直接命中。宿主没有提供的元数据按“未知”处理，只有已经提供且冲突时才排除。当前任务刚产出的 lesson
  会在下一条提示补注入一次，即使用户只说“继续”；Critical/Blocker 在适用范围和 context epoch 内加载一次。
- 使用本地、中文保守的 token 估算器；预算由完整卡片成本校准，不再写死 320，也不会切断卡片字段。
- Major 放不下时整卡跳过；严重卡放不下时进入明确的 checkpoint hold，而不是假装已经加载。
- 同一 family 的项目版和全局版只加载一个。全局晋升必须有至少两个独立仓库 lineage 的 Blocker 证据。

向量数据库目前不是必需项。结构化 scope 和 receipt 才是正确性边界；未来记忆量很大时，embedding 可以作为
候选召回插件，但不能决定严重度、全局晋升或“模型是否收到 lesson”。因此当前版本没有强制接入向量库。

## 数据与安全

```text
~/.agent/feedback-loop/              版本化运行时与可编辑 prompt
~/.agent/feedback-loop-data/
  store/feedback-loop.sqlite3        事务索引、job、lesson、receipt
  blobs/sha256/                       AES-GCM 加密原始证据
  reviewer-contexts/                  短生命周期 0600 上下文
  logs/reconcile.log                  补扫器诊断日志
~/.agent/feedback-loop-keys/          0700；fallback key 为 0600
```

旧版提示委派回执必须是当前用户拥有的普通 `0600` 文件，包含 `write_complete=true`、后台 agent id 和未过期的
一次性 capability。报告、lesson revision、active projection、effectiveness、队列确认和 capability 消费在
一个事务里完成。仅写 Markdown 或输出隐藏 marker 不算完成。

`password=...`、英文 `password is ...`、中文 `密码是...` 等凭据赋值会从可搜索索引和日志中脱敏；在
凭据提醒语境里，混合型凭据令牌也会脱敏，避免“之前已经提供”这类说法留下可搜索明文。原始证据只保留
在按期限管理的本地加密 blob 中；增量补扫游标不保存用户或助手正文。宿主自己保存的 transcript 不由本插件删除。

运行日志和补扫日志默认达到 5 MiB 时轮转，且不写入原始 prompt/report 正文。即时 hook 结果与后台 reviewer
启动/完成/失败会记录时间和 job id。`memory explain <session-id>` 可查看脱敏后的链路：
`emitted/observed` 表示该会话产出的 lesson 后来是否投递/确认，
`delivered_into_session/observed_in_session` 表示该会话自身是否收到/确认过既有 lesson；命令不返回事件正文。

## 常用命令

```bash
agent-feedback-loop doctor --live
agent-feedback-loop capture status
agent-feedback-loop memory list [project-id]
agent-feedback-loop memory explain <session-id> [--verbose]
agent-feedback-loop memory promote <lesson-id> [project-id]
agent-feedback-loop gc run
agent-feedback-loop reconcile
agent-feedback-loop paths
```

关键配置：

```text
AGENT_FEEDBACK_LOOP_REVIEW_MIN_ENTRIES=3
AGENT_FEEDBACK_LOOP_REVIEW_BATCH_MAX=24
AGENT_FEEDBACK_LOOP_REVIEW_MAX_AGE=3600
AGENT_FEEDBACK_LOOP_REVIEW_COOLDOWN=900
AGENT_FEEDBACK_LOOP_REVIEW_WAKE_COOLDOWN=300
AGENT_FEEDBACK_LOOP_INTERRUPTION_WINDOW=900
AGENT_FEEDBACK_LOOP_RECONCILE_LOOKBACK=900
AGENT_FEEDBACK_LOOP_RECONCILE_INTERVAL=60
AGENT_FEEDBACK_LOOP_RECONCILE_KILL_GRACE_MS=2000
AGENT_FEEDBACK_LOOP_REVIEW_MAX_ATTEMPTS=3
AGENT_FEEDBACK_LOOP_RETENTION_DAYS=10
AGENT_FEEDBACK_LOOP_MAX_LOG_BYTES=5242880
AGENT_FEEDBACK_LOOP_MEMORY_BUDGET=<可选绝对预算覆盖>
AGENT_FEEDBACK_LOOP_DEBUG=1
AGENT_FEEDBACK_LOOP_LOG=<路径>  # 默认 data/logs/runtime.log，权限 0600
AGENT_FEEDBACK_LOOP_REVIEWER_ENV_ALLOWLIST=<逗号分隔变量名>
```

诚实边界：内置 reviewer 是同用户短生命周期进程，不是针对 provider 自身的安全沙箱；更强隔离要配置
operator 自己的 sandbox/container。新启动的 Codex app-server 能验证持久化 hook，不能认证已打开 Desktop
任务的内存态；补扫器负责追平证据，但不会伪称已经热重载。确定性危险操作拦截仍需要宿主的可验证 tool hook。

测试覆盖三轮端到端 lesson 闭环、Codex 精确信任范围、`modified` 健康检查、同轮纠偏正反例、
hook/transcript 竞态去重、有界压缩历史恢复、referent 先于 reviewer 的顺序、reviewer lease 恢复、调度器存活
与强制子进程清理、严格降级健康判断、各 CLI 超时单位和凭据脱敏。发布前仍应实际运行测试，不使用会过期的
固定测试数量徽章。

[返回英文 README](README.md)
