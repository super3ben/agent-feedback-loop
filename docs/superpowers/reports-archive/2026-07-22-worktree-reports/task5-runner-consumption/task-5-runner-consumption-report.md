# Task 5 Detached Runner Consumption Report

## Scope

Implemented only the detached runner consumption seam and its focused tests:

- `src/convergence-probe-runner.mjs`
- `test/convergence-probe.test.mjs`

No Guard command was run and no new receipt was created or consumed.

## TDD evidence

- RED: `node --test test/convergence-probe.test.mjs` initially reported 5 failures:
  the runner neither read the live binding nor supplied evidence to the provider,
  and it did not perform terminal cleanup.
- GREEN: after the minimal runner change, the same focused test passed. The final
  focused regression command below passed 16 of 16 tests.

## Implemented behavior

- Requires injected `contextStore` plus the frozen narrow Store binding reader after
  lease claim.
- Reads bounded status, live binding, and evidence before the provider; mismatched
  identity, contract revision, generation, or decision-basis digest fails closed as
  `context_invalid`.
- Passes the provider one frozen semantic object with exactly `status` and `evidence`,
  while retaining the existing frozen `resultKind` metadata argument required by the
  no-tool result-isolation adapter.
- Retains context for retryable failure. Completion and final failure first complete
  their Store transition, then remove context. Cleanup errors only invoke the injected
  bounded cleanup log event and do not revive the job or call the provider again.
- Retains existing lease-loss behavior: a failed completion does not write a stale
  failure transition or remove context.

## Verification

```text
node --test test/convergence-probe.test.mjs test/convergence-probe-result.test.mjs
16 passed, 0 failed

git diff --check
exit 0
```

The focused Node tests ran on this macOS host without touching the real HOME or
executing a Guard command. A Computer Use Terminal verification was attempted, but the
desktop safety policy disallowed control of `com.apple.Terminal`; no UI action or real
HOME access followed.
