# Task 2 Retention Fix Report

## RED

Added `retention preserves terminal episodes and refuses admission when no idle row remains` to `test/execution-monitor.test.mjs`.

Command:

```text
node --test test/execution-monitor.test.mjs --test-name-pattern='retention preserves terminal episodes'
```

The regression failed before the fix because retention evicted terminal `failed` rows, allowing the same over-threshold session to create a second episode.

## GREEN

Changed `src/control-store.mjs` retention selection so only `idle` monitor rows are evictable. Reserved, running, retryable, completed, and failed rows remain fenced until a below-threshold observation rearms the monitor. When no idle row is available, new monitor admission remains atomic and returns the existing capacity fail-open result.

Commands:

```text
node --test test/execution-monitor.test.mjs
npm test
git diff --check
```

Results: focused execution-monitor tests passed (17/17); full suite passed (567/567); diff check passed.
