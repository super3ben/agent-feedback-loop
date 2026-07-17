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
- Stage: `task-review`
- Dispatch: canonical identity implementer `/root/task1_canonical_identity_refactor` completed with `DONE_WITH_CONCERNS`
- Implementation base: `add6b7ee6c02a11786c7d6e467c2bc7b6d8c1d72`
- Implementation commits: `4a1791af267d9775d2bd8217be6f8eb5dcd6c777`, `aa770c6`, `864240b5f011722172898d88523d9201a9a91d07`, `9e62862ae5bfb993820eaa9fa03fcd285a8151a8`, `44acbfd0709b2385cf818b1d792df9d66fc67926`, `5053ddaf21b18ece0de9714873dfc37ed7b66e37`, `d11cb8a503eb3f54e94bf40b9714d57d451aa834`, `535704d2f6370ec4b7d21cdab6905cd2b37bd7de`
- Changed files: `src/index.mjs`, `src/capture.mjs`, `src/control-schema.mjs`, `src/control-store.mjs`, `docs/verification/2026-07-16-legacy-control-plane-audit.md`, `test/runtime.test.mjs`, `test/control-store.test.mjs`
- RED evidence: missing module/path; install did not initialize control DB; runtime accepted a mode `0644` DB; initial and second-round capture identity/path/lock/type probes reproduced the reviewed gaps
- GREEN evidence: canonical blocker 4/4, omitted-context replay 1/1, identity/schema matrix 18/18, capture/control-store 61/61 and Task 1 focused 126/126; `node --check` and `git diff --check` passed. The single temporary-HOME full run was 253/254; its only unchanged legacy Stop hard-deadline fixture failed before creating the first signal file and passed an exact isolated rerun 1/1
- Review round: `7` (fifth user-authorized exception beyond configured 2-round ceiling)
- Review package: pending fresh full Task 1 package after canonical identity commit
- Review result: pending fresh independent Task 1 review after canonical identity refactor
- Unresolved findings: capture identity has multiple competing definitions. Public projection drops `event.capture_source`; direct `captureSessionEvent()` duplicate replay bypasses persisted observation signature, so changed capture source/source event/source offset can still return `duplicate=true`
- Fix dispatch: `/root/task1_control_store_fix1` completed commit `aa770c6`
- Fix round 2 dispatch: `/root/task1_control_store_fix2` completed commit `864240b5f011722172898d88523d9201a9a91d07`
- Full-suite diagnostic: one clean run passed; prior non-exit was overlapping test/tool-session lifecycle, not reproduced as a product defect
- Review ceiling: configured 2-round budget was exhausted; user explicitly replied `继续` again on 2026-07-17, authorizing this canonical-identity architecture correction and one fresh re-review
- Fix round 3 dispatch: `/root/task1_control_store_fix3` completed commit `9e62862ae5bfb993820eaa9fa03fcd285a8151a8`
- Exception-round closure: review-3 alias truncation and concurrent replay findings are closed; schema completeness is only partially closed and a provider-identity counterexample remains
- Fix round 4 dispatch: `/root/task1_control_store_fix4` completed commit `44acbfd0709b2385cf818b1d792df9d66fc67926`; scope remained limited to complete xinfo schema metadata and provider identity isolation
- Fourth-round full-suite diagnostic: the implementer's load-sensitive 239/241 run was not reproduced; with no concurrent test processes, the coordinator reran `npm test` once and passed 241/241 in 50.055 s
- Fix round 5 dispatch: `/root/task1_control_store_fix5` completed commit `5053ddaf21b18ece0de9714873dfc37ed7b66e37`; report `.superpowers/sdd/isolate-feedback-control-plane-task-1-v2-fix-5-report.md`
- Fifth-round full-suite diagnostic: the implementer's load-sensitive run passed 245/246 with one investigated legacy Stop polling timeout; after the subagent and all other test processes exited, the coordinator's clean `npm test` passed 246/246 in 51.193 s
- Fix round 6 dispatch: `/root/task1_control_store_fix6` completed commit `d11cb8a503eb3f54e94bf40b9714d57d451aa834`; report `.superpowers/sdd/isolate-feedback-control-plane-task-1-v2-fix-6-report.md`
- Sixth-round full-suite diagnostic: changed-path suites are green; both observed full-suite failures are in unchanged transitional Stop code assigned to Task 3. Storage-failure passed isolated; the isolated hard-deadline failure produced no fixture PID/signal files, consistent with its recorded pre-readiness timing race
- Canonical identity decision: replace the fragmented public projection, event/observation normalization, signature and duplicate equality definitions with the single body-free tuple recorded in the Task 1 plan; preserve encrypted evidence as a separate immutable storage invariant
- Canonical identity implementation: `normalizeCaptureIdentity()` is now the single body-free tuple producer for public/direct capture, observation resolution, signatures and replay equality; report `.superpowers/sdd/task-1-report.md`
- Next action: generate the full Task 1 review package from `add6b7ee6c02a11786c7d6e467c2bc7b6d8c1d72` through `535704d2f6370ec4b7d21cdab6905cd2b37bd7de`, then dispatch one fresh independent reviewer. Task 1 and all mapped OpenSpec tasks remain unchecked until that review passes

## Superseded implementation

- Former notification/receipt/Stop work in `7d6b1e3..9c89e00` is evidence to audit, not accepted completion under the new design.
- Reusable generic primitives may survive only after Task 1 audit; notification, Stop, episode, maintenance and scheduler runtime paths must be removed by their mapped tasks.
