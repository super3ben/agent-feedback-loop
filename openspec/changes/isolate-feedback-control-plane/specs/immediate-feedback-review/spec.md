## ADDED Requirements

### Requirement: Distinct feedback candidates start review immediately
The runtime SHALL transactionally create and attempt to launch one detached reviewer job as soon as a distinct explicit feedback candidate is captured; it SHALL NOT wait for a minimum event count, debounce batch, episode close, or resident scheduler tick.

#### Scenario: First explicit dissatisfaction is captured
- **WHEN** the first eligible feedback event in a session is committed
- **THEN** its reviewer job is immediately passed to the detached launcher and the prompt hook does not wait for completion

#### Scenario: The same hook event is replayed
- **WHEN** duplicate hook or reconciliation paths submit the same stable source identity and assistant referent
- **THEN** the existing job is reused and no duplicate reviewer is launched concurrently

#### Scenario: Similar feedback occurs in a later session
- **WHEN** a different source event describes the same method failure
- **THEN** it receives a distinct immediate review and is not suppressed by text similarity

### Requirement: Candidate detection combines independent evidence
The local detector SHALL use strong host structure or multiple independent retrospective evidence classes and SHALL treat no single keyword as semantic authority.

#### Scenario: Completed-turn retrospective dissatisfaction is explicit
- **WHEN** a user prompt has a prior assistant referent and combines negative evaluation, backward reference, causal/accountability language, and an expected-process contrast
- **THEN** the prompt becomes an immediate candidate with bounded reason codes

#### Scenario: User asks an ordinary or invited design question
- **WHEN** a prompt is a neutral follow-up, an answer to an agent-requested design choice, or a question about AFL without retrospective dissatisfaction evidence
- **THEN** it does not become a candidate solely because it contains words such as “为什么”, “问题”, or “反思”

#### Scenario: Host records active-turn correction
- **WHEN** the host supplies a trusted active-turn steering, interruption, turn-aborted, or explicit feedback signal
- **THEN** the structural signal is sufficient to create an immediate candidate after synthetic traffic is excluded

### Requirement: Reviewer is the final semantic gate
The detached reviewer SHALL validate the referenced prior output, unmet requirement, agent responsibility, recurrence evidence, and reusable method change before any long-term document is published.

#### Scenario: Candidate is a false positive
- **WHEN** bounded context does not prove a reusable agent-caused failure
- **THEN** the job terminates as `reviewed_no_lesson` and creates no reflection document

#### Scenario: Candidate proves a reusable failure
- **WHEN** the reviewer result satisfies the structured contract and controller validation
- **THEN** the result proceeds to atomic reflection publication

### Requirement: Detached execution is short-lived and recoverable
On macOS and Linux, reviewer execution MUST be detached from the prompt hook, use fenced job ownership, and require no resident scheduler.

#### Scenario: Detached launch succeeds
- **WHEN** the job transaction commits and the process is spawned
- **THEN** the parent unrefs the child and returns without waiting for provider or publication

#### Scenario: Launch fails or a worker crashes
- **WHEN** spawn fails or a lease expires before a terminal result
- **THEN** the job remains recoverable and a later prompt performs a bounded opportunistic relaunch without blocking that prompt
