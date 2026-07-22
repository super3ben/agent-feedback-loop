# Task 2 Report: Deterministic Convergence Policy

## Implementation summary

Added the pure deterministic Convergence Policy and its focused Node test suite.

- `evaluateConvergence(request)` validates one strict plain-data request, normalizes elevated importance to `routine` unless authority is `explicit_user`, `approved_spec`, `approved_plan`, or `verified_runtime`, evaluates the approved trigger order, clamps `audit_only` decisions to at most `warn`, and returns one frozen plain-data decision.
- Trigger predicates use only outward observable structured facts and decision-basis digests. Semantic recommendations are bounded advisory input and cannot alter importance, failure history, or policy results.
- Important work receives at most one exploration only with both a bounded risk hypothesis and falsification test. Critical work requires changed verified evidence. File-save counts never create or return a generation.
- `validateTransition({ from, eventType, to })` accepts only the confirmed state graph, confirmed state-preserving events on nonterminal states, and `task_resolved` from a nonterminal state. Unknown fields, enum values, states, events, and undeclared edges return bounded deterministic error codes.
- Public decision, reason, grant-purpose, and adapter-capability vocabularies are frozen.

No database, store, controller, CLI, provider, hook, receipt, scheduler, service, notification, RAG, runtime install, global SDD state, or real HOME state was added or changed.

## RED evidence

Command:

```sh
node --test test/convergence-policy.test.mjs
```

Exact output:

```text
exit=1
node:internal/modules/esm/resolve:271
    throw new ERR_MODULE_NOT_FOUND(
          ^

Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/sunxingda/project/agent-feedback-loop/.worktrees/convergence-kernel/src/convergence-policy.mjs' imported from /Users/sunxingda/project/agent-feedback-loop/.worktrees/convergence-kernel/test/convergence-policy.test.mjs
    at finalizeResolution (node:internal/modules/esm/resolve:271:11)
    at moduleResolve (node:internal/modules/esm/resolve:861:10)
    at defaultResolve (node:internal/modules/esm/resolve:988:11)
    at #cachedDefaultResolve (node:internal/modules/esm/loader:700:20)
    at #resolveAndMaybeBlockOnLoaderThread (node:internal/modules/esm/loader:717:38)
    at ModuleLoader.resolveSync (node:internal/modules/esm/loader:749:52)
    at #resolve (node:internal/modules/esm/loader:682:17)
    at ModuleLoader.getOrCreateModuleJob (node:internal/modules/esm/loader:602:35)
    at ModuleJob.syncLink (node:internal/modules/esm/module_job:162:33)
    at ModuleJob.link (node:internal/modules/esm/module_job:252:17) {
  code: 'ERR_MODULE_NOT_FOUND',
  url: 'file:///Users/sunxingda/project/agent-feedback-loop/.worktrees/convergence-kernel/src/convergence-policy.mjs'
}

Node.js v26.0.0
✖ test/convergence-policy.test.mjs (58.946292ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 63.474584

✖ failing tests:

test at test/convergence-policy.test.mjs:1:1
✖ test/convergence-policy.test.mjs (58.946292ms)
  'test failed'
```

This is the required feature-absent RED: the test was created first and failed only because the production policy module did not exist.

## Focused GREEN evidence

Command:

```sh
node --test test/convergence-policy.test.mjs
```

Result:

```text
tests 23
suites 0
pass 23
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 73.7675
```

The focused suite covers the complete policy matrix, frozen trigger priority, negative generation/basis/wording/semantic-authority fixtures, adapter enforcement seams, plain immutable results, frozen public enums, all approved state-changing edges, nonterminal state-preserving events, terminal resolution, and bounded rejections.

## Identity + policy GREEN evidence

Command:

```sh
node --test test/convergence-policy.test.mjs test/convergence-identity.test.mjs
```

Result:

```text
tests 37
suites 0
pass 37
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 293.719375
```

This run included the Task 1 real macOS Git repository/linked-worktree lineage check and `0600` lineage-file assertion together with every Task 2 policy test.

## Full-suite evidence

Command, run once before commit as required:

```sh
npm test
```

Result:

```text
tests 309
suites 1
pass 309
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 24518.225375
```

## Files changed

- `src/convergence-policy.mjs` (new, committed)
- `test/convergence-policy.test.mjs` (new, committed)
- `.superpowers/sdd/task-2-report.md` (this required report, intentionally uncommitted)

Commit: `2a22080 feat: add deterministic convergence breaker`

## Self-review

- The production module is pure policy logic. Its only import is Task 1's pure `digestDecisionBasis`; it performs no filesystem, process, network, database, model, scheduling, hook, notification, or logging action.
- Trigger evaluation order is exactly: explicit exclusion, failed architecture fix, repeated review invariant, acceptance-satisfied expansion, unjustified architecture expansion, oscillation, evidence-free same invariant, unchanged-basis repeated mutation, exploration budget, critical evidence.
- Every predicate returns one fixed reason code and uses explicit structured inputs. There is no free-text recommendation path into decision importance, failure count, history, or hard policy.
- `audit_only` is the sole semantic clamp and never returns an effective decision above `warn`. Strong decisions retain their meaning for checkpoint/workflow/tool adapters while enforcement names only the real seam: next checkpoint, review/fix dispatch, or pre-mutation.
- `probeRequired` is derived from the requested deterministic reflection decision, so an audit-only clamp still preserves the asynchronous reflection request without claiming a synchronous stop.
- Canonical contract revisions and decision-basis digests are checked as 64-character lowercase SHA-256 values; the supplied evidence-change flag must agree with digest equality.
- Input objects, nested projections, arrays, and semantic recommendation envelopes must be plain data with known fields. Validation reads data descriptors without invoking accessors and creates frozen internal copies; returned decisions are frozen plain objects.
- The transition table contains only the confirmed edges. State-preserving ledger events require `from === to` and a nonterminal state; all other undeclared transitions fail with `invalid_transition`.
- `git diff --cached --check` passed before commit. Only the two requested source/test files were staged and committed; the pre-existing Task 1 report modification was left untouched and unstaged.

## Concerns

No implementation blocker remains. By the frozen three-field `validateTransition({ from, eventType, to })` interface, `breaker_triggered` can validate only that its target is one of the structurally permitted decision states; the later Store/controller must still pass the state corresponding to the already evaluated decision. This is an intentional later-task binding, not authority added in this pure policy task.

## Guard-authorized generation-1 fix: CONV-POLICY-ROUTINE-EVIDENCE-FREE-REFLECTION

### RED evidence

Added one focused regression covering an acceptance-satisfied routine architecture expansion with an unchanged basis and `evidenceQuality: "none"` at both adapter seams.

Command:

```sh
node --test test/convergence-policy.test.mjs
```

Result before the production change: `tests 24`, `pass 23`, `fail 1` (exit 1). The workflow-gate assertion failed for the intended reason: actual `decision` and `requestedDecision` were both `warn`, `enforcement` was `warn_only`, and `probeRequired` was `false`; the regression requires requested/effective `reflection_required`, `stop_review_fix_dispatch`, and `probeRequired: true`. The same test also specifies that `audit_only` retains requested `reflection_required` and its probe while the effective decision clamps to `warn` with `warn_only`.

### GREEN evidence

Narrow owning change: `acceptanceSatisfiedScopeExpansion()` no longer marks its deterministic reflection trigger as subject to the semantic-evidence downgrade. Absence of new evidence is therefore preserved as the cause for reflection; the existing `audit_only` capability clamp continues to limit only the effective action. The independent generic weak-evidence `unjustified_architecture_expansion` case remains unchanged and covered.

Commands and results:

```sh
node --test test/convergence-policy.test.mjs
# tests 24, pass 24, fail 0

node --test test/convergence-policy.test.mjs test/convergence-identity.test.mjs
# tests 38, pass 38, fail 0

npm test
# tests 310, suites 1, pass 310, fail 0
```

### Files changed

- `src/convergence-policy.mjs` — one trigger-classification change.
- `test/convergence-policy.test.mjs` — one focused two-adapter regression test.
- `.superpowers/sdd/task-2-report.md` — this append only; intentionally left uncommitted.

### Self-review

- The change is restricted to the Guard boundary: `evaluateConvergence` trigger classification and its focused policy test.
- `workflow_gate` now retains effective/requested `reflection_required`, `stop_review_fix_dispatch`, and `probeRequired: true` for the evidence-free routine expansion.
- `audit_only` retains requested `reflection_required` and `probeRequired: true` while clamping only its effective decision to `warn` with `warn_only`.
- No Minor tail-priority coverage, Store/controller binding, schema, adapter, hook, model, runtime, or global-state work was performed.
- A Computer Use attempt to inspect macOS Terminal was rejected by the environment safety policy; all automated checks above were run on the current macOS Node runtime.
