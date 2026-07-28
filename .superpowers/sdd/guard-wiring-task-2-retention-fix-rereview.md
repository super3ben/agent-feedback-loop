# Task 2 terminal-retention repair re-review

Review-Run-ID: `guard-wiring-recurrence-task-2-retention-fix-rereview-1`
Reviewed commit: `488c71c`
Invariant: `EXEC-SOFTSTOP-RETENTION-001`
Boundary: `execution-session-episode`

## Verdict

Spec compliance: PASS  
Task quality: PASS

Critical: None  
Important: None  
Minor: None

Only `idle` monitor rows are eligible for retention eviction. A completed,
failed, retryable, reserved, or running episode therefore survives capacity
pressure and cannot emit a second soft-stop until a deterministic
below-threshold observation rearms it. The capacity refusal is atomic and
fail-open for the host hook.

Evidence: `node --test test/execution-monitor.test.mjs` (17/17), `npm test`
(567/567), and `git diff --check` all pass on the local macOS runtime.
