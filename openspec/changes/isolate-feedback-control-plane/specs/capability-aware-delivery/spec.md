## ADDED Requirements

### Requirement: Transport-specific delivery truth
The notification system SHALL store delivery lifecycle independently for every attempted transport and SHALL distinguish transport acceptance from transcript observation.

#### Scenario: Native transport accepts a notification
- **WHEN** a native adapter returns a successful append acknowledgement
- **THEN** the delivery is marked `accepted` with its transport acknowledgement and is not marked `observed`

#### Scenario: Transcript later contains the synthetic marker
- **WHEN** reconciliation observes the exact stable marker for an accepted notification
- **THEN** that transport delivery is marked `observed` idempotently

#### Scenario: Delivery state is audited
- **WHEN** an operator runs the review audit command
- **THEN** it reports semantic notification state and each transport state separately

### Requirement: Capability-gated native delivery
A native adapter MUST prove host availability, exact target-session identity, supported protocol, and bounded request completion before attempting delivery.

#### Scenario: Codex native capability is available
- **WHEN** the scheduler resolves the target Codex thread and app-server append capability
- **THEN** it appends one bounded synthetic assistant item outside the main model turn and records the acknowledgement

#### Scenario: Native capability is unavailable
- **WHEN** the host, target session, protocol, or app-server connection cannot be verified
- **THEN** the adapter records `unsupported` or `failed` with a reason code and falls back to an eligible side channel

### Requirement: No model-mediated fallback
No delivery adapter SHALL fall back to prompt-context receipt instructions or Stop-hook retries.

#### Scenario: Every direct transport fails
- **WHEN** native and system delivery both fail or are unsupported
- **THEN** the notification remains available through the audit surface and the business turn remains unaffected

### Requirement: Bounded and idempotent notification delivery
Every semantic notification MUST have a stable identity, and each transport MUST process that identity at most once concurrently through a leased claim.

#### Scenario: Scheduler repeats after acknowledgement
- **WHEN** the scheduler scans an already accepted or observed transport delivery
- **THEN** it does not append or notify the same semantic notification again

#### Scenario: Worker crashes while delivering
- **WHEN** a transport lease expires without a terminal acknowledgement
- **THEN** a later worker may reclaim the same delivery with an incremented lease epoch and stale workers cannot commit
