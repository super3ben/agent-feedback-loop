# memory-selection-safety Specification

## Purpose
TBD - created by archiving change isolate-feedback-control-plane. Update Purpose after archive.
## Requirements
### Requirement: Reflection documents are selected directly
The selector SHALL read applicable project Markdown files from `.agent/reflections` and SHALL NOT require a database lesson body, card table, embedding index, or RAG service.

#### Scenario: Canonical reflection is complete
- **WHEN** a document has parseable scope, severity, method class, family identity, and method change
- **THEN** it is eligible for deterministic ranking and bounded prompt guidance

#### Scenario: Legacy reflection is incomplete
- **WHEN** a historical document cannot safely provide the required selection fields
- **THEN** it remains an auditable file, is omitted with `legacy_incomplete`, and does not block other documents

### Requirement: Capacity overflow produces omissions, not a global hold
The selector SHALL treat document-count and token limits as ranking constraints and SHALL return safe selected guidance plus structured omission reasons.

#### Scenario: Five severe documents compete for four slots
- **WHEN** five applicable complete severe documents have no semantic conflict and the configured maximum is four
- **THEN** the selector deterministically returns the highest-ranked four, records one `count_budget` omission, and returns no hold

#### Scenario: One document is oversized
- **WHEN** an applicable document exceeds the per-document or total token budget
- **THEN** it is omitted with `oversized_document` or `token_budget` while other eligible documents remain selectable

### Requirement: Selection order is deterministic
Applicable documents MUST have a stable total order using project scope, task relevance, severity, same-family recurrence, recency, and stable document identity.

#### Scenario: Identical input is selected repeatedly
- **WHEN** the same documents, prompt context, emission history, and budgets are evaluated
- **THEN** selected guidance and omissions are byte-for-byte stable

#### Scenario: A family has multiple reflections
- **WHEN** several complete documents share one family identity
- **THEN** recurrence is computed from documents and only the latest applicable method is emitted for that family

### Requirement: Selection diagnostics protect content
Selection diagnostics MUST report bounded opaque identity, reason code, rank, count, and numeric budget without logging reflection or prompt text.

#### Scenario: A document is omitted
- **WHEN** parsing, capacity, token budget, prior emission, or family projection omits a document
- **THEN** operational logs contain no raw report, method, or prompt content

