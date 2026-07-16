## 为什么现在必须改

Agent Feedback Loop 当前同时存在两个根本问题：一是把回执、Stop 重试和状态提示放进主模型回合，导致控制面可以替换或追加用户真正需要的业务回答；二是把普通 prompt 先累计到阈值后才启动 reviewer，第一次明确不满不能及时形成反思，下一次会话可能在教训尚未生成时重复同类错误。

继续增加通知 transport、常驻 scheduler 或数据库记忆层不能修复这两个边界，反而扩大了需要维护的状态。正确边界应是：主会话只消费已有反思文档；新的明确反馈被识别后，立即启动独立 reviewer subagent，主会话不等待、不展示其控制输出。

## 变更内容

- **破坏性变更**：默认安装彻底移除 AFL Stop hook、模型回执指令、纯回执补发、原生/系统通知投递和所有会话内 reviewer 状态提示。
- 每个不同的明确反馈候选都立即创建一个幂等 reviewer job 并启动独立、短生命周期的 detached subagent；不再等待 3 条、不做 debounce 批处理，也不需要常驻 scheduler。
- 用宿主结构信号与本地证据组合识别候选。它必须覆盖“为什么你之前没有考虑，等到我发现才开始思考”这类已完成回合的明确回顾性不满；最终是否值得沉淀仍由 reviewer 判断。
- reviewer 只在结论可复用时原子写入 `.agent/reflections/*.md`；`reviewed_no_lesson` 不创建反思文档。
- Markdown 反思文档成为长期记忆唯一事实源。SQLite 只保存短期 job、去重、租约、重试、发布指针和注入尝试，不保存长期 lesson/report/card 正文，也不参与长期检索。
- prompt hook 直接解析项目反思文档，确定性选择少量适用方法并注入。容量超限只产生 omission，不再触发 `memory_overflow_hold`。
- 只声明可证明的效果状态：文档已发布、已选中、已注入。若同一方法类别在注入后再次发生，记录为复发证据；没有复发不能被解释为已经有效。
- 首期只支持 macOS 和 Linux。历史数据库迁移采用显式、可重复、先 dry-run 的一次性导出，不自动修改真实用户数据。

## 能力范围

### 新增能力

- `control-plane-isolation`：保证 AFL 控制信息永不成为主会话输出，默认安装没有 Stop hook。
- `immediate-feedback-review`：定义明确反馈候选的本地识别、幂等建 job、立即 detached 启动和无 scheduler 恢复。
- `document-memory`：定义 reviewer 校验、Markdown 原子发布、直接读取和历史数据库一次性导出。
- `memory-selection-safety`：定义基于文档的确定性 Top-K 与 omission，不再使用全局 hold。
- `effectiveness-audit`：定义 published、selected、emitted 与复发证据的真实语义。

### 移除的旧方案能力

- `capability-aware-delivery`：不再向用户会话或操作系统投递 reviewer 通知。
- 旧 `feedback-episode-routing`：不再先聚合或等待 episode 关闭；每个不同候选立即评审。
- `memory-maintenance-lifecycle`：当前规模不引入 compactor、maintenance worker 或 scheduler；需要时直接由新反思文档表达复发与方法修订。

## 影响范围

- Runtime：prompt capture、候选识别、reviewer launcher、reviewer contract、文档发布/解析、selector、轻量控制账本和 installer。
- 删除路径：receipt/hookPrompt、Stop backstop、notification delivery、resident scheduler、memory maintenance 和数据库长期记忆选择。
- 数据：现有 `.agent/reflections/*.md` 保持可读；旧 SQLite 保留为归档，迁移必须由用户显式执行。
- 用户可见行为：主回答中不再出现 `[AFL]`、`Output this receipt verbatim...` 或 reviewer 进度；反思完成后，从下一个匹配 prompt 起才可能消费新文档。
- 验证：单元、故障恢复、fresh HOME 安装、macOS 真机、Linux 环境和真实新会话消费证据。
