# Comet Design Handoff

- Change: isolate-feedback-control-plane
- Phase: design
- Mode: compact
- Context hash: 009ad80131261e15627d229be13ce9042e03612d963c2b8cc36d2b117151d89a

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/isolate-feedback-control-plane/proposal.md

- Source: openspec/changes/isolate-feedback-control-plane/proposal.md
- Lines: 1-35
- SHA256: c64fcb4172499ceccaaf78c7fdd192cf52a9355a4d90de693fcc1213e39bc206

```md
## 为什么现在必须改

Agent Feedback Loop 0.7.6 让“可观察性”和“记忆执行”控制流侵入了用户的正常业务会话。回执通过模型指令传输，再由阻断式 Stop hook 强制补发；同时，lesson 选择器把本地 Top-K/Token 容量上限错误解释成语义冲突，并声称存在一个实际上没有创建的后台压缩任务。结果是正常回答会被纯回执替换，安全任务也可能因不存在的维护过程被长期挂起。因此，必须先从架构上隔离控制面，AFL runtime 才能被认为可靠。

## 变更内容

- **破坏性变更**：从受支持的投递契约中移除“模型回显回执”和“回执驱动 Stop 阻断”。Stop hook 对所有 AFL 通知状态都只能采集并 fail-open。
- 增加宿主能力感知的通知传输层。Codex 只有在能力探测和真机投递验证通过后才使用 app-server 原生 thread adapter；不支持或不可用的宿主使用操作系统通知和 CLI 审计，不得退回模型指令。
- 用持久化 feedback episode 取代“每条 prompt 立即建 reviewer job”。episode 必须绑定因果 assistant referent 和明确生命周期；普通追问、AFL 运维问题及 synthetic control traffic 本身不能创建新 job。
- 把记忆选择容量与记忆有效性分离。超过 Top-K 或 Token 预算时确定性排序并省略卡片，不再触发全局 hold。
- 增加真实的 memory maintenance 生命周期，覆盖重复项合并、supersession 和真冲突处理，并具备 lineage、租约、重试、审计事件和事务发布。
- 把已有回执与 overflow 记录迁移成语义真实的终态，同时保留 reviewer evidence 和审计信息。
- 扩展结构化日志、doctor、审计命令与真机验收，分别证明投递、episode 归并、选择、维护以及业务回合连续性。

## 能力范围

### 新增能力

- `control-plane-isolation`：保证 AFL 可观察性与执行状态不能替换、延迟或阻断宿主的正常业务回答。
- `capability-aware-delivery`：定义原生通知与侧通道通知、投递 acknowledgement、fallback 规则和真实审计状态。
- `feedback-episode-routing`：定义相关纠正如何归并、何时允许调度 reviewer，以及如何排除 synthetic/运维流量。
- `memory-selection-safety`：定义有界且确定性的 lesson 选择，不把容量溢出解释为冲突或全局任务失败。
- `memory-maintenance-lifecycle`：定义真实后台 consolidation/conflict maintenance job 的 lineage、租约、重试和原子发布。

### 修改已有能力

仓库目前没有既有 OpenSpec capability。本次变更把当前只存在于代码和 Superpowers 设计文档中的行为正式规格化并替换。

## 影响范围

- Runtime：hook orchestration、capture/reconciliation、receipt/outbox、store/schema、selector、reviewer provider、scheduler、installer 与 host adapter。
- 持久化数据：notification delivery 语义、feedback episode identity、maintenance job/event、card lineage，以及 schema version 8 到 version 9 的迁移。
- 宿主集成：Codex、Claude Code、Gemini CLI hook 输出；Codex app-server 集成必须经过 capability gate。
- 用户可见行为：业务回答不再依赖 AFL 回执；原生投递不可用时走系统通知和审计，而不是 Stop retry。
- 验证：单元、迁移、并发、集成、失败恢复与新旧真实会话测试。

```

## openspec/changes/isolate-feedback-control-plane/design.md

- Source: openspec/changes/isolate-feedback-control-plane/design.md
- Lines: 1-117
- SHA256: c369d72b17c5d011f752a81b84dc9fb609dd0ce5855431f27eed35d87491b7b7

[TRUNCATED]

```md
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

```

Full source: openspec/changes/isolate-feedback-control-plane/design.md

## openspec/changes/isolate-feedback-control-plane/tasks.md

- Source: openspec/changes/isolate-feedback-control-plane/tasks.md
- Lines: 1-57
- SHA256: ecd2ed6a61d3f9456f29b47e3502cebe17227164f5ffcc0a287a2fef31965f0a

```md
## 1. 基线与迁移契约

- [ ] 1.1 固化 schema-v8 失败 fixture：commentary-only receipt、Stop re-entry、重复运维追问、5 张无冲突 severe card 和 oversized severe card。
- [ ] 1.2 为 schema-v9 delivery、feedback episode、maintenance job/event/input 和 lesson lineage 编写 RED migration test，并证明 schema-v8 evidence 全部保留。
- [ ] 1.3 实现 additive schema-v9 migration 与完整性约束，包括历史 `legacy_model_echo` 和 `audited_only` 映射。

## 2. 控制面隔离

- [ ] 2.1 编写跨宿主 RED test，证明 transactional Stop 不因 notification、reviewer、selector 或 maintenance 状态输出 `block/deny`。
- [ ] 2.2 把 Stop capture 重构为 bounded observation + fail-open response，从正常 transactional install 中移除 receipt backstop。
- [ ] 2.3 编写 prompt-hook RED test，证明 model context 不含 receipt、maintenance claim 或 generic correction instruction，同时仍支持 selected lesson。
- [ ] 2.4 从 prompt orchestration 移除 model receipt instruction，并为每个 hook outcome 增加结构化 non-interference log。

## 3. 宿主能力感知的通知投递

- [ ] 3.1 为 per-transport claim、fenced lease、accepted/observed、retry、unsupported 和 semantic idempotency 编写 RED store test。
- [ ] 3.2 实现 transport-neutral notification delivery store，把 notifier/audit query 从内嵌 chat/system 列迁移出来。
- [ ] 3.3 为 Codex app-server initialize、精确 thread targeting、bounded `thread/inject_items`、ack、timeout、reject 和 unavailable 编写 RED protocol test。
- [ ] 3.4 在 capability probe 后实现异步 Codex native adapter，并保证 synthetic marker 被 capture filter 排除且 hook 不同步依赖 adapter。
- [ ] 3.5 终态通知采用 native-preferred/system-fallback；candidate/queued 默认只审计。
- [ ] 3.6 更新 review audit 与结构化日志，分别显示 semantic notification、transport acceptance、transcript observation 和 fallback。

## 4. Feedback Episode 路由

- [ ] 4.1 为普通追问、AFL 运维问题、synthetic hook prompt、同 turn 重复 steering、显式 interruption、重复 reconciliation 与新 referent 纠正编写 RED fixture。
- [ ] 4.2 实现 feedback episode creation、event association、signal strength、debounce/close transition 和 one-job uniqueness。
- [ ] 4.3 用 episode scheduling 取代 per-prompt immediate scheduling；没有新 causal referent 时，closed no-lesson episode 不得重开。
- [ ] 4.4 把历史 reviewer job 迁移为 audit-only episode record，不能重新排队 terminal work。

## 5. 有界记忆选择

- [ ] 5.1 编写 selector RED test：5 选 4、oversized card、conflict/non-conflict 混合 family、确定性重复排序与 prior delivery。
- [ ] 5.2 实现 severity/scope/recurrence/confidence/revision 确定性排序及结构化 omission diagnostic。
- [ ] 5.3 移除由数量/Token 触发的 `memory_overflow_hold`；只隔离真 conflict，并继续返回其他 eligible card。
- [ ] 5.4 持久化 bounded omission telemetry，并为重复容量、尺寸或 conflict 条件幂等请求 maintenance。

## 6. Memory Maintenance 生命周期

- [ ] 6.1 为 maintenance 幂等创建、fenced claim、lease recovery、retry exhaustion、stale submit rejection 与独立 health 编写 RED store test。
- [ ] 6.2 实现 maintenance store API、scheduler recovery、detached worker launch、job event 与结构化日志。
- [ ] 6.3 定义并测试 maintenance provider I/O contract：不可变 source revision、bounded card、source coverage、severity/scope preservation。
- [ ] 6.4 实现 atomic consolidation publication、immutable lineage、source supersession 与 partial failure rollback。
- [ ] 6.5 实现 `needs_human_resolution`，证明矛盾 family 保持隔离但不阻断业务回合。

## 7. 安装、审计与文档

- [ ] 7.1 更新 doctor/live health、`review list/show` 与 memory audit，真实展示 transport、episode、selection omission 和 maintenance 状态。
- [ ] 7.2 更新 installer template 与 managed-runtime compatibility，原子迁移已有配置且不重放历史 receipt。
- [ ] 7.3 更新中英文文档，说明 non-interference guarantee、host capability matrix、fallback、maintenance lifecycle 与 rollback boundary。

## 8. 验证与发布

- [ ] 8.1 执行 targeted RED→GREEN、全量 Node regression、fresh install、schema-v8 copy migration 和并发 scheduler/worker recovery test。
- [ ] 8.2 在真实 Codex desktop task 验证 native acceptance 与 transcript observation 分开记录，并覆盖普通非反馈 prompt。
- [ ] 8.3 验证长期 Codex task 不再出现 model receipt instruction/Stop re-entry，且 5 张无冲突 severe card 不再触发 hold。
- [ ] 8.4 尝试 Claude Code/Gemini 矩阵；native delivery 不支持时必须明确标记，并证明 system/audit fallback 不阻断业务。
- [ ] 8.5 只有 memory checkpoint 允许高风险操作后才安装 versioned managed runtime，执行 `doctor --live` 并保留原子 `current.json` rollback target。

```

## openspec/changes/isolate-feedback-control-plane/specs/capability-aware-delivery/spec.md

- Source: openspec/changes/isolate-feedback-control-plane/specs/capability-aware-delivery/spec.md
- Lines: 1-45
- SHA256: 0fe5cd5e748871c5bf24c75cd3829b0c3badf31fe2d92946da7282c6f952ac55

```md
## ADDED Requirements

### Requirement: Transport-specific delivery truth
The notification system SHALL store delivery lifecycle independently for every attempted transport and SHALL distinguish transport acceptance from transcript observation.

#### Scenario: Native transport accepts a notification
- **WHEN** a native adapter returns a successful append acknowledgement
- **THEN** the delivery is marked `accepted` with its transport acknowledgement and is not marked `observed`

#### Scenario: Transcript later contains the synthetic marker
- **WHEN** reconciliation observes the exact stable marker for an accepted notification
- **THEN** that transport delivery is marked `observed` idempotently

#### Scenario: Delivery state is audited
- **WHEN** an operator runs the review audit command
- **THEN** it reports semantic notification state and each transport state separately

### Requirement: Capability-gated native delivery
A native adapter MUST prove host availability, exact target-session identity, supported protocol, and bounded request completion before attempting delivery.

#### Scenario: Codex native capability is available
- **WHEN** the scheduler resolves the target Codex thread and app-server append capability
- **THEN** it appends one bounded synthetic assistant item outside the main model turn and records the acknowledgement

#### Scenario: Native capability is unavailable
- **WHEN** the host, target session, protocol, or app-server connection cannot be verified
- **THEN** the adapter records `unsupported` or `failed` with a reason code and falls back to an eligible side channel

### Requirement: No model-mediated fallback
No delivery adapter SHALL fall back to prompt-context receipt instructions or Stop-hook retries.

#### Scenario: Every direct transport fails
- **WHEN** native and system delivery both fail or are unsupported
- **THEN** the notification remains available through the audit surface and the business turn remains unaffected

### Requirement: Bounded and idempotent notification delivery
Every semantic notification MUST have a stable identity, and each transport MUST process that identity at most once concurrently through a leased claim.

#### Scenario: Scheduler repeats after acknowledgement
- **WHEN** the scheduler scans an already accepted or observed transport delivery
- **THEN** it does not append or notify the same semantic notification again

#### Scenario: Worker crashes while delivering
- **WHEN** a transport lease expires without a terminal acknowledgement
- **THEN** a later worker may reclaim the same delivery with an incremented lease epoch and stale workers cannot commit

```

## openspec/changes/isolate-feedback-control-plane/specs/control-plane-isolation/spec.md

- Source: openspec/changes/isolate-feedback-control-plane/specs/control-plane-isolation/spec.md
- Lines: 1-34
- SHA256: e966dc6f801875048a946f53957ae2ef78848f59e74463d64b1f38db9de4e9fc

```md
## ADDED Requirements

### Requirement: Business-turn non-interference
The AFL runtime SHALL allow the host's normal business turn to finish independently of notification, reviewer, lesson-selection, and memory-maintenance state.

#### Scenario: Receipt is pending at Stop
- **WHEN** a Stop hook observes a pending or failed AFL notification delivery
- **THEN** the hook returns the host's non-blocking success response and does not request another assistant round

#### Scenario: Reviewer or maintenance is unavailable
- **WHEN** a reviewer or memory-maintenance worker is pending, failed, retrying, or exhausted
- **THEN** the current business turn continues without a Stop block or model instruction to wait

### Requirement: Capture-only Stop contract
Transactional AFL Stop hooks MUST limit their synchronous responsibilities to bounded capture, delivery observation, reconciliation bookkeeping, and fail-open response generation.

#### Scenario: Capture succeeds
- **WHEN** the Stop hook receives a valid host payload
- **THEN** it persists available evidence and returns without emitting `decision=block` or `decision=deny`

#### Scenario: Capture fails
- **WHEN** evidence parsing, storage, or reconciliation fails
- **THEN** the failure is logged with a reason code and the host is allowed to stop normally

### Requirement: Control text is excluded from model instructions
AFL MUST NOT inject receipt reproduction instructions, maintenance status claims, or generic correction commands into the main model context.

#### Scenario: Notification is ready during prompt submission
- **WHEN** `UserPromptSubmit` finds a deliverable notification
- **THEN** the hook response contains no instruction to print or explain that notification

#### Scenario: Applicable lesson exists
- **WHEN** the selector returns an applicable lesson card
- **THEN** the hook may inject only the bounded lesson guidance and provenance nonce, not notification or maintenance control text

```

## openspec/changes/isolate-feedback-control-plane/specs/feedback-episode-routing/spec.md

- Source: openspec/changes/isolate-feedback-control-plane/specs/feedback-episode-routing/spec.md
- Lines: 1-42
- SHA256: 3f9334689778de259812c2c1215f5c846a9768839e706982df082a4abd5aea50

```md
## ADDED Requirements

### Requirement: Captured events are not automatically feedback candidates
The runtime SHALL persist observable user and assistant events independently from the decision to create a feedback episode or reviewer job.

#### Scenario: Ordinary follow-up prompt
- **WHEN** a user asks a new or operational follow-up without a strong structural feedback signal
- **THEN** the event may be captured but no immediate reviewer job is created

#### Scenario: Synthetic AFL control item
- **WHEN** capture encounters a receipt, hook prompt, notification marker, or other AFL-generated control item
- **THEN** the item is tagged synthetic and excluded from episode creation and reviewer evidence

### Requirement: Corrections are grouped by causal episode
Related feedback events MUST be associated with one feedback episode identified by session, context epoch, and root assistant referent.

#### Scenario: Multiple steering prompts target one active turn
- **WHEN** several user prompts steer or correct the same assistant turn before the episode closes
- **THEN** they are attached to one episode and cannot create separate immediate reviewer jobs

#### Scenario: Follow-up arrives after no-lesson review
- **WHEN** an episode was reviewed with no lesson and a follow-up has no new assistant referent
- **THEN** the closed episode is not reopened and no new immediate job is created

#### Scenario: New assistant output is later corrected
- **WHEN** a later correction has a different causal assistant referent
- **THEN** the runtime creates a new episode with a distinct identity

### Requirement: Episode scheduling is stateful and idempotent
An episode SHALL create at most one immediate reviewer job, only after an eligible strong signal or debounce/turn-close transition.

#### Scenario: Weak active-turn steering is observed
- **WHEN** the only evidence is an assistant referent within an active turn
- **THEN** the episode remains open and is not submitted synchronously on each prompt

#### Scenario: Strong interruption closes an episode
- **WHEN** the host records an interruption or explicit feedback event and the episode closes
- **THEN** one reviewer job is transactionally assigned to the episode's eligible events

#### Scenario: Duplicate hook and reconcile paths see the same episode
- **WHEN** prompt capture and transcript reconciliation observe duplicate sources for the episode
- **THEN** unique source observation and episode constraints preserve one episode and one job

```

## openspec/changes/isolate-feedback-control-plane/specs/memory-maintenance-lifecycle/spec.md

- Source: openspec/changes/isolate-feedback-control-plane/specs/memory-maintenance-lifecycle/spec.md
- Lines: 1-48
- SHA256: ad9e183be5c61fb4763d29e42ee1f9fcd61736066e5822b0863b5cba645d115d

```md
## ADDED Requirements

### Requirement: Maintenance work is durable and explicit
The runtime SHALL create an idempotent maintenance job before claiming that memory consolidation, compaction, supersession, or conflict resolution is queued or running.

#### Scenario: Repeated selection omission requests consolidation
- **WHEN** the same family revisions repeatedly exceed selection capacity or card size
- **THEN** one pending maintenance job is created with immutable source revision references and a stable input digest

#### Scenario: No job exists
- **WHEN** no maintenance job was created for an overflow or conflict
- **THEN** no hook, notification, log, or audit command describes background compaction as pending or running

### Requirement: Maintenance claims use fenced leases
Maintenance workers MUST claim jobs with owner, attempt, lease epoch, and expiry, and stale workers MUST be unable to publish output.

#### Scenario: Worker lease expires
- **WHEN** a running maintenance job passes its lease expiry
- **THEN** the scheduler requeues it with an audit event and a later worker receives a higher lease epoch

#### Scenario: Stale worker submits after requeue
- **WHEN** the former owner submits using an old lease epoch
- **THEN** the store rejects the publication without changing lessons or lineage

### Requirement: Consolidation publication preserves safety and provenance
A maintenance result MUST pass deterministic validation and publish the target revision, lineage, and source supersession in one transaction.

#### Scenario: Valid consolidation is submitted
- **WHEN** the result has complete bounded card fields, covers all source revisions, does not lower maximum severity, and does not broaden scope without evidence
- **THEN** the target lesson revision and lineage are committed atomically and sources are marked superseded rather than deleted

#### Scenario: Publication transaction fails
- **WHEN** any lesson, lineage, or source-state write fails
- **THEN** no partial target or supersession is visible and the job remains recoverable

### Requirement: Irreconcilable conflict requires human resolution
The maintenance worker SHALL NOT automatically merge contradictory source constraints that fail deterministic preservation checks.

#### Scenario: Source instructions contradict
- **WHEN** a consolidation proposal cannot preserve all severe must-do and must-not constraints
- **THEN** the job terminates as `needs_human_resolution`, immutable sources remain, and the affected family stays quarantined

### Requirement: Maintenance state is independently observable
Doctor and audit commands MUST report maintenance queue depth, oldest age, running leases, exhausted jobs, human-resolution jobs, and last successful publication separately from reviewer state.

#### Scenario: Reviewer is healthy but maintenance is stalled
- **WHEN** reviewer jobs complete while maintenance jobs are overdue or exhausted
- **THEN** health output reports the maintenance degradation without claiming reviewer failure or hiding the maintenance gap

```

## openspec/changes/isolate-feedback-control-plane/specs/memory-selection-safety/spec.md

- Source: openspec/changes/isolate-feedback-control-plane/specs/memory-selection-safety/spec.md
- Lines: 1-37
- SHA256: 8a656fbd41259cb9061a72c8dc91af53bd3e6080512c508e402173c0587e607e

```md
## ADDED Requirements

### Requirement: Capacity overflow produces omissions, not a global hold
The selector SHALL treat card-count and token limits as bounded ranking constraints and SHALL return safe selected cards plus structured omission reasons.

#### Scenario: Five severe cards compete for four slots
- **WHEN** five applicable complete severe cards have no semantic conflict and the configured maximum is four
- **THEN** the selector deterministically returns the highest-ranked four, records one `count_budget` omission, and returns no hold

#### Scenario: One severe card is oversized
- **WHEN** an applicable severe card exceeds the single-card or absolute token budget
- **THEN** that card is omitted with an `oversized_card` or `token_budget` reason while other eligible cards remain selectable

### Requirement: Selection order is deterministic
Applicable lessons MUST have a total order based on severity, scope evidence, recurrence, confidence, revision, and stable lesson identity.

#### Scenario: Identical input is selected repeatedly
- **WHEN** the same lesson revisions, task context, delivery history, and budgets are evaluated
- **THEN** selected cards and omissions are byte-for-byte stable

#### Scenario: Already delivered revision is encountered
- **WHEN** a ranked card's application id was already delivered to the same task fingerprint and context epoch
- **THEN** it is skipped without changing the relative order of remaining candidates

### Requirement: Genuine conflicts are quarantined locally
A genuine unresolved conflict SHALL exclude only the affected family or lesson projection and SHALL NOT block unrelated memory or the business turn.

#### Scenario: One family is in safety conflict
- **WHEN** applicable candidates include a conflicted severe family and unrelated non-conflicting cards
- **THEN** the selector reports the family as `conflict_quarantine` and still returns eligible unrelated cards

### Requirement: Selection diagnostics are auditable
The runtime MUST record bounded diagnostics for every omission and maintenance trigger without including sensitive card content in operational logs.

#### Scenario: Selector omits a card
- **WHEN** a card is omitted for capacity, size, prior delivery, or conflict
- **THEN** logs and audit output include opaque lesson/revision identity, reason code, rank, and relevant numeric budget

```
