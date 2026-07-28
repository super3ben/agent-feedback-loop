# Task 2 live-fence repair re-review

Review-Run-ID: `guard-wiring-recurrence-task-2-live-fence-rereview-1`
Reviewed commit: `488c71c`
Invariant: `EXEC-LIVE-FENCE-001`
Boundary: `execution-monitor-retention`

## Verdict

Spec compliance: PASS  
Task quality: PASS

Critical: None  
Important: None  
Minor: None

The retention path preserves `reserved` and `running` monitor entries, and
terminal entries remain fenced until an explicit below-threshold rearm. When
the bound is occupied by non-idle entries, admission removes only the newly
inserted row inside the same transaction and returns `capacity_exhausted`;
existing monitor state is unchanged.

Evidence: `node --test test/execution-monitor.test.mjs` (17/17), `npm test`
(567/567), and `git diff --check` all pass on the local macOS runtime.
