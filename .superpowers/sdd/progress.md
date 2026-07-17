# Immediate Subagent Reflection SDD Ledger

- Branch: `codex/isolate-feedback-control-plane`
- Plan: `docs/superpowers/plans/2026-07-16-immediate-subagent-reflection.md`
- Baseline: 216 tests, 215 passed; one obsolete Stop timing test failed once and passed on isolated rerun
- Review policy: fresh thorough reviewer after every task, then a final full review
- Safety boundary: temporary HOME/DB copies only; real hooks, runtime pointer and database stay untouched

| Task | Status | Implementation | Review | Verification |
| --- | --- | --- | --- | --- |
| 1. Lean control DB | implementing (user-authorized review exception) | `4a1791a`, `aa770c6`, `864240b` | third targeted fix/re-review pending | targeted 39/39, focused 103/103, full 232/232; three final novel probes RED |
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
