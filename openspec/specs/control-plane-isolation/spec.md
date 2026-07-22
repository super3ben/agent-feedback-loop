# control-plane-isolation Specification

## Purpose
TBD - created by archiving change isolate-feedback-control-plane. Update Purpose after archive.
## Requirements
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

#### Scenario: A reviewer publishes during the current prompt hook
- **WHEN** a detached reviewer atomically publishes a document at or after the current hook's fixed publication cutoff
- **THEN** that document is excluded from the current response and can become eligible only on a later matching prompt

### Requirement: Capture input is frozen before side effects
The runtime SHALL synchronously normalize each capture into one caller-independent immutable snapshot before any await, blob I/O, SQLite access, or other capture side effect. The snapshot SHALL contain the ordered body-free canonical identity fields `event_uid`, `source_provider`, `session_uid`, `context_epoch`, `source_namespace`, `source_id`, `source_event_id`, `source_offset`, `capture_source`, `native_turn_id`, `source_timestamp`, `role`, `referent_event_uid`, `content_hash`, and `completeness`, plus bounded project/storage metadata, derived observation/event keys, the canonical signature, and the caller-supplied encrypted reference.

#### Scenario: Capture identity is invalid
- **WHEN** any identity alias conflicts or a required identity, including the canonical content hash, is empty or out of bounds
- **THEN** capture fails closed before blob I/O or SQLite mutation and no event or observation is persisted

#### Scenario: Caller mutates the event while blob writing is pending
- **WHEN** preflight has returned and the caller changes any field on its original event object before blob I/O completes
- **THEN** resolution, persistence, and the returned result use only the frozen snapshot and never re-read or modify that original object

#### Scenario: Raw content is captured
- **WHEN** capture receives `rawText`
- **THEN** the runtime uses it only to compute a separate blob content hash and write the content-addressed encrypted blob, and raw content, the blob content hash, and the encrypted reference are not included in the canonical signature or required to equal the canonical event content hash

### Requirement: Public capture resolution is one atomic SQLite decision
After blob writing returns an authoritative encrypted reference, public capture SHALL perform exact replay resolution, event UID/source identity conflict checks, complete alias candidate re-evaluation, alias attachment, and new event insertion as one ordered decision inside a single `BEGIN IMMEDIATE`. Public capture SHALL NOT perform a transaction-external database resolve before that decision, and blob I/O SHALL NOT occur inside the SQLite transaction.

#### Scenario: Exact observation is replayed through public or direct capture
- **WHEN** an existing observation has the same observation key, full 15-field signature, binding, and separate encrypted-reference invariant
- **THEN** capture returns an exact duplicate whose `eventUid` and `blobPath` both identify the persisted event

#### Scenario: Exact observation changes identity or encrypted reference
- **WHEN** an existing observation key is supplied with a different canonical field, event UID/source identity binding, or authoritative encrypted reference
- **THEN** capture fails closed with a fixed collision and does not return a partial or contradictory duplicate result

#### Scenario: Supplied reference conflicts with blob output
- **WHEN** the caller supplied a non-null encrypted reference and the content-addressed blob writer returns a different reference
- **THEN** public capture fails closed before the SQLite decision and persists no event or observation

#### Scenario: Two different aliases are first captured concurrently
- **WHEN** two valid observations from different alias namespaces describe the same eligible event and enter public capture concurrently
- **THEN** the transactions serialize to exactly one event and two observations, with one result classified as new and the other as duplicate/alias

#### Scenario: A unique alias has incompatible blob storage
- **WHEN** the in-transaction alias recheck finds exactly one semantic candidate but its persisted encrypted reference is incompatible with the authoritative reference
- **THEN** capture does not attach the alias to that event and, absent a UID/source identity conflict, inserts a new event and observation

#### Scenario: Alias candidates are absent or ambiguous
- **WHEN** the in-transaction full candidate recheck finds zero candidates or more than one candidate
- **THEN** capture inserts a new event and observation without modifying an existing event

### Requirement: Capture compatibility has one canonical contract
Public capture and the retained direct capture APIs SHALL share the same normalization, signature, observation/storage-key, provider/session, and encrypted-reference invariant helpers. The legacy resolve API MAY remain available for direct callers but SHALL NOT be used as a public two-phase resolve fast path.

#### Scenario: A successful capture result is returned
- **WHEN** capture resolves an exact replay, attaches an alias, or inserts a new event
- **THEN** its duplicate classification, `eventUid`, `blobPath`, and any returned event view are internally consistent with one committed event and never combine caller-mutated and persisted references

#### Scenario: Provider or session identity conflicts
- **WHEN** a capture would change the immutable provider of an existing session or cross a provider/session/context boundary during replay or alias resolution
- **THEN** the existing collision behavior remains fail closed

#### Scenario: Runtime opens an incompatible control database
- **WHEN** the v1 control schema, columns, indexes, foreign keys, triggers, or views do not match the canonical fingerprint
- **THEN** runtime open fails closed without creating, migrating, or changing the database

#### Scenario: Capture commits a durable blob reference
- **WHEN** the SQLite decision commits successfully
- **THEN** the runtime performs the existing transaction-external content-addressed second-write/GC-race confirmation and leaves deletion decisions to retention GC

#### Scenario: Capture or alias storage fails
- **WHEN** the capture API reports an identity, blob-reference, alias, or database failure to prompt orchestration
- **THEN** the business turn remains bounded fail-open and no AFL status is printed to the user

### Requirement: Atomic capture does not widen the control plane
The atomic capture boundary SHALL use the existing control schema and version and SHALL NOT add a scheduler, service, RAG layer, notification path, Stop hook, or long-term SQLite memory body. Markdown SHALL remain the long-term truth and SQLite SHALL remain a short-term bounded control ledger.

#### Scenario: Atomic capture is implemented
- **WHEN** public and direct capture adopt the frozen-snapshot and transactional resolve-or-insert contract
- **THEN** the v1 schema/table set and the existing Markdown/SQLite ownership boundary remain unchanged and no new background or user-visible control path is introduced

