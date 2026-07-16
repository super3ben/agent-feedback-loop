## ADDED Requirements

### Requirement: Effectiveness states match observable evidence
The runtime SHALL distinguish document publication, selector choice, prompt emission, and confirmed recurrence, and SHALL NOT infer model adoption or effectiveness from an earlier state.

#### Scenario: A document is written
- **WHEN** atomic Markdown publication and hash verification complete
- **THEN** the document is `published` but not automatically `selected`, `emitted`, observed, or effective

#### Scenario: Guidance is selected but hook delivery fails
- **WHEN** the selector chooses a document but the prompt hook cannot return the guidance to the host
- **THEN** the attempt records `selected` without recording `emitted`

#### Scenario: Hook returns guidance
- **WHEN** the prompt hook successfully includes bounded method guidance in its host response
- **THEN** it records `emitted` without claiming the model followed it or the user saw a benefit

### Requirement: Recurrence after emission is negative evidence
A later validated reflection in the same method family SHALL be classified as `recurrence_after_emission` only when a prior family document was emitted before the new source event.

#### Scenario: Same family recurs after emission
- **WHEN** reviewer validation proves a later event belongs to a family with a prior pre-event emission
- **THEN** the new report records recurrence and analyzes why the previous method did not prevent it

#### Scenario: Same family existed but was never emitted
- **WHEN** a later event matches a published family with no qualifying earlier emission
- **THEN** it is recurrence of the problem but not evidence that injected guidance failed

### Requirement: Absence of recurrence is not proof
The runtime MUST keep effectiveness `unknown` when it only knows that no later recurrence has been recorded.

#### Scenario: Time passes without another report
- **WHEN** no same-family feedback appears after publication or emission
- **THEN** audit output does not promote the document to observed or effective

### Requirement: Effectiveness audit is content-safe
Audit records and logs SHALL use opaque document/family identity, timestamps, outcome, and reason codes without copying prompt or method bodies into the control ledger.

#### Scenario: Operator inspects a family
- **WHEN** audit history is requested
- **THEN** it can show publication, selection, emission, and recurrence chronology while document content remains sourced from Markdown
