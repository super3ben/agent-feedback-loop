# Task 1 canonical capture identity 架构修复报告

## 状态

`DONE_WITH_CONCERNS`

Task 1 的最后一项 canonical capture identity 审查 blocker 已按授权范围修复并提交。
唯一 concern 是本轮只执行一次的完整 `npm test` 为 253/254：既有 Stop 进程树硬截止
fixture 在全套负载下未创建首个 Codex signal 文件；同一测试隔离精确复跑通过 1/1。
该路径不在本轮 diff 中，且本轮没有修改或实现 reviewer job、launcher、selector、hook
删除、schema/version、installer、CLI 或真实 runtime。

## 提交

- 提交：`535704d`（`fix: canonicalize control capture identity`）
- 分支：`codex/isolate-feedback-control-plane`

提交只包含：

- `src/capture.mjs`
- `src/control-store.mjs`
- `test/control-store.test.mjs`

本报告是协调文件，完整覆盖了此前陈旧内容，未加入实现提交。

## 架构说明

`src/control-store.mjs` 现在只有一个 body-free canonical normalizer：
`normalizeCaptureIdentity()`。它产生并冻结以下唯一 tuple，顺序与 Task 1 brief 完全一致：

```text
(event_uid, source_provider, session_uid, context_epoch, source_namespace,
 source_id, source_event_id, source_offset, capture_source, native_turn_id,
 source_timestamp, role, referent_event_uid, content_hash, completeness)
```

架构收敛点：

- 公共 `captureObservedSession()` 在任何 blob/数据库操作前先得到完整 canonical identity，
  再将这份完整表示交给 observation resolution；不再手工拼接不完整 equality tuple。
- 直接 `captureSessionEvent()` 与 `resolveEventObservation()` 复用同一 normalizer；
  event/observation adapter 只添加存储所需的 key、UID、project 和 blob ref 元数据。
- 唯一 `captureIdentitySignature()` 只按上述 15 个字段生成 SHA-256；首次持久化、公共
  replay、直接 replay 和 observation replay 都比较这个同一签名。
- `sameEvent()` 被删除。direct duplicate 必须同时满足：event UID/source identity 指向同一
  event、observation key 仍绑定该 event、完整 canonical signature 相等、持久化
  `capture_source` 相等；`encrypted_raw_ref` 作为独立不可变存储不变量另行比较。
- `event.capture_source` 与 `input.captureSource` 统一成一个最大 256 字符的字段；二者冲突、
  空值或越界均 fail closed。只有二者都缺失时才派生
  `${provider}:${sourceNamespace}`，不截断。
- 所有 optional tuple 字段统一为 `null`；`source_offset` 只允许 `null` 或非负 safe integer。
  无 context 的 alias 首次落库时可用候选 epoch 形成物理 observation key，但签名仍保留
  调用者的 canonical `context_epoch=null`，因此 exact replay 保持等价。
- 不同 hook/transcript observation key 可以关联同一 event；每条 observation 保存自己的
  完整 canonical signature。候选选择不再用 `capture_source` 阻止合法的不同 key alias。
- raw text、raw body bytes 和 `encrypted_raw_ref` 都不进入 identity/signature。公共与直接
  路径即使使用不同 blob ref，也对相同 metadata 保存相同签名。
- schema、schema version 与表结构完全未改。

## RED 证据

### 审查 blocker 的四组 RED

生产实现修改前运行：

```sh
node --test --test-name-pattern='public control capture treats capture source as bounded canonical identity|direct control capture replay compares the complete canonical identity|public and direct control capture persist the same normalized replay identity|invalid canonical capture identity is rejected before blob or database side effects' test/control-store.test.mjs
```

结果：0/4，四组均按预期失败。

- 公共 changed `capture_source` 没有抛 collision，而是被报告为 duplicate。
- direct changed `source_event_id`、`source_offset`、`capture_source` 没有抛 collision。
- public/direct 虽然碰巧签名相同，但两者都把显式 `prompt_hook` 错误持久化为
  `codex:prompt_hook`。
- 空、257 字符和 snake/camel 冲突的 capture source 都没有在 blob/DB 前拒绝。

### 自审发现的 optional-context RED

```sh
node --test --test-name-pattern='control observation replay preserves an omitted optional context epoch' test/control-store.test.mjs
```

结果：0/1，首次 alias 成功后，exact replay 错误抛出
`control_observation_collision`。根因是物理 key 使用候选 epoch，而 canonical tuple 正确保留
`context_epoch=null`；结构完整性检查不应直接拿物理 key 与 `null` 比较。

### systematic-debugging 中发现的既有回归

第一次运行 capture/control-store 回归为 59/60；唯一失败是非法
`capture_completeness` 在 `completeness` 已存在时未被拒绝。根因是新 normalizer 的通用
`firstDefined()` 只验证了首个 alias，弱化了旧 contract。修复为两个 completeness alias
分别验证后再按既有优先级归一化；对应既有测试隔离复跑通过 1/1。

## GREEN 证据

### blocker 精确 GREEN

上述四组 canonical identity 测试最终通过 4/4。

### optional-context 精确 GREEN

上述 optional-context 测试最终通过 1/1；物理 observation key 按持久化 epoch 校验，
canonical signature 仍按调用输入的 `null` 比较。

### capture/control-store suite

```sh
node --test test/control-store.test.mjs test/capture.test.mjs
```

最终通过 61/61。

### identity/schema 保持矩阵

```sh
node --test --test-name-pattern='runtime open rejects undeclared CHECK constraints|runtime open rejects undeclared user triggers|runtime open rejects undeclared user views|control observation exact-turn alias replay is idempotent|control observation null-turn fallback replay is idempotent|control observation alias replay rejects changed immutable input|public control capture replay rejects changed bounded event identity|public control capture treats capture source as bounded canonical identity|direct control capture replay compares the complete canonical identity|public and direct control capture persist the same normalized replay identity|invalid canonical capture identity is rejected before blob or database side effects|control observation exact-turn alias never crosses provider identity|control observation null-turn fallback never crosses provider identity|control observation explicit target rejects a different provider|control observation replay rejects an existing cross-provider target|public control capture keeps one immutable provider per session UID|concurrent exact capture replay reports one new event and one duplicate|control store captures normalized hooks, replays observations, and rejects contradictory identities' test/control-store.test.mjs
```

通过 18/18。

### Task 1 focused suites

最终源码状态下运行：

```sh
node --test test/runtime.test.mjs test/control-store.test.mjs test/store.test.mjs test/capture.test.mjs
```

通过 126/126。覆盖 runtime/control path、canonical schema、legacy store、capture、alias、
provider/session、并发与新 identity matrix。

## 完整 suite

启动前确认没有 `node .*--test` 测试进程，使用临时 HOME，且只执行一次：

```sh
HOME="$(mktemp -d /tmp/afl-task1-full.XXXXXX)" npm test
```

结果：254 项中 253 passed、1 failed，耗时 47.355s。

唯一失败：

```text
installed Stop hook kills an uncooperative process tree within a hard deadline
ENOENT: .../afl-stop-process-tree-codex-.../codex-signals.log
```

按 systematic-debugging 核验：

- 失败发生在 fixture 的首个 Codex 分支，`readFile(signalFile)` 时 signal 文件尚未创建；
  不是 identity/capture assertion。
- 本轮 `git diff --name-only` 只有三份授权文件，不包含 `templates/hooks`、`src/cli.mjs`
  或 `test/e2e-smoke.test.mjs`。
- 不再次运行 full suite；隔离精确复跑：

```sh
HOME="$(mktemp -d /tmp/afl-task1-stop-isolated.XXXXXX)" \
  node --test --test-name-pattern='installed Stop hook kills an uncooperative process tree within a hard deadline' test/e2e-smoke.test.mjs
```

通过 1/1，耗时 6.028s。当前证据把 failure 限定为旧 Stop 硬截止 fixture 在 full-suite
负载下的时序敏感性；本轮授权不允许修改该路径，因此状态保留为
`DONE_WITH_CONCERNS`，未笼统标记为“旧 Stop 抖动”。

## 语法与 diff 门禁

最终源码状态下：

```sh
node --check src/capture.mjs
node --check src/control-store.mjs
git diff --check
```

全部退出 0。

提交前 `git status --short` 只有：

```text
M src/capture.mjs
M src/control-store.mjs
M test/control-store.test.mjs
```

`git diff --cached --check` 退出 0；提交只包含这三个文件。

## 自审

- **单一 identity 真相源**：公共 adapter、direct event、observation resolution、持久化
  signature 与 replay equality 均使用 `normalizeCaptureIdentity()` 产生的同一表示；没有
  `sameEvent()` 或第二套 replay tuple。
- **exact replay/collision**：public/direct exact replay 均为 `[false, true]`；相同输入的
  持久化 signature 完全相同。改变任一已覆盖 tuple 字段得到固定
  `control_observation_collision`；无效字段在 side effect 前抛 validation error。
- **alias**：hook/transcript 不同 observation key 仍可绑定同一 event；exact-turn、null-turn、
  omitted-context 与五分钟窗口行为均有回归证据，每条 observation signature 独立保存。
- **隐私/存储**：signature 仅含 15 个 bounded metadata 字段；测试用不同 raw body/blob ref
  的 public/direct 路径得到相同 signature。direct changed blob ref 仍由独立存储不变量拒绝。
- **provider/session/concurrency**：provider-qualified selection、session provider 不可变性、
  same-provider update 和 concurrent exact replay 均在最终 focused suite 中通过。
- **schema/runtime**：没有 schema/version/DDL 变化；CHECK/trigger/VIEW、path、permission、
  non-migrating open 与 legacy store 回归全绿。
- **范围**：未修改 Task 2+ API、reviewer job、launcher、selector、hook 删除、installer、CLI、
  OpenSpec、Comet/SDD progress、真实 HOME、真实 runtime pointer 或真实 feedback DB。

## 风险信号

- **外部输入/public API**：capture source alias、长度、冲突和 source offset 现在严格验证；
  invalid identity 在 blob/SQLite side effect 前拒绝。
- **持久化 identity**：既有 schema 只能存 signature 而不存全部 tuple 列，因此正确性依赖
  canonical normalizer 与签名字段顺序保持稳定；本轮以固定字段数组和 public/direct
  signature equality 测试锁定。
- **共享状态/并发**：duplicate 判定在 `BEGIN IMMEDIATE` 内同时读取 event 与 observation
  binding；concurrent exact replay 保持一 new、一 duplicate。
- **兼容性**：公共 adapter 仍给 transitional legacy store 提供 camelCase alias，但这些值
  全部从 canonical representation 机械投影，不重建 equality。legacy capture tests 全绿。
- **全套测试 concern**：唯一 full-suite Stop hard-deadline fixture 负载敏感失败；隔离通过，
  且与本轮 diff 无路径重叠。它仍应在后续负责旧 Stop 删除/收敛的任务中处理或移除。
