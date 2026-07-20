---
change: isolate-feedback-control-plane
design-doc: docs/superpowers/specs/2026-07-16-isolate-feedback-control-plane-design.md
base-ref: cc14224444ef26894e407218235c37297714605c
---

# 即时 Subagent 反思与 Markdown 记忆实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 AFL 收敛为“明确反馈立即启动独立 reviewer subagent，后续主会话直接读取 Markdown 反思文档”的最小闭环，并彻底移除会话回执、Stop、三条批处理、通知、常驻 scheduler、maintenance 和数据库长期记忆路径。

**Architecture:** `UserPromptSubmit` 是唯一同步入口：有界读取当前用户文本与直接 assistant referent、本地检测反馈候选、事务创建短期 job、提交后同步发起 detached spawn，并按 hook 开始时刻的 publication cutoff 直接选择 `.agent/reflections/*.md` 中已有方法；主会话不等待 reviewer。短生命周期 runner 通过 fenced lease 调用隔离 provider，controller 校验结果后原子发布 Markdown；SQLite 使用独立轻量 control DB，只保存短期证据、job 和 selected/emitted 索引，旧 DB 仅由显式只读导出命令访问。

**Tech Stack:** Node.js `>=24.15.0` ESM、`node:sqlite`、`node:test`、POSIX shell prompt hook、macOS/Linux detached process、Markdown 文件、OpenSpec/Comet。

## Global Constraints

- 第一个不同的明确反馈候选落账后立即 detached spawn；不得等待 3 条、debounce、episode close 或 scheduler tick。
- 每次 hook 在 spawn 前固定 `selectionPublishedBefore`；本次 hook 开始后才发布的文档必须等到后续匹配 prompt 才能被选择。
- 主会话不等待 reviewer；默认安装没有 AFL Stop hook、receipt、hookPrompt、notification transport 或 reviewer 状态输出。
- `.agent/reflections/*.md` 是长期记忆唯一事实源；SQLite 只保存短期 job、去重、租约、重试、发布指针和 selected/emitted attempt，不存取长期正文。
- 当前不实现 RAG、resident scheduler、maintenance worker 或 compactor；恢复只由后续 prompt 做上限为 1 的 opportunistic recovery。
- `memory_overflow_hold` 必须删除；数量、尺寸或 Token 容量只产生确定性 omission，不能阻断业务回合。
- 效果语义只允许 `published`、`selected`、`emitted`、`recurrence_after_emission` 和 `unknown`；没有额外宿主证据时不得宣称 `observed` 或 `effective`。
- 只支持 macOS 和 Linux；其他平台返回显式 `unsupported_platform` 并保持业务回合 fail-open。
- 结构化日志禁止 raw prompt、assistant output、report 或 method 正文，只记录 opaque id、reason code、计数、预算、attempt/lease 和 duration。
- 不得修改真实 `~/.codex/config.toml`、`~/.agent/feedback-loop/current.json`、真实反馈数据库或已关闭的全局 hooks；自动化和真机验证只使用临时 HOME/数据库副本，真实安装仍需后续用户授权。
- 必须审计并删除当前分支 `7d6b1e3..9c89e00` 中与新设计不兼容的 notification、Stop、episode、maintenance 和 scheduler 代码；不能因代码已经提交而保留 dormant path。
- 每个实现任务都必须先加载并遵循 `superpowers:test-driven-development`：先观察正确 RED，再写最小 GREEN，运行定向回归后才允许 commit。

## Review Circuit Breaker and Frozen Acceptance Policy

- 同一功能累计经历 3 轮修复或正式复审后，不得自动开启下一轮补丁。必须先完成一次架构复盘，分别判断：原始用户价值是否实现；缺陷属于职责混乱、规格不清、实现错误、测试过拟合还是 reviewer 扩围；是否存在真实受支持输入或生产证据；继续修补、简化、删除或延期哪个成本最低；是否已经过度设计或过度优化。
- 只有主会话干扰、数据损坏或不可恢复、安全/隐私问题、或者冻结的核心验收条件失败，才能继续阻塞当前任务。仅存在于未声明输入、缺少真实生产者证据的理论反例默认进入 backlog，不触发下一轮修复。
- 超过熔断阈值后的 reviewer 只能检查持久化的冻结验收清单和对应回归，不得重新做开放式全范围缺陷搜索。新的相邻 finding 除非达到上述阻塞等级，否则记录到 backlog 并放行当前任务。
- Review Loop Guard 从 Task 7 当前冻结复审结果及后续任务生效；Task 1 不重开，Task 2–6 不回填历史 review/receipt 事件。每次 task review 使用稳定 `Review-Run-ID`，每个 Critical/Important finding 使用稳定 `Invariant-ID` 与 `Boundary`；同一 finding 改名用 `add-alias`，同 task/boundary 的真实独立 finding 用带理由的 `declare-distinct`。
- `.superpowers/sdd/review-loop-state.json` 是 Guard 唯一持久状态源。任何 Critical/Important 修复派发前必须依次成功执行 `record-review`、`authorize-fix`、把 JSON receipt 持久化到仓库内，并由 `task-brief --mode fix --guard-receipt` 消费；不得手写 fix brief、换 ID、重置计数或绕过门禁。
- Guard exit 3 触发架构 checkpoint 且只允许一次 `architecture_fix`；exit 4 必须等待人工决定；exit 5/6 必须先诊断状态、身份、checkpoint 或 receipt。上述状态均阻断自动修复，但不扩大冻结验收范围。
- Task 1 架构复盘结论：原始“明确不满立即启动后台 subagent，发布 Markdown，并在后续会话生效”的用户价值尚未实现，因为 Task 2–6 尚未开始；SQLite/Markdown/后台 subagent 的基础边界仍然成立，但 `control-store` 同时承担 legacy alias、canonical identity、去重、attachment、replay 和时间解析，兼容层职责已经过载，11 轮 review 也证明原 gate 缺少停止条件。
- Task 1 的 review-11 时间戳反例来自当前未声明、无真实生产者证据的无时区输入；仓库内当前 capture/reconcile 生产者与 Task 1 fixture 均使用带时区 ISO。成本最低的收口是只在入口把带时区 RFC3339 规范化为 UTC ISO，并补两条回归；不新增 schema、epoch 字段、服务、解析框架或大规模设计文档。
- Task 1 冻结验收清单仅包含：独立 control DB/legacy 隔离和 schema v1 不变；公共 capture 在副作用前冻结并验证 body-free canonical identity；blob I/O 位于 SQLite 事务外且 writer ref fail closed；exact/alias/new 与 replay/ref/completeness 既有回归通过；无时区时间戳在 blob/SQLite 前拒绝；受支持的带时区 alias 规范化为 UTC 后可原样 replay；真实 HOME/hooks/runtime/database 未触碰。最终 Task 1 review 只按此清单和既有回归作 pass/fail。

## Baseline Evidence Before Implementation

- `npm test` on base `cc14224444ef26894e407218235c37297714605c` ran 216 tests in 57.58s: 215 passed and the legacy `installed Stop hook kills an uncooperative process tree within a hard deadline` timing assertion failed.
- An immediate isolated rerun of that exact legacy Stop test passed 1/1 in 6.59s, so record it as a pre-existing timing-flaky obsolete-path test, not as a green baseline and not as permission to ignore unrelated failures.
- Task 3 deletes that Stop path/test under the approved design. Before Task 3, only this exact known test may be classified as baseline noise; every other failure must be investigated before proceeding.

## File Responsibility Map

- `src/control-schema.mjs`：轻量 control DB schema；新鲜数据库不得创建 lesson/report/receipt/notification/episode/maintenance 表。
- `src/control-store.mjs`：capture、candidate job、fenced lease、publication pointer 和 selected/emitted 控制 API；不暴露长期正文 API。
- `src/capture.mjs`：宿主 payload 规范化、transcript referent 读取与凭据脱敏。
- `src/feedback-signal.mjs`：纯本地候选分类器，只输出 candidate/reason codes，不决定 lesson。
- `src/reviewer-launcher.mjs`：macOS/Linux detached spawn、launch reservation 和有界 recovery。
- `src/reviewer-runner.mjs`：claim job、准备 bounded context、调用 provider、校验结果、提交 no-lesson/published 终态。
- `src/reflection-document.mjs`：canonical/legacy Markdown parse、validate、render 和原子 publish。
- `src/selector.mjs`：直接扫描项目 reflection 文档，确定性 family 投影、Top-K 和 omission。
- `src/legacy-export.mjs`：显式只读打开旧 SQLite，dry-run/idempotent 导出 Markdown；正常 runtime 不 import。
- `src/cli.mjs`：prompt-only orchestration、reviewer-run 和 legacy-export 命令；不包含 Stop/receipt/reconcile daemon。
- `src/index.mjs`：prompt-only install/uninstall/doctor、独立 `control.sqlite3` 与 legacy DB path。
- `templates/hooks/core-hook.sh`：唯一 hook wrapper；只执行 prompt command 并 fail-open。
- `templates/prompts/reflection-agent.md` 与 `templates/schemas/reviewer-result.schema.json`：新 reviewer 机器契约。
- `test/*.test.mjs`：按模块验证；真实 HOME 永远不作为 fixture。

---

### Task 1: 并行建立轻量 control DB，不破坏旧 runtime

> **当前 review 状态与最终收口边界：** 历史 Step 1-22 及后续 identity 修复已完成，但 Task 1 在 11 轮 review 后触发全局三轮熔断。最终 implementer 只执行新增 Step 23-27：对受支持的带时区 RFC3339 做一次 UTC ISO 规范化，补两条冻结回归，然后交给一次冻结清单 review。不得重做 schema、路径、安装器、SQL 架构或扩展输入格式；非 Critical 相邻发现进入 backlog。review 通过后由协调者勾选 Task 1 并立即进入 Task 2。

- [x] **Task 1 complete: 并行建立轻量 control DB，不破坏旧 runtime**

**Files（历史 Step 1-5，已实施，本轮不修改）：**
- Modify: `src/index.mjs:73-119`
- Create: `src/control-schema.mjs`
- Create: `docs/verification/2026-07-16-legacy-control-plane-audit.md`
- Modify: `test/runtime.test.mjs`

**Files（本轮 Step 6-22 唯一可能修改的文件）：**
- Modify: `src/capture.mjs:350-405`
- Modify: `src/control-store.mjs:23-488`
- Modify: `test/control-store.test.mjs:704-1390`

**Files（最终 Step 23-27 唯一允许修改）：**
- Modify: `src/control-store.mjs`
- Modify: `test/control-store.test.mjs`

现有 `EncryptedBlobStore.write(contentHash, rawText) -> Promise<string>` 已满足 content-addressed 第一次写入与 post-commit second-write；本轮不得修改 `src/crypto-store.mjs`。原有 v1 表、列、索引和 fingerprint 已足够表达原子决策；本轮不得修改 `src/control-schema.mjs`、schema version、CLI、installer、service、scheduler、RAG、Stop、notification 或 Markdown/SQLite ownership boundary。

**Interfaces:**
- Produces: `pathsFor(home).controlDatabase = <dataRoot>/store/control.sqlite3`
- Produces: `pathsFor(home).legacyDatabase = <dataRoot>/store/feedback-loop.sqlite3`
- Produces: `SCHEMA_VERSION = 1` for the new control database only
- Produces: install/upgrade-only `initializeControlStore({ paths, now })`
- Produces: hook/runner `openControlStore({ paths, now, requireSchemaVersion = 1 })` that never creates or migrates
- Produces: capture-compatible `assertCaptureAllowed(event)`, `captureSessionEvent(event)`, `resolveEventObservation(input)` and `getSessionEvent(eventUid)`
- Produces: synchronous, side-effect-free `prepareCapture({ event, rawText }) -> PreparedCapture`; `PreparedCapture` is the following recursively frozen, caller-independent value, and `rawText` itself is not retained:

```js
{
  identity: Object.freeze({
    event_uid, source_provider, session_uid, context_epoch,
    source_namespace, source_id, source_event_id, source_offset,
    capture_source, native_turn_id, source_timestamp, role,
    referent_event_uid, content_hash, completeness
  }),
  signature,                    // SHA-256 of only the ordered 15 identity values
  projectId,                    // bounded string or null
  sourceIdentity,               // derived physical source identity
  observationKey,               // provider/session/epoch/namespace/source key
  observationUid,               // SHA-256-derived observation id
  suppliedEncryptedRawRef,      // bounded caller value or null
  blobContentHash               // SHA-256 of String(rawText), separate from identity.content_hash
}
```

- Produces: synchronous `store.resolveOrInsertCapture({ preparedCapture, authoritativeEncryptedRef }) -> CaptureResolution`, where `authoritativeEncryptedRef` is a bounded string for public blob capture and may be `null` only for the retained direct wrapper. Its exact return shape is:

```js
{
  kind: "exact_replay" | "alias" | "new",
  duplicate: boolean,            // false exactly for new; true for exact_replay/alias
  eventUid: eventView.event_uid,
  blobPath: eventView.encrypted_raw_ref,
  eventView: Object.freeze({
    event_uid, session_uid, source_event_id, source_identity, role,
    referent_event_uid, content_hash, encrypted_raw_ref, completeness
  }),
  observation: Object.freeze({
    observation_uid, observation_key, observed_event_uid,
    event_uid, capture_source
  })
}
```

- Compatibility: `captureObservedSession()` and the control-store branch of `captureSession()` call `prepareCapture()` synchronously before the first `await`, reconcile the first blob writer result, call `resolveOrInsertCapture()` exactly once, then perform the existing second blob write after commit. They never call `resolveEventObservation()` as a transaction-external fast path and never mutate or return the caller-owned event; compatibility fields, if retained, are `event_uid = eventUid` and `event = eventView`.
- Compatibility: `captureSessionEvent(event)` synchronously prepares the same normalized fields and calls the same atomic decision with the event's supplied `encrypted_raw_ref` as authoritative; it may retain `event_uid = eventUid` and `event = eventView` aliases. `resolveEventObservation(input)` remains only for direct callers: exact replay and explicit target/alias attachment use the same normalization/signature/key helpers, a direct non-null `encrypted_raw_ref` must equal the persisted target ref, and a null direct ref adopts the target's persisted ref. Neither method is callable from the control public path after an async blob write.
- Consumes: existing `crypto-store.mjs` data/key roots without changing their permissions
- Transitional rule: existing `src/schema.mjs`, `src/store.mjs` and `paths.storeFile` remain unchanged until every consumer has moved; Task 13 deletes them

**Canonical capture identity clarification (user-approved review exception):**

- Public `captureObservedSession()`, direct `captureSessionEvent()`, observation resolution, persisted signatures and replay equality must all consume one shared, body-free normalized capture identity. No entry point may reconstruct a partial equality tuple of its own.
- The normalized tuple is `(event_uid, source_provider, session_uid, context_epoch, source_namespace, source_id, source_event_id, source_offset, capture_source, native_turn_id, source_timestamp, role, referent_event_uid, content_hash, completeness)`. Optional values normalize to `null`; `source_offset` is either `null` or a bounded non-negative safe integer.
- `event.capture_source` and `input.captureSource` are aliases for the same bounded field (maximum 256 characters). Normalize the supplied value once; only when it is absent derive `${provider}:${sourceNamespace}`. Reject conflicting, empty or oversized values before encrypted-blob or database side effects; never truncate them.
- An exact replay may return `duplicate=true` only when the persisted observation key targets the same event and the complete normalized tuple matches. Any changed tuple field is `control_observation_collision`. Hook/transcript aliasing may attach a different observation key to the same event, but that observation stores and replays its own complete signature.
- Raw text and encrypted body bytes never enter the identity/signature. `encrypted_raw_ref` remains a separate immutable storage invariant and must not be used to make two different normalized capture identities equal.
- Canonical `identity.content_hash` identifies the normalized/redacted event content. `blobContentHash` identifies the raw evidence bytes used by content-addressed encrypted blob storage. They may legitimately differ; neither raw body, `blobContentHash` nor `encrypted_raw_ref` enters `signature`.

- [ ] **Step 1: Write the fresh-schema RED tests**

Before editing runtime code, record `git diff --name-status 7d6b1e3^..9c89e00` and inspect the changed schema/CLI/installer/reviewer files. Write an audit table with columns `symbol/path`, `keep primitive`, `delete old architecture`, and `replacement task`. It must explicitly classify notification delivery, receipt/Stop/hookPrompt, episodes, maintenance, resident scheduler, fenced lease, encrypted blobs, provider process isolation and Markdown rendering; no unclassified changed runtime path may survive Task 13.

Add exact assertions that a fresh temporary HOME uses a separate control path, does not open a pre-created legacy file, and creates only the allowed tables:

```js
const ALLOWED_CONTROL_TABLES = [
  "event_observations",
  "reflection_emissions",
  "review_job_events",
  "reviewer_jobs",
  "schema_migrations",
  "session_events",
  "sessions",
  "store_meta"
];

assert.match(paths.controlDatabase, /store\/control\.sqlite3$/);
assert.match(paths.legacyDatabase, /store\/feedback-loop\.sqlite3$/);
assert.deepEqual(listUserTables(store.database), ALLOWED_CONTROL_TABLES);
assert.equal(readFileSync(paths.legacyDatabase, "utf8"), "legacy-sentinel");
```

Add a hook-mode fixture with a missing DB and another with schema version 0; `openControlStore` must return/throw a fixed `control_store_unavailable`/`control_schema_mismatch` error without creating or changing a file. Only `initializeControlStore` may create v1 during install or an explicit test setup.

- [ ] **Step 2: Run the tests and observe the old schema fail**

Run: `node --test --test-name-pattern='separates the lean control database|fresh control schema contains only transient tables' test/runtime.test.mjs test/control-store.test.mjs`

Expected: FAIL because `paths.controlDatabase`, `initializeControlStore()`, non-migrating `openControlStore()` and the new schema do not exist.

- [ ] **Step 3: Replace the schema with the minimal control contract**

Define the complete table set with foreign keys and no body-bearing lesson/report/card columns. Use these canonical state checks:

```js
export const SCHEMA_VERSION = 1;
export const REVIEW_JOB_STATES = Object.freeze([
  "pending", "running", "retryable", "reviewed_no_lesson", "published", "failed"
]);
export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS store_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(session_uid TEXT PRIMARY KEY, cli TEXT NOT NULL, project_id TEXT, context_epoch INTEGER NOT NULL, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS session_events(event_uid TEXT PRIMARY KEY, session_uid TEXT NOT NULL REFERENCES sessions(session_uid), source_event_id TEXT NOT NULL, source_identity TEXT NOT NULL UNIQUE, role TEXT NOT NULL, referent_event_uid TEXT, content_hash TEXT NOT NULL, encrypted_raw_ref TEXT, completeness TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS event_observations(observation_uid TEXT PRIMARY KEY, observation_key TEXT NOT NULL UNIQUE, event_uid TEXT NOT NULL REFERENCES session_events(event_uid), capture_source TEXT NOT NULL, observed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reviewer_jobs(job_id TEXT PRIMARY KEY, source_identity TEXT NOT NULL UNIQUE, source_event_uid TEXT NOT NULL REFERENCES session_events(event_uid), referent_event_uid TEXT, project_id TEXT, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, launch_epoch INTEGER NOT NULL DEFAULT 0, owner_id TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0, lease_until TEXT, next_attempt_at TEXT, next_launch_at TEXT, created_at TEXT NOT NULL, claimed_at TEXT, completed_at TEXT, result_code TEXT, error_code TEXT, published_path TEXT, published_sha256 TEXT);
CREATE TABLE IF NOT EXISTS review_job_events(id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES reviewer_jobs(job_id), event_type TEXT NOT NULL, reason_code TEXT, lease_epoch INTEGER, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reflection_emissions(id INTEGER PRIMARY KEY AUTOINCREMENT, document_path TEXT NOT NULL, document_sha256 TEXT NOT NULL, family_id TEXT NOT NULL, session_uid TEXT NOT NULL, context_epoch INTEGER NOT NULL, task_fingerprint TEXT NOT NULL, selected_at TEXT NOT NULL, emitted_at TEXT, outcome TEXT NOT NULL, reason_code TEXT, UNIQUE(document_sha256, session_uid, context_epoch, task_fingerprint));
`;
```

`initializeControlStore()` opens only `paths.controlDatabase`, creates v1 in an install/upgrade command and never imports or touches the legacy schema/file. Runtime `openControlStore()` requires an existing private regular DB with exactly the supported schema version and performs no DDL. `listUserTables()` must exclude SQLite internal names beginning with `sqlite_`. Implement the four capture-compatible methods against `sessions`, `session_events` and `event_observations`; preserve existing duplicate-observation semantics and persist only encrypted blob references plus bounded metadata, never raw text.

- [ ] **Step 4: Run focused and existing storage safety tests**

Run: `node --test test/runtime.test.mjs test/control-store.test.mjs test/store.test.mjs test/capture.test.mjs`

Expected: PASS; the new control store safety tests pass and all unchanged legacy store/capture tests remain green during migration.

- [ ] **Step 5: Commit**

```bash
git add src/index.mjs src/control-schema.mjs src/control-store.mjs docs/verification/2026-07-16-legacy-control-plane-audit.md test/runtime.test.mjs test/control-store.test.mjs
git commit -m "refactor: separate the lean reflection control store"
```

- [ ] **Step 6: Write the prepared-capture RED test and strengthen zero-side-effect invalid cases**

Add `createHash` plus `import * as controlStoreModule from "../src/control-store.mjs"` to `test/control-store.test.mjs`; keep the existing named imports for other store APIs. Then add this exact contract test so the missing export fails only this selected RED test and does not mask the later behavioral RED probes:

```js
test("prepared capture freezes the body-free identity and keeps raw blob hashing separate", () => {
  const callerEvent = event({
    event_uid: "prepared-event",
    source_identity: undefined,
    source_event_id: "prepared-source",
    source_namespace: "prompt_hook",
    observation_source_id: "prepared-observation",
    capture_source: "prompt_hook",
    encrypted_raw_ref: null,
    content_hash: "a".repeat(64)
  });
  const prepared = controlStoreModule.prepareCapture({
    event: callerEvent,
    rawText: "raw evidence with a wider payload"
  });
  callerEvent.capture_source = "caller-mutated";
  callerEvent.content_hash = "b".repeat(64);

  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.identity), true);
  assert.equal(prepared.identity.capture_source, "prompt_hook");
  assert.equal(prepared.identity.content_hash, "a".repeat(64));
  assert.equal(
    prepared.blobContentHash,
    createHash("sha256").update("raw evidence with a wider payload").digest("hex")
  );
  assert.notEqual(prepared.blobContentHash, prepared.identity.content_hash);
  assert.equal("rawText" in prepared, false);
  assert.equal("encrypted_raw_ref" in prepared.identity, false);
});
```

Replace `invalid canonical capture identity is rejected before blob or database side effects` with this complete zero-side-effect matrix:

```js
test("invalid canonical capture identity is rejected before blob or database side effects", async () => {
  for (const mutation of [
    { event_uid: "" },
    { content_hash: "" },
    { content_hash: "a".repeat(129) },
    { capture_source: "" },
    { capture_source: "x".repeat(257) },
    { capture_source: "prompt_hook", captureSource: "transcript_payload" }
  ]) {
    const { store } = controlCaptureFixture();
    let blobWrites = 0;
    const blobs = {
      async write() {
        blobWrites += 1;
        return "/private/blobs/unexpected.enc";
      }
    };
    const invalid = event({
      event_uid: "invalid-canonical-event",
      source_identity: undefined,
      source_event_id: "invalid-canonical-source",
      source_namespace: "prompt_hook",
      observation_source_id: "invalid-canonical-observation",
      encrypted_raw_ref: null,
      ...mutation
    });

    await assert.rejects(
      captureObservedSession({ store, blobs, event: invalid, rawText: "must not be written" }),
      /event_uid|content_hash|capture_source|captureSource/i
    );
    assert.equal(blobWrites, 0);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 0);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count, 0);
    store.close();
  }
});
```

- [ ] **Step 7: Run the prepared-capture RED**

Run:

```bash
node --test --test-name-pattern='prepared capture freezes the body-free identity|invalid canonical capture identity is rejected before blob or database side effects' test/control-store.test.mjs
```

Expected: FAIL with `controlStoreModule.prepareCapture is not a function`; the separately selected invalid cases still prove zero side effects and must not regress while the missing interface is RED.

- [ ] **Step 8: Write the supplied-ref and public/direct consistency RED tests**

Add a public supplied-reference mismatch test that permits the required first blob write but proves no SQLite write:

```js
test("public capture rejects a supplied encrypted ref mismatch before database resolution", async () => {
  const { store } = controlCaptureFixture();
  let blobWrites = 0;
  const blobs = {
    async write() {
      blobWrites += 1;
      return "/private/blobs/writer-authoritative.enc";
    }
  };
  const callerEvent = event({
    event_uid: "supplied-ref-mismatch",
    source_identity: undefined,
    source_event_id: "supplied-ref-source",
    source_namespace: "prompt_hook",
    observation_source_id: "supplied-ref-observation",
    encrypted_raw_ref: "/private/blobs/caller-supplied.enc"
  });

  await assert.rejects(
    captureObservedSession({ store, blobs, event: callerEvent, rawText: "reference mismatch evidence" }),
    (error) => error?.code === "control_observation_collision"
  );
  assert.equal(blobWrites, 1);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 0);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count, 0);
  store.close();
});
```

Replace the prior signature-only public/direct comparison with exact resolution assertions:

```js
test("public and direct exact replay return one persisted event and blob ref", async () => {
  const { store, blobs } = controlCaptureFixture();
  const canonical = event({
    event_uid: "consistent-replay-event",
    source_identity: undefined,
    source_event_id: "consistent-replay-source",
    source_namespace: "prompt_hook",
    observation_source_id: "consistent-replay-observation",
    source_offset: 12,
    capture_source: "prompt_hook",
    referent_event_uid: "consistent-replay-referent",
    native_turn_id: "consistent-replay-turn",
    source_timestamp: "2026-07-17T08:20:00.000Z",
    encrypted_raw_ref: null
  });
  const first = await captureObservedSession({
    store, blobs, event: { ...canonical }, rawText: "consistent raw evidence"
  });
  const publicReplay = await captureObservedSession({
    store,
    blobs,
    event: { ...canonical, encrypted_raw_ref: first.blobPath },
    rawText: "consistent raw evidence"
  });
  const directReplay = store.captureSessionEvent({
    ...canonical,
    encrypted_raw_ref: first.blobPath
  });

  for (const result of [first, publicReplay, directReplay]) {
    assert.equal(result.eventUid, canonical.event_uid);
    assert.equal(result.event_uid, canonical.event_uid);
    assert.equal(result.blobPath, first.blobPath);
    assert.equal(result.eventView.encrypted_raw_ref, first.blobPath);
    assert.equal(result.event, result.eventView);
    assert.notEqual(result.event, canonical);
  }
  assert.equal(first.kind, "new");
  assert.equal(publicReplay.kind, "exact_replay");
  assert.equal(directReplay.kind, "exact_replay");
  assert.deepEqual([first.duplicate, publicReplay.duplicate, directReplay.duplicate], [false, true, true]);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 1);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count, 1);
  store.close();
});
```

- [ ] **Step 9: Run the reference-consistency RED**

Run:

```bash
node --test --test-name-pattern='public capture rejects a supplied encrypted ref mismatch|public and direct exact replay return one persisted event and blob ref' test/control-store.test.mjs
```

Expected: FAIL because the current public replay accepts a changed supplied ref and returns caller-owned `event` plus persisted `blobPath`; current direct/public returns also lack the unified `kind`, `eventUid`, `eventView`, and `blobPath` contract.

- [ ] **Step 10: Write the caller-mutation barrier RED test**

```js
test("public capture uses one frozen snapshot across the blob await", async () => {
  const { store } = controlCaptureFixture();
  let firstWriteStartedResolve;
  let releaseFirstWriteResolve;
  const firstWriteStarted = new Promise((resolve) => { firstWriteStartedResolve = resolve; });
  const releaseFirstWrite = new Promise((resolve) => { releaseFirstWriteResolve = resolve; });
  let blobWrites = 0;
  const blobs = {
    async write() {
      blobWrites += 1;
      if (blobWrites === 1) {
        firstWriteStartedResolve();
        await releaseFirstWrite;
      }
      return "/private/blobs/frozen-snapshot.enc";
    }
  };
  const callerEvent = event({
    event_uid: "frozen-event",
    session_uid: "frozen-session",
    project_id: "frozen-project",
    source_identity: undefined,
    source_event_id: "frozen-source",
    source_namespace: "prompt_hook",
    observation_source_id: "frozen-observation",
    capture_source: "prompt_hook",
    content_hash: "a".repeat(64),
    encrypted_raw_ref: null
  });
  const pending = captureObservedSession({ store, blobs, event: callerEvent, rawText: "frozen raw evidence" });
  await firstWriteStarted;
  Object.assign(callerEvent, {
    event_uid: "mutated-event",
    project_id: "mutated-project",
    capture_source: "",
    content_hash: "b".repeat(64),
    encrypted_raw_ref: "/private/blobs/mutated.enc"
  });
  releaseFirstWriteResolve();
  const result = await pending;

  assert.equal(blobWrites, 2);
  assert.equal(result.kind, "new");
  assert.equal(result.eventUid, "frozen-event");
  assert.equal(result.blobPath, "/private/blobs/frozen-snapshot.enc");
  assert.notEqual(result.event, callerEvent);
  assert.deepEqual(store.getSessionEvent("frozen-event"), {
    event_uid: "frozen-event",
    session_uid: "frozen-session",
    source_event_id: "frozen-source",
    source_identity: '["codex","frozen-session",1,"prompt_hook","frozen-observation"]',
    role: "user",
    referent_event_uid: null,
    content_hash: "a".repeat(64),
    encrypted_raw_ref: "/private/blobs/frozen-snapshot.enc",
    completeness: "prompt_only"
  });
  assert.equal(
    store.database.prepare("SELECT project_id FROM sessions WHERE session_uid=?").get("frozen-session").project_id,
    "frozen-project"
  );
  assert.equal(store.getSessionEvent("mutated-event"), null);
  store.close();
});
```

- [ ] **Step 11: Run the mutation-barrier RED**

Run:

```bash
node --test --test-name-pattern='public capture uses one frozen snapshot across the blob await' test/control-store.test.mjs
```

Expected: FAIL on current code after the first blob write because it re-reads the now-invalid `capture_source`; the corrected path must instead succeed from the frozen values and perform the post-commit second write.

- [ ] **Step 12: Write the different-alias concurrency and incompatible-storage RED tests**

Add a helper inside each test that constructs two valid aliases with different event/source identities but the same provider, session, context, role, canonical content hash, native turn and timestamp. Then add these assertions:

```js
test("concurrent different first aliases resolve to one event and two observations", async () => {
  const { store, blobs } = controlCaptureFixture();
  let initialWrites = 0;
  let releaseInitialWrites;
  const initialWriteBarrier = new Promise((resolve) => { releaseInitialWrites = resolve; });
  const barrieredBlobs = {
    async write(...args) {
      if (initialWrites < 2) {
        initialWrites += 1;
        if (initialWrites === 2) releaseInitialWrites();
        await initialWriteBarrier;
      }
      return blobs.write(...args);
    }
  };
  const shared = {
    session_uid: "different-alias-session",
    source_identity: undefined,
    native_turn_id: "different-alias-turn",
    source_timestamp: "2026-07-17T09:00:00.000Z",
    content_hash: "d".repeat(64),
    encrypted_raw_ref: null
  };
  const hook = event({
    ...shared,
    event_uid: "different-alias-hook-event",
    source_event_id: "different-alias-hook-source",
    source_namespace: "prompt_hook",
    observation_source_id: "different-alias-hook-observation",
    capture_source: "prompt_hook"
  });
  const transcript = event({
    ...shared,
    event_uid: "different-alias-transcript-event",
    source_event_id: "different-alias-transcript-source",
    source_namespace: "transcript_message",
    observation_source_id: "different-alias-transcript-observation",
    capture_source: "transcript_payload"
  });

  const results = await Promise.all([
    captureObservedSession({ store, blobs: barrieredBlobs, event: hook, rawText: "shared raw evidence" }),
    captureObservedSession({ store, blobs: barrieredBlobs, event: transcript, rawText: "shared raw evidence" })
  ]);

  assert.equal(initialWrites, 2);
  assert.deepEqual(results.map((result) => result.kind).sort(), ["alias", "new"]);
  assert.deepEqual(results.map((result) => result.duplicate).sort(), [false, true]);
  assert.equal(new Set(results.map((result) => result.eventUid)).size, 1);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 1);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count, 2);
  assert.deepEqual(
    store.database.prepare(`SELECT observed_event_uid FROM event_observations
      ORDER BY observed_event_uid`).all().map((row) => row.observed_event_uid),
    ["different-alias-hook-event", "different-alias-transcript-event"]
  );
  store.close();
});

test("public capture inserts a new event for an alias with incompatible encrypted storage", async () => {
  const { store, blobs } = controlCaptureFixture();
  const shared = {
    session_uid: "incompatible-alias-session",
    source_identity: undefined,
    native_turn_id: "incompatible-alias-turn",
    source_timestamp: "2026-07-17T09:10:00.000Z",
    content_hash: "e".repeat(64),
    encrypted_raw_ref: null
  };
  const first = await captureObservedSession({
    store,
    blobs,
    event: event({
      ...shared,
      event_uid: "incompatible-hook-event",
      source_event_id: "incompatible-hook-source",
      source_namespace: "prompt_hook",
      observation_source_id: "incompatible-hook-observation",
      capture_source: "prompt_hook"
    }),
    rawText: "raw evidence A"
  });
  const second = await captureObservedSession({
    store,
    blobs,
    event: event({
      ...shared,
      event_uid: "incompatible-transcript-event",
      source_event_id: "incompatible-transcript-source",
      source_namespace: "transcript_message",
      observation_source_id: "incompatible-transcript-observation",
      capture_source: "transcript_payload"
    }),
    rawText: "raw evidence B"
  });

  assert.equal(first.kind, "new");
  assert.equal(second.kind, "new");
  assert.equal(second.duplicate, false);
  assert.notEqual(second.eventUid, first.eventUid);
  assert.notEqual(second.blobPath, first.blobPath);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 2);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM event_observations").get().count, 2);
  store.close();
});
```

- [ ] **Step 13: Run the alias transaction RED**

Run:

```bash
node --test --test-name-pattern='concurrent different first aliases resolve to one event and two observations|public capture inserts a new event for an alias with incompatible encrypted storage' test/control-store.test.mjs
```

Expected: FAIL because current public resolution occurs before the blob await and event insert transaction: concurrent aliases produce two `new` events, while the sequential incompatible-ref alias can attach to the old event without enforcing the separate storage invariant.

- [ ] **Step 14: Implement the minimal synchronous prepared-capture value**

In `src/control-store.mjs`, reuse `eventFields()`, `captureIdentitySignature()`, `observationKey()` and `observationUid()`; do not add a second normalizer. Implement the exported public preflight with this exact data flow:

```js
export function prepareCapture({ event, rawText }) {
  const fields = eventFields(event);                 // all validation first
  const identity = Object.freeze({ ...fields.identity });
  return Object.freeze({
    identity,
    signature: captureIdentitySignature(identity),
    projectId: fields.project_id,
    sourceIdentity: fields.source_identity,
    observationKey: fields.observation_key,
    observationUid: fields.observation_uid,
    suppliedEncryptedRawRef: fields.encrypted_raw_ref,
    blobContentHash: createHash("sha256").update(String(rawText)).digest("hex")
  });
}
```

The function must execute before any `await`, blob call, SQLite statement or log call. It creates no reference back to `event`; it freezes both object levels. Keep `identity.content_hash` and `blobContentHash` independent, and never add raw/body/ref fields to `CAPTURE_IDENTITY_FIELDS` or `captureIdentitySignature()`.

- [ ] **Step 15: Implement exact replay and UID/source conflict phases in one write transaction**

Add `store.resolveOrInsertCapture({ preparedCapture, authoritativeEncryptedRef })` and one result projector. Validate the bounded authoritative ref before opening the transaction, then execute this exact prefix inside one existing `transaction()`/`BEGIN IMMEDIATE`:

```text
SELECT observation joined to session_events WHERE observation_key = ?
IF exact observation exists:
  require observation_signature = preparedCapture.signature
  require observed_event_uid = preparedCapture.identity.event_uid
  require observation provider/session/context/namespace/source/capture_source binding
  require persisted event provider/session/context/role/content/native-turn/timestamp/completeness binding
  require persisted encrypted_raw_ref = authoritativeEncryptedRef
  otherwise throw control_observation_collision
  return result(kind = exact_replay) from persisted event and observation rows

SELECT session_events WHERE event_uid = preparedCapture.identity.event_uid
SELECT session_events WHERE source_identity = preparedCapture.sourceIdentity
IF either row exists after exact replay was not proven: throw control_observation_collision

SELECT sessions WHERE session_uid = preparedCapture.identity.session_uid
IF the persisted cli/provider differs: throw control_observation_collision
```

Do not return an observation merely because its key exists. The result projector always derives `eventUid`, `blobPath`, `eventView`, and `observation` from the same persisted/just-inserted rows; it never receives the caller event.

- [ ] **Step 16: Implement the complete alias recheck and new insert phases in that same transaction**

Continue inside the same transaction and preserve the current provider/session/context/role/content/native-turn/timestamp semantics with the full five-minute window. Re-run the candidate SQL only while holding the write transaction; do not accept a pre-transaction candidate or truncate before all predicates:

```sql
SELECT e.*
FROM session_events e
WHERE e.session_uid = ?
  AND e.source_provider = ?
  AND e.role = ?
  AND e.content_hash = ?
  AND e.context_epoch = ?
  AND COALESCE(e.native_turn_id, '') = COALESCE(?, '')
  AND julianday(COALESCE(e.source_timestamp, e.created_at))
      BETWEEN julianday(?) - (5.0 / 1440.0)
          AND julianday(?) + (5.0 / 1440.0)
ORDER BY COALESCE(e.source_timestamp, e.created_at), e.event_uid
LIMIT 2;
```

If the exact native-turn query returns zero and the incoming native turn is non-null, execute the same fully bounded query with stored `native_turn_id IS NULL`, matching the existing fallback. Then finish in this exact order:

```text
IF exactly one candidate AND candidate.encrypted_raw_ref = authoritativeEncryptedRef:
  INSERT event_observations using the incoming observation key/signature,
         observed_event_uid = incoming identity.event_uid,
         event_uid = candidate.event_uid
  return result(kind = alias) from candidate plus inserted observation
ELSE:
  INSERT/UPDATE the same-provider session metadata
  INSERT session_events with incoming UID/source identity and authoritativeEncryptedRef
  INSERT event_observations bound to the new event
  return result(kind = new) from the inserted rows
COMMIT
```

Zero candidates, more than one candidate, or one ref-incompatible candidate all take the `new` branch. Do not overwrite an existing event/ref, change schema/version, put blob I/O inside the transaction, or add a mutex/service/scheduler.

- [ ] **Step 17: Route the public adapter and direct compatibility APIs through the single decision point**

Replace the control-store branch of both public capture exports with this exact order; retain a bounded legacy-store compatibility branch only until Task 13, and never select it when `store.resolveOrInsertCapture` exists:

```js
const preparedCapture = prepareCapture({ event, rawText });       // synchronous
const writerRef = await blobs.write(preparedCapture.blobContentHash, rawText); // outside SQLite
if (preparedCapture.suppliedEncryptedRawRef !== null
    && preparedCapture.suppliedEncryptedRawRef !== writerRef) {
  throw new ControlStoreError("control_observation_collision", "control observation collision");
}
const resolution = store.resolveOrInsertCapture({
  preparedCapture,
  authoritativeEncryptedRef: writerRef
});
await blobs.write(preparedCapture.blobContentHash, rawText);       // after COMMIT
return {
  ...resolution,
  event_uid: resolution.eventUid,
  event: resolution.eventView
};
```

Delete the control-store public path's initial `resolveEventObservation()`, constraint-catch re-resolve, mutation of `event.encrypted_raw_ref`, and return of caller-owned `event`. On SQLite failure, do not perform the second write and do not delete the first content-addressed blob; retention GC owns deletion.

Implement `captureSessionEvent(event)` as a synchronous wrapper around the same internal prepared fields and `resolveOrInsertCapture()`, using supplied `encrypted_raw_ref` as authoritative and returning the same compatibility aliases. Keep `resolveEventObservation(input)` direct-only: add snake/camel encrypted-ref normalization, compare a supplied non-null ref with the persisted target, use the target persisted ref when the input ref is null, and preserve current exact/explicit-target/unique-alias/null/ambiguous return behavior. Do not call it from either control public capture export.

- [ ] **Step 18: Run the amendment GREEN tests**

Run:

```bash
node --test --test-name-pattern='prepared capture freezes the body-free identity|invalid canonical capture identity is rejected before blob or database side effects|public capture rejects a supplied encrypted ref mismatch|public and direct exact replay return one persisted event and blob ref|public capture uses one frozen snapshot across the blob await|concurrent different first aliases resolve to one event and two observations|public capture inserts a new event for an alias with incompatible encrypted storage' test/control-store.test.mjs
```

Expected: PASS; invalid input performs 0 blob/DB writes, supplied-ref mismatch performs 1 blob write and 0 DB writes, successful public captures perform 2 blob writes, and all result pointers agree with one committed event.

- [ ] **Step 19: Run exact/provider/session/context/schema concurrency regressions**

Run:

```bash
node --test --test-name-pattern='control observation replay preserves an omitted optional context epoch|control observation alias checks the complete timestamp window before bounding candidates|control observation exact-turn alias never crosses provider identity|control observation null-turn fallback never crosses provider identity|public control capture keeps one immutable provider per session UID|runtime open rejects every malformed canonical v1 schema signature|runtime open rejects undeclared generated columns|runtime open rejects noncanonical unique index collation|runtime open rejects undeclared CHECK constraints|runtime open rejects undeclared user triggers|runtime open rejects undeclared user views|concurrent exact capture replay reports one new event and one duplicate' test/control-store.test.mjs
```

Expected: PASS; provider/session/context/window behavior, non-migrating schema fingerprint checks, and exact same-key concurrency remain unchanged.

- [ ] **Step 20: Run the focused Task 1 and transitional legacy regression**

Run:

```bash
node --test test/control-store.test.mjs test/runtime.test.mjs test/capture.test.mjs test/store.test.mjs
```

Expected: PASS. The control public path is atomic; the still-transitional legacy store/capture suite remains green without changing `src/store.mjs`, and no Task 2-15 interface is changed.

- [ ] **Step 21: Run one temporary-HOME full suite and static checks**

Run the full package exactly once with a disposable HOME:

```bash
temp_home="$(mktemp -d "${TMPDIR:-/tmp}/afl-task1-transaction.XXXXXX")"
HOME="$temp_home" npm test
test_status=$?
rm -rf "$temp_home"
test "$test_status" -eq 0
```

Expected: PASS. If and only if the sole failure is the baseline `installed Stop hook kills an uncooperative process tree within a hard deadline`, run this exact isolated check:

```bash
node --test --test-name-pattern='installed Stop hook kills an uncooperative process tree within a hard deadline' test/e2e-smoke.test.mjs
```

Expected: PASS on the isolated rerun, matching the recorded pre-existing transitional Stop timing noise; any other failure blocks the commit.

Then run:

```bash
node --check src/capture.mjs
node --check src/control-store.mjs
git diff --check
```

Expected: all three commands exit 0 with no output. Confirm `git diff --name-only` contains only `src/capture.mjs`, `src/control-store.mjs`, and `test/control-store.test.mjs`; confirm `git diff -- src/control-schema.mjs src/crypto-store.mjs src/index.mjs src/cli.mjs` is empty.

- [ ] **Step 22: Commit only the transaction-boundary amendment**

```bash
git add src/capture.mjs src/control-store.mjs test/control-store.test.mjs
git commit -m "fix: make public capture resolution atomic"
```

Do not mark Task 1 complete in this plan. Record the implementation commit in the coordination artifact and dispatch a fresh Task 1 review covering all three review-8 findings as one transaction-boundary correction.

- [x] **Step 23: Write exactly two frozen timestamp regressions and observe RED**

Add only these two behavior tests to `test/control-store.test.mjs`:

1. `timezone-less source timestamp is rejected before blob or database side effects`: a public capture with `source_timestamp = "2026-07-20T02:11:00.000"` rejects synchronously before the first blob write and leaves sessions/events/observations at zero.
2. `timezone-offset alias normalizes to UTC and exact replay succeeds`: a canonical `Z` event plus a different observation alias expressed with an equivalent explicit offset returns `alias`; its stored/normalized identity is UTC ISO, and the identical alias replay returns `exact_replay` with one event/two observations.

Run only the two selected tests. The first must fail because the current bounded-string normalizer accepts timezone-less input; the second may already satisfy its replay assertion but must fail its UTC-normalization assertion. Do not add a general invalid-date matrix or widen the accepted timestamp language.

- [x] **Step 24: Implement the minimal entry normalization**

In `src/control-store.mjs`, add one small timestamp normalizer used by the existing `source_timestamp` / `sourceTimestamp` alias group. A non-null value must be a bounded RFC3339 string with explicit `Z` or `±HH:MM`; parse it once and return `new Date(epoch).toISOString()`. Timezone-less or unparsable input fails before `prepareCapture()` returns. Equivalent offset aliases compare after normalization. Keep the existing SQL, schema v1, direct null fallback, five-minute window, native-turn fallback and all other identity fields unchanged; do not add an epoch column, parsing framework, new service or second timestamp representation.

- [x] **Step 25: Run focused GREEN and the existing Task 1 regression**

Run the exact two-test pattern from Step 23, then:

```bash
node --test test/control-store.test.mjs test/runtime.test.mjs test/capture.test.mjs test/store.test.mjs
```

Expected: both frozen timestamp tests and the existing Task 1/legacy regression pass. Run the focused tests once under `TZ=UTC` and once under `TZ=Asia/Shanghai`; outcomes must be identical. Do not repeat the full npm suite unless these commands expose an unknown failure.

- [x] **Step 26: Run static/scope gates and commit**

Run `node --check src/control-store.mjs`, `node --check test/control-store.test.mjs`, and `git diff --check`. Confirm the implementation commit contains only `src/control-store.mjs` and `test/control-store.test.mjs`; preserve `.superpowers/sdd/task-1-report.md` as the uncommitted append-only handoff. Commit as `fix: normalize capture timestamps`.

- [x] **Step 27: Run one frozen Task 1 acceptance review**

The fresh reviewer checks only the global Task 1 frozen acceptance checklist, the two timestamp regressions, and the existing Task 1 regression evidence. It does not perform another open-ended whole-Task defect search. A frozen checklist failure or a Critical issue involving main-session interference, data corruption/unrecoverability, or security/privacy blocks Task 1; every other newly observed adjacent concern is recorded in backlog and does not start another review/fix round. On pass, the coordinator checks Task 1 and immediately dispatches Task 2.

### Task 2: 实现即时 candidate job 与 fenced lease 控制 API

- [x] **Task 2 complete: 实现即时 candidate job 与 fenced lease 控制 API**

**Files:**
- Modify: `src/control-store.mjs`
- Modify: `test/control-store.test.mjs`

**Interfaces:**
- Produces: `store.createReviewCandidate({ sourceEventUid, referentEventUid, sourceIdentity, projectId }) -> { jobId, created }`
- Produces: `store.reserveReviewLaunch({ jobId, cooldownMs }) -> { launch, launchEpoch, reason }`
- Produces: `store.recordReviewLaunchFailure({ jobId, launchEpoch, reasonCode }) -> { released }`
- Produces: `store.listRecoverableReviewJobs({ limit, now }) -> ReviewJob[]`
- Produces: `store.claimReviewJob({ jobId, ownerId, leaseMs }) -> { job, leaseEpoch }`
- Produces: `store.assertReviewLease(...)` and `store.renewReviewLease(...)` before publication
- Produces: `store.completeReviewNoLesson(...)`, `store.completeReviewPublished(...)`, `store.failReviewJob(...)`
- Produces: `store.getReviewContext({ jobId, priorLimit = 6, followingLimit = 2 }) -> { job, source, referent, prior, following }`
- Produces: stale owner fencing by `(job_id, owner_id, lease_epoch)`

- [x] **Step 1: Write RED tests for identity, immediate readiness and fencing**

```js
const first = store.createReviewCandidate(candidate);
const replay = store.createReviewCandidate(candidate);
assert.equal(first.created, true);
assert.equal(replay.created, false);
assert.equal(replay.jobId, first.jobId);

const laterSession = store.createReviewCandidate({ ...candidate, sourceIdentity: "codex:s2:e9:r8" });
assert.equal(laterSession.created, true);

const wake1 = store.reserveReviewLaunch({ jobId: first.jobId, cooldownMs: 5_000 });
const wake2 = store.reserveReviewLaunch({ jobId: first.jobId, cooldownMs: 5_000 });
assert.deepEqual([wake1.launch, wake2.launch], [true, false]);
assert.equal(wake1.launchEpoch, 1);
```

Add a stale lease assertion in which owner A expires, owner B claims a higher epoch, and A cannot publish.

- [x] **Step 2: Run RED**

Run: `node --test --test-name-pattern='candidate identity is replay-idempotent|different sessions are never text-deduplicated|launch reservation is bounded|stale reviewer owners cannot publish' test/control-store.test.mjs`

Expected: FAIL because the new APIs do not exist and current `submitDueReview()` still depends on queue count/cooldown semantics.

- [x] **Step 3: Implement the minimal transactional APIs**

Use one `BEGIN IMMEDIATE` transaction per state change. `createReviewCandidate` inserts the job immediately and never counts unrelated queue rows. `reserveReviewLaunch` atomically increments `launch_epoch` and advances `next_launch_at`; a synchronous spawn failure may release only the same epoch. `listRecoverableReviewJobs` returns only due pending/retryable/expired-running jobs ordered by `created_at, job_id` with `limit` hard-capped to 8.

```js
createReviewCandidate({ sourceEventUid, referentEventUid = null, sourceIdentity, projectId = null }) {
  ensureString(sourceIdentity, "sourceIdentity");
  const existing = getJobBySourceIdentity.get(sourceIdentity);
  if (existing) return { jobId: existing.job_id, created: false };
  const jobId = randomUUID();
  insertReviewJob.run(jobId, sourceIdentity, sourceEventUid, referentEventUid, projectId, nowIso(now));
  insertJobEvent.run(jobId, "candidate_created", "explicit_feedback", null, nowIso(now));
  return { jobId, created: true };
}
```

The new control store never defines `queue_events`, `submitDueReview`, `feedback_candidate_event_ids` or minEntries/maxAge batching. `getReviewContext` returns opaque event ids, encrypted blob references and bounded metadata in stable chronological order; the runner owns decryption. Use `MAX_REVIEW_ATTEMPTS = 3`, a 185-second default lease for the 180-second provider timeout, and retry delays of 30/120 seconds before the final `failed` state. Claim increments `attempt` and `lease_epoch`; `failReviewJob` may move only the current owner/epoch to `retryable` or `failed`. The temporary legacy store remains unchanged until Task 13 so intermediate commits keep the old consumer tests green.

- [x] **Step 4: Run focused regression**

Run: `node --test test/control-store.test.mjs test/store.test.mjs test/capture.test.mjs`

Expected: PASS with job/event rows bounded and no notification, lesson or report body writes.

- [x] **Step 5: Commit**

```bash
git add src/control-store.mjs test/control-store.test.mjs
git commit -m "feat: add immediate reviewer job control"
```

### Task 3: 删除 Stop、notification、reconcile 与会话控制入口

- [x] **Task 3 complete: 删除 Stop、notification、reconcile 与会话控制入口**

**Files:**
- Modify: `src/index.mjs:20-675`
- Modify: `src/cli.mjs:1-635`
- Modify: `src/codex-host.mjs`
- Modify: `templates/hooks/core-hook.sh`
- Modify: `test/runtime.test.mjs`
- Modify: `test/cli.test.mjs`
- Modify: `test/e2e-smoke.test.mjs`
- Modify: `test/codex-host.test.mjs`
- Delete: `templates/hooks/stop-hook.sh`
- Delete: `templates/hooks/trigger-rules.sh`
- Delete: `src/notification-delivery.mjs`
- Delete: `src/reconcile-scheduler.mjs`
- Delete: `src/codex-reconcile.mjs`
- Delete: `test/notification-delivery.test.mjs`
- Delete: `test/reconcile-scheduler.test.mjs`
- Delete: `test/codex-reconcile.test.mjs`

**Interfaces:**
- Consumes: `core-hook.sh -> agent-feedback-loop hook --event UserPromptSubmit --cli <host>`
- Produces: fresh/upgrade installer config with only AFL-managed prompt hooks
- Produces: Codex host inspection/trust assessment based on the prompt hook alone
- Consumes: `initializeControlStore()` during install; the prompt hook never performs DDL/migration
- Produces: doctor fields `promptHook`, `controlStore`, `reflectionDirectory`, `reviewerProvider`, `legacyStopRemoved`
- Removes: CLI `capture-stop`, `reconcile`, `reconcile-daemon`, receipt commands and notifier APIs

- [x] **Step 1: Write installer and CLI RED tests**

```js
assert.equal(codexManagedEvents(config).includes("Stop"), false);
assert.equal(claude.hooks.Stop?.some(isAflManagedHook) ?? false, false);
assert.equal(gemini.hooks.Stop?.some(isAflManagedHook) ?? false, false);
assert.equal(existsSync(paths.stopHook), false);
assert.equal("reconcileLaunchAgent" in paths, false);
assert.doesNotMatch(help.stdout, /capture-stop|reconcile-daemon|receipt/);
```

Add upgrade fixtures containing an AFL-managed Stop entry plus an unrelated user Stop entry; assert only the AFL entry is removed.

- [x] **Step 2: Run RED**

Run: `node --test --test-name-pattern='fresh install is prompt-only|upgrade removes only the managed AFL Stop hook|CLI exposes no receipt or reconcile control plane' test/runtime.test.mjs test/cli.test.mjs test/e2e-smoke.test.mjs`

Expected: FAIL because current installer still copies `stop-hook.sh`, installs a launchd scheduler and exposes receipt/reconcile commands.

- [x] **Step 3: Remove obsolete runtime modules and managed entries**

Keep each host's native prompt response schema but delete all Stop definitions and scheduler lifecycle code. The managed Codex block must contain one `UserPromptSubmit` hook only. Claude/Gemini JSON patching must filter AFL-owned Stop entries while preserving unrelated entries. Update `assessCodexHookListing()` and synchronization so configured/runnable status depends only on that prompt hook and never expects or trusts a backstop.

Reduce `core-hook.sh` to the stable runtime launcher plus bounded fail-open handling: read stdin once, invoke `$HOME/.agent/feedback-loop/bin/afl-hook hook "$@"`, copy a successful launcher response verbatim, and otherwise return exactly the host's `{}` or `{"continue":true}` no-op according to `--continue`. Delete the JSONL/trigger-rule branch. The wrapper must not `exec` the launcher because a launcher exit failure still has to become a valid host no-op, and it must not print operational status to stdout/stderr.

Retain existing stable runtime resolution and symlink protections. Delete obsolete notification/reconcile files rather than leaving disabled imports or CLI branches. The legacy `store.mjs`/`schema.mjs`/`receipt.mjs` remain temporarily isolated only because later migration tasks still replace their consumers; Task 13 must delete them and proves no imports remain.

- [x] **Step 4: Run focused package tests**

Run: `node --test test/runtime.test.mjs test/cli.test.mjs test/e2e-smoke.test.mjs test/codex-host.test.mjs`

Expected: PASS; no test invokes an AFL Stop hook, notification transport or reconcile daemon. Capture-only synthetic-control parsing may still exercise the temporary legacy receipt parser until Task 13.

- [x] **Step 5: Verify deleted symbols are gone and commit**

Run: `rg -n 'notification_deliver|afl-receipt|hookPrompt|capture-stop|reconcile-daemon|memory_maintenance|feedback_episode' src/cli.mjs src/index.mjs templates/hooks test/runtime.test.mjs test/cli.test.mjs test/e2e-smoke.test.mjs`

Expected: no active entrypoint/install/E2E matches; temporary isolated legacy modules are removed in Task 13.

```bash
git add -A src templates test
git commit -m "refactor: remove the conversation control plane"
```

### Task 4: 增加可解释的明确反馈候选分类器

- [x] **Task 4 complete: 增加可解释的明确反馈候选分类器**

**Files:**
- Create: `src/feedback-signal.mjs`
- Modify: `src/capture.mjs:91-158`
- Modify: `test/capture.test.mjs`

**Interfaces:**
- Produces: `detectFeedbackCandidate({ payload, userText, referent, now }) -> Promise<{ candidate, reasonCodes, score, referent }>`
- Produces: `classifyRetrospectiveEvidence({ userText, hasReferent }) -> { candidate, reasonCodes, score }`
- Produces: `readDirectAssistantReferent({ cli, payload, maxBytes, now }) -> { referent, structuralReason }`
- Produces: `feedbackSourceIdentity({ cli, sessionUid, contextEpoch, sourceEventId, referentEventUid }) -> sha256 hex`
- Produces: deterministic `normalizeHookEvent()` source-id fallback for replay-safe hosts without `event_id`/`prompt_id`
- Consumes: the existing owned, non-symlink, bounded transcript-tail primitive in `capture.mjs`

- [x] **Step 1: Write RED fixtures for required positive and negative cases**

```js
const explicit = await detectFeedbackCandidate({
  payload: completedTurnPayload,
  userText: "是的，而且为什么你改造这些之前没有去考虑这些东西呢，而是等到我发现事情变复杂了才开始思考这些东西",
  referent: { eventUid: "assistant:1", text: "previous design" },
  now: fixedNow
});
assert.equal(explicit.candidate, true);
assert.deepEqual(explicit.reasonCodes, [
  "negative_evaluation", "backward_reference", "causal_accountability", "expected_process_contrast"
]);

for (const text of ["reviewer job 是干嘛的？", "按推荐执行", "以后量大了再上 RAG"]) {
  assert.equal((await detectFeedbackCandidate({ payload: {}, userText: text, referent: null, now: fixedNow })).candidate, false);
}
```

Retain active-turn steering, recent interruption and stale interruption fixtures. Add single-keyword negatives for `为什么`、`问题`、`反思`.

Add host fixtures in which: Codex JSONL contains the immediately preceding completed assistant message; a current-turn assistant message is active steering; Claude/Gemini provide an explicit assistant field; transcript path is missing/symlinked/unowned/oversized; and the same payload without a native prompt id is replayed. The replay must produce one source identity, while the same text in another session or turn produces another identity.

- [x] **Step 2: Run RED and confirm the current completed-turn test fails for the right reason**

Run: `node --test test/capture.test.mjs`

Expected: FAIL on the explicit completed-turn dissatisfaction fixture because current code returns `immediateReview:false`; negative and structural fixtures remain intelligible.

- [x] **Step 3: Implement deterministic evidence classes**

First implement direct referent resolution. Prefer a role-validated explicit assistant field supplied by the host. Otherwise read only an owned regular transcript tail within the byte/age limits and select the closest role-validated assistant message preceding the current user event; a same-turn assistant message is structural `active_turn_steering`, while a completed prior-turn assistant message is only a referent and still needs retrospective evidence. Never treat unparsed transcript bytes or a user/system message as assistant content.

Use normalized Chinese/English phrase-pattern groups only as evidence extractors. Candidate rules are:

```js
const required = hasReferent && reasons.has("negative_evaluation");
const supporting = [
  "backward_reference",
  "causal_accountability",
  "expected_process_contrast",
  "explicit_correction"
].filter((reason) => reasons.has(reason));
return {
  candidate: Boolean(structuralReason || (required && supporting.length >= 1)),
  reasonCodes: [...reasons].sort(REASON_ORDER),
  score: structuralReason ? 100 : 40 + supporting.length * 20,
  referent
};
```

Synthetic AFL controls are rejected before scoring. Never log `userText` or referent text.

`feedbackSourceIdentity` hashes the five canonical identity fields with length-prefixed UTF-8 encoding. `normalizeHookEvent` first uses the host's `event_id`/`prompt_id`; when absent, it derives a deterministic source id from the canonical tuple `(cli, session id, turn/native-turn id, transcript path, redacted content hash)`. The content hash is a last-resort event discriminator, not a cross-event similarity key: session and turn remain part of the identity, so identical wording in a later session/turn is never suppressed. If the host supplies neither a stable session nor turn, mark the source `identity_unstable` and do not create a reviewer job rather than pretending replay idempotency.

- [x] **Step 4: Run focused tests and commit**

Run: `node --test test/capture.test.mjs`

Expected: PASS for completed-turn, structural, stale, synthetic and invited-design cases.

```bash
git add src/feedback-signal.mjs src/capture.mjs test/capture.test.mjs
git commit -m "feat: detect explicit retrospective feedback"
```

### Task 5: 让 prompt capture 事务创建一个即时 job

- [x] **Task 5 complete: 让 prompt capture 事务创建一个即时 job**

**Files:**
- Modify: `src/capture.mjs:248-374`
- Modify: `src/cli.mjs:635-805`
- Modify: `test/cli.test.mjs`
- Modify: `test/e2e-smoke.test.mjs`

**Interfaces:**
- Consumes: `detectFeedbackCandidate()` from Task 4
- Consumes: `openControlStore()`, `store.createReviewCandidate()` and `store.reserveReviewLaunch()` from Tasks 1–2
- Produces: `handlePromptHook({ payload, cli, controlStore, legacyMemoryStore, blobs, launchReviewer, writeResponse, now })`
- Produces: candidate transaction before any detached spawn call
- Produces: `selectionPublishedBefore` fixed before capture/spawn so same-hook publications are ineligible

- [x] **Step 1: Write orchestration RED tests with injected launcher/writer**

```js
const calls = [];
const response = await handlePromptHook({
  payload: explicitFeedbackPayload,
  cli: "codex",
  controlStore,
  legacyMemoryStore,
  blobs,
  launchReviewer: (jobId) => calls.push(jobId),
  writeResponse: async () => calls.push("response")
});
assert.equal(controlStore.countReviewJobs(), 1);
assert.deepEqual(calls, [controlStore.listReviewJobs()[0].job_id, "response"]);
assert.equal(response.operationalText, null);
```

Add replay, different-session same-text, ordinary prompt and store-failure cases. Replay must reuse one job and not reserve a second launch during cooldown; different source identity must create a second job immediately.

Add a never-resolving Promise launcher fixture and assert `handlePromptHook` does not await it; the production launcher contract is synchronous. Preserve `selectionPublishedBefore` on the selection input; Task 10 adds the direct-document race assertion when that path becomes active.

- [x] **Step 2: Run RED**

Run: `node --test --test-name-pattern='explicit feedback commits one job before launch|hook replay reuses the job|same complaint in another session starts another review|prompt failures remain host-pass' test/cli.test.mjs test/e2e-smoke.test.mjs`

Expected: FAIL because the current hook calls `submitDueReview()` and defaults ordinary traffic to a three-entry queue.

- [x] **Step 3: Extract and implement prompt-only orchestration**

The function must set `selectionPublishedBefore = now()` before any spawn, resolve the direct transcript referent, evaluate the signal, capture current/referent evidence only for a real candidate, reserve launch after the durable job commit, and construct a host no-op even when a substep fails. Keep capture/store, launch/recovery, catalog/selection and host-response construction in separate fail-open boundaries so one failure cannot suppress later safe phases. Remove all `AGENT_FEEDBACK_LOOP_REVIEW_MIN_ENTRIES`, queue age and candidate receipt logic.

```js
if (signal.candidate) {
  const candidate = controlStore.createReviewCandidate({
    sourceEventUid: captured.eventUid,
    referentEventUid: referentCapture?.eventUid ?? null,
    sourceIdentity: feedbackSourceIdentity({
      cli: event.cli,
      sessionUid: event.session_uid,
      contextEpoch: event.context_epoch,
      sourceEventId: event.source_event_id,
      referentEventUid: referentCapture?.eventUid ?? "none"
    }),
    projectId: event.project_id
  });
  const reservation = controlStore.reserveReviewLaunch({ jobId: candidate.jobId, cooldownMs: 5_000 });
  if (reservation.launch) launchReviewer(candidate.jobId, reservation.launchEpoch);
}
```

`launchReviewer` in this task is dependency-injected, synchronous and must return immediately; its return value is never a completion signal. If a test double returns a Promise, do not await it. Real process semantics and launch-failure release arrive in Task 6. To keep this intermediate commit green, existing lesson selection may read through a separately named `legacyMemoryStore`; capture/job code must never write to it. Task 10 consumes the fixed publication cutoff, removes that last runtime consumer and removes the compatibility parameter.

The normal CLI path must not reuse the current embedded legacy launcher: until Task 9 switches the runner protocol, inject a silent `runner_transition` no-op launcher and leave the durable job recoverable. This is an implementation-only transition in the isolated worktree, never a releasable/installable checkpoint. Task 9 replaces that no-op and the legacy `reviewer-run` together in one commit.

- [x] **Step 4: Run focused regression and commit**

Run: `node --test test/cli.test.mjs test/e2e-smoke.test.mjs test/capture.test.mjs test/control-store.test.mjs test/store.test.mjs`

Expected: PASS; ordinary prompt creates zero job and emits no AFL status.

```bash
git add src/capture.mjs src/cli.mjs test/cli.test.mjs test/e2e-smoke.test.mjs
git commit -m "feat: queue explicit feedback immediately"
```

### Task 6: 实现 macOS/Linux detached reviewer 与 prompt-time recovery

- [x] **Task 6 complete: 实现 macOS/Linux detached reviewer 与 prompt-time recovery**

**Files:**
- Create: `src/reviewer-launcher.mjs`
- Create: `test/reviewer-launcher.test.mjs`
- Modify: `test/e2e-smoke.test.mjs`

**Interfaces:**
- Produces: synchronous `launchDetachedReviewer({ platform, nodeExecutable, cliFile, home, jobId, launchEpoch, spawnImpl, env = process.env }) -> { attempted, reason }`
- Produces: `recoverDueReviewers({ store, launchReviewer, limit = 1 }) -> { scanned, attempted }`
- Consumes: CLI command `reviewer-run --home <home> --job-id <id>`
- Transitional rule: Task 6 verifies the launcher with a fixture child but does not point production prompt jobs at the legacy `reviewer-run`; Task 9 atomically activates launcher + new runner

**Frozen Task 6 acceptance:** (A) only `darwin` and `linux` are supported; inputs and absolute executable/CLI paths are validated before direct spawn; (B) arguments and process options are exact, use no shell, inherit no stdio, and the child is synchronously unrefed; (C) only a bounded environment allowlist reaches the child and no prompt/evidence content is logged; (D) spawn/unref failure is returned as a machine reason, and `recoverDueReviewers` releases only the matching reserved launch epoch; (E) recovery scans stable due order, reserves and attempts at most one job per call, and store/launcher failure remains prompt-safe; (F) a real disposable macOS child outlives its parent and writes a sentinel without leaking child output, while Linux options are covered through the same platform-neutral implementation; (G) the task does not wire the legacy runner, add a timer/scheduler, wait for a provider, change schema, support Windows, or touch real HOME/hooks/runtime state.

- [x] **Step 1: Write RED tests for exact spawn options and bounded recovery**

```js
const result = launchDetachedReviewer({
  platform: "darwin",
  nodeExecutable: "/usr/bin/node",
  cliFile: "/runtime/bin/agent-feedback-loop.mjs",
  home: "/tmp/afl-home",
  jobId: "job-1",
  launchEpoch: 1,
  spawnImpl(command, args, options) {
    assert.equal(command, "/usr/bin/node");
    assert.deepEqual(args, ["/runtime/bin/agent-feedback-loop.mjs", "reviewer-run", "--home", "/tmp/afl-home", "--job-id", "job-1"]);
    assert.deepEqual({ detached: options.detached, stdio: options.stdio }, { detached: true, stdio: "ignore" });
    return { unref() { unrefCalled = true; } };
  }
});
assert.deepEqual(result, { attempted: true, reason: "spawn_attempted" });
assert.equal(unrefCalled, true);
```

Test `darwin` and `linux`; `win32` returns `{attempted:false, reason:'unsupported_platform'}`. When launch is exercised through `recoverDueReviewers`, a synchronous spawn/unref failure must call `recordReviewLaunchFailure` with the matching launch epoch and make the job immediately recoverable; a stale epoch cannot release a newer reservation. The process-only launcher does not own SQLite. Recovery fixture with three jobs must attempt exactly one in stable order. A child object has to expose `unref`; otherwise treat launch as failed.

- [x] **Step 2: Run RED**

Run: `node --test test/reviewer-launcher.test.mjs test/e2e-smoke.test.mjs`

Expected: FAIL because launcher/recovery module does not exist and current launcher is embedded in `cli.mjs`.

- [x] **Step 3: Implement short-lived detached launch**

Use direct `spawn`, never a shell. Prevalidate platform, executable and absolute CLI path. The function is intentionally synchronous: it only creates the child and calls `unref`, never awaits process exit. A synchronous spawn/unref exception returns `spawn_failed`; the recovery orchestrator records that failure against only the matching reservation epoch. An asynchronous child error is consumed so it cannot crash the host and remains recoverable after `next_launch_at`. No stdout/stderr is inherited by the host. Pass only the existing reviewer-safe base environment (`PATH`, `HOME`, `TMPDIR`, locale and `TZ`), explicitly allowlisted operator variables and `AFL_REVIEW_*`; do not forward arbitrary secrets.

```js
const child = spawnImpl(nodeExecutable, args, {
  cwd: path.dirname(cliFile),
  detached: true,
  stdio: "ignore",
  env: reviewerEnvironment(env),
  windowsHide: true
});
child.unref();
return { attempted: true, reason: "spawn_attempted" };
```

Keep production wiring dependency-injected in this task. The lifecycle E2E uses a fixture CLI that writes a sentinel after its parent returns; do not send a new control-store job to the still-legacy `reviewer-run`. Task 9 will call `recoverDueReviewers({limit:1})` once per prompt after the new candidate's reservation, once the new runner protocol is active. Recovery is not a timer, performs at most one synchronous spawn attempt, and cannot wait for a child or provider.

- [x] **Step 4: Run focused and process-lifecycle tests**

Run: `node --test test/reviewer-launcher.test.mjs test/e2e-smoke.test.mjs`

Expected: PASS; a fixture child writes a completion sentinel after the hook process has already returned, and host output contains no child output.

- [x] **Step 5: Commit**

```bash
git add src/reviewer-launcher.mjs test/reviewer-launcher.test.mjs test/e2e-smoke.test.mjs
git commit -m "feat: add the detached reviewer launcher"
```

### Task 7: 先定义结构化 reviewer result，保持旧 runtime 全绿

- [x] **Task 7 complete: 先定义结构化 reviewer result，保持旧 runtime 全绿**

**Files:**
- Create: `src/reviewer-result.mjs`
- Create: `src/reviewer-result-file.mjs`
- Create: `templates/schemas/reviewer-result.schema.json`
- Create: `test/reviewer-result.test.mjs`
- Create: `test/reviewer-result-file.test.mjs`

**Interfaces:**
- Produces: `ReviewResult = { outcome, final_severity, responsibility, method_class, family_id, proposed_family_key, applies_when, facts, user_complaint, root_cause, class_of_mistake, method_changes, repeated_pattern_evidence, recurrence_of }`
- Produces: `validateReviewerResult(value, { allowedFamilyIds = [], recurrenceFamilyById = new Map() }) -> ReviewResult`
- Produces: `deriveReviewerFamilyId(methodClass, proposedFamilyKey) -> family-<20 lowercase hex>`
- Produces: `readSecureReviewerResult(path) -> unknown`; semantic validation remains in `validateReviewerResult`
- Transitional rule: existing provider/runner/receipt files remain active and unchanged until Task 9 atomically switches the whole reviewer path

**Frozen Task 7 acceptance:** (A) `no_lesson` is exactly `{outcome}` and `lesson` has exactly the declared fields; (B) lesson severity is `Major|Critical|Blocker`, responsibility is `agent_fault`, controlled identifiers and all strings/arrays obey the stated bounds, and facts/applies-when/method changes are non-empty; (C) an existing family must be controller-allowlisted with `proposed_family_key:null`, while a new family has `family_id:null`, a normalized proposed key, no recurrence ids and a deterministic controller-derived id; prior reflection ids in `recurrence_of` must resolve through `recurrenceFamilyById` to the selected existing family; (D) unknown/source/receipt/notification fields, obvious credential/control payloads and caller mutation are rejected without logging content; (E) the JSON Schema mirrors the static two-outcome contract while catalog/secret semantics are independently enforced in JavaScript; (F) `readSecureReviewerResult()` uses a no-follow opened file, accepts only one owned 0600 regular file of 1..256 KiB, decodes strict UTF-8 JSON, and removes only the same owned regular file on success or failure without touching a symlink; (G) only the five declared files change and no provider, runner, CLI, database, Markdown publication or real runtime is activated.

- [x] **Step 1: Write RED contract tests**

```js
const noLesson = validateReviewerResult({ outcome: "no_lesson" }, { allowedFamilyIds: [] });
assert.deepEqual(noLesson, { outcome: "no_lesson" });

assert.equal(validateReviewerResult({
  outcome: "lesson",
  final_severity: "Major",
  responsibility: "agent_fault",
  method_class: "requirements_before_architecture",
  family_id: null,
  proposed_family_key: "requirements-before-architecture",
  applies_when: ["changing an existing architecture"],
  facts: ["The prior answer introduced a scheduler before validating the simpler subagent path."],
  user_complaint: "The design became heavier before the requirement was checked.",
  root_cause: "Architecture was selected before validating the smallest value path.",
  class_of_mistake: "solution-first architecture",
  method_changes: ["List the minimum end-to-end value chain before adding control-plane components."],
  repeated_pattern_evidence: [],
  recurrence_of: []
}, { allowedFamilyIds: [] }).outcome, "lesson");
```

Reject invented source ids, unsupported severity/responsibility, unbounded arrays/strings, empty reusable method, obvious credential/control payloads and extra operational fields such as receipt/notification. Bound `applies_when` to 8 items × 160 chars, `facts` to 12 × 512, complaint/root-cause/class fields to 2,048 chars each, `method_changes` to 8 × 512, repeated-pattern evidence to 8 × 512 and recurrence ids to 16 × 128; every required string is trimmed and non-empty. An existing `family_id` is accepted only when it appears in `allowedFamilyIds`, requires `proposed_family_key:null`, and each prior reflection id in `recurrence_of` must map to that same family in the controller-supplied `recurrenceFamilyById`. Otherwise `family_id` must be null, `recurrence_of` must be empty and `proposed_family_key` must normalize to lowercase ASCII letters/digits/hyphens. The controller derives a new stable id as `family-<first 20 hex chars of sha256(method_class + "\n" + proposed_family_key)>`.

- [x] **Step 2: Run RED**

Run: `node --test test/reviewer-result.test.mjs test/reviewer-result-file.test.mjs`

Expected: FAIL because the standalone result validator, schema and secure result-file reader do not exist.

- [x] **Step 3: Implement the standalone result contract**

Use one JSON Schema with `oneOf` for the two outcomes and `additionalProperties:false`. `validateReviewerResult` enforces the same limits in JavaScript so provider output cannot bypass schema validation.

Rename the private output-file boundary to `readSecureReviewerResult(path)`. It opens with no-follow semantics, then accepts one 0600 regular file owned by the current uid, rejects zero or more than 256 KiB before JSON parsing, decodes strict UTF-8, returns the parsed value to the separate semantic validator, and removes only the same owned regular inode in `finally` on success or parse/validation failure. It never follows or removes a symlink and never renders or logs the content. Codex writes this path via `--output-last-message`; Claude/Gemini stdout envelopes are unwrapped and copied by the controller into the same exclusive 0600 boundary before validation. This is an internal provider result channel, not a user-visible receipt.

- [x] **Step 4: Run new and unchanged reviewer tests, then commit**

Run: `node --test test/reviewer-result.test.mjs test/reviewer-result-file.test.mjs test/reviewer-provider.test.mjs test/reviewer-runner.test.mjs test/reviewer-adapter.test.mjs test/reviewer-auth.test.mjs`

Expected: PASS; the new contract is complete while the unchanged old reviewer path remains green until Task 9.

```bash
git add src/reviewer-result.mjs src/reviewer-result-file.mjs templates/schemas/reviewer-result.schema.json test/reviewer-result.test.mjs test/reviewer-result-file.test.mjs
git commit -m "feat: define validated reviewer results"
```

### Task 8: 建立 canonical/legacy Markdown 文档层与原子发布

- [x] **Task 8 complete: 建立 canonical/legacy Markdown 文档层与原子发布**

**Files:**
- Create: `src/reflection-document.mjs`
- Create: `test/reflection-document.test.mjs`
- Create: `test/fixtures/reflections/legacy-modern.md`
- Create: `test/fixtures/reflections/legacy-zh.md`
- Create: `test/fixtures/reflections/legacy-list.md`

**Interfaces:**
- Produces: `validateReflectionModel(result, source) -> ReflectionModel`
- Produces: `renderReflectionMarkdown(model) -> string`
- Produces: `parseReflectionMarkdown(markdown, { path }) -> ParsedReflection`
- Produces: `readReflectionCatalog({ projectDir, publishedBefore, maxFileBytes = 131072, maxFiles = 256 }) -> { documents, omissions }`
- Produces: `publishReflectionDocument({ projectDir, reflectionDir, model, beforeRename, fsImpl }) -> { path, sha256, created }`; exactly one of project/reflection directory is accepted
- Produces: canonical metadata keys `reflection_id`, `created_at`, `published_at`, `final_severity`, `responsibility`, `method_class`, `family_id`, `applies_when`, `effectiveness`, `source_identity_hash`
- `validateReflectionModel` 的 controller source envelope 固定为 `{ sourceIdentity, createdAt, publishedAt }`：前两项来自 durable job/source event，`publishedAt` 是调用者在 publication fence 内固定并在 crash adoption 时复用的带时区时间；文档层只校验并规范化为 UTC，不自行读取时钟或新增持久状态

- [x] **Step 1: Write RED tests for the exact readable format and legacy compatibility**

```js
const markdown = renderReflectionMarkdown(model);
assert.match(markdown, /^# 反思报告：/);
for (const heading of [
  "## facts proven by context",
  "## user complaint in plain language",
  "## root cause",
  "## class of mistake",
  "## method change",
  "## repeated pattern evidence"
]) assert.match(markdown, new RegExp(heading));

const parsed = parseReflectionMarkdown(markdown, { path: "/project/.agent/reflections/report.md" });
assert.equal(parsed.familyId, model.family_id);
assert.deepEqual(parsed.methodChanges, model.method_changes);
```

Add three read-only-derived fixture shapes matching the existing repository reports: modern English named sections with severity/responsibility but no `method_class`/`family_id`; Chinese named-section aliases; and older metadata-list reports. The parser uses an explicit case-insensitive alias table for facts, complaint, root cause, mistake class, method change/preventive constraint and repeated pattern headings; it never guesses from arbitrary prose.

For a legacy document with severity, responsibility, a bounded mistake-class section and a bounded actionable method-change/preventive-constraint section, derive `methodClass = legacy-method-<first 20 hex chars of sha256(normalized class)>` and `familyId = legacy-family-<first 20 hex chars of sha256(normalized class + "\n" + methodClass)>`. This allows current documents that predate those metadata keys to remain selectable and groups only exact normalized mistake classes; it does not pretend semantic equivalence. Derive `createdAt` from a recognized filename timestamp, otherwise owned file mtime; use mtime as the legacy publication cutoff. Missing mistake class or actionable method returns `{eligible:false, omission:'legacy_incomplete'}`. Catalog tests must read only regular `*.md` files, reject symlink entries, enforce the two hard limits and return stable path order. Canonical `published_at >= publishedBefore` and concurrently modified legacy files with `mtime >= publishedBefore` are excluded as `published_after_cutoff`.

- [x] **Step 2: Write atomic publication RED tests**

Use an injectable filesystem that fails at write, file sync, rename and post-rename hash verification. Assert no canonical target is selectable after pre-rename failures, duplicate `reflection_id` reuses an identical hash, and a conflicting existing target returns `publication_collision` without overwrite.

Run: `node --test test/reflection-document.test.mjs`

Expected: FAIL because the document module does not exist.

- [x] **Step 3: Implement validation, rendering, parsing and publication**

Canonical rendering must use the established report format, not YAML or a separate card database:

```js
export function renderReflectionMarkdown(model) {
  return [
    `# 反思报告：${model.title}`,
    "",
    `- reflection_id: ${model.reflection_id}`,
    `- created_at: ${model.created_at}`,
    `- published_at: ${model.published_at}`,
    `- final_severity: ${model.final_severity}`,
    `- responsibility: ${model.responsibility}`,
    `- method_class: ${model.method_class}`,
    `- family_id: ${model.family_id}`,
    `- applies_when: ${model.applies_when.join(" | ")}`,
    `- effectiveness: ${model.effectiveness ?? "unknown"}`,
    `- source_identity_hash: ${model.source_identity_hash}`,
    "",
    "## facts proven by context", "", ...model.facts.map((fact) => `- ${fact}`), "",
    "## user complaint in plain language", "", model.user_complaint, "",
    "## root cause", "", model.root_cause, "",
    "## class of mistake", "", model.class_of_mistake, "",
    "## method change", "", ...model.method_changes.map((item, index) => `${index + 1}. ${item}`), "",
    "## repeated pattern evidence", "", ...(model.repeated_pattern_evidence.length ? model.repeated_pattern_evidence.map((item) => `- ${item}`) : ["- none"]), ""
  ].join("\n");
}
```

Derive controller-owned fields rather than trusting the provider: `reflection_id = reflection-<first 24 hex chars of sha256(sourceIdentity)>`, `created_at` is the captured source-event time, `published_at` is the current fenced publication attempt time, `source_identity_hash` is SHA-256 of the durable source identity, and title is a bounded rendering of `class_of_mistake`. A retry uses the same identity and target name `<UTC source timestamp>-<slug>-<reflection id suffix>.md`; if an earlier authorized attempt already renamed the file, only an identical hash may be adopted.

Use a 0600 same-directory temp file, `FileHandle.sync()`, `rename()`, directory sync when supported, and SHA-256 verification. Reject a symlinked project root, `.agent` directory or reflections directory before every publish. Slug sanitization allows lowercase ASCII letters, digits and hyphens only; fall back to the reflection id prefix. An explicit `reflectionDir` exists only for legacy export and is subject to the same ownership/symlink checks.

- [x] **Step 4: Run document tests and commit**

Run: `node --test test/reflection-document.test.mjs`

Expected: PASS for canonical roundtrip, eligible/incomplete legacy docs, every failure injection and idempotent publication.

```bash
git add src/reflection-document.mjs test/reflection-document.test.mjs test/fixtures/reflections
git commit -m "feat: publish reflection documents atomically"
```

### Task 9: 让 reviewer runner 只提交 no-lesson 或 published 文档终态

- [ ] **Task 9 complete: 让 reviewer runner 只提交 no-lesson 或 published 文档终态**

**Files:**
- Modify: `src/reviewer-provider.mjs`
- Modify: `src/reviewer-runner.mjs`
- Modify: `src/reviewer-adapter.mjs`
- Modify: `src/cli.mjs`
- Modify: `src/control-store.mjs`
- Delete: `src/reviewer-auth.mjs`
- Modify: `templates/prompts/reflection-agent.md`
- Delete: `templates/schemas/reviewer-receipt.schema.json`
- Modify: `test/reviewer-provider.test.mjs`
- Modify: `test/reviewer-runner.test.mjs`
- Modify: `test/reviewer-adapter.test.mjs`
- Delete: `test/reviewer-auth.test.mjs`
- Modify: `test/control-store.test.mjs`
- Modify: `test/e2e-smoke.test.mjs`

**Interfaces:**
- Consumes: `validateReviewerResult()` from Task 7
- Consumes: `readReflectionCatalog()` and `publishReflectionDocument()` from Task 8
- Consumes: `launchDetachedReviewer()`/`recoverDueReviewers()` from Task 6 and activates them with the new runner only in this task
- Produces: `runReviewJob({ jobId, ownerId, store, blobs, provider, projectDir }) -> { outcome, documentPath }`
- Produces: CLI `reviewer-run --home <home> --job-id <id>` with no stdout business/control message

- [ ] **Step 1: Write runner RED tests for both terminal outcomes and publication fencing**

```js
const noLesson = await runReviewJob({ ...fixture, provider: async () => ({ outcome: "no_lesson" }) });
assert.deepEqual(noLesson, { outcome: "reviewed_no_lesson", documentPath: null });
assert.equal(listReflectionFiles(projectDir).length, 0);

const lesson = await runReviewJob({ ...fixture, provider: async () => validLessonResult });
assert.equal(lesson.outcome, "published");
assert.equal(listReflectionFiles(projectDir).length, 1);
assert.equal(store.getReviewJob(jobId).published_sha256, sha256(readFileSync(lesson.documentPath)));
```

Add invalid provider result, publication collision, lease expiry during provider call, stale-owner submission and crash-after-rename adoption. A lease that expires during the provider call must fail the pre-publication fence without creating a canonical file. A crash after a fenced rename may leave one valid immutable document; the next owner may adopt only that same reflection id/hash and may never overwrite it.

- [ ] **Step 2: Run RED**

Run: `node --test test/reviewer-provider.test.mjs test/reviewer-runner.test.mjs test/reviewer-adapter.test.mjs test/control-store.test.mjs test/e2e-smoke.test.mjs`

Expected: FAIL because current runner submits a receipt plus database lesson/report/notification transaction.

- [ ] **Step 3: Implement bounded context and terminal commits**

First atomically switch the production CLI wiring: `handlePromptHook` injects the synchronous detached launcher for newly reserved jobs and then performs one bounded recovery; `reviewer-run` opens only the control store and invokes the new runner. There must be no commit in which a control-store job is launched into the legacy runner protocol.

Build reviewer input from the source event, direct referent, at most six prior and two following bounded events, plus existing reflection id/family/method-class/applies-when/hash summaries. Raw evidence is read from encrypted blobs only by the runner, parsed through allowlisted host fields and credential-redacted again before provider input; it is never copied into operational logs, SQLite bodies or result errors.

Switch every provider invocation to `reviewer-result.schema.json` and `readSecureReviewerResult(path)`. The reflection prompt must first audit `requirement -> prior delivery -> evidence -> unmet item`, then classify responsibility, reusable method and existing/new family; it returns JSON only. Preserve stdin-only evidence and process-group timeout behavior. Run Codex with `--ephemeral --ignore-user-config --ignore-rules --sandbox read-only` in a private empty 0700 work directory rather than the project; keep Claude's empty tool allowlist and Gemini's deny-all policy. For Codex add `--output-last-message <private result path>`; for Claude/Gemini normalize the bounded stdout envelope into that private path. Delete the old secure receipt-file module/schema/tests in the same commit so no mixed provider protocol remains.

```js
const allowedFamilyIds = context.reflectionCatalog.map((item) => item.familyId);
const result = validateReviewerResult(await provider(context), { allowedFamilyIds });
if (result.outcome === "no_lesson") {
  store.completeReviewNoLesson({ jobId, ownerId, leaseEpoch });
  return { outcome: "reviewed_no_lesson", documentPath: null };
}
const model = validateReflectionModel(result, context.source);
store.renewReviewLease({ jobId, ownerId, leaseEpoch, leaseMs: 30_000 });
store.assertReviewLease({ jobId, ownerId, leaseEpoch });
const published = await publishReflectionDocument({
  projectDir,
  model,
  beforeRename: () => store.assertReviewLease({ jobId, ownerId, leaseEpoch })
});
store.completeReviewPublished({ jobId, ownerId, leaseEpoch, path: published.path, sha256: published.sha256 });
return { outcome: "published", documentPath: published.path };
```

Immediately before any canonical rename, recheck the current owner/epoch and renew a short publication lease. The publisher receives that fence callback and invokes it after temp-file sync but before rename; this prevents a worker whose lease already expired during provider work from making a file visible. If rename succeeds but final DB commit is interrupted, a later owner validates the stable reflection id and exact content hash before adopting the existing document. A conflicting hash is `publication_collision`, never overwrite.

On retryable provider/publication failure call `failReviewJob` with one fixed enum reason (`provider_unavailable`, `provider_timeout`, `provider_invalid`, `context_invalid`, `lease_lost`, `publication_failed`, `publication_collision`) and the Task 2 backoff; exhausted jobs become `failed`. Remove lesson/report/notification writes from completion.

- [ ] **Step 4: Run focused runner/store/e2e regression and commit**

Run: `node --test test/reviewer-result.test.mjs test/reviewer-result-file.test.mjs test/reviewer-provider.test.mjs test/reviewer-runner.test.mjs test/reviewer-adapter.test.mjs test/control-store.test.mjs test/e2e-smoke.test.mjs test/reflection-document.test.mjs`

Expected: PASS; detached runner completion changes only control rows and Markdown files.

```bash
git add -A src/reviewer-provider.mjs src/reviewer-runner.mjs src/reviewer-adapter.mjs src/reviewer-auth.mjs src/cli.mjs src/control-store.mjs templates/prompts templates/schemas test/reviewer-provider.test.mjs test/reviewer-runner.test.mjs test/reviewer-adapter.test.mjs test/reviewer-auth.test.mjs test/control-store.test.mjs test/e2e-smoke.test.mjs
git commit -m "feat: publish reviewer outcomes as markdown"
```

### Task 10: 用 Markdown 文档实现确定性 Top-K 与 omission

- [ ] **Task 10 complete: 用 Markdown 文档实现确定性 Top-K 与 omission**

**Files:**
- Replace: `src/selector.mjs`
- Modify: `src/cli.mjs`
- Modify: `test/selector.test.mjs`
- Modify: `test/cli.test.mjs`

**Interfaces:**
- Produces: `loadReflectionDocuments({ projectDir, publishedBefore, maxFileBytes }) -> { documents, omissions }`, implemented as the selector-facing projection of `readReflectionCatalog()`
- Produces: `selectReflections({ documents, prompt, session, task, budget, priorEmissions, publishedBefore }) -> { guidance, selected, omissions, tokenEstimate }`
- Produces: omission reasons `not_applicable`, `count_budget`, `token_budget`, `oversized_document`, `legacy_incomplete`, `family_projection`, `prior_emission`, `parse_error`, `published_after_cutoff`, `catalog_limit`

- [ ] **Step 1: Write direct-document RED tests**

Create real Markdown fixtures through `renderReflectionMarkdown()` and cover:

```js
const result = selectReflections({
  documents: fiveSevereDocuments,
  prompt: "修改已有架构前先核对用户目标",
  session,
  task,
  budget: { maxCards: 4, maxTotalTokens: 900, maxDocumentTokens: 320 },
  priorEmissions: []
});
assert.equal(result.selected.length, 4);
assert.equal(result.omissions.filter((item) => item.reason === "count_budget").length, 1);
assert.equal("hold" in result, false);
```

Add deterministic repeat, oversized plus safe sibling, one family with three documents, incomplete legacy, Chinese/English relevance, zero-relevance exclusion and prior-emission fixtures. The family fixture must select only the newest eligible method and count recurrence from documents. Add a launcher race fixture through `handlePromptHook`: a document atomically published with `published_at === selectionPublishedBefore` is excluded from the current response and becomes eligible on the next matching prompt.

- [ ] **Step 2: Run RED**

Run: `node --test test/selector.test.mjs test/reflection-document.test.mjs`

Expected: FAIL because the current selector reads database lesson cards and returns `memory_overflow_hold` for severe count/size.

- [ ] **Step 3: Implement direct loading, total order and bounded guidance**

Read only `*.md` regular files under the project reflection directory, reject symlinks, cap each read to `maxFileBytes`, enforce strict `published_at < publishedBefore`, and parse through Task 8. Apply the steps in this exact order: stable catalog parse/omissions; applicability (`relevanceScore > 0`); per-family newest complete document projection by `(createdAt, reflectionId)`; prior-emission suppression for the same `(document hash, session, context, task)`; rank; per-document budget; Top-K/total budget. Rank the projected documents with this exact tuple:

```js
const rankKey = (document) => [
  -document.relevanceScore,
  -SEVERITY_RANK[document.finalSeverity],
  -document.familyRecurrence,
  -Date.parse(document.createdAt),
  document.reflectionId
];
```

Use stable lexicographic comparison. Guidance contains only `applies_when`, `class_of_mistake` and numbered `method_changes`, plus opaque document hash; never include the full complaint/facts/root-cause report. Switch `handlePromptHook` from `legacyMemoryStore/selectLessons` to `readReflectionCatalog/selectReflections`, pass its fixed hook-start cutoff, and remove the legacy store parameter/import from every normal CLI path.

Compute relevance without embeddings: normalize unique lowercase Latin word tokens and unique overlapping CJK bigrams from the prompt; add 4 points for each intersection with `applies_when`, 3 for `class_of_mistake`, 2 for `method_class`, and 1 for `method_changes`, capped at 40. Exact normalized path/tool task metadata matches add 8 each. A zero score is `not_applicable`, never injected merely because it is severe. Estimate budget conservatively and deterministically: each CJK code point counts as one token, each Latin alphanumeric run as `ceil(length / 4)`, and each remaining non-whitespace code point as one. Default `maxFileBytes` is 131072, `maxCards` is 4, `maxDocumentTokens` is 320, and `maxTotalTokens` is 900; configuration may lower but not exceed these hard limits in the prompt hook.

- [ ] **Step 4: Run focused tests and verify the hold symbol is gone**

Run: `node --test test/selector.test.mjs test/reflection-document.test.mjs`

Expected: PASS.

Run: `rg -n 'memory_overflow_hold|selectLessons|compileLessonCard' src/selector.mjs src/cli.mjs test/selector.test.mjs test/cli.test.mjs`

Expected: no active selector/prompt matches. The legacy `lessons.mjs` remains only for the isolated old store until Task 13.

- [ ] **Step 5: Commit**

```bash
git add src/selector.mjs src/cli.mjs test/selector.test.mjs test/cli.test.mjs
git commit -m "feat: select guidance directly from reflection documents"
```

### Task 11: 分离 selected、emitted 与复发负向证据

- [ ] **Task 11 complete: 分离 selected、emitted 与复发负向证据**

**Files:**
- Modify: `src/control-store.mjs`
- Modify: `src/cli.mjs`
- Modify: `src/reviewer-runner.mjs`
- Modify: `src/reflection-document.mjs`
- Modify: `test/control-store.test.mjs`
- Modify: `test/cli.test.mjs`
- Modify: `test/reviewer-runner.test.mjs`

**Interfaces:**
- Produces: `store.recordReflectionSelected({ document, familyId, sessionUid, contextEpoch, taskFingerprint }) -> emissionId`
- Produces: `store.markReflectionEmitted({ emissionId })`
- Produces: `store.findPriorFamilyEmission({ familyId, before }) -> Emission | null`
- Produces: `writePromptResponse({ cli, response, writer }) -> Promise<void>`; emission is recorded only after successful write

- [ ] **Step 1: Write RED tests for the four truthful state boundaries**

```js
const emissionId = store.recordReflectionSelected(selection);
assert.equal(store.getReflectionEmission(emissionId).outcome, "selected");

await assert.rejects(writePromptResponse({ cli: "codex", response, writer: failingWriter }));
assert.equal(store.getReflectionEmission(emissionId).emitted_at, null);

await writePromptResponse({ cli: "codex", response, writer: successfulWriter });
store.markReflectionEmitted({ emissionId });
assert.equal(store.getReflectionEmission(emissionId).outcome, "emitted");
```

Add two same-family reviewer fixtures: one after a qualifying emitted timestamp yields `recurrence_after_emission`; one after publication with no emission remains ordinary recurrence and effectiveness `unknown`. Assert no API/state named `observed` or `effective` exists.

- [ ] **Step 2: Run RED**

Run: `node --test --test-name-pattern='selected is not emitted|successful host write records emitted|same family after emission is negative evidence|absence of recurrence remains unknown' test/control-store.test.mjs test/cli.test.mjs test/reviewer-runner.test.mjs`

Expected: FAIL because current delivery state uses lesson application/receipt observation semantics.

- [ ] **Step 3: Implement emission ordering and recurrence annotation**

Create one selected row per application identity `(document_sha256, session_uid, context_epoch, task_fingerprint)`. Attempt selected-row insertion before the host write, but if that audit write fails, still return the already-built safe guidance and log `selection_record_failed`; audit failure cannot suppress business context. Write host JSON exactly once; only after the writer resolves, mark all successfully created rows emitted. A store failure after host output underclaims emission and logs `emission_record_failed`; it must not retry the host response.

Before publishing a lesson result, query a prior same-family emitted record strictly earlier than the source event's captured timestamp. If found, append a controller-authored bounded repeated-pattern entry containing only the prior family/document hash and emitted timestamp, validate any provider `recurrence_of` ids against the same-family catalog, and set model field `effectiveness: recurrence_after_emission`; otherwise set `effectiveness: unknown`. An emission produced later in the same hook cannot qualify. This fact is rendered into the new Markdown, not inferred from silence.

- [ ] **Step 4: Run focused regression and forbidden-state scan**

Run: `node --test test/control-store.test.mjs test/cli.test.mjs test/reviewer-runner.test.mjs test/reflection-document.test.mjs`

Expected: PASS.

Run: `rg -n '\bobserved\b|\beffective\b|emitted_unconfirmed' src templates test`

Expected: no active runtime or test matches.

- [ ] **Step 5: Commit**

```bash
git add src/control-store.mjs src/cli.mjs src/reviewer-runner.mjs src/reflection-document.mjs test/control-store.test.mjs test/cli.test.mjs test/reviewer-runner.test.mjs
git commit -m "feat: audit reflection emission and recurrence honestly"
```

### Task 12: 实现旧数据库的显式只读 Markdown 导出

- [ ] **Task 12 complete: 实现旧数据库的显式只读 Markdown 导出**

**Files:**
- Create: `src/legacy-export.mjs`
- Modify: `src/cli.mjs`
- Create: `test/legacy-export.test.mjs`
- Modify: `test/cli.test.mjs`

**Interfaces:**
- Produces: `inspectLegacyExport({ sourceDb, outputDir }) -> ExportPlan`
- Produces: `executeLegacyExport({ plan, dryRun }) -> { planned, written, skipped, incomplete, conflicts }`
- Produces: CLI `legacy-export --source-db <absolute-path> --output-dir <absolute-path> --dry-run|--apply`
- Consumes: legacy `review_receipts`, `report_contents`, `lessons`, `lesson_revisions` only through read-only SQL

- [ ] **Step 1: Write RED tests with an immutable legacy DB copy**

Build a minimal v8/v9 fixture in a temporary directory, close it, hash its database/WAL/SHM files, then run:

```js
const dryRun = await inspectLegacyExport({ sourceDb, outputDir });
assert.deepEqual(dryRun.counts, { planned: 1, incomplete: 1, conflicts: 0 });
assert.equal(listReflectionFiles(outputDir).length, 0);

const first = await executeLegacyExport({ plan: dryRun, dryRun: false });
const second = await executeLegacyExport({ plan: await inspectLegacyExport({ sourceDb, outputDir }), dryRun: false });
assert.equal(first.written, 1);
assert.equal(second.written, 0);
assert.equal(second.skipped, 1);
assert.deepEqual(hashLegacyFiles(sourceDb), originalHashes);
```

Test a missing report, malformed lesson body, output collision and symlink source/output rejection.

- [ ] **Step 2: Run RED**

Run: `node --test test/legacy-export.test.mjs test/cli.test.mjs`

Expected: FAIL because no export module/command exists.

- [ ] **Step 3: Implement read-only inspection and idempotent apply**

Require absolute explicit paths and exactly one of `--dry-run` or `--apply`. Reject symlink/non-owned inputs, copy the explicitly supplied DB plus any WAL/SHM siblings into a private temporary snapshot, hash the supplied source set before and after, and execute only literal `SELECT` statements against the private snapshot; never import `openStore()` or run migrations. This avoids `immutable=1` silently ignoring WAL content while guaranteeing the operator's supplied copy is unchanged. Convert only complete evidence to `ReflectionModel`, use `legacy-<row id>` reflection identity plus content hash, and publish into the explicit output directory through Task 8's shared atomic writer.

Return counts and opaque legacy ids only. Do not print report content. `--apply` must compare canonical paths and always refuse `pathsFor(os.homedir()).legacyDatabase`. The supported safe procedure is to copy the old DB/WAL/SHM set to a temporary directory first and export that copy; this version exposes no bypass flag. Dry-run never creates the output directory; apply accepts only an owned non-symlink directory (or creates its final leaf beneath an owned non-symlink parent).

- [ ] **Step 4: Run export and CLI tests, then commit**

Run: `node --test test/legacy-export.test.mjs test/cli.test.mjs test/reflection-document.test.mjs`

Expected: PASS; two apply runs are idempotent and every source file hash is unchanged.

```bash
git add src/legacy-export.mjs src/cli.mjs test/legacy-export.test.mjs test/cli.test.mjs
git commit -m "feat: export legacy reflections without mutating the database"
```

### Task 13: 删除迁移期旧 store/schema/receipt，证明运行图已收敛

- [ ] **Task 13 complete: 删除迁移期旧 store/schema/receipt，证明运行图已收敛**

**Files:**
- Modify: `src/capture.mjs`
- Modify: `src/feedback-signal.mjs`
- Modify: `src/index.mjs`
- Delete: `src/schema.mjs`
- Delete: `src/store.mjs`
- Delete: `src/receipt.mjs`
- Delete: `src/lessons.mjs`
- Delete: `test/store.test.mjs`
- Delete: `test/receipt.test.mjs`
- Delete: `test/lessons.test.mjs`
- Delete: `test/fixtures/schema-v8-control-plane.mjs`
- Modify: `test/capture.test.mjs`
- Modify: `test/control-store.test.mjs`
- Modify: `test/runtime.test.mjs`

**Interfaces:**
- Consumes: all normal runtime storage through `openControlStore()`
- Produces: `stripSyntheticAflControlText(text) -> { text, syntheticOnly }` in `feedback-signal.mjs`
- Removes: `paths.storeFile`, `openStore`, legacy schema migration, receipt renderer/parser and every long-term database body API
- Preserves: legacy SQL access only inside `legacy-export.mjs`

- [ ] **Step 1: Write RED import-graph and synthetic-filter tests**

```js
assert.equal(stripSyntheticAflControlText("[AFL] queued\n<!--afl-receipt id=x--> ").syntheticOnly, true);
assert.equal(stripSyntheticAflControlText("business answer\n[AFL] queued\n<!--afl-receipt id=x-->").text, "business answer");
assert.equal("storeFile" in pathsFor(tempHome), false);
assert.equal("controlDatabase" in pathsFor(tempHome), true);
```

Add a module-graph test that starts from `bin/agent-feedback-loop.mjs`, follows static relative imports, and asserts the reachable set excludes `schema.mjs`, `store.mjs`, `receipt.mjs`, `notification-delivery.mjs`, `codex-reconcile.mjs` and `reconcile-scheduler.mjs` before those files are deleted.

- [ ] **Step 2: Run RED**

Run: `node --test --test-name-pattern='synthetic control stripping no longer needs receipt transport|normal runtime imports only the control store|legacy database has no normal path alias' test/capture.test.mjs test/control-store.test.mjs test/runtime.test.mjs`

Expected: FAIL because capture still imports `receipt.mjs`, `paths.storeFile` still exists for the old runtime, and the legacy modules remain reachable.

- [ ] **Step 3: Move the narrow synthetic parser and delete the legacy runtime**

Implement `stripSyntheticAflControlText` as a bounded parser for only the exact legacy visible-line plus adjacent canonical marker shape. It must preserve fabricated, fenced, mismatched and mixed business text exactly as the current safety tests require, but expose no render/delivery API.

Update all remaining imports to `control-store.mjs`/`control-schema.mjs`; remove `paths.storeFile` and old migration/lesson/notification APIs. Before deleting `test/store.test.mjs`, transfer every still-valid invariant into focused new tests: private directory/database modes, observation replay/race idempotency, encrypted-blob reference safety, capture-policy rejection, bounded reviewer context, transaction rollback, lease fencing, WAL reopen, and body-free schema. Mark only tests for receipt, notification, episode batching, maintenance scheduler, lesson/card DB or hold as intentionally rejected behavior in the audit document. Delete the legacy files/tests/fixture only after the transferred tests pass. `legacy-export.mjs` keeps its own literal read-only SELECT statements and must not import deleted code.

- [ ] **Step 4: Run the full suite and source scans**

Run: `npm test`

Expected: PASS with zero failures after old tests are either transferred to the new modules or deleted as rejected behavior.

Run: `rg -n 'from "\./(store|schema|receipt|notification-delivery|codex-reconcile|reconcile-scheduler)\.mjs"|memory_overflow_hold|submitDueReview|feedback_candidate_event_ids' src templates test`

Expected: no matches.

Run: `rg -l 'review_receipts|report_contents|lesson_revisions' src test`

Expected: exactly `src/legacy-export.mjs` and `test/legacy-export.test.mjs`.

Run: `rg -n 'notification|receipt|episode|maintenance|scheduler|lesson/card|memory hold' docs/verification/2026-07-16-legacy-control-plane-audit.md`

Expected: every old architecture family has an explicit delete/reject disposition and replacement task; there are no unclassified entries.

- [ ] **Step 5: Commit**

```bash
git add -A src test
git commit -m "refactor: remove the legacy feedback runtime"
```

### Task 14: 收敛 doctor、日志、安装文档和包内容

- [ ] **Task 14 complete: 收敛 doctor、日志、安装文档和包内容**

**Files:**
- Modify: `src/index.mjs:560-680`
- Modify: `src/cli.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `README-zh.md`
- Modify: `templates/rules/feedback-loop.md`
- Modify: `test/runtime.test.mjs`
- Modify: `test/cli.test.mjs`

**Interfaces:**
- Produces: doctor status `promptHook`, `controlStore`, `reflectionDirectory`, `reviewerProvider`, `legacyStopRemoved`, `ready`
- Produces: fixed structured event names from the Design Doc and bounded fields only
- Produces: package contents with no deleted Stop/receipt/notification/reconcile artifacts
- Produces: breaking pre-1.0 runtime version `0.8.0`, consistent in package metadata, installer paths and doctor

- [ ] **Step 1: Write RED doctor, log-privacy and pack-content tests**

```js
assert.deepEqual(Object.keys(doctor.status).sort(), [
  "controlStore", "legacyStopRemoved", "promptHook", "ready", "reflectionDirectory", "reviewerProvider"
]);
assert.doesNotMatch(JSON.stringify(doctor), /scheduler|notification|maintenance|receipt/);
assert.equal(packageJson.version, runtimeVersion);
assert.equal(runtimeVersion, "0.8.0");
assert.doesNotMatch(runtimeLog, /secret-user-text|full-review-body|method-body/);
```

Add `npm pack --dry-run --json` assertions that deleted modules/templates are absent and `reviewer-result.schema.json`, `reflection-document.mjs`, `feedback-signal.mjs` are present.

Add adversarial logger inputs in which a caller passes prompt/report text through an allowed key such as `reason` or `document`; assert the logger emits `invalid_reason_code`/an opaque hash rather than trusting the field name alone.

- [ ] **Step 2: Run RED**

Run: `node --test --test-name-pattern='doctor reports only the prompt and document pipeline|structured logs never contain content|package excludes removed control plane files' test/runtime.test.mjs test/cli.test.mjs`

Expected: FAIL because doctor/package/docs still describe scheduler, receipt, lesson DB and Stop behavior.

- [ ] **Step 3: Implement bounded diagnostic surfaces and update documentation**

Use an allowlist logger:

```js
const LOG_FIELDS = new Set(["event", "job", "document", "family", "reason", "count", "bytes", "tokens", "attempt", "lease_epoch", "duration_ms", "result"]);
export function structuredLog(event, fields) {
  const safe = validateLogFields(event, fields, LOG_FIELDS);
  process.stderr.write(`${JSON.stringify(safe)}\n`);
}
```

`validateLogFields` must enforce enum event/reason/result codes, opaque id/hash patterns and bounded non-negative integers; unknown or content-shaped values are replaced by fixed reason codes, never truncated raw text. Document the exact timing boundary: current prompt never waits; the publication cutoff guarantees a valid document can affect only a later matching prompt. Explain direct Markdown selection, control DB/legacy DB separation, no RAG/scheduler, macOS/Linux support, dry-run/export/apply procedure, troubleshooting, rollback to hooks-disabled state and explicit live-install authorization.

- [ ] **Step 4: Run tests and packaging checks**

Run: `node --test test/runtime.test.mjs test/cli.test.mjs`

Expected: PASS.

Run: `npm pack --dry-run --json`

Expected: exit 0; file list contains no deleted control-plane artifact.

- [ ] **Step 5: Commit**

```bash
git add src/index.mjs src/cli.mjs package.json README.md README-zh.md templates/rules/feedback-loop.md test/runtime.test.mjs test/cli.test.mjs
git commit -m "docs: describe the immediate reflection pipeline"
```

### Task 15: 完成端到端、macOS 和 Linux 候选发布验证

- [ ] **Task 15 complete: 完成端到端、macOS 和 Linux 候选发布验证**

**Files:**
- Modify: `test/e2e-smoke.test.mjs`
- Create: `test/platform-smoke.test.mjs`
- Create: `docs/verification/2026-07-16-immediate-subagent-reflection-build.md`
- Modify: `openspec/changes/isolate-feedback-control-plane/tasks.md`
- Modify: `openspec/changes/isolate-feedback-control-plane/.comet/subagent-progress.md`

**Interfaces:**
- Consumes: all runtime interfaces from Tasks 1–13
- Produces: reproducible build evidence without real HOME writes
- Produces: a release-candidate boundary that still requires explicit user authorization before global hook/runtime/database changes

- [ ] **Step 1: Write the end-to-end RED scenarios before final integration fixes**

Add subprocess tests using a temporary HOME and project:

Before any command in this task, record SHA-256 plus size/mtime for the guarded real paths into `/tmp/afl-real-home-before.txt` without opening SQLite through AFL:

```bash
for file in "$HOME/.codex/config.toml" "$HOME/.agent/feedback-loop/current.json" "$HOME/.agent/feedback-loop-data/store/feedback-loop.sqlite3" "$HOME/.agent/feedback-loop-data/store/feedback-loop.sqlite3-wal" "$HOME/.agent/feedback-loop-data/store/feedback-loop.sqlite3-shm"; do
  if test -e "$file"; then shasum -a 256 "$file"; stat -f '%N %z %m' "$file"; else echo "MISSING $file"; fi
done > /tmp/afl-real-home-before.txt
```

```js
assert.equal(firstPrompt.elapsedMs < 2_000, true);
assert.doesNotMatch(firstPrompt.stdout + firstPrompt.stderr, /\[AFL\]|afl-receipt|Output this receipt|reviewer.*queued/);
assert.equal(controlStore.countReviewJobs(), 1);
await waitFor(() => listReflectionFiles(projectDir).length === 1, 10_000);
assert.match(nextMatchingPrompt.additionalContext, /method change/);
assert.equal(fiveDocumentPrompt.hold, undefined);
```

The required completed-turn dissatisfaction sentence must drive this scenario. Add a false-positive scenario for `reviewer job 是干嘛的？` that creates zero job/document.

Complete the effectiveness chain in the same disposable project: first feedback publishes family A; the next matching prompt emits its method; a later distinct feedback is reviewer-confirmed as family A and publishes a new immutable document with `recurrence_after_emission`; the following matching prompt selects only the newest family method. Also prove a document published during a hook is excluded by that hook's cutoff and appears only on the next prompt.

- [ ] **Step 2: Run RED and diagnose only integration gaps**

Run: `node --test test/e2e-smoke.test.mjs test/platform-smoke.test.mjs`

Expected: FAIL only where completed modules are not yet wired; if a previously approved task behavior is broken, return to that task's implementer and review rather than patching it silently here.

- [ ] **Step 3: Complete minimal integration and run the full Node suite**

Run: `npm test`

Expected: all tests pass with zero failures; report the exact test count and duration. No test name should claim Stop, receipt, notification delivery, three-turn feedback, scheduler, database lesson or memory hold behavior.

- [ ] **Step 4: Run fresh temporary-HOME and package verification on the real macOS host**

Run:

```bash
TMP_HOME="$(mktemp -d)"
node ./bin/agent-feedback-loop.mjs install --home "$TMP_HOME"
AFL_SMOKE_HOME="$TMP_HOME" AFL_REAL_PROVIDER=1 node --test test/platform-smoke.test.mjs
node ./bin/agent-feedback-loop.mjs doctor --home "$TMP_HOME"
rm -rf "$TMP_HOME"
```

Expected: prompt-only install, the locally installed real isolated reviewer provider is invoked outside the parent turn, Markdown is atomically published, next prompt emits guidance, doctor ready, and no AFL Stop/scheduler configuration exists. The test passes the disposable controller home explicitly through `AFL_SMOKE_HOME` while leaving the provider's normal authentication environment intact; Codex still runs `--ephemeral --ignore-user-config`, and guarded real config/runtime/database hashes must not change. If the provider executable/authentication is unavailable, the test must report `real_provider_unavailable` and Task 15 remains incomplete; a fake provider cannot satisfy this macOS evidence. Record command output and filesystem assertions in the verification report; do not treat protocol success as Codex desktop UI proof.

- [ ] **Step 5: Run the same smoke contract in a real Linux environment**

Use the available Linux CI/container/VM with Node `>=24.15.0`; mount only the repository and a disposable HOME. Run:

```bash
npm test
TMP_HOME="$(mktemp -d)"
node ./bin/agent-feedback-loop.mjs install --home "$TMP_HOME"
AFL_SMOKE_HOME="$TMP_HOME" node --test test/platform-smoke.test.mjs
rm -rf "$TMP_HOME"
```

Expected: exit 0 for every command; detached/unref, lease recovery, permissions and atomic rename behave identically. If no real Linux executor is available, leave OpenSpec 7.3 unchecked and record the exact infrastructure blocker; do not substitute a mocked `process.platform` assertion for Linux proof.

- [ ] **Step 6: Verify the real user environment was not touched**

Repeat the Step 1 read-only loop into `/tmp/afl-real-home-after.txt`, then run `diff -u /tmp/afl-real-home-before.txt /tmp/afl-real-home-after.txt`. Expected: no diff; global AFL hooks remain disabled. If another user process legitimately changes a guarded file during the window, stop and report the external-state conflict instead of overwriting or normalizing it.

- [ ] **Step 7: Update task evidence and commit**

Check each OpenSpec item only when its cited command/output exists. Keep real Codex desktop installation/visibility acceptance explicitly pending for the later user-authorized verify stage.

```bash
git add test/e2e-smoke.test.mjs test/platform-smoke.test.mjs docs/verification/2026-07-16-immediate-subagent-reflection-build.md openspec/changes/isolate-feedback-control-plane/tasks.md openspec/changes/isolate-feedback-control-plane/.comet/subagent-progress.md
git commit -m "test: verify the immediate reflection pipeline"
```

## OpenSpec Coverage Matrix

| OpenSpec task | Implementation task |
|---|---|
| 1.1 故障 fixture | Tasks 3, 4, 10, 15 |
| 1.2 审计 `7d6b1e3..9c89e00` | Tasks 1, 3, 13 |
| 1.3 删除旧架构运行路径 | Tasks 1, 3, 7, 10, 13 |
| 2.1 默认无 Stop/控制文本 RED | Task 3 |
| 2.2 prompt-only fail-open | Tasks 3, 5 |
| 2.3 synthetic control filter | Tasks 3, 4, 13 |
| 3.1 detector 正负例 | Task 4 |
| 3.2 多证据 detector 与指定样例 | Task 4 |
| 3.3 candidate identity/job 幂等 | Tasks 2, 5 |
| 3.4 macOS/Linux detached launch | Task 6 |
| 3.5 runner lease/retry/recovery | Tasks 2, 6, 9 |
| 4.1 reviewer result validator | Task 7 |
| 4.2 Markdown 原子发布/no-lesson | Tasks 8, 9 |
| 4.3 canonical/legacy parser | Task 8 |
| 4.4 SQLite 仅短期账本 | Tasks 1, 2, 9, 13 |
| 4.5 历史 DB dry-run/export | Task 12 |
| 5.1 文档选择 RED matrix | Task 10 |
| 5.2 Top-K/移除 hold | Task 10 |
| 5.3 family 最新方法/文档 recurrence | Task 10 |
| 5.4 published/selected/emitted 边界 | Tasks 8, 9, 11 |
| 5.5 recurrence_after_emission | Task 11 |
| 6.1 installer/doctor | Tasks 3, 14 |
| 6.2 opaque structured logs | Task 14 |
| 6.3 中英文文档 | Task 14 |
| 7.1 RED→GREEN/全量/fresh HOME | Task 15 |
| 7.2 macOS Codex 边界 | Task 15；真实 desktop 可见性保留到用户授权后的 verify |
| 7.3 Linux 真实环境 | Task 15 |
| 7.4 历史 DB 两次导出 | Tasks 12, 15 |
| 7.5 不恢复真实 hooks/runtime/DB | Global Constraints, Task 15 |

## Plan Self-Review Checklist

- 每个 capability 都有实现任务和 RED/GREEN 命令；29 个 OpenSpec task 均已映射。
- 任务接口顺序一致：control store → detector/job → launcher → reviewer result → document → runner → selector/effect → export/doctor → E2E。
- 没有任务要求 Stop、receipt、notification、三条批处理、resident scheduler、maintenance 或 RAG。
- 旧 DB 只在 Task 12 通过显式只读路径访问；正常 runtime 只使用 `control.sqlite3` 和 Markdown。
- 真机证据严格区分 temporary-HOME macOS/Linux build proof 与尚需用户授权的真实 Codex desktop 安装/可见性 proof。
