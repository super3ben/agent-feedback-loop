---
comet_change: isolate-feedback-control-plane
role: technical-design
canonical_spec: openspec
---

# Agent Feedback Loop 控制面隔离与真实记忆维护技术设计

## 1. 设计定位

需求与验收场景以 `openspec/changes/isolate-feedback-control-plane/` 为唯一事实源。本文只回答实现方式：模块边界、数据模型、事务与租约、宿主 adapter、迁移、日志和测试策略。

本次修改从已部署的 0.7.6 分支继续，保留已有 capture、reviewer、lesson、outbox 和 reconciliation 能力。核心不变量是：

> AFL 的任何控制面状态都不能要求主模型代为投递，也不能通过 Stop 让业务回合多生成一次。

## 2. Runtime 边界

```text
用户 prompt
    │
    ▼
UserPromptSubmit ── capture event ──► episode router ──► reviewer queue
    │                                         │
    │                                         └── async only
    ├── select bounded lessons
    └── return lesson additionalContext or host no-op

assistant output
    │
    ▼
Stop ── bounded capture / transcript observation / bookkeeping
    └── always host no-op (never block/deny)

reviewer / maintenance transaction
    │
    ▼
notification_outbox ──► notification_deliveries
                           ├── codex_thread worker
                           ├── system worker
                           └── audit
```

同步 hook 路径允许做本地、确定性、受限的 SQLite 操作；禁止调用 reviewer、maintenance provider、app-server native delivery 或操作系统 notifier。所有潜在阻塞 I/O 都进入 scheduler/worker。

## 3. 数据模型

Schema 从 8 升级到 9。新表全部 additive，旧 runtime 可忽略。

### 3.1 `notification_deliveries`

每条 outbox semantic event 可对应多个 transport delivery：

```text
notification_id       FK notification_outbox
transport             codex_thread | system | audit | legacy_model_echo
state                 pending | delivering | accepted | observed |
                      failed | unsupported | suppressed | audited_only
owner_id              nullable
attempt               integer
lease_epoch           integer
lease_until           epoch milliseconds
next_attempt_at       epoch milliseconds
ack_id                bounded opaque string
reason_code           bounded snake_case
accepted_at           nullable ISO timestamp
observed_at           nullable ISO timestamp
created_at/updated_at ISO timestamp
PRIMARY KEY(notification_id, transport)
```

状态转换：

```text
pending/failed ──claim──► delivering ──ack──► accepted ──reconcile──► observed
                              │
                              ├──retryable──► failed
                              └──capability──► unsupported
pending ──policy──► suppressed | audited_only
```

所有 worker commit 都匹配 `(notification_id, transport, owner_id, lease_epoch, state=delivering)`。过期 owner 不能提交。`accepted` 只表示 transport 接受；只有 transcript/source observation 才能写 `observed`。

### 3.2 `feedback_episodes` 与 `feedback_episode_events`

```text
feedback_episodes
  episode_id              deterministic hash
  session_uid/context_epoch
  project_id
  root_referent_event_uid nullable assistant event
  signal_strength         weak | strong
  status                  open | ready | assigned | reviewed | closed
  reviewer_job_id         nullable UNIQUE
  opened_at/ready_at/closed_at/updated_at
  UNIQUE(session_uid, context_epoch, root_referent_event_uid, status-open projection)

feedback_episode_events
  episode_id
  event_uid UNIQUE
  relation                referent | feedback | context
  signal_reason           active_turn_steering | turn_interrupted |
                          explicit_feedback | reconciled_context
  created_at
```

episode id 对有 referent 的路径由 `(session_uid, context_epoch, root_referent_event_uid)` 派生；没有 referent 的 host-explicit feedback 使用稳定 source observation id。queue event 只有在 episode 进入 `ready` 时才绑定 reviewer job。

### 3.3 Maintenance 表

```text
memory_maintenance_jobs
  maintenance_job_id      deterministic input digest
  job_type                consolidate | resize | conflict_review
  project_id/family_id
  status                  pending | running | completed | failed |
                          retry_exhausted | needs_human_resolution
  owner_id/attempt/lease_epoch/lease_until
  reason_code/input_digest
  created_at/updated_at/completed_at

memory_maintenance_inputs
  maintenance_job_id
  lesson_id/revision
  card_hash
  PRIMARY KEY(maintenance_job_id, lesson_id, revision)

memory_maintenance_job_events
  event_id
  maintenance_job_id
  attempt/lease_epoch
  state                   claimed | requeued | completed | failed |
                          retry_exhausted | needs_human_resolution
  reason_code/provider/created_at

lesson_lineage
  source_lesson_id/source_revision
  target_lesson_id/target_revision
  relation                consolidated_into | superseded_by
  maintenance_job_id/created_at
  PRIMARY KEY(source_lesson_id, source_revision, target_lesson_id, target_revision, relation)
```

Maintenance input 一经创建不可变。input digest 包含按稳定顺序排列的 lesson id、revision、card hash、job type 和 family/project scope，重复 scheduler 扫描只能命中同一 job。

### 3.4 选择 omission

第一阶段不增加高基数永久表；selector 返回 bounded diagnostics，并由 store 以聚合计数记录相同 `(lesson_id, revision, task scope digest, reason)` 的 omission。达到维护阈值时创建 maintenance job。若实现中发现 doctor 需要逐次审计，再增加有 retention 的 `lesson_selection_events`，不得把敏感 card body 写日志。

## 4. 组件设计

### 4.1 `capture.mjs`：synthetic 识别与结构信号

新增统一 `classifyCapturedEvent()`：

1. 验证 role/source namespace；
2. 使用稳定 AFL marker/receipt/hook envelope 识别 synthetic control event；
3. 提取 causal assistant referent；
4. 只输出结构信号，不进行自然语言关键词分类。

`active_turn_steering` 从 `immediateReview=true` 降为 weak signal。`prior_turn_interrupted` 或宿主显式 feedback 才是 strong signal。receipt stripping 继续保留，但 stripping 与 synthetic classification 分开：混合消息中的业务正文仍可作为 evidence，纯 control item 被排除。

### 4.2 新增 `episode-router.mjs`

该模块是纯决策层，不直接 launch worker：

```js
routeFeedbackEvent({ event, signal, referent, now })
// => { action: "capture_only" | "episode_opened" | "episode_merged" | "episode_ready",
//      episodeId, reason }
```

Store 在同一事务中完成 episode/event association 和 ready transition。scheduler 扫描 ready episode，幂等创建 reviewer job 并更新 `reviewer_job_id`。同一 episode 再次被 hook/reconcile 看见时只返回 existing。

### 4.3 `selector.mjs`：排序、选择与诊断

拆成三步纯函数：

1. `rankLessons()`：计算 scope match class，并按以下 tuple 排序：
   `(severity asc, scopeMatch desc, recurrence desc, confidence desc, revision desc, lessonId asc)`；
2. `chooseWithinBudget()`：按序检查 prior delivery、single-card limit、severe count、absolute/normal budget；
3. `summarizeOmissions()`：返回 bounded opaque diagnostic。

返回结构：

```js
{
  cards,
  omissions: [{ lesson_id, revision, family_id, reason, rank, token_cost }],
  diagnostics: { candidate_count, selected_count, omitted_count, budgets },
  maintenanceRequests: [{ family_id, reason, source_revisions }],
  hold: null
}
```

`safety_hold` 不再清空所有 cards；只产生 `conflict_quarantine` omission。原调用者在 schema-v9 runtime 中永远看不到 `memory_overflow_hold`。

### 4.4 `notification-delivery.mjs`

新增统一 transport interface：

```js
probe({ session, paths })
deliver({ notification, delivery, session, signal })
// => { state: "accepted" | "unsupported" | "failed", ackId?, reasonCode?, retryable }
```

Worker 流程：claim delivery → probe → deliver → fenced commit。native transport 成功后不再发送 system notification；native 不支持/最终失败时创建或激活 system delivery。所有 terminal notification 至少保留 audit delivery。

### 4.5 Codex app-server adapter

实现放在独立 `codex-notification-adapter.mjs`，避免污染现有 `codex-host.mjs` 的 reviewer provider 选择。

连接通过当前 Codex CLI 的 app-server proxy/control socket，使用 JSON-RPC initialize 后调用 `thread/inject_items`。约束：

- thread id 必须等于 session 中已持久化的 `native_session_id`；
- item 为单条 bounded assistant output，内容只含 renderer 生成的固定行和 synthetic marker；
- 总请求、stdout 和 stderr 都有硬上限；
- 连接/请求有短 timeout，异常只返回 reason code；
- adapter 只能由 scheduler 调用，不能由 UserPromptSubmit/Stop 调用；
- app-server ack 保存为 hash/opaque id，不记录 socket/token。

真机若证明 desktop 不即时渲染 injected item，则 adapter 仍可保留为 `accepted` 的历史注入能力，但默认 user-notification policy 将切到 system transport；不能把“历史中存在”说成“用户已看到”。

### 4.6 Maintenance provider

复用 reviewer-provider 的进程隔离、timeout 和输出上限，但增加 maintenance 专用 schema：

```json
{
  "write_complete": true,
  "status": "consolidated | needs_human_resolution",
  "target": {
    "lesson_id": "...",
    "severity": "Critical",
    "scope": {},
    "card": {}
  },
  "source_revisions": [{"lesson_id":"...","revision":1}],
  "reason_code": "..."
}
```

提交事务执行确定性 validator：source 集合完全相等、card 必填字段完整、token 不超过 hard limit、severity 不低于 source 最大 severity、scope 不无证据扩张、source ids/lineage 完整。validator 不判断隐藏推理，只判断结构化结果和证据引用。

## 5. Hook 改造

### 5.1 Prompt hook

移除：

- `candidate_captured/review_queued/final receipt` 的 chat claim；
- `renderReceiptInstruction()`；
- generic correction checkpoint；
- selection hold additionalContext。

保留：

- prompt capture；
- episode routing；
- eligible reviewer wake 的异步 launch；
- bounded selected lesson context；
- host no-op response。

### 5.2 Stop hook

`capture-stop` 无论 store 返回什么，都只产生各宿主 pass schema：

- Codex：`{"continue":true}`；
- Claude/Gemini：`{}`。

`confirmChatNotification()` 不再参与 Stop decision。legacy JSONL mode 的阻断 backstop 从新安装模板删除；若仍保留旧兼容命令，必须显式 opt-in 且 doctor 标为 legacy/unsafe，不属于默认 runtime。

## 6. 迁移策略

`openStore()` 继续在 transaction 内执行 migration：

1. 创建 schema-v9 表和索引；
2. 对每个 notification 创建 audit delivery；
3. 根据 v8 `system_state` 创建 system delivery；
4. 根据 v8 `chat_state` 创建 `legacy_model_echo`：observed 保留 observed，已发未确认保留 accepted/failed 事实，pending 变 audited_only；
5. 为 reviewer job 创建 migration episode，并关联原 queue event；
6. 写 schema migration version 9；
7. 提交后才允许 worker 扫描。

迁移必须幂等。测试从真实 schema-v8 SQL 建库并复制 fixture，而不是只测 fresh schema。

## 7. 日志与诊断

新增结构化事件，正文只含 opaque id、计数和 reason code：

```text
hook.non_interference event=stop result=pass capture=<ok|failed>
episode.routed episode=<id> action=<...> signal=<...>
episode.job.assigned episode=<id> job=<id>
selection.completed candidates=N selected=N omitted=N
selection.omitted lesson=<id> revision=N reason=<code> rank=N tokens=N
delivery.claimed notification=<id> transport=<name> lease=N
delivery.accepted notification=<id> transport=<name>
delivery.observed notification=<id> transport=<name>
delivery.failed notification=<id> transport=<name> reason=<code>
maintenance.created job=<id> type=<type> inputs=N reason=<code>
maintenance.completed job=<id> target=<id> sources=N
maintenance.human_required job=<id> reason=<code>
```

`doctor --live` 分开显示 enabled、runnable、trusted、hook event、reviewer、notification transport 和 maintenance health，不能用单一 healthy 掩盖某层缺口。

## 8. 测试策略

严格执行 RED → GREEN → targeted regression → full regression。

### 8.1 自动化

- Store migration：fresh v9、schema-v8 fixture、重复 migration、事务失败回滚；
- Stop：Codex/Claude/Gemini 所有 receipt/job/hold 状态都 pass；
- Prompt：不含 receipt/maintenance/correction control，selected lesson 仍注入；
- Episode：普通追问 capture-only、同 referent 合并、strong signal 单 job、closed no-lesson 不重开、新 referent 新 episode；
- Selector：5 选 4、oversized、mixed conflict、prior delivery、deterministic ordering；
- Delivery：lease race、stale commit、native ack、timeout、unsupported、system fallback、observation；
- Maintenance：idempotent create、lease recovery、validator、atomic publication、human resolution；
- Installer：新模板没有 Stop backstop 或 receipt instruction，旧配置原子替换。

### 8.2 真机

1. 新 Codex task：普通业务问题只有正常回答，没有 AFL model receipt/Stop prompt；
2. 长期 task：复现当前截图路径，确认同一 receipt 不再强制补发；
3. 真实 5 张 severe、无 conflict 项目：选择 4 张并记录 omission，无 hold；
4. native adapter：分别记录 accepted 和 transcript observed；若 UI 不显示，验证 system fallback；
5. scheduler 连续运行至少两轮，验证 delivery/maintenance lease recovery；
6. Claude/Gemini：能运行则实测；缺 CLI/auth/native event 时明确标记 unavailable，不用 Codex 结果替代。

Computer Use 必须尝试；若 Codex app 安全策略拒绝，保留拒绝错误，并用 task API、真实 transcript、SQLite 与可见截图组合证明，不伪称 UI 已通过。

## 9. 发布与回滚

完成自动化和真机验证前不修改受管 `current.json`。发布时创建新 version directory，完整安装后原子切换；保留 0.7.6 作为 rollback target。若 hook non-interference、migration integrity 或真实普通会话任一失败，禁止切换。

当前会话仍受到 0.7.6 注入的 `memory_overflow_hold`。它不阻止可回滚的设计、代码和测试，但在该约束解除或新 runtime 通过等价安全验证前，不执行全局安装与发布。
