# Agent Feedback Loop: 严重度感知的长期行为记忆与反思学习设计

- 日期: 2026-07-10, 2026-07-15 更新
- 状态: `0.7.4` 已实现并完成全量测试、真实会话链路诊断与用户级运行时验证；Codex 桌面 UI 自动化仍被 Computer Use 安全策略拒绝，不记为真机 UI 验收
- 目标层级: 个人用户级可复用插件, 项目级行为记忆, 证据满足后可提升为个人全局行为记忆

## 1. 背景与问题

旧版只能把用户消息写入队列, 再向当前 agent 注入「启动后台反思 subagent」的要求。这个边界无法证明
三个 CLI 真正启动了独立 reviewer, 也会占用主会话。`0.7.3` 起改为由 hook/补扫器提交 job 后直接启动
短生命周期的 Codex、Claude 或 Gemini headless CLI 进程；证据通过受限文件/stdin 传递, 主会话不接收
反思提示。Codex 另外通过 60 秒增量 transcript 补扫关闭升级、热加载和同一 turn 追加纠正的漏采窗口。
长期收益由结构化 lesson 选择、delivery observation 和复发 effectiveness 审计闭环验证。

`0.7.4` 进一步关闭了“已经捕获和生成 lesson，但后续任务没有收到”的缺口：同一轮明确纠偏只注入
短检查点，完整反思仍在后台运行；Major lesson 对宿主缺失的 task metadata 不再判为不匹配，并可用
行动卡 `when` 做有阈值的本地中英文检索。诊断命令必须区分 lesson 从该会话产出后是否向外投递，和既有
lesson 是否投递进该会话，禁止再把“同属一个 reviewer job”或“已经记录”当成“已经生效”。

此前用户能看到记录不断增加, 却很难在同项目的新会话里感受到模型主动吸收了旧问题。
这与之前 pipeline-orchestrator 中可感知的同项目反馈效果不同: 后者实际把既有教训
重新放回了后续执行上下文, 当前插件则主要停留在生产反思产物。

本设计把 feedback-loop 从「反思记录器」改造成闭环的长期行为记忆插件。第一版只记
Agent 自己的行为教训, 不混入用户画像、项目事实或一般知识:

```text
完整会话短期保存 -> 用户明确反馈 -> 反馈会话归档 -> 深度反思
                  -> 结构化行动卡 -> 按严重度/相关性选择
                  -> 后续任务应用 -> 效果审计 -> 复发时升级
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
9. 反思必须由独立后台 reviewer 完成, 不占用主会话, 不允许主会话代写, 也不依赖 Superpowers 等任务执行流水线。
10. 所有选择、跳过、预算和异常都有不泄漏用户原文的诊断日志。
11. Codex、Claude Code、Gemini CLI 的完整会话文本统一进入本地热存储, 普通会话滚动保留 10 天。
12. 真实反馈会话保留到关联 lesson 归档后 30 天, 证据索引不替代完整会话归档。
13. 只有用户明确纠正、不满或重复要求形成的回顾性反馈才允许生成长期 lesson。
14. 项目 lesson 只有在至少两个不同项目出现同类独立反馈并通过复审后, 才能提升为个人全局 lesson。
15. 运行文件、用户原文和长期记忆使用不同根目录; 卸载或升级运行文件不能删除长期记忆。
16. 选择、评审、lesson revision、receipt 和删除必须具有事务性、幂等性和崩溃恢复语义。
17. 宿主能力不足时必须保持任务 pending 并诚实报告, 不得回退到主会话或伪装成已经硬约束。
18. 项目隔离是数据 scope, 不是把可变记忆写进项目 Git 工作树。

## 3. 非目标

- 不把全部历史反思加载到每个会话。
- 不在每个用户回合重复注入同一批教训。
- 不用关键词表判断用户是否不满。
- 不在正常会话里调用第二个模型做语义检索。
- 不自动把所有项目教训提升为个人全局规则。
- 不用简短行动卡替代完整反思报告; 二者用途不同且同时保留。
- 不承诺仅靠 prompt 就能绕过宿主平台更高优先级的系统规则。
- 不把用户偏好、项目事实、业务知识或普通会话摘要写进本行为记忆库。
- 不把完整会话或完整反思默认注入后续模型上下文。
- 第一版不使用 embeddings 或向量数据库; 未来向量检索只能提供候选, 不能直接决定注入。
- 不启动常驻模型或常驻 reviewer; macOS 允许一个不读取正文、不调用模型的轻量本地调度 daemon，
  负责周期性启动有界补扫子进程和恢复到期 lease。
- 不保证删除宿主 CLI 自己的 transcript、操作系统备份或用户另外导出的副本; 插件只保证删除自己管理的数据闭包。

## 4. 核心架构

### 4.1 Capture: 跨 CLI 完整会话热存储

Codex、Claude Code、Gemini CLI adapter 把各自 hook 明确暴露的事件和可读取 transcript
归一化为统一 session event。不能从 UI 文案反推对话, 也不能把 `transcript_path` 存在等同于
「当前 turn 已经完整写入」。每个 release 必须携带经过真机验证的 capability manifest:

```text
cli / tested_version / adapter_version / event / available_fields
timeout_unit / timeout_value / capture_phase / completeness_ceiling
runner_command_protocol / launch_mode / detach_strategy / start_ack_timeout
job_timeout / termination_strategy / completion_receipt_schema / tool_gate
last_live_canary_id / last_live_canary_at / capability_status
```

`capability_status=supported` 只能由 `doctor --live` 的隔离 canary 写入: runner 必须在 start-ack 超时内证明
已脱离 hook 生命周期, 最终 receipt 通过 schema/epoch 校验, capture 也达到 manifest 声明的 completeness。
静态配置存在但没有 live canary 时只能是 `configured_unverified`, 不能标 supported/complete。

Codex transcript 补扫以原生 message id 或稳定字节偏移作为消息身份, 以 observation alias 合并 hook 与
transcript 对同一消息的观察。同一 turn 中只有在 assistant 已输出后出现的真实用户消息才形成即时纠偏信号;
assistant 输出前的连续补充只采集不快触发。即时 reviewer 启动前必须先持久化该 turn 最近可见 assistant referent。
对于已被 Codex 压缩出普通消息流的记录, 只允许从有界 `compacted.replacement_history` 恢复最近真实用户消息,
不得把整段压缩上下文送入 reviewer。补扫游标只保存 inode/offset/turn/id 等结构状态, 不保存会话正文。
同一项目在一次补扫中出现多条即时信号时先入库再合并, 每次补扫最多唤醒一个 reviewer。

最低捕获契约如下; 具体最低版本由发布验收生成, 不在未经真机验证时拍定:

| CLI | 当前 turn 的首选来源 | 收尾来源 | 必须诚实声明的边界 |
| --- | --- | --- | --- |
| Codex | `UserPromptSubmit` payload 中可证明存在的 prompt/session 字段 | Stop/本地 transcript 中已落盘事件 | `transcript_path` 缺失或为 null 时不得声称 full |
| Claude Code | `UserPromptSubmit` prompt + 可读取 transcript | Stop transcript | command hook timeout 按秒; transcript 尾部可能尚未完成 |
| Gemini CLI | `BeforeAgent.prompt` | `AfterAgent.prompt_response` + transcript | hook timeout 按毫秒; `SessionEnd` 是 best effort |

Gemini 的 timeout 单位以[官方 hook reference](https://geminicli.com/docs/hooks/reference/)为准;
Claude 的事件和 timeout 以[官方 hook reference](https://code.claude.com/docs/en/hooks)为准。
adapter 安装时必须按 CLI 分别写正确单位, 不能复用一个裸数字配置。

统一事件至少包含:

```text
installation_id
session_uid = namespace(cli, native_session_id, installation_id)
event_uid = namespace(cli, installation_id, native_session_id, source_namespace, source_event_id)
source_namespace / source_event_id / event_seq / native_turn_id / parent_event_id / context_epoch
project_id / repository_lineage_id / cwd / timestamp / role / model
redacted_text / encrypted_raw_ref / content_hash / redaction_manifest
tool_name / normalized_tool_args / textual_output_ref / file_refs / artifact_hashes
capture_source / capture_completeness / adapter_version
capture_policy_revision / data_class(user|synthetic_canary)
```

- `installation_id` 首次初始化后持久化在 `data_root/identity.json`, 并由 key_root 的 key 做 MAC;
  runtime 升级、卸载和重装不得重新生成或覆盖。
- `source_event_id` 只要求在同一 source namespace 内稳定; 数据库以全局 namespaced `event_uid` 做幂等 upsert,
  不能把 source-local id 直接设为全局唯一。offset 只用于加速, 不能作为正确性边界。
- capture off/on/exclude 每次变更都递增 `capture_policy_revision`。hook 在读取正文前检查一次, 在写事务内
  再检查当前 revision/decision; 在途 hook 使用旧 revision 时必须丢弃正文, 不能在 off 之后补写。
- 每个事件单独记录当时的 cwd/project, 同一 CLI session 切换项目时不能沿用 session 首次 cwd。
- 捕获通道只包括用户/assistant 可见文本、明确暴露的工具调用和文本输出。二进制文件不复制, 只保存路径、hash 和必要元数据。
- 完整原文只以加密 blob 保存 10 天; 索引和自动评审默认使用 `redacted_text`。原文 hash 用于证明 referent,
  但日志、active projection 和行动卡不得包含原文。脱敏改变 quote span 时, 该证据不能自动晋升为长期 lesson。
- 数据目录使用 `umask 077`、目录 `0700`、文件 `0600`, 拒绝符号链接和权限不满足的路径。
- completeness 使用 `prompt_only | partial | complete`。adapter 无法证明 assistant turn 或关键工具输出完整时,
  只能标记 partial; partial 可以辅助人工排查, 但不能单独支撑长期 lesson。
- 普通 session 从最后更新时间起滚动保留 10 天。插件删除只覆盖自己的加密 blob 和索引,
  不承诺删除宿主 transcript、Time Machine 或其他备份。

项目身份分成两个层级:

- `project_id`: 当前用户数据域中的项目实例, 用于项目 lesson scope;
- `repository_lineage_id`: 规范化 Git remote identity 或用户明确确认的 lineage, 用于判断跨项目证据独立性。

worktree/clone 可以共享 lineage, 但各事件仍保留自己的 project_id。没有 remote、来源不明的复制目录
或无法证明 lineage 的项目可以使用本地 lesson, 但不得参与个人全局提升。

project/lineage identity 记录 `normalization_version`。remote 规范化必须去凭据、统一 host case、协议和 `.git`
后缀; remote/path 变化先写 alias, 不自动生成第二份跨项目证据。错误拆分或合并只能通过可审计的
`memory project alias|merge` 修正, merge 后重新计算 promotion aggregate。

### 4.2 ReviewerRunner: 独立后台评审执行契约

shell hook 不依赖 Codex/Claude/Gemini 主会话自行委派, 而是通过版本化 `ReviewerRunner` 直接启动独立
CLI reviewer 进程:

```text
submit(job_id, project_id, incident_ids, prompt_version) -> runner_job
claim(job_id, owner_id, lease_until, attempt) -> monotonic lease_epoch
heartbeat(job_id, owner_id, attempt, lease_epoch, lease_until)
complete(job_id, owner_id, attempt, lease_epoch, review_receipt_id)
fail(job_id, owner_id, attempt, lease_epoch, retryable, reason_code)
```

当前实现使用 `isolated_cli_process`: hook 只创建一个短生命周期、非交互、独立上下文的 CLI reviewer
进程后立即返回。若未来宿主提供可证明生命周期隔离的原生后台 agent API, 可新增
`native_background_agent` adapter, 但不得把 prompt 委派伪装成原生能力。

`isolated_cli_process` 不是常驻 daemon。它必须有 job lease、硬超时、最多重试次数、独立日志、受限工作目录
和完成回调; 崩溃后由下一次 hook 或周期补扫回收过期 lease。runner 只读取经过授权的 incident evidence,
通过插件命令提交 report/lesson transaction, 不直接任意修改 store。

`lease_epoch` 是每次成功 claim 单调递增的 fencing token。heartbeat、complete、fail 和最终 store transaction
必须同时满足 owner/attempt/lease_epoch 与当前记录一致且 lease 未过期; 旧 worker 即使恢复运行也不能提交、
清队列或覆盖新 worker 的结果。

reviewer model 默认禁用 shell、网络、MCP 和项目写入工具, 只接收 evidence renderer 产生的受限输入并输出
schema-validated JSON。确需补证时只能向 evidence broker 请求受控的只读 source id/范围, 由 broker 决定是否返回;
模型本身不能跟随历史文本中的路径或指令。最终 report 渲染、store transaction 和规则校验由可信 runtime 完成。

install/doctor 对每个 CLI 探测 runner 能力并记录 `supported | degraded | unavailable`。没有独立 runner 时:

- 队列和 reviewer job 保持 pending;
- 正常任务 fail-open, 但显示一次可诊断的 `reviewer_unavailable` 状态;
- 严禁主会话 fallback 代写完整反思, 严禁清队列或签发成功 receipt;
- 不得宣称该 CLI 已满足自动反思要求。

ReviewerRunner 只在到期批量评审时调用模型, 普通 prompt 的捕获和 lesson 选择仍为零额外模型请求。

### 4.3 Producer: 后台反思 reviewer

现有后台 reviewer 继续负责事实核验、责任分类、严重度判定、决策路径还原、
5 Why、遗漏信号、复发原因、类别抽象和方法改进。

当结论满足以下条件时, reviewer 除写完整报告外, 还要写结构化 lesson event:

- 用户原话能逐字引用, 且能通过 `referent_event_ids` 指向明确的既有 agent 输出或该输出对既有要求的遗漏;
- responsibility 为 `agent_fault`;
- confidence 为 medium/high;
- 有可执行的方法改进;
- 能给出明确适用范围和反例/例外;
- 不是单纯预防性提醒或低证据猜测。

Agent 自检、预防性提醒、用户对主动澄清问题的回答以及普通任务约束均不得生成长期 lesson。
第一版宁可漏记也不允许把未被用户确认的推测写成长期行为约束。

每个候选必须保存 `feedback_event_id`、quote span、`referent_event_ids`、referent content hash、
时间顺序和解析状态。重复要求只能触发候选搜索; 找不到先前 agent 输出或可证明遗漏时不得创建 lesson。
incident 使用稳定 fingerprint 去重, 同一事故的重复消息只增加 evidence, 不制造第二个独立 incident。

fingerprint 持久化 `fingerprint_version`:

```text
incident_fingerprint = H(version, session_uid, feedback_event_id, sorted(referent_content_hashes))
incident_family_id = H(version, canonical_method_class, canonical_class_id, normalized_failure_mechanism)
```

前者只去除同一反馈事故的重复导入; 后者由 compiler 在证据审查后分配, 用于复发/跨项目聚合。
family 变更必须写 merge/split event 并重算 promotion, 不能靠重新运行模型无痕改 id。

发现同类 Markdown 规则或 active lesson 时, reviewer 只禁止创建重复规则, 不能因此停止处理。
真实反馈一旦属于复发, 必须追加 recurrence event, 审计旧教训为什么没有产生约束效果,
并对原 lesson 做激活、升级、修订或进入待复审状态。`existing rule found` 不是
`rule_action: none` 的充分条件。

### 4.4 Store: 事务型用户数据域

运行文件与持久数据必须使用不同根目录, 防止旧版 `uninstall --remove-files` 递归删除长期记忆:

```text
runtime_root = ~/.agent/feedback-loop/versions/<runtime-version>/
runtime_launcher = ~/.agent/feedback-loop/bin/afl-hook
runtime_current = ~/.agent/feedback-loop/current.json
data_root = ~/.agent/feedback-loop-data/
key_root = ~/.agent/feedback-loop-keys/
store = <data_root>/store/feedback-loop.sqlite3
blobs = <data_root>/blobs/sha256/<content-hash>.enc
safety_projection = <data_root>/safety/guard.json.mac
exports = <data_root>/exports/
```

旧版可能删除 `~/.agent/feedback-loop`, 但永远不能触达 sibling `feedback-loop-data` 和 `feedback-loop-keys`。所有 session、incident、
reflection report、lesson、global promotion、receipt、runner job、GC 标记和 tombstone 都进入 data_root,
不在项目 Git 工作树创建可变记忆文件。项目隔离由 project_id/scope 保证; 只有用户显式执行脱敏 export
时才向项目目录生成可分享副本。

第一版使用支持事务、唯一约束、外键和 WAL 的 SQLite store, 不再用 JSONL offset 作为并发正确性机制。
运行时必须打包或要求一个经过三平台安装验证的 SQLite backend; backend 不可用时禁用长期记忆并由 doctor
明确报错, 不能静默退回无锁文件追加。package engine/backend 的最低版本必须写入 capability manifest,
安装器在改 hook 前先验证; 不满足时保留旧 prompt-only 能力但不启用长期记忆。最低表集合包括:

```text
projects / sessions / session_events / content_blobs / queue_events
incidents / incident_events / feedback_referents
lessons / lesson_revisions / lesson_incidents / lesson_events / project_overrides
applications / delivery_receipts / verification_receipts
reviewer_jobs / review_receipts / gc_marks / tombstones / schema_migrations
```

事务与持久化不变量:

- `source_event_id`、incident fingerprint 和 `(lesson_id, revision)` 有唯一约束, 重复 hook firing 只能幂等成功;
- reviewer job 使用 owner + lease + attempt 原子 claim, 过期 lease 才能重领;
- lesson 更新使用 `base_revision` CAS, 分叉写入进入冲突处理而不是 last-write-wins;
- report、lesson revision、引用关系、active projection 和 review receipt 在同一事务提交后才可清队列;
- archive blob 先写临时文件、fsync 文件与父目录、原子 rename, 再在事务中发布引用;
- event 表只保留无正文元数据和 content id, 可删除正文单独存放, 以支持真实 deletion closure;
- selector 使用 read-only transaction 读取 active projection, 数据库损坏时使用经过校验的只读备份并报警。

Blocker/Critical/safety hold 另编译为不含正文的 MAC 签名 `safety_projection`。新增 hold 时先原子发布更保守
projection 再激活 DB revision; 移除 hold 时先提交已复审的 DB revision 再发布删除, 保证崩溃窗口只会多拦截、
不会少拦截。tool gate 必须验证 MAC 和 projection revision。store、备份和 safety projection 都不可读或
无法验证时, 已配置的高风险确定性工具类别 fail-closed; 不支持硬 gate 的宿主进入 `memory_safety_unknown`
checkpoint hold。普通捕获、低风险 lesson 和非安全选择仍可 fail-open。

完整原文是加密 blob; 自动 selector 永远只读取结构化卡片。source 对外只暴露 opaque id,
不会把项目 A 的本地路径或报告内容注入项目 B。review receipt 与 application/delivery receipt 是不同实体:
前者证明评审事务完成, 后者只描述某次 lesson 传递状态。

加密使用版本化 `KeyProvider`: 优先 OS keychain, 受支持环境可退回 key_root 中的独立 `0600` key file。
每个 blob 使用独立 data key 并由 master key envelope; key 不可用时只保存 content-free capture error,
不能落明文。key rotation 只重包 data key; 显式删除同时销毁 blob 和 envelope。doctor 必须验证实际加解密 canary,
不能只检查 key 文件存在。

个人全局 lesson 只有满足「至少两个独立 lineage 的同类用户反馈 + 不同 incident family +
medium/high confidence + 新的单独复审事件」后才进入 global projection。

### 4.5 Compiler: lesson 归并与行动卡编译

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
- project lesson 与 global lesson 同时匹配时, project 级明确 exception/override 优先, 但必须记录覆盖原因。
- 同一 scope 的低严重度规则互相矛盾时标记 `conflict`, 不进入自动上下文, 等待后台复审。
- 冲突涉及 Blocker/Critical 或 `safety-irreversible` 时不得 fail-open: compiler 生成最小 `safety_hold`
  contract, 在冲突解决前阻止受影响的确定性工具动作; 不能硬阻止的宿主必须显示 `checkpoint_hold`。
- 被新规则替代的 lesson 标记 `superseded`, 不参与加载。

每个活动 lesson 同时保存完整分析指针和一张紧凑行动卡。行动卡必须包含:

```text
when:       什么情况下适用
must_do:    agent 必须执行的动作、顺序和前置检查
must_not:   已证明会造成偏移的禁止行为
verify:     完成前必须取得的可观察证据
why:        一句说明该契约防止的系统性根因
exception:  不适用的边界或反例
source_ids: opaque incident/report ids, 不包含本地路径或正文
verify_predicate: 可选的受控证据谓词, 由可信 runtime verifier 执行
gate_predicate: 可选的受控工具/参数谓词; 只有校验通过后才能用于 hard gate
```

卡片校验器要求七个字段都非空。`must_not` 不能脱离 `must_do`、`verify` 和 `exception`
单独存在, 避免把一次具体错误编译成无限扩张的禁令。超预算时只能整卡选择、整卡跳过或重新编译,
绝不对字符串做尾部截断。

### 4.6 Consumer: 每回合本地选择、每 revision/上下文代次单次注入

现有 `core-hook.sh` 保持负责队列和到期评审。新增一个 Node selector 负责结构化数据:

```text
templates/runtime/lesson-selector.mjs
```

shell 不解析 lesson JSON, 只把 hook payload、project identity 和 store 路径交给 selector。
selector 返回:

- 要注入的完整行动卡列表;
- 选择/跳过原因;
- 预算使用量;
- `application_id` 和 delivery state 更新。

每次应用使用以下稳定标识:

```text
application_id = hash(session_uid, context_epoch, task_fingerprint, lesson_id, revision)
delivery_state = selected | emitted | observed | emitted_unconfirmed
```

- `selected`: selector 已选择, 尚未输出给宿主;
- `emitted`: hook 已把 additionalContext 成功写给宿主;
- `observed`: 后续可读取 transcript 明确包含 injection nonce;
- `emitted_unconfirmed`: 宿主没有提供可回读确认能力。

只有 `observed` 能证明模型上下文真正收到 lesson。`emitted_unconfirmed` 不能在复发审计中直接归责为
`loaded_not_applied`。receipt 绑定 `context_epoch`; SessionStart/resume/clear、可观测的上下文压缩或宿主
明确丢弃历史时进入新 epoch, 允许严重 lesson 重新注入。同一 lesson revision 在同一 epoch/task 只注入一次。
活动 projection 因无关 lesson 变化时不会重注入旧卡; lesson 升级后只注入新 revision。

selector 可以在每个用户回合本地运行, 以覆盖同一会话中途切换任务的情况。它不调用模型;
没有命中时不注入任何文字, 已有 receipt 时也不重复注入, 因此本地选择频率不等于 token 消耗。

批量评审到期时 hook 向 ReviewerRunner 提交 job, 不再把完整评审指令注入主会话。
`additionalContext` 只包含本回合行动卡或 safety hold。Stop/AfterAgent 可以记录 delivery/verification
状态, 但不能要求主会话代跑反思; reviewer job 的超时、重试和完成由独立 lease 状态机处理。

### 4.7 Effectiveness auditor: 复发时审计控制链

后台 reviewer 对同类首次反馈只分析「本次任务为什么做错」。对同类复发必须再分析一条独立的
「学习控制链为什么失效」, 不能把两条因果链合并成一句「规则没有吃进」:

1. 找到匹配的旧规则、lesson id 和当时应生效的 revision;
2. 读取当前 CLI/session 的 application/delivery receipt, 区分 selected、emitted、observed 和 unconfirmed;
3. 对照用户请求、行动卡 `when` 和 agent 行为, 判断是否适用、是否执行;
4. 归类唯一的主失败模式, 并写出可验证的纠正动作;
5. 追加 effectiveness event, 更新 lesson revision/active projection 后才允许给出完成 receipt。

失败模式和默认动作如下:

| failure_mode | 证据 | 必须动作 |
| --- | --- | --- |
| `not_materialized` | Markdown 规则存在, 但没有对应 active lesson | 编译并激活原规则, 不复制近义规则 |
| `not_selected` | active lesson 存在, 没有 application 或只停在 selected 前 | 修正 scope/signals/load_policy, 复发严重度至少提升一级 |
| `delivery_unconfirmed` | hook 只证明 emitted, 不能证明模型 observed | 修复 adapter/epoch/回读能力, 不归责 agent_execution |
| `loaded_not_applied` | receipt 证明 observed, 但 agent 没执行行动卡 | 严重度至少提升一级, 把 `must_do/verify` 改成带前置检查和验收证据的强动作 |
| `contract_incomplete` | 已加载且部分执行, 但行动卡无法覆盖该场景 | 修订 when/must_do/must_not/verify/exception, 生成新 revision |
| `external_limit` | 控制链已执行, 失败来自可证明的宿主限制 | 保留证据和 fallback, 不把限制伪装成 agent 已学会 |
| `unknown` | receipt/上下文不足, 无法证明在哪一层失效 | 标记 `review_due`, 保留队列证据, 不允许静默归档为已处理 |

这项审计只在识别到真实复发反馈时运行, 不在普通会话增加 LLM 调用。application/delivery receipt 和
active projection 查询是本地结构化读取, 不消耗模型 token。

后台 reviewer 完成后由 ReviewerRunner 提交 `review_receipt`; 主会话隐藏标记不再是完成依据。
receipt 必须在同一数据库事务内达到 `acknowledged`, 且 report content id、lesson event、active projection
revision 和已消费 queue event 都存在。这样「写了报告并清队列, 但学习状态没有变化」不能伪装成反思成功。

## 5. Lesson 数据模型

```json
{
  "id": "afl-lesson-...",
  "revision": 3,
  "base_revision": 2,
  "lifecycle": "active",
  "enablement": "enabled",
  "conflict_state": "none",
  "deletion_state": "none",
  "load_policy": "always",
  "severity": "Critical",
  "responsibility": "agent_fault",
  "confidence": "high",
  "scope": {
    "level": "project",
    "project_id": "afl-project-...",
    "repository_lineage_id": "afl-lineage-...",
    "paths": ["templates/hooks/**"],
    "tools": ["git", "computer-use"],
    "task_types": ["runtime-verification"],
    "signals": ["端到端验证", "live verification"]
  },
  "method_class": "learning-retrieval",
  "class_id": "producer-without-consumer",
  "card": {
    "when": "...",
    "must_do": "...",
    "must_not": "...",
    "verify": "...",
    "why": "...",
    "exception": "...",
    "source_ids": ["afl-incident-...", "afl-report-..."],
    "verify_predicate": {"type": "artifact_hash", "subject": "..."},
    "gate_predicate": null
  },
  "recurrence_count": 2,
  "effectiveness": {
    "previous_lesson_id": "afl-lesson-...",
    "expected_revision": 2,
    "application_id": "afl-application-...",
    "delivery_state": "emitted_unconfirmed",
    "was_applicable": true,
    "was_followed": false,
    "failure_mode": "delivery_unconfirmed",
    "control_owner": "delivery_adapter",
    "corrective_action": "add observable delivery confirmation for this CLI"
  },
  "evidence_refs": [{
    "feedback_event_id": "afl-event-...",
    "feedback_quote": "用户脱敏事件中的逐字原话",
    "referent_event_ids": ["afl-event-..."]
  }],
  "created_at": "...",
  "last_seen_at": "...",
  "review_after": "...",
  "token_counts": {
    "local_conservative": 0,
    "provider_opt_in": null,
    "selection_cost": 0
  }
}
```

`incident_fingerprint` 由 store 根据已验证的 feedback/referent event ids 与项目身份确定性生成，
不接受 reviewer 自报；`feedback_quote` 必须是对应脱敏用户事件的原文子串。

`signals` 由 reviewer 针对具体 lesson 生成, 可同时包含中英文别名。它不是全局写死的
「不满词表」, 只用于判断某项方法教训是否与当前任务有关。

新 lesson 默认 `scope.level=project`。只有相同 `method_class + class_id` 在至少两个不同
`repository_lineage_id` 和两个不同 incident family 中分别由用户明确反馈证明时, reviewer 才能提出
`global_promotion_candidate`。个人全局 lesson 必须由新的 review event 单独复审并保留两个 incident
证据指针; 不能因一句规则看起来通用就直接提升。源 incident 被禁用、删除或判无效时必须重新计算
promotion aggregate, 证据不足则自动降回项目 lesson。项目 lesson 的明确 exception/override 优先于 global。

project override 是持久关系而不是选择器临时推断:

```text
project_id / global_lesson_id / global_revision / action(suppress|replace|narrow)
reason / review_event_id / lifecycle(candidate|active|review_due)
```

global revision 变化后旧 override 自动进入 review_due; 未复审前保留更保守的安全约束, 不能静默失效或
继续覆盖语义已经变化的 global lesson。

`effectiveness` 只在复发事件上必填。`control_owner` 使用
`capture_adapter | reviewer_runner | reviewer | store | compiler | selector | delivery_adapter |
agent_execution | lesson_contract | external | unknown`,
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

报告完成度按字段和证据校验, 不是按篇幅校验。完整报告加密保存在 data_root; 普通会话仍只加载行动卡,
因此加深 Critical/Blocker 反思不会让每个后续会话携带整份 5 Why。

加载策略:

| 严重度 | 默认加载与约束 | 生命周期 |
| --- | --- | --- |
| Blocker | 在适用 scope 内每个 context epoch 加载; 只有已验证 `gate_predicate` 才能在工具 hook 阻止危险操作 | 只有明确验证闭环后才能降级 |
| Critical | 每个相关 task application 加载; 完成前必须写入绑定该 application 的 `verify` 证据 receipt | 到 `review_after` 后由后台复审是否降为条件加载 |
| Major | scope/路径/工具/任务类型相关时加载一次 | 复发升级; 长期无复发可归档 |
| Minor | 不加载, 只累计趋势 | 同类累计达到阈值后升级 |

`gate_predicate` 是受控 DSL, 只能匹配规范化 tool name、参数路径/host/environment 和已经存在的
verification receipt。自然语言 `when` 不能直接编译为硬 gate。没有确定性 predicate 或平台不支持工具级
拦截时, Blocker 只能使用模型可见契约与 checkpoint; doctor 和日志必须标记
`enforcement=prompt_only|checkpoint_only`, 不得宣称已经硬阻止危险操作。

Critical/Blocker 的 `verification_receipt` 必须绑定 `application_id + lesson_id + revision + evidence_hash`,
旧任务或旧 epoch 的 receipt 不能冒充当前任务验收。

agent 自报文本、任意文件路径或未经验证的 hash 不能签发 receipt。可信 runtime `Verifier` 只执行受控
`verify_predicate` DSL, 例如 artifact hash、已登记测试结果、规范化 tool result、live canary 或显式 human ack;
它把规范化 evidence refs、issuer/version 和 predicate revision 一起在事务中签发 receipt。gate 只接受
Verifier 为当前 application 签发且未撤销的 receipt。无法确定性验证时状态只能是 `manual_unconfirmed`,
不得伪装成 verified 或用于 hard gate 放行。

`human ack` 只能来自宿主标记为 user role 的新事件并引用当前 application challenge nonce; agent 输出、
工具日志中的同样文字或历史会话片段都不能作为人工确认。

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

### 8.2 计数发生在卡片创建/校准时, 默认只在本地

第一版默认使用经过中英文语料校准的保守本地估算器, 计入注入 wrapper、行动卡正文和宿主固定前缀。
不得为了计数把 lesson/card 发送到 Claude/Gemini/OpenAI 远程 token API。provider 精确计数只能作为用户
显式 opt-in 的离线校准任务, UI/CLI 必须先说明会上传待计数文本。

本地可用 tokenizer 可以提高精度, 但 selector 始终使用已存储的最坏值:

```text
selection_cost = max(local_provider_tokenizers, local_conservative)
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
3. 下一张完整 Major 卡放不下时整张跳过, 禁止截断字段; Critical/Blocker 不允许静默跳过。
4. 同 class_id 的 lesson 必须先合并; always-loaded 严重 lesson 还必须按
   `method_class + scope` 编译成至多一张方法卡。
5. active projection 对每个 `method_class + scope` 只允许一张有上限的 severe card。新卡无法在字段完整的
   前提下收敛到单卡上限时保持 `review_due`, 由后台 reviewer 合并, 不能把超大正文交给 selector。
6. 发布校准同时产生 `absolute_budget`; selector 永远不得超过该上限。
7. 发布包固定 `max_candidates`、`max_active_severe_per_scope`、`single_card_hard_limit` 和
   `absolute_budget`; 顶层分类有界不代表卡片数量自然有界, 必须由 schema validator 强制这些上限。
8. 现有 severe cards 合计仍超出 absolute budget 时进入 `memory_overflow_hold`: 注入一张固定大小的
   hold contract, 对可确定匹配的高风险工具动作 fail-closed, 并提交后台合并 job。prompt-only 宿主只能
   声明 checkpoint hold, 不得声称所有 severe lesson 已加载。
9. selector 不自动读取完整 card/report/session 来补预算。任何证据深读都走独立 reviewer 的受限 renderer,
   并计入单次片段和一次 job 的累计 token 硬上限。

### 8.5 Reviewer 自身的 Token 控制

正常回合只本地入库和选择, 不启动 reviewer。队列达到条数/时间阈值后才创建批量 job, 且分两阶段:

1. classification 只接收待评审 user events、对应的 prior-agent referent windows 和结构化索引,
   不把 10 天完整 session 整包送入模型;
2. 只有通过回顾性反馈门的 incident 才进入深度 reflection, 再按严重度请求必要 evidence snippets。

预算分为 `per_call_limit`、`per_job_limit` 和持久化的 `per_incident_absolute_limit`, 每次调用都累计到
incident budget ledger。达到 call limit 时按完整 event/incident 边界分页并保存 continuation cursor;
达到 job limit 时可以由同一 lease 的后续调用继续, 但不能越过 incident absolute limit。

达到 incident absolute limit 仍未满足第 6.1 节完成字段时, 状态进入 `budget_blocked + review_due`,
保存 cursor、缺失字段和建议预算。相同 `budget_revision` 不得自动重试, 也不能输出简化结论、清队列或
签发 receipt; 只有用户/策略显式提高预算或 reviewer 通过无损证据归并降低需求后才能恢复。
Token 上限控制调用成本, 不把不完整反思伪装成完成。

## 9. 注入格式与按需深读

正常会话只接收如下紧凑上下文:

```text
[Agent Feedback Lessons - apply before acting]
- <id> [Critical]
  When: ...
  Must do: ...
  Must not: ...
  Verify: ...
  Why: ...
  Exception: ...
```

行动卡必须包含正常任务做出正确决策所需的完整契约。主任务 agent 不自动读取 source, source 也不作为
可执行指令进入 prompt。只有独立 reviewer 在以下情况通过 evidence renderer 读取受限证据:

- 当前任务确实命中 lesson, 但行动边界仍不清楚;
- lesson 之间出现冲突;
- 准备修改/降级/合并 lesson;
- 同类问题再次复发, 需要检查旧方法为什么没有生效。

evidence renderer 只接受 opaque source id, 返回经过脱敏、明确标注为「不可信历史证据」的有限片段,
禁止工具调用、路径跳转和自动跟随片段中的指令。单片段和单次 review job 都有 token 硬上限。
用户执行 `memory show` 默认也看到脱敏视图; 只有显式 `--raw` 才在本机解密原文。

这样深度反思不会丢失, 但完整 5 Why 和历史 prompt injection 不会永久进入后续主会话。
完整 session 存储成本与上下文 token 成本严格分离: session/incident 可以很大, selector 仍只计算
实际注入行动卡的 token。

## 10. 生命周期

Lesson 使用四个正交维度, 不能把加载策略、用户开关和生命周期混成一个 `status`:

```text
lifecycle:      candidate -> active -> review_due -> active / archived / superseded
enablement:     enabled | disabled
conflict_state: none | conflict | safety_hold
load_policy:    always | conditional | trend_only
deletion_state: none -> delete_pending -> deleted (terminal)
```

- `candidate`: 新产出, 尚未通过证据/完整性校验;
- `active`: 按严重度策略加载;
- `review_due`: 到期后由现有延迟后台 reviewer 一并复审;
- `archived`: 保留历史但不进入上下文;
- `superseded`: 已被更高层 lesson 替代。
- `disabled`: 用户手动停用, 保留证据和历史但不加载; 只有显式 enable 才能恢复;
- `conflict`: 低风险冲突等待复审;
- `safety_hold`: 严重/安全冲突时的保守约束, 在复审完成前不能静默取消保护。
- `delete_pending/deleted`: 一进入 delete_pending 就从所有 projection 排除; deleted 是 tombstone 终态,
  不能 enable、rebuild 或重新导入同一 content id。

Minor 同 class_id 在复审窗口内累计三次时提升为 Major。已有 active lesson 再复发时至少升级一级,
并要求反思「为什么已有教训没有被加载或没有被执行」, 不能只追加同义规则。

对真实复发反馈, 以下四项在同一事务全部持久化后才算处理成功:

1. 完整反思报告;
2. recurrence + effectiveness event;
3. 与 failure_mode 对应的 lesson revision/状态维度/active projection 变更;
4. 指向上述 event 的 review receipt。

后台 reviewer 可以在事务成功后把已消费 queue event 标为 acknowledged。只写报告、只清空队列、
或仅返回 `rule_action: none` 都不能生成成功 receipt。queue event 使用
`pending -> claimed -> reflected -> compiled -> acknowledged`, claim 受 runner lease 保护;
失败重试按 event id 幂等, 不通过清空整个文件表示成功。

Session 与 Incident 生命周期:

```text
captured -> review_pending -> reviewed_no_lesson / linked
         -> deletion_pending -> deleted
```

- 普通完整 session 从最后更新时间起 10 天后删除;
- 真实反馈 incident 在评审关闭但没有生成 lesson 时, 从 `reviewed_no_lesson_at` 起保留 30 天;
- linked incident 保留到所有直接 lesson、global promotion aggregate 和 effectiveness audit 不再活动后 30 天;
- lesson 重新激活或 promotion 资格重算时, 在同一事务取消尚未执行的 deletion mark;
- GC 使用引用图和两阶段 `mark -> transaction 内重新检查 -> delete`; 不能先删 blob 再发现 lesson 复活;
- session 原文过期不影响结构化 lesson, 但 source metadata 必须显示 `raw_expired_at`。

显式删除使用 deletion closure, 覆盖 lesson revision/card、active projection、incident/report 正文、
application/verification receipt 中的正文引用、导出缓存和加密 blob。删除是幂等两阶段事务:

1. 事务写 `delete_pending`, 冻结 closure/refcount 并立即从 projection 排除;
2. unlink blob/envelope/cache, fsync 目录, 再在事务中重新检查引用并写 content-free `deleted` tombstone。

任一步崩溃后 GC 从 delete_pending 继续, 不重新加载内容。unlink 失败保持不可加载的 delete_pending 并报警;
不会先写 deleted 再遗留可读取正文。event history 只保留不含正文的 id/hash/time/reason tombstone;
rebuild 必须先应用 tombstone, 不能从旧 event 复活内容。
删除一个 global lesson 的源 incident 时必须重新计算 promotion 资格。插件不能删除宿主 CLI transcript
或系统备份, 命令执行前后都要明确这个边界。

## 11. 插件安装与升级

`agent-feedback-loop install` 继续完成 prompt pack 和三 CLI hook 接线, 并新增:

- 三 CLI session capture adapter 和归一化 schema;
- 独立 data_root、加密 key provider、SQLite store 和 GC 配置;
- versioned ReviewerRunner/adapter capability manifest;
- runtime selector 文件;
- lesson store/schema 版本;
- `doctor` 的 runner/selector/lesson/budget/transaction 检查;
- 已有 `.agent/rules/feedback-loop.md` 的一次性迁移提示。

runtime 按版本安装, stable launcher 读取原子更新的 `current.json`; 不依赖 Windows 可能无权限创建的目录
symlink。`current.json` 只在文件完整和自检通过后切换。store 声明
`min_reader_version/max_reader_version/min_writer_version`; 不兼容 writer 必须拒绝启动, 不能让新旧进程
同时写不同 schema。migration 获取全局 lease, 先做校验备份, 在事务中升级, 失败回滚 runtime 指针和 store。

旧 Markdown 严重规则不能等到「下一次反馈」才生效。迁移期间它们作为只读 legacy overlay 继续加载,
reviewer 只对有证据的规则生成结构化行动卡; 完成后按 fingerprint 停用对应 overlay, 避免重复注入。
无证据、重复或过窄规则不自动提升为长期 lesson。

旧 `.agent/reflections/` 和规则只通过显式 `memory import-legacy --project <path>` 导入 data_root。
导入先脱敏、hash、去重并显示计划, 不删除或修改项目原文件; 未通过 referent 证据门的旧报告只能作为
审计材料, 不能直接变成 active lesson。

`uninstall` 默认只拆 hook; `uninstall --remove-files` 也只能删除 runtime_root, 不触碰 data_root/key_root。
普通重装可以读取 capability/schema 元数据但不能删除用户数据。升级只有在获得 migration lease、完成备份并
通过 reader/writer compatibility 检查后才能事务性迁移 data_root; 它不得执行 purge 或删除正文。
旧版 runtime 没有 data/key root 删除权限。长期数据只能由单独的 `memory purge` 删除, 该命令必须展示清单、
要求明确确认、事务执行并报告不可控的宿主/系统备份边界。project purge 不删除共享 master key;
`purge --all` 只有在所有 blob 删除并 fsync 后才删除 fallback key/envelopes。

用户可检查和撤销长期记忆:

```text
agent-feedback-loop memory list [--project <path>] [--lifecycle active] [--enablement enabled]
agent-feedback-loop memory show <lesson-id> [--raw]
agent-feedback-loop memory explain <session-or-application-id>
agent-feedback-loop memory disable <lesson-id>
agent-feedback-loop memory enable <lesson-id>
agent-feedback-loop memory archive <lesson-id>
agent-feedback-loop memory delete <lesson-id>
agent-feedback-loop memory rebuild [--project <path>]
agent-feedback-loop memory import-legacy --project <path>
agent-feedback-loop memory purge --project <path> | --all
agent-feedback-loop capture status [--project <path>]
agent-feedback-loop capture off|on --session <id> | --project <path>
agent-feedback-loop capture exclude <path-or-pattern>
agent-feedback-loop gc status|run
agent-feedback-loop doctor [--live]
```

`disable/enable/archive/delete` 必须写事件而不是无痕覆盖。`delete` 是显式用户删除权, 按 deletion closure
立即删除插件管理的可加载内容和原文; 不能用默认审计保留期对抗用户主动删除。
`capture off` 不删除既有数据, `memory purge` 才执行删除。敏感项目可以默认 exclude, doctor 必须显示
当前捕获策略和最近一次实际捕获结果。

## 12. 可观测性

`AGENT_FEEDBACK_LOOP_DEBUG=1` 时新增单行日志:

```text
agent-feedback-loop: decision=lesson-context session=... project=...
application=... selected=L1,L4 emitted=L1 observed=L1 unconfirmed=L4
estimated_tokens=N soft_budget=S reserve_budget=R absolute_budget=A projection_revision=V
capture=complete hot_sessions=H incidents=I gc_deleted=G enforcement=checkpoint runner=supported
```

日志不得包含用户 prompt、卡片正文、证据原文或凭据。doctor 输出:

- active lesson 数量及严重度分布;
- 本地选择器是否可执行;
- token estimator/calibration 版本;
- 当前默认 soft/reserve/absolute 预算;
- 冲突、超大卡片、过期未复审数量;
- session capture 完整度、最旧热 session、待删除 incident 和磁盘占用;
- 当前 CLI 对 prompt/checkpoint/tool-gate 三种约束能力的实际支持级别;
- 三 CLI 二进制、版本、hook/backstop、ReviewerRunner 和 capture capability 的真实连接状态;
- store schema/reader/writer compatibility、WAL/backup/lease 健康度;
- selected/emitted/observed 比例、未确认 delivery、过期 runner job 和 safety hold。

普通 doctor 做静态检查并使用 `configured | configured_unverified | unavailable | unhealthy`。只有显式
`doctor --live` 才创建隔离的 synthetic session 执行 capture/injection/runner canary, 避免每次诊断额外调用模型。
目标 CLI 二进制缺失、版本未验证、runner 不可用或最近 live canary 未 observed 时不得报告该能力 healthy。
`memory explain <session-or-application-id>` 返回机器可读的选择/跳过原因、delivery state、context epoch、
预算、gate/verify 结果和是否读取过 evidence renderer; 日志 schema 必须版本化。

live canary 使用独立临时 data root/store 和 `data_class=synthetic_canary`, 完成后立即清理。即使清理失败,
synthetic 数据也必须被 schema gate 排除于用户 queue、incident、lesson、promotion、A/B 统计和正常保留策略。

## 13. 错误处理

- store 不存在: 初始化事务库; 初始化失败时普通 prompt/capture fail-open, 但高风险 tool gate 按
  `memory_safety_unknown` fail-closed, 其他宿主进入 checkpoint hold。
- store/WAL 损坏: 切换经过校验的只读备份, 禁止写入和清队列, 记录 repair required; 若 store、备份和
  safety projection 都无法证明不存在 hold, 使用同一 safety-unknown 策略, 不能通用 fail-open。
- session 捕获不完整: 标记 partial, 不以该 session 单独生成长期 lesson; 反馈事件保留等待补齐或人工审计。
- session/incident 写入失败: 不清反馈队列, 不签发 review receipt; 当前任务继续 fail-open。
- 加密/脱敏失败或权限无法收敛: 拒绝保存原文, 只记 content-free 错误元数据。
- reviewer runner 不可用/超时: job 保持 pending 或 retryable, lease 到期后重领; 不回退主会话。
- 并发 lesson 更新: SQLite transaction + base_revision CAS; revision 分叉进入 conflict/safety_hold。
- native session_id 缺失: 使用 namespaced 临时 session_uid 并标记 identity_partial; 该证据不能跨项目晋升。
- token counter 不可用: 使用保守估算值, 不发起会话内 API 调用。
- 严重卡超 reserve: 先合并; 仍超 absolute 时进入 memory_overflow_hold, 不截断、不宣称已经加载全部教训。
- 卡片缺字段: 保持 candidate, 不进入 active projection。
- 低风险 lesson 冲突: 标记 conflict 并排除; Blocker/Critical/safety 冲突必须进入 safety_hold。

## 14. 验证策略

### 14.1 自动化测试

1. severity 硬升级和普通矩阵测试。
2. Blocker/Critical/Major/Minor 选择顺序测试。
3. 同 application/revision/context_epoch 只注入一次, revision 或 epoch 变化只注入必要增量。
4. project/path/tool/task_type/signal 相关性测试, 含中英文卡片。
5. 整卡选择测试: 预算边界不得产生截断文本。
6. 无关 projection revision 更新不得让已注入 lesson 重复进入同一 context epoch。
7. 严重卡超过 reserve/absolute 时分别触发合并和 memory_overflow_hold, 不产生无界 index。
8. 同 class_id 归并、复发升级、superseded/archived 排除测试。
9. 复发 effectiveness audit 包含 delivery_unconfirmed 的状态迁移测试。
10. 「旧 Markdown 规则存在但没有 application/delivery receipt」必须归类 `not_materialized`, 不得
    `rule_action: none` 后只写报告。
11. repeated-pattern evidence + Major 的事件必须被 schema validator 拒绝。
12. 报告已写但 event/active projection 未完成时不得清队列或签发成功 receipt。
13. store/WAL 损坏、缺 native session_id、counter 不可用的诚实降级测试。
14. queue review 到期时提交 ReviewerRunner job, 主会话不得收到完整反思 instruction。
15. debug 日志包含选择理由和预算, 但不包含 prompt/card 正文。
16. install/uninstall/doctor 对 Codex、Claude、Gemini 配置的回归测试。
17. 三种 CLI manifest 的命令协议、detach/start ack、timeout 单位/值、null transcript、completion 判据和 live canary 测试。
18. 普通 session 10 天 GC、feedback incident 按 lesson 归档后 30 天 GC、重新激活取消删除测试。
19. umask/目录/文件权限、拒绝 symlink、加密 blob、redacted index 和二进制只存引用/hash 测试。
20. 只有带 quote span、referent event/hash 和时间顺序的事件能生成 lesson; 重复要求无 referent 只能保持候选。
21. versioned incident/family fingerprint 去重和 merge/split event, 同一事故重复导入不能制造独立证据。
22. persistent installation_id、namespaced event_uid/session_uid、同 session 多 cwd、identity alias/merge 和未知 lineage 测试。
23. 两个独立 lineage + incident family 才能提出全局提升; 源证据删除后自动降级测试。
24. selected/emitted/observed/unconfirmed 和 context_epoch 压缩/clear/resume 测试。
25. ReviewerRunner owner/attempt/monotonic lease_epoch fencing、旧 worker 拒绝提交、崩溃重领和 unavailable 测试。
26. SQLite 并发写、WAL 重启、base_revision CAS、事务回滚和 blob 发布崩溃窗口测试。
27. lifecycle/enablement/conflict/load_policy 正交状态与 no_lesson incident 30 天 GC 测试。
28. delete_pending 两阶段崩溃恢复、deletion closure、content-free tombstone、rebuild 不复活和资格重算测试。
29. revision-bound project override、低风险 conflict、severe safety_hold 和 store/safety projection 不可读时 fail-closed 测试。
30. trusted Verifier issuer、受控 verify/gate predicate、伪造 receipt 拒绝和 prompt/checkpoint 能力降级测试。
31. runtime/data/key 三根隔离; uninstall/reinstall 保留 data/key, migration lease 可升级但不可 purge 测试。
32. schema reader/writer 范围、migration lease、备份回滚和 legacy overlay 去重测试。
33. capture off/on/exclude、memory explain、gc status 和日志 schema 版本测试。
34. doctor 在 CLI 缺失、版本未验证或 runner unavailable 时不得报告 healthy; 只有 `doctor --live` 可刷新 canary verified 状态。
35. reviewer 默认无 shell/network/MCP/write 权限, 历史 prompt injection 不能触发工具或绕过 evidence broker。
36. classification/reflection 两阶段分页、incident budget ledger、budget_blocked 和同 budget revision 不重试测试。
37. benchmark manifest 运行前冻结、paired trial 完整性、置信区间和阈值自动判定测试。
38. capture policy revision 双检查、在途写拒绝、synthetic canary 隔离和 TTL 清理测试。

### 14.2 Token 校准测试

1. 从现有反思/规则和新增 fixtures 生成至少 30 张中英文完整行动卡。
2. 用本地 tokenizer 和保守估算器计数; 保存语料、版本和日期, 不调用远程 token API。
3. 使用本地结果最大值计算每卡 `selection_cost`, 并计入 injection wrapper。
4. 验证发布默认预算覆盖 P95 + 20% 余量。
5. 验证正常无相关 lesson 为 0 tokens, 单 Major、两 Major、四严重卡和 hold contract 的实际成本。
6. 验证 max_candidates、单卡硬上限、absolute budget、单 evidence snippet 和单 review job 深读上限。

### 14.3 真机端到端验收

在真实 Codex、Claude Code、Gemini CLI 新会话中分别验证:

1. 完整 user/assistant 文本、工具输出和文件引用进入 10 天加密热存储, 原始正文和 lesson 不进入 Git。
2. 真实反馈后完整 session 被复制到 incident, 关键 turn 索引没有裁掉原会话。
3. 到期反馈由独立 runner 完成; 主会话不出现完整反思, runner unavailable 时队列保持 pending。
4. Blocker 在适用 scope/context epoch 内恰好进入一次, 只有确定性 predicate 才能证明 hard gate。
5. Critical 在相关 task application 进入一次, 完成前能验证绑定 application 的 receipt。
6. 无关 Major 不进入; 命中相同 path/tool/task_type 的 Major 进入; Minor 不进入。
7. 主任务不能自动深读 source; reviewer renderer 和 `memory show` 只能按权限返回受限证据。
8. 模型在复现场景中主动执行 must_do、避开 must_not 并取得 verify 证据, 而不只是复述规则。
9. 新会话没有额外 token-count/semantic-retrieval LLM 请求, provider 计数默认没有网络流量。
10. queue、runner lease、capture、delivery observation、GC 和 transaction recovery 均正常工作。
11. 使用 Computer Use 检查真实 CLI 可见行为, 并把机制层、宿主能力层与端到端收益分开报告。
12. 对同一固定场景执行 lesson disabled/enabled 多次 A/B replay, 记录行为成功率、误学习率、漏载率、
    实际 token、hook p95/p99、runner 延迟和 GC 延迟, 不能用一次模型偶然遵从证明收益。
13. 复现「既有规则存在但本轮未注入」场景, 后台报告必须产出 `not_materialized` 或
    `not_selected` audit、升级原 lesson, 下一新会话能看到修订后的行动卡。
14. 复现 emitted 但未 observed 场景, 必须归类 `delivery_unconfirmed`, 不能误判 agent 未执行。
15. 复现「行动卡已 observed 但 agent 仍偏离」场景, 必须产出 `loaded_not_applied`, 不能用
    「已有同类规则所以不新增」结束评审。
16. 同类用户反馈在第二个独立 lineage/incident family 复发后形成 global candidate, 经复审后才进入全局 projection。
17. CLI 不支持工具 gate 时, 真机结果必须显示 prompt/checkpoint 边界, 不得声称硬拦截已生效。
18. 真机 uninstall/upgrade/reinstall 后 data_root 和 active lessons 保持不变; 显式 purge 后插件管理内容消失。
19. capture off/exclude 在敏感会话即时生效, doctor/capture status 能证明没有新增正文。
20. `doctor --live` 在隔离 synthetic session 验证 capture、observed injection 和独立 runner, 普通 doctor 不产生模型调用。

### 14.4 可判定的收益发布门

每次 release candidate 在测试前冻结 versioned benchmark manifest, 至少包含:

```text
scenario_id/version / positive_and_negative_controls / lesson_id/revision
cli/model/version / system_prompt_hash / temperature / seed_if_supported
minimum_paired_runs / success_rubric / required_success_delta
max_false_load / max_mislearning / max_token_overhead
hook_latency_baseline / max_p95_ratio / max_p99_ratio
```

每个场景的 enabled/disabled paired runs 不得少于 20 次; 平台不支持 seed 时必须记录全部原始试次。
只有成功率增量的 95% 置信区间下界达到预先声明的 `required_success_delta`, negative controls 的误加载/
误学习上界未超阈值, Token 和 p95/p99 延迟也通过时, 才能判定「有可重复收益」。阈值和评分规则必须在
运行前提交, 不能看完结果再改; 失败试次不得删除。机制 canary 通过只证明注入链路, 不能替代此收益门。

## 15. 成功标准

实现完成必须同时满足:

- 用户在同项目新会话中能观察到模型主动规避已知严重问题;
- 无相关 lesson 的普通会话没有新增上下文;
- 偶发 Minor 不会永久占用上下文;
- 严重 lesson 不会因预算被截断或静默丢失;
- 所有注入都可解释「为什么选中/为什么跳过/消耗多少」;
- 反思完整报告、行动卡、加载 receipt、effectiveness audit 和复发事件形成可追踪闭环;
- 同类复发不会以「规则已存在」为由只生成报告; 每次复发都能看到控制链失败分类和状态变更;
- 普通完整会话按 10 天窗口保存, 真实反馈会话在 lesson 生命周期内可完整回读;
- 只有用户确认的回顾性反馈能生成长期行为记忆, Agent 自检和普通约束不会污染 lesson store;
- 项目 lesson 不泄漏到其他项目, 两个独立 lineage/incident family 的复发证据经过复审后才能提升为个人全局 lesson;
- 用户能列出、查看、禁用、归档、删除和重建记忆, 所有状态变化可追溯;
- 独立 reviewer unavailable 时不会占用主会话, 不会清队列, 也不会伪装成功;
- 卸载、升级、重装不会删除 data_root, 显式 delete/purge 不会被 rebuild 复活;
- A/B replay 显示 lesson enabled 时行为成功率有可重复提升, 而不是只证明报告或卡片存在;
- 三个平台至少各完成一次真实能力矩阵和多次场景验收, 不能只凭 doctor/单测宣称生效。

## 16. 未来方案 C: 向量召回扩展

第一版只保留内部 `candidate_retriever` 边界, 不承诺尚未验证的公共稳定 API。默认实现先按
project/global scope 生成已授权 lesson id 集合, 再使用 severity、task_type、path、tool 和 signals
做结构化本地匹配。只有 lesson 数量达到数百级且真实漏召回数据证明结构化选择不足时,
才增加 embeddings/vector backend。

未来接口至少包含:

```text
retrieve({ authorized_lesson_ids, projection_revision, query_features, max_candidates })
  -> [{ lesson_id, projection_revision, score, reason, backend }]
```

向量 backend 只能看到预授权候选集合或物理分 scope 的索引, 不能先跨项目检索再由 selector 过滤。
默认只索引结构化行动卡, 不把完整 session/report 原文发送给 embedding provider。删除、禁用、supersede
和 scope 变更必须传播到索引 revision。

向量检索只能返回候选 lesson id 和相似度, 后续仍必须通过:

1. project/global scope;
2. severity/load_policy;
3. when/exception 适用性;
4. lifecycle/enablement/conflict_state 状态门;
5. application/context epoch receipt 去重;
6. token budget 和完整行动卡校验。

因此方案 C 可以替换候选召回器, 不能绕过方案 B 的证据门、状态机和执行约束。embedding 失败时
自动退回结构化 selector, 不影响已有长期行为记忆。

## 17. 实施边界

第一版只实现本设计所需的最小闭环:

1. 三 CLI capability adapter、统一身份 schema、10 天加密热存储和无 daemon GC;
2. 独立 ReviewerRunner、job lease、失败重试和 unavailable 边界;
3. 真实反馈 incident 完整归档与 referent/fingerprint 证据门;
4. 独立 data_root、SQLite transaction store、加密 blob 和 deletion closure;
5. lesson schema/active projection、全局 promotion aggregate 和安全冲突 hold;
6. reviewer 产出完整行动卡、recurrence effectiveness audit 和事务 review receipt;
7. Node selector + application/delivery/verification receipt + context epoch;
8. 严重度/相关性/本地预算选择和 gate/checkpoint 能力声明;
9. versioned runtime、可回滚 migration、legacy overlay 和 uninstall/purge 边界;
10. memory/capture/gc/explain 命令、doctor、版本化日志、自动化测试和三 CLI 真机 A/B 验收。

不在第一版加入 embeddings、向量数据库、后台守护进程、Web UI、用户画像、项目事实记忆或
每会话 LLM router。
