# document-memory Specification

## Purpose
TBD - created by archiving change isolate-feedback-control-plane. Update Purpose after archive.
## Requirements
### Requirement: Markdown is the long-term source of truth
Long-term reflection content SHALL exist in `.agent/reflections/*.md`; the runtime database SHALL NOT be required to store or retrieve lesson, report, or card bodies.

#### Scenario: Reviewer produces a long-term lesson
- **WHEN** a validated reviewer result is publishable
- **THEN** the controller renders the canonical human-readable report and only records its path and content hash in the transient ledger

#### Scenario: Transient rows are retained or pruned
- **WHEN** job/evidence retention changes the control database
- **THEN** published Markdown remains independently readable and selectable

### Requirement: Reflection publication is validated and atomic
The controller MUST validate required metadata and report sections, write a same-directory temporary file, sync it, and atomically rename it before marking the job published.

#### Scenario: Publication completes
- **WHEN** validation, file sync, rename, and hash verification succeed
- **THEN** one canonical document becomes visible and the job records `published`

#### Scenario: Review yields no reusable lesson
- **WHEN** the reviewer returns a valid `reviewed_no_lesson` result
- **THEN** no reflection Markdown file is created

#### Scenario: Publication fails partway
- **WHEN** validation, write, sync, rename, or verification fails
- **THEN** no partial canonical document is selected and the job remains retryable or terminal with a reason code

### Requirement: Documents preserve method identity and recurrence evidence
Canonical reports MUST include stable reflection and family identity, severity, responsibility, facts, complaint, root cause, mistake class, method change, and repeated-pattern evidence while retaining the established readable report format.

#### Scenario: The same method family fails again
- **WHEN** a later validated reflection belongs to an existing family
- **THEN** a new immutable document records that relation instead of rewriting or deleting prior reports

#### Scenario: An existing readable report predates family metadata
- **WHEN** a legacy report has parseable severity, responsibility, mistake class, and actionable method-change or preventive-constraint sections but no explicit method or family id
- **THEN** the parser derives deterministic legacy identities without rewriting the report, and the document remains eligible for direct selection

### Requirement: Legacy database export is explicit and idempotent
Migration from legacy database memory SHALL be an operator-invoked export with dry-run and explicit output directory; normal runtime selection SHALL never read legacy bodies from the database.

#### Scenario: Migration is dry-run
- **WHEN** the operator runs export with `--dry-run` against a database copy
- **THEN** it reports planned, skipped, incomplete, and conflicting documents without modifying the database or destination

#### Scenario: Export is repeated
- **WHEN** the same legacy identities and content hashes are exported twice
- **THEN** the second run creates no duplicate documents and reports stable skip reasons

