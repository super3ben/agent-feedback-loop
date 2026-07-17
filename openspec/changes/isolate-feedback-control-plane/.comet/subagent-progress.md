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
- Stage: `implementing`
- Dispatch: implementer `/root/task1_lean_control_store` completed
- Implementation base: `add6b7ee6c02a11786c7d6e467c2bc7b6d8c1d72`
- Implementation commits: `4a1791af267d9775d2bd8217be6f8eb5dcd6c777`, `aa770c6`, `864240b5f011722172898d88523d9201a9a91d07`
- Changed files: `src/index.mjs`, `src/capture.mjs`, `src/control-schema.mjs`, `src/control-store.mjs`, `docs/verification/2026-07-16-legacy-control-plane-audit.md`, `test/runtime.test.mjs`, `test/control-store.test.mjs`
- RED evidence: missing module/path; install did not initialize control DB; runtime accepted a mode `0644` DB; initial and second-round capture identity/path/lock/type probes reproduced the reviewed gaps
- GREEN evidence: final targeted control/capture 39/39; plan focused regression 103/103 before the final schema fingerprint case plus final targeted coverage; one non-overlapping `npm test` passed 232/232 in 23.8 s; `git diff --check` passed
- Review round: `3` (user-authorized exception beyond configured 2-round ceiling)
- Review package: final full range `.superpowers/sdd/isolate-feedback-control-plane-review-task1-v2-final.diff`
- Review result: final `CHANGES_REQUIRED` from `/root/task1_control_store_final_review` (Critical 0, Important 3, Minor 0)
- Unresolved findings: alias candidate `LIMIT 32` precedes time-window uniqueness; schema fingerprint does not verify the complete declared v1 schema/constraints; concurrent exact replay discards the duplicate result at the capture adapter
- Fix dispatch: `/root/task1_control_store_fix1` completed commit `aa770c6`
- Fix round 2 dispatch: `/root/task1_control_store_fix2` completed commit `864240b5f011722172898d88523d9201a9a91d07`
- Full-suite diagnostic: one clean run passed; prior non-exit was overlapping test/tool-session lifecycle, not reproduced as a product defect
- Review ceiling: configured 2-round budget was exhausted; user explicitly replied `继续` on 2026-07-17 and authorized one targeted third fix/re-review exception
- Fix round 3 dispatch: preparing a fresh agent; scope is limited to the three final-review blockers
- Next action: third-round RED/GREEN fix followed by one fresh Task 1 reviewer; Task 1 and all mapped OpenSpec tasks remain unchecked until approval

## Superseded implementation

- Former notification/receipt/Stop work in `7d6b1e3..9c89e00` is evidence to audit, not accepted completion under the new design.
- Reusable generic primitives may survive only after Task 1 audit; notification, Stop, episode, maintenance and scheduler runtime paths must be removed by their mapped tasks.
