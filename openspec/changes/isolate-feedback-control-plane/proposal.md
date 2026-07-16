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
