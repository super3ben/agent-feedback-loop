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
- Dispatch: canonical identity implementer `/root/task1_canonical_identity_refactor` completed with `DONE_WITH_CONCERNS`
- Implementation base: `add6b7ee6c02a11786c7d6e467c2bc7b6d8c1d72`
- Implementation commits: `4a1791af267d9775d2bd8217be6f8eb5dcd6c777`, `aa770c6`, `864240b5f011722172898d88523d9201a9a91d07`, `9e62862ae5bfb993820eaa9fa03fcd285a8151a8`, `44acbfd0709b2385cf818b1d792df9d66fc67926`, `5053ddaf21b18ece0de9714873dfc37ed7b66e37`, `d11cb8a503eb3f54e94bf40b9714d57d451aa834`, `535704d2f6370ec4b7d21cdab6905cd2b37bd7de`, `da19db100c9b4c52abe0a19c712b4d691267aed4`
- Changed files: `src/index.mjs`, `src/capture.mjs`, `src/control-schema.mjs`, `src/control-store.mjs`, `docs/verification/2026-07-16-legacy-control-plane-audit.md`, `test/runtime.test.mjs`, `test/control-store.test.mjs`
- RED evidence: missing module/path; install did not initialize control DB; runtime accepted a mode `0644` DB; initial and second-round capture identity/path/lock/type probes reproduced the reviewed gaps
- GREEN evidence: canonical blocker 4/4, omitted-context replay 1/1, identity/schema matrix 18/18, capture/control-store 61/61 and Task 1 focused 126/126; `node --check` and `git diff --check` passed. The single temporary-HOME full run was 253/254; its only unchanged legacy Stop hard-deadline fixture failed before creating the first signal file and passed an exact isolated rerun 1/1
- Review round: `8` (sixth user-authorized exception beyond configured 2-round ceiling)
- Review package: full Task 1 range `.superpowers/sdd/review-add6b7e..9c3405c.diff`
- Review result: fresh independent reviewer `/root/task1_canonical_identity_review` returned `CHANGES_REQUIRED` (Critical 0, Important 3, Minor 0); report `.superpowers/sdd/isolate-feedback-control-plane-task-1-v2-review-8.md`
- Unresolved findings: the 15-field normalizer/signature is now unified, but the public async capture boundary remains inconsistent: public duplicate replay skips the separate immutable `encrypted_raw_ref` check; it discards the normalized snapshot and re-reads caller-mutable event fields after blob I/O; and different first-time alias keys can resolve and insert in separate transactions, producing two events under concurrency
- Fix dispatch: `/root/task1_control_store_fix1` completed commit `aa770c6`
- Fix round 2 dispatch: `/root/task1_control_store_fix2` completed commit `864240b5f011722172898d88523d9201a9a91d07`
- Full-suite diagnostic: one clean run passed; prior non-exit was overlapping test/tool-session lifecycle, not reproduced as a product defect
- Review ceiling: configured 2-round budget is exhausted; on 2026-07-17 the user explicitly replied `继续吧`, authorizing one transaction-boundary redesign, its TDD implementation and one fresh independent re-review
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
- Transaction-boundary decision: remove the public transaction-external resolve fast path; validate and freeze one capture snapshot before blob I/O; pass the resulting encrypted reference into one serialized resolve-or-insert transaction that rechecks exact replay, alias attachment and new-event insertion without rereading caller-owned input
- Design amendment: fresh architecture agent `/root/task1_capture_transaction_design` completed commit `e1732a87aaab7102435d8a74b25991d413a040d7`; the existing Design Doc and control-plane-isolation delta spec now define frozen preflight, transaction-external blob I/O and one serialized resolve-or-insert decision
- Design validation: no placeholders or unresolved ambiguities found in self-review; `openspec validate isolate-feedback-control-plane --strict` and `git diff --check e1732a8^..e1732a8` pass
- Written-spec review: user explicitly replied `确认`; the frozen-snapshot and atomic resolve-or-insert design is approved for implementation
- Plan amendment: fresh planning agent `/root/task1_capture_transaction_plan` completed commit `c6f984f9e3e285583e51e198cf63f85177da3102`; only Task 1 was amended with exact interfaces, RED/GREEN commands and the three review-8 probes
- Plan self-review: clean; the amendment stays within `src/capture.mjs`, `src/control-store.mjs` and `test/control-store.test.mjs`, reuses schema v1 and `EncryptedBlobStore`, and adds no service, scheduler, mutex, RAG, Stop, notification or Task 2-15 behavior
- Implementation dispatch: fresh implementer `/root/task1_atomic_public_capture` is executing Task 1 Steps 6-22 from `.superpowers/sdd/task-1-brief.md`; implementation base remains `add6b7ee6c02a11786c7d6e467c2bc7b6d8c1d72` for the eventual full Task 1 review package
- Dispatch constraints: TDD; only `src/capture.mjs`, `src/control-store.mjs`, and `test/control-store.test.mjs`; disposable HOME/DB; no schema/crypto/installer/plan/progress changes and no live hooks/runtime state
- Amendment RED evidence: four focused RED groups failed for the intended gaps: missing `prepareCapture`; public supplied-ref mismatch/unified result absent; caller mutation after blob await changed validation/persistence; different-alias and incompatible-storage paths lacked the atomic `kind` contract
- Fixture reconciliation: Step 19 exposed old fixtures that supplied fake public refs or used compatible direct aliases to seed rows. The approved production contract governs; fixture-only changes must set non-ref-testing public inputs to `null` and give every timestamp-window seed a distinct non-null ref so the original 31-outside/2-inside ambiguity proof remains intact
- Interim GREEN evidence: after fixture-only reconciliation, Step 19 passed 12/12 and the four-file Task 1/legacy regression passed 133/133; an initial disposable-HOME package run passed 261/261 in 23.20s
- Final-suite correction: self-review then added in-scope RED/GREEN coverage for direct resolve ref reconcile/adopt, non-caller-owned control `captureSession` results, and null-timestamp exact replay, with production changes. Therefore the earlier 261/261 run is diagnostic only; one explicit final-code disposable-HOME rerun is required and must be reported separately
- Amendment implementation result: `/root/task1_atomic_public_capture` returned `DONE`; commit `da19db100c9b4c52abe0a19c712b4d691267aed4` changes only `src/capture.mjs`, `src/control-store.mjs`, and `test/control-store.test.mjs`; report appended at `.superpowers/sdd/task-1-report.md`
- Final GREEN evidence: Step 18 7/7, Step 19 12/12, four-file Task 1/legacy regression 134/134, and final disposable-HOME package 262/262 in 22.320s; syntax, diff, and scope checks passed
- Risk signals: cross-module, SQL/security, concurrency/lock, public API, and diff over 200; no schema migration and no implementer concerns
- Review round: `9` (the single fresh independent transaction-boundary re-review explicitly authorized after review-8)
- Review package: `.superpowers/sdd/review-add6b7e..da19db1.diff` covers the complete Task 1 implementation range from `add6b7ee6c02a11786c7d6e467c2bc7b6d8c1d72` through `da19db100c9b4c52abe0a19c712b4d691267aed4`
- Review dispatch: fresh independent reviewer `/root/task1_atomic_public_capture_review` is verifying spec compliance and code quality from the brief, implementation report, and full-range diff package; it must not repeat the implementer's suite
- Review result: `/root/task1_atomic_public_capture_review` returned `CHANGES_REQUIRED` (Critical 0, Important 1, Minor 0); report `.superpowers/sdd/isolate-feedback-control-plane-task-1-v2-review-9.md`
- Closed findings: review-9 confirms the review-8 supplied-ref replay mismatch, caller-mutation TOCTOU, and different-alias serialization blockers are closed; canonical identity, direct compatibility, result consistency, scope, and all other Task 1 checks passed
- Unresolved finding: public capture accepts a null/undefined first blob-writer result, enters the direct-only nullable authoritative-ref path, and can commit `encrypted_raw_ref = NULL`. Public capture must reject it after exactly one attempted first write and before SQLite/second-write side effects, with a focused regression
- Review ceiling: the single transaction-boundary implementation plus fresh independent re-review explicitly authorized after review-8 has been consumed; no review-9 fix agent is authorized yet
- User authorization: on 2026-07-17 the user replied `继续`, authorizing exactly one bounded review-9 fix plus one fresh independent re-review
- Verified root cause: `capturePreparedControlSession()` accepts a null/undefined `blobs.write()` result and passes it to `resolveOrInsertCapture()`, whose nullable branch intentionally exists only for direct `captureSessionEvent()`; the public/direct boundary, not the transaction or schema, is the failing component
- Dirty-worktree attribution: the only pre-dispatch dirty file is `.superpowers/sdd/task-1-report.md`, an in-scope append-only implementation handoff already recorded by the prior agent; it must be preserved and appended, not overwritten or committed with source
- Fix scope: add one public writer-result bounded-string guard and one deterministic regression proving one first write, zero SQLite rows, no second write, and rejection; no control-store/schema/crypto/installer/plan/OpenSpec/runtime-state change
- Fix base: `43a4441013691ec91eee752f52bf862c181590c1`
- Fix dispatch: fresh agent `/root/task1_public_writer_ref_fix` is executing the review-9 finding with TDD; allowed files are only `src/capture.mjs` and `test/control-store.test.mjs`, and direct nullable-ref compatibility is frozen
- Fix result: `/root/task1_public_writer_ref_fix` returned `DONE`; commit `9fb6cd61881b3dea4cfdf6e9c718fa4498aabbdf` changes only `src/capture.mjs` and `test/control-store.test.mjs`
- Fix RED evidence: `public control capture rejects invalid blob writer refs before store resolution` failed 0/1 because a null writer ref reached the control-store resolver
- Fix GREEN evidence: the focused writer-ref regression passed 1/1; Task 1/legacy four-file coverage passed 135/135; `node --check src/capture.mjs`, diff check, and two-file scope check passed
- Fix behavior: public capture rejects null, undefined, empty, non-string, and over-4096 writer refs after exactly one attempted first write and before resolver/SQLite/second-write effects; direct nullable-ref compatibility is unchanged
- Review round: `10` (the single fresh independent re-review authorized after review-9)
- Review package: `.superpowers/sdd/review-add6b7e..9fb6cd6.diff` covers the full Task 1 range from `add6b7ee6c02a11786c7d6e467c2bc7b6d8c1d72` through the bounded fix `9fb6cd61881b3dea4cfdf6e9c718fa4498aabbdf`
- Re-review dispatch: fresh independent reviewer `/root/task1_public_writer_ref_rereview` is verifying complete Task 1 spec compliance and code quality; it must not repeat the reported suites
- Review result: `/root/task1_public_writer_ref_rereview` returned `CHANGES_REQUIRED` (Critical 0, Important 2, Minor 0); report `.superpowers/sdd/isolate-feedback-control-plane-task-1-v2-review-10.md`
- Closed finding: the bounded public writer-result guard is correct, rejects all invalid values before resolver/SQLite/second write, and preserves caller-supplied mismatch plus direct nullable-ref compatibility
- Unresolved finding 1: alias attachment omits `completeness`, while exact replay requires persisted target completeness. A different-completeness alias can be committed as 1 event/2 observations but its identical replay deterministically collides
- Unresolved finding 2: `firstDefined()` silently chooses precedence for conflicting snake/camel aliases across most canonical identity fields. The approved fail-closed identity-alias contract is enforced only for capture source/encrypted ref, not event/content/session/provider/etc. aliases
- Root-cause synthesis: signature generation is unified, but canonical alias reading and alias-target compatibility are not yet single shared invariants. The next correction must add one conflict-validating alias reader and make alias attachment use a target-compatibility predicate coherent with exact replay, not append isolated field patches
- Review ceiling: the single bounded review-9 fix plus fresh review-10 explicitly authorized by the user has been consumed
- User authorization: on 2026-07-20 the user replied `继续`, authorizing one identity-coherence TDD fix for both review-10 blockers plus one fresh independent re-review
- Fix architecture: replace precedence-only canonical alias reads with one conflict-validating alias invariant, and make alias attachment and exact replay share one target-compatibility rule that includes completeness before candidate bounding
- Fix scope: `src/control-store.mjs` and `test/control-store.test.mjs` only; preserve observation-specific alias identity, schema v1, public/direct APIs, Markdown truth, and the disabled live-hook boundary
- Dirty-worktree attribution: `.superpowers/sdd/task-1-report.md` remains the prior agents' append-only in-scope handoff; the new implementer must append its own section and leave the report uncommitted
- Fix base: `e08ed2c0bec45be2a1431a8858120efb3404f301`
- Fix dispatch: fresh implementer `/root/task1_identity_coherence_fix` is executing the authorized review-10 correction with TDD; allowed production/test scope is exactly `src/control-store.mjs` and `test/control-store.test.mjs`
- Next action: wait for the implementer result, verify its commit/report/scope, then dispatch one fresh independent Task 1 re-review. Task 1 and all mapped OpenSpec tasks remain unchecked

## Superseded implementation

- Former notification/receipt/Stop work in `7d6b1e3..9c89e00` is evidence to audit, not accepted completion under the new design.
- Reusable generic primitives may survive only after Task 1 audit; notification, Stop, episode, maintenance and scheduler runtime paths must be removed by their mapped tasks.
