## ADDED Requirements

### Requirement: Business-turn non-interference
The AFL runtime SHALL let the host business turn finish independently of capture, candidate detection, reviewer, storage, document parsing, and memory selection state.

#### Scenario: Any AFL subsystem fails
- **WHEN** capture, storage, detached launch, reviewer recovery, document parsing, or selection fails
- **THEN** the prompt hook returns a bounded fail-open response and does not delay, replace, or request another assistant round

#### Scenario: Reviewer is still running
- **WHEN** a detached reviewer job is pending, running, retrying, or exhausted
- **THEN** the current business turn continues without reviewer status text or an instruction to wait

### Requirement: Default installation has no Stop control path
The supported macOS and Linux installation SHALL NOT register an AFL Stop hook or rely on Stop output for delivery, reconciliation, or reviewer progress.

#### Scenario: Fresh configuration is installed
- **WHEN** the installer writes the managed AFL configuration into a fresh HOME
- **THEN** it contains the prompt hook and no AFL Stop hook

#### Scenario: Legacy managed configuration is upgraded
- **WHEN** the installer encounters an AFL-managed Stop hook from an older version
- **THEN** it removes that managed entry without changing unrelated user hooks

### Requirement: AFL control text is excluded from the user conversation
AFL MUST NOT inject or emit receipt reproduction instructions, hook prompts, reviewer status, maintenance claims, notification text, or generic correction commands through the main model.

#### Scenario: Legacy receipt or hook prompt is observed
- **WHEN** capture encounters `[AFL]`, `afl-receipt`, or `Output this receipt verbatim before stopping` control traffic
- **THEN** it is classified as synthetic, excluded from feedback candidates, and not returned to the model as user-visible work

#### Scenario: Applicable reflection exists
- **WHEN** document selection finds an applicable method
- **THEN** the prompt hook may return only bounded method guidance and opaque provenance, not AFL operational state
