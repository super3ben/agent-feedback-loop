# Convergence Kernel Guard Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the proven SDD Review Loop Guard semantics into AFL as a lightweight Convergence Kernel that detects evidence-free repeated work, launches bounded reflection, and grants exactly one authorized next generation without disturbing the main conversation.

**Architecture:** Keep AFL's existing prompt-only feedback learning plane intact. Add a pure deterministic kernel, four lean SQLite control tables, an SDD workflow adapter, and a separately validated detached Reflection Probe; expose weaker checkpoint/audit adapters only where the host lacks a real mutation gate. Migrate the existing Guard through dry-run import, shadow comparison, and explicit per-repository cutover so AFL becomes the sole authority only after parity is proven.

**Tech Stack:** Node.js 24.15+ ESM, `node:sqlite`, `node:test`, SHA-256 digests, direct detached child processes, JSON Schema, Git common-directory lineage, macOS and Linux.

## Global Constraints

- The installed synchronous surface remains prompt-only; no Stop/AfterAgent control loop may be added.
- Prompt handling is fail-open and never emits Guard status, grants, receipts, hook prompts, or recovery text.
- Explicit Guard workflow commands are fail-closed on missing authorization, corrupt state, unsafe paths, or grant mismatch.
- Long-term experience remains only in `.agent/reflections/*.md`; SQLite stores no prompt, diff, reviewer, Probe, contract, or lesson body.
- No resident scheduler, maintenance service, RAG layer, vector database, notification transport, or long-term dual-write is introduced.
- A semantic model may recommend an action but cannot create a hard gate, raise task importance, reset history, declare a distinct finding, or sign a grant.
- `routine` work pauses on the first evidence-free scope expansion; `important` work has at most one falsifiable exploration grant; `critical` work requires new verified evidence for every generation.
- The first supported platforms are macOS and Linux; Windows returns `unsupported_platform` before any strong-gate side effect.
- Existing Guard fingerprints, failure counts, fix generations, aliases, distinct declarations, checkpoints, consumed receipts, and closed-loop regressions are preserved during migration.
- Three formal repair/review rounds for one feature trigger an architecture checkpoint; only main-conversation interference, data loss/unrecoverability, security/privacy, or frozen core acceptance failures remain blocking.

---

## File Structure

### New production files

- `src/convergence-identity.mjs` — secure Git-common-dir lineage, opaque task identity, and bounded contract projection.
- `src/convergence-policy.mjs` — pure Breaker predicates, importance budgets, decision lattice, and state transition validation.
- `src/convergence-store.mjs` — transactional convergence task/loop/event/probe/grant API layered onto the existing SQLite connection.
- `src/convergence-sdd-adapter.mjs` — maps the existing Guard command contract to Kernel operations without importing the Python implementation at runtime.
- `src/convergence-probe-result.mjs` — exact Reflection Probe result validator.
- `src/convergence-probe-runner.mjs` — claims a Probe lease, builds bounded context, calls the isolated provider, and records only outcome/digest.
- `src/convergence-probe-launcher.mjs` — macOS/Linux detached one-shot launcher and bounded opportunistic recovery.
- `src/convergence-controller.mjs` — Breaker → Probe → policy decision → one-shot grant orchestration.
- `src/convergence-migration.mjs` — old Guard dry-run import, apply, shadow parity, explicit cutover, and rollback metadata.
- `src/convergence-adapters.mjs` — OpenSpec/Comet checkpoint projection and generic audit-only projection.
- `src/convergence-learning.mjs` — task-resolution effectiveness evidence and Markdown-learning handoff without automatic policy creation.
- `src/convergence-cli.mjs` — strict parser and machine-readable output for explicit `guard` commands.
- `templates/prompts/convergence-probe.md` — bounded Reflection Probe contract.
- `templates/schemas/convergence-probe-result.schema.json` — provider-visible result schema.

### Modified production files

- `src/control-schema.mjs` — version 2 schema and canonical signatures for four new tables.
- `src/control-store.mjs` — transactional v1→v2 migration and composition of `createConvergenceStoreApi`.
- `src/reviewer-provider.mjs` — accept a declared result kind/schema while retaining provider isolation and no-tool policy.
- `src/cli.mjs` — dispatch explicit `guard` and internal `convergence-probe-run` commands without changing prompt output.
- `src/index.mjs` — 0.9.0 runtime paths, template installation, doctor capabilities, and no new hook.
- `package.json` — version 0.9.0 and packaged convergence templates/modules.
- `README.md`, `README-zh.md`, `templates/rules/feedback-loop.md` — document actual capability levels and activation boundary.

### New tests and fixtures

- `test/convergence-identity.test.mjs`
- `test/convergence-policy.test.mjs`
- `test/convergence-store.test.mjs`
- `test/convergence-sdd-adapter.test.mjs`
- `test/convergence-probe-result.test.mjs`
- `test/convergence-probe.test.mjs`
- `test/convergence-controller.test.mjs`
- `test/convergence-migration.test.mjs`
- `test/convergence-adapters.test.mjs`
- `test/convergence-learning.test.mjs`
- `test/fixtures/guard/open-first-failure.json`
- `test/fixtures/guard/second-failure-direction.json`
- `test/fixtures/guard/closed-regression.json`
- `test/fixtures/guard/architecture-failed.json`

---

### Task 1: Repository Lineage and Contract Projection

**Files:**
- Create: `src/convergence-identity.mjs`
- Create: `test/convergence-identity.test.mjs`

**Interfaces:**
- Produces: `ensureRepositoryLineage({ repoRoot, execFileImpl?, randomBytesImpl? }): Promise<{ lineageId, commonDir }>`
- Produces: `deriveTaskUid({ lineageId, adapterKind, nativeTaskId }): string`
- Produces: `projectContract(input): { sourceKind, sourceRefDigest, sourceRevision, revision, requirements, exclusions, importance, importanceAuthority }`
- Produces: `digestDecisionBasis(input): string`
- Consumes: no new project modules.

- [ ] **Step 1: Write failing lineage and projection tests**

```js
test("linked worktrees share one private lineage while separate clones do not", async () => {
  const first = await gitFixture();
  const linked = await addLinkedWorktree(first.root);
  const second = await gitFixture();
  const a = await ensureRepositoryLineage({ repoRoot: first.root });
  const b = await ensureRepositoryLineage({ repoRoot: linked });
  const c = await ensureRepositoryLineage({ repoRoot: second.root });
  assert.equal(a.lineageId, b.lineageId);
  assert.notEqual(a.lineageId, c.lineageId);
  assert.equal((await lstat(path.join(a.commonDir, "afl-lineage-id"))).mode & 0o777, 0o600);
});

test("inferred requirements remain advisory and cannot raise importance", () => {
  const projected = projectContract({
    sourceKind: "user_request",
    sourceRef: "turn-7",
    sourceRevision: "rev-1",
    requirements: [{ id: "main-chat-safe", authority: "explicit_user" }],
    exclusions: [{ id: "no-scheduler", authority: "approved_spec" }],
    importance: "critical",
    importanceAuthority: "inferred_advisory"
  });
  assert.equal(projected.importance, "routine");
  assert.equal(projected.requirements[0].hard, true);
  assert.equal(projected.revision.length, 64);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/convergence-identity.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/convergence-identity.mjs`.

- [ ] **Step 3: Implement secure lineage and canonical projection**

```js
export const CONTRACT_AUTHORITIES = Object.freeze(new Set([
  "explicit_user", "approved_spec", "approved_plan", "verified_runtime",
  "review_finding", "inferred_advisory"
]));
const HARD_AUTHORITIES = new Set(["explicit_user", "approved_spec", "approved_plan", "verified_runtime"]);

export async function ensureRepositoryLineage({
  repoRoot,
  execFileImpl = execFile,
  randomBytesImpl = randomBytes
} = {}) {
  if (!SUPPORTED_PLATFORMS.has(process.platform)) throw coded("unsupported_platform");
  const root = await ownedRealDirectory(repoRoot);
  const output = await execFileText(execFileImpl, "git", ["-C", root, "rev-parse", "--git-common-dir"]);
  const commonDir = await ownedRealDirectory(path.resolve(root, output.trim()));
  const lineageFile = path.join(commonDir, "afl-lineage-id");
  const existing = await readPrivateRegularFileIfPresent(lineageFile);
  if (existing !== null) return { lineageId: validateLineage(existing), commonDir };
  const lineageId = randomBytesImpl(32).toString("hex");
  await writeFile(lineageFile, `${lineageId}\n`, { flag: "wx", mode: 0o600 });
  await chmod(lineageFile, 0o600);
  return { lineageId: validateLineage(await readFile(lineageFile, "utf8")), commonDir };
}

export function deriveTaskUid({ lineageId, adapterKind, nativeTaskId }) {
  return framedDigest([validateLineage(lineageId), boundedId(adapterKind), boundedId(nativeTaskId)]);
}

export function projectContract(input) {
  const requirements = normalizeClauses(input.requirements);
  const exclusions = normalizeClauses(input.exclusions);
  const authority = CONTRACT_AUTHORITIES.has(input.importanceAuthority)
    ? input.importanceAuthority : "inferred_advisory";
  const requestedImportance = ["routine", "important", "critical"].includes(input.importance)
    ? input.importance : "routine";
  const importance = HARD_AUTHORITIES.has(authority) ? requestedImportance : "routine";
  const canonical = { sourceKind: boundedId(input.sourceKind), sourceRefDigest: sha256(input.sourceRef),
    sourceRevision: boundedId(input.sourceRevision), requirements, exclusions, importance,
    importanceAuthority: authority };
  return { ...canonical, revision: sha256(stableJson(canonical)) };
}
```

The file must also implement the referenced bounded validators, length-prefixed digest, stable JSON serializer, owner/mode/symlink checks, and coded errors directly in this module. Each helper receives only strings or plain records and rejects NUL, non-canonical IDs, values over its fixed bound, and unsupported platforms before filesystem writes.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/convergence-identity.test.mjs`

Expected: PASS, including real linked-worktree and mode assertions on macOS.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/convergence-identity.mjs test/convergence-identity.test.mjs
git commit -m "feat: add convergence lineage and contract projection"
```

---

### Task 2: Deterministic Convergence Policy

**Files:**
- Create: `src/convergence-policy.mjs`
- Create: `test/convergence-policy.test.mjs`

**Interfaces:**
- Consumes: canonical contract projection and decision-basis digest from Task 1.
- Produces: `evaluateConvergence(request): ConvergenceDecision`
- Produces: `validateTransition({ from, eventType, to }): true`
- Produces: frozen enums `DECISIONS`, `BREAKER_REASONS`, `GRANT_PURPOSES`, `ADAPTER_CAPABILITIES`.

- [ ] **Step 1: Write the full policy matrix as failing table tests**

```js
const cases = [
  ["routine first scope expansion", routine({ acceptanceSatisfied: true, addsArchitecture: true }),
    "reflection_required", "acceptance_satisfied_scope_expansion"],
  ["same basis next generation", routine({ currentGeneration: 1, requestedGeneration: 2 }),
    "reflection_required", "unchanged_basis_repeated_mutation"],
  ["same invariant second failure", sdd({ failureCount: 2 }),
    "checkpoint_required", "repeated_review_invariant"],
  ["architecture failure", sdd({ failureCount: 3, lastGrantPurpose: "architecture_fix" }),
    "human_decision", "architecture_fix_failed"],
  ["important first falsifiable exploration", important({ explorationUsed: false,
    riskHypothesis: "atomic grant consumption may race", falsificationTest: "run two consumers" }),
    "pass", "exploration_grant_available"],
  ["important second exploration", important({ explorationUsed: true }),
    "checkpoint_required", "exploration_budget_exhausted"],
  ["critical without new evidence", critical({ evidenceChanged: false }),
    "checkpoint_required", "critical_evidence_required"],
  ["generic weak evidence", generic({ addsArchitecture: true, evidenceQuality: "partial" }),
    "warn", "unjustified_architecture_expansion"]
];
for (const [name, input, decision, reasonCode] of cases) {
  test(name, () => assert.deepEqual(evaluateConvergence(input),
    assertDecision({ decision, reasonCode, enforcement: expectedEnforcement(input) })));
}
```

Add explicit negative fixtures proving file saves do not open generations, new verified evidence changes the basis, a reviewer wording change does not, and semantic recommendations cannot raise importance or clear failure history.

- [ ] **Step 2: Run the policy test and verify RED**

Run: `node --test test/convergence-policy.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/convergence-policy.mjs`.

- [ ] **Step 3: Implement the pure decision lattice**

```js
const CAPABILITY_RANK = Object.freeze({ audit_only: 0, checkpoint_gate: 1, workflow_gate: 2, tool_gate: 3 });

export function evaluateConvergence(request) {
  const value = validateRequest(request);
  const trigger = firstTrigger([
    explicitExclusionTouched(value),
    architectureFixFailed(value),
    repeatedReviewInvariant(value),
    acceptanceSatisfiedScopeExpansion(value),
    unjustifiedArchitectureExpansion(value),
    oscillation(value),
    evidenceFreeSameInvariant(value),
    unchangedBasisRepeatedMutation(value),
    exhaustedExploration(value),
    criticalEvidenceMissing(value)
  ]);
  if (!trigger) return decision("pass", "basis_changed_or_scope_aligned", value, false);
  const semanticOnly = trigger.evidenceRequired && value.evidenceQuality !== "verified";
  const requested = semanticOnly ? "warn" : trigger.decision;
  return decision(requested, trigger.reasonCode, value, requested === "reflection_required");
}

function decision(requested, reasonCode, value, probeRequired) {
  const maximum = capabilityMaximum(value.adapterCapability);
  const effective = clampDecision(requested, maximum);
  return Object.freeze({ decision: effective, requestedDecision: requested, reasonCode,
    enforcement: enforcementFor(effective, value.adapterCapability), probeRequired,
    policyRevision: POLICY_REVISION });
}
```

Implement each predicate as a side-effect-free function with one reason code and explicit required inputs. `validateTransition` must encode only the state graph from the approved design and reject unknown event/state combinations.

- [ ] **Step 4: Run policy and identity tests**

Run: `node --test test/convergence-policy.test.mjs test/convergence-identity.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/convergence-policy.mjs test/convergence-policy.test.mjs
git commit -m "feat: add deterministic convergence breaker"
```

---

### Task 3: Schema v2 and Atomic Convergence Store

**Files:**
- Create: `src/convergence-store.mjs`
- Create: `test/convergence-store.test.mjs`
- Modify: `src/control-schema.mjs`
- Modify: `src/control-store.mjs`
- Modify: `test/control-store.test.mjs`
- Modify: `test/runtime.test.mjs`

**Interfaces:**
- Consumes: policy enums and transition validator from Task 2.
- Produces through the existing control store object:
  - `upsertConvergenceTask(input)`
  - `recordConvergenceReview(input)`
  - `addConvergenceAlias(input)`
  - `declareConvergenceDistinct(input)`
  - `recordConvergenceEvidence(input)`
  - `recordConvergenceCheckpoint(input)`
  - `recordConvergenceDecision(input)`
  - `requestConvergenceGeneration(input)`
  - `requestConvergenceProbe(input)`
  - `claimConvergenceProbe(input)`
  - `completeConvergenceProbe(input)`
  - `failConvergenceProbe(input)`
  - `issueContinuationGrant(input)`
  - `consumeContinuationGrant(input)`
  - `resolveConvergenceLoop(input)`
  - `getConvergenceStatus(input)`
  - `transactionalGuardImport(input)`

- [ ] **Step 1: Write failing schema migration and transaction tests**

```js
test("v1 upgrades transactionally to the exact canonical v2 schema", () => {
  const paths = v1Fixture();
  const store = initializeControlStore({ paths });
  assert.equal(store.database.prepare("SELECT version FROM schema_migrations").get().version, 2);
  assert.deepEqual(listUserTables(store.database), EXPECTED_V2_TABLES);
  assert.equal(store.getReviewJob("existing-job").state, "pending");
});

test("grant consumption and generation open are one atomic single-use transition", () => {
  const store = convergenceFixture();
  const grant = store.issueContinuationGrant(grantInput());
  const first = store.consumeContinuationGrant({ token: grant.token, ...grantBinding() });
  assert.equal(first.generation, 2);
  assert.throws(() => store.consumeContinuationGrant({ token: grant.token, ...grantBinding() }),
    /grant_consumed/);
  assert.equal(store.getConvergenceStatus(loopKey()).currentGeneration, 2);
});

test("closed regression retains fingerprint failure count and generations", () => {
  const store = convergenceFixture();
  seedClosedLoop(store, { failureCount: 1, fixGeneration: 1 });
  const result = store.recordConvergenceReview(secondFailureSameInvariant());
  assert.equal(result.fingerprint, originalFingerprint());
  assert.equal(result.failureCount, 2);
  assert.deepEqual(result.fixGenerations, [1]);
  assert.equal(result.decision, "checkpoint_required");
});
```

Also test event replay idempotence, same event ID with changed digest rejection, alias collision, distinct declaration evidence, Probe lease fencing, policy/contract invalidation, concurrent grant consumers, and rollback of projection when event insertion fails.

- [ ] **Step 2: Run store tests and verify RED**

Run: `node --test test/convergence-store.test.mjs test/control-store.test.mjs`

Expected: FAIL because schema version 2 and convergence APIs do not exist.

- [ ] **Step 3: Add the exact four-table schema and v1→v2 migration**

```sql
CREATE TABLE convergence_tasks(
  task_uid TEXT PRIMARY KEY, lineage_digest TEXT NOT NULL, adapter_kind TEXT NOT NULL,
  adapter_capability TEXT NOT NULL, native_task_digest TEXT NOT NULL,
  contract_source_kind TEXT NOT NULL, contract_source_ref_digest TEXT NOT NULL,
  contract_revision TEXT NOT NULL, policy_revision TEXT NOT NULL,
  importance TEXT NOT NULL, importance_authority TEXT NOT NULL,
  state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE convergence_loops(
  fingerprint TEXT PRIMARY KEY, task_uid TEXT NOT NULL REFERENCES convergence_tasks(task_uid),
  boundary_id TEXT NOT NULL, canonical_invariant_id TEXT NOT NULL, status TEXT NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0, fix_generation INTEGER NOT NULL DEFAULT 0,
  decision_basis_digest TEXT NOT NULL, current_decision TEXT NOT NULL,
  direction_generation INTEGER NOT NULL DEFAULT 0, aliases_json TEXT NOT NULL DEFAULT '[]',
  active_grant_id TEXT, probe_kind TEXT, probe_state TEXT, probe_attempt INTEGER NOT NULL DEFAULT 0,
  probe_owner_id TEXT, probe_lease_epoch INTEGER NOT NULL DEFAULT 0, probe_lease_until TEXT,
  probe_next_attempt_at TEXT, probe_result_digest TEXT, version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(task_uid, boundary_id, canonical_invariant_id)
);
CREATE TABLE convergence_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_uid TEXT NOT NULL UNIQUE,
  task_uid TEXT NOT NULL REFERENCES convergence_tasks(task_uid),
  fingerprint TEXT REFERENCES convergence_loops(fingerprint), generation INTEGER,
  event_type TEXT NOT NULL, reason_code TEXT, decision TEXT, action TEXT,
  evidence_digest TEXT, source_digest TEXT, result_digest TEXT,
  facts_json TEXT NOT NULL DEFAULT '{}', previous_event_digest TEXT,
  event_digest TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE continuation_grants(
  grant_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
  task_uid TEXT NOT NULL REFERENCES convergence_tasks(task_uid),
  fingerprint TEXT NOT NULL REFERENCES convergence_loops(fingerprint),
  current_generation INTEGER NOT NULL, next_generation INTEGER NOT NULL,
  purpose TEXT NOT NULL, scope_digest TEXT NOT NULL, contract_revision TEXT NOT NULL,
  policy_revision TEXT NOT NULL, decision_basis_digest TEXT NOT NULL,
  evidence_digest TEXT NOT NULL, state TEXT NOT NULL,
  issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, revoked_at TEXT
);
```

Set `SCHEMA_VERSION = 2`, add exact `CONTROL_SCHEMA_SQL_SIGNATURE` and `CONTROL_SCHEMA_SIGNATURE` entries, and migrate inside `BEGIN IMMEDIATE`: verify exact v1 first, create the four tables, replace the single `schema_migrations` row with version 2, verify exact v2, then commit. A failure must roll back both schema and version.

- [ ] **Step 4: Implement the convergence store API**

```js
export function createConvergenceStoreApi({ database, transaction, now, randomBytesImpl = randomBytes }) {
  const appendEvent = (input) => {
    const canonical = validateEvent(input);
    const existing = database.prepare("SELECT * FROM convergence_events WHERE event_uid=?")
      .get(canonical.eventUid);
    if (existing) {
      if (existing.event_digest !== canonical.eventDigest) throw coded("event_collision");
      return existing;
    }
    database.prepare(INSERT_EVENT_SQL).run(...eventParameters(canonical, nowIso(now)));
    return database.prepare("SELECT * FROM convergence_events WHERE event_uid=?").get(canonical.eventUid);
  };

  return {
    issueContinuationGrant(input) {
      return transaction(() => {
        const binding = validateGrantBinding(database, input);
        revokeActiveGrant(database, binding.fingerprint, nowIso(now));
        const token = randomBytesImpl(32).toString("base64url");
        insertGrant(database, binding, sha256(token), nowIso(now));
        appendEvent(grantIssuedEvent(binding));
        return { grantId: binding.grantId, token, ...publicGrantBinding(binding) };
      });
    },
    consumeContinuationGrant(input) {
      return transaction(() => {
        const grant = requireMatchingActiveGrant(database, input, sha256(input.token), nowIso(now));
        markGrantConsumed(database, grant.grant_id, nowIso(now));
        openNextGeneration(database, grant);
        appendEvent(grantConsumedEvent(grant));
        return { fingerprint: grant.fingerprint, generation: grant.next_generation, purpose: grant.purpose };
      });
    }
  };
}
```

Implement every interface method listed above with bounded validators, canonical JSON for `facts_json`, append-event-before-projection semantics in one transaction, immutable replay comparison, and lease epoch fencing. Compose the returned API into `createStore()` in `src/control-store.mjs`; do not open a second SQLite connection.

Use this exact transaction contract for the remaining methods:

| Method | Required current state | Appended event | Projection change | Return |
|---|---|---|---|---|
| `upsertConvergenceTask` | absent or identical identity | `contract_projected` on first/revision change | insert/update task revision and revoke stale grants | frozen task row |
| `recordConvergenceReview` | task exists; stable run/event ID | `review_recorded` | reopen closed loop, increment only real failed review, retain generation | loop summary + policy decision |
| `addConvergenceAlias` | canonical loop exists; alias unbound or same | `alias_declared` | append canonical bounded alias once | canonical fingerprint |
| `declareConvergenceDistinct` | evidence digest and bounded reason present | `distinct_declared` | create a separate canonical loop | new fingerprint |
| `recordConvergenceEvidence` | loop exists | `evidence_recorded` | replace basis only for trusted evidence class | basis changed boolean |
| `recordConvergenceCheckpoint` | decision requires checkpoint | `checkpoint_recorded` | increment direction generation, bind checkpoint digest | checkpoint summary |
| `recordConvergenceDecision` | loop exists | `breaker_triggered` | set current decision without changing failure count | decision summary |
| `requestConvergenceGeneration` | `pass` or valid grant path | `generation_opened` | open exactly the requested next generation | generation summary |
| `requestConvergenceProbe` | no live Probe | `reflection_requested` | set pending Probe kind/state and due time | launch reservation |
| `claimConvergenceProbe` | pending/retryable and due | `reflection_claimed` | set owner, lease epoch/deadline, increment attempt | fenced lease |
| `completeConvergenceProbe` | matching live lease | `reflection_completed` | terminal outcome/action/digest; clear owner/lease | Probe summary |
| `failConvergenceProbe` | matching live lease | `reflection_failed` | retryable with bounded backoff or terminal | Probe summary |
| `resolveConvergenceLoop` | no live grant/Probe | `task_resolved` | close or human-decision terminal state; retain history | loop summary |
| `transactionalGuardImport` | source digest not imported or identical | `legacy_imported` plus real mapped events | insert canonical task/loops/grants atomically | import summary |

`facts_json` schemas are event-specific: review stores severity/verdict/direction signal and bounded counters; alias stores alias ID; distinct stores reason code; checkpoint stores kind and file digest; Probe stores kind/attempt; grant stores purpose/generation. Unknown fields are rejected rather than silently persisted.

- [ ] **Step 5: Run schema/store regression tests**

Run: `node --test test/convergence-store.test.mjs test/control-store.test.mjs test/runtime.test.mjs`

Expected: PASS; fresh installs expose exactly twelve user tables, existing v1 evidence survives migration, and prompt-only runtime assertions remain green.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/convergence-store.mjs src/control-schema.mjs src/control-store.mjs test/convergence-store.test.mjs test/control-store.test.mjs test/runtime.test.mjs
git commit -m "feat: persist convergence state and one-shot grants"
```

---

### Task 4: SDD Workflow Adapter and Guard Command Parity

**Files:**
- Create: `src/convergence-sdd-adapter.mjs`
- Create: `src/convergence-cli.mjs`
- Create: `test/convergence-sdd-adapter.test.mjs`
- Create: `test/fixtures/guard/open-first-failure.json`
- Create: `test/fixtures/guard/second-failure-direction.json`
- Create: `test/fixtures/guard/closed-regression.json`
- Create: `test/fixtures/guard/architecture-failed.json`
- Modify: `src/cli.mjs`
- Modify: `test/cli.test.mjs`

**Interfaces:**
- Consumes: convergence store and policy decisions.
- Produces: `runGuardCommand({ args, repoRoot, store, now }): Promise<GuardCommandResult>`.
- Produces stable command verbs: `record-review`, `status`, `lock-status`, `add-alias`, `declare-distinct`, `checkpoint`, `authorize-fix`, `consume-grant`, `resolve`.
- Preserves a compatibility parser for old `consume-receipt` and `--receipt-file`, while all new machine output names the artifact `continuation_grant`.

- [ ] **Step 1: Write failing parity tests from real supported Guard states**

```js
test("first failure authorizes one local fix and the second requires direction review", async () => {
  const harness = sddHarness();
  const first = await harness.recordReview(review({ run: "review-1", verdict: "changes_required" }));
  assert.equal(first.action, "local_fix_allowed");
  const grant = await harness.authorizeFix({ mode: "local_fix" });
  await harness.consumeGrant(grant, "brief-task-7-fix-1");
  const second = await harness.recordReview(review({ run: "review-2", verdict: "changes_required" }));
  assert.equal(second.action, "direction_review_required");
  assert.equal(second.failure_count, 2);
});

test("closed regression keeps identity and architecture failure goes human", async () => {
  const harness = await sddHarnessFrom("closed-regression.json");
  const regression = await harness.recordReview(review({ run: "review-regression", verdict: "changes_required" }));
  assert.equal(regression.fingerprint, harness.fixture.fingerprint);
  assert.equal(regression.failure_count, 2);
  await harness.recordCheckpoint(directionCheckpoint());
  const grant = await harness.authorizeFix({ mode: "architecture_fix" });
  await harness.consumeGrant(grant, "brief-architecture-fix");
  const failed = await harness.recordReview(review({ run: "review-architecture", verdict: "changes_required" }));
  assert.equal(failed.action, "human_decision_required");
});
```

Add tests for exact replay, review-run collision, alias rewrite, distinct declaration reason/evidence, changed checkpoint digest, expired/changed grant, status JSON, and nonzero machine exit classification.

- [ ] **Step 2: Run adapter/CLI tests and verify RED**

Run: `node --test test/convergence-sdd-adapter.test.mjs test/cli.test.mjs`

Expected: FAIL because `guard` dispatch and the SDD adapter are absent.

- [ ] **Step 3: Implement strict parsing and adapter mapping**

```js
export async function runGuardCommand({ args, repoRoot, store, now = () => new Date() }) {
  const parsed = parseGuardArgs(args);
  const lineage = await ensureRepositoryLineage({ repoRoot });
  const task = await ensureSddTask({ store, lineage, parsed, repoRoot });
  switch (parsed.command) {
    case "record-review": return recordSddReview({ store, task, parsed, now });
    case "status": return store.getConvergenceStatus({ taskUid: task.taskUid, ...parsed });
    case "lock-status": return lockStatus({ store, task });
    case "add-alias": return addAlias({ store, task, parsed });
    case "declare-distinct": return declareDistinct({ store, task, parsed });
    case "checkpoint": return recordCheckpoint({ store, task, parsed, repoRoot });
    case "authorize-fix": return authorizeFix({ store, task, parsed });
    case "consume-grant":
    case "consume-receipt": return consumeGrantArtifact({ store, task, parsed, repoRoot });
    case "resolve": return resolveLoop({ store, task, parsed });
    default: throw coded("guard_invalid_arguments");
  }
}
```

Use an exact allowlist for flags and enums. `checkpoint` and grant artifact paths must be owned regular files inside `repoRoot`; artifacts are `0600`, created atomically, contain the token only in their private JSON body, and are deleted after successful consumption. CLI stdout is exactly one JSON object; stderr contains only bounded reason codes. No `guard` branch may be reachable from prompt-hook output.

- [ ] **Step 4: Wire explicit CLI dispatch**

```js
export async function main(args) {
  if (args[0] === "guard") {
    const result = await executeGuardCli(args.slice(1));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  // Existing legacy-export, install, doctor, reviewer-run, and hook dispatch remains unchanged.
}
```

Keep the comment as ordinary source prose only if it still describes the adjacent unchanged branches accurately; do not route `guard` through the generic prompt option parser.

- [ ] **Step 5: Run adapter, CLI, and existing Guard oracle tests**

Run: `node --test test/convergence-sdd-adapter.test.mjs test/cli.test.mjs && python3 /Users/sunxingda/.codex/skills/subagent-driven-development/tests/test_review_loop_guard.py`

Expected: both suites PASS. The Python suite is an external oracle only; production AFL code must not import it or depend on its filesystem location.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/convergence-sdd-adapter.mjs src/convergence-cli.mjs src/cli.mjs test/convergence-sdd-adapter.test.mjs test/cli.test.mjs test/fixtures/guard
git commit -m "feat: add SDD convergence workflow gate"
```

---

### Task 5: Isolated Reflection Probe Contract and Runtime

**Files:**
- Create: `src/convergence-probe-result.mjs`
- Create: `src/convergence-probe-runner.mjs`
- Create: `src/convergence-probe-launcher.mjs`
- Create: `templates/prompts/convergence-probe.md`
- Create: `templates/schemas/convergence-probe-result.schema.json`
- Create: `test/convergence-probe-result.test.mjs`
- Create: `test/convergence-probe.test.mjs`
- Modify: `src/reviewer-provider.mjs`
- Modify: `src/cli.mjs`

**Interfaces:**
- Consumes: Probe leases and event digests from the convergence store.
- Produces: `validateConvergenceProbeResult(value): ProbeResult`.
- Produces: `launchDetachedConvergenceProbe(input): LaunchResult`.
- Produces: `runConvergenceProbeJob(input): Promise<{ outcome, action, resultDigest }>`.
- Extends: `runReviewerProvider({ resultKind: "lesson" | "convergence_probe", ... })`.

- [ ] **Step 1: Write failing exact-schema and authority tests**

```js
test("validates one bounded structured conclusion without chain-of-thought", () => {
  const result = validateConvergenceProbeResult({
    assessment: "overdesigned",
    action: "simplify_current_generation",
    unmet_user_value: "No user-visible convergence protection is missing",
    wrong_assumption: "A resident scheduler is needed",
    unnecessary_scope: ["resident scheduler"],
    minimal_next_step: "Use the existing detached one-shot provider",
    falsification_test: "Demonstrate an unlaunchable candidate without a resident process"
  });
  assert.equal(result.action, "simplify_current_generation");
  assert.equal(Object.hasOwn(result, "reasoning"), false);
});

test("rejects extra keys secrets control receipts and oversized fields", () => {
  for (const value of invalidProbeResults()) {
    assert.throws(() => validateConvergenceProbeResult(value), /probe result/);
  }
});
```

Add tests proving provider output cannot set importance, policy, grant, invariant identity, failure count, or hard decision.

- [ ] **Step 2: Run Probe tests and verify RED**

Run: `node --test test/convergence-probe-result.test.mjs test/convergence-probe.test.mjs`

Expected: FAIL with missing Probe modules/templates.

- [ ] **Step 3: Implement validator and exact JSON Schema**

```js
const KEYS = new Set(["assessment", "action", "unmet_user_value", "wrong_assumption",
  "unnecessary_scope", "minimal_next_step", "falsification_test"]);
const ASSESSMENTS = new Set(["aligned_and_necessary", "wrong_direction", "overdesigned",
  "overoptimized", "insufficient_evidence", "scope_drift", "acceptance_already_satisfied"]);
const ACTIONS = new Set(["continue_once", "simplify_current_generation", "rollback_to_generation",
  "direction_checkpoint", "human_decision", "finish_now"]);

export function validateConvergenceProbeResult(value) {
  exactPlainObject(value, KEYS);
  if (!ASSESSMENTS.has(value.assessment) || !ACTIONS.has(value.action)) {
    throw coded("probe_result_invalid");
  }
  return Object.freeze({ assessment: value.assessment, action: value.action,
    unmet_user_value: boundedScannedText(value.unmet_user_value, 1024),
    wrong_assumption: boundedScannedText(value.wrong_assumption, 1024),
    unnecessary_scope: boundedUniqueArray(value.unnecessary_scope, 8, 256),
    minimal_next_step: boundedScannedText(value.minimal_next_step, 1024),
    falsification_test: boundedScannedText(value.falsification_test, 1024) });
}
```

The JSON Schema must require exactly the seven fields, use the same enums, set `additionalProperties: false`, and mirror all array and string bounds supported by provider transports.

- [ ] **Step 4: Implement detached launch and lease-fenced runner**

```js
export async function runConvergenceProbeJob({ store, taskUid, fingerprint, ownerId, provider }) {
  const lease = store.claimConvergenceProbe({ taskUid, fingerprint, ownerId, leaseMs: 240_000 });
  if (!lease) throw coded("probe_lease_lost");
  try {
    const context = buildBoundedProbeContext(store.getConvergenceStatus({ taskUid, fingerprint }));
    const raw = await provider(context, { resultKind: "convergence_probe" });
    const result = validateConvergenceProbeResult(raw);
    const resultDigest = sha256(stableJson(result));
    store.completeConvergenceProbe({ taskUid, fingerprint, ownerId,
      leaseEpoch: lease.leaseEpoch, outcome: result.assessment, action: result.action, resultDigest });
    return { outcome: result.assessment, action: result.action, resultDigest };
  } catch (error) {
    store.failConvergenceProbe({ taskUid, fingerprint, ownerId,
      leaseEpoch: lease.leaseEpoch, reasonCode: boundedProbeFailure(error) });
    throw error;
  }
}
```

The launcher follows the current reviewer launch contract: direct Node executable, detached, `stdio: "ignore"`, safe environment allowlist, `unref`, macOS/Linux only, one due recovery per explicit Guard invocation. The runner reads no main-conversation hook and writes no user-visible output.

```js
export function launchDetachedConvergenceProbe({ platform, nodeExecutable, cliFile, home,
  taskUid, fingerprint, spawnImpl = spawn, env = process.env }) {
  if (!new Set(["darwin", "linux"]).has(platform)) return { attempted: false, reason: "unsupported_platform" };
  validateLaunchInput({ nodeExecutable, cliFile, home, taskUid, fingerprint });
  try {
    const child = spawnImpl(nodeExecutable, [cliFile, "convergence-probe-run", "--home", home,
      "--task-uid", taskUid, "--fingerprint", fingerprint], {
      cwd: path.dirname(cliFile), detached: true, stdio: "ignore",
      env: safeProbeEnvironment(env), windowsHide: true
    });
    child.once?.("error", () => {});
    child.unref();
    return { attempted: true, reason: "spawn_attempted" };
  } catch {
    return { attempted: false, reason: "spawn_failed" };
  }
}
```

- [ ] **Step 5: Extend provider result-kind handling without weakening isolation**

Run the same Codex/Claude/Gemini invocation tests for both schemas. `resultKind` selects a package-owned prompt/schema pair; arbitrary schema paths are rejected. Preserve ephemeral/no-user-config/no-tools/read-only flags and process-group timeout behavior.

- [ ] **Step 6: Run Probe and provider regression tests**

Run: `node --test test/convergence-probe-result.test.mjs test/convergence-probe.test.mjs test/reviewer-provider.test.mjs test/reviewer-result-file.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

```bash
git add src/convergence-probe-result.mjs src/convergence-probe-runner.mjs src/convergence-probe-launcher.mjs src/reviewer-provider.mjs src/cli.mjs templates/prompts/convergence-probe.md templates/schemas/convergence-probe-result.schema.json test/convergence-probe-result.test.mjs test/convergence-probe.test.mjs test/reviewer-provider.test.mjs
git commit -m "feat: add isolated convergence reflection probe"
```

---

### Task 6: Breaker-to-Grant Vertical Workflow

**Files:**
- Create: `src/convergence-controller.mjs`
- Create: `test/convergence-controller.test.mjs`
- Modify: `src/convergence-sdd-adapter.mjs`
- Modify: `src/convergence-cli.mjs`
- Modify: `test/convergence-sdd-adapter.test.mjs`

**Interfaces:**
- Consumes: pure policy, store, SDD adapter, Probe launcher/result.
- Produces: `evaluateAndAdvance({ store, task, loop, request, launchProbe }): ControllerResult`.
- Produces: authorization actions `pass`, `probe_started`, `checkpoint_required`, `human_decision`, `grant_issued`, `finish`.

- [ ] **Step 1: Write failing end-to-end controller tests**

```js
test("routine evidence-free expansion pauses before the next generation and starts one Probe", async () => {
  const h = controllerHarness({ importance: "routine", capability: "workflow_gate" });
  await h.closeGeneration({ acceptanceSatisfied: true });
  const result = await h.requestNext({ addsArchitecture: true, evidenceChanged: false });
  assert.equal(result.action, "probe_started");
  assert.equal(h.launches.length, 1);
  assert.throws(() => h.openNextGeneration(), /grant_required/);
});

test("Probe continue advice alone cannot create a grant", async () => {
  const h = await pausedHarness();
  await h.completeProbe({ assessment: "aligned_and_necessary", action: "continue_once" });
  assert.throws(() => h.authorize(), /verified_basis_or_exploration_required/);
});

test("important task receives exactly one falsifiable exploration grant", async () => {
  const h = controllerHarness({ importance: "important", authority: "approved_spec" });
  const first = await h.requestNext({ riskHypothesis: "lease race", falsificationTest: "two consumers" });
  assert.equal(first.grant.purpose, "exploration");
  await h.consume(first.grant);
  const second = await h.requestNext({ riskHypothesis: "another race", falsificationTest: "three consumers" });
  assert.equal(second.action, "checkpoint_required");
});
```

Add tests for simplify/rollback constrained grants, verified new evidence, grant invalidation, finish-now, Probe failure, generic audit downgrade, second invariant failure, and architecture-fix failure.

- [ ] **Step 2: Run controller tests and verify RED**

Run: `node --test test/convergence-controller.test.mjs test/convergence-sdd-adapter.test.mjs`

Expected: FAIL because orchestration is absent.

- [ ] **Step 3: Implement deterministic orchestration**

```js
export function evaluateAndAdvance({ store, task, loop, request, launchProbe }) {
  const decision = evaluateConvergence({ ...request,
    adapterCapability: task.adapterCapability, importance: task.importance,
    importanceAuthority: task.importanceAuthority, loop });
  store.recordConvergenceDecision({ taskUid: task.taskUid, fingerprint: loop.fingerprint, ...decision });
  if (decision.decision === "reflection_required") {
    const reservation = store.requestConvergenceProbe({ taskUid: task.taskUid,
      fingerprint: loop.fingerprint, kind: "decision", reasonCode: decision.reasonCode });
    const launch = launchProbe(reservation);
    return { action: launch.attempted ? "probe_started" : "reflection_required", decision };
  }
  if (decision.decision === "checkpoint_required") return { action: "checkpoint_required", decision };
  if (decision.decision === "human_decision") return { action: "human_decision", decision };
  if (decision.decision === "finish") return { action: "finish", decision };
  return { action: decision.decision === "warn" ? "warn" : "pass", decision };
}
```

Add `authorizeAfterProbe()` that accepts the validated Probe outcome plus controller-verified evidence. It may issue only the purpose/scope allowed by deterministic policy. Wire SDD `record-review` and `authorize-fix` through this controller; no adapter may call `issueContinuationGrant` directly.

- [ ] **Step 4: Run the vertical workflow tests**

Run: `node --test test/convergence-controller.test.mjs test/convergence-sdd-adapter.test.mjs test/convergence-store.test.mjs test/convergence-probe.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

```bash
git add src/convergence-controller.mjs src/convergence-sdd-adapter.mjs src/convergence-cli.mjs test/convergence-controller.test.mjs test/convergence-sdd-adapter.test.mjs
git commit -m "feat: close the convergence breaker and grant loop"
```

---

### Task 7: Existing Guard Import, Shadow Parity, Cutover, and Rollback

**Files:**
- Create: `src/convergence-migration.mjs`
- Create: `test/convergence-migration.test.mjs`
- Modify: `src/convergence-cli.mjs`
- Modify: `test/convergence-sdd-adapter.test.mjs`

**Interfaces:**
- Consumes: old Guard schema v1 JSON and new Kernel/store.
- Produces: `inspectGuardImport(input)`, `applyGuardImport(plan)`, `compareGuardShadow(input)`, `cutoverGuard(input)`, `rollbackGuardCutover(input)`.
- Produces explicit commands: `guard import --dry-run|--apply`, `guard shadow`, `guard cutover --apply`, `guard rollback --apply`.

- [ ] **Step 1: Write failing migration safety tests**

```js
test("dry-run reports an exact bounded plan and performs no writes", async () => {
  const h = migrationHarness("closed-regression.json");
  const before = h.databaseHash();
  const plan = await inspectGuardImport(h.input());
  assert.deepEqual(plan.counts, { tasks: 1, loops: 1, events: 6, consumedGrants: 1 });
  assert.equal(h.databaseHash(), before);
  assert.equal(plan.items.every((item) => !JSON.stringify(item).includes(h.repoRoot)), true);
});

test("apply preserves real history and never invents review events", async () => {
  const h = migrationHarness("closed-regression.json");
  const imported = await applyGuardImport(await inspectGuardImport(h.input()));
  assert.equal(imported.loop.fingerprint, h.fixture.fingerprint);
  assert.equal(imported.loop.failureCount, h.fixture.failure_count);
  assert.equal(imported.events.filter((event) => event.eventType === "review_recorded").length,
    h.fixture.real_review_events.length);
});

test("cutover requires matching shadow parity and blocks long-term dual write", async () => {
  const h = migrationHarness("second-failure-direction.json");
  await h.import();
  await h.shadow({ oldDecision: "direction_review_required", newDecision: "checkpoint_required" });
  const cutover = await h.cutover();
  assert.equal(cutover.authority, "afl_sqlite");
  assert.throws(() => h.writeOldState(), /legacy_state_read_only/);
});
```

Add corrupt schema, symlink, owner/mode, source digest change, mismatch, idempotent import, already-consumed architecture grant, and rollback snapshot tests.

- [ ] **Step 2: Run migration tests and verify RED**

Run: `node --test test/convergence-migration.test.mjs`

Expected: FAIL with missing migration module.

- [ ] **Step 3: Implement bounded import and provenance**

```js
export async function inspectGuardImport({ repoRoot, stateFile, store }) {
  const source = await readOwnedGuardState({ repoRoot, stateFile });
  const parsed = validateLegacyGuardState(JSON.parse(source.text));
  const mappings = parsed.loops.map((loop) => mapLegacyLoop(parsed, loop));
  return deepFreeze({ sourceSha256: sha256(source.bytes), mappingRevision: MAPPING_REVISION,
    counts: countImport(mappings), items: mappings.map(publicImportItem), mappings });
}

export function applyGuardImport({ plan, store }) {
  return store.transactionalGuardImport({ expectedSourceSha256: plan.sourceSha256,
    mappingRevision: plan.mappingRevision, mappings: plan.mappings });
}
```

Only real legacy events become review/checkpoint/grant events. Snapshot-only values become one `legacy_imported` provenance event plus the current projection; they are not expanded into fictional history. `compareGuardShadow` is pure and writes only a bounded parity event. `cutoverGuard` verifies source digest, no pending consumed atomic action, declared parity set, and explicit `--apply` before setting per-lineage authority.

- [ ] **Step 4: Run migration and SDD parity tests**

Run: `node --test test/convergence-migration.test.mjs test/convergence-sdd-adapter.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit Task 7**

```bash
git add src/convergence-migration.mjs src/convergence-cli.mjs test/convergence-migration.test.mjs test/convergence-sdd-adapter.test.mjs
git commit -m "feat: migrate Guard authority without dual writes"
```

---

### Task 8: Checkpoint/Audit Adapters and Learning Feedback

**Files:**
- Create: `src/convergence-adapters.mjs`
- Create: `src/convergence-learning.mjs`
- Create: `test/convergence-adapters.test.mjs`
- Create: `test/convergence-learning.test.mjs`
- Modify: `src/convergence-probe-runner.mjs`
- Modify: `src/convergence-cli.mjs`

**Interfaces:**
- Produces: `projectOpenSpecCheckpoint(input)`, `projectCometCheckpoint(input)`, `projectGenericAudit(input)`.
- Produces: `recordConvergenceEffectiveness(input)` and `buildConvergenceLearningContext(input)`.
- Adds explicit commands: `guard checkpoint-evaluate`, `guard audit`, `guard resolve-effectiveness`.

- [ ] **Step 1: Write failing capability and learning tests**

```js
test("OpenSpec may hold the next task but generic audit cannot claim a mutation block", () => {
  const openspec = projectOpenSpecCheckpoint(approvedOpenSpecFixture());
  const generic = projectGenericAudit(promptOnlyFixture());
  assert.equal(openspec.adapterCapability, "checkpoint_gate");
  assert.equal(generic.adapterCapability, "audit_only");
  assert.equal(generic.maximumEnforcement, "warn");
});

test("verified effectiveness can become learning context but never a hard policy", () => {
  const event = recordConvergenceEffectiveness({ outcome: "true_positive",
    evidenceDigest: "a".repeat(64), removedScopeCount: 2, falsePositive: false });
  const context = buildConvergenceLearningContext([event]);
  assert.equal(context.facts[0].includes("2"), true);
  assert.equal(Object.hasOwn(context, "policy"), false);
  assert.equal(Object.hasOwn(context, "grant"), false);
});
```

Add fixtures proving inferred contract fields remain advisory, unapproved OpenSpec revisions cannot gate, false positives are retained, and recurrence after an emitted Markdown method is negative evidence.

- [ ] **Step 2: Run adapter/learning tests and verify RED**

Run: `node --test test/convergence-adapters.test.mjs test/convergence-learning.test.mjs`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement capability-bounded projections**

```js
export function projectOpenSpecCheckpoint(input) {
  const contract = projectContract({ ...input, sourceKind: "openspec" });
  if (input.approvalState !== "approved") return advisoryProjection(contract, "unapproved_contract");
  return Object.freeze({ adapterKind: "openspec", adapterCapability: "checkpoint_gate",
    maximumEnforcement: "checkpoint_required", contract });
}

export function projectGenericAudit(input) {
  return Object.freeze({ adapterKind: "generic_prompt", adapterCapability: "audit_only",
    maximumEnforcement: "warn", contract: projectContract(forceAdvisory(input)) });
}
```

Comet uses the same checkpoint capability but its native task ID and revision come from the active change/task artifact. No adapter writes source specifications.

- [ ] **Step 4: Implement effectiveness recording and learning handoff**

```js
export function recordConvergenceEffectiveness(input) {
  const outcome = exactEnum(input.outcome,
    ["true_positive", "false_positive", "useful_complexity", "recurrence", "unknown"]);
  return Object.freeze({ outcome, evidenceDigest: exactSha256(input.evidenceDigest),
    removedScopeCount: boundedCount(input.removedScopeCount), falsePositive: Boolean(input.falsePositive) });
}

export function buildConvergenceLearningContext(events) {
  const verified = events.filter(hasVerifiedEvidence).slice(-8);
  return Object.freeze({
    facts: verified.map(renderBoundedFact),
    candidateKind: "convergence_effectiveness",
    authority: "advisory_learning"
  });
}
```

At `resolve-effectiveness`, store the structured event. When the outcome has verified evidence, enqueue one `learning` Probe on the same loop after all decision Probes are terminal. The learning Probe uses the existing lesson result validator and Markdown publisher, but its source identity is a digest of task/loop/effectiveness event. Its published method remains advisory and cannot mutate `policy_revision`.

- [ ] **Step 5: Run adapter, learning, reviewer, and selector tests**

Run: `node --test test/convergence-adapters.test.mjs test/convergence-learning.test.mjs test/convergence-probe.test.mjs test/reviewer-runner.test.mjs test/selector.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit Task 8**

```bash
git add src/convergence-adapters.mjs src/convergence-learning.mjs src/convergence-probe-runner.mjs src/convergence-cli.mjs test/convergence-adapters.test.mjs test/convergence-learning.test.mjs test/convergence-probe.test.mjs
git commit -m "feat: add bounded adapters and convergence learning"
```

---

### Task 9: Packaging, Doctor, Documentation, and Platform Acceptance

**Files:**
- Modify: `src/index.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `README-zh.md`
- Modify: `templates/rules/feedback-loop.md`
- Modify: `test/runtime.test.mjs`
- Modify: `test/e2e-smoke.test.mjs`
- Modify: `test/platform-smoke.test.mjs`
- Modify: `test/cli.test.mjs`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: packaged 0.9.0 runtime, convergence capability diagnostics, macOS/Linux acceptance evidence, and activation instructions.

- [ ] **Step 1: Write failing packaging and prompt-isolation acceptance tests**

```js
test("0.9.0 packages convergence assets without adding a Stop hook", async () => {
  const packed = await packageFileList();
  for (const required of [
    "src/convergence-policy.mjs",
    "src/convergence-sdd-adapter.mjs",
    "templates/prompts/convergence-probe.md",
    "templates/schemas/convergence-probe-result.schema.json"
  ]) assert.equal(packed.includes(required), true, required);
  assert.equal(await installedHookNames().then((names) => names.includes("Stop")), false);
});

test("every convergence failure preserves the native prompt response exactly", async () => {
  for (const failure of ["schema_mismatch", "database_busy", "probe_spawn_failed", "identity_partial"]) {
    const response = await invokeInstalledPromptWithConvergenceFailure(failure);
    assert.deepEqual(response, nativePromptNoOp());
    assert.doesNotMatch(JSON.stringify(response), /grant|receipt|guard|probe|AFL/i);
  }
});
```

Add doctor output assertions for schema version 2, provider/Probe availability, platform support, and adapter capability without claiming cutover or real-time generic blocking.

- [ ] **Step 2: Run runtime/e2e/platform tests and verify RED**

Run: `node --test test/runtime.test.mjs test/e2e-smoke.test.mjs test/platform-smoke.test.mjs test/cli.test.mjs`

Expected: FAIL on old version, missing templates, and missing capability output.

- [ ] **Step 3: Update versioned packaging and doctor**

```js
export const RUNTIME_VERSION = "0.9.0";
```

Add `convergenceProbePrompt`, `convergenceProbeSchema`, and private grant artifact root to `pathsFor()`. Install only package assets and schema migration; do not register a new hook or activate Guard authority. Doctor reports `audit_only`, `checkpoint_gate`, and `workflow_gate` availability separately from installation/cutover state.

- [ ] **Step 4: Write truthful English and Chinese documentation**

Document:

- feedback reviewer versus convergence Probe;
- deterministic Breaker triggers and importance budgets;
- SDD full workflow gate, OpenSpec/Comet checkpoint gate, generic audit-only limit;
- `guard import --dry-run`, shadow parity, explicit per-repository cutover, and rollback;
- no Stop hook, no user-visible receipt, no resident service, no database lesson body;
- code verification, installed runtime, cutover canary, and production effectiveness as separate states.

- [ ] **Step 5: Run focused and full regressions**

Run: `node --test test/runtime.test.mjs test/e2e-smoke.test.mjs test/platform-smoke.test.mjs test/cli.test.mjs`

Expected: PASS.

Run: `npm test`

Expected: all existing 272 tests plus all new convergence tests PASS on macOS.

- [ ] **Step 6: Attempt real macOS and Linux acceptance**

On the macOS development machine:

```bash
npm test
node ./bin/agent-feedback-loop.mjs guard import --repo-root "$PWD" --state-file .superpowers/sdd/review-loop-state.json --dry-run
```

Expected: full PASS; dry-run emits one bounded JSON object and makes no database or Guard-state change.

In a supported Linux environment using the same commit:

```bash
npm test
node ./bin/agent-feedback-loop.mjs doctor --home /tmp/afl-convergence-doctor
```

Expected: full PASS; doctor reports Linux process/database support and does not claim any repository has been cut over.

If a Linux environment is unavailable, record the exact unavailable boundary and do not label Linux runtime verified.

- [ ] **Step 7: Commit Task 9**

```bash
git add src/index.mjs package.json README.md README-zh.md templates/rules/feedback-loop.md test/runtime.test.mjs test/e2e-smoke.test.mjs test/platform-smoke.test.mjs test/cli.test.mjs
git commit -m "docs: package and verify convergence guard integration"
```

---

## Final Verification and Activation Boundary

- [ ] Run `git diff --check` and confirm no whitespace errors.
- [ ] Run `npm test` and record the exact test/pass/fail counts.
- [ ] Run `npm pack --dry-run --json` and confirm only intended runtime/template files are packaged.
- [ ] Run the old Python Guard test suite as a semantic oracle; do not treat it as AFL runtime dependency.
- [ ] Inspect installed temp-HOME hooks and prove no Stop/AfterAgent AFL control hook exists.
- [ ] Inspect structured logs and prove no prompt, diff, Probe body, token, absolute path, or grant artifact content appears.
- [ ] Confirm `.superpowers/sdd/review-loop-state.json` in the real development worktree has not been modified by tests.
- [ ] Confirm the real global SDD Skill and real AFL installation remain unchanged.
- [ ] Obtain separate user authorization before changing the global SDD Skill, importing real Guard state, switching a real repository to AFL authority, or enabling a canary runtime.
