> 2026-07-16 重设计说明：旧 Task 1/2/3 基于 notification delivery、Stop fail-open、episode 与 maintenance scheduler，完成状态不再代表新架构已实现。以下任务全部按新规格重新验收；不兼容代码必须删除，不能因已经提交而保留。

## 1. 冻结新边界与清理旧方向

- [x] 1.1 建立失败 fixture：纯回执/Stop 重入、5 张严重记忆卡、已完成回合明确不满未即时触发、同一 hook 重放和 detached spawn 失败。
- [x] 1.2 审计 `7d6b1e3..9c89e00` 的 schema、notification 和 Stop 变更，列出可复用的通用 primitive 与必须删除的旧架构代码。
- [x] 1.3 删除或回退 receipt、hookPrompt、Stop backstop、notification transport、feedback episode、memory maintenance 与 resident scheduler 的运行路径和 schema 依赖。

## 2. 主会话不可干扰

- [x] 2.1 编写 RED 安装/运行测试，证明默认 macOS/Linux 配置没有 AFL Stop hook，prompt 输出没有回执、reviewer 状态或维护文案。
- [x] 2.2 实现 prompt-only managed hook；capture、store、spawn、parse、select 任一失败都 bounded fail-open。
- [x] 2.3 为 synthetic AFL control text 建立统一过滤与回归测试，旧截图中的 hookPrompt 不能再成为候选或用户输出。

## 3. 明确反馈立即评审

- [x] 3.1 为结构信号、普通追问、被征求设计校准、中性 AFL 问题、已完成回合回顾性不满及中英文表达编写 detector RED fixture。
- [x] 3.2 实现纯本地多证据 detector，并证明指定“为什么之前没有考虑、等我发现才思考”样例立即成为 candidate。
- [x] 3.3 实现每个不同 source candidate 的稳定 identity、事务 job 创建和 hook replay 幂等；不同会话的同类反馈不能被文本去重吞掉。
- [x] 3.4 实现 macOS/Linux detached reviewer launcher，候选提交后立即 spawn/unref，主 hook 不等待 reviewer 结果。
- [x] 3.5 实现 runner claim、fenced lease、bounded context、retry/no-lesson/publish 终态，以及后续 prompt 的小批量 opportunistic recovery。

## 4. Markdown 反思发布

- [x] 4.1 定义 reviewer 结构化输出与 validator RED test，覆盖责任、事实、根因、方法类别、family id、方法变化和复发证据。
- [x] 4.2 实现沿用现有报告形式的 Markdown renderer 与 temp+fsync+rename 原子发布；no-lesson 不得创建文件。
- [x] 4.3 实现 canonical/legacy 文档 parser，完整旧文档可参与选择，不完整文档只能产生安全 omission。
- [x] 4.4 缩减 SQLite 为短期控制账本，证明长期正文只从 `.agent/reflections/*.md` 读取。
- [x] 4.5 实现历史 DB 的显式 dry-run/idempotent export，并只用临时数据库副本验证；不得迁移真实 HOME。

## 5. 文档选择与复发效果

- [x] 5.1 编写直接文档选择 RED test：项目范围、相关性、severity、同 family 复发、稳定排序、5 选 4、oversized 和 Token omission。
- [x] 5.2 实现确定性 Top-K，移除 `memory_overflow_hold`；容量和解析问题不能阻断其他文档或业务回合。
- [x] 5.3 同 family 只注入最新完整方法，recurrence 从文档计算，不能依赖长期 DB 计数。
- [x] 5.4 分开记录 published、selected、emitted；没有宿主证据时不得声明 observed/effective。
- [x] 5.5 实现 `recurrence_after_emission` 判定并测试：注入后同 family 再次被 reviewer 确认必须形成负向证据。

## 6. 安装、日志与文档

- [x] 6.1 更新 installer/doctor，显式报告 prompt hook、detached launcher、文档目录和旧 Stop 清理状态，不显示通知/scheduler 健康项。
- [x] 6.2 增加只含 opaque id、reason、计数和 duration 的结构化日志；测试禁止 raw prompt/report/method 泄漏。
- [x] 6.3 更新中英文 README、故障排查、迁移与回滚说明，明确“当前 prompt 不等待；文档发布后下一次匹配 prompt 生效”。

## 7. 验证与受控发布

- [x] 7.1 执行每项 RED→GREEN、targeted regression、全量 Node suite、fresh HOME 安装和 crash/recovery test。
- [x] 7.2 在 macOS Codex 真机验证普通任务无 AFL 控制输出、明确不满立即 detached 启动、业务回答正常结束、新文档在后续会话被选中并注入。
- [x] 7.3 在 Linux 环境验证安装、detached 生命周期、锁/租约、原子发布和 prompt-only 配置。
- [x] 7.4 对历史 DB 副本执行两次 migration dry-run/export，证明幂等且旧库未修改。
- [x] 7.5 在用户再次明确授权前，不恢复全局 hooks、不切换 managed runtime、不迁移真实数据库。
