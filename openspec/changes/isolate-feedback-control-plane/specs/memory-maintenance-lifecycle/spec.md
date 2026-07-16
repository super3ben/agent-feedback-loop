## ADDED Requirements

### Requirement: Maintenance work is durable and explicit
The runtime SHALL create an idempotent maintenance job before claiming that memory consolidation, compaction, supersession, or conflict resolution is queued or running.

#### Scenario: Repeated selection omission requests consolidation
- **WHEN** the same family revisions repeatedly exceed selection capacity or card size
- **THEN** one pending maintenance job is created with immutable source revision references and a stable input digest

#### Scenario: No job exists
- **WHEN** no maintenance job was created for an overflow or conflict
- **THEN** no hook, notification, log, or audit command describes background compaction as pending or running

### Requirement: Maintenance claims use fenced leases
Maintenance workers MUST claim jobs with owner, attempt, lease epoch, and expiry, and stale workers MUST be unable to publish output.

#### Scenario: Worker lease expires
- **WHEN** a running maintenance job passes its lease expiry
- **THEN** the scheduler requeues it with an audit event and a later worker receives a higher lease epoch

#### Scenario: Stale worker submits after requeue
- **WHEN** the former owner submits using an old lease epoch
- **THEN** the store rejects the publication without changing lessons or lineage

### Requirement: Consolidation publication preserves safety and provenance
A maintenance result MUST pass deterministic validation and publish the target revision, lineage, and source supersession in one transaction.

#### Scenario: Valid consolidation is submitted
- **WHEN** the result has complete bounded card fields, covers all source revisions, does not lower maximum severity, and does not broaden scope without evidence
- **THEN** the target lesson revision and lineage are committed atomically and sources are marked superseded rather than deleted

#### Scenario: Publication transaction fails
- **WHEN** any lesson, lineage, or source-state write fails
- **THEN** no partial target or supersession is visible and the job remains recoverable

### Requirement: Irreconcilable conflict requires human resolution
The maintenance worker SHALL NOT automatically merge contradictory source constraints that fail deterministic preservation checks.

#### Scenario: Source instructions contradict
- **WHEN** a consolidation proposal cannot preserve all severe must-do and must-not constraints
- **THEN** the job terminates as `needs_human_resolution`, immutable sources remain, and the affected family stays quarantined

### Requirement: Maintenance state is independently observable
Doctor and audit commands MUST report maintenance queue depth, oldest age, running leases, exhausted jobs, human-resolution jobs, and last successful publication separately from reviewer state.

#### Scenario: Reviewer is healthy but maintenance is stalled
- **WHEN** reviewer jobs complete while maintenance jobs are overdue or exhausted
- **THEN** health output reports the maintenance degradation without claiming reviewer failure or hiding the maintenance gap
