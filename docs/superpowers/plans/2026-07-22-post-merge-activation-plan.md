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

- [ ] 在 `main` 工作树执行 `lineage-init`
- [ ] Guard import dry-run,确认只读、无副作用
- [ ] 记录 dry-run 输出作为 Step B 的输入证据

### Step B:Guard import → shadow parity → cutover canary → rollback proof

现状(已核实):`review-loop-state.json` 仅存在于 `convergence-kernel` 和 `background-review-observability` 两个工作树(未提交),主工作树没有。

- [ ] 确定权威 legacy state 来源(两个工作树中哪份是真),快照留存
- [ ] 真实 import,前后对比
- [ ] shadow parity:legacy 与 AFL authority 并行观察,输出一致才继续
- [ ] 单仓库 cutover canary,保留切换前快照
- [ ] 演练 rollback 并留证
- 禁止:跳过 shadow parity 直接 cutover

### Step C:真实 HOME 安装与 prompt hook 重启

现状(已核实,注意有两处遗留):

1. `~/.agent-feedback-loop/` 是旧版布局(`events.jsonl`、`global-trigger-archive.md` 等);
2. `~/.agent/feedback-loop/hooks/` 下仍有旧版 `core-hook.sh`;
3. `~/.codex/config.toml` 中 `# agent-feedback-loop:start/end` 标记块仍指向旧路径,且包含 0.9.0 已删除的 **Stop hook** 和 `statusMessage`(0.9.0 明确禁止 Stop/AfterAgent 控制 hook 与状态输出)。

- [ ] 先做隔离 canary(临时 HOME)验证 0.9.0 安装/卸载往返
- [ ] 用 0.9.0 `install` 重写真实 HOME:清掉旧 Stop hook 块、旧路径指向,必要时走 `legacy-export` 迁移旧数据
- [ ] 重启 prompt hook 后在真实会话观察:主会话不得出现 Guard/Probe/receipt 文本
- 禁止:自动启用 Stop/AfterAgent hook

### Step D:真实 provider / Codex Desktop canary

- [ ] 以真实 Codex/Claude/Gemini CLI 作为 reviewer 跑一次完整后台反思链路
- [ ] Desktop 会话启用 AFL 做可见 canary,确认延迟与静默性
- [ ] 记录不满识别、reviewer job、lesson 发布、后续投递各环节证据

### Step E:发布与生产有效性观察

- [ ] push `main` 到 origin(当前本地领先 origin/main 232+ 提交,推送前需用户确认)
- [ ] 创建 0.9.0 tag/release
- [ ] 生产指标观察:不满识别准确率、后台反思成功率、Markdown 经验复用率、误触发率、主会话延迟

### Step F:流程与工作区收尾

- [ ] Comet change `isolate-feedback-control-plane` 仍处 `phase: build`、`verify_result: pending`:走 `/comet-verify` → `/comet-archive` 正式闭环(或由用户决定直接归档处理)
- [ ] 用户裁决 4 个保留工作树中的未提交报告(task-1/2/3 report 修改、task5/task7 未跟踪报告):提交、复制或丢弃;处理完后再删工作树
- [ ] 清理已吸收的本地分支(`codex/task5-*`、`codex/task7-*`、`codex/isolate-feedback-control-plane`、`codex/background-review-observability`、`codex/convergence-kernel`、`codex/backlog-closeout`)

## 3. 红线(继承交接文档 §7)

- 不得自动启用 Stop/AfterAgent hook
- 不得把 Guard/Probe receipt 或内部控制文本输出到主会话
- 不得在未初始化 lineage 时隐式创建 authority
- 不得跳过 shadow parity 直接 cutover
- 不得把 Probe advice 当作 hard decision 或 grant authority
- 不得在未处理用户报告文件前删除对应工作树
