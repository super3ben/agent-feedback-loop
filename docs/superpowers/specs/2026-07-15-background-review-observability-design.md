# Agent Feedback Loop: 后台反思可观察性与主会话回执设计

- 日期: 2026-07-15
- 状态: 已确认设计，待实现
- 目标版本: 0.7.5
- 关联设计: `2026-07-10-severity-aware-reflection-learning-design.md`

## 1. 背景

当前事务型 feedback loop 已经把完整反思移到短生命周期 reviewer CLI 进程，主会话不等待、
不代写报告。这个执行边界降低了主会话上下文膨胀，但也造成新的产品问题：用户无法从主会话判断
反馈是否被捕获、reviewer 是否真正启动、receipt 是否完成落库，以及产生的 lesson 是否在后续任务生效。

日志、`doctor` 和 `memory explain` 是审计能力，不是日常反馈。仅在后台记录状态，会让一次真实成功的
反思在用户体验上与完全没有触发相同。本设计增加一个不参与语义判断的可观察性层，使每个用户可见
状态都由已持久化事实产生，同时保持完整反思不进入主会话。

## 2. 设计原则

1. 不把“已捕获候选”“已排队”“正在运行”“已完成”“lesson 已投递/观察”合并成一个模糊的“已触发”。
2. 只有对应数据库事务提交后才能生成回执，禁止先显示成功再异步补写状态。
3. 主会话只出现一行确定性摘要，不出现反馈原文、5 Why、报告正文或模型隐藏推理。
4. 回执由可信 runtime 渲染，不由主模型自由总结或改写。
5. 普通消息零回执、零额外 reviewer 请求；只有真实状态变化才产生有限的主会话 Token。
6. 后台 reviewer 完成不能跨平台直接向已经结束的会话追加消息时，立即发送系统通知，并在该会话
   下一次用户输入时补发最终回执，不伪装成实时聊天消息。
7. 回执投递失败不能回滚已经完成的反思；反思完成和用户是否看到回执必须分别审计。
8. 回执本身是 synthetic control event，不能再次成为反馈候选、长期记忆证据或 lesson 检索文本。

## 3. 用户可见状态

### 3.1 固定格式

所有主会话回执使用确定性单行格式，正文最长 160 个字符，默认跟随当前会话语言：

```text
[AFL] 已捕获反馈候选 · event=8c9d12 · receipt=4a6f10
[AFL] 后台反思已排队 · job=7e876e · receipt=93bd21
[AFL] 反思完成 · severity=Major · lessons=1 · job=7e876e · receipt=aa10c4
[AFL] 已复核，本次未形成长期经验 · job=7e876e · receipt=b91e02
[AFL] 反思失败，证据已保留并等待重试 · job=7e876e · receipt=c5018f
[AFL] 已向本任务投递 1 条历史经验 · receipt=d218a7
```

可见文本之后携带一个不展示的稳定标记，用于 Stop/transcript 回执确认：

```html
<!--afl-receipt id=<receipt-notification-id> nonce=<nonce> state=<state>-->
```

标记不得包含用户原文、项目路径、报告内容、密钥或完整 session id。可见 job/event id 只显示安全引用的前
6 位；每一行还必须包含 canonical `notification_id` 前 6 位形成的 `receipt` binding，完整身份保留在本地
store 中。当前控制标记使用 domain-separated v2 SHA-256 commitment，输入依次为 canonical
`notification_id`、`state` 和 renderer 生成的完整可见行，截取 16 个十六进制字符。该 commitment 和
`receipt` binding 共同约束 event/job/severity/lesson count 等所有可见动态字段；保留旧 marker 而修改任一
字段时，剥离器必须保留整对文本。

新建 `notification_id`、renderer 和 hidden marker 只接受小写 64-hex canonical ID。canonical Stop observation
必须根据 authoritative outbox row 重渲染可见行并校验其精确 v2 marker，旧的 canonical ID-only v1 marker
不得转为 `observed`。读取历史 store 行时可额外接受唯一已证明的 legacy 语法
`notification-<positive integer>`，且仅在独立 v1 `receiptNonce` 路径确认；不接受 UUID、`msg_UUID`、
colon/session 或 path 形态，也不允许未知 state。legacy 行只可确认，不得由新 renderer 生成或由剥离器删除。

### 3.2 状态语义

| 回执 | 可生成条件 | 不代表 |
| --- | --- | --- |
| `candidate_captured` | 用户事件和触发信号已经持久化 | 已认定为真实反馈、reviewer 已运行 |
| `review_queued` | reviewer job 事务已提交 | reviewer 已开始或已完成 |
| `review_started` | worker 已成功 claim lease | review receipt 已提交；默认不在主会话展示 |
| `review_completed` | report、lesson、review receipt 和 job completion 同事务提交 | lesson 已在未来任务被应用 |
| `reviewed_no_lesson` | reviewer 提交了有内容的无 lesson receipt | 没有执行 reviewer |
| `review_retrying` | 可重试失败已持久化 | 最终失败；默认只发系统通知，不刷主会话 |
| `review_exhausted` | 重试耗尽或不可恢复失败已持久化 | 证据已删除 |
| `lesson_delivered` | lesson delivery receipt 已创建且状态为 `emitted` | 模型已经观察；后续仍由 nonce observation 确认 |

`candidate_captured` 后即使最终判定不是回顾性反馈，也必须补发 `reviewed_no_lesson`，让用户知道后台
确实完成了复核，而不是无声丢弃。

为避免普通批处理产生噪声，`reviewed_no_lesson` 和 `review_exhausted` 只投递给此前已有
`candidate_captured`/`review_queued` 可见状态的 session；无强触发信号的延迟批次只有在 reviewer 形成
真实 lesson 时才向对应证据 session 投递 `review_completed`。

## 4. 架构

### 4.1 ReceiptOutbox

所有回执通过事务型 outbox 创建。新增 `notification_outbox`：

```text
notification_id
session_uid / context_epoch
job_id / event_uid / application_id
kind
payload_json
chat_state = pending | emitted | observed | emitted_unconfirmed | suppressed
chat_turn_id / chat_emit_attempts / chat_block_attempted / chat_emitted_at
system_state = not_applicable | pending | delivering | delivered | failed | unsupported | suppressed
system_owner / system_lease_until / system_attempts / next_attempt_at
created_at / updated_at / chat_observed_at / system_delivered_at
```

唯一键按回执语义建立，例如 `(session_uid, job_id, kind)`；重复 hook、重复 scheduler 扫描或 worker 重试
只能幂等命中同一条回执。创建 `review_completed` 时必须与 review receipt 同事务提交；创建
`lesson_delivered` 时必须与 delivery receipt 的 `emitted` 状态同事务提交。

chat/system 领取必须在事务内完成。chat receipt 绑定当前 native turn，Stop 只确认该 turn 已发出的 nonce；
system notifier 使用 owner + lease 领取，进程崩溃后由 scheduler 回收过期 `delivering`，禁止两个 worker
并发发送同一通知。outbox 保存结构字段，不保存已渲染的用户原文。最终文案由版本化 renderer 生成，payload 只允许严重度、
lesson 数量、短身份、reason code 和本地化语言等白名单字段。

### 4.2 主会话投递

主会话投递分两类：

1. 当前 `UserPromptSubmit`/`BeforeAgent` hook 同步创建的回执，直接附加到本轮 hook context；
2. 后台 reviewer 或补扫器在本轮结束后创建的回执，保留为 `pending`，在同一 `session_uid` 下一次
   prompt hook 中补发。

hook 只领取当前 session、当前 context epoch 可见且尚未确认的回执。注入内容要求主 agent 在第一条
用户可见更新或最终答复中逐字输出回执行和隐藏标记，不允许扩写反思内容。Stop hook 检查当前 assistant
输出或 transcript 中的 nonce：

- 观察到标记：`emitted -> observed`；
- 未观察到：`emitted -> emitted_unconfirmed`；
- 下一轮最多重发一次；仍不可观察时停止强制重发，保留系统通知和审计入口，避免无限循环。

Stop hook 仅在存在本轮待确认回执时最多阻止一次，要求补齐固定回执行。普通会话和已经确认的回执不增加
Stop 轮次。宿主无法提供 assistant 输出或 transcript 时，不得写 `observed`。

进入 capture/reconcile 前，剥离器只删除相邻的完整控制对，并同时验证 canonical marker ID、state、
state-specific 可见文法、`receipt=<marker id 前 6 位>`，以及由 marker ID、state 和相邻完整可见行重算的
精确 v2 nonce。反引号或波浪号 fenced code block 内的内容、quoted 内容、畸形 marker、错误
state/nonce/binding、旧版无 binding 行和非相邻控制必须原样保留，避免删除用户证据。

Codex transcript reconciliation 必须在空文本判断前提取 tool/output/file/artifact refs，并统一通过
`hasCaptureEvidence` 判定是否跳过。`content: []` 但存在结构引用的真实 assistant event 必须落库，同时 cursor
推进到已扫描 EOF；只有语义文本和全部结构引用都为空时才可跳过。

跨宿主不承诺后台进程能主动向已结束的聊天追加消息。Codex、Claude Code、Gemini CLI 若未来提供稳定、
可授权的会话消息 API，可新增 native chat delivery adapter；当前基线仍是系统通知立即送达、主会话下一轮补发。

### 4.3 系统通知

系统通知用于填补“后台完成到下一次用户输入”之间的时间窗口：

- macOS: Notification Center adapter；
- Linux: `notify-send` 存在时启用；
- Windows: 后续 capability manifest 验证通过后启用，不因 Node 进程可启动就宣称支持；
- 没有通知能力时标记 `unsupported`，不影响 review transaction。

默认发送 `review_completed`、`reviewed_no_lesson`、`review_exhausted`；普通 retry 只记日志。系统通知失败
按 outbox 重试并记录 reason code，但不能把 reviewer job 改回 pending。

### 4.4 审计命令

新增：

```text
agent-feedback-loop review list [--session <id>] [--status <state>] [--home <path>]
agent-feedback-loop review show <job-id> [--home <path>]
```

`review list` 显示时间、来源 session、job 状态、provider、attempt、severity、lesson 数、chat/system 回执状态。
`review show` 显示结构化报告、证据身份、receipt、失败历史、lesson 和后续 application/effectiveness；默认仍对
敏感正文脱敏。命令展示正式 reviewer 产物，不展示 provider 的隐藏 chain of thought。

失败历史来自同事务写入的 `reviewer_job_events`（claim/requeue/completed/failed/retry_exhausted），只保存
attempt、lease epoch、provider、状态和 reason code，不保存 reviewer 输入输出正文。

## 5. Token 与噪声控制

- 单条主会话回执硬限制为 160 字符；隐藏标记不携带语义正文。
- 每个 job 最多展示一次排队状态和一次最终状态。
- `review_started` 和普通 retry 不进入主会话。
- `lesson_delivered` 每个 session/context epoch 聚合为一条，不逐 lesson 展开。
- 普通 prompt 没有 outbox 状态变化时不注入任何文本。
- 回执不调用 LLM；唯一 Token 成本是被主会话模型读取并逐字输出的单行文本。
- 完整报告只能通过 `review show` 主动查看，不自动注入后续会话。

## 6. 失败与恢复

1. reviewer 启动失败：保留 job 和证据，创建真实的 retry/unavailable 状态，不显示“反思完成”。
2. reviewer 完成但系统通知失败：review 仍为 completed，通知 outbox 独立重试。
3. 主会话回执已注入但未观察：最多下一轮重发一次，之后保持 `emitted_unconfirmed`。
4. 重复 hook：唯一键和 nonce 防止生成重复回执。
5. 宿主旧会话没有热加载新 hook：Codex 由 transcript reconciliation 捕获状态，系统通知可独立发送；
   主会话回执必须等真实 prompt hook 执行后才能补发。Claude/Gemini 若宿主不热加载，明确要求新建或重启
   会话，不能用配置已写入代替验证。
6. scheduler 崩溃：下次 scheduler/hook 领取未完成 outbox 和过期 reviewer lease，状态转换保持幂等。
7. 回执文本被 transcript 补扫再次观察：标记为 synthetic control event 并过滤，不进入 feedback gate。

所有路径写结构化日志：

```text
receipt.outbox.created notification=<id> kind=<kind> session=<hash>
receipt.chat.emitted notification=<id> attempt=<n>
receipt.chat.observed notification=<id>
receipt.chat.unconfirmed notification=<id> reason=<code>
receipt.system.delivered notification=<id> adapter=<adapter>
receipt.system.failed notification=<id> reason=<code>
```

日志只写 opaque id/hash 和 reason code，不写反馈原文或报告。

## 7. 配置与兼容

默认配置：

```text
AGENT_FEEDBACK_LOOP_CHAT_RECEIPTS=1
AGENT_FEEDBACK_LOOP_SYSTEM_NOTIFICATIONS=1
AGENT_FEEDBACK_LOOP_RECEIPT_LANGUAGE=auto
```

关闭 chat receipt 只影响可见回执，不关闭 capture/reviewer/lesson。升级使用 schema migration，不修改既有
review receipt 和 delivery receipt 的语义。历史已完成 job 不批量制造通知；只对升级后新状态转换创建 outbox，
避免安装后刷出大量旧消息。

关闭 chat 或 system receipt 时，本轮可投递项进入 `suppressed`，重新启用后不追发关闭期间的历史回执，
避免配置切换造成消息洪峰。`reviewer_jobs` 同时持久化实际 reviewer provider（原生 CLI、显式命令或
prompt subagent），审计命令不得用来源会话 CLI 冒充实际 reviewer provider。

## 8. 测试与验收

### 8.1 自动化测试

1. RED/GREEN 覆盖每种状态到 outbox 的事务绑定。
2. 重复 capture、重复 scheduler、worker retry 不产生重复回执。
3. current-turn 回执和 next-turn completion 回执按 session 隔离。
4. Stop 观察 nonce 后确认，缺失时只重发一次。
5. 回执文本不进入 feedback candidate、lesson selector 或长期证据。
6. renderer 中英文、binding 精确副本、长度上限、敏感字段白名单和非法 payload 拒绝。
7. reviewer receipt 提交失败时绝不产生 completed 回执。
8. system notifier 失败、重试、unsupported 不影响 review 状态。
9. `review list/show` 正确区分 captured、queued、running、completed、delivery 和 effectiveness。
10. backtick/tilde fenced、quoted、畸形、错误 state/nonce/binding 和伪造旧行不会被剥离。
11. canonical 真实 outbox 行只有从 authoritative rendered line 得出的精确 v2 marker 可转为 `observed`；canonical ID-only v1 marker 保持未确认。
12. 精确 legacy `notification-<positive integer>` v1 marker 可转为 `observed`；UUID、`msg_UUID`、session、path、zero、leading-zero 和 oversized 形态保持未确认。
13. 每种回执的精确生成对可剥离；event、job、severity 或 lesson count 任一字段改变且沿用旧 marker 时整对保留。
14. Codex `content: []` 加 tool/output/file/artifact refs 的结构事件落库且 cursor 推进到 EOF。

### 8.2 真机状态矩阵

发布验收必须记录真实 session/job/receipt/notification id 和状态前后计数：

| 场景 | 必须证明 |
| --- | --- |
| 全新 Codex 任务 | captured -> queued -> reviewer receipt -> chat/system completion receipt |
| 安装前已存在且宿主不重启的长期 Codex 任务 | transcript 补扫是否捕获；若 chat hook 未热加载，明确记录 system-only/next-prompt 边界 |
| 同一 turn 追加纠正 | referent 正确、只建一个 job、当前轮出现候选/排队回执 |
| 历史压缩或替换 | reconciliation 恢复的事件不重复，最终回执关联原 session |
| Hook 漏执行 | scheduler 至少连续复跑两次并恢复 capture/job/outbox |
| reviewer 首次失败后恢复 | attempt/lease_epoch 递增、旧 worker 不能提交、最终 receipt 和回执唯一 |
| 不应触发的普通请求 | 没有 reviewer job，也没有主会话或系统回执 |
| lesson 后续匹配 | 新任务收到 `lesson_delivered` 回执，并区分 emitted 与 observed |

Claude Code 和 Gemini CLI 分别执行相同的新会话矩阵。缺少 CLI、认证、原生事件或可观察 transcript 时，
对应能力只能标为 unavailable/unverified，不能由 Codex 结果替代。Computer Use 必须尝试验证桌面可见回执；
若宿主安全策略拒绝访问，则保留命令、错误和替代证据，并明确 UI 未验收。

### 8.3 完成条件

只有以下证据同时存在才能宣称闭环：

1. 新任务与至少一个既有长期任务的真实结果被分别记录；
2. 事件已持久化，job 已排队且 reviewer receipt 已提交；
3. scheduler 至少连续复跑一次并证明过期任务可恢复；
4. 主会话回执达到 `observed`，或明确记录宿主限制并由系统通知补偿；
5. lesson 生成和后续 application/delivery receipt 可关联；
6. 非触发样例证明没有 job 和回执；
7. 全量自动化测试和真实安装后的 `doctor --live` 均通过其各自可证明的范围。

`doctor healthy`、配置文件存在、单次手动 reviewer、局部测试通过或系统通知出现，均不能单独代表完整闭环。
