# Subagent Progress

## Architecture reset

- Phase: `design_revision_user_review`
- Source implementation: paused until the revised Design Doc is reviewed
- Approved direction: immediate detached reviewer subagent, prompt-only non-interference, Markdown long-term memory, no receipt/Stop/notification/three-item batch/resident scheduler/RAG
- Supported platforms: macOS and Linux
- Live boundary: global AFL hooks remain disabled; no real HOME/runtime/database changes are authorized

## Superseded implementation

- Former Task 1 (`7d6b1e3`) and Task 2 (`5c72633..fd7ec68`) were completed against the rejected notification/schema architecture and are not accepted as completed work under the revised specification.
- Former Task 3 (`002302e`, `6f511ee`) attempted to make Stop fail-open. The new default installation removes AFL Stop entirely, so its shell descendant-cleanup blocker and proposed Node watchdog are no longer implementation requirements.
- All source changes in `7d6b1e3..9c89e00` must be audited in the new implementation plan. Reusable generic lease/logging primitives may survive; notification, Stop, episode, maintenance and scheduler paths must be removed rather than left dormant.

## Current checkpoint

- OpenSpec proposal/design/specs/tasks: rewritten for the simplified architecture
- Canonical technical Design Doc: rewritten
- Previous implementation plan: marked superseded and forbidden to resume
- Next gate: strict OpenSpec validation, Design Doc self-review, documentation commit, then user review
- No implementation subagent is active for this design checkpoint
