# Task 15 Human-Decision Linux Proof Report

Decision reference: `.superpowers/sdd/isolate-feedback-control-plane-task-15-linux-detached.human-decision.md`

## Scope

The user selected Option A after Guard entered `blocked_human_decision`. This authorized one manual evidence rerun for invariant `linux-smoke-proves-detached-launch` at boundary `test/platform-smoke/linux-process`. No Guard counter or identity was reset, and no second automatic fixer was dispatched.

The only experimental variable changed from the failed generation-2 invocation was the disposable mount option:

- failed executor: `--tmpfs /state:rw,nosuid,nodev,size=256m`
- human-authorized executor: `--tmpfs /state:rw,nosuid,nodev,exec,size=256m`

Production code, test code, the official `node:24-bookworm-slim` image, exact reviewed commit, read-only repository/root filesystem, disabled network, HOME/TMP isolation, and platform-smoke command were unchanged.

## Exact command

```bash
docker run --rm --network none --read-only --mount type=bind,src=/Users/sunxingda/project/agent-feedback-loop/.worktrees/background-review-observability,dst=/repo,readonly --tmpfs /state:rw,nosuid,nodev,exec,size=256m -e HOME=/state/home -e TMPDIR=/state/tmp -e AFL_REVIEWED_COMMIT=07f86e0570aabdf375963213c23fe73bfea9033d -w /repo node:24-bookworm-slim sh -ceu 'mkdir -p /state/home /state/tmp; echo reviewed_commit: "$AFL_REVIEWED_COMMIT"; echo state_mount:; grep " /state " /proc/mounts; echo node_version:; node --version; echo installer:; node ./bin/agent-feedback-loop.mjs install --home /state/home; echo installer_exit: 0; echo installed_hook:; test -x /state/home/.agent/feedback-loop/hooks/core-hook.sh; ls -l /state/home/.agent/feedback-loop/hooks/core-hook.sh; echo platform_smoke:; AFL_SMOKE_HOME=/state/home node --test test/platform-smoke.test.mjs; echo platform_smoke_exit: 0'
```

## Exact result

Exit code: `0`

```text
reviewed_commit: 07f86e0570aabdf375963213c23fe73bfea9033d
state_mount:
tmpfs /state tmpfs rw,nosuid,nodev,relatime,size=262144k,inode64 0 0
node_version:
v24.18.0
installer:
agent-feedback-loop installed
- copy templates -> /state/home/.agent/feedback-loop
- write stable launcher -> /state/home/.agent/feedback-loop/bin/afl-hook
- connect Codex hook -> /state/home/.agent/feedback-loop/hooks/core-hook.sh
- connect Claude Code hook -> /state/home/.agent/feedback-loop/hooks/core-hook.sh
- connect Gemini CLI hook -> /state/home/.agent/feedback-loop/hooks/core-hook.sh
- Codex hooks configured but not runnable (unavailable: codex: spawn codex ENOENT)
installer_exit: 0
installed_hook:
-rwxr-xr-x 1 root root 728 Jul 20 15:36 /state/home/.agent/feedback-loop/hooks/core-hook.sh
platform_smoke:
✔ installed prompt pipeline publishes and reuses reflection guidance on the host platform (631.476956ms)
tests: 1
pass: 1
fail: 0
duration_ms: 661.917169
platform_smoke_exit: 0
```

## Diagnosis

The failed and passing invocations used the same commit, image, test, and isolation boundary. Explicit executable permission on the disposable state mount is the single causal difference. The earlier failure occurred at child-process spawn before the coordinated reviewer assertions; the passing invocation proves the installed hook and deterministic provider can execute on Linux and the corrected detached-launch smoke completes.

The installer's real-Codex availability warning is expected in the network-disabled image. Default platform smoke supplies its own deterministic provider and passed without a real Codex executable.

## Safety and self-review

- The repository was mounted read-only.
- The container root filesystem was read-only.
- Network access was disabled.
- HOME and TMP were beneath disposable `/state` tmpfs.
- `--rm` removed the container and state after exit.
- No real user HOME, AFL hook, managed runtime pointer, or database path was mounted or changed.
- No production or test file changed.
- The three user-owned dirty Task 1/2/3 reports remained unstaged and untouched.

Result: the human-authorized falsification test passed and provides commit-bound Linux evidence for the original invariant.
