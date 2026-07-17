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
7. 一次 capture 只允许一个在任何 await/副作用前产生的 caller-independent frozen snapshot；公共路径的 exact replay、alias attachment 与 new-event insertion 必须在同一个 `BEGIN IMMEDIATE` 内作最终决策。

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

- 同步 preflight 当前 user event 和直接 assistant referent，冻结 capture snapshot；
- 在 SQLite 事务外写入 content-addressed encrypted blob，再把 snapshot 与 authoritative encrypted ref 交给 control store；
- 调用 `feedback-signal` 得到 `{candidate, reasonCodes, score}`；
- 在短事务中调用 reviewer job store；
- 事务提交后调用 detached launcher；
- 调用 document selector 并渲染 bounded context；
- 无论子步骤结果如何都返回宿主的 prompt-hook schema。

同步路径禁止：reviewer/provider 调用、等待 child、Stop reconciliation、native message append、系统通知、数据库 migration、文档 consolidation。

### 3.2 `feedback-signal`

纯函数输入是宿主结构字段、当前 user event、直接 referent 的最小 metadata，以及是否为 synthetic traffic。输出只说明“是否值得交给 reviewer”，不产生 lesson、severity 或责任结论。

### 3.3 Control store 与 reviewer job store

复用现有 SQLite 基础时只保留 capture event/observation、job、source observation、lease 和 publication/emission 指针。control store 对公共 capture 提供一个接收 frozen snapshot 与 authoritative encrypted ref 的原子 resolve-or-insert 方法；它不再读取、补写或返回 caller-owned event。notification、episode、maintenance、长期 lesson/report/card 表不能成为新 runtime 依赖。

### 3.4 Detached launcher 与 runner

launcher 只负责一次 spawn attempt；runner 才拥有 job lease、provider invocation、validation 和 publication。两者通过 job id 关联，不通过 stdout 向主会话传递结果。

### 3.5 Reflection document

`reflection-document` 负责 canonical/legacy Markdown parse、结构校验、render、atomic publish 和 content hash。selector 与 reviewer 都通过这一层读取文档，不能各写一套解析规则。

### 3.6 Selector

selector 的输入是项目目录、当前任务的 bounded textual features、已发布文档与 emission history；输出是 `{guidance, selected, omissions}`。它不打开旧 lesson/card body 表。

## 4. Prompt 同步路径

### 4.1 同步 capture preflight 与 frozen snapshot

公共 capture 的第一步必须是无 I/O 的同步 preflight。它在任何 `await`、blob 写入、SQLite 查询或日志副作用前一次性完成以下工作：

1. 规范化并冻结 15-field、body-free canonical identity，字段顺序固定为：
   `event_uid`、`source_provider`、`session_uid`、`context_epoch`、`source_namespace`、`source_id`、`source_event_id`、`source_offset`、`capture_source`、`native_turn_id`、`source_timestamp`、`role`、`referent_event_uid`、`content_hash`、`completeness`；
2. 校验 snake/camel alias 冲突、空值、长度/整数边界、provider/session/context/event/source identity、referent、timestamp、role、completeness 与 canonical content hash；所有 identity、observation-alias 和边界错误都在这里 fail closed；
3. 由 canonical identity 计算 body-free signature，并计算 observation key/UID、source identity 等 storage key；
4. 复制并冻结 `project_id` 等 bounded project/storage metadata，以及 caller supplied `encrypted_raw_ref`（允许为 `null`）；
5. 对 `rawText` 计算独立的 `blobContentHash`，作为 content-addressed blob storage value 冻结在 prepared capture 中；它不替换、也不要求等于 canonical identity 中的 `content_hash`。

snapshot 是新建的不可变值，不持有原 event 的可变引用。`rawText` 不属于 snapshot，也不进入 canonical signature；它只用于计算独立 `blobContentHash` 和执行 content-addressed encrypted blob 写入。canonical `content_hash` 可以是规范化/脱敏 event 内容的 identity hash，raw evidence 的 `blobContentHash` 可以覆盖更完整的 payload，二者职责不同。preflight 返回后，公共路径及数据库层不得再次读取或修改原 event，因此 caller 在 blob await 期间修改 `capture_source`、event UID、source identity、content hash、project metadata 或 encrypted ref 都不会改变本次 capture 的决定。

若后续 detector 需要 event 上已经脱敏的候选输入，preflight 同步复制出独立的 frozen signal input；该输入不属于 canonical identity，不写入 SQLite，也不得在 await 后从原 event 重新取得。它与 `rawText` 分离，`rawText` 仍只服务于 hash/blob。

blob I/O 明确位于 SQLite transaction 之外。第一次 `blobs.write(blobContentHash, rawText)` 返回本次 authoritative encrypted ref；若 preflight 保存的 caller supplied ref 非 `null`，它必须与 writer 返回值精确相等，否则在进入 SQLite 前 fail closed。supplied ref 为 `null` 时，以 writer 返回值为 authoritative ref。blob body、rawText 和 blob bytes 都不得进入 SQLite 或 canonical signature。

### 4.2 单事务 resolve-or-insert

第一次 blob 写入/确认完成后，公共路径只调用一次 control-store 原子方法，将 frozen snapshot 与 authoritative encrypted ref 作为完整输入。该方法使用一个 `BEGIN IMMEDIATE`，并严格按以下顺序作最终决定：

1. **Exact observation replay：** 以 observation key 查询；存在时必须同时匹配完整 15-field signature、observation binding 和独立的 `encrypted_raw_ref` storage invariant。全部一致才返回 `kind=exact_replay, duplicate=true`；任一不一致均抛固定 collision，不得返回部分匹配结果。
2. **UID/source identity conflict：** 若 incoming `event_uid` 或 source identity 已被占用，但第一步未证明是 exact replay，则 fail closed。不能把两个冲突行任选其一，也不能继续 alias 查询。
3. **完整 alias candidate recheck：** 在当前写事务持锁期间重新执行既有完整候选查询与 provider/session/context/role/content-hash/native-turn/timestamp/五分钟窗口边界判断；禁止复用事务外查询结果。alias 的 canonical signature 保留该 observation 自己的 15-field identity。
4. **唯一 compatible alias：** 只有恰好一个候选且其已存 `encrypted_raw_ref` 与 authoritative ref 满足独立 storage invariant 时，才插入第二条 observation 绑定既有 event，返回 `kind=alias, duplicate=true`。
5. **New event：** 没有候选、候选不唯一，或唯一候选的 encrypted ref 不兼容时，插入新 session/event/observation，返回 `kind=new, duplicate=false`。该分支不改变 schema，也不覆盖既有 event/blob ref。

`BEGIN IMMEDIATE` 使两个不同 observation alias、且 raw/blob storage invariant compatible 的首次并发 capture 形成稳定串行顺序：第一个事务插入一个 event，第二个事务在锁内重新查询后把自己的 observation 绑定到它。结果必须始终为一个 `new`、一个 `alias/duplicate`，数据库为 1 event/2 observations；调度顺序只影响哪个调用成为 `new`，不能产生 2 events。

事务返回统一结果 `{kind, duplicate, eventUid, blobPath, eventView, observation}`。`eventUid`、`blobPath` 与 frozen `eventView` 必须来自同一个已提交 event：exact replay/alias 使用目标行的 persisted UID/ref，new 使用刚插入行的 UID/authoritative ref。兼容层若仍返回 `event` 字段，只能映射到该 `eventView`，不能回传原可变对象；因此不会出现 caller changed ref 与 stored/blob ref 同时出现在一次成功结果中。

### 4.3 Prompt 顺序与事务边界

一次 prompt hook 的伪流程：

```text
selectionPublishedBefore = hookStartedAt
{snapshot, frozenSignalInput, blobContentHash} = preflightCapture(payload.event, payload.rawText)  # sync
blobRef = await blobs.write(blobContentHash, payload.rawText) # outside SQLite
authoritativeRef = reconcileSuppliedRef(snapshot.suppliedEncryptedRef, blobRef)
captureResult = controlStore.resolveOrInsertCapture(snapshot, authoritativeRef)
await blobs.write(blobContentHash, payload.rawText)            # post-commit GC-race confirmation

signal = detect(frozenSignalInput, directReferent)

BEGIN IMMEDIATE
  source = insertSourceObservationIdempotently(captureResult.eventView)
  job = signal.candidate ? insertJobIfAbsent(source.identity) : null
COMMIT

if job.wasCreated:
  attemptDetachedSpawn(job.id)       # no wait

attemptBoundedRecovery(limit = 1)    # pending/expired only; no timer

documents = readProjectReflections(publishedBefore = selectionPublishedBefore)
selection = selectDocuments(documents, frozenSignalInput.taskContext)
response = renderHostContext(selection.guidance)
recordSelectedAndEmittedTruthfully(response)
return response
```

`selectionPublishedBefore` 在任何 detached spawn 前固定。即使 reviewer 极快并在当前 hook 尚未完成时发布，新文档也因 `published_at >= selectionPublishedBefore` 被本轮排除，只能从后续匹配 prompt 生效。

capture 的 resolve-or-insert 事务与 reviewer job 事务都必须短小，二者都不包含 blob I/O、spawn 或 provider 调用。事务内不 spawn，避免 child 看到尚未提交的 job，也避免持锁启动进程。`attemptDetachedSpawn` 只表示发起；只有 runner 成功 claim 才证明 worker 真正开始。

### 4.4 失败、blob 与兼容语义

- invalid identity、supplied-ref mismatch、exact replay collision、UID/source conflict 或 alias/store 失败：capture API 自身 fail closed；prompt orchestration 只记录 bounded reason code，继续尝试安全的只读 document selection，并对业务回合 fail-open。用户输出不得包含 AFL 状态。
- spawn 失败：job 维持 pending，不产生用户提示；下一次 prompt 有界恢复。
- selection 失败：返回 no-op context；不能注入“记忆不可用”或“等待压缩”。
- host response 构造失败：返回宿主定义的最小合法 no-op。

所有同步操作都有硬 timeout/数量/字节边界。日志记录阶段、opaque id、duration 和 reason，不记录正文。

事务提交后继续执行既有 content-addressed blob second-write/GC race contract：durable DB ref 建立后再次幂等写/确认同一 hash，使并发 GC 能看到引用；SQLite collision 或其他失败时不得主动删除可能被其他 event 引用的 content-addressed blob，保留给 retention GC 判断。第二次写入仍不进入 SQLite transaction。

`assertCaptureAllowed(event)`、`captureSessionEvent(event)` 与 `resolveEventObservation(input)` 的 direct API 兼容面继续保留，但必须共享同一 normalization、15-field signature、observation/storage-key 和 encrypted-ref invariant helpers。`captureSessionEvent(event)` 是“同步 preflight + 以 supplied `encrypted_raw_ref` 为 authoritative ref 立即调用同一原子决策”的 compatibility wrapper。`resolveEventObservation(input)` 可保留其历史 direct 语义：创建 alias 时以目标 event 的 persisted ref 为 storage invariant，若 direct caller 显式提供非空 ref 则必须精确匹配；它不能再被 public capture 用作 transaction-external fast path，也不能形成“先 resolve、await blob、再 insert”的两阶段协议。

### 4.5 已否决的 capture 方案

- **继续 patch transaction-external resolve fast path。** 补更多字段仍保留 stale alias decision、caller mutation TOCTOU 和公共/direct 两套证据规则，无法建立单一提交点。
- **增加 per-process/session mutex。** 多 hook、runner 或进程不能共享进程内锁，崩溃恢复也没有可靠所有权；SQLite 写事务才是跨进程串行边界。
- **把 blob I/O 放进 SQLite transaction。** 文件系统/加密 I/O 会不受控延长写锁并放大正常并发失败；snapshot 先冻结、blob 事务外确认、SQLite 内只做 bounded metadata 决策即可满足原子身份要求。

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
- published_at: <ISO timestamp>
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

现有报告不被重写。parser 兼容已有 `final_severity`、`responsibility`、英文/中文具名章节以及列表式 metadata。很多现有文档没有显式 `method_class`/`family_id`；只要 mistake class 与可执行 method change/preventive constraint 完整，controller 就从规范化 mistake class 稳定派生 legacy method class，再从 mistake class + derived method class 产生 legacy family fingerprint。该规则只合并精确规范化类别，不声称语义等价。若连 mistake class、method change 或责任都无法可靠解析，文档保留但自动选择省略为 `legacy_incomplete`。

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

- capture preflight 固定 15-field body-free tuple，rawText/ref/blobContentHash 不进入 signature；非法 capture source、identity alias 冲突、越界 canonical content hash 在 blob/DB/log 副作用前拒绝，并证明 canonical `content_hash` 与 raw `blobContentHash` 可合法不同；
- public/direct exact replay 使用相同 signature 与 encrypted-ref invariant；changed ref、UID/source identity 或任一 canonical field 产生 fixed collision；
- blob await barrier 中修改 caller event 不影响 frozen snapshot、持久行或返回值；supplied non-null ref 与 blob writer ref 不一致时 SQLite 保持零写入；
- alias candidate 的 encrypted ref 不兼容时不附着既有 event，而是按无冲突 new-event 分支落账；
- detector 正负例、中英文表达、single-keyword false positive；
- source identity replay 幂等与跨会话同类反馈不去重；
- lease fencing、retry、stale submit；
- reviewer validator、no-lesson、family recurrence；
- canonical/legacy parse 和原子发布失败注入；
- document Top-K 稳定性、5 选 4、oversized/token omission；
- selected/emitted 分离与 recurrence-after-emission 时间关系；
- 日志内容泄漏测试。

### 13.2 集成测试

- 固定复现 review-8 的三个 deterministic probe：public ref-only replay mismatch fail closed；blob barrier 中 caller mutation 不产生 mutation-derived DB 行；hook/transcript 不同 alias 首次并发稳定得到 1 event/2 observations、一个 new 与一个 alias/duplicate；
- public 与 direct API 的 exact replay 都返回 internally consistent `eventUid/blobPath`，且 exact same-key concurrency 不退化；
- provider-qualified session、immutable session provider、五分钟 alias 窗口、same/omitted context-epoch 物理 key、runtime schema fingerprint/non-migrating open 继续回归；
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
