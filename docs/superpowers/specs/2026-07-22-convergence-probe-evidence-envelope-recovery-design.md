# Convergence Probe Evidence Envelope Recovery Design

**Date:** 2026-07-22  
**Status:** approved design, implementation not authorized  
**Owns:** Task 5 `probe-bounded-input-carries-semantic-decision-evidence`

## 1. Goal

Give the detached Reflection Probe enough bounded, authoritative semantic evidence to
judge wrong direction, overdesign, unnecessary scope, and unmet user value without
putting prompt, diff, contract, review, or lesson bodies in SQLite and without connecting
the Probe to the main conversation.

## 2. Authoritative evidence

The final integration review traced the provider input to one `status` object containing
only opaque IDs, counters, state names, and digests. The current runner therefore cannot
derive its required `wrong_assumption`, `unnecessary_scope`, `minimal_next_step`, or
`falsification_test` from supplied evidence.

The lease, detached process, strict result schema, no-tool provider, result digest, and
deterministic post-Probe grant boundary are sound and remain in place.

## 3. Hard constraints

- Semantic context is supplied by a named adapter/controller producer. Probe output can
  never create its own evidence, importance, contract, hard decision, or grant.
- Missing required semantic context does not launch the provider and does not ask it to
  guess.
- SQLite stores only a context digest and lifecycle metadata, never context plaintext or
  ciphertext.
- The encrypted context is short-lived operational data, not a Markdown lesson, contract
  authority, reviewer archive, RAG corpus, or long-term memory source.
- No complete prompt, transcript, diff, review report, task brief, source file, absolute
  path, secret, token, grant artifact, or chain-of-thought enters the context.
- The existing prompt-only dissatisfaction reviewer and Markdown selector remain
  unchanged.
- No new table, schema version, resident scheduler, service, RAG layer, vector database,
  lesson reader, notification transport, or main-session output is added.
- macOS and Linux use the same direct detached, lease-fenced lifecycle.

## 4. Alternatives considered

### 4.1 Selected: encrypted short-lived context artifact

Store canonical bounded JSON under a separate private context root using the existing key
and encrypted-blob capability. Put only its digest in the existing
`reflection_requested` event. This survives detached launch and bounded retry without a
database body or background service.

### 4.2 Rejected: bounded semantic text in SQLite

This is operationally simple but makes SQLite a second source for task/review content and
violates the approved privacy boundary.

### 4.3 Rejected: reconstruct context from repository documents at Probe time

The detached runner would need repository paths, document discovery, parsing, and broader
file authority. It could not reliably reconstruct the exact review evidence or decision
basis and would expand into a new subsystem.

### 4.4 Rejected: keep the opaque Probe and downgrade its claims

This avoids storage but does not deliver the requested self-review value. Structural
warnings alone cannot identify a wrong assumption or unnecessary scope.

## 5. Exact evidence envelope

The canonical plaintext is strict JSON with exact keys and a maximum UTF-8 size of
16 KiB:

```json
{
  "version": 1,
  "identity": {
    "taskUid": "opaque-id",
    "fingerprint": "opaque-id",
    "boundaryId": "bounded-id",
    "canonicalInvariantId": "bounded-id"
  },
  "contract": {
    "goalSummary": "bounded summary",
    "acceptanceCriteria": ["bounded criterion"],
    "exclusions": ["bounded exclusion"],
    "importance": "routine",
    "importanceAuthority": "approved_plan",
    "contractRevision": "sha256"
  },
  "trigger": {
    "decision": "reflection_required",
    "breakerReason": "bounded_reason",
    "failureCount": 1,
    "currentGeneration": 1,
    "decisionBasisDigest": "sha256"
  },
  "recentGenerations": [
    {
      "generation": 1,
      "action": "local_fix",
      "changedFileCount": 3,
      "additions": 40,
      "deletions": 12,
      "pathCategories": ["source", "tests"],
      "testStatus": "passed",
      "evidenceClass": "review_finding",
      "evidenceDigest": "sha256"
    }
  ],
  "reviewEvidence": {
    "severity": "important",
    "verdict": "changes_required",
    "hypothesis": "bounded hypothesis",
    "newEvidence": "bounded evidence summary",
    "falsificationTest": "bounded falsification test"
  }
}
```

Bounds are fixed:

- `goalSummary`: 1–512 UTF-8 characters.
- `acceptanceCriteria`: 1–8 entries, each 1–256 characters.
- `exclusions`: 0–8 entries, each 1–256 characters.
- `recentGenerations`: 0–2 entries.
- `pathCategories`: 0–8 canonical category IDs; never paths.
- Counts: safe non-negative integers capped at 10,000,000.
- `hypothesis`, `newEvidence`, and `falsificationTest`: each 1–1,024 characters.
- IDs: existing canonical identifier bounds.
- Digests: exact lowercase SHA-256.
- Unknown keys, accessors, proxies, sparse/decorated arrays, unsupported prototypes,
  NUL, invalid UTF-8, secret/control-receipt patterns, and oversize input are rejected.

The context validator returns a detached deeply frozen value and never invokes getters.

## 6. Producer authority

The controller accepts a `probeContext` only alongside the exact evaluated request that
produced `reflection_required`.

- Contract fields must match the current task contract revision, importance, and
  importance authority.
- Identity, failure count, generation, decision basis, and Breaker reason are derived by
  the controller, not accepted from a caller.
- Review evidence is accepted only from the latest immutable `review_recorded` or
  `evidence_recorded` event and must match its evidence and decision-basis digests.
- Generation summaries are derived from the last two Store generations/events. Callers
  may supply bounded file/test observations only through an adapter evidence projection;
  those observations remain advisory unless their evidence class is trusted.
- Goal, acceptance, and exclusions come from the host's approved task/change projection.
  They are not synthesized from IDs or guessed by the model.

For the explicit SDD CLI, semantic context is opt-in through bounded standard input rather
than command-line text or a plaintext path:

```sh
agent-feedback-loop guard ... record-review ... --probe-context-stdin
```

The package reads at most 16 KiB, validates the exact JSON, and passes the projection to
the controller. Direct OpenSpec/Comet adapters pass the same typed projection through the
API. Until a host supplies it, the host cannot claim semantic Probe capability.

If required context is absent or invalid when policy requests reflection:

- `workflow_gate` and `checkpoint_gate` produce deterministic `checkpoint_required`
  with bounded reason `probe_context_required` or `probe_context_invalid`.
- `audit_only` produces `warn`.
- No artifact, request event, lease, process, provider call, or grant is created.

## 7. Encrypted artifact lifecycle

Add `paths.probeContextRoot` at
`~/.agent/feedback-loop-data/convergence/probe-context`, while reusing the existing key
provider and encrypted blob implementation.

1. The controller validates and canonicalizes the context after deterministic policy
   returns `reflection_required`.
2. It computes `contextDigest = SHA-256(canonical plaintext)`.
3. It writes ciphertext atomically under the digest with owner-private directory/file
   modes and inode/symlink protections.
4. It calls `requestConvergenceProbe` with `contextDigest`.
5. The existing `reflection_requested` event uses that digest as its source digest; its
   facts remain body-free. No schema field is added.
6. If the Store transaction fails, the newly written artifact is removed. A replay with
   the same canonical context reuses the same artifact and request identity.
7. Only after the request transaction commits may the detached launcher run.
8. The runner claims its existing lease, reads the request digest through a narrow Store
   API, opens/decrypts the artifact, recomputes the digest, and verifies identity and
   current decision basis before calling the provider.
9. Retryable provider failure retains the same context. Completion or final non-retryable
   failure records the Store transition first, then removes the artifact.
10. Cleanup failure emits a bounded reason and never rewrites the terminal result.

Orphans created by a crash between artifact publication and request commit are cleaned
opportunistically by later explicit convergence/Probe commands. Each invocation examines
at most 32 private entries and removes only entries older than 24 hours that have no live
request digest. No prompt hook performs this cleanup and no scheduler is added.

## 8. Provider and result boundary

Provider input becomes exactly:

```js
{ status: boundedStatus, evidence: boundedProbeContext }
```

The existing no-tool provider isolation and strict result schema remain unchanged. The
result is completion advice only. `continue_once`, simplify, rollback, checkpoint, human
decision, and finish recommendations still pass through deterministic policy, current
contract/evidence checks, and one-shot grant issuance. A semantically plausible result
cannot authorize itself.

No evidence body, result body, or context plaintext is returned to the main conversation,
ordinary Guard stdout, structured logs, or Markdown lessons.

## 9. Review Loop Guard bookkeeping

After the written spec is approved:

1. Record a direction checkpoint for Task 5
   `probe-bounded-input-carries-semantic-decision-evidence` at
   `convergence-probe/evidence-envelope`.
2. Authorize at most one `architecture_fix` receipt after the implementation plan is
   approved.
3. The repair may touch only context validation/storage, controller request binding,
   runner/launcher consumption, bounded CLI ingestion, focused tests, and truthful
   capability documentation.
4. Any architecture-fix re-review failure returns to human decision. No local-fix retry,
   invariant rename, counter reset, or second architecture generation is allowed.

## 10. Falsifiable acceptance

1. Two otherwise identical Probes with different approved goals, exclusions, latest
   evidence, or Breaker reasons deliver those exact bounded differences to the provider.
2. Missing goal, acceptance criteria, provenance, or current decision binding prevents
   artifact creation and provider launch.
3. SQLite, WAL/SHM, stdout, stderr, structured logs, grant artifacts, and Markdown contain
   no context plaintext or ciphertext reference beyond the digest.
4. Artifact directories/files are private; symlink, unowned, permissive, replaced,
   truncated, corrupted, wrong-key, and digest-mismatched artifacts fail closed before the
   provider call.
5. Request replay is idempotent. Retry uses the same digest. A stale generation, changed
   contract, or changed decision basis cannot consume an old context.
6. Completion and final failure transition once; cleanup cannot cause a second provider
   execution or revive a grant.
7. Crash-orphan cleanup is bounded, explicit-call-only, and never scans or deletes outside
   the private context root.
8. Probe advice still cannot raise importance, alter the contract, reset history, sign a
   grant, or bypass adapter capability.
9. Prompt hooks keep native no-op/fail-open output under context, Store, provider, spawn,
   and cleanup failures.
10. macOS and supported Linux focused tests cover validation, encryption, detached retry,
    cleanup, privacy, and no-provider-on-missing-context; full regressions and package
    inventory remain green.

## 11. Stop conditions

Stop and return to human decision if implementation requires storing semantic bodies in
SQLite, reading the project tree at Probe time, adding a scheduler/service/schema/table,
passing plaintext through argv or logs, weakening lease/grant authority, changing the
prompt feedback/Markdown path, or launching a Probe without all required authoritative
context.
