## ADDED Requirements

### Requirement: Capacity overflow produces omissions, not a global hold
The selector SHALL treat card-count and token limits as bounded ranking constraints and SHALL return safe selected cards plus structured omission reasons.

#### Scenario: Five severe cards compete for four slots
- **WHEN** five applicable complete severe cards have no semantic conflict and the configured maximum is four
- **THEN** the selector deterministically returns the highest-ranked four, records one `count_budget` omission, and returns no hold

#### Scenario: One severe card is oversized
- **WHEN** an applicable severe card exceeds the single-card or absolute token budget
- **THEN** that card is omitted with an `oversized_card` or `token_budget` reason while other eligible cards remain selectable

### Requirement: Selection order is deterministic
Applicable lessons MUST have a total order based on severity, scope evidence, recurrence, confidence, revision, and stable lesson identity.

#### Scenario: Identical input is selected repeatedly
- **WHEN** the same lesson revisions, task context, delivery history, and budgets are evaluated
- **THEN** selected cards and omissions are byte-for-byte stable

#### Scenario: Already delivered revision is encountered
- **WHEN** a ranked card's application id was already delivered to the same task fingerprint and context epoch
- **THEN** it is skipped without changing the relative order of remaining candidates

### Requirement: Genuine conflicts are quarantined locally
A genuine unresolved conflict SHALL exclude only the affected family or lesson projection and SHALL NOT block unrelated memory or the business turn.

#### Scenario: One family is in safety conflict
- **WHEN** applicable candidates include a conflicted severe family and unrelated non-conflicting cards
- **THEN** the selector reports the family as `conflict_quarantine` and still returns eligible unrelated cards

### Requirement: Selection diagnostics are auditable
The runtime MUST record bounded diagnostics for every omission and maintenance trigger without including sensitive card content in operational logs.

#### Scenario: Selector omits a card
- **WHEN** a card is omitted for capacity, size, prior delivery, or conflict
- **THEN** logs and audit output include opaque lesson/revision identity, reason code, rank, and relevant numeric budget
