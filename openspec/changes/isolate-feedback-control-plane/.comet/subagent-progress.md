# Subagent Progress

## Stable build boundary

- Change: `isolate-feedback-control-plane`
- Branch: `codex/isolate-feedback-control-plane`
- Plan: `docs/superpowers/plans/2026-07-16-immediate-subagent-reflection.md`
- Build mode: `subagent-driven-development`
- TDD mode: `tdd`
- Review mode: `thorough`
- Supported platforms: macOS and Linux
- Live boundary: global AFL hooks remain disabled; no real HOME/runtime/database changes are authorized
- Baseline: 216 tests, 215 passed; one legacy Stop hard-deadline timing test failed once and passed on isolated rerun

## Current task

- Plan task: `Task 1 complete: 并行建立轻量 control DB，不破坏旧 runtime`
- OpenSpec mappings: `1.2` audit and `4.4` lean SQLite are partial until their later mapped implementation tasks complete
- Stage: `blocked`
- Dispatch: implementer `/root/task1_lean_control_store` completed
- Implementation base: `add6b7ee6c02a11786c7d6e467c2bc7b6d8c1d72`
- Implementation commits: `4a1791af267d9775d2bd8217be6f8eb5dcd6c777`, `aa770c6`, `864240b5f011722172898d88523d9201a9a91d07`, `9e62862ae5bfb993820eaa9fa03fcd285a8151a8`, `44acbfd0709b2385cf818b1d792df9d66fc67926`, `5053ddaf21b18ece0de9714873dfc37ed7b66e37`
- Changed files: `src/index.mjs`, `src/capture.mjs`, `src/control-schema.mjs`, `src/control-store.mjs`, `docs/verification/2026-07-16-legacy-control-plane-audit.md`, `test/runtime.test.mjs`, `test/control-store.test.mjs`
- RED evidence: missing module/path; install did not initialize control DB; runtime accepted a mode `0644` DB; initial and second-round capture identity/path/lock/type probes reproduced the reviewed gaps
- GREEN evidence: fifth-round alias/schema regressions and preserved collisions 11/11; complete control-store suite 28/28; required storage/capture regression 118/118; coordinator clean single-process `npm test` passed 246/246 in 51.193 s; `node --check` and `git diff --check` passed
- Review round: `5` (third user-authorized exception beyond configured 2-round ceiling)
- Review package: fifth-round final full range `.superpowers/sdd/isolate-feedback-control-plane-review-task1-v2-fifth-final.diff`
- Review result: fifth-round independent reviewer `/root/task1_control_store_fifth_review` returned `CHANGES_REQUIRED` (Critical 0, Important 2, Minor 1); report `.superpowers/sdd/isolate-feedback-control-plane-task-1-v2-review-6.md`
- Unresolved findings: public capture replay signature/fast path omits persisted immutable referent/source/completeness metadata; a new cross-provider event can reuse one session UID and overwrite `sessions.cli`; undeclared user VIEW acceptance is recorded as Minor
- Fix dispatch: `/root/task1_control_store_fix1` completed commit `aa770c6`
- Fix round 2 dispatch: `/root/task1_control_store_fix2` completed commit `864240b5f011722172898d88523d9201a9a91d07`
- Full-suite diagnostic: one clean run passed; prior non-exit was overlapping test/tool-session lifecycle, not reproduced as a product defect
- Review ceiling: configured 2-round budget was exhausted; user explicitly replied `继续` three times on 2026-07-17, authorizing targeted third, fourth, and fifth fix/re-review exceptions
- Fix round 3 dispatch: `/root/task1_control_store_fix3` completed commit `9e62862ae5bfb993820eaa9fa03fcd285a8151a8`
- Exception-round closure: review-3 alias truncation and concurrent replay findings are closed; schema completeness is only partially closed and a provider-identity counterexample remains
- Fix round 4 dispatch: `/root/task1_control_store_fix4` completed commit `44acbfd0709b2385cf818b1d792df9d66fc67926`; scope remained limited to complete xinfo schema metadata and provider identity isolation
- Fourth-round full-suite diagnostic: the implementer's load-sensitive 239/241 run was not reproduced; with no concurrent test processes, the coordinator reran `npm test` once and passed 241/241 in 50.055 s
- Fix round 5 dispatch: `/root/task1_control_store_fix5` completed commit `5053ddaf21b18ece0de9714873dfc37ed7b66e37`; report `.superpowers/sdd/isolate-feedback-control-plane-task-1-v2-fix-5-report.md`
- Fifth-round full-suite diagnostic: the implementer's load-sensitive run passed 245/246 with one investigated legacy Stop polling timeout; after the subagent and all other test processes exited, the coordinator's clean `npm test` passed 246/246 in 51.193 s
- Next action: configured review budget plus fifth user-authorized exception are exhausted; require a new explicit user decision before a sixth targeted fix/re-review. Task 1 and all mapped OpenSpec tasks remain unchecked

## Superseded implementation

- Former notification/receipt/Stop work in `7d6b1e3..9c89e00` is evidence to audit, not accepted completion under the new design.
- Reusable generic primitives may survive only after Task 1 audit; notification, Stop, episode, maintenance and scheduler runtime paths must be removed by their mapped tasks.
