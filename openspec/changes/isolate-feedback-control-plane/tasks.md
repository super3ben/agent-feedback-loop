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
