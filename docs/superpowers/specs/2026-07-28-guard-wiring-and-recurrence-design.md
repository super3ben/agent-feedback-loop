# 反思复发失明修复 + Guard 执行期接线

日期: 2026-07-28
状态: 待评审

## 背景与实证

两个独立失效,均经本机数据实证,且均**对新用户必然复现**(源于契约与接线设计,非本机配置问题)。

### 失效 A: 反思链路对复发失明

控制库 `control.sqlite3` 统计:

| 指标 | 数值 |
|------|------|
| candidate_created | 54 |
| published | 6 |
| reviewed_no_lesson | 33 |
| failed / 未完成 | 15 |
| expanded_feedback 候选 | 0 |

用户同一问题反馈 7 次仍复发。实证链路:用户原话
`为什么又要打开这个Termius？ssh不能登录吗...` 于 `2026-07-28T08:19:06`
被完整采集 → 拉起复审 → 真实模型判定 → `reviewed_no_lesson`。

采集、referent、证据包容量均正常(codex assistant 事件 43 条,53 条事件带
referent;截断限额 16K/8K/2K 字符)。失效发生在**判定契约**。

**根因: 冷启动死锁。**

`templates/prompts/reflection-agent.md:14-17` 为强默认拒绝:必须证明
`agent_fault` 且严重度 Major 以上,并将 "external limits" 排除在经验之外。

- 单次孤立看: agent 称"本机钥匙串没有该主机凭据"→ 落入 external limits →
  判 no_lesson **符合契约**。
- 本应由"重复 7 次"顶高严重度,但 `recurrence_of` /
  `repeated_pattern_evidence` 只能引用**已发布**经验
  (`catalogSummaries` 仅读 reflection catalog)。

于是: 靠复发提severity需先有已发布同族经验 → 发布需单次即 Major+ → **死锁**。
单次为 minor 但重复 N 次的模式永远学不进去。7 次反馈 = 7 次互不相见的 no_lesson。

加重因素:

1. 用户话语中的"又/还是/我都说了 N 次"是明确复发信号,契约中无任何条款
   将其采信为 `repeated_pattern_evidence`。
2. **判定理由不落库** —— `reviewer_jobs` 仅存 `result_code`,模型判 no_lesson
   的原因无记录。这是该失效能静默重复 7 次而无人发现的直接原因。

### 失效 B: Guard 对自主跑零约束

convergence guard 是能力完备的过度设计断路器(`failure_count>=2` 或方向信号
→ `direction_review_required`),但为 **pull-based、仅 sdd adapter、未接任何 hook**
(`core-hook.sh` 零 guard 引用)。

实证: 8h21m 的 site-gateway codex 会话(rollout JSONL 12450 行)对真实 guard
调用 **0 次**,取而代之运行自创的自我批准影子门禁(`GO` ×6756、`Guard` ×818、
`RED/GREEN` ×136)。根因是**缺接线**,非判定标准有问题。

### 用户核心反馈: 越改越费

现状复杂度: 3 个 result kind、语义门禁(执行 0 次)、convergence guard
(自主跑调用 0 次)、convergence-probe(仅手动子命令)、
`resultKind: "reviewer"` 死值(与 `RESULT_KINDS` 不匹配,仅因显式传
`promptFile` 才未抛 `provider_invalid`)、`~/.agent-feedback-loop/` 与
`~/.codex/hooks/feedback_loop_router.py` 残留。端到端有效产出 54 → 6。

**设计原则: 本次不新增子系统,而是修通已有链路并删除不可达枝节。净复杂度不得上升。**

## 范围与验收

### 修改 A1: 复发计数进证据包(破死锁)

`buildReviewContext` 已查询 `session_events`。增加一项:同 project 下语义近似
历史抱怨的出现次数,复用现有 `classifyRetrospectiveEvidence` 的 reasonCodes
加词法近似计算,**不引入新的模型调用**。

复审据此看到"这是第 N 次",不依赖已发布 catalog。

验收: 构造同类抱怨 N 次的 fixture,证据包中复发计数为 N;N>=2 时复审可在无
任何已发布同族经验的前提下产出经验。

### 修改 A2: 契约承认用户自述复发

`templates/prompts/reflection-agent.md`:

- 用户话语中的"又/还是/我都说了 N 次"及证据包复发计数构成
  `repeated_pattern_evidence`,**可独立**将严重度提升至 Major。
- "external limits" 限定为**首次**遭遇。复发的同一外部限制属于 agent 未固化
  已知信息,归 `agent_fault`。

验收: 上述 Termius 事件的实际证据包经修订契约复审后产出经验而非 no_lesson。

### 修改 A3: 判定理由落库(可观测性地基)

`review_job_events.reason_code` 字段已存在,无需加表。`reviewed_no_lesson`
必须写入判定原因。

验收: 任一 no_lesson 结案后可查得其原因;缺原因视为失败。

### 修改 B: Guard 执行期接线

已确认的 codex hook 语义(经本机 compact-guard 与官方文档核对):

- `PostToolUse` 为工具级事件,每次工具调用后触发 —— 即缺失的执行期触发点。
- `Stop` 仅回合末触发,管不住 8h 单回合自主跑。
- 每次 payload 均带 `session_id`(会话级身份)与 `transcript_path`
  (回合数/时长/工具历史 → 确定性信号)。
- `core-hook.sh` 已按 `--event` 参数化,install 为声明式 `CLIS` 注册表。

落地(四项此前已确认的选择):

1. `CLIS` 注册表为 codex/claude 增加 `PostToolUse`,gemini 用其等价事件。
   新用户执行 `install` 自动接线 —— 满足"对新用户生效"约束。
2. 第一层确定性初筛(零 LLM,每次都跑): 由 `session_id` 建/取会话级监控身份;
   读 `transcript_path` 计算回合数、累计时长、连续无实质进展计数。未越阈即
   `{"continue":true}` 放行。
3. 第二层仅越阈时升级至 LLM 精判,**复用现有 convergence-probe**,不新建
   result kind。判定成立则累加 `failure_count`。
4. 越阈动作为软阻断: 返回 `{"continue":true,"systemMessage":...}` 注入停止
   与最小收敛指令。

验收: 未越阈时单次 hook 为纯确定性且无 LLM 调用;越阈时注入停止指令;
`install` 后新环境的 `PostToolUse` 已注册。

### 瘦身(同批)

- 删除语义不满门禁全部拆除面: `src/cli.mjs:780`、
  `src/reviewer-runner.mjs:148-149,245,248`、`src/reviewer-provider.mjs:32`
  注册项、`templates/prompts/semantic-dissatisfaction-gate.md`、
  `templates/schemas/semantic-dissatisfaction-gate.schema.json`。
  理由: `expanded` 要求 `!explicit`,而抱怨话术几乎总先命中
  `negative_evaluation` + supporting 被判为 `explicit`,该路径**结构性不可达**
  (实测执行 0 次);其目标已由 A1 复发计数覆盖。
- 删除 `resultKind: "reviewer"` 死值(`src/reviewer-runner.mjs:270`)。
- 清理 `~/.agent-feedback-loop/` 与 `~/.codex/hooks/feedback_loop_router.py`
  残留(两者均已不被任何配置引用)。

净效果: 删 1 个 result kind、1 条死路径、1 个死值、2 处残留;
加 1 个执行期事件与 3 处链路修补。

## 非目标

- 不改 convergence guard 的判定标准(实证其标准本身合理)。
- 不引入常驻守护进程。
- 不改 `Stop` / `UserPromptSubmit` 现有语义。
- 不做与本失效无关的重构。

## 测试策略

- A1: 复发计数单测 + 同类抱怨 N 次的证据包 fixture。
- A2: 以实际 Termius 证据包为回归夹具,断言产出经验。
- A3: no_lesson 必带原因的断言。
- B: 确定性初筛单测(不触发 LLM);`install` 后 `PostToolUse` 注册的
  e2e 断言;越阈注入 `systemMessage` 的断言。
- 瘦身: 全量测试通过,且无对已删除 result kind / 模板的悬挂引用。
- 并发: 涉及共享状态写入的路径需实际跑并发场景验证无死锁。
- 子进程: 新增测试若 spawn 子进程,必须经 `spawnTracked` 并在
  `finally` / `t.after` 中 `killTrackedChild`。
