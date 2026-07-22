# Agent Feedback Loop 0.9.0 / Convergence Kernel 交接文档

日期：2026-07-22

权威交付分支：`codex/convergence-kernel`

交接时实现提交：`dfa6db715c8283d52ea06a9800d028810732a0f2`

目标分支：`main`（本文件编写时尚未合并）

## 1. 当前结论

代码实现、两套实施计划、Task 1–9、恢复计划 Task 1–6 和最终整分支复审均已完成。
最终复审 `convergence-kernel-final-branch-review-1` 结论为 Approved，
Critical 0 / Important 0 / Minor 0 / Backlog 2。

当前没有阻塞合并的代码缺陷。尚未完成的内容分为两类：

- 5 项需要单独授权的真实激活、发布和生产验证动作；
- 2 项不阻塞合并的 backlog。

因此，“未完成”不是继续补架构或继续写核心代码，而是后续受控上线动作和两项低优先级收尾。

## 2. 已完成的用户价值

### 2.1 主会话不再被 AFL 控制回执干扰

- AFL 不再注册或依赖 Stop/AfterAgent 控制 hook。
- prompt hook 保持原生、静默、fail-open；失败不会向主会话输出 Guard、Probe、receipt、恢复指令或内部状态。
- `Output this receipt verbatim before stopping` 不再是正常控制路径。
- Guard 只存在于显式机器命令和真实 review/fix 调度边界，不能阻塞普通业务会话。

### 2.2 用户不满会立即进入后台反思闭环

已验证的纵向路径：

1. 明确用户不满被识别为反馈候选；
2. prompt 返回前原子记录 reviewer job；
3. detached one-shot reviewer 在后台运行，不占用主会话；
4. 有长期价值时发布规范 Markdown 经验；
5. 后续 prompt 直接读取 Markdown catalog，按相关性选择并投递；
6. 复发与投递效果通过受控元数据记录，不引入 RAG 或 scheduler。

长期经验仍以 Markdown 为唯一可读来源。SQLite 只保存身份、租约、摘要、状态和审计元数据，
不保存 prompt、diff、reviewer/Probe 正文或 lesson 正文。

### 2.3 Convergence Guard 已融入 AFL，但保持轻量

- 四张收敛控制表保存 task、loop、event、Probe/grant 状态。
- SDD 提供真实 `workflow_gate`；OpenSpec/Comet 只提供 task 间 `checkpoint_gate`；
  通用 prompt 观察最多是 `audit_only` warning。
- 第一次 Important 失败只允许一次 local fix；第二次同 invariant 失败进入方向复盘；
  architecture fix 再失败进入人工决策。
- invariant fingerprint、failure count、fix generation、alias、distinct declaration、checkpoint、
  consumed receipt 和 closed regression 均保留，不能通过改 ID 或重置计数绕过。
- Probe 是 detached、一次性、只提供建议的语义顾问；确定性 policy 才能改变 hard state 或签发一次性 grant。
- Probe 的 review evidence 和可选 producer context 使用一个有界 stdin envelope，正文不进入 argv、SQLite、日志或主会话。

### 2.4 macOS 和 Linux 边界已收口

- macOS：完整测试 513/513。
- Linux arm64：只读 rootfs、只读仓库、无网络环境中 512 通过、0 失败、1 个 macOS 专属跳过。
- Linux 不依赖 `ps`；真实 argv 检查读取 `/proc/<pid>/cmdline`。
- 静态 reviewer package assets 只读打开并在同一 descriptor 上校验/读取，不再执行 `chmod`；
  symlink、非 owner、group/other writable 仍 fail-closed。
- provider 创建的临时目录、result 和 transport 文件继续保持 0700/0600。

## 3. 最新验证证据

| 层级 | 结果 | 说明 |
|---|---:|---|
| macOS full regression | 513/513 | 0 fail，0 skip |
| macOS 核心聚焦 | 153/153 | Guard、Probe、provider、CLI、E2E、platform |
| Linux arm64 full | 512 pass / 0 fail / 1 skip | network-none、read-only、Node 24.18.0 |
| Linux reviewer provider | 17/17 | 只读 package asset 与 provider isolation |
| Python Guard oracle | 29/29 | 仅作为语义 oracle，不是 AFL runtime 依赖 |
| package dry-run | 0.9.0 / 45 files | 包含全部 convergence 模块和 Probe 资产 |
| 最终整分支 review | Approved | C0 / I0 / M0 / Backlog2 |

这些证据证明代码、测试、打包和临时运行路径，不代表真实生产验收。

## 4. 仍未完成：7 项

### 4.1 需要单独授权的 5 项操作

1. **真实仓库 lineage 初始化与 import dry-run**

   当前真实仓库未执行 `lineage-init`。因此直接 Guard import dry-run 会安全返回
   `lineage_not_initialized`，且不会写数据库或 state。这是设计的显式授权边界，不是实现缺陷。

2. **真实 Guard import、shadow parity、逐仓库 cutover 与 rollback canary**

   尚未把现有 `.superpowers/sdd/review-loop-state.json` 导入 AFL authority，未做真实 shadow、cutover、rollback。
   每一步都应单独确认，并保留切换前快照与可回滚证据。

3. **真实 HOME 安装与重新启用 prompt hook**

   用户此前为避免主会话受影响已关闭 hook。本轮只验证了临时 HOME；没有修改真实 Codex 配置、
   runtime pointer 或全局安装。重新启用前应先做隔离 canary。

4. **真实 provider / Codex Desktop canary**

   provider contract、进程隔离和 fake executable 路径已验证，但没有把真实 Codex、Claude、Gemini provider
   作为生产 reviewer 完成全链路验收，也没有在真实 Desktop 会话中启用 AFL 做可见 canary。

5. **发布与生产有效性观察**

   尚未创建 release/tag、推送发布包或声明生产接受；也没有长期观察“不满识别准确率、后台反思成功率、
   Markdown 经验复用率、误触发率、主会话延迟”等生产指标。

### 4.2 不阻塞合并的 2 项 backlog

1. `src/index.mjs` 的 doctor 显式 `CONVERGENCE_MODULES` 清单和对应 package test 没有单列
   `convergence-probe-context.mjs`。实际 0.9.0 包已经包含该文件，运行和安全不受影响；这是诊断完整性问题。

2. 持有 SQLite writer 时的 prompt fail-open 测试使用严格毫秒阈值，在高负载环境偶发超时。
   最新本机复审为 599 ms 并通过；此前隔离复跑也通过。当前没有生产失败证据，应单独做性能/测试稳定性调查，
   不应重开 Guard/Probe 架构。

## 5. 尚未合入 main 的分支与工作树

### 5.1 唯一权威交付分支

| 分支 | HEAD | 相对 `main` | 处理建议 |
|---|---|---|---|
| `codex/convergence-kernel` | 当前交接 HEAD（实现基线 `dfa6db7`） | 尚未合入；当前可 fast-forward，但会带入累计 229 个提交 | 唯一需要合入 `main` 的分支 |

这 229 个提交包含此前 `isolate-feedback-control-plane` 的完整演进、本次 Convergence Kernel 和本交接文档，
不是只有最后几个 Guard commit。合并前应以本交接文档和最终 review 为边界确认。

### 5.2 已被交付分支完整吸收的分支

下列分支没有 `codex/convergence-kernel` 未包含的独立代码补丁，不应逐个再 merge：

| 分支/工作树 | 关系 | 未提交内容 |
|---|---|---|
| `codex/background-review-observability` | 整个分支是交付分支 ancestor | 无工作树；分支可在主合并后再清理 |
| `codex/isolate-feedback-control-plane` | 整个分支是交付分支 ancestor | 工作树有 `progress.md` 和 task-1/2/3 report 修改 |
| `codex/task5-context-envelope` | 2 个提交均为交付分支中的 patch-equivalent | 2 个未跟踪 Task 5 报告 |
| `codex/task5-paths-package` | 1 个提交为 patch-equivalent | 1 个未跟踪 Task 5 报告 |
| `codex/task5-runner-consumption` | 1 个提交为 patch-equivalent | 1 个未跟踪 Task 5 报告 |
| `codex/task5-shared-integration` | 5 个提交均为 patch-equivalent | clean |
| `codex/task7-human-correction` | 2 个提交均为 patch-equivalent | 1 个未跟踪 Task 7 报告 |
| detached `task7-binding-baseline` | 唯一提交为 patch-equivalent，仅用于验证基线 | clean |

“patch-equivalent”表示 commit SHA 因 cherry-pick 不同，但代码变更已经存在于权威交付分支；
再次 merge 会制造重复历史或冲突。

### 5.3 当前必须保留的未提交文件

`codex/convergence-kernel` 和 `codex/isolate-feedback-control-plane` 工作树中存在：

- `.superpowers/sdd/task-1-report.md`
- `.superpowers/sdd/task-2-report.md`
- `.superpowers/sdd/task-3-report.md`

这些文件被视为用户已有改动，本轮没有覆盖、暂存或提交。合并后不要直接删除这两个工作树，
应先由用户决定保留、提交、复制还是丢弃这些报告。

本交付分支的 `.superpowers/sdd/progress.md` 是本轮实施账本，应与本交接文档一起提交。

## 6. 推荐后续顺序

1. 提交本交接文档与 `progress.md`，保持 task-1/2/3 report 不动。
2. fast-forward 合入本地 `main`，在合并后的 `main` 再跑一次 `npm test` 和 `npm pack --dry-run --json`。
3. 暂时保留含未提交报告的工作树；只清理 clean 且已吸收的子任务工作树。
4. 单独安排一个激活 change：lineage-init → import dry-run → import → shadow parity → cutover canary → rollback proof。
5. 激活 change 通过后，再决定真实 HOME 安装、hook 重启和 Desktop canary。
6. 最后才做 tag/release 和生产有效性观察。

## 7. 明确禁止的捷径

- 不得自动启用 Stop/AfterAgent hook。
- 不得把 Guard/Probe receipt 或内部控制文本重新输出到主会话。
- 不得在未初始化 lineage 时隐式创建 authority。
- 不得跳过 shadow parity 直接 cutover。
- 不得把 Probe advice 当作 hard decision 或 grant authority。
- 不得为了两个 backlog 再开启无边界的全范围补丁循环。
- 不得在未处理用户报告文件前删除对应工作树。

## 8. 关键参考

- `docs/superpowers/plans/2026-07-21-convergence-kernel-guard-integration.md`
- `docs/superpowers/plans/2026-07-22-convergence-authority-and-probe-recovery-implementation.md`
- `docs/superpowers/specs/2026-07-21-convergence-kernel-guard-integration-design.md`
- `docs/superpowers/specs/2026-07-22-repository-guard-authority-lifecycle-recovery-design.md`
- `docs/superpowers/specs/2026-07-22-convergence-probe-evidence-envelope-recovery-design.md`
- `.superpowers/sdd/convergence-final-branch-review.md`
- `.superpowers/sdd/task-6-frozen-final-review.md`
- `.superpowers/sdd/task-9-readonly-provider-local-fix-rereview.md`
- `.superpowers/sdd/progress.md`
