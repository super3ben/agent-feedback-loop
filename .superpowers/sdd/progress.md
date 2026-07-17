# Immediate Subagent Reflection SDD Ledger

- Branch: `codex/isolate-feedback-control-plane`
- Plan: `docs/superpowers/plans/2026-07-16-immediate-subagent-reflection.md`
- Baseline: 216 tests, 215 passed; one obsolete Stop timing test failed once and passed on isolated rerun
- Review policy: fresh thorough reviewer after every task, then a final full review
- Safety boundary: temporary HOME/DB copies only; real hooks, runtime pointer and database stay untouched

| Task | Status | Implementation | Review | Verification |
| --- | --- | --- | --- | --- |
| 1. Lean control DB | implementing (fifth-round user exception) | `4a1791a`, `aa770c6`, `864240b`, `9e62862`, `44acbfd` | fifth targeted fix/re-review authorized | control-store 23/23, focused 113/113, coordinator clean full 241/241; independent alias-replay/schema-semantic probes RED |
| 2. Immediate job and fenced lease APIs | pending | pending | pending | pending |
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
- Every task receives a fresh spec-and-quality reviewer; Critical/Important findings are fixed and re-reviewed before checkoff.
- Real Codex desktop installation/visibility remains a later user-authorized verify activity, separate from temporary-HOME build proof.
- Task 1 is blocked at the configured review ceiling on three concrete contract gaps: over-limit alias ambiguity, incomplete schema fingerprinting, and concurrent replay duplicate-result propagation. No task checkbox or OpenSpec item was marked complete.
- On 2026-07-17 the user explicitly replied `继续`, authorizing one third-round exception limited to those three gaps; the task remains unchecked until a fresh reviewer approves it.
- The exception review closed alias truncation and duplicate-result propagation but found two Task 1 blockers: incomplete generated-column/index-collation schema inspection and missing provider isolation in alias/explicit-target identity. A fourth round requires a new explicit user decision.
- The user replied `继续` again on 2026-07-17, authorizing a fourth-round exception limited to those two blockers; no task is checked until a fresh reviewer approves.
- Review 5 confirmed the fourth-round xinfo/provider fixes but found two different blockers: identical same-provider alias replays collide, and undeclared `CHECK`/trigger semantics are not covered by the schema fingerprint. A fifth targeted fix/re-review requires a new explicit user decision.
- The user replied `继续` on 2026-07-17, authorizing a fifth-round exception limited to those two deterministic blockers; no task is checked until a fresh reviewer approves.
