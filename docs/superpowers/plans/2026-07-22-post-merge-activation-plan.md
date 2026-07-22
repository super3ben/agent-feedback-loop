# Convergence Kernel 合并后激活计划

日期:2026-07-22
基线:`main` @ `5fbfc92`(已 fast-forward 吸收 `codex/convergence-kernel` 全部 229 提交 + 2 项 backlog 修复)
上游交接:`docs/handoffs/2026-07-22-convergence-kernel-handoff.md`

## 1. 本轮已核实并完成(2026-07-22)

| 项 | 结果 | 证据 |
|---|---|---|
| FF 合并 `codex/convergence-kernel` → `main` | 完成 | `main` 从 `3416d18` 前进到 `7b1b7fb`,merge-base 校验为纯 fast-forward |
| 合并后 main 全量回归 | 513/513,0 fail,0 skip | `npm test` |
| 合并后打包 | 0.9.0 / 45 files | `npm pack --dry-run --json` |
| Backlog 1:doctor 模块清单 | 已修复 | `CONVERGENCE_MODULES` 与 package test 均补入 `convergence-probe-context.mjs`,见 `5fbfc92` |
| Backlog 2:fail-open 毫秒阈值 | 已修复 | held-writer 测试阈值从 2s 改为「低于 5s busy timeout 的 4s 上界」,断言语义改为证明走了短超时 fail-open 路径而非墙钟性能;实测三次 916–1384ms。见 `5fbfc92` |
| 修复后全量回归 | 513/513 | `npm test` |
| 清理已吸收 clean 工作树 | 完成 | 已移除 `task5-shared-integration`、`task7-binding-baseline`;含未提交报告的工作树全部保留 |
| 分支吸收关系复核 | 与交接文档一致 | `git cherry` 确认 7 个子分支全部 patch-equivalent 或为 ancestor |

交接文档中的 2 项 backlog 至此清零。剩余工作全部属于「受控上线动作」,每一步都需要单独授权,不涉及继续补架构或核心代码。

## 2. 剩余工作(按顺序执行,每步单独授权)

### Step A:真实仓库 lineage 初始化与 import dry-run

现状(已核实):真实仓库无 `.agent-feedback-loop/` authority;`convergence-cli` 在未初始化时安全返回 `lineage_not_initialized`,不写库。

### Step A:真实仓库 lineage 初始化与 import dry-run — ✅ 完成(2026-07-22)

- [x] 在 `main` 工作树执行 `lineage-init`:`created:true`,lineageDigest `8911415e…`(lineage 存 git common dir,所有 worktree 共享)
- [x] Guard import dry-run:首次 dry-run 对两份真实 state 均 fail-closed(`legacy_state_invalid`),确认只读、无副作用
- [x] dry-run 暴露真实缺陷:0.9.0 迁移校验器无法导入真实 SDD 历史(见下方「导入兼容修复」),修复后两份 state 均产出导入计划

**导入兼容修复(commit `cc98cfe`,经用户逐项确认)**:真实 legacy state 与校验器有 5 处格式差异——boundary 含 `/`、task_id 纯数字/含 `.`、旧 schema 缺 `direction_signal`/`last_evidence_sha256`、部分 `changes_required` review 无 hypothesis/evidence(用户选择接受空依据导入)、`failure_next_action` 为 null。全部按「接受真实数据、不改写指纹身份」原则放宽,回归 515/515。

### Step B:Guard import → shadow parity → cutover canary → rollback proof — ✅ 完成(2026-07-22)

- [x] 权威 legacy state 判定:两份 state **不是副本而是互不相交的两段历史**(convergence-kernel 29 loops / background-review-observability 22 loops,fingerprint 零重叠),各自绑定所在 worktree 的 repository_id,须分别导入
- [x] 快照留存:`.cutover-snapshot-2026-07-22/`(两份 state + 三份 CLI 配置 + cutover refs)
- [x] 真实 import:convergence-kernel(9 tasks/29 loops/158 events/33 grants)、background-review-observability(10 tasks/22 loops/99 events/24 grants),写入真实 HOME control store
- [x] shadow parity:51 个 loop 逐一自动比对 `failure_count` 与 `status→(kernel status, decision)` 映射,0 不匹配;4 个 repo 级 parity 字段(decision=closed→finish、action=none、generation=2、eligibility=false)经 `compareGuardShadow` 记录,0 mismatch
- [x] cutover canary:先对 convergence-kernel 单仓库 cutover(authority `legacy_guard`→`afl_sqlite`,生成 0400 快照)
- [x] rollback proof:真实执行 rollback,authority 回到 `legacy_guard`,state 文件 sha256 与切换前完全一致
- [x] 最终 cutover:两个 repo authority 均为 `afl_sqlite`,refs 记录于 `.cutover-snapshot-2026-07-22/cutover-refs.json`

### Step C:真实 HOME 安装与 prompt hook 重启 — ✅ 完成(2026-07-22)

- [x] 隔离 canary(临时 HOME):install/doctor/uninstall 往返干净,hook 块无 Stop hook、无 statusMessage
- [x] 真实 HOME 安装 0.9.0:installer 自动清除旧 `stop-hook.sh`/`trigger-rules.sh`,重写 Codex/Claude/Gemini 三个 hook 块;安装前三份配置已备份到 `.cutover-snapshot-2026-07-22/`
- [x] 残留的 `hooks.Stop` 属于用户自己的 `context_compact_guard.py`,与 AFL 无关,保留不动
- [x] hook 真实执行验证:管道注入一次 prompt,返回静默 `{"continue":true}`,无 Guard/Probe/receipt 文本;`doctor --live` 确认 controlStore healthy、encryption healthy、runtime 0.9.0 selected

### Step D:真实 provider / Codex Desktop canary — ✅ 完成(2026-07-22),修复 2 个真实缺陷后全链路闭环

- [x] **缺陷 1 已修**(`ec340e9`):claude CLI 校验器拒绝 draft 2020-12 `$schema` dialect pin
- [x] **缺陷 2 已修**(`62dd8cd`):API 拒绝顶层 `oneOf/anyOf/allOf` 的 input_schema(400 错误在 CLI 内部重试直至耗尽 provider 超时,表象是 provider_timeout/provider_unavailable)。claude 传输层现在镜像 codex 方案:逻辑分支包裹在单个 required `result` 属性下(分支保真),读取时多解一层。真实 claude CLI + 生产 schema 实测 6.4s 返回合法 `structured_output`
- [x] **完整生产链路闭环实证**(job `4861171c`,attempt 1,约 15s):明确不满 → explicit_feedback candidate → durable job → detached one-shot reviewer → 真实 claude provider → 判定有长期价值 → 原子发布规范 Markdown lesson(`.agent/reflections/20260722-154936-resource-cleanup-…md`,facts/root cause/method_changes 结构完整)→ 后续相关 prompt 按词面相关性命中并注入该 lesson(document_hash 与发布文件 sha256 一致)→ `reflection_emissions` 记录投递审计
- [x] lesson 投递路径同样在本会话真实 Claude Code hook 中生效(历史 lesson 注入)
- [x] **环境要求确认(生产启用前提)**:reviewer 子进程被双层环境白名单剥离;第三方 `ANTHROPIC_BASE_URL` 中转与超时配置须通过 `AGENT_FEEDBACK_LOOP_REVIEWER_ENV_ALLOWLIST` 显式放行(值中必须包含它自身与 `AGENT_FEEDBACK_LOOP_REVIEWER_TIMEOUT_MS` 才能传进 detached reviewer-run);真实 codex reviewer 单次审查 >420s,claude reviewer 秒级——建议 reviewer 源优先 claude
- [x] 失败路径全程符合设计:有界重试(3 次上限)、退避调度、attempts_exhausted 终态、零主会话干扰、审计事件完整

### Step E:发布与生产有效性观察 — ✅ 发布完成(2026-07-22)

- [x] push `main` 到 origin(SSH 被网络重置,origin 已切 HTTPS)
- [x] tag `v0.9.0` + GitHub Release:https://github.com/super3ben/agent-feedback-loop/releases/tag/v0.9.0
- [ ] 生产指标观察(hook 已在真实 HOME 启用,随日常使用积累)

### Step F:流程与工作区收尾 — ✅ 完成(2026-07-22)

- [x] Comet change `isolate-feedback-control-plane`:build guard → verify(full 模式,报告 `docs/superpowers/reports/2026-07-22-isolate-feedback-control-plane-verify.md`,PASS)→ 用户确认归档 → delta spec 合并入 `openspec/specs/`(5 capabilities / 23 requirements)→ archive guard 全 PASS
- [x] 全部 12 份未提交工作树报告归档到 `docs/superpowers/reports-archive/2026-07-22-worktree-reports/`,随后清理 6 个 worktree
- [x] 删除 8 个已吸收本地分支与远端 stale 分支

## 3. 红线(继承交接文档 §7)

- 不得自动启用 Stop/AfterAgent hook
- 不得把 Guard/Probe receipt 或内部控制文本输出到主会话
- 不得在未初始化 lineage 时隐式创建 authority
- 不得跳过 shadow parity 直接 cutover
- 不得把 Probe advice 当作 hard decision 或 grant authority
- 不得在未处理用户报告文件前删除对应工作树
