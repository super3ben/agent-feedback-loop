# Task 1 implementation report

## Delivered

- Removed the semantic-dissatisfaction reviewer result kind, provider assets, runner branch, CLI branch, and obsolete tests. Every admitted candidate now invokes the full lesson reviewer directly.
- The installer removes both deleted managed assets from an already-installed prompt pack during an upgrade.
- Added a bounded recurrence projection. It reads only prior candidate source events joined through the immutable `reviewer_jobs.project_id`, never derives historical ownership from sessions, decrypts only inside the runner, and returns just a count plus matching reason codes to the reviewer context.
- Similarity requires both overlapping retrospective reason codes and lexical overlap. The coverage includes two same-project Termius/SSH paraphrases, a different complaint sharing reason codes only, and an identical candidate assigned to another project.
- A recurrence count of two is explicitly recognized by the reviewer prompt as `repeated_pattern_evidence` that can support a new Major lesson with an empty reflection catalog.
- `no_lesson` now requires a controlled `reason_code`; schema validation, runner completion, and the transactional terminal event all enforce and preserve it. Missing or uncontrolled reasons leave the job running.
- Updated active English and Chinese README wording. Historical documents were not changed.

## TDD evidence

1. Added result/schema, store atomicity, direct-review, recurrence, and installer-upgrade assertions before their corresponding production changes.
2. Observed RED: missing reason codes were rejected by the old validator, terminal events stored `NULL`, uncontrolled store completion was accepted, and expanded candidates still invoked the old preliminary result kind.
3. Added the distinct-complaint recurrence case and observed RED (`similar_complaint_count: 3` instead of `2`); narrowed lexical matching so generic complaint wording cannot be sufficient.
4. Green verification: focused affected tests passed (200 tests); full `npm test` passed (545 tests).

## Static checks

- `git diff --check` passed.
- Active source/tests/templates contain no forbidden legacy result-kind/template references; the installer derives the two deleted asset paths without retaining those legacy identifiers.
