## 背景与现状

0.7.6 已经具备事务型 reviewer 和 notification outbox，但跨越了两个不安全边界：

1. runtime 在 `UserPromptSubmit.additionalContext` 中注入指令，让主模型逐字复述回执；
2. Stop hook 没看到模型生成的 marker 时返回 `decision=block`，强制再生成一轮 assistant output。

`additionalContext` 是模型上下文，不是专用通知通道，因此无法同时保证“回执一定出现”和“业务回答绝不受影响”。commentary/final 的分离以及宿主渲染方式都不受 AFL 控制。同一种概念错误也存在于 lesson selector：本地 Top-K/Token 上限被当成非法记忆状态，注入的 hold 又声称后台 compactor 正在工作，实际却没有创建任何 compaction job。

现有 store 仍有可复用基础：持久事件、带租约 reviewer job、不可变 lesson revision、notification outbox、delivery receipt、transcript reconciliation 和独立租约的 system notifier。本设计保留这些基础，但把状态归回正确子系统。

## 目标与非目标

**目标：**

- 正常业务输出独立于 AFL 回执、reviewer、selector 容量与 maintenance 状态。
- 通过能力感知的 transport 投递终态通知，不再要求主模型回显控制文本。
- 为每个投递状态建立真实 acknowledgement 边界：queued、transport-accepted、transcript-observed、failed、unsupported 或 audited-only。
- 把相关纠正归并为一个因果 feedback episode，并最多创建一个 immediate reviewer job。
- 在有界容量内选择最强适用记忆，返回明确 omission diagnostics，而不是全局 hold。
- 用持久 job、租约、重试、校验、lineage 和原子发布实现真实 memory maintenance。
- 从 schema v8 保守迁移，不丢失 reviewer、lesson、receipt 或 audit evidence。

**非目标：**

- 不保证缺少直接 append API 的宿主一定能在聊天中显示内联回执。
- 不把 app-server acknowledgement 当成用户已经看到回执的证明。
- 不在同步 prompt/Stop hook 路径调用语言模型。
- consolidation 期间不删除历史 lesson 或报告。
- 不自动解决无法通过确定性安全校验的语义矛盾。
- 不把 maintenance worker 扩展成与本问题无关的通用分布式任务框架。

## 架构决策

### 1. 建立 non-interference 边界

事务型 Stop hook 只负责采集 assistant output、对账 delivery observation 和返回宿主 no-op success schema。无论 receipt、reviewer、lesson 或 maintenance 处于什么状态，都不得输出 `block` 或 `deny`。`UserPromptSubmit.additionalContext` 只允许承载真正适用的 lesson 内容，不得包含回执、维护状态声明或通用纠正指令。

拒绝方案：继续增强 transcript 扫描，使 Stop 能在 commentary 中找到回执。该方案仍把 model response 当成通知 transport，未来宿主格式变化仍可能阻断业务回合。

### 2. 按 transport 规范化通知状态

`notification_outbox` 继续作为语义事件源。原先混在一行里的 chat/system 可变列迁移到 `notification_deliveries`，主键为 `(notification_id, transport)`，初始 transport 包含 `codex_thread`、`system` 和 `audit`。每行拥有独立 leased lifecycle，并明确分开 `accepted_at` 与 `observed_at`。

Codex adapter 先探测本地 app-server 协议；只有精确解析当前 native session 后，才调用 `thread/inject_items` 追加一条有界 synthetic assistant item。JSON-RPC 成功只表示 `accepted`，不表示 `observed`。transcript reconciliation 后续看到稳定 synthetic marker 才能写 `observed`。adapter 不可用或拒绝请求时，终态通知退到 system notifier，并持续通过 `review list/show` 可审计。

Claude Code 和 Gemini 在没有通过等价能力验证前，只启用 `system` 与 `audit`。任何 adapter 都不得 fallback 到 prompt injection 或 Stop block。

默认只主动推送 reviewer 终态。candidate/queued transition 仍作为审计事件存在，从源头降低噪声并移除“prompt 时必须同步投递回执”的错误动机。

拒绝方案：所有宿主只用侧通道。它虽然安全，但会放弃 Codex 已提供的 append capability。能力门控可以在保持安全属性的同时，允许已验证宿主获得内联可见性。

### 3. 引入因果 feedback episode

被捕获的 session event 只是 observation，不自动成为 feedback candidate。新增 `feedback_episodes`，保存 root assistant referent、session/context epoch、signal strength、lifecycle 和 reviewer job；`feedback_episode_events` 关联后续 steering/correction event。

结构信号分类如下：

- AFL synthetic control item：排除；
- 普通 prompt/follow-up：仅捕获；
- active-turn steering：弱 episode evidence，等待 turn close/debounce；
- 宿主确认的 interruption 或显式 feedback event：强 episode evidence；
- episode open 时、同一 causal referent 的后续纠正：合并到原 episode。

只有强 episode 关闭或 debounce 到期时，才允许创建一次 immediate reviewer job。唯一性边界是 episode id，而不是 prompt text 或 hook invocation。已 reviewed 的 episode 不能因普通追问重新打开；只有新的 assistant referent 才能建立新 episode。

拒绝方案：继续增加自然语言反馈关键词。关键词无法稳定跨语言，也不能证明因果关系，仍会把“为什么 AFL 出现这个”一类运维询问变成 reviewer job。

### 4. 把 selection limit 视为 ranking constraint

Lesson selector 返回 `{cards, omissions, diagnostics}`。适用且无冲突的 lesson 按 severity、精确 scope evidence、recurrence、confidence、revision 与 lesson id 建立确定性全序，再在 card 数量和 Token 预算内贪心选择。

超出数量、单卡过大或总预算耗尽时，记录 omission reason，并可请求 maintenance；不得清空已选卡片，也不得返回全局 hold。真正冲突的 family 只隔离自身，其他安全 lesson 继续选择。记忆指导本身不构成阻断宿主业务回合的授权。

### 5. 增加真实 maintenance 状态机

Schema v9 新增：

- `memory_maintenance_jobs`：type、family/project scope、status、owner、attempt、lease epoch/expiry、reason、input digest 与时间戳；
- `memory_maintenance_job_events`：claimed、requeued、completed、failed、retry exhausted；
- `memory_maintenance_inputs`：不可变 source lesson/revision 引用；
- `lesson_lineage`：source/target lesson revision、relation、maintenance job 与时间戳；
- `feedback_episodes`、`feedback_episode_events`；
- `notification_deliveries`。

重复 omission、oversized card、同 family 多个 active projection 或显式 conflict 会幂等创建 maintenance job。worker 复用现有 detached-provider 启动机制，但使用 maintenance 专用输入/输出契约。发布前必须验证：card 字段完整、体积有界、覆盖全部 source、severity 不低于 source 最大值、没有无证据扩大 scope、lineage 完整。通过后在一个事务中发布 target，并把 source 标为 superseded 而非删除。

若 source 矛盾且确定性校验无法同时保留约束，job 结束为 `needs_human_resolution`；相关 family 继续隔离，不发布虚假 consolidation。

### 6. 保守且可观察地迁移

Schema v8 notification row 全部保留。已有 `chat_state/system_state` 复制到 per-transport delivery，旧模型回显标记为 `legacy_model_echo`。未完成的旧 chat row 迁移为 `audited_only`，不再重放进会话；`chat_block_attempted` 作为历史审计信息保留。

已有 reviewer job 各自获得一个 synthetic feedback episode 便于追溯；已完成 job 保持完成，不重新调度。历史 `memory_overflow_hold` 只有在重新执行当前 selector 并确认 source revision 后，才允许创建 maintenance job。

## 风险与取舍

- **`thread/inject_items` 被接受但桌面端未立即显示。** → 只记录 `accepted`，等待 transcript observation，并以 system/audit 补偿，不宣称用户已看到。
- **hook 内连接 active app-server 可能死锁或命中错误 thread。** → prompt/Stop 同步进程绝不调用 native adapter；scheduler 使用精确 native session identity 和严格 timeout 异步 drain。
- **减少 immediate job 会延迟单次纠正的学习。** → strong interruption/explicit-feedback 仍即时；weak steering 在 turn 结束后 debounce review。
- **非阻断 selection 可能省略重要 severe card。** → severity-first 确定性排序、omission telemetry、真 enforcement gap 的 system notification 与自动 maintenance 保持可观察性。
- **自动 consolidation 可能削弱安全指令。** → 不可变 source、severity/scope 校验、bounded output、事务发布和 `needs_human_resolution` 阻止不安全合并。
- **schema migration 可能产生含糊 legacy delivery。** → 使用具名 legacy transport 保留事实；没有 transcript evidence 时绝不从 `accepted` 升级为 `observed`。

## 迁移与回滚计划

1. 增加 schema v9 表，把 delivery/episode audit data 迁移完成，但不改已安装 hook。
2. 加入新 selector 与 episode routing，并对新库和 schema-v8 数据库副本运行 migration、unit、concurrency 与 recovery test。
3. 增加异步 transport/maintenance worker；在 disposable task 和长期 task 上验证 Codex native delivery，再验证 fallback。
4. 修改 prompt hook，只注入 selected lesson context；修改 Stop hook为 capture-only fail-open。
5. 原子安装新 managed runtime，执行 `doctor --live` 与真机矩阵，证明不再产生 Stop block 或 model-echo instruction。
6. 回滚只切换 `current.json` 到上一 runtime。schema v9 全部为 additive table，旧 runtime 会忽略；不删除迁移后的审计数据。

## 尚待真机回答的问题

- Codex desktop 对异步注入 assistant item 是否立即渲染，必须由 live acceptance 证明。若只 `accepted` 而未 `observed`，状态机已经定义了真实处理方式。
- Claude Code/Gemini 在没有公开并通过等价 native append contract 前，不启用 native adapter。
