# Convergence Kernel 与 Review Loop Guard 融合设计

**日期：** 2026-07-21  
**状态：** 用户已批准
**目标版本：** `agent-feedback-loop` 0.9.x 设计基线  
**实现基线：** `7294398`（0.8.0 prompt-only、detached reviewer、Markdown 长期经验）

## 1. 背景与问题定义

`agent-feedback-loop`（AFL）0.8.0 已经把反馈学习链路收敛为：prompt 捕获、明确不满识别、立即启动短生命周期 reviewer、发布 Markdown 经验、后续会话直接选择经验。它明确移除了 Stop hook、用户可见回执、常驻 scheduler、数据库长期记忆正文和 `memory_overflow_hold`，从而保证主会话不再成为后台控制面的传输通道。

现有 `subagent-driven-development`（SDD）Review Loop Guard 解决的是另一类问题：同一 invariant 被 reviewer 反复退回时，限制无休止的 local-fix，保留失败历史，并在第二次同类失败时进入方向/架构复盘。它已经证明“用确定性状态约束 review/fix 循环”有价值，但状态和策略仍局限在一个开发工作流 Skill 内。

需要融合的真正用户价值不是建立一个更重的 Agent 控制平台，而是：

1. 普通任务一旦出现无新证据的范围膨胀、重复修补或过度设计，就尽早停止下一轮修改；
2. 停止之后自动进行一次有界的自我复盘，判断方向错误、规格错误、实现错误、测试过拟合或 reviewer 扩大范围；
3. 特别重要的任务仍允许必要的深度探索，但每一轮必须增加可验证信息，不能用“重要”作为无限循环的豁免；
4. 已经验证有效的 Guard 身份、失败代际、alias、distinct finding 和 receipt 语义必须保留；
5. 无论控制面发生什么故障，主会话的正常业务回答都不能再次被 AFL 状态、回执或内部提示阻断。

早期讨论中曾提出 Task Contract 服务、统一后台控制面、数据库长期对象以及通用实时拦截。那些假设基于旧架构，与 0.8.0 已批准的轻量方向不兼容。本设计只抽取其中必要的确定性收敛能力，并把它实现为 AFL 内的一个小型 **Convergence Kernel**。

## 2. 目标

- 将现有 SDD Review Loop Guard 的稳定 invariant、boundary、failure generation、alias、distinct finding、architecture checkpoint 和单次修复授权语义纳入 AFL。
- 对外部可观察的过度思考行为进行确定性检测；不读取、不要求、不存储模型的隐式思维链。
- 在确定性 Breaker 触发后，立即启动短生命周期 Reflection Probe，给出结构化的继续、简化、回滚、换方向、人工决策或结束建议。
- 让策略强度受证据质量、任务重要性来源和适配器能力共同约束，禁止声称并不存在的实时阻断能力。
- 保持 SQLite 为精简控制账本；长期方法与复发经验继续只写入 Markdown。
- 支持 macOS 与 Linux；不引入常驻进程、scheduler、消息 transport 或新的主会话回执。
- 通过导入、影子比对和显式切换迁移现有 Guard，切换后只保留一个状态权威。

## 3. 非目标

- 不观察、记录或展示 chain-of-thought；“自我反思”只输出结构化结论和可验证的下一步。
- 不自动把模型生成的语义意见升级为硬规则。
- 不要求所有项目新建一套 Task Contract 文档；已有用户请求、OpenSpec 和实施计划保持原事实源。
- 不在通用 prompt 模式宣称能够拦截同一回合中的每一次工具调用。没有 pre-mutation seam 时，只能在下一代修改或下一提示边界生效。
- 不把 diff、完整规格、reviewer 正文、prompt 正文或长期 lesson 正文写入控制数据库。
- 不引入 RAG、向量库、常驻 worker、定时清理服务或远程控制平面。
- 不自动修改用户全局安装的 SDD Skill、真实 hooks 或真实数据库；这些属于实现完成后的独立部署授权。
- 首期不支持 Windows。

## 4. 第一性原理与系统不变量

### 4.1 主任务价值优先

控制机制存在的目的，是帮助 Agent 更快完成用户原始价值，而不是证明控制机制自身完备。若验收条件已经满足，新增抽象必须由新的可信风险或失败证据证明；否则默认停止扩展。

### 4.2 复杂度需要证据

新增 schema、服务、scheduler、兼容框架、依赖或长期双写不是中性动作。它们必须对应用户明确要求、冻结验收条件、真实失败测试、平台运行证据或已批准的方向决定。

### 4.3 语义判断不能单独立法

LLM reviewer 和 Reflection Probe 可以解释、建议、归类和提出假设，但不能凭自己的自然语言输出创建 hard gate、提升任务重要性或签发无限继续授权。硬门禁只来自版本化、可测试、经批准的确定性 policy。

### 4.4 控制强度不能超过观测能力

系统分别标记 evidence quality 与 adapter capability。一个只看到 prompt 的适配器只能审计或警告；只有位于 review/fix 或 pre-mutation 边界的适配器才能阻断相应动作。

### 4.5 主会话与控制面隔离

prompt 路径一律 fail-open，并且不输出 Guard 状态、grant、内部 prompt 或恢复提示。显式 Guard 工作流自身则 fail-closed：授权缺失、状态损坏或 grant 不匹配时，不得进行下一次受控修改。

### 4.6 历史不能通过改名逃逸

同一 invariant 改写描述时必须保留 canonical identity；真实独立 finding 必须记录 distinct reason。禁止通过换 ID、重置计数、关闭后重开或清空状态绕过既有失败代际。

## 5. 总体架构

```text
agent-feedback-loop
├── Feedback Learning Plane（现有）
│   ├── evidence capture
│   ├── detached dissatisfaction reviewer
│   ├── Markdown reflection publisher
│   └── next-prompt selector
├── Convergence Kernel（新增、纯确定性核心）
│   ├── Contract Projector
│   ├── Generation Ledger
│   ├── Convergence Breaker
│   ├── Policy Decision Engine
│   └── Continuation Grant Authority
├── Reflection Probe（新增、短生命周期语义顾问）
└── Adapters
    ├── SDD Review Loop Adapter：workflow_gate
    ├── OpenSpec / Comet Adapter：checkpoint_gate
    ├── Generic Prompt Adapter：audit_only
    └── Future Pre-Mutation Adapter：tool_gate
```

Convergence Kernel 是无模型依赖的状态机与策略库。Reflection Probe 复用现有 provider adapter、detached process、私有结果文件和严格 schema validation，但使用独立的输入/输出协议，不复用“不满是否形成长期经验”的 reviewer job 类型。

## 6. 权威与事实源

| 事实 | 唯一权威 | AFL 保存内容 | 允许的决策强度 |
|---|---|---|---|
| 用户目标、显式排除项 | 原始用户请求或用户确认 | source digest、revision、bounded ref | 可形成机械约束 |
| OpenSpec 验收条件 | 已批准且当前的 OpenSpec | path digest、revision digest | 可形成 checkpoint/workflow gate |
| 实施任务边界 | 已批准实施计划或工作流 task | task id、boundary id、revision | 可形成对应适配器门禁 |
| 测试/运行失败 | 可复现命令结果或宿主结构事件 | result digest、reason code、时间 | 可更新 decision basis |
| reviewer finding | 受支持 reviewer 的结构化输出 | invariant/boundary/fingerprint/digest | 只有确定性 policy 可据此门禁 |
| Reflection Probe 结论 | 短生命周期语义模型 | outcome、digest、最小结构字段 | 只能建议，不能独立 hard gate |
| Guard 状态 | 切换前为旧 Guard；切换后为 AFL SQLite | 当前投影与追加事件 | 只允许单一权威 |
| 长期方法经验 | `.agent/reflections/*.md` | path/hash/emission state | 作为后续上下文，不自动立法 |

Contract Projector 不把任意自然语言推断直接升级为硬约束。每个投影字段携带 `authority`：`explicit_user`、`approved_spec`、`approved_plan`、`verified_runtime`、`review_finding` 或 `inferred_advisory`。只有前四类中适合机械验证的字段，才能参与硬门禁；`inferred_advisory` 只能产生 warn 或 probe guidance。

## 7. 身份模型

### 7.1 仓库 lineage

每个 Git clone 在真实 Git common directory 下维护私有文件 `afl-lineage-id`：

- 内容为随机 128-bit 以上的 opaque ID；
- 所有 worktree 通过 common directory 共享同一个 lineage；
- 不根据绝对路径或 remote URL 推导，避免移动目录后失联或不同 clone 意外合并；
- 创建时要求 common directory 真实存在、归当前用户所有、不是符号链接跳转，文件使用 exclusive create 与 `0600`；
- 已存在时只读取并验证格式、owner、mode 和 regular-file 身份；
- 数据库只保存 lineage ID 的不可逆 digest，不保存仓库路径或 remote URL。

如果适配器无法安全建立 lineage，`audit_only` 可以记录 `identity_partial` 并继续主任务；`checkpoint_gate`、`workflow_gate` 和 `tool_gate` 必须 fail-closed，不得生成强授权。

### 7.2 Task、boundary 与 invariant

- `task_uid = SHA-256(lineage_id || adapter_kind || native_task_id)`。
- `boundary_id` 由适配器根据冻结任务或 review 边界产生，不使用自由变化的 finding 文案。
- `canonical_invariant_id` 是同一失败性质的稳定标识；文案改写通过 alias 归入原 ID。
- 同 task/boundary 的独立问题必须显式 `declare-distinct`，并保存 bounded reason code 与证据 digest。
- 通用过度思考检测使用保留 invariant `task-convergence`，但仍按 task/boundary 隔离。

关闭 invariant 只改变 lifecycle，不删除失败历史。后续回归使用相同 canonical ID 和原 failure count，形成新的 fix generation。

### 7.3 Revision 与 policy identity

- `contract_revision` 是权威 contract projection 的规范 digest；用户要求或批准规格变化才更新。
- `policy_revision` 是确定性策略包的版本与 digest；升级 policy 不重写历史事件。
- `decision_basis_digest` 只在以下事实出现时变化：新的用户要求、真实失败测试/运行/平台证据、已验证的 distinct invariant、或经用户/工作流批准的方向决定。

文件保存、相同测试重跑、reviewer 换一种措辞、无证据的“也许”以及模型自行提升重要性，都不改变 `decision_basis_digest`。

## 8. Change Generation 模型

Generation 表示“根据一个稳定决策依据进行的一次受控修改尝试”，不是文件保存次数。

- SDD：一次 receipt-backed fix 是一代；review 追加证据仍属于该代，下一次修复才开新代。
- OpenSpec/Comet：一个已批准实施 task 是一代；task 内的保存与测试不增加代数。
- Generic：适配器能识别稳定目标时，一个明确执行段是一代；无法稳定识别时只能 `audit_only`。
- Future tool adapter：消费一个 `continuation_grant` 后开始一代，受该 grant 的 action 与 scope 约束。

Generation 事件至少包含：task、boundary、canonical invariant、contract revision、decision basis digest、允许动作、受影响文件数量与 diff 统计的 digest、测试结果 digest、证据类别以及开始/结束时间。数据库不保存 source diff 或命令完整输出。

同一代可以增加新 evidence；新 evidence 不自动允许新修改。要进行下一代修改，必须先由 Policy Decision Engine 得出 `pass`，或消费一个有效的单次 grant。

## 9. 任务重要性与探索预算

重要性分为 `routine`、`important`、`critical`。来源只能是：

- 用户明确声明；
- 已批准规格中的风险等级；
- 确定性 policy 对安全、隐私、数据损坏、不可恢复状态或主会话干扰的分类；
- 已验证的生产/运行证据。

模型、reviewer、Probe 和适配器都不能自行把任务提升为 important/critical。

策略预算：

- **routine**：第一次出现无新证据的范围膨胀即暂停下一代并启动 Probe，不等待累计三次。
- **important**：允许至多一次 exploration grant；申请必须给出明确风险假设、最小实验和 falsification test。实验没有新增证据时立即停止。
- **critical**：允许必要的深度处理，但每一代必须增加与 critical 风险直接相关的可验证证据。没有“无限探索”豁免；architecture fix 再次失败时进入 human decision。

任务降级可以自动减少预算；任务升级必须重新取得可信 authority。

## 10. Convergence Breaker

Breaker 只基于外部可验证事实运行。首期冻结的确定性触发器如下：

1. **AcceptanceSatisfiedScopeExpansion**  
   冻结验收条件已经有通过证据，下一代却新增 contract 未要求的抽象、兼容层、配置面或子系统。
2. **UnchangedBasisRepeatedMutation**  
   `decision_basis_digest` 未变化，却在同 boundary 开启下一代修改。
3. **EvidenceFreeSameInvariant**  
   同一 canonical invariant 的上一代未新增可信 evidence，又申请新一代 local fix。
4. **Oscillation**  
   同一结构在相邻代出现 add/delete/add、enable/disable/enable 或等价方向反复，且没有新的 decision basis。
5. **ExplicitExclusionTouched**  
   修改或设计触及用户/批准规格明确排除项。
6. **UnjustifiedArchitectureExpansion**  
   新增数据库、schema、scheduler、常驻服务、外部依赖、解析框架或长期双写，但 contract 与已验证风险均不要求。
7. **RepeatedReviewInvariant**  
   同一 invariant 第二次正式失败时停止 local-fix，进入 direction/architecture checkpoint；architecture-fix 再失败时进入 human decision。

前六项在证据不够支持硬判断时降级为 `warn` 或 `reflection_required`，不得伪装成 hard gate。第七项在 SDD `workflow_gate` 中保持现有 Guard 的确定性强制语义。

Breaker 的产物是结构化 decision，不是面向用户的文案：

- `pass`
- `warn`
- `reflection_required`
- `checkpoint_required`
- `hold`
- `human_decision`
- `finish`

Decision 与 Enforcement 分离；同一 decision 在不同 adapter capability 下可能只记录、在 checkpoint 阻断，或在 mutation 前阻断。

## 11. Reflection Probe

### 11.1 启动与隔离

当 deterministic Breaker 得出 `reflection_required` 时，controller 事务性记录请求，提交后立即 detached spawn 一个 Probe。Probe 与主会话无 stdout/stderr/control-message 连接，不使用用户 hooks，不等待主业务回答。

Probe 复用现有 provider-specific executable resolution、deny-all tools、timeout、process-group termination、私有结果文件和 inode-safe cleanup。它使用独立 job kind、独立 JSON Schema 与独立 validator，不能把不满 reviewer 的 `lesson/no_lesson` 协议混入 convergence decision。

### 11.2 有界输入

Probe 只接收：

- 用户目标与冻结验收条件的有界投影；
- 显式排除项；
- 最近两代的结构化摘要；
- 文件数量、增删统计和路径类别，不含 diff 正文；
- 测试状态、失败 reason 与 evidence digest；
- 当前 invariant/boundary、failure generation；
- 任务重要性及其 authority；
- 当前 direction source 与 breaker reason。

不提供 secrets、完整 transcript、完整 reviewer 报告、绝对敏感路径或模型 chain-of-thought。

### 11.3 输出契约

Probe 输出严格 JSON，核心字段为：

```json
{
  "assessment": "overdesigned",
  "action": "simplify_current_generation",
  "unmet_user_value": "",
  "wrong_assumption": "A scheduler is required for immediate reflection",
  "unnecessary_scope": ["resident scheduler", "notification transport"],
  "minimal_next_step": "reuse the detached one-shot reviewer",
  "falsification_test": "prove a feedback candidate cannot launch immediately without a scheduler"
}
```

`assessment` 仅允许：

- `aligned_and_necessary`
- `wrong_direction`
- `overdesigned`
- `overoptimized`
- `insufficient_evidence`
- `scope_drift`
- `acceptance_already_satisfied`

`action` 仅允许：

- `continue_once`
- `simplify_current_generation`
- `rollback_to_generation`
- `direction_checkpoint`
- `human_decision`
- `finish_now`

所有字符串和数组均有数量、单项长度和总字节上限。保存到数据库的只有 outcome code、result digest 与必要的 generation reference；完整结构化结果位于 owner-only 临时文件，controller 消费后安全删除。

### 11.4 Authority 限制

Probe 的 `continue_once` 只是建议。只有下列条件之一满足，Kernel 才能签发 grant：

- controller 验证存在改变 `decision_basis_digest` 的新证据；
- important 任务尚未消费唯一 exploration budget，且风险假设与 falsification test 完整；
- 用户或批准工作流明确授权新的方向；
- deterministic policy 明确允许一代受限 simplification/rollback。

Probe 无法提升 importance、改变 contract、清除 failure count、声明 distinct finding 或把自己的建议变成 hard policy。

## 12. Adapter 能力与执行上限

| capability | 可观察边界 | 可执行动作 | 禁止声称 |
|---|---|---|---|
| `audit_only` | prompt/任务摘要 | 记录、warning、异步 Probe、下次提示建议 | 已阻止同回合工具调用 |
| `checkpoint_gate` | task/checkpoint 切换 | 阻止进入下一个 task/checkpoint | 已拦截 task 内每次保存 |
| `workflow_gate` | review/fix 调度 | 无 grant 不生成 fix brief、不派 fixer | 已拦截任意外部工具 |
| `tool_gate` | pre-mutation tool seam | 在写入/命令前验证 grant | 当前已普遍支持实时拦截 |

实际 enforcement 等于 `min(decision severity, evidence quality, adapter capability)`。

### 12.1 SDD adapter

提供完整 `workflow_gate`：

1. 正式 review 记录稳定 Review-Run-ID；
2. Critical/Important finding 记录 canonical Invariant-ID 与 Boundary；
3. 真实执行 `record-review`；
4. 只有允许修复的 decision 才能 `authorize-fix`；
5. 将 grant 以私有 JSON artifact 持久化；
6. `task-brief --mode fix` 必须消费 grant，成功后才允许调度 fixer；
7. 同一 invariant 第二次失败进入 direction checkpoint；architecture-fix 再失败进入 human decision；
8. alias、distinct declaration、closed regression 都保留原 fingerprint、failure count 和 fix generation。

### 12.2 OpenSpec / Comet adapter

首期为 `checkpoint_gate`：从已批准 proposal/spec/design/tasks 投影 contract revision，在 task 完成与下一 task 开始之间运行 Breaker。它不篡改 OpenSpec 文件，也不把 inferred requirement 变成 gate。

### 12.3 Generic Prompt adapter

首期仅 `audit_only`。它可以基于明确反馈、已存在的结构化 generation 摘要和后续 prompt 启动 Probe，但不宣称已停止同一回合中的过度思考。若宿主未来提供可靠的 BeforeTool/pre-mutation API，再单独升级为 `tool_gate`。

## 13. 状态机

核心状态如下：

```text
idle
  -> active_generation
      -> generation_closed -> pass -> next_generation
      -> breaker_triggered -> reflection_required
          -> probe_running
              -> finish
              -> simplify/rollback -> constrained_grant -> active_generation
              -> aligned + verified basis -> one_shot_grant -> active_generation
              -> checkpoint_required
                  -> approved_direction -> architecture_grant -> active_generation
                  -> human_decision
              -> human_decision
  -> terminal
```

规则：

- 每次状态变更先写 append-only event，再更新 projection；二者在同一 SQLite 事务中完成。
- 重放相同 event ID 幂等返回原结果；同 ID 不同内容 fail-closed。
- grant 消费与 generation open 在同一事务中完成，避免一份授权启动两代。
- controller 崩溃后根据 event ledger 重建 projection；不得用重置计数恢复。
- 主会话 prompt 捕获不参与上述 fail-closed 事务；失败时只返回宿主原生 no-op。

## 14. Continuation Grant

Continuation Grant 是内部一次性授权，不是用户回执。它绑定：

- repository lineage digest
- task UID
- boundary 与 canonical invariant
- contract revision
- policy revision
- current generation 与 next generation
- decision basis digest
- evidence digest
- allowed purpose：`local_fix`、`exploration`、`simplify`、`rollback` 或 `architecture_fix`
- bounded scope digest
- issued/expiry time

controller 生成高熵随机 token，只把 token hash 存入 SQLite。CLI 只在机器可读 JSON 中返回原 token；不得写到主会话、普通日志或 Markdown lesson。消费时核对全部绑定字段并原子标记 consumed。以下任一变化都使未消费 grant 失效：contract revision、policy revision、direction、boundary/invariant identity、decision basis、scope 或 generation。

grant 不能续期、重复消费或跨 task 使用。需要继续时必须根据当前事实重新决策。

## 15. 精简持久化模型

现有 lean control database 升级一个明确 schema version，新增四张控制表：

### 15.1 `convergence_tasks`

保存 task UID、lineage digest、adapter kind/capability、native task digest、contract source/revision、policy revision、importance/authority、task state、创建/更新时间。它不保存 contract 正文。

### 15.2 `convergence_loops`

每个 task + boundary + canonical invariant 一行，保存 lifecycle、failure count、fix generation、decision basis digest、current decision、direction generation、bounded alias ID list、active grant ID 与版本号。该投影也保存当前 Probe 的 `kind/state/attempt/owner/lease_epoch/lease_until/next_attempt_at/result_digest`；Probe 的每次状态变化仍以 append-only event 为事实依据。closed 后再次失败更新同一行，不创建可逃逸的新身份。

### 15.3 `convergence_events`

append-only 事件：event ID、task/loop、generation、event type、reason code、decision/action、evidence/source/result digest、allowlisted bounded counters、previous-event digest 与时间。详情 JSON 只接受静态 schema 中的标量、ID、digest 和计数；拒绝 prompt、diff、命令输出、reviewer 正文和绝对路径。

事件类型首期冻结为：

`contract_projected`、`generation_opened`、`evidence_recorded`、`review_recorded`、`alias_declared`、`distinct_declared`、`breaker_triggered`、`reflection_requested`、`reflection_claimed`、`reflection_completed`、`reflection_failed`、`checkpoint_recorded`、`grant_issued`、`grant_consumed`、`grant_revoked`、`generation_closed`、`task_resolved`、`legacy_imported`、`shadow_compared`。

### 15.4 `continuation_grants`

保存 grant ID、token hash、绑定字段、purpose、issued/expires/consumed/revoked time 与状态。唯一约束保证一个 loop 同时最多一个 active grant。

这四张表属于控制历史，不是长期知识库。首期不增加定时清理器；所有字段有硬大小上限，数据库增长来自小型结构事件。只有真实规模数据证明需要 retention 时，才设计显式、可审计的压缩策略。长期可读经验仍只存在于 Markdown。

## 16. 事件日志与隐私

- 结构化日志只包含 opaque task/loop/event/grant ID、reason code、generation、duration、counts 和 exit state。
- 不记录 token、prompt、Probe 正文、reviewer 正文、diff、secret、socket 或绝对项目路径。
- Reflection Probe 临时结果要求 owner-only regular file、严格 UTF-8/size/mode 校验、open inode 与 unlink inode 一致性验证。
- SQLite、lineage file 和 grant artifact 均为当前用户私有；任何 symlink、owner 或 mode 异常在强门禁路径 fail-closed。
- Probe provider 禁用用户 hooks、MCP/tool use 与 shell，证据仅通过 stdin 或私有文件传入。

## 17. 旧 Guard 迁移与单一权威切换

迁移不直接删除或覆盖 `.superpowers/sdd/review-loop-state.json`，分四阶段：

### 阶段 1：Dry-run import

- 只读解析旧 state；
- 验证 schema、canonical invariant、alias、distinct declaration、full history、closed regression、failure count、fix generation、checkpoint、authorization 与 receipt consumption；
- 输出 bounded diff 与 source file digest；
- 不写 AFL 数据库、不改变旧 Guard。

### 阶段 2：Import with provenance

- 事务性导入真实投影和历史摘要；
- 记录 `legacy_imported`、源 schema/version/digest 与映射版本；
- 保留原 fingerprint、failure count、fix generation 和 closed lifecycle；
- 不臆造、回填或改写不存在的 review 事件。

### 阶段 3：Shadow parity

- 旧 Guard 继续作为唯一授权权威；
- 同一受支持输入同时交给 AFL Kernel 纯计算；
- 只比较 decision、next required action、failure generation 和 authorization eligibility；
- mismatch 写 `shadow_compared` bounded evidence，不自动修复、不改变旧授权；
- 只有声明支持的真实输入 fixture 与生产记录计入 parity，理论未声明输入进入 backlog。

### 阶段 4：Explicit cutover

- 用户对目标仓库显式批准；
- 切换记录绑定 lineage、最后旧 state digest 与新 policy revision；
- SDD adapter 从此只从 AFL SQLite 读取和写入；旧 state 变成只读归档；
- 禁止长期 dual-write；回滚只能恢复到切换前完整快照，不能把两边事件拼接。

对已开始且已经消费旧 architecture-fix receipt 的原子动作，先按原权威安全收口，再在下一处 review/fix 边界切换，禁止中途撤销或重新签发。

## 18. 学习闭环但不自动立法

任务结束后，AFL 可以把以下已验证结果交给现有反馈学习层：

- Breaker 是否阻止了真实的范围膨胀；
- 是否删除或避免了不必要的代码/服务/schema；
- 是否发生 false positive；
- 被允许的复杂度是否最终被证据证明必要；
- 相同过度设计模式是否再次出现。

reviewer 可据此生成普通 Markdown 方法经验，例如“验收已满足后，新增 scheduler 前先要求生产证据”。这些经验在后续任务中增强 warning 与 Probe guidance，但不能静默成为 hard policy。

新的 deterministic trigger 必须经过独立变更：真实复发证据、明确 predicate、正负 fixture、false-positive 分析、用户批准和 policy revision。这样实现“自我成长”，同时避免模型自我扩权。

## 19. 错误处理与恢复

- **Prompt 路径任何 convergence 错误：** 记录 bounded error，返回宿主原生 no-op，业务回答继续。
- **显式 Guard 命令状态损坏：** fail-closed，不签发 grant，输出机器可读诊断。
- **Probe spawn 失败：** 状态保持 `reflection_required`；不阻断主会话，但 workflow/tool gate 不得越过。
- **Probe timeout/invalid output：** 记录 bounded reason，转 checkpoint 或 human decision，不把无效语义结果当授权。
- **SQLite busy：** 使用现有 bounded busy timeout；prompt fail-open，显式 gate fail-closed。
- **进程崩溃：** event 与 projection 同事务；未消费 grant 保持可验证，已消费 grant 不回退为可用。
- **policy revision 变化：** 现有 active grant 全部撤销，历史按原 revision 保留。
- **adapter 失去能力：** enforcement 自动降级到真实 capability，并明确机器状态；不得继续声称 hard block。

## 20. macOS 与 Linux 支持

- 继续使用 Node.js 直接 spawn、detached process group 与 provider-specific argv，不通过 shell 拼接。
- macOS 与 Linux 都验证 detached Probe 在 parent 结束后完成、超时可终止整个 process group、结果文件权限与 inode cleanup 正确。
- Git common directory 通过 `git rev-parse --git-common-dir` 的受控执行结果解析，验证 owner/mode/symlink；覆盖普通 clone 与 linked worktree。
- SQLite WAL、busy timeout、事务、file mode 与 crash recovery 在两个平台分别运行集成测试。
- Windows 行为返回 `unsupported_platform`，不得降级到未经验证的强门禁。

## 21. 测试策略与冻结验收条件

### 21.1 纯逻辑与状态机

- 每个 Breaker predicate 都有正例、相邻负例与 evidence-quality 降级测试。
- routine 首次无证据扩张即暂停；important 仅一次 exploration；critical 每代要求新证据。
- unchanged decision basis、oscillation、explicit exclusion 和 architecture expansion 可确定性重放。
- 第二次同 invariant 失败进入 direction checkpoint；architecture-fix 再失败进入 human decision。
- closed invariant 回归保留原 fingerprint、failure count 与 fix generation。
- alias 不新增 failure identity；distinct finding 必须有独立证据与 reason。

### 21.2 Grant 与并发

- grant 绑定字段任何一项变化均不可消费。
- 并发消费只成功一次，并与 generation open 原子提交。
- crash、replay、timeout、policy update、contract update 不会让已消费 grant 复活。
- grant/token 永不出现在普通日志、prompt 输出或 Markdown。

### 21.3 Probe

- 独立 JSON Schema 与 validator 覆盖所有枚举、长度、exact keys、secret/control-text rejection。
- Probe 建议不能提升 importance、改 contract、重置 failure 或直接创建 hard gate。
- detached、deny-all tools、timeout、overflow、invalid UTF-8、symlink、mode、inode replacement 在 macOS/Linux 验证。

### 21.4 Adapter 与迁移

- 以现有 Guard 的真实受支持 fixture 证明 record-review、alias、distinct、checkpoint、authorize、receipt consume、resolve 和 closed regression parity。
- dry-run 无副作用；import 幂等；shadow mismatch 不改变旧权威；cutover 后无 dual-write。
- SDD 无有效 grant 时不能生成 fix brief 或调度 fixer。
- OpenSpec/Comet 只能在 checkpoint 边界阻断；generic prompt 只能 audit/warn。

### 21.5 主会话隔离

- 安装配置仍只有 prompt hook，没有 Stop hook。
- 所有 convergence/Probe/DB/spawn 失败均不输出回执、内部 prompt、状态文案或额外模型回合。
- 正常用户问题得到正常业务回答；Guard 机器结果只存在于显式 CLI/adapter channel。
- 现有 AFL 0.8.0 全量回归必须继续通过。

### 21.6 真机验收

- macOS 真机运行完整测试、真实 linked worktree lineage、detached Probe 与 prompt isolation 验证。
- Linux 运行相同的数据库、process、adapter 和 CLI 契约测试。
- 测试通过、运行时安装、真实 hook 切换与生产效果是不同层级；没有真实部署授权时只声明代码与隔离环境验证完成。

## 22. 实施边界与顺序

实现按纵向闭环拆分，避免先搭平台：

1. 纯 Convergence Kernel：identity、generation、state machine、deterministic policy、grant；
2. lean control schema 与原子 store；
3. SDD adapter 兼容层与真实 fixture parity；
4. Reflection Probe 独立协议与 detached runner；
5. Breaker → Probe → grant → 下一代的 SDD 纵向闭环；
6. OpenSpec/Comet checkpoint adapter；
7. generic audit-only context；
8. dry-run import、shadow、显式 cutover 工具；
9. macOS/Linux 真机验收与文档。

每个阶段冻结验收范围。对同一功能累计正式修复/复审超过三轮时，禁止自动开始下一轮补丁，必须先进行客观架构复盘：核对原始用户价值、缺陷类别、真实生产证据、继续/简化/删除/延期成本，以及是否过度设计。只有主会话干扰、数据损坏/不可恢复、安全隐私或冻结核心验收失败继续阻塞；未声明输入的理论反例默认进入 backlog。

## 23. 发布与回滚

1. 项目内实现与测试先在独立 worktree 完成，不修改真实安装。
2. 用旧 Guard fixture 与真实历史副本完成 dry-run/import/shadow 验证。
3. 单独请求用户批准后，才对一个非关键仓库进行 cutover canary。
4. canary 观察主会话隔离、false positive、阻止的无效代数、Probe 建议质量和授权消费一致性。
5. 达到冻结验收后，再逐仓库显式切换；不做全局静默迁移。
6. 回滚恢复旧 Guard state 快照与 adapter authority；AFL 新表保留为只读审计，不反向拼接事件。

## 24. 已否决方案

- **把 Guard 做成新的常驻后台平台。** 当前需要的是边界决策与短任务，不需要 scheduler、服务发现或消息系统。
- **所有 prompt 都实时 hard-block。** 当前宿主没有统一 pre-mutation seam；虚构能力比 audit-only 更危险。
- **等待三次再反思。** routine 第一次无证据范围膨胀已经值得暂停；等待三次会让同类错误重复发生。
- **Probe 自己决定是否继续。** 语义模型不能为自己签发硬授权；必须由确定性 Kernel 验证 authority 与 evidence。
- **模型自行声明任务 critical。** 这会成为无限思考的逃逸口。
- **数据库保存 contract、diff、review 或 lesson 正文。** 增加隐私、迁移与双事实源成本；digest 和 bounded projection 已足够控制。
- **长期双写旧 Guard 与 AFL。** 两个权威最终必然分叉；只允许有限 shadow compute 与显式 cutover。
- **把 convergence 结果显示到主会话。** 这会重现 0.7.6 回执污染；用户只应看到正常回答与真正需要其决定的问题。
- **从 Reflection lesson 自动生成 hard policy。** 自我成长不能等同自我立法；新门禁必须经过证据、测试和批准。

## 25. 成功定义

融合完成后的 AFL 不以“控制了多少回合”为成功，而以以下可证明结果衡量：

- 明确不满仍能立即触发后台反思并生成 Markdown 经验；
- 同一 review invariant 不再无限 local-fix，第二次失败必然换方向，architecture-fix 再失败必然交给人；
- routine 任务的第一次无证据额外代就能触发有界复盘；
- 必要复杂度可以凭可信 evidence 获得一次受限继续，不必要复杂度被简化、回滚或停止；
- 主会话不出现 AFL 回执、内部 hook prompt、状态轮询或额外纯控制回答；
- 所有 hard gate 都能追溯到冻结 policy、真实 adapter seam 与可信证据；
- 长期知识仍是人可读 Markdown，数据库保持为精简、私有、可重放的控制账本。
