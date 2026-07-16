## 背景

0.7.6 把 AFL 回执放进主模型上下文，并让 Stop hook 在最终输出中找不到 marker 时阻断停止、要求再生成一轮纯回执。与此同时，所有普通用户 prompt 都可能进入队列，默认累计 3 条才创建 reviewer job。前者破坏业务回合，后者无法保证第一次明确不满立即学习。

当前分支曾尝试增加原生/系统通知 transport、feedback episode、maintenance scheduler 和数据库控制表。该方向保留了不必要的“把 reviewer 状态反馈给用户”目标，并把一个本可由短生命周期 subagent 完成的流程扩展成后台平台。本设计撤销该方向。

## 目标

- 主会话永远不等待 reviewer，也不输出 AFL 回执、状态或内部指令。
- 一个不同的明确反馈候选被持久化后，立即尝试启动一个 detached reviewer subagent。
- 已完成回合中的回顾性不满能够被本地候选检测发现，reviewer 是最终语义闸门。
- 长期经验只存在于项目 `.agent/reflections/*.md`，后续 prompt 直接读取文档。
- 小规模场景不用 RAG、常驻 scheduler、通知系统或独立 maintenance 生命周期。
- 对“学习是否有效”的声明严格受证据约束。

## 非目标

- 不保证刚触发的反思能作用于同一个 prompt；主会话不为此等待。
- 不把任意负面词、追问或方案讨论都直接写成长期经验。
- 不在当前规模实现向量检索、embedding、数据库全文记忆或后台 compactor。
- 不自动修改、删除或合并历史反思文档。
- 不支持 Windows；首期支持 macOS 与 Linux。

## 架构决策

### 1. Prompt hook 是唯一的同步入口

默认安装只保留 `UserPromptSubmit` 类入口。一次调用按固定顺序完成有界工作：

1. 捕获当前用户事件及可用的直接 assistant referent；
2. 排除 AFL synthetic/control traffic；
3. 运行纯本地候选检测；
4. 对新候选事务性插入 reviewer job，并在提交后立即 detached spawn；
5. 解析已有反思文档，选择适用方法并作为普通上下文返回；
6. 无论 reviewer、存储或选择失败，都及时返回主会话。

默认安装不注册 Stop hook。没有 receipt、hookPrompt、model nonce echo、chat/system notification 或“等待后台 reviewer”文案。主会话看到的唯一 AFL 内容只能是已经发布且与当前任务相关的经验方法。

### 2. 候选识别只负责高召回，reviewer 负责最终判断

候选检测组合两类证据：

- 宿主强结构信号，例如 active-turn steering、明确 interruption/turn-aborted 或专用 feedback event；
- 已完成回合的本地回顾性证据：存在直接 assistant referent，并同时出现多个独立特征类别，例如负面评价、向后指代、责任/因果表达、以及“本应怎样”的过程反差。

任何单个关键词都不是授权。检测器只输出 reason codes 与分数，不输出长期结论。普通问题、被 agent 主动征求的设计校准、仅讨论 AFL 原理的中性问题和 synthetic hook 文本必须有负例测试。

以下已完成回合表达必须成为正例 fixture：

> 是的，而且为什么你改造这些之前没有去考虑这些东西呢，而是等到我发现事情变复杂了才开始思考这些东西

候选成立后立即评审，不等待后续第 2、3 条。reviewer 使用有界相邻上下文核对：是否确实评价了既有 agent 产出、未满足项是什么、责任是否属于 agent、是否存在可复用的方法变化。误报结束为 `reviewed_no_lesson`，不写文档。

### 3. 每个不同候选一个幂等 job，不建立 episode 平台

`review_jobs` 使用稳定 source identity 去重同一次 hook 重放：`host + session_uid + context_epoch + source_event_id + referent_id`，缺少稳定 event id 时才使用规范化 payload digest。不同用户事件即使文字或 referent 相同，也分别立即评审，因为它们可能是有价值的复发证据；不跨会话按文本去重。

插入 job 与 source evidence 在一个短事务中完成，事务内不启动进程。提交后使用 macOS/Linux 支持的 detached child 启动短生命周期 reviewer runner，parent `unref` 后立即返回。runner 自己 claim job、调用 reviewer、校验结果并提交终态。

系统没有常驻 scheduler。spawn 失败或 worker 崩溃时，job 保持 pending 或等待租约过期；后续 prompt hook 只做一次有界 opportunistic recovery，最多重启少量 due job。初次处理仍是在候选产生时立即启动，恢复扫描不是批处理门槛。

### 4. Markdown 文档是长期记忆事实源

reviewer 先返回结构化结果，controller 校验后再渲染为人可读 Markdown。新文档沿用现有报告形式，至少包含：

- `reflection_id`、`created_at`、`final_severity`、`responsibility`；
- `method_class` 与稳定 `family_id`；
- `facts proven by context`、`user complaint in plain language`、`root cause`；
- `class of mistake`、`method change`、`repeated pattern evidence`；
- source identity 的不可逆摘要，不保存额外原始 prompt 到日志或数据库。

文件通过同目录临时文件、fsync 和 rename 原子发布到 `.agent/reflections/<timestamp>-<slug>.md`。只有发布完成才把 job 标记为 `published`；`reviewed_no_lesson` 不创建文件。SQLite 仅记录 document path/hash 作为控制账本，不复制正文。

现有 Markdown 保持可读。新 parser 优先读取规范字段；旧文档在能可靠解析 severity、class 和 method change 时直接参与选择，否则只保留为可审计历史并记录 `legacy_incomplete` omission。文档不会因再次发生而就地改写；新事件生成新文档，并用相同 `family_id` 表达复发。

### 5. 后续 prompt 直接选择文档，不建 RAG 层

selector 直接扫描当前项目反思目录，以受限单文件大小解析 metadata、错误类别与 `method change`。它根据项目范围、任务相关性、severity、同 family 文档数量、时间和稳定 id 建立确定性全序，选择配置的 Top-K，并把方法段落渲染成有界上下文。

超过数量或 Token 预算时只记录 `count_budget`、`token_budget`、`oversized_document` 或 `legacy_incomplete` omission。绝不返回 `memory_overflow_hold`，也不声称后台正在压缩。当前数据规模直接扫描文档；只有真实规模和延迟数据证明该方式不可接受时，才另行设计 RAG。

同一 family 的 recurrence 由文档数量和 lineage 计算，不依赖数据库里的自增计数。默认选择该 family 最新的完整方法，历史文档继续提供证据，但不重复把同类方法全部塞进上下文。

### 6. 效果状态只记录可证明事实

状态定义如下：

- `published`：规范反思文档已经原子存在并通过 hash 校验；
- `selected`：selector 在某次 prompt 上选择了该文档；
- `emitted`：prompt hook 确实把对应有界经验上下文返回给宿主；
- `recurrence_after_emission`：后来 reviewer 确认同一 family 再次发生，且该事件之前存在该 family 的 emitted 记录。

`selected` 不等于 `emitted`，`emitted` 不等于模型已采用，更不等于用户行为改善。没有再次出现只能保持 `unknown`，不能自动升级为 effective。`recurrence_after_emission` 是明确的负向效果证据，后续文档必须指出原方法为何没有防住，而不是仅增加计数。

### 7. SQLite 是短期控制账本

新运行时只需要：job/source identity、状态、attempt、owner/lease、短期 bounded evidence、document path/hash、selected/emitted attempt 和结构化错误码。终态 job/evidence 按明确 retention 清理，Markdown 文档不随清理丢失。

旧数据库不再作为 lesson/report/card 的读取源。一次性迁移命令必须支持 `--dry-run`、指定输出目录、按 legacy identity/hash 幂等导出和碰撞报告。真实 HOME 的迁移或 runtime 切换必须再次获得用户明确授权；旧数据库可原样保留为归档。

### 8. 日志、平台与安全边界

运行日志只记录 opaque job/document/family id、reason code、计数、duration、lease 和退出状态，不记录 prompt、reviewer 正文、方法正文、token、socket 或绝对项目内容。

detached launch、原子 rename、锁和权限在 macOS 与 Linux 分别测试。安装器必须从 managed block 中删除旧 Stop hook，而不是仅令其 no-op。任何 capture、spawn、review、parse 或 select 异常都 fail-open 到正常业务回答。

## 失败与恢复

- **插入 job 失败**：记录 bounded error，主会话继续；没有虚假“已排队”提示。
- **spawn 失败**：job 保持 pending；当前主会话继续，下次 prompt 有界重试。
- **worker 崩溃**：租约到期后由后续 prompt 回收；stale owner 不能提交。
- **reviewer 输出不合法**：job 记录 retryable/terminal reason；不发布半成品。
- **原子发布失败**：job 不进入 published；临时文件可安全清理。
- **文档解析失败**：仅省略该文档并记录 reason；其他文档和主会话继续。
- **选择为空**：正常返回，不注入控制文案。

## 迁移与回滚

1. 先在临时 HOME 中用历史数据库副本验证 dry-run 和幂等导出，不读取或修改真实运行库。
2. 安装测试必须证明 managed 配置只有 prompt hook，没有 Stop、receipt、notification 或 scheduler。
3. 在 macOS 真机与 Linux 环境分别证明：业务回答不含 AFL 控制文本，候选 job 立即启动，subagent 在主回合外完成，下一次匹配 prompt 可直接读取新文档。
4. 只有用户再次明确批准，才迁移真实数据并原子切换 `current.json`；现有全局 hooks 在此之前保持关闭。
5. 回滚只切回旧 runtime/config；新 Markdown 是普通文件，旧 SQLite 未被破坏。

## 已否决方案

- **继续让 Stop 找 receipt。** 无论扫描多准确，都仍把主模型输出当控制 transport。
- **把 reviewer 结果通过 Codex 原生消息或系统通知投递。** 用户不需要控制噪声；独立 subagent 的价值是生成下一次可消费的文档。
- **收集 3 条或等待 episode 关闭。** 这使第一次故障无法及时学习，违背反馈机制的目标。
- **常驻 scheduler/maintenance worker。** 当前只有短任务和小规模 Markdown，没有足够收益支撑平台复杂度。
- **数据库作为长期记忆或现在引入 RAG。** 文档量尚小，直接读取更透明、更可审计；规模证据出现后再设计索引。
