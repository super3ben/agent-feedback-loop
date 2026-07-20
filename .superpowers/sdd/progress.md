# Immediate Subagent Reflection SDD Ledger

- Branch: `codex/isolate-feedback-control-plane`
- Plan: `docs/superpowers/plans/2026-07-16-immediate-subagent-reflection.md`
- Baseline: 216 tests, 215 passed; one obsolete Stop timing test failed once and passed on isolated rerun
- Review policy: thorough review with a three-round circuit breaker; after three cumulative fix/formal-review rounds, architecture retrospective and a frozen acceptance checklist replace open-ended review. Only main-session interference, data corruption/unrecoverability, security/privacy, or frozen-core failure blocks; unsupported theoretical edge cases enter backlog
- Safety boundary: temporary HOME/DB copies only; real hooks, runtime pointer and database stay untouched

| Task | Status | Implementation | Review | Verification |
| --- | --- | --- | --- | --- |
| 1. Lean control DB | complete (frozen acceptance) | `4a1791a`, `aa770c6`, `864240b`, `9e62862`, `44acbfd`, `5053dda`, `d11cb8a`, `535704d`, `da19db1`, `9fb6cd6`, `88c2c4b`, `d37c91f`; design `e1732a8`; plan `c6f984f`, circuit breaker `d3dd12a` | PASS A-G; Critical 0; backlog 0 | Timestamp RED 0/2; UTC and Asia/Shanghai GREEN 2/2 each; disposable-HOME four-file regression 159/159; scope two files. macOS temporary-state build proof only; Linux/live/production remain unverified |
| 2. Immediate job and fenced lease APIs | implementing | base `e7b9fa3`; implementer pending | pending | TDD focused + existing control/store/capture regression required |
| 3. Remove Stop/notification/reconcile | pending | pending | pending | pending |
| 4. Explicit dissatisfaction detector | pending | pending | pending | pending |
| 5. Prompt capture creates immediate job | pending | pending | pending | pending |
| 6. macOS/Linux detached launcher | pending | pending | pending | pending |
| 7. Reviewer result contract | pending | pending | pending | pending |
| 8. Canonical/legacy Markdown documents | pending | pending | pending | pending |
| 9. Reviewer runner terminal outcomes | pending | pending | pending | pending |
| 10. Deterministic Markdown Top-K | pending | pending | pending | pending |
| 11. Selected/emitted/recurrence evidence | pending | pending | pending | pending |
| 12. Read-only legacy export | pending | pending | pending | pending |
| 13. Delete transitional legacy runtime | pending | pending | pending | pending |
| 14. Doctor/logs/docs/package | pending | pending | pending | pending |
| 15. End-to-end macOS/Linux build proof | pending | pending | pending | pending |
| Final branch review | pending | pending | pending | pending |

## Notes

- Every implementation or fix agent must report an observed RED command and failure summary before GREEN evidence.
- Every task receives review according to the circuit-breaker policy above. Before the threshold, frozen-scope Critical/Important findings are fixed and re-reviewed; after the threshold, adjacent non-Critical findings cannot extend the loop.
- Task 1 architecture retrospective: the core control DB direction is valid, but compatibility responsibilities and the review gate became overextended while the user-facing vertical loop remained unbuilt. The timezone-less counterexample has no supported producer evidence; one minimal normalization closeout is cheaper than more control-store redesign, after which Tasks 2–6 take priority.
- Task 1 frozen acceptance: separate schema-v1 control DB and legacy isolation; side-effect-free frozen canonical preflight; blob/transaction/ref invariants; exact/alias/new replay and completeness regressions; timezone-less pre-side-effect rejection; timezone-bearing UTC-normalized alias replay; no real-state mutation.
- Frozen timestamp closeout commit `d37c91f` changes only `src/control-store.mjs` and `test/control-store.test.mjs`. It adds exactly two tests and one small entry normalizer; SQL/schema/fallback behavior is unchanged. Reported GREEN is 2/2 under both `TZ=UTC` and `TZ=Asia/Shanghai`, plus 159/159 four-file regression.
- Frozen Task 1 acceptance passed checklist A-G with Critical 0 and backlog 0. Task 1 is frozen and complete; no twelfth open-ended review/fix round is permitted. Linux, live hooks/runtime, Codex desktop visibility, and production evidence remain later verification boundaries.
- Task 2 preflight: the schema-v1 `reviewer_jobs` and `review_job_events` tables already contain the needed identity, launch, lease, retry and terminal fields. The bounded task adds only transactional control-store APIs and focused tests; it does not add a scheduler, notification path, RAG layer, schema change, Markdown body storage, or main-session wait.
- Real Codex desktop installation/visibility remains a later user-authorized verify activity, separate from temporary-HOME build proof.
- Historical review note: Task 1 previously stopped at the configured review ceiling on three concrete contract gaps. Those gaps and later bounded findings were resolved under explicit user-authorized rounds; this historical gate is superseded by the final frozen acceptance PASS.
- On 2026-07-17 the user explicitly replied `继续`, authorizing one third-round exception limited to those three gaps; the task remains unchecked until a fresh reviewer approves it.
- The exception review closed alias truncation and duplicate-result propagation but found two Task 1 blockers: incomplete generated-column/index-collation schema inspection and missing provider isolation in alias/explicit-target identity. A fourth round requires a new explicit user decision.
- The user replied `继续` again on 2026-07-17, authorizing a fourth-round exception limited to those two blockers; no task is checked until a fresh reviewer approves.
- Review 5 confirmed the fourth-round xinfo/provider fixes but found two different blockers: identical same-provider alias replays collide, and undeclared `CHECK`/trigger semantics are not covered by the schema fingerprint. A fifth targeted fix/re-review requires a new explicit user decision.
- The user replied `继续` on 2026-07-17, authorizing a fifth-round exception limited to those two deterministic blockers; no task is checked until a fresh reviewer approves.
- Review 6 confirmed the fifth-round alias/CHECK/trigger fixes but found two identity blockers: public duplicate replay omits persisted immutable referent/source/completeness fields, and a shared session UID can rewrite its provider. Undeclared VIEW acceptance is Minor. A sixth targeted fix/re-review requires a new explicit user decision.
- The user replied `继续` on 2026-07-17, authorizing a sixth-round exception for both identity blockers and the adjacent canonical-schema VIEW gap; no task is checked until a fresh reviewer approves.
- Review 7 closed the review-6 provider/VIEW findings but proved the identity model is still fragmented: public capture drops capture source while direct replay bypasses observation-signature checks. After repeated field-level fixes, the next attempt must unify normalization/signature/equality/replay around one canonical capture identity contract, not append another isolated field check; this requires a new explicit user decision.
- Review 9 confirms the atomic frozen-snapshot redesign closes all three review-8 blockers, but found one new bounded Important: public capture does not reject a null/undefined blob-writer result before entering the direct-only nullable authoritative-ref path. The authorized implementation/re-review round is consumed; no fix is dispatched until the user explicitly authorizes one bounded fix and fresh re-review.
- The user replied `继续` after review 9, authorizing exactly one bounded fix for the public null-writer invariant and one fresh independent re-review; the direct-only nullable path remains unchanged.
- Review 10 approves the public writer-ref fix but finds two deterministic identity-contract blockers: alias attachment can create a completeness-mismatched observation that exact replay rejects, and most snake/camel canonical identity conflicts are silently resolved by precedence. The authorized review-9 fix/re-review round is consumed; no further fix is dispatched without a new explicit user decision.
- On 2026-07-20 the user replied `继续`, authorizing one review-10 identity-coherence fix and one fresh independent re-review. The fix must use a shared conflict-validating reader for all existing canonical alias groups and a shared replay-compatible alias-target rule with completeness applied before candidate bounding; no schema, hook, scheduler, notification, RAG, Markdown-truth, or later-task expansion is authorized.
- Review 11 confirms both review-10 blockers are closed but proves one remaining semantic split: SQLite `julianday()` accepts a timezone-less timestamp as a 60-second alias match while JavaScript `Date.parse()` sees a 28,740-second difference, so the same accepted alias immediately collides on replay. The authorized fix/re-review round is consumed; no timestamp-contract fix is dispatched without a new explicit user decision.
- On 2026-07-20 the user replied `继续`, authorizing one root-cause timestamp-contract amendment, its TDD implementation, and one fresh independent review. The correction must normalize valid timezone-bearing RFC3339 input to fixed-width UTC before side effects and make SQL/replay consume one canonical inclusive window; it must not add schema, services, schedulers, hooks, notifications, RAG, or later-task behavior.
