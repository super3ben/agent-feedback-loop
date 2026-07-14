# Agent Feedback Loop 中文说明

面向 **Codex、Claude Code、Gemini CLI** 的本地长期反馈记忆插件。

**当前仓库版本：`0.7.0`**

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

## 两种 reviewer 模式

### 零配置提示委派

Codex、Claude、Gemini 的模型可见 hook 在评审批次到期时，只注入一次“启动真正后台 subagent”的要求。
主会话只允许提交回执，不允许自己代做完整反思。平台没有 subagent 工具时，job 保持 pending 并报告
`reviewer_unavailable`，不再使用主会话 fallback。

这个模式接入即可用，但能力会诚实标记为 `delegated_unattested`：一次性 capability 能防回放和半写文件，
却不能从 shell 层密码学证明某个 id 确实由宿主原生 subagent 调度器签发。

### 可选短生命周期 reviewer 进程

`AGENT_FEEDBACK_LOOP_REVIEWER_COMMAND` 不是错误或必填项，而是可选的 reviewer 可执行命令。配置后，
运行时会启动短生命周期独立进程，并通过以下环境变量传入受限上下文：

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
- Minor 永不加载；Major 必须命中任务类型、路径、工具或中英文 signal；Critical/Blocker 在适用范围和
  context epoch 内加载一次。
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
  reviewer-receipts/                  原子回执交接
~/.agent/feedback-loop-keys/          0700；fallback key 为 0600
```

提示委派回执必须是当前用户拥有的普通 `0600` 文件，包含 `write_complete=true`、后台 agent id 和未过期的
一次性 capability。报告、lesson revision、active projection、effectiveness、队列确认和 capability 消费在
一个事务里完成。仅写 Markdown 或输出隐藏 marker 不算完成。

## 常用命令

```bash
agent-feedback-loop doctor --live
agent-feedback-loop capture status
agent-feedback-loop memory list [project-id]
agent-feedback-loop memory promote <lesson-id> [project-id]
agent-feedback-loop gc run
agent-feedback-loop paths
```

关键配置：

```text
AGENT_FEEDBACK_LOOP_REVIEW_MIN_ENTRIES=3
AGENT_FEEDBACK_LOOP_REVIEW_BATCH_MAX=24
AGENT_FEEDBACK_LOOP_REVIEW_MAX_AGE=3600
AGENT_FEEDBACK_LOOP_REVIEW_COOLDOWN=900
AGENT_FEEDBACK_LOOP_REVIEW_WAKE_COOLDOWN=300
AGENT_FEEDBACK_LOOP_RETENTION_DAYS=10
AGENT_FEEDBACK_LOOP_MEMORY_BUDGET=<可选绝对预算覆盖>
AGENT_FEEDBACK_LOOP_DEBUG=1
AGENT_FEEDBACK_LOOP_LOG=<路径>  # 默认 data/logs/runtime.log，权限 0600
AGENT_FEEDBACK_LOOP_REVIEWER_ENV_ALLOWLIST=<逗号分隔变量名>
```

诚实边界：提示委派不能认证原生 subagent 身份；prompt-only 宿主也不能声称已经建立工具级 hard gate。
需要进程隔离时配置独立 reviewer command；需要确定性危险操作拦截时，还必须由宿主提供可验证 tool hook。

当前 `0.7.0` 有 89 项自动化测试，其中包含三轮端到端场景：采集反馈、事务提交经验证 lesson，并在下一次
匹配任务中注入。测试数量会随覆盖范围变化，发布前仍应实际运行测试，而不是把该数字当作永久徽章。

[返回英文 README](README.md)
