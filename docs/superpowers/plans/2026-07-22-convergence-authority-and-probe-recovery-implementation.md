---
design-docs:
  - docs/superpowers/specs/2026-07-22-repository-guard-authority-lifecycle-recovery-design.md
  - docs/superpowers/specs/2026-07-22-convergence-probe-evidence-envelope-recovery-design.md
base-ref: 97a175d
status: awaiting-user-approval
---

# Convergence Authority and Probe Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to execute this plan. Each production change must use
> `superpowers:test-driven-development`; completion claims must use
> `superpowers:verification-before-completion`.

**Goal:** Close the two architecture findings that still prevent the Convergence Guard
from being safe and useful: repository authority must be explicit and side-effect-free
until lineage/cutover permits a write, and a detached Reflection Probe must receive
bounded authoritative semantic evidence without moving bodies into SQLite or the main
conversation.

**Architecture:** Keep the existing four convergence tables, detached one-shot Probe,
grant policy, prompt-only feedback reviewer, and Markdown lesson reader. Add one
read-only repository preflight before Store selection and one strict encrypted Probe
context boundary outside SQLite. Do not add a service, scheduler, schema/table, RAG
reader, activation registry, dual-write path, or prompt/Stop output.

**Tech stack:** Node.js 24.15+ ESM, `node:sqlite`, `node:test`, Git common-directory
lineage, SHA-256, AES-256-GCM through AFL's existing key infrastructure, macOS and Linux.

## Frozen scope and review policy

- This plan owns exactly two root invariants:
  - Task 7 `guard-unimported-legacy-remains-authoritative` at
    `guard-migration/adapter-authority-before-cutover`.
  - Task 5 `probe-bounded-input-carries-semantic-decision-evidence` at
    `convergence-probe/evidence-envelope`.
- Task 9 `legacy-import-dry-run-has-supported-lineage-bootstrap` remains the same
  historical fingerprint. Its human-decision resolution points to the Task 7 root cause;
  it is never renamed or reopened.
- Execute two guarded change sets, not a chain of per-test fixers:
  1. one Task 7 `architecture_fix` receipt covers Workstream A in full;
  2. one Task 5 `architecture_fix` receipt covers Workstream B in full.
- Each receipt is persisted by the real Guard, consumed once by the generated task brief,
  and handed to one implementer. Do not hand-write a fix brief or split one invariant
  across fresh receipts.
- Each workstream receives one frozen-scope review. A failed architecture generation
  returns to `human_decision`; no local-fix retry, invariant rename, counter reset, or
  adjacent full-scope review is allowed.
- Only main-conversation interference, data corruption/unrecoverability,
  security/privacy failure, or a frozen acceptance failure blocks completion. Other
  adjacent findings go to backlog.
- Never modify or stage the pre-existing user files
  `.superpowers/sdd/task-1-report.md`, `task-2-report.md`, or `task-3-report.md`.
- Never initialize lineage, import/cut over a real repository, install into the user's
  real HOME, or re-enable hooks as part of automated verification. Use disposable Git
  repositories and temporary HOME directories.

## Current Guard evidence

Read `.superpowers/sdd/review-loop-state.json` immediately before execution; it is the
only authority. At plan creation the relevant real state was:

| Task | Invariant | State | Failures | Architecture fixes |
|---|---|---:|---:|---:|
| 9 | `legacy-import-dry-run-has-supported-lineage-bootstrap` | `blocked_human_decision` | 2 | 1 |
| 7 | `guard-unimported-legacy-remains-authoritative` | `blocked_direction_review` | 1 | 0 |
| 5 | `probe-bounded-input-carries-semantic-decision-evidence` | `blocked_direction_review` | 1 | 0 |

If the file differs, stop and diagnose the actual state. Do not reconstruct, backfill,
or overwrite events from this table.

## File responsibility map

- `src/convergence-identity.mjs`: read-only lineage discovery and explicit lineage
  creation remain separate APIs.
- `src/control-store.mjs`: add an explicitly read-only existing-Store open path; no
  schema change.
- `src/convergence-migration.mjs`: canonical legacy inspection, transition-lock
  inspection, and repository authority preflight.
- `src/convergence-cli.mjs`: parse first, preflight second, then choose no Store,
  read-only Store, existing writable Store, or explicitly initialized Store.
- `src/convergence-sdd-adapter.mjs`: operate on a supplied preflight/Store; read commands
  never call task creation, while mutating commands retain controller authority.
- `src/convergence-probe-context.mjs`: exact semantic envelope projection, validation,
  canonical serialization, digesting, strict encrypted artifact lifecycle, and bounded
  orphan cleanup. This is the only new production module.
- `src/convergence-controller.mjs`: bind reflection decisions to semantic context before
  publishing a Probe request.
- `src/convergence-store.mjs`: reuse `reflection_requested.source_digest` as the context
  digest and expose narrow read queries; no table or column is added.
- `src/convergence-probe-runner.mjs`: lease, load/decrypt/verify context, call provider
  with `{ status, evidence }`, record the terminal transition, then clean up.
- `src/convergence-probe-launcher.mjs`: unchanged detached-process authority; only the
  existing opaque task/fingerprint coordinates cross argv.
- `src/cli.mjs`: bounded stdin ingestion for explicit Guard use and context-store
  construction for the internal Probe runner.
- `src/index.mjs`: add `paths.probeContextRoot`; installation remains hook-neutral.
- `src/crypto-store.mjs`: only add the minimum strict, handle-based primitive required by
  Probe artifacts. Do not change existing reviewer-blob behavior.

---

## Workstream A: Repository authority lifecycle

One Task 7 receipt and one implementer own Tasks A1-A2 together. Task A3 is performed by
an independent frozen-scope reviewer.

### Task A0: Resolve and authorize the real Guard boundary

**Files:**
- Create: `.superpowers/sdd/task-7-authority-lifecycle-checkpoint.md`
- Create: Guard-generated Task 7 receipt/grant artifact at the path returned by the
  Guard
- Modify: `.superpowers/sdd/review-loop-state.json` only through the real Guard commands

- [ ] **Step 1: Re-read real state and script help**

Load the current `subagent-driven-development` Review Loop Guard instructions and CLI
help from disk. Confirm Task 9/7/5 match the real state; do not rely on this plan's
snapshot if they differ.

- [ ] **Step 2: Close only the Task 9 human-decision loop**

Use the Guard's human-decision/resolve operation with a decision reference naming:

```text
docs/superpowers/specs/2026-07-22-repository-guard-authority-lifecycle-recovery-design.md
root-invariant:guard-unimported-legacy-remains-authoritative
```

Verify the original Task 9 fingerprint, failure count, and architecture-fix count remain
in history. Do not create a new review event.

- [ ] **Step 3: Record the Task 7 direction checkpoint**

The checkpoint must quote the approved spec's business value, authority lattice, bounded
file scope, exclusions, falsifiable tests, and human-decision stop condition. Run the
real Guard checkpoint command; do not edit state manually.

- [ ] **Step 4: Authorize and consume exactly one architecture fix**

Run the real `authorize-fix --mode architecture_fix`, persist its JSON artifact in the
repository, then generate/consume the fix brief with the Guard receipt. Proceed only on
the success exit code. Record the artifact path in the Task 7 report.

Expected: Task 7 becomes an authorized architecture generation without altering its
fingerprint or failure count.

### Task A1: Prove and add side-effect-free repository preflight

**Files:**
- Modify: `test/convergence-identity.test.mjs`
- Modify: `test/control-store.test.mjs`
- Modify: `test/convergence-migration.test.mjs`
- Modify: `src/convergence-identity.mjs`
- Modify: `src/control-store.mjs`
- Modify: `src/convergence-migration.mjs`

**Interfaces:**
- Existing: `readRepositoryLineage(...)` stays read-only.
- New: `openControlStoreReadOnly({ paths, now?, busyTimeoutMs? })` opens only an existing
  valid database with SQLite read-only mode and never creates WAL/SHM or migrates.
- New: `inspectGuardRepository({ repoRoot, paths })` returns the frozen internal
  preflight projection from the approved design.

- [ ] **Step 1: Write failing no-side-effect tests**

Create disposable Git repositories and snapshot the Git common directory, repository,
temporary HOME, database/WAL/SHM paths, task count, and event count before/after:

```js
test("lineage-free preflight returns uninitialized before inspecting HOME", async () => {
  const h = await emptyRepository();
  const before = await h.snapshot();
  const result = await inspectGuardRepository({
    repoRoot: h.repoRoot,
    paths: poisonIfRead(h.paths)
  });
  assert.equal(result.repositoryState, "uninitialized");
  assert.equal(result.lineageId, null);
  assert.deepEqual(await h.snapshot(), before);
});

test("read-only Store inspection creates no database journal or schema bytes", async () => {
  const h = await initializedRepositoryWithExistingStore();
  const before = await h.snapshot();
  const store = openControlStoreReadOnly({ paths: h.paths });
  store.close();
  assert.deepEqual(await h.snapshot(), before);
});
```

Add matrix cases for missing Store, valid Store, invalid Store, absent legacy state,
valid repository-bound legacy state, corrupt JSON, copied repository ID, unsafe owner or
mode, symlink, and transition lock. Assert invalid state is never projected as absent.

- [ ] **Step 2: Run focused tests and observe RED**

Run:

```bash
node --test test/convergence-identity.test.mjs test/control-store.test.mjs test/convergence-migration.test.mjs
```

Expected: fail because read-only Store open and repository preflight do not exist.

- [ ] **Step 3: Implement the smallest read-only primitives**

- Reuse secure Git common-directory discovery; do not call
  `ensureRepositoryLineage` from preflight.
- Open an existing control database with the runtime's read-only SQLite option, run only
  connection/schema validation that cannot write, and return the existing Store API for
  bounded reads.
- Inspect the canonical legacy path
  `.superpowers/sdd/review-loop-state.json` using the existing owner/mode/symlink/size/
  schema/repository binding rules.
- Treat a missing canonical file as `absent` only after safe path inspection; every
  malformed or unsafe case is `invalid` and fails closed.
- Read existing import/cutover/rollback authority only from an existing valid Store.
- Return exactly one of `uninitialized`, `transition_locked`, `legacy_guard`,
  `fresh_afl_eligible`, or `afl_sqlite`.
- Emit only bounded structured diagnostics (`action`, effective state, reason code); do
  not log paths, lineage, legacy bytes, task/review text, or Store contents.

Do not create a registry, activation event, table, schema version, or alternate legacy
parser.

- [ ] **Step 4: Run focused tests to GREEN**

Run the command from Step 2. Confirm the filesystem snapshots are byte-for-byte stable.

### Task A2: Route every Guard command through preflight before Store creation

**Files:**
- Modify: `test/convergence-sdd-adapter.test.mjs`
- Modify: `test/convergence-migration.test.mjs`
- Modify: `test/cli.test.mjs`
- Modify: `src/convergence-sdd-adapter.mjs`
- Modify: `src/convergence-cli.mjs`

**Interfaces:**
- `runGuardCommand({ args, repoRoot, store?, preflight, ... })` must accept no Store for
  bounded read results.
- `executeGuardCli(args)` parses the command before selecting a Store mode.

- [ ] **Step 1: Write failing command-matrix tests**

Cover every official Guard verb with valid required arguments:

```js
test("no Guard command implicitly initializes lineage or control state", async () => {
  for (const invocation of allGuardInvocations()) {
    const h = await emptyRepository();
    const before = await h.snapshot();
    const result = await executeGuardCli(invocation(h));
    if (invocation.command === "status" || invocation.command === "lock-status") {
      assert.equal(result.payload.authority, "uninitialized");
    } else {
      assert.equal(result.payload.error, "lineage_not_initialized");
    }
    assert.deepEqual(await h.snapshot(), before);
  }
});
```

Add assertions that:

- after `lineage-init --apply`, `status`/`lock-status` report empty/unknown without a DB;
- a fresh lineage-initialized repository creates the Store only inside a successful
  explicit mutation;
- valid unimported and imported-not-cut-over legacy state blocks AFL mutation without
  changing Store counts;
- exact cutover enables AFL and rollback restores legacy authority;
- invalid legacy/Store/lock state returns a bounded error before any write;
- `status --task-id` derives a task UID in memory but performs no task upsert;
- concurrent read commands do not create tasks/events/journal files.

- [ ] **Step 2: Run focused tests and observe RED**

```bash
node --test test/convergence-sdd-adapter.test.mjs test/convergence-migration.test.mjs test/cli.test.mjs
```

- [ ] **Step 3: Implement parse → preflight → Store-mode selection**

Use this fixed routing table:

| Command/state | Store mode | Result |
|---|---|---|
| `status`, `lock-status`; no existing Store | none | bounded empty/unknown |
| `status`, `lock-status`; existing valid Store | read-only | bounded projection |
| mutation; `uninitialized` | none | `lineage_not_initialized` |
| mutation; `transition_locked` | none | `guard_authority_locked` |
| mutation; `legacy_guard` | none/read-only | `legacy_guard_authoritative` |
| mutation; `fresh_afl_eligible` | initialize after checks | execute atomically |
| mutation; `afl_sqlite` | existing writable | execute atomically |
| invalid legacy/Store | none | fail-closed bounded error |

Move task creation behind the successful mutating branch. Read commands must never call
`ensureTask`, `ensureRepositoryLineage`, `initializeControlStore`, schema migration, or
event append. Migration dry-run remains Store-free; explicit import apply may initialize
the Store only after lineage and legacy validation succeed.

- [ ] **Step 4: Run focused and migration regressions**

```bash
node --test test/convergence-identity.test.mjs test/control-store.test.mjs \
  test/convergence-migration.test.mjs test/convergence-sdd-adapter.test.mjs test/cli.test.mjs
```

- [ ] **Step 5: Commit Workstream A implementation**

Stage only the Workstream A source/tests plus the Guard-generated Task 7 checkpoint and
receipt artifacts. Verify the three pre-existing task reports are unstaged.

```bash
git commit -m "fix: enforce explicit repository guard authority"
```

### Task A3: Frozen Task 7 review and stop decision

- [ ] Run the macOS focused process tests above in real temporary Git repositories.
- [ ] Run the existing migration/cutover/rollback and linked-worktree identity tests.
- [ ] Run `npm test` once for regression evidence.
- [ ] Dispatch one reviewer with stable Review-Run-ID
  `task-7-authority-lifecycle-architecture-review-1` and the frozen acceptance list from
  the authority design.
- [ ] If approved, record the approved review in the real Guard and stop Workstream A.
- [ ] If Critical/Important within the frozen invariant, record it under the existing
  Task 7 invariant. Because this was its architecture generation, return to human
  decision; do not dispatch another fixer.
- [ ] Put non-blocking adjacent findings in a backlog document without reopening review.

---

## Workstream B: Bounded semantic Probe evidence

Start only after Workstream A reaches its stop condition. One Task 5 receipt and one
implementer own Tasks B1-B3 together.

### Task B0: Authorize the Task 5 architecture generation

**Files:**
- Create: `.superpowers/sdd/task-5-probe-evidence-checkpoint.md`
- Create: Guard-generated Task 5 receipt/grant artifact
- Modify: `.superpowers/sdd/review-loop-state.json` only through real Guard commands

- [ ] Re-read actual Task 5 state.
- [ ] Write the direction checkpoint from the approved Probe design, including the exact
  16 KiB envelope, named producer, digest-only DB, no-context fallback, encrypted
  lifecycle, and stop conditions.
- [ ] Run the real checkpoint and one `authorize-fix --mode architecture_fix`.
- [ ] Persist and consume the generated receipt through the generated fix brief before
  dispatching the implementer.

### Task B1: Validate and protect the semantic evidence artifact

**Files:**
- Create: `src/convergence-probe-context.mjs`
- Create: `test/convergence-probe-context.test.mjs`
- Modify: `src/crypto-store.mjs`
- Modify: `test/control-store.test.mjs`
- Modify: `src/index.mjs`
- Modify: `test/runtime.test.mjs`

**Interfaces:**
- `buildConvergenceProbeEvidence(input)` derives the approved exact artifact envelope
  from a named host projection plus controller/Store facts.
- `validateConvergenceProbeEvidence(value)` returns a recursively frozen, accessor-safe
  value.
- `canonicalProbeEvidence(value)` returns canonical UTF-8 JSON capped at 16 KiB.
- `ConvergenceProbeContextStore` exposes digest-addressed `put`, `read`, `remove`, and
  bounded `pruneOrphans` operations under `paths.probeContextRoot`.

- [ ] **Step 1: Write failing exact-envelope tests**

Test every required key, enum, count, identifier, digest, and text bound from the design.
Reject unknown keys, accessors, proxies, sparse/decorated arrays, unsupported prototypes,
NUL, secret/receipt patterns, invalid UTF-8, and 16 KiB overflow without invoking a
getter.

Prove identity/trigger fields come from controller facts, review summaries reconstruct
the latest decision/evidence digests, contract fields bind to the current contract
revision, and host-supplied attempts to override identity, importance, generation,
decision, or authority fail.

- [ ] **Step 2: Write failing encrypted-lifecycle tests**

Test private root/file modes, atomic publication, idempotent same-digest write,
wrong-key/corrupt/truncated/replaced/symlink/unowned/permissive rejection, and exact
digest verification before plaintext is returned. Test at most 32 cleanup inspections,
24-hour cutoff, and no deletion outside the private root.

- [ ] **Step 3: Run tests and observe RED**

```bash
node --test test/convergence-probe-context.test.mjs test/control-store.test.mjs test/runtime.test.mjs
```

- [ ] **Step 4: Implement one bounded context module**

- Add `paths.probeContextRoot =
  ~/.agent/feedback-loop-data/convergence/probe-context`.
- Reuse `BlobKeyProvider` and AES-GCM envelope mechanics. Add only a strict handle-based
  crypto primitive if the existing blob API cannot prove no-follow, ownership, exact
  mode, inode stability, and digest identity; do not change legacy reviewer blob
  semantics.
- Store files by context digest and return whether publication was newly created so a
  failed request can safely roll back only its own orphan.
- Keep plaintext, ciphertext paths, and bodies out of logs and returned machine output.

- [ ] **Step 5: Run focused tests to GREEN**

Run the command from Step 3.

### Task B2: Bind reflection request, CLI stdin, Store digest, and detached runner

**Files:**
- Modify: `test/convergence-controller.test.mjs`
- Modify: `test/convergence-sdd-adapter.test.mjs`
- Modify: `test/convergence-store.test.mjs`
- Modify: `test/convergence-probe.test.mjs`
- Modify: `test/cli.test.mjs`
- Modify: `src/convergence-controller.mjs`
- Modify: `src/convergence-sdd-adapter.mjs`
- Modify: `src/convergence-store.mjs`
- Modify: `src/convergence-probe-runner.mjs`
- Modify: `src/convergence-cli.mjs`
- Modify: `src/cli.mjs`

**Interfaces:**
- Explicit SDD CLI flag: `record-review ... --probe-context-stdin`.
- `executeGuardCli(args, { readStdin? })` reads at most 16 KiB only when that flag is
  present; semantic bytes never enter argv or a plaintext file.
- `requestConvergenceProbe(..., contextDigest)` writes the digest as
  `reflection_requested.source_digest`.
- Narrow Store readers expose the live request digest and the set of live Probe context
  digests without returning bodies.
- Provider input becomes exactly `{ status, evidence }`.

- [ ] **Step 1: Write failing producer and fallback tests**

Use two approved host projections with different goals/exclusions/evidence and prove the
provider observes those exact bounded differences. Add tests that missing, truncated,
oversized, invalid, stale-revision, stale-generation, stale-decision-basis, or
digest-mismatched input causes:

- `workflow_gate`/`checkpoint_gate`: deterministic `checkpoint_required` with
  `probe_context_required` or `probe_context_invalid`;
- `audit_only`: `warn`;
- zero artifact/request/lease/spawn/provider/grant side effects.

The SDD stdin projection contains named producer metadata, goal summary, acceptance
criteria, exclusions, importance authority, contract revision, and optional bounded
generation observations. Review hypothesis/new evidence/falsification test come from the
same `record-review` invocation; identity, counters, trigger, and digests are derived by
the controller.

- [ ] **Step 2: Write failing transaction and privacy tests**

Assert:

- context artifact is published before request and launcher runs only after commit;
- request failure removes only a newly created unreferenced artifact;
- replay reuses the same digest/request identity;
- retry keeps the same digest;
- SQLite/WAL/SHM, events except the digest, stdout/stderr, structured logs, grants,
  Markdown, and argv contain no semantic plaintext or ciphertext path;
- provider is never called before lease, context decrypt, digest verification, current
  generation, contract, and decision-basis checks all pass.

- [ ] **Step 3: Run focused tests and observe RED**

```bash
node --test test/convergence-probe-context.test.mjs test/convergence-store.test.mjs \
  test/convergence-controller.test.mjs test/convergence-sdd-adapter.test.mjs \
  test/convergence-probe.test.mjs test/cli.test.mjs
```

- [ ] **Step 4: Implement the minimal vertical path**

1. Parse/validate bounded stdin before any Store/artifact/provider side effect.
2. Build the canonical envelope only after pure policy returns
   `reflection_required`.
3. If context is missing/invalid, apply the capability fallback and do not first record
   a reflection request.
4. Publish encrypted context, then transactionally record the existing
   `reflection_requested` event with `source_digest = contextDigest`.
5. On transaction failure, remove only a newly published artifact with no live request.
6. Launch the detached Probe only after the Store transaction commits.
7. Runner claims the lease, resolves the request digest, decrypts/verifies context,
   confirms current contract/generation/decision basis, and calls the no-tool provider
   with `{ status, evidence }`.
8. Record completion/final failure first. Remove context only after a terminal Store
   transition; retain it for retryable failure.
9. Run bounded orphan cleanup only from explicit mutating Guard/Probe commands, never
   prompt hooks, `status`, `lock-status`, or a scheduler.

Log only bounded lifecycle actions, reason codes, attempts, and digests. Never log the
semantic envelope, ciphertext path, provider body, prompt, diff, review body, or grant
token.

Do not add a Store column/table, semantic body query, provider authority, or alternate
lesson path.

- [ ] **Step 5: Run focused and provider regressions**

```bash
node --test test/convergence-probe-context.test.mjs test/convergence-store.test.mjs \
  test/convergence-controller.test.mjs test/convergence-sdd-adapter.test.mjs \
  test/convergence-probe-result.test.mjs test/convergence-probe.test.mjs \
  test/reviewer-provider.test.mjs test/reviewer-result-file.test.mjs test/cli.test.mjs
```

### Task B3: Truthful packaging, platform smoke, and commit

**Files:**
- Modify: `README.md`
- Modify: `README-zh.md`
- Modify: `templates/rules/feedback-loop.md`
- Modify: `test/e2e-smoke.test.mjs`
- Modify: `test/platform-smoke.test.mjs`
- Modify: `package.json` only if the package inventory requires the new module (do not
  bump the schema or add a dependency)

- [ ] Document that semantic Probe capability is available only when a named host sends
  valid bounded context; otherwise the adapter checkpoints/warns and does not launch.
- [ ] Document encrypted context as short-lived operational data and Markdown as the
  only long-term lesson source.
- [ ] Add a macOS real-process smoke using temporary HOME/Git repositories that proves:
  explicit review → detached Probe → bounded provider context → terminal cleanup, while
  prompt handling emits no Guard/receipt/probe status.
- [ ] Run the same process test on Linux when a real Linux runner/container with Node
  24.15+ and Git is available. If unavailable, report Linux as unverified rather than
  inferring it from platform branches.
- [ ] Verify unsupported platforms return before artifact/Store/spawn side effects.
- [ ] Use Computer Use for a final non-destructive Codex Desktop check only after the
  user separately authorizes an installed-canary test; without that authority, report
  local process evidence and do not touch real hooks/HOME.
- [ ] Run:

```bash
node --test test/runtime.test.mjs test/e2e-smoke.test.mjs test/platform-smoke.test.mjs test/cli.test.mjs
npm test
npm pack --dry-run --json
git diff --check
```

- [ ] Inspect package inventory: new Probe context module is present; Guard state,
  receipts, checkpoints, temporary context, tests, and real user data are absent.
- [ ] Commit Workstream B source/tests/docs and its Guard-generated checkpoint/receipt
  artifacts, leaving Task 1-3 reports unstaged.

```bash
git commit -m "fix: bind probes to bounded semantic evidence"
```

### Task B4: Frozen Task 5 review and final stop decision

- [ ] Dispatch one reviewer with stable Review-Run-ID
  `task-5-probe-evidence-architecture-review-1` and only the Probe design's frozen
  acceptance list.
- [ ] If approved, record the approved review in the real Guard and stop Workstream B.
- [ ] If Critical/Important within the frozen invariant, record it under the original
  Task 5 invariant and return to human decision. Do not generate a second receipt.
- [ ] Record non-blocking adjacent observations in backlog without widening this change.

---

## Final evidence and handoff

- [ ] Confirm the original user-value path is still intact and independently tested:
  explicit dissatisfaction → detached reviewer → Markdown lesson → later prompt
  selection/emission.
- [ ] Confirm Guard/Probe paths never run from Stop and never print receipts or machine
  instructions into the main conversation.
- [ ] Report evidence by layer:
  1. focused unit/transaction tests;
  2. full regression count;
  3. macOS real-process smoke;
  4. Linux runner result or explicit unverified status;
  5. package inventory;
  6. installed Codex/Desktop canary only if separately authorized;
  7. real repository import/cutover remains not performed.
- [ ] Do not claim production acceptance from tests, packaging, or a temporary-HOME
  process run.
- [ ] Offer the completed branch for final review/merge; real Guard import, cutover,
  global Skill modification, hook enablement, or release publication still require
  separate user authorization.
