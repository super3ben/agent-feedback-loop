---
comet_change: isolate-feedback-control-plane
role: technical-design
canonical_spec: openspec
---

# Agent Feedback Loop 即时 Subagent 反思与文档记忆技术设计

## 1. 设计定位

需求与验收场景以 `openspec/changes/isolate-feedback-control-plane/` 为唯一规格源。本文回答实现方式：同步边界、候选检测、detached reviewer、短期控制账本、Markdown 发布/读取、效果证据、迁移和真机验证。

本次重设计不是对 0.7.6 做兼容性热修复。它撤销当前分支中已经证明会把系统变重、但不能增加用户价值的方向：

- 模型回显 receipt 与 Stop 补发；
- Codex 原生消息、系统通知和 notification delivery 状态机；
- 等待 episode 收集/关闭后才调度 reviewer；
- 常驻 scheduler 与 memory maintenance worker；
- SQLite lesson/card 正文与数据库长期检索。

### 1.1 不可妥协的不变量

1. 主业务回答不依赖任何 AFL 状态，也不承担 AFL 控制文本的投递。
2. 第一个不同的明确反馈候选一旦落账，就立即尝试启动独立 reviewer subagent。
3. reviewer 完成与否不影响当前 prompt；刚产生的经验最早从发布后的下一次匹配 prompt 生效。
4. `.agent/reflections/*.md` 是长期经验唯一事实源，SQLite 只是可清理的控制账本。
5. 所有容量、解析、provider 和后台失败都 fail-open；不存在 `memory_overflow_hold`。
6. 只对 macOS 与 Linux 建立受支持、可验证的进程和安装契约。

## 2. 运行拓扑

```text
UserPromptSubmit
    │
    ├── bounded capture + synthetic filter
    ├── local feedback candidate detector
    │       └── new candidate transaction
    │               └── detached spawn + immediate return
    ├── direct scan of .agent/reflections/*.md
    ├── deterministic Top-K method selection
    └── host response: applicable method guidance or no-op

detached reviewer runner (short-lived)
    │
    ├── claim job with fenced lease
    ├── gather bounded referent/context + reflection metadata
    ├── invoke reviewer provider/subagent
    ├── validate structured result
    ├── no lesson ──► terminal row only
    └── lesson ─────► atomic Markdown publication
```

默认安装没有 AFL Stop hook。也没有 resident daemon、timer、launchd/systemd scheduler、app-server adapter 或 OS notifier。detached runner 是候选产生时启动的一次性子进程，不是后台服务。

## 3. 模块边界

现有代码先按职责审计，不能因为已经提交就保留。目标模块边界如下；最终文件名可在实施时微调，但职责不得重新混合。

### 3.1 Prompt orchestration

`src/cli.mjs` 或独立 orchestrator 只组合以下纯/有界能力：

- capture 当前 user event 和直接 assistant referent；
- 调用 `feedback-signal` 得到 `{candidate, reasonCodes, score}`；
- 在短事务中调用 reviewer job store；
- 事务提交后调用 detached launcher；
- 调用 document selector 并渲染 bounded context；
- 无论子步骤结果如何都返回宿主的 prompt-hook schema。

同步路径禁止：reviewer/provider 调用、等待 child、Stop reconciliation、native message append、系统通知、数据库 migration、文档 consolidation。

### 3.2 `feedback-signal`

纯函数输入是宿主结构字段、当前 user event、直接 referent 的最小 metadata，以及是否为 synthetic traffic。输出只说明“是否值得交给 reviewer”，不产生 lesson、severity 或责任结论。

### 3.3 Reviewer job store

复用现有 SQLite 基础时只保留 job、source observation、lease 和 publication/emission 指针。notification、episode、maintenance、长期 lesson/report/card 表不能成为新 runtime 依赖。

### 3.4 Detached launcher 与 runner

launcher 只负责一次 spawn attempt；runner 才拥有 job lease、provider invocation、validation 和 publication。两者通过 job id 关联，不通过 stdout 向主会话传递结果。

### 3.5 Reflection document

`reflection-document` 负责 canonical/legacy Markdown parse、结构校验、render、atomic publish 和 content hash。selector 与 reviewer 都通过这一层读取文档，不能各写一套解析规则。

### 3.6 Selector

selector 的输入是项目目录、当前任务的 bounded textual features、已发布文档与 emission history；输出是 `{guidance, selected, omissions}`。它不打开旧 lesson/card body 表。

## 4. Prompt 同步路径

### 4.1 顺序与事务边界

一次 prompt hook 的伪流程：

```text
event = capture(payload)
signal = detect(event, directReferent)

BEGIN IMMEDIATE
  source = insertSourceObservationIdempotently(event)
  job = signal.candidate ? insertJobIfAbsent(source.identity) : null
COMMIT

if job.wasCreated:
  attemptDetachedSpawn(job.id)       # no wait

attemptBoundedRecovery(limit = 1)    # pending/expired only; no timer

documents = readProjectReflections()
selection = selectDocuments(documents, event.taskContext)
response = renderHostContext(selection.guidance)
recordSelectedAndEmittedTruthfully(response)
return response
```

事务内不 spawn，避免 child 看到尚未提交的 job，也避免持锁启动进程。`attemptDetachedSpawn` 只表示发起；只有 runner 成功 claim 才证明 worker 真正开始。

### 4.2 失败语义

- capture/store 失败：记录 reason code，继续尝试安全的只读 document selection；仍返回主会话。
- spawn 失败：job 维持 pending，不产生用户提示；下一次 prompt 有界恢复。
- selection 失败：返回 no-op context；不能注入“记忆不可用”或“等待压缩”。
- host response 构造失败：返回宿主定义的最小合法 no-op。

所有同步操作都有硬 timeout/数量/字节边界。日志记录阶段、opaque id、duration 和 reason，不记录正文。

## 5. 明确反馈候选检测

### 5.1 结构信号

可信宿主信号可直接进入 candidate：

- active-turn steering/correction；
- interruption 或 `turn_aborted`；
- 宿主原生 explicit-feedback event。

它们仍须先通过 synthetic filter。receipt、hookPrompt、AFL marker、reviewer instruction 不能触发 reviewer。

### 5.2 已完成回合的回顾性证据

普通 `UserPromptSubmit` 往往发生在上一轮 assistant 已完成以后，因此不能只依赖 steering。检测器要求存在直接 assistant referent，并从以下独立类别收集证据：

1. **负面评价/未达标**：指出不合理、没达到要求、变复杂、仍然重复等；
2. **向后指代**：明确指向“刚才、上面、之前、你改造这些”等既有 agent 行为；
3. **责任或因果**：说明 agent 的选择导致结果，或用户被迫再次发现/纠正；
4. **期望过程反差**：表达“本来应该先……、为什么没有……、等到……才……”；
5. **明确修正要求**：要求改变已交付方案，而不是选择一个尚未决定的方案。

候选门槛必须包含“既有 assistant referent + 明确不满”，再要求至少一个独立因果/过程/修正类别。实现可用可解释权重，但不能用单词命中直接授权。

必须锁定的正例：

> 是的，而且为什么你改造这些之前没有去考虑这些东西呢，而是等到我发现事情变复杂了才开始思考这些东西

必须锁定的负例包括：

- “reviewer job 是干嘛的？”
- agent 主动问“是否按 A 方案”后，用户回答“按推荐执行”；
- 中性讨论“以后量大了再上 RAG”；
- 任何 receipt/hookPrompt；
- 没有既有 assistant referent 的一般产品抱怨。

### 5.3 Reviewer 仍是最终语义闸门

高召回候选可能误报。runner 给 reviewer 的 bounded context 至少包含：被指向的 assistant 输出、当前用户反馈、紧邻必要事件、项目目标摘要，以及既有 reflection metadata/paths。reviewer 必须证明：

- 用户评价的是已经发生的 agent 行为；
- 存在可核对的未满足要求或错误方法；
- 责任不是外部系统或纯偏好变化；
- 方法变化能迁移到未来任务；
- 是否与既有 family 相同，以及先前方法是否曾在本事件前 emitted。

不能证明则返回 `reviewed_no_lesson`。candidate 数量不是 lesson 数量，误报不会污染文档库。

## 6. Job identity、租约与恢复

### 6.1 稳定 identity

同一次 source observation 的 identity：

```text
sha256(host | session_uid | context_epoch | source_event_id | referent_id)
```

若宿主没有稳定 event id，fallback 使用 host payload 中稳定字段的规范化 digest。identity 只用于 hook replay/reconciliation 去重；禁止跨事件、跨会话按相似文本去重，因为相似失败再次出现正是效果证据。

### 6.2 最小持久字段

概念上的 `reviewer_jobs` 需要：

```text
job_id, source_identity UNIQUE, state
attempt, owner_id, lease_epoch, lease_until, next_attempt_at
source_event_ref, referent_event_ref
created_at, claimed_at, completed_at
result_code, error_code
published_path, published_sha256
```

相邻 evidence 可以继续存在 session event 表，但要有大小和保留期；长期报告正文不写进 SQLite。终态 job/evidence 的清理不能影响 Markdown。

### 6.3 Detached 进程契约

macOS/Linux 使用 Node `spawn` 的 detached process group、`stdio: ignore`（或 runner 自有结构化日志 fd）与 `unref`。launcher 不等待 provider。runner 启动后必须先通过 owner + lease epoch claim；旧 owner 在 lease 过期后不能发布结果。

没有常驻 scheduler。每个新 candidate 都即时 spawn；后续 prompt 额外恢复至多一个 due pending/expired job。worker 正常完成后直接退出。这样第一条反馈不会等第 3 条，系统空闲时也没有后台维护进程。

## 7. Reviewer 输出与 Markdown 发布

### 7.1 结构化 provider 输出

provider 的机器契约至少包含：

```text
outcome: lesson | no_lesson
final_severity
responsibility
method_class
family_id or proposed_family_key
applies_when[]
facts[]
user_complaint
root_cause
class_of_mistake
method_changes[]
repeated_pattern_evidence[]
recurrence_of[]
```

controller 校验枚举、长度、必填字段、source provenance、family 引用和内容边界。reviewer 不能直接写最终文件。

### 7.2 延续现有可读格式

canonical Markdown 保持目前“反思报告 + metadata bullets + 具名章节”的形式，例如：

```markdown
# 反思报告：<标题>

- reflection_id: <opaque id>
- created_at: <ISO timestamp>
- final_severity: Major
- responsibility: agent_fault
- method_class: <stable class>
- family_id: <opaque/stable id>
- applies_when: <short bounded conditions>

## facts proven by context
...

## user complaint in plain language
...

## root cause
...

## class of mistake
...

## method change
...

## repeated pattern evidence
...
```

不另建长期 lesson/card 数据库。`method change` 就是后续 selector 构造 guidance 的来源；`class of mistake`、`applies_when` 和项目范围用于匹配。

### 7.3 原子发布

发布步骤：

1. 在目标目录创建权限受限的同目录临时文件；
2. 写入并 fsync 文件；
3. 必要时 fsync 目录；
4. rename 到 `<timestamp>-<slug>.md`；
5. 重新计算 hash；
6. 用当前 lease epoch 提交 `published_path/hash`。

如果 stale worker 已经写出同一 identity，controller 通过 reflection id/hash 识别并复用，不能生成第二份。no-lesson 只提交 job 终态。

### 7.4 Legacy 文档

现有报告不被重写。parser 兼容已有 `final_severity`、`responsibility` 和具名章节；缺 `family_id` 时可根据完整的 mistake class + method class 产生稳定 legacy family fingerprint。若连 method change 或责任都无法可靠解析，文档保留但自动选择省略为 `legacy_incomplete`。

## 8. 文档直接选择

### 8.1 输入和相关性

selector 扫描当前项目 `.agent/reflections/*.md`。每个文件只读取配置的最大字节数并解析所需章节，不把全报告注入主模型。匹配信号来自：

- 当前项目 scope；
- `applies_when`、mistake/method class 与当前 task features 的确定性 lexical overlap；
- severity；
- 同 family 文档数；
- recency；
- stable document id。

当前规模直接解析更透明。任何缓存都只能是可丢弃的文件 metadata cache，Markdown 仍是事实源。没有 embedding、向量库或数据库正文检索。

### 8.2 排序与预算

建立完全确定的 total order 后按 family 去重，再选择 Top-K。每个入选文档只渲染 bounded `method change` 与必要触发条件。容量问题返回 omission：

- `count_budget`
- `token_budget`
- `oversized_document`
- `legacy_incomplete`
- `family_projection`
- `prior_emission`

任何 omission 都不改变主会话可执行性，不创建 compaction job，不返回 hold。5 张适用严重文档、上限 4 时必须稳定选择 4 张并省略 1 张。

## 9. 效果证据

最小 emission ledger 只保存：document hash/path、family id、session/context/task fingerprint、selected timestamp、emitted timestamp、outcome/reason。它不保存 method body。

状态边界：

```text
published  --selector chose--> selected  --host response contained guidance--> emitted

later validated same-family failure
    + qualifying pre-event emitted record
    = recurrence_after_emission
```

- published 只证明文件存在；
- selected 只证明排序选择；
- emitted 只证明 hook 返回了 guidance；
- 没有 host/model adoption signal 时，不存在 observed；
- 没有真实行为对照时，不存在 effective；
- 没再出现保持 unknown；
- emitted 后复发是负向证据，必须进入新报告的方法修订。

这解决当前真实库“有大量 emitted_unconfirmed，却从未闭合 effectiveness/recurrence”的问题：新系统不再把尝试投递包装成效果。

## 10. 旧分支代码处置

实施第一步必须逐 commit 审计 `7d6b1e3..9c89e00`：

- 通用且仍正确的 schema helper、fenced lease primitive、结构化日志和测试 fixture 可以保留；
- notification delivery tables/API、Codex adapter、system fallback、Stop watchdog、episode router、maintenance job/scheduler 以及相关 CLI/doctor/documentation 必须删除或回退；
- 不能保留“未来也许需要”的 disabled production path，因为它会继续增加 migration、health、测试和误触发面；
- 被删除能力若未来有真实规模/产品证据，再作为独立 change 重新设计。

## 11. 一次性旧数据导出

旧 DB 只作为归档输入。迁移工具必须：

- 接受显式 source DB 和 output directory；
- 默认或强制先 `--dry-run`；
- 只读打开 source；
- 按 legacy id/content hash 幂等；
- 把可验证完整报告转为 canonical Markdown；
- 把缺字段、碰撞和已有文件列为报告，不猜测补全；
- 第二次运行零重复写入。

实施和测试只使用临时 HOME 与 DB 副本。没有用户再次授权，不接触 `~/.codex/config.toml`、`~/.agent/feedback-loop/current.json` 或真实反馈库。

## 12. 日志与可诊断性

每个阶段使用结构化 event：

```text
prompt_capture_completed
feedback_signal_evaluated
review_job_created | review_job_reused
review_spawn_attempted
review_job_claimed | review_job_recovered
review_completed_no_lesson | reflection_published
reflection_parse_omitted
reflection_selected | reflection_emitted
recurrence_after_emission
```

字段只允许 opaque ids、reason codes、计数、字节/Token 预算、attempt/lease epoch、duration 和 exit status。禁止 raw prompt、assistant output、report/method body、token、socket、credential 和不必要的绝对路径。

Doctor 只检查真实运行依赖：prompt hook managed entry、Node/runtime、可写控制库、reflection directory、reviewer provider/launcher，以及“旧 AFL Stop managed entry 已移除”。它不再显示 notification/scheduler/maintenance 健康项。

## 13. 测试策略

### 13.1 单元与性质测试

- detector 正负例、中英文表达、single-keyword false positive；
- source identity replay 幂等与跨会话同类反馈不去重；
- lease fencing、retry、stale submit；
- reviewer validator、no-lesson、family recurrence；
- canonical/legacy parse 和原子发布失败注入；
- document Top-K 稳定性、5 选 4、oversized/token omission；
- selected/emitted 分离与 recurrence-after-emission 时间关系；
- 日志内容泄漏测试。

### 13.2 集成测试

- prompt hook 创建 job 后在 reviewer 完成前返回；
- detached child 不继承/占用宿主 stdio，主进程退出不杀死正常 runner；
- spawn crash 后下一 prompt 最多恢复一个 due job；
- fresh HOME 安装只有 prompt hook；legacy managed Stop 被精确删除；
- 文档发布后新 prompt 直接消费，无 DB lesson/card body；
- DB export dry-run、只读与二次幂等。

### 13.3 真机/真实环境

macOS Codex desktop 必须用真实 UI 验证：

1. 普通业务 prompt 不出现 AFL receipt/hookPrompt/status；
2. 指定明确不满样例产生即时 detached job，而主回答正常结束；
3. subagent 完成后出现一份规范 Markdown；
4. 新任务的匹配 prompt 选中并 emitted 该方法；
5. 5 张严重文档不触发 hold。

Linux 环境验证安装、进程组、`unref` 生命周期、锁/租约、文件权限和 atomic rename。协议/单元通过不能替代这两层证据。

## 14. 发布与回滚边界

1. 当前阶段只在隔离 worktree 和临时 HOME 实施。
2. 完成 RED→GREEN、全量回归、fresh install、macOS 真机和 Linux 验证后，仍只形成可安装候选。
3. 必须由用户再次明确授权，才能导出真实旧数据、恢复 hooks 或切换 managed runtime。
4. 原子切换前保留旧 `current.json` target；失败时恢复配置和版本指针。旧 DB 不被修改，新 Markdown 是独立普通文件。

## 15. 设计结论

该设计把 AFL 缩回两个真正创造价值的动作：

1. 发现明确反馈后立即让独立 subagent 反思并生成可审计文档；
2. 后续主会话直接读取适用文档的方法变化。

其余 receipt、Stop、通知、三条聚合、scheduler、maintenance 和数据库长期记忆均不属于这条价值链，因而从当前架构中删除，而不是继续隐藏在配置后面。
