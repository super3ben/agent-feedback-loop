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

## Atomic public capture amendment

### 变更摘要

- 新增 synchronous `prepareCapture({ event, rawText })`：一次性规范化并递归冻结 caller-independent、
  body-free 15-field identity，独立保存 `blobContentHash` 与 caller supplied encrypted ref，不保留
  `rawText` 或 caller event 引用。
- 新增 `store.resolveOrInsertCapture({ preparedCapture, authoritativeEncryptedRef })`：在单个
  `BEGIN IMMEDIATE` 内依序完成 exact replay、UID/source conflict、session provider check、完整
  alias recheck、alias attach 或 new insert，并统一投影 frozen `eventView`/`observation`。
- control public `captureSession()` 与 `captureObservedSession()` 都在第一次 `await` 前 prepare，
  第一次/第二次 content-addressed blob write 分别保留在 transaction 前/commit 后；control path
  不再调用 transaction-external `resolveEventObservation()`，不修改或返回 caller-owned event。
- direct `captureSessionEvent()` 复用同一 atomic decision；direct `resolveEventObservation()` 对账
  snake/camel encrypted ref，null ref 采用 persisted ref。未修改 schema/version、crypto store、
  installer、CLI、service/scheduler/Stop/notification/Markdown ownership。
- 已批准的 fixture-only 修订：旧 timestamp-window seed 改为每个 seed 使用不同 non-null ref，
  继续真实构造 31 个窗口外 event + 2 个窗口内 candidates；非 ref 专项的旧 public 首次 capture
  显式使用 `encrypted_raw_ref: null`。新增 Step 6-13 的指定值和断言目的未改。

### RED 证据

1. Prepared capture / invalid zero-side-effect：

   ```sh
   node --test --test-name-pattern='prepared capture freezes the body-free identity|invalid canonical capture identity is rejected before blob or database side effects' test/control-store.test.mjs
   ```

   结果 1 passed / 1 failed；prepared test 以
   `TypeError: controlStoreModule.prepareCapture is not a function` 失败，invalid matrix 通过且保持
   0 blob/DB writes。

2. Supplied ref / public-direct result consistency：

   ```sh
   node --test --test-name-pattern='public capture rejects a supplied encrypted ref mismatch|public and direct exact replay return one persisted event and blob ref' test/control-store.test.mjs
   ```

   结果 0 passed / 2 failed；mismatch 为 `Missing expected rejection`，consistency 在读取缺失的
   `eventView.encrypted_raw_ref` 时失败。

3. Caller mutation barrier：

   ```sh
   node --test --test-name-pattern='public capture uses one frozen snapshot across the blob await' test/control-store.test.mjs
   ```

   结果 0 passed / 1 failed；第一次 blob write 后 mutation 被重新读取，以
   `capture_source must be a bounded non-empty string` 失败。

4. Different-alias transaction / incompatible storage：

   ```sh
   node --test --test-name-pattern='concurrent different first aliases resolve to one event and two observations|public capture inserts a new event for an alias with incompatible encrypted storage' test/control-store.test.mjs
   ```

   结果 0 passed / 2 failed；两项都先在缺失统一 `kind` contract 处失败（actual `undefined`）。

5. 自审补充 direct/ref、control `captureSession` 与 null timestamp replay：

   - `direct observation resolution enforces and adopts the persisted encrypted ref`：RED 为
     `Missing expected exception`；GREEN 1/1。
   - `control captureSession returns the frozen atomic event view`：RED 证明旧 branch 把 writer ref
     写回 caller event（expected null，actual writer ref）；GREEN 1/1。
   - `public exact replay preserves an alias with a null observation timestamp`：RED 为固定
     `control_observation_collision`；改为用 persisted `observed_at`/event `created_at` 执行同一
     五分钟 binding 后 GREEN 1/1。

### GREEN 与回归证据

- Step 18 amendment exact command：7/7 passed，134.762ms（最终源码状态）。
- Step 19 exact/provider/session/context/schema/concurrency exact command：12/12 passed，
  166.253ms（最终源码状态）。
- Step 20：

  ```sh
  node --test test/control-store.test.mjs test/runtime.test.mjs test/capture.test.mjs test/store.test.mjs
  ```

  最终 134/134 passed，1.670s。transitional legacy store/capture 仍绿。

### Full suite

- 第一次 disposable-HOME `npm test`：261/261 passed，23.201s；该次之后自审又修复了 direct ref
  adopt、control `captureSession` caller-event result 与 null timestamp exact replay，因此该次不作为
  最终 commit 证据，也未触发 Stop isolated rerun。
- 最终提交候选的权威 disposable-HOME `npm test`：262/262 passed，22.320s；0 failed、0 skipped，
  legacy Stop hard-deadline test 直接通过，未执行 isolated rerun。临时 HOME 均已删除；未访问真实
  HOME/runtime pointer/feedback DB，未启用 hooks。

### Static / diff / scope checks

- `node --check src/capture.mjs`、`node --check src/control-store.mjs`、`git diff --check`：全部 exit 0，
  无输出。
- pre-commit `git diff --name-only` 仅为 `src/capture.mjs`、`src/control-store.mjs`、
  `test/control-store.test.mjs`；对 `src/control-schema.mjs src/crypto-store.mjs src/index.mjs
  src/cli.mjs` 的 diff 为空。
- 一次额外的过粗 `sed | rg resolveEventObservation` exploratory check 曾 exit 1，因为它把
  `resolveOrInsertCapture` guard 之后的 legacy compatibility branch 也匹配进来；逐行结构核验显示
  control branch 在进入 legacy resolve 前直接 return，required static/scope checks 随后全部通过。
- commit 仅包含允许的 3 个文件；未勾选 Task 1，未修改 plan/OpenSpec/progress/ledger。

### Commit 与变更文件

- Commit: `da19db100c9b4c52abe0a19c712b4d691267aed4`
- Message: `fix: make public capture resolution atomic`
- Files: `src/capture.mjs`, `src/control-store.mjs`, `test/control-store.test.mjs`
- Stat: 653 insertions, 111 deletions；diff > 200 风险信号命中，主要来自完整 regression fixtures/tests
  与把原 capture insert path 收敛到统一 atomic projector。

### Self-review

- Frozen boundary：validation、identity/signature/key/ref/project metadata snapshot 全部发生在第一次
  await/blob/SQLite/log side effect 前；caller mutation test 证明 await 后不重读 caller event。
- Storage boundary：blob I/O 均在 SQLite transaction 外；supplied ref mismatch 为 1 blob / 0 DB，
  store failure 不执行 second write，成功 commit 后执行 second write；没有主动删除 first blob。
- Atomicity：exact replay、UID/source conflicts、provider check、完整 five-minute alias query/fallback、
  alias attach/new insert 均由同一个 `transaction()`/`BEGIN IMMEDIATE` 包围；不同首次 aliases 为
  1 event/2 observations、一个 new/一个 alias。
- Result consistency：`eventUid`、`blobPath`、frozen `eventView`、frozen `observation` 全部从同一
  persisted/inserted rows 投影；compatibility `event` 只指向 `eventView`。
- Direct compatibility：capture wrapper 复用 prepared/atomic helper；legacy observation direct API
  保留 exact/explicit/unique/null/ambiguous 行为并补齐 independent ref invariant。
- Scope/privacy：identity signature 仍只含原 15 fields，raw/body/blob hash/ref 不进入 signature；
  schema/version/table set、Markdown/SQLite ownership、crypto store 和 legacy modules 未变。

### Concerns 与风险信号

- Concerns: 无阻断 concern；最终候选 full suite 直接全绿。Task 1 仍需新的独立 review gate，且本轮
  按要求不勾选 Task 1。
- 跨模块：**YES**（capture adapter + control store + tests）。
- 安全/SQL：**YES**（bounded encrypted ref、SQLite transaction/query/result binding）。
- 并发/锁：**YES**（`BEGIN IMMEDIATE`、different-alias/exact concurrency）。
- Schema migration：**NO**。
- 公共 API：**YES**（prepared capture、atomic resolution、统一 capture result）。
- diff > 200：**YES**。
- DONE_WITH_CONCERNS：**NO**。

## Public writer ref review-9 fix

### Reviewer finding technical verification

review-9 的 deterministic probe 与当前源码一致：公共
`capturePreparedControlSession()` 的第一次 `blobs.write()` 返回值此前只参与 caller-supplied
non-null ref 的 equality 比较；当两者均为 `null` 时，公共 adapter 会调用
`resolveOrInsertCapture()`。后者为 retained direct `captureSessionEvent()` 兼容而允许 null，因而公共
capture 可以持久化 `encrypted_raw_ref = NULL`。这不是 direct nullable 语义的问题，而是 public
adapter 没有在 authoritative writer-ref 边界执行其 bounded-string contract。

本修复在第一次 write 返回后、supplied-ref mismatch 与
`store.resolveOrInsertCapture()` 之前，以既有 `authoritativeEncryptedRef must be a bounded non-empty
string` TypeError 模式拒绝非 string、`null`、`undefined`、空 string 和长度超过 4096 的 string。
direct `captureSessionEvent()` 路径和其 nullable ref 兼容语义未改变。

### RED evidence

先仅运行新增 deterministic regression：

```sh
node --test --test-name-pattern='public control capture rejects invalid blob writer refs before store resolution' test/control-store.test.mjs
```

RED 为 0/1：`null` writer ref 已越过 adapter 并调用测试替换的
`store.resolveOrInsertCapture()`，准确失败为：

```text
Error: public writer ref reached the control store
```

该矩阵为 `null`、`undefined`、empty、non-string、overlong 五个 case 各建一个新的 disposable
fixture；每个 case 都要求第一次 write 恰好一次、reject、0 resolver calls、0 sessions、0
session_events、0 event_observations，因此也证明没有第二次 blob write。

### GREEN and coverage evidence

同一 focused 命令在最小 adapter fix 后 GREEN：1/1 passed，0 failed。

```sh
node --test test/control-store.test.mjs test/runtime.test.mjs test/capture.test.mjs test/store.test.mjs
```

GREEN：135/135 passed，0 failed，约 1.500s。该套件保留了 caller-supplied non-null mismatch、public
atomic capture、direct nullable compatibility、alias/concurrency 及 transitional legacy regression。

### Static, scope and commit

- `node --check src/capture.mjs`：exit 0。
- `git diff --check`：exit 0。
- staged commit scope 仅为 `src/capture.mjs`、`test/control-store.test.mjs`；
  `src/control-store.mjs`、schema、crypto-store、CLI、installer 均无 diff。
- Commit：`9fb6cd61881b3dea4cfdf6e9c718fa4498aabbdf`
  (`fix: reject invalid public blob writer refs`)。
- 本报告在 commit 后追加，保持 dirty 且未提交；Task 1 checkbox 未变。

### Self-review, concerns and risk signals

- 验证位于第一个 await 的返回边界，故 invalid writer ref 不可到达 SQLite decision 或第二次 write；
  non-null caller/writer mismatch 的既有 collision 判断仍在其后保持不变。
- 4096 边界与 control-store 的 authoritative ref validator 相同；没有新 error taxonomy、helper
  service 或 schema，更没有修改 direct null-ref branch。
- 风险信号：首次 content-addressed writer 在返回无效 ref 前可能已有外部副作用；现有设计同样不对
  first write 做主动删除，且此 bounded fix 不扩大为 blob lifecycle/GC 改造。数据库保持零写入、第二次
  write 不执行。
- Concerns：无阻断 concern；仍需按既有流程交由新的独立 Task 1 review gate。

## Identity coherence review-10 fix

### 状态与提交

`DONE`

- Commit：`88c2c4bf4b1a148ef7ae0122b2a9afd8cd8e908d`
- Message：`fix: unify capture alias invariants`
- 提交文件仅为 `src/control-store.mjs`、`test/control-store.test.mjs`。
- 本节在 commit 后 append，报告保持 dirty 且未进入 source commit；Task 1 checkbox、OpenSpec、plan、
  progress 和 `.comet` 均未修改。

### 共同根因与行为修复

- 用单一 `readAliasGroup()` 取代 `firstDefined()`。所有既有 source provider/session/context/source
  event/source namespace/source id/event UID/source offset/native turn/timestamp/referent/content hash/
  completeness alias 都会逐个按原类型、长度和 optional/default 规则规范化；多个 non-null 规范值
  不同即 fail closed。`capture_source` 与 encrypted raw ref 复用同一 reader，并保留原有 default、
  capture-source `TypeError` 和 encrypted-ref collision 语义；没有新增 alias。
- 将 observation-specific binding 与 target compatibility 分开。observation 的 incoming event/source
  IDs、namespace、capture source 和完整 signature 只与 observation row 对账，不要求等于 target
  event；target 只比较 provider/session/optional context/role/content/native turn/timestamp/completeness。
- public/direct 共用 `targetCompatibility()`、`sameTargetEvent()` 和唯一
  `selectCompatibleTargetCandidates()`。SQL 的 completeness predicate 位于 native-turn、timestamp、
  `ORDER BY` 和 `LIMIT 2` 之前，因此不兼容候选不能遮蔽唯一兼容候选。
- public/event capture 的 completeness 必填并与 target 严格相等；不同 completeness 走 new event，
  同一输入随后 exact replay。legacy direct observation API 的 omitted/null completeness 继续保持既有
  wildcard 兼容，显式 completeness 必须相等。direct null encrypted ref 继续采用 target ref，non-null
  ref 仍必须匹配；public ref-compatible/ambiguous 语义未改变。

### RED 证据

生产代码修改前运行：

```sh
node --test --test-name-pattern='public capture rejects conflicting aliases|direct capture uses the shared conflict-validating alias normalizer|equivalent duplicate aliases|public completeness-incompatible alias|public target-compatible alias|public alias candidate applies completeness|direct alias does not attach a completeness-incompatible target' test/control-store.test.mjs
```

结果：exit 1，22 tests 中 4 passed、18 failed。

- 13 个此前由 `firstDefined()` 处理的 conflict 子用例全部错误成功，并实际产生 2 blob writes、
  1 session、1 event、1 observation；既有 capture-source 与 encrypted-ref conflict 子用例通过。
- direct `event_uid/eventUid` 冲突错误写入 1 session/event/observation。
- differing-completeness public alias 先错误返回 alias，相同输入 replay 固定抛
  `control_observation_collision`。
- completeness-LIMIT probe 的唯一兼容候选被前两个不兼容候选遮蔽，actual `new` 而不是 `alias`。
- direct explicit completeness mismatch 缺少预期 collision；等值重复 alias 与正常 compatible alias
  在同一 RED 中保持通过，证明 fixture 没有破坏既有正向语义。

### 最终 GREEN 与真机证据

最终源码上的相同聚焦命令：22/22 passed，0 failed，exit 0。

使用 disposable HOME 执行 Task 1/legacy 四文件命令：

```sh
set -u
temp_home="$(mktemp -d "${TMPDIR:-/tmp}/afl-task1-identity-green.XXXXXX")"
printf 'TEMP_HOME=%s\n' "$temp_home"
HOME="$temp_home" node --test \
  test/control-store.test.mjs test/runtime.test.mjs test/capture.test.mjs test/store.test.mjs
```

结果：157/157 passed，0 failed，exit 0；临时 HOME 为空并已用 `rmdir` 删除。运行环境为 macOS
26.5.1、Darwin arm64、Node v26.0.0，内置 `node:sqlite` 可用。未重复 full `npm test`，符合本轮
“窄测无未知问题时不必重复全套”的授权。

最终静态/scope gate：

```sh
node --check src/control-store.mjs
node --check test/control-store.test.mjs
git diff --check
```

全部 exit 0。静态 SQL audit 证明 completeness predicate 在 line 592、唯一 candidate `LIMIT 2`
在 line 598；除预存 append-only report 外，未提交 diff 只有获准的两个文件。对
`src/capture.mjs`、schema、crypto、index/CLI、OpenSpec、plan 与 `.comet` 的 diff 均为空。

### 自审、风险信号与 concerns

- 对抗性只读审计结论为 `NO_BLOCKER`：未发现 alias/default/error 弱化、observation/target 混淆、
  LIMIT 后过滤、direct nullable ref 漂移或成功 observation 不可重放路径。
- API 输入收紧风险：以前被静默按优先级选择的 contradictory aliases 现在会在 side effect 前拒绝；
  这是 review-10 要求的 fail-closed 行为。历史上若已有 completeness-incoherent observation，replay
  将继续 fail closed，不自动迁移或改写 schema v1。
- 测试敏感度风险：generic conflict matrix 断言 reject 与零副作用，而不为每个新冲突规定统一错误
  code；规范未规定该 taxonomy，既有 capture-source/encrypted-ref 专项错误语义由原回归继续锁定。
- 风险信号：SQL/持久化 identity **YES**；public/direct API 输入行为 **YES**；schema migration **NO**；
  新并发/锁机制 **NO**；diff > 200 **YES**（主要为完整 alias 子用例和 replay/LIMIT fixtures）。
- 未触碰真实 HOME、真实 hooks、真实 runtime pointer、真实 feedback DB、notification、scheduler、
  RAG、maintenance 或后续任务。无阻断 concern；Task 1 仍等待新的独立正式 review gate，本修复不把
  Task 1 checkbox 标记完成。

## Frozen timestamp closeout

### RED evidence

在生产代码修改前，仅用 disposable HOME 运行：

```sh
node --test --test-name-pattern='timezone-less source timestamp is rejected before blob or database side effects|timezone-offset alias normalizes to UTC and exact replay succeeds' test/control-store.test.mjs
```

结果为 0/2 passed、2 failed。第一条以 `Missing expected rejection` 失败，证明无时区输入仍越过 public preflight；第二条在 alias/exact replay 后以 `actual '2026-07-20T10:10:00.000+08:00'`、`expected '2026-07-20T02:10:00.000Z'` 失败，证明 UTC 规范化缺失。

### GREEN and scope

- 在 `TZ=UTC` 与 `TZ=Asia/Shanghai` 下分别运行上述两条冻结测试，均为 2/2 passed。
- disposable HOME 下运行 `node --test test/control-store.test.mjs test/runtime.test.mjs test/capture.test.mjs test/store.test.mjs`：159/159 passed、0 failed。
- 只修改 `src/control-store.mjs` 与 `test/control-store.test.mjs`；实现仅将现有 `source_timestamp` / `sourceTimestamp` alias reader 收敛为显式时区 RFC3339 的 UTC ISO normalizer。schema、candidate SQL、null timestamp fallback、五分钟窗口、native-turn fallback、ambiguity、其他 identity/ref 语义均未变。

### Concerns and runtime boundary

- 无阻断 concern；冻结验收 review 仍由协调者按 Step 27 执行，本轮不勾选 Task 1。
- 未触碰真实 HOME、hooks、runtime pointer 或 feedback DB；所有执行均使用 disposable HOME/DB。未运行 full npm suite，因授权四文件回归未暴露未知失败。
