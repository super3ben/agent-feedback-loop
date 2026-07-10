# Agent Feedback Loop: 严重度感知的反思学习与上下文消费设计

- 日期: 2026-07-10
- 状态: 待书面评审
- 目标层级: 个人用户级可复用插件, 项目级学习数据

## 1. 背景与问题

当前插件已经能把用户消息写入队列, 到期后启动后台反思 subagent, 生成
`.agent/reflections/` 报告并在必要时写入 `.agent/rules/feedback-loop.md`。
但这个链路只覆盖了「发现 -> 分析 -> 持久化」, 没有可靠覆盖
「检索 -> 注入 -> 后续会话应用」。

因此用户能看到记录不断增加, 却很难在同项目的新会话里感受到模型主动吸收了旧问题。
这与之前 pipeline-orchestrator 中可感知的同项目反馈效果不同: 后者实际把既有教训
重新放回了后续执行上下文, 当前插件则主要停留在生产反思产物。

本设计把 feedback-loop 从「反思记录器」改造成闭环学习插件:

```text
反馈 -> 深度反思 -> 结构化行动卡 -> 按严重度/相关性选择
     -> 每个新会话一次性注入 -> 执行方法发生变化 -> 复发时升级
```

## 2. 目标

1. `Blocker` / `Critical` 教训在适用范围内进入每个新会话。
2. `Major` 仅在当前项目、路径、工具或任务类型相关时进入会话。
3. `Minor` 默认不占上下文, 只累计趋势和复发证据。
4. 完整反思报告与后续会话行动卡分离; 不把 5 Why 报告整篇塞入上下文。
5. 行动卡必须是完整语义单元, 禁止为了 token 上限从中间截断。
6. 正常会话的 lesson 选择不调用 LLM, 不增加一次额外模型请求。
7. Codex、Claude Code、Gemini CLI 继续共享一套核心机制和数据格式。
8. 用户安装后即可使用, 不要求每个项目手工维护三套原生规则文件。
9. 反思仍由独立后台 reviewer 完成, 不依赖 Superpowers 等任务执行流水线。
10. 所有选择、跳过、预算和异常都有不泄漏用户原文的诊断日志。

## 3. 非目标

- 不把全部历史反思加载到每个会话。
- 不在每个用户回合重复注入同一批教训。
- 不用关键词表判断用户是否不满。
- 不在正常会话里调用第二个模型做语义检索。
- 不自动把所有项目教训提升为个人全局规则。
- 不用简短行动卡替代完整反思报告; 二者用途不同且同时保留。
- 不承诺仅靠 prompt 就能绕过宿主平台更高优先级的系统规则。

## 4. 核心架构

### 4.1 Producer: 后台反思 reviewer

现有后台 reviewer 继续负责事实核验、责任分类、严重度判定、决策路径还原、
5 Why、遗漏信号、复发原因、类别抽象和方法改进。

当结论满足以下条件时, reviewer 除写完整报告外, 还要写结构化 lesson event:

- responsibility 为 `agent_fault`;
- confidence 为 medium/high;
- 有可执行的方法改进;
- 能给出明确适用范围和反例/例外;
- 不是单纯预防性提醒或低证据猜测。

发现同类 Markdown 规则或 active lesson 时, reviewer 只禁止创建重复规则, 不能因此停止处理。
真实反馈一旦属于复发, 必须追加 recurrence event, 审计旧教训为什么没有产生约束效果,
并对原 lesson 做激活、升级、修订或进入待复审状态。`existing rule found` 不是
`rule_action: none` 的充分条件。

### 4.2 Store: 项目级 lesson 事件日志与活动快照

项目数据使用两个文件:

```text
<project>/.agent/feedback-loop/lessons.jsonl
<project>/.agent/feedback-loop/active-lessons.json
~/.agent/feedback-loop/lessons/global.jsonl
~/.agent/feedback-loop/lessons/active-global.json
~/.agent/feedback-loop/review-receipts/<review-event-id>.json
```

- `lessons.jsonl` 是追加式事件日志, 保存创建、复发、升级、降级、合并、归档事件。
- `active-lessons.json` 是原子生成的活动快照, 供 prompt hook 快速只读选择。
- 完整证据和因果链仍保存在 `.agent/reflections/<timestamp>-<slug>.md`。
- review receipt 是后台评审事务的机器校验结果, 记录 report/event/snapshot 的最终 revision;
  它和「本会话加载过哪些 lesson」的 session receipt 是两种不同凭证。
- 个人全局 lesson 只有满足现有 Blocker + 跨项目证据门时才写入 global event log;
  selector 会把 global active snapshot 与当前项目 snapshot 合并后选择。

采用事件日志而不是原地改 JSON 数组, 是为了避免多个 CLI/会话并发评审时覆盖数据。
活动快照通过临时文件 + 原子 rename 更新; 读取失败时保留上一份有效快照。

### 4.3 Compiler: lesson 归并与行动卡编译

compiler 按 `method_class + class_id + scope` 合并同根因事件。`method_class` 使用受控顶层分类,
避免 reviewer 每次发明近义类别导致严重卡数量无限增长:

```text
evidence-premise
requirements-scope
execution-order
verification-closure
state-context
resource-lifecycle
communication-handoff
learning-retrieval
safety-irreversible
```

`class_id` 可以描述更具体的子类, 但 always-loaded 严重卡最终必须按
`method_class + scope` 归并为最多一张方法卡。

- 同一类别再次出现只增加 recurrence/evidence/revision, 不复制近义规则。
- 新证据表明现有规则过窄时更新同一 lesson 的行动卡。
- 规则互相矛盾时标记 `conflict`, 不进入自动上下文, 等待后台复审。
- 被新规则替代的 lesson 标记 `superseded`, 不参与加载。

每个活动 lesson 同时保存完整分析指针和一张紧凑行动卡。行动卡必须包含:

```text
when:       什么情况下适用
do:         agent 必须执行的动作/顺序/检查
why:        一句说明该动作防止的根因
exception:  不适用的边界或反例
source:     完整反思报告路径
```

卡片校验器要求五个字段都非空。超预算时只能整卡选择、整卡跳过或重新编译,
绝不对字符串做尾部截断。

### 4.4 Consumer: 每会话一次的 lesson selector

现有 `core-hook.sh` 保持负责队列和到期评审。新增一个 Node selector 负责结构化数据:

```text
templates/runtime/lesson-selector.mjs
```

shell 不解析 lesson JSON, 只把 hook payload、项目路径和活动快照路径交给 selector。
selector 返回:

- 要注入的完整行动卡列表;
- 选择/跳过原因;
- 预算使用量;
- 当前 session 的 lesson revision receipt。

selector 使用 `session_id + project_key` 定位会话 receipt, receipt 内保存已经注入的
`lesson_id -> revision` 映射, 文件保存在 `~/.agent/feedback-loop/session-context/`。
同一 lesson revision 在同一会话只注入一次。活动快照因无关 lesson 变化时不会重注入旧卡;
如果某个活动 lesson 升级, 下一次 prompt 只注入该 lesson 的新 revision。

lesson context 与批量评审 instruction 同时到期时, `additionalContext` 按以下顺序组合:

1. 本会话行动卡;
2. 后台反馈评审指令。

Stop/AfterAgent backstop 仍只约束到期评审完成标记, 不因为普通 lesson 注入阻断回合。

### 4.5 Effectiveness auditor: 复发时审计控制链

后台 reviewer 对同类首次反馈只分析「本次任务为什么做错」。对同类复发必须再分析一条独立的
「学习控制链为什么失效」, 不能把两条因果链合并成一句「规则没有吃进」:

1. 找到匹配的旧规则、lesson id 和当时应生效的 revision;
2. 读取当前 CLI/session 的 lesson receipt, 证明该 revision 是否被编译、选择和注入;
3. 对照用户请求、行动卡 `when` 和 agent 行为, 判断是否适用、是否执行;
4. 归类唯一的主失败模式, 并写出可验证的纠正动作;
5. 追加 effectiveness event, 更新 lesson revision/snapshot 后才允许给出完成 receipt。

失败模式和默认动作如下:

| failure_mode | 证据 | 必须动作 |
| --- | --- | --- |
| `not_materialized` | Markdown 规则存在, 但没有对应 active lesson | 编译并激活原规则, 不复制近义规则 |
| `not_selected` | active lesson 存在, session receipt 没有该 revision | 修正 scope/signals/load_policy, 复发严重度至少提升一级 |
| `loaded_not_applied` | receipt 证明已注入, 但 agent 没执行行动卡 | 严重度至少提升一级, 把 `do` 改成带前置检查和验收证据的强动作 |
| `contract_incomplete` | 已加载且部分执行, 但行动卡无法覆盖该场景 | 修订 when/do/exception, 生成新 revision |
| `external_limit` | 控制链已执行, 失败来自可证明的宿主限制 | 保留证据和 fallback, 不把限制伪装成 agent 已学会 |
| `unknown` | receipt/上下文不足, 无法证明在哪一层失效 | 标记 `review_due`, 保留队列证据, 不允许静默归档为已处理 |

这项审计只在识别到真实复发反馈时运行, 不在普通会话增加 LLM 调用。session receipt 和
snapshot 查询是本地结构化读取, 不消耗模型 token。

后台 subagent 完成后写 `review-receipts/<review-event-id>.json`; 主会话的隐藏完成标记只引用
`receipt=<review-event-id>`, 不再把一段不可验证的 HTML 注释本身当作完成证据。Stop/AfterAgent
backstop 必须校验 receipt 状态为 `acknowledged`, 且其中引用的 report、lesson event 和 snapshot
revision 均存在。这样「写了报告并清队列, 但学习状态没有变化」不能伪装成反思成功。

## 5. Lesson 数据模型

```json
{
  "id": "afl-lesson-...",
  "revision": 3,
  "status": "active",
  "load_policy": "always",
  "severity": "Critical",
  "responsibility": "agent_fault",
  "confidence": "high",
  "scope": {
    "level": "project",
    "project_key": "...",
    "paths": ["templates/hooks/**"],
    "tools": ["git", "computer-use"],
    "task_types": ["runtime-verification"],
    "signals": ["端到端验证", "live verification"]
  },
  "method_class": "learning-retrieval",
  "class_id": "producer-without-consumer",
  "card": {
    "when": "...",
    "do": "...",
    "why": "...",
    "exception": "...",
    "source": ".agent/reflections/...md"
  },
  "recurrence_count": 2,
  "effectiveness": {
    "previous_lesson_id": "afl-lesson-...",
    "expected_revision": 2,
    "was_materialized": true,
    "was_loaded": false,
    "was_applicable": true,
    "was_followed": false,
    "failure_mode": "not_selected",
    "control_owner": "selector",
    "corrective_action": "expand task_types and activate project-session loading",
    "audit_source": "~/.agent/feedback-loop/session-context/<session>.json"
  },
  "evidence": ["..."],
  "created_at": "...",
  "last_seen_at": "...",
  "review_after": "...",
  "token_counts": {
    "openai": 0,
    "claude": 0,
    "gemini": 0,
    "conservative": 0,
    "selection_cost": 0
  }
}
```

`signals` 由 reviewer 针对具体 lesson 生成, 可同时包含中英文别名。它不是全局写死的
「不满词表」, 只用于判断某项方法教训是否与当前任务有关。

`effectiveness` 只在复发事件上必填。`control_owner` 使用
`reviewer | compiler | selector | agent_execution | lesson_contract | external | unknown`,
用于把「任务执行过错」和「插件控制链失效」分开归责。

## 6. 严重度判定与加载策略

严重度根据后果而不是情绪判断。基础维度包括:

- 影响: 是否只增加少量返工, 或影响用户可见结果、真实环境、数据/凭据/安全;
- 复发: 是否首次出现, 是否跨会话重复, 是否已有规则仍再次发生;
- 可恢复性: 是否可以低成本撤销, 是否产生不可逆外部影响;
- 范围: 单一步骤、单一项目、跨项目或个人全局;
- 逃逸: agent 是否有便宜检查却未做, 是否在声称完成后才由用户发现。

基础分级语义:

| 严重度 | 判定语义 |
| --- | --- |
| Minor | 首次、局部、低成本可恢复, 不影响完成结论 |
| Major | 造成明确返工、遗漏用户要求或错误结论, 但未产生高风险外部影响 |
| Critical | 跨会话复发、已有规则仍失效, 或影响真实用户流程/live 环境且仍可恢复 |
| Blocker | 数据/凭据/安全/不可逆外部影响, 或继续执行会扩大损失 |

硬升级条件优先于普通评分:

- 数据破坏、凭据泄漏、安全风险、不可逆 live 操作 -> 至少 `Blocker`;
- 已有活动 lesson 仍发生同类过错 -> 至少升级一级;
- 跨会话重复并造成真实环境/用户流程影响 -> 至少 `Critical`。

如果 reviewer 已引用既有规则或 lesson 作为 repeated-pattern evidence, 却仍输出 `Major`
且没有可证明的 `external_limit`, schema validator 必须拒绝该事件。严重度规则不能只写在 prompt
里由模型自行选择。

### 6.1 反思深度随严重度变化

反思深度由必须回答的问题决定, 不使用固定字数或固定 token 截断:

| 严重度 | 完整报告最低要求 |
| --- | --- |
| Minor | 事实、直接原因、一个可执行局部改进; 不生成活动 lesson |
| Major | 完整 5 Why 到过程/默认假设层、遗漏信号、方法分类、行动卡 |
| Critical | Major 全部内容 + 决策时间线 + 独立的学习控制链 5 Why + effectiveness audit + 反事实检查点 |
| Blocker | Critical 全部内容 + 影响面/不可逆性 + 停止条件 + 回滚/隔离方案 + 是否提升为全局 lesson 的证据 |

报告完成度按字段和证据校验, 不是按篇幅校验。完整报告保存在磁盘; 普通会话仍只加载行动卡,
因此加深 Critical/Blocker 反思不会让每个后续会话携带整份 5 Why。

加载策略:

| 严重度 | 默认加载 | 生命周期 |
| --- | --- | --- |
| Blocker | 在适用 scope 内每个新会话加载 | 只有明确验证闭环后才能降级 |
| Critical | 每个相关项目会话加载 | 到 `review_after` 后由后台复审是否降为条件加载 |
| Major | scope/路径/工具/任务类型相关时加载 | 复发升级; 长期无复发可归档 |
| Minor | 不加载, 只累计趋势 | 同类累计达到阈值后升级 |

「每个新会话」不等于每个用户回合。相同 revision 在同一 session 只注入一次。

## 7. 相关性选择

selector 不调用 LLM。相关性由结构化元数据确定:

1. `scope.level` 和当前项目必须匹配;
2. path/tool/task_type 任一精确命中时提高优先级;
3. 当前 prompt 与 lesson `signals` 做本地规范化匹配;
4. Blocker 绕过相关性排序, 只受 scope 约束;
5. Critical 在项目 scope 内固定加载;
6. Major 只有达到相关性门槛才加载;
7. 不确定时跳过低严重度 lesson, 复发后由严重度升级纠正漏载。

选择器不维护「用户是否不满」的中英文模式; 反馈识别仍由延迟后台 reviewer 完成。

## 8. Token 预算与语义完整性

### 8.1 不使用固定 320-token 上限

`320` 只是早期按 60-90 tokens/卡片的估算, 对中文和不同模型不可靠。
现有项目规则段落已经达到约 529 和 932 个字符, 证明完整规则不能直接按英文字符比例估算。

### 8.2 计数发生在卡片创建/校准时, 不发生在每个会话

每张卡片记录各 provider 的 token 计数。可用精确计数器时使用:

- OpenAI: 对应模型 tokenizer/tiktoken;
- Claude: Messages count_tokens;
- Gemini: models.countTokens。

参考: [OpenAI tiktoken](https://developers.openai.com/cookbook/examples/how_to_count_tokens_with_tiktoken)、
[Claude count_tokens](https://platform.claude.com/docs/en/api/messages/count_tokens)、
[Gemini countTokens](https://ai.google.dev/api/tokens)。

CLI 没有可用 provider token counter 时, 使用经过三平台语料校准的保守本地估算器。
selector 使用已存储的最坏值:

```text
selection_cost = max(openai, claude, gemini, conservative)
```

因此会话选择不产生额外网络或模型调用。

### 8.3 预算由语料分布校准

发布前用真实中英文行动卡语料计算:

```text
single_card_target = P95(selection_cost) * 1.20
normal_soft_budget = 2 * single_card_target
severe_reserve_budget = 4 * single_card_target
```

具体默认值由测试语料结果生成并写进发布包, 不在设计阶段拍死。两个预算都可通过环境变量覆盖。

### 8.4 超预算策略

1. 先选 Blocker, 再选 Critical, 最后选相关 Major。
2. Minor 不参与上下文预算。
3. 下一张完整卡放不下时整张跳过, 禁止截断字段。
4. 同 class_id 的 lesson 必须先合并; always-loaded 严重 lesson 还必须按
   `method_class + scope` 编译成至多一张方法卡。
5. 严重卡仍超过 reserve 时, compiler 必须先按 class_id 合并并重新抽象, 不允许 selector
   无上限突破预算。
6. 发布校准同时产生 `absolute_budget`; selector 永远不得超过该上限。
7. 顶层方法分类数量是固定有界的; 发布时 `absolute_budget` 必须覆盖九个分类各一张
   最坏值方法卡的完整 severe index。
8. 合并后仍超出 absolute budget 时进入显式 degraded mode: 注入一张语义完整的
   `severe lesson index`。该索引逐项保留 lesson id、when、do 和 source, 并要求 agent
   在执行匹配任务前读取对应完整行动卡。不得截断索引项或静默遗漏严重 lesson。
9. 单张卡长期大于 P95 上限时由 compiler 重新抽象; 完整细节通过 source 按需读取。

## 9. 注入格式与按需深读

正常会话只接收如下紧凑上下文:

```text
[Agent Feedback Lessons - apply before acting]
- <id> [Critical]
  When: ...
  Do: ...
  Why: ...
  Exception: ...
  Source: ... (read only when this task needs the full incident context)
```

行动卡已经包含做出正确决策所需的完整契约。只有以下情况读取 source 完整报告:

- 当前任务确实命中 lesson, 但行动边界仍不清楚;
- lesson 之间出现冲突;
- 准备修改/降级/合并 lesson;
- 同类问题再次复发, 需要检查旧方法为什么没有生效。

这样深度反思不会丢失, 但完整 5 Why 不会永久占据每个会话。

## 10. 生命周期

Lesson 状态:

```text
candidate -> active -> review_due -> active / conditional / archived / superseded
```

- `candidate`: 新产出, 尚未通过证据/完整性校验;
- `active`: 按严重度策略加载;
- `review_due`: 到期后由现有延迟后台 reviewer 一并复审;
- `conditional`: 只在相关任务加载;
- `archived`: 保留历史但不进入上下文;
- `superseded`: 已被更高层 lesson 替代。

Minor 同 class_id 在复审窗口内累计三次时提升为 Major。已有 active lesson 再复发时至少升级一级,
并要求反思「为什么已有教训没有被加载或没有被执行」, 不能只追加同义规则。

对真实复发反馈, 以下四项全部持久化后才算处理成功:

1. 完整反思报告;
2. recurrence + effectiveness event;
3. 与 failure_mode 对应的 lesson revision/status/snapshot 变更;
4. 指向上述 event 的 review receipt。

后台 reviewer 可以在这些写入成功后清空已消费的队列项。只写报告、只清空队列、或仅返回
`rule_action: none` 都不能生成成功 receipt。为了避免失败时重复处理整个队列, queue entry 使用
event id 标记 `claimed -> reflected -> compiled -> acknowledged`, 最后一步完成后再压缩已确认项。

## 11. 插件安装与升级

`agent-feedback-loop install` 继续完成 prompt pack 和三 CLI hook 接线, 并新增:

- runtime selector 文件;
- lesson store/schema 版本;
- session-context 目录;
- `doctor` 的 selector/lesson/budget 检查;
- 已有 `.agent/rules/feedback-loop.md` 的一次性迁移提示。

升级不直接把旧 Markdown 规则机械切段。下一次后台评审时, reviewer 对有证据的现有项目规则生成
行动卡; 无证据、重复或过窄规则不迁移。迁移完成写入 schema/version marker, 避免每次重跑。

## 12. 可观测性

`AGENT_FEEDBACK_LOOP_DEBUG=1` 时新增单行日志:

```text
agent-feedback-loop: decision=lesson-context session=... project=...
selected=L1,L4 always=1 conditional=1 skipped_budget=L7
estimated_tokens=N soft_budget=S reserve_budget=R absolute_budget=A snapshot_revision=V
```

日志不得包含用户 prompt、卡片正文、证据原文或凭据。doctor 输出:

- active lesson 数量及严重度分布;
- 本地选择器是否可执行;
- token estimator/calibration 版本;
- 当前默认 soft/reserve/absolute 预算;
- 冲突、超大卡片、过期未复审数量;
- 三 CLI hook/backstop 连接状态。

## 13. 错误处理

- 活动快照不存在: 正常 turn fail-open, 队列/评审机制继续工作。
- 快照 JSON 损坏: 使用上一份有效快照并记录 warning。
- lessons 并发写入: 追加事件 + 原子 snapshot, 不做无锁原地覆盖。
- session_id 缺失: 使用 CLI 事件字段组合生成短期 receipt; 仍无法确定时宁可重复一次严重卡,
  不在每回合无限重复。
- token counter 不可用: 使用保守估算值, 不发起会话内 API 调用。
- 严重卡超 reserve: 先合并; 仍超 absolute 时使用完整 severe index degraded mode,
  不截断、不静默丢弃。
- 卡片缺字段: 保持 candidate, 不进入 active snapshot。

## 14. 验证策略

### 14.1 自动化测试

1. severity 硬升级和普通矩阵测试。
2. Blocker/Critical/Major/Minor 选择顺序测试。
3. 同 session/revision 只注入一次, revision 变化只注入增量。
4. project/path/tool/task_type/signal 相关性测试, 含中英文卡片。
5. 整卡选择测试: 预算边界不得产生截断文本。
6. 无关 snapshot revision 更新不得让已注入 lesson 重复进入同一会话。
7. 严重卡超过 reserve/absolute 时分别触发合并和 severe-index degraded mode。
8. 同 class_id 归并、复发升级、superseded/archived 排除测试。
9. 复发 effectiveness audit 六种 failure_mode 的状态迁移测试。
10. 「旧 Markdown 规则存在但没有 session receipt」必须归类 `not_materialized`, 不得
    `rule_action: none` 后只写报告。
11. repeated-pattern evidence + Major 的事件必须被 schema validator 拒绝。
12. 报告已写但 event/snapshot 未完成时不得清队列或签发成功 receipt。
13. malformed snapshot、缺 session_id、counter 不可用的 fail-open 测试。
14. queue review 与 lesson context 同时注入时的组合顺序测试。
15. debug 日志包含选择理由和预算, 但不包含 prompt/card 正文。
16. install/uninstall/doctor 对 Codex、Claude、Gemini 配置的回归测试。

### 14.2 Token 校准测试

1. 从现有反思/规则和新增 fixtures 生成至少 30 张中英文完整行动卡。
2. 对 OpenAI、Claude、Gemini 分别计数; 保存语料、模型和日期。
3. 使用三者最大值计算每卡 `selection_cost`。
4. 验证发布默认预算覆盖 P95 + 20% 余量。
5. 验证正常无相关 lesson 为 0 tokens, 单 Major、两 Major、四严重卡的实际成本。

### 14.3 真机端到端验收

在真实 Codex、Claude Code、Gemini CLI 新会话中分别验证:

1. Blocker 在适用 scope 内恰好进入一次。
2. Critical 在相关项目的新会话进入一次。
3. 无关 Major 不进入; 命中相同 path/tool/task_type 的 Major 进入。
4. Minor 不进入。
5. 卡片正文完整, source 可按需读取。
6. 模型在复现场景中主动执行卡片的检查/顺序, 而不只是复述规则。
7. 新会话没有额外 token-count/semantic-retrieval LLM 请求。
8. 队列、后台反思、Stop/AfterAgent backstop 仍正常工作。
9. 使用 Computer Use 检查真实 CLI 可见行为, 并把机制层与端到端层结果分开报告。
10. 复现「既有规则存在但本轮未注入」场景, 后台报告必须产出 `not_materialized` 或
    `not_selected` audit、升级原 lesson, 下一新会话能看到修订后的行动卡。
11. 复现「行动卡已注入但 agent 仍偏离」场景, 必须产出 `loaded_not_applied`, 不能用
    「已有同类规则所以不新增」结束评审。

## 15. 成功标准

实现完成必须同时满足:

- 用户在同项目新会话中能观察到模型主动规避已知严重问题;
- 无相关 lesson 的普通会话没有新增上下文;
- 偶发 Minor 不会永久占用上下文;
- 严重 lesson 不会因预算被截断或静默丢失;
- 所有注入都可解释「为什么选中/为什么跳过/消耗多少」;
- 反思完整报告、行动卡、加载 receipt、effectiveness audit 和复发事件形成可追踪闭环;
- 同类复发不会以「规则已存在」为由只生成报告; 每次复发都能看到控制链失败分类和状态变更;
- 三个平台至少各完成一次真实新会话验收, 不能只凭 doctor/单测宣称生效。

## 16. 实施边界

第一版只实现本设计所需的最小闭环:

1. lesson schema/event store/snapshot;
2. reviewer 产出完整行动卡;
3. recurrence effectiveness audit + review receipt;
4. Node selector + session receipt;
5. 严重度/相关性/预算选择;
6. core hook 组合注入;
7. doctor/日志/测试/三 CLI 真机验收。

不在第一版加入 embeddings、向量数据库、后台守护进程、Web UI 或每会话 LLM router。
