## ADDED Requirements

### Requirement: Business-turn non-interference
The AFL runtime SHALL allow the host's normal business turn to finish independently of notification, reviewer, lesson-selection, and memory-maintenance state.

#### Scenario: Receipt is pending at Stop
- **WHEN** a Stop hook observes a pending or failed AFL notification delivery
- **THEN** the hook returns the host's non-blocking success response and does not request another assistant round

#### Scenario: Reviewer or maintenance is unavailable
- **WHEN** a reviewer or memory-maintenance worker is pending, failed, retrying, or exhausted
- **THEN** the current business turn continues without a Stop block or model instruction to wait

### Requirement: Capture-only Stop contract
Transactional AFL Stop hooks MUST limit their synchronous responsibilities to bounded capture, delivery observation, reconciliation bookkeeping, and fail-open response generation.

#### Scenario: Capture succeeds
- **WHEN** the Stop hook receives a valid host payload
- **THEN** it persists available evidence and returns without emitting `decision=block` or `decision=deny`

#### Scenario: Capture fails
- **WHEN** evidence parsing, storage, or reconciliation fails
- **THEN** the failure is logged with a reason code and the host is allowed to stop normally

### Requirement: Control text is excluded from model instructions
AFL MUST NOT inject receipt reproduction instructions, maintenance status claims, or generic correction commands into the main model context.

#### Scenario: Notification is ready during prompt submission
- **WHEN** `UserPromptSubmit` finds a deliverable notification
- **THEN** the hook response contains no instruction to print or explain that notification

#### Scenario: Applicable lesson exists
- **WHEN** the selector returns an applicable lesson card
- **THEN** the hook may inject only the bounded lesson guidance and provenance nonce, not notification or maintenance control text
