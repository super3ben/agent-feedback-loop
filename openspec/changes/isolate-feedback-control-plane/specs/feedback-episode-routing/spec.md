## ADDED Requirements

### Requirement: Captured events are not automatically feedback candidates
The runtime SHALL persist observable user and assistant events independently from the decision to create a feedback episode or reviewer job.

#### Scenario: Ordinary follow-up prompt
- **WHEN** a user asks a new or operational follow-up without a strong structural feedback signal
- **THEN** the event may be captured but no immediate reviewer job is created

#### Scenario: Synthetic AFL control item
- **WHEN** capture encounters a receipt, hook prompt, notification marker, or other AFL-generated control item
- **THEN** the item is tagged synthetic and excluded from episode creation and reviewer evidence

### Requirement: Corrections are grouped by causal episode
Related feedback events MUST be associated with one feedback episode identified by session, context epoch, and root assistant referent.

#### Scenario: Multiple steering prompts target one active turn
- **WHEN** several user prompts steer or correct the same assistant turn before the episode closes
- **THEN** they are attached to one episode and cannot create separate immediate reviewer jobs

#### Scenario: Follow-up arrives after no-lesson review
- **WHEN** an episode was reviewed with no lesson and a follow-up has no new assistant referent
- **THEN** the closed episode is not reopened and no new immediate job is created

#### Scenario: New assistant output is later corrected
- **WHEN** a later correction has a different causal assistant referent
- **THEN** the runtime creates a new episode with a distinct identity

### Requirement: Episode scheduling is stateful and idempotent
An episode SHALL create at most one immediate reviewer job, only after an eligible strong signal or debounce/turn-close transition.

#### Scenario: Weak active-turn steering is observed
- **WHEN** the only evidence is an assistant referent within an active turn
- **THEN** the episode remains open and is not submitted synchronously on each prompt

#### Scenario: Strong interruption closes an episode
- **WHEN** the host records an interruption or explicit feedback event and the episode closes
- **THEN** one reviewer job is transactionally assigned to the episode's eligible events

#### Scenario: Duplicate hook and reconcile paths see the same episode
- **WHEN** prompt capture and transcript reconciliation observe duplicate sources for the episode
- **THEN** unique source observation and episode constraints preserve one episode and one job
