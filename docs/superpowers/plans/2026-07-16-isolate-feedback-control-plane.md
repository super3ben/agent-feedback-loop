---
change: isolate-feedback-control-plane
design-doc: docs/superpowers/specs/2026-07-16-isolate-feedback-control-plane-design.md
base-ref: 17f1761c1fed0465ad39aaa3c76c34a02d692c5c
---

# Agent Feedback Loop 控制面隔离与真实记忆维护实施计划

> **执行要求：** 全程在当前隔离 Worktree `/Users/sunxingda/project/agent-feedback-loop/.worktrees/background-review-observability` 中实施。用户已关闭全局 AFL hook；在任务 12 的显式验收窗口以前，不修改 `~/.codex/config.toml`，不切换 `~/.agent/feedback-loop/current.json`，不安装到真实 HOME。

**目标：** 消除模型回执与 Stop 重入对业务回合的劫持，以 feedback episode 替代逐 prompt 排队，以有界 Top-K 与 omission 替代 `memory_overflow_hold`，并建立可恢复、可审计的通知投递和记忆维护生命周期。

**架构边界：** `UserPromptSubmit` 只做有界 capture、episode 路由、异步唤醒和经验选择；`Stop` 只做有界观察且永远 fail-open。reviewer、notification delivery、memory maintenance 都由 scheduler/worker 异步执行。SQLite schema v9 采用 additive migration；所有 worker 写入使用 owner + lease epoch fencing。

**技术栈：** Node.js 24.15+ ESM、`node:sqlite`、`node:test`、shell hook templates、macOS launchd、Codex app-server JSON-RPC。

## 执行约束与验收口径

- 每个实现任务严格按 RED → GREEN → targeted regression 顺序推进；先证明测试因缺失行为失败，再写最小完整实现。
- 新增结构化日志只记录 opaque id、数量、状态和 reason code，禁止记录 card body、prompt、socket/token 或未脱敏正文。
- `accepted` 只表示 transport 接受，`observed` 必须来自 transcript/source observation；测试与 doctor 不得混淆。
- v8 数据迁移必须保留 evidence、job、receipt 和旧投递事实，但不得重放任何历史 model receipt。
- 本计划中的“真机”表示真实 Codex desktop/app-server/transcript/SQLite 组合证据；若 Computer Use 因安全策略不可用，必须记录限制，不得把协议 ack 当成 UI 可见。

## 执行进度

- [ ] Task 1：冻结 schema-v8 故障 fixture 与 schema-v9 迁移契约
- [ ] Task 2：建立 notification delivery 的租约、状态与迁移兼容 API
- [ ] Task 3：让所有 Stop 路径永不阻断业务回合
- [ ] Task 4：从模型上下文移除回执与虚假维护控制指令
- [ ] Task 5：以 feedback episode 替代逐 prompt reviewer 排队
- [ ] Task 6：实现确定性 Top-K、omission 与 family 局部隔离
- [ ] Task 7：实现可恢复的 memory maintenance store、provider 与原子发布
- [ ] Task 8：实现 capability-aware Codex native adapter 与 system fallback
- [ ] Task 9：把 delivery 与 maintenance 纳入 detached scheduler，且不扩大 hook 临界路径
- [ ] Task 10：补齐 doctor、audit CLI、安装迁移与中英文文档
- [ ] Task 11：完整自动化回归与 fresh-install 证据
- [ ] Task 12：真实 Codex 验收、受控安装与回滚演练

---

## Task 1：冻结 schema-v8 故障 fixture 与 schema-v9 迁移契约

**OpenSpec 映射：** 1.1、1.2、1.3

**文件：**

- 新建：`test/fixtures/schema-v8-control-plane.mjs`
- 修改：`test/store.test.mjs`
- 修改：`src/schema.mjs`
- 修改：`src/store.mjs`

**接口与数据：**

- `SCHEMA_VERSION` 从 `8` 升到 `9`。
- 新建 `notification_deliveries`、`feedback_episodes`、`feedback_episode_events`、`memory_maintenance_jobs`、`memory_maintenance_inputs`、`memory_maintenance_job_events`、`lesson_lineage`。
- `notification_deliveries` 主键为 `(notification_id, transport)`；`feedback_episode_events.event_uid` 唯一；maintenance input 和 lineage 使用复合主键。
- fixture 必须包含 commentary-only receipt、`emitted`/`emitted_unconfirmed`/`observed` chat state、普通追问产生的多个 reviewer job、5 张无冲突 Critical、oversized Critical 和一个真实 `safety_hold` family。

**步骤：**

1. 在 `test/fixtures/schema-v8-control-plane.mjs` 写真实 v8 DDL/seed helper，禁止复用 v9 `SCHEMA_SQL` 伪造旧库。
2. 在 `test/store.test.mjs` 写 RED migration test，断言：
   - v8 evidence、queue event、reviewer job、review receipt、lesson revision 数量与内容 hash 不变；
   - 每个 outbox semantic event 都生成 `audit` delivery；
   - v8 `system_state` 映射为 `system` delivery；
   - v8 `chat_state` 只映射为 `legacy_model_echo` 的 `observed`/`accepted`/`audited_only`，没有 `pending` 可被新 worker claim；
   - 历史 reviewer job 只生成 migration episode，不进入 ready/pending 调度；
   - 重复 `openStore()` 不增加行；迁移中途异常整笔回滚。
3. 运行 RED：

   ```bash
   node --test --test-name-pattern='schema v9|v8 control-plane migration' test/store.test.mjs
   ```

   预期：因 schema version/table/API 缺失失败。
4. 在 `src/schema.mjs` 增加 v9 表、CHECK、外键和 due/lease/episode 索引。
5. 在 `src/store.mjs` 的 `BEGIN IMMEDIATE` migration 中实现幂等 v8→v9 backfill；使用稳定 digest 派生 migration episode id，先完成所有 backfill，再记录 schema version 9。
6. 为 migration 增加结构化日志/诊断计数：`schema.migrated from=8 to=9 deliveries=N episodes=N`，不得输出 payload。
7. 运行 GREEN 与相关回归：

   ```bash
   node --test test/store.test.mjs test/runtime.test.mjs
   ```

8. 提交：

   ```bash
   git add src/schema.mjs src/store.mjs test/store.test.mjs test/fixtures/schema-v8-control-plane.mjs
   git commit -m "feat: add schema v9 control-plane state"
   ```

---

## Task 2：建立 notification delivery 的租约、状态与迁移兼容 API

**OpenSpec 映射：** 3.1、3.2

**文件：**

- 修改：`src/store.mjs`
- 修改：`test/store.test.mjs`
- 新建：`src/notification-delivery.mjs`
- 新建：`test/notification-delivery.test.mjs`

**接口：**

```js
store.ensureNotificationDelivery({ notificationId, transport, state, reasonCode })
store.claimNotificationDeliveries({ ownerId, nowMs, leaseMs, limit, transports })
store.acceptNotificationDelivery({ notificationId, transport, ownerId, leaseEpoch, ackId })
store.failNotificationDelivery({ notificationId, transport, ownerId, leaseEpoch, reasonCode, retryAt, retryable })
store.markNotificationUnsupported({ notificationId, transport, ownerId, leaseEpoch, reasonCode })
store.observeNotificationDelivery({ notificationId, transport, observationId, observedAt })
store.listNotificationDeliveries({ notificationId, sessionUid, state, transport })
deliverNotificationBatch({ store, adapters, ownerId, nowMs, leaseMs, limit, log })
```

**步骤：**

1. 写 RED store test：并发 claim 只能有一个 owner；lease 过期可恢复；旧 epoch 的 accept/fail 返回 false；ack id 有长度上限；terminal state 不重开；semantic event 可为多个 transport 各自投递。
2. 写 RED orchestration test：native accepted 后不激活 system；native unsupported/最终失败后激活 system；audit 永远保留；candidate/queued 默认 `audited_only`。
3. 运行 RED：

   ```bash
   node --test test/store.test.mjs test/notification-delivery.test.mjs
   ```

4. 在 `src/store.mjs` 实现全部 fenced API；统一返回 `{ changed, delivery }` 或 `null`，不让调用者绕过租约更新表。
5. 在 `src/notification-delivery.mjs` 定义 transport-neutral `probe()`/`deliver()` 协议、短路策略、retry backoff 与结构化日志事件。
6. 保留旧 outbox chat/system 列只用于 v8 audit/migration 兼容；新 runtime 不再用 `claimChatNotification()` 或旧 system claim 推进新事件。
7. 运行 GREEN：

   ```bash
   node --test test/store.test.mjs test/notification-delivery.test.mjs
   ```

8. 提交：

   ```bash
   git add src/store.mjs src/notification-delivery.mjs test/store.test.mjs test/notification-delivery.test.mjs
   git commit -m "feat: add fenced notification deliveries"
   ```

---

## Task 3：让所有 Stop 路径永不阻断业务回合

**OpenSpec 映射：** 2.1、2.2

**文件：**

- 修改：`src/cli.mjs`
- 修改：`templates/hooks/stop-hook.sh`
- 修改：`templates/hooks/core-hook.sh`
- 修改：`test/cli.test.mjs`
- 修改：`test/e2e-smoke.test.mjs`
- 修改：`test/runtime.test.mjs`

**契约：**

- Codex `capture-stop` 对任何内部状态都输出 `{"continue":true}`。
- Claude Code/Gemini Stop 对任何内部状态都输出宿主 no-op `{}`。
- capture/store/observation 抛错也 fail-open，同时落 `hook.non_interference event=stop result=pass capture=failed reason=<code>`。
- 正常安装模板中不存在 receipt backstop、`decision=block` 或 `Output this receipt verbatim before stopping`。

**步骤：**

1. 将现有“Stop 只阻断一次”测试改成 RED matrix：pending/emitted/unconfirmed/observed、review queued/completed、selector omission/maintenance、SQLite busy/corrupt input、Codex/Claude/Gemini 都必须 pass。
2. 添加安装后 shell e2e：向真实临时 HOME 安装，再执行生成的 stop hook，断言 stdout 是合法 host pass schema，stderr 只有 bounded diagnostic，模板文本不含内部补发指令。
3. 运行 RED：

   ```bash
   node --test --test-name-pattern='Stop|capture-stop|non-interference|backstop' test/cli.test.mjs test/e2e-smoke.test.mjs test/runtime.test.mjs
   ```

4. 删除 `src/cli.mjs` 中根据 `confirmChatNotification()` 生成 `decision=block` 的分支；Stop 可做观察，但观察结果不能进入 response decision。
5. 修改模板，让 transactional Stop 只调用 bounded capture；子进程异常/timeout 也回宿主 pass schema。
6. 记录 `hook.non_interference` 日志，reason code 使用固定枚举，禁止拼接原始异常正文。
7. 运行 GREEN：

   ```bash
   node --test test/cli.test.mjs test/e2e-smoke.test.mjs test/runtime.test.mjs
   ```

8. 提交：

   ```bash
   git add src/cli.mjs templates/hooks/stop-hook.sh templates/hooks/core-hook.sh test/cli.test.mjs test/e2e-smoke.test.mjs test/runtime.test.mjs
   git commit -m "fix: make transactional Stop fail open"
   ```

---

## Task 4：从模型上下文移除回执与虚假维护控制指令

**OpenSpec 映射：** 2.3、2.4

**文件：**

- 修改：`src/cli.mjs`
- 修改：`src/receipt.mjs`
- 修改：`test/cli.test.mjs`
- 修改：`test/receipt.test.mjs`
- 修改：`templates/rules/feedback-loop.md`

**契约：**

- `UserPromptSubmit` additional context 只能包含已选择 lesson 的 bounded context；无 lesson 时返回 host no-op。
- 不再调用/导出 `renderReceiptInstruction()`；receipt renderer 仅可供 audit/system/native notification 展示。
- 不输出 generic correction checkpoint，也不输出 `memory_overflow_hold` 文案。

**步骤：**

1. 写 RED snapshot/matrix：candidate、queued、completed、no-lesson、delivery、5 severe、oversized、conflict 时，additional context 均不含 `[agent-feedback-loop receipt]`、`afl-receipt`、`Output this receipt`、`checkpoint hold`、`background reviewer compacts`；selected lesson 仍只注入一次。
2. 运行 RED：

   ```bash
   node --test --test-name-pattern='prompt context|receipt instruction|checkpoint hold|selected lesson' test/cli.test.mjs test/receipt.test.mjs
   ```

3. 删除 `src/cli.mjs` 的 chat notification claim/render 路径和 hold 文案；保留 outbox 创建与异步 worker 唤醒。
4. 删除 `renderReceiptInstruction()` 及对应测试；保留 `renderReceiptLine()`/`renderReceiptControl()` 用于非模型 transport 和历史 receipt stripping。
5. 更新 rule 模板，明确 synthetic control event 不构成用户反馈，模型不承担 receipt delivery。
6. 运行 GREEN：

   ```bash
   node --test test/cli.test.mjs test/receipt.test.mjs test/runtime.test.mjs
   ```

7. 提交：

   ```bash
   git add src/cli.mjs src/receipt.mjs templates/rules/feedback-loop.md test/cli.test.mjs test/receipt.test.mjs
   git commit -m "fix: remove model-mediated receipt delivery"
   ```

---

## Task 5：以 feedback episode 替代逐 prompt reviewer 排队

**OpenSpec 映射：** 4.1、4.2、4.3、4.4

**文件：**

- 新建：`src/episode-router.mjs`
- 新建：`test/episode-router.test.mjs`
- 修改：`src/capture.mjs`
- 修改：`src/store.mjs`
- 修改：`src/cli.mjs`
- 修改：`src/codex-reconcile.mjs`
- 修改：`test/capture.test.mjs`
- 修改：`test/store.test.mjs`
- 修改：`test/cli.test.mjs`
- 修改：`test/codex-reconcile.test.mjs`

**接口：**

```js
classifyCapturedEvent({ event, payload, strippedText })
// => { synthetic, signalStrength, signalReason, referentEventUid, sourceObservationId }

routeFeedbackEvent({ event, classification, now })
// => { action: 'capture_only'|'episode_opened'|'episode_merged'|'episode_ready', episodeId, reason }

store.routeFeedbackEpisode({ eventUid, sessionUid, contextEpoch, projectId, rootReferentEventUid, signalStrength, signalReason, sourceObservationId })
store.assignReadyFeedbackEpisode({ episodeId, promptVersion })
store.closeFeedbackEpisode({ episodeId, reviewerJobId, outcome })
```

**步骤：**

1. 创建 fixtures 覆盖：普通追问、询问 AFL 状态、纯 hook prompt/receipt、同一 active turn 重复 steering、prior-turn interruption、显式 thumbs-down/feedback、reconcile 重复观察、reviewed-no-lesson 后无新 referent追问、新 referent 新纠正。
2. 写纯路由 RED test 与 store uniqueness RED test，断言 weak signal 不立即 ready；strong signal 同 referent 只产生一个 job；terminal episode 无新 referent 不重开。
3. 运行 RED：

   ```bash
   node --test test/episode-router.test.mjs test/capture.test.mjs test/store.test.mjs test/codex-reconcile.test.mjs
   ```

4. 在 `src/capture.mjs` 实现结构 marker/source namespace 分类，禁止用“为什么/不对”等自然语言关键词决定 feedback。
5. 在 `src/episode-router.mjs` 实现纯决策函数；在 `src/store.mjs` 用单事务关联 event、合并/ready、唯一绑定 job。
6. 将 `src/cli.mjs` prompt capture 和 `src/codex-reconcile.mjs` historical capture 改为调用同一 episode store API；旧 per-prompt `immediateReview` 仅转换为 weak signal。
7. reviewer 完成/无 lesson/耗尽时关闭对应 episode；重复 reconciliation 只返回 existing episode/job。
8. 增加日志：`episode.routed`、`episode.job.assigned`，只输出 digest id/action/signal/reason。
9. 运行 GREEN：

   ```bash
   node --test test/episode-router.test.mjs test/capture.test.mjs test/store.test.mjs test/cli.test.mjs test/codex-reconcile.test.mjs
   ```

10. 提交：

   ```bash
   git add src/episode-router.mjs src/capture.mjs src/store.mjs src/cli.mjs src/codex-reconcile.mjs test/episode-router.test.mjs test/capture.test.mjs test/store.test.mjs test/cli.test.mjs test/codex-reconcile.test.mjs
   git commit -m "feat: group causal feedback into episodes"
   ```

---

## Task 6：实现确定性 Top-K、omission 与 family 局部隔离

**OpenSpec 映射：** 5.1、5.2、5.3、5.4

**文件：**

- 修改：`src/selector.mjs`
- 修改：`src/store.mjs`
- 修改：`src/cli.mjs`
- 修改：`test/selector.test.mjs`
- 修改：`test/store.test.mjs`
- 修改：`test/cli.test.mjs`

**接口：**

```js
rankLessons({ lessons, session, task, hostPrefix })
chooseWithinBudget({ ranked, session, task, budget, store })
summarizeOmissions({ ranked, cards, omissions, budgets })
selectLessons(...)
// => { cards, omissions, diagnostics, maintenanceRequests, hold: null, tokenEstimate, budgets }

store.recordSelectionOutcome({ sessionUid, contextEpoch, taskFingerprint, diagnostics, omissions, maintenanceRequests })
```

**步骤：**

1. 将旧 hold assertions 改为 RED：5 张 Critical 稳定选 4、第五张记 `severe_capacity`；oversized Critical 记 `single_card_hard_limit` 且其他卡继续；conflict family 记 `conflict_quarantine` 且无冲突 family 继续；prior delivery 记 `already_delivered`。
2. 加入输入顺序随机化重复测试，断言排序 tuple `(severity, scope match, recurrence, confidence, revision, lesson id)` 和 application id 稳定。
3. 运行 RED：

   ```bash
   node --test test/selector.test.mjs test/store.test.mjs test/cli.test.mjs
   ```

4. 将 `src/selector.mjs` 拆成三个纯函数；任何数量/token 条件都只 omission，不返回 `memory_overflow_hold`；真实 conflict 只隔离对应 family。
5. 在 `src/store.mjs` 实现 bounded omission aggregate（stable scope digest + reason + lesson revision）及 maintenance request 幂等入口，日志不写 card body。
6. `src/cli.mjs` 注入 cards 后异步记录 selection outcome；记录失败不影响 prompt response。
7. 运行 GREEN：

   ```bash
   node --test test/selector.test.mjs test/store.test.mjs test/cli.test.mjs
   ```

8. 提交：

   ```bash
   git add src/selector.mjs src/store.mjs src/cli.mjs test/selector.test.mjs test/store.test.mjs test/cli.test.mjs
   git commit -m "fix: replace memory holds with bounded omissions"
   ```

---

## Task 7：实现可恢复的 memory maintenance store、provider 与原子发布

**OpenSpec 映射：** 6.1、6.3、6.4、6.5

**文件：**

- 新建：`src/memory-maintenance.mjs`
- 新建：`src/maintenance-provider.mjs`
- 新建：`test/memory-maintenance.test.mjs`
- 新建：`test/maintenance-provider.test.mjs`
- 修改：`src/store.mjs`
- 修改：`src/lessons.mjs`
- 修改：`test/store.test.mjs`
- 修改：`test/lessons.test.mjs`
- 修改：`templates/schemas/reviewer-receipt.schema.json`（若共享 schema 不合适则新增 `templates/schemas/maintenance-result.schema.json`）

**接口：**

```js
store.ensureMaintenanceJob({ jobType, projectId, familyId, reasonCode, sourceRevisions })
store.claimMaintenanceJobs({ ownerId, nowMs, leaseMs, limit })
store.renewMaintenanceLease({ maintenanceJobId, ownerId, leaseEpoch, leaseUntil })
store.failMaintenanceJob({ maintenanceJobId, ownerId, leaseEpoch, reasonCode, retryAt, retryable })
store.publishMaintenanceResult({ maintenanceJobId, ownerId, leaseEpoch, result })

validateMaintenanceResult({ job, inputs, result, singleCardHardLimit })
runMaintenanceBatch({ store, provider, ownerId, nowMs, leaseMs, limit, log })
```

**步骤：**

1. 写 RED store test：source revision digest 幂等、不可变 inputs、并发 claim/fencing、lease recovery、retry exhaustion、stale submit rejection、事务失败不出现半条 lineage/半个 supersession。
2. 写 RED validator test：source 集合缺失、revision/card hash 变化、oversized target、severity 降级、scope 无证据扩张、lineage 不完整均拒绝；真实矛盾返回 `needs_human_resolution`。
3. 运行 RED：

   ```bash
   node --test test/memory-maintenance.test.mjs test/maintenance-provider.test.mjs test/store.test.mjs test/lessons.test.mjs
   ```

4. 在 `src/store.mjs` 实现 maintenance 生命周期和事件；所有 commit 匹配 owner/lease epoch/state。
5. 在 `src/maintenance-provider.mjs` 复用 reviewer provider 的进程隔离、timeout、stdout/stderr 上限，但使用独立输入输出 schema。
6. 在 `src/memory-maintenance.mjs` 实现 worker orchestration 与 deterministic validator；provider 只提供候选结果，最终约束由本地 validator 判断。
7. `publishMaintenanceResult()` 在单事务中创建/更新 target revision、写 immutable lineage、supersede source、完成 job；任何失败全部回滚。
8. `needs_human_resolution` 只保持该 family quarantine，绝不设置会话/项目级 hold。
9. 运行 GREEN：

   ```bash
   node --test test/memory-maintenance.test.mjs test/maintenance-provider.test.mjs test/store.test.mjs test/lessons.test.mjs
   ```

10. 提交：

   ```bash
   git add src/memory-maintenance.mjs src/maintenance-provider.mjs src/store.mjs src/lessons.mjs test/memory-maintenance.test.mjs test/maintenance-provider.test.mjs test/store.test.mjs test/lessons.test.mjs templates/schemas
   git commit -m "feat: add recoverable memory maintenance"
   ```

---

## Task 8：实现 capability-aware Codex native adapter 与 system fallback

**OpenSpec 映射：** 3.3、3.4、3.5、3.6

**文件：**

- 新建：`src/codex-notification-adapter.mjs`
- 新建：`test/codex-notification-adapter.test.mjs`
- 修改：`src/notification-delivery.mjs`
- 修改：`src/codex-reconcile.mjs`
- 修改：`test/notification-delivery.test.mjs`
- 修改：`test/codex-reconcile.test.mjs`
- 修改：`src/capture.mjs`
- 修改：`test/capture.test.mjs`

**接口：**

```js
createCodexNotificationAdapter({ command, env, spawnImpl, timeoutMs, maxOutputBytes, log })
// => { probe({ session, paths }), deliver({ notification, delivery, session, signal }) }

injectCodexThreadItem({ threadId, text, syntheticMarker, ...boundedProcessOptions })
// JSON-RPC initialize -> thread/inject_items -> bounded ack
```

**步骤：**

1. 写 fake app-server protocol RED test：initialize capability、精确 thread id、一条 bounded assistant item、ack hash、timeout、reject、malformed/oversized response、CLI unavailable、wrong thread、process cleanup。
2. 写 delivery policy RED test：terminal notification native-preferred；candidate/queued audit-only；native unsupported/final failure 激活 system；native accepted 与 observed 分离。
3. 写 capture RED test：adapter synthetic marker/assistant item 不进入 feedback episode 或 reviewer evidence，但可作为 notification observation。
4. 运行 RED：

   ```bash
   node --test test/codex-notification-adapter.test.mjs test/notification-delivery.test.mjs test/capture.test.mjs test/codex-reconcile.test.mjs
   ```

5. 实现独立 adapter：只接受已持久化 `session.native_session_id`，使用 JSON-RPC initialize 后调用 `thread/inject_items`；请求、输出、timeout 均硬限制；错误转换为 reason code。
6. adapter 只由 scheduler batch 调用，禁止从 hook 同步调用。ack 只写 opaque hash/id。
7. 在 reconcile transcript observation 中把 synthetic marker 匹配到对应 delivery 的 `observed`，同时从 episode/evidence classifier 排除。
8. 运行 GREEN：

   ```bash
   node --test test/codex-notification-adapter.test.mjs test/notification-delivery.test.mjs test/capture.test.mjs test/codex-reconcile.test.mjs
   ```

9. 提交：

   ```bash
   git add src/codex-notification-adapter.mjs src/notification-delivery.mjs src/codex-reconcile.mjs src/capture.mjs test/codex-notification-adapter.test.mjs test/notification-delivery.test.mjs test/codex-reconcile.test.mjs test/capture.test.mjs
   git commit -m "feat: deliver Codex notifications out of band"
   ```

---

## Task 9：把 delivery 与 maintenance 纳入 detached scheduler，且不扩大 hook 临界路径

**OpenSpec 映射：** 6.2

**文件：**

- 修改：`src/cli.mjs`
- 修改：`src/codex-reconcile.mjs`
- 修改：`src/reconcile-scheduler.mjs`
- 修改：`test/reconcile-scheduler.test.mjs`
- 修改：`test/e2e-smoke.test.mjs`
- 修改：`test/codex-reconcile.test.mjs`

**契约：**

- `reconcile-daemon` 每轮按固定顺序运行 transcript reconcile、episode assignment、review recovery、notification delivery、maintenance recovery；每层独立捕获异常并写 runtime status。
- 任一 worker timeout/failure 不阻断下一层，也不能反向改变 hook response。
- daemon 已有全局 lease，子工作项另有各自 lease epoch fencing。

**步骤：**

1. 写 RED scheduler/e2e test：delivery/maintenance lease recovery、某一层挂死被 timeout/kill 后下一轮继续、两个 daemon 竞争不重复 commit、无工作时有界退出。
2. 运行 RED：

   ```bash
   node --test test/reconcile-scheduler.test.mjs test/e2e-smoke.test.mjs test/codex-reconcile.test.mjs
   ```

3. 抽取一轮 runner，将各阶段结果写为独立 runtime status：`codex_reconcile`、`episode_scheduler`、`notification_delivery`、`memory_maintenance`。
4. 只从 prompt hook 发 detached wake signal；真正的 adapter/provider I/O 始终发生在 daemon/worker。
5. 增加每层 duration/count/reason 的结构日志与硬 timeout。
6. 运行 GREEN：

   ```bash
   node --test test/reconcile-scheduler.test.mjs test/e2e-smoke.test.mjs test/codex-reconcile.test.mjs test/cli.test.mjs
   ```

7. 提交：

   ```bash
   git add src/cli.mjs src/codex-reconcile.mjs src/reconcile-scheduler.mjs test/reconcile-scheduler.test.mjs test/e2e-smoke.test.mjs test/codex-reconcile.test.mjs
   git commit -m "feat: schedule control-plane workers asynchronously"
   ```

---

## Task 10：补齐 doctor、audit CLI、安装迁移与中英文文档

**OpenSpec 映射：** 7.1、7.2、7.3

**文件：**

- 修改：`src/index.mjs`
- 修改：`src/cli.mjs`
- 修改：`test/cli.test.mjs`
- 修改：`test/runtime.test.mjs`
- 修改：`README.md`
- 修改：`README-zh.md`
- 修改：`templates/rules/feedback-loop.md`

**CLI 输出：**

- `doctor --live` 分层报告 `enabled`、`runnable`、`trusted`、hook event、reviewer、scheduler、native/system/audit transport、episode backlog、maintenance health。
- `review list/show` 显示 episode/job/outcome；`memory explain` 显示 selected/omitted reason 和 maintenance lineage；notification audit 显示 semantic event、accepted、observed、fallback。
- 所有输出都要避免把 `accepted` 写成“用户已看到”。

**步骤：**

1. 写 RED CLI test：健康层可独立失败；native unsupported + system available 不是整体假健康；maintenance retry exhausted 明确显示；v8 pending receipt 迁移后不 replay。
2. 写 RED install test：临时 HOME 从 0.7.6 配置升级，原子备份/替换；新 core/stop template 无 model receipt/backstop；`current.json` 只在完整安装完成后切换；失败保留旧 target。
3. 运行 RED：

   ```bash
   node --test test/cli.test.mjs test/runtime.test.mjs test/e2e-smoke.test.mjs
   ```

4. 实现分层 doctor 和 audit query；为 transport/episode/maintenance 添加 bounded JSON/table output。
5. 更新 installer copy/compatibility 与 rollback 测试，禁止读取或修改真实 HOME。
6. 更新 README：non-interference guarantee、capability matrix、fallback、episode、Top-K omission、maintenance、迁移、rollback、已知 native UI observation 边界。
7. 运行 GREEN：

   ```bash
   node --test test/cli.test.mjs test/runtime.test.mjs test/e2e-smoke.test.mjs
   ```

8. 提交：

   ```bash
   git add src/index.mjs src/cli.mjs test/cli.test.mjs test/runtime.test.mjs README.md README-zh.md templates/rules/feedback-loop.md
   git commit -m "docs: expose control-plane health and guarantees"
   ```

---

## Task 11：完整自动化回归与 fresh-install 证据

**OpenSpec 映射：** 8.1

**文件：**

- 按失败结果修改对应测试/实现文件；不得通过放宽断言掩盖失败。
- 更新：`openspec/changes/isolate-feedback-control-plane/tasks.md`（只在对应项有证据后勾选）

**步骤：**

1. 运行 targeted control-plane suite：

   ```bash
   node --test test/store.test.mjs test/notification-delivery.test.mjs test/episode-router.test.mjs test/selector.test.mjs test/memory-maintenance.test.mjs test/maintenance-provider.test.mjs test/codex-notification-adapter.test.mjs test/cli.test.mjs test/codex-reconcile.test.mjs
   ```

2. 运行全量回归：

   ```bash
   npm test
   ```

3. 使用临时 HOME 做 fresh install/doctor：

   ```bash
   TMP_HOME="$(mktemp -d)"
   node ./bin/agent-feedback-loop.mjs install --home "$TMP_HOME"
   node ./bin/agent-feedback-loop.mjs doctor --home "$TMP_HOME" --live
   ```

4. 复制 schema-v8 fixture 到另一个临时 HOME，执行一次升级和两次 reopen；导出脱敏计数/hash，证明 evidence 保留、legacy receipts 不可 claim。
5. 并发启动两个 reconciliation worker，人工终止一个持有 lease 的子进程，再运行恢复轮；验证 delivery/maintenance 没有重复 terminal commit。
6. 扫描发行内容：

   ```bash
   rg -n "Output this receipt verbatim|renderReceiptInstruction|memory_overflow_hold|background reviewer compacts|decision.?block" src templates README.md README-zh.md
   ```

   预期：默认 runtime 路径无命中；若兼容/audit parser 必须保留字面量，逐项记录原因且证明不可执行。
7. 执行严格规格验证：

   ```bash
   openspec validate isolate-feedback-control-plane --strict
   ```

8. 更新 OpenSpec tasks，仅勾选已有命令输出/fixture 证据的任务。
9. 提交：

   ```bash
   git add openspec/changes/isolate-feedback-control-plane/tasks.md
   git commit -m "test: verify control-plane isolation regressions"
   ```

---

## Task 12：真实 Codex 验收、受控安装与回滚演练

**OpenSpec 映射：** 8.2、8.3、8.4、8.5

**前置门禁：**

- 任务 1–11 全部通过；`git status --short` 为空。
- 用户显式同意进入真实验收窗口。
- 当前全局 hook 仍保持用户关闭状态，先保存当前 `current.json` target 和配置 hash；不覆盖用户修改。

**步骤：**

1. 先不安装 hook，仅用真实本机 Codex CLI/app-server 对 native adapter 做 capability probe 和 `thread/inject_items` 测试；记录 `accepted` ack 与 transcript observation 为两个字段。
2. 尝试 Computer Use 查看 desktop 可见性；若 Codex app 被安全策略拒绝，保存拒绝证据，改用 task API、真实 transcript、SQLite delivery row 和用户截图组合验收。
3. 在一次性临时 Codex task/临时 HOME 开启新 runtime，验证：
   - 普通业务问题只有业务回答，无 receipt instruction/Stop re-entry；
   - 询问 AFL 状态不会创建新 episode/job；
   - 同 referent 强反馈只生成一个 job；
   - reviewed-no-lesson 后普通追问不再生成 job；
   - 5 张无冲突 Critical 选 4 + omission，无 hold；
   - oversized/conflict 只局部 omission/quarantine；
   - scheduler 连续两轮后 delivery/maintenance 状态可恢复。
4. Claude Code/Gemini CLI 可运行时执行同一 Stop non-interference matrix；缺 CLI/auth/native delivery 时标记 `unsupported/unavailable` 并验证 system/audit fallback，不用 Codex 结果替代。
5. 将版本号从 0.7.6 升为本次正式版本，跑 `npm pack --dry-run`，确认包内含新模块/schema/templates 且无临时证据文件。
6. 向用户汇报真机证据和已知边界，获得第二次显式同意后，才创建新的 version directory 并原子切换 managed `current.json`；安装过程不得自动重新启用用户关闭的 hook。
7. 用户明确要求恢复 hook 后，使用 installer 的受控配置同步恢复；立即在新普通任务执行 smoke。失败则原子恢复旧 `current.json` 和 hook-off 配置。
8. 最终运行：

   ```bash
   agent-feedback-loop doctor --live
   npm test
   openspec validate isolate-feedback-control-plane --strict
   ```

9. 完成实现提交（版本号与发行说明如有）：

   ```bash
   git add package.json README.md README-zh.md openspec/changes/isolate-feedback-control-plane/tasks.md
   git commit -m "release: isolate AFL control-plane delivery"
   ```

## 最终完成定义

- Stop 在所有宿主和所有 AFL 状态下都不阻断业务回合。
- 主模型上下文不再承载 receipt、maintenance claim 或 generic correction control。
- 相同 causal episode 至多一个 reviewer job；无新 referent 的普通追问不创建 job。
- 记忆数量/token 只产生确定性 omission；`memory_overflow_hold` 从默认 runtime 消失。
- 真实 conflict 只隔离相关 family；maintenance 有租约、重试、lineage、原子发布和 human-resolution 终态。
- native/system/audit transport 的 accepted/observed/fallback 可独立审计。
- schema-v8 evidence 完整迁移且 legacy receipt 不重放。
- 自动化、临时 fresh install、真实 Codex 验收和回滚演练均有证据；全局 hook 只在用户明确授权后恢复。
