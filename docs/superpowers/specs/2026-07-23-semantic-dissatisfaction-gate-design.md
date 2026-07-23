# Semantic Dissatisfaction Gate Design

Date: 2026-07-23
Status: proposed

## Background

The current AFL feedback trigger treats a fixed set of lexical patterns as a hard gate for user dissatisfaction. In real usage this produces false negatives:

- repeated known-information complaints such as “不是都有吗” / “怎么又不知道了”
- recurring-failure complaints such as “之前出现过好几次了” / “都第七八次了”
- rhetorical accountability such as “你为什么之前没有处理…”

Humans reliably hear these as dissatisfaction, blame, impatience, or correction. The current detector does not. In addition, some real turns have not been recorded into `session_events`, which hides the true cause of non-triggering and makes detector misses indistinguishable from capture misses.

We also observed that Codex is slow when used as a full reviewer. The current path feeds it a prompt that looks like a general review task rather than a narrow classification task. This increases tail latency without improving trigger accuracy.

## Goal

Improve dissatisfaction detection and reviewer latency **without reducing current trigger hit rate**.

More specifically:

1. Preserve all currently-triggering explicit dissatisfaction cases.
2. Recover implicit dissatisfaction cases that are currently missed.
3. Keep the prompt hook fast and silent.
4. Reduce unnecessary full-reviewer invocations, especially on slow Codex paths.
5. Make it diagnosable whether a miss came from capture failure or semantic gating.

## Non-goals

This design does not:

- change the lesson / no_lesson contract
- change lesson publication format or storage model
- change control-store schema for convergence / lineage / cutover
- introduce a new resident service, queue, or scheduler
- require the user to configure a separate model for semantic gating
- replace the current full reviewer with a different provider strategy
- weaken candidate coverage to gain speed

## Recommended approach

Adopt a three-layer reviewer pipeline:

1. **Evidence collection** keeps the current raw capture semantics and remains recall-oriented.
2. **Semantic dissatisfaction gate** performs a lightweight semantic decision using the same provider ecosystem the user already runs, but with a dedicated short prompt, narrow schema, and minimal context projection.
3. **Full reviewer** runs only after the semantic gate affirms that the user is actually expressing dissatisfaction about prior assistant behavior.

The current hard lexical dissatisfaction gate is downgraded to a coarse recall signal, not a final decision authority.

## Design overview

### 1. Keep raw evidence collection intact

The existing capture layer continues to collect the raw prompt event, referent assistant event, and structural metadata. This layer must stay recall-oriented and must not optimize away facts for latency reasons.

Collected evidence continues to include:

- current user prompt
- direct assistant referent when available
- session / provider / project identity
- recurrence and prior-emission facts already available cheaply
- structural reasons such as explicit interruption signals

This layer is not responsible for deciding dissatisfaction.

### 2. Replace the lexical hard gate with a coarse recall stage

The current detector remains useful, but only as a **coarse candidate generator**. Its responsibility changes from:

- “this is dissatisfaction”

to:

- “this deserves semantic checking”

The coarse recall stage should become broader in three targeted ways:

#### 2.1 Known-information forgetting / repeated retrieval complaints

Candidate recall should include prompts that combine:

- a concrete known fact payload (port, password, path, account, identifier, hostname, switch value, etc.)
- with rhetorical or contrastive language indicating the assistant should already know it

Examples:

- “这些之前都有存的呀怎么又不知道了”
- “密码不是都有吗端口55555…”

#### 2.2 Recurrence complaints

Candidate recall should include recurrence language that implies user impatience or blame, not just historical reference.

Examples:

- “之前出现过好几次了”
- “都第七八次了”
- “怎么每次都是这个问题”
- “又来问这个”

#### 2.3 Rhetorical accountability

Candidate recall should include rhetorical blame patterns that do not necessarily use explicit keywords like “做错了” or “不合理”.

Examples:

- “你为什么之前没有处理…”
- “怎么又…”
- “不是已经…了吗”
- “还要我再说一遍吗”

These signals are still **not final dissatisfaction proof**. They are only expansion signals for semantic review.

### 3. Add a semantic dissatisfaction gate inside the background reviewer job

The semantic gate runs **inside the existing detached reviewer job**, before the full reviewer. This preserves a fast prompt hook and avoids introducing a second foreground latency source.

The new pipeline becomes:

1. prompt hook captures and returns immediately
2. event is recorded and a reviewer job may be scheduled
3. reviewer job runs a lightweight semantic dissatisfaction gate
4. only if the gate returns true does the job continue to the full reviewer
5. full reviewer decides `no_lesson` vs `lesson`

This keeps the external architecture stable: still one detached job, but with a lightweight first phase.

### 4. Semantic gate input contract

The semantic gate consumes a **minimal projected envelope** rather than the full reviewer context.

Required fields:

- current user prompt text
- relevant assistant referent excerpt
- provider id
- stable project/session identity
- cheap structural markers such as recurrence/back-reference/accountability flags
- optional prior-emission / recurrence facts if already cheaply available

Not included:

- full lesson documents
- long audit trails
- unrelated control-plane metadata
- provider-specific transport noise

This projection must be deterministic and rule-based. It must not use an LLM summarizer. The purpose is zero-semantic-loss compression, not reinterpretation.

### 5. Semantic gate output contract

The semantic gate returns a narrow schema:

```json
{
  "is_dissatisfaction": true,
  "confidence": "high",
  "reason_class": "forgetting_known_info"
}
```

Allowed `reason_class` values:

- `forgetting_known_info`
- `repeated_failure`
- `process_complaint`
- `direct_correction`
- `accountability_rhetorical`
- `not_dissatisfaction`

It does **not** generate lesson text or long-form analysis.

### 6. Provider strategy for the semantic gate

The semantic gate must **reuse the user’s existing provider ecosystem**. It does not introduce a separately configured model.

That means:

- Claude sessions use the existing Claude provider path.
- Codex sessions use the existing Codex provider path.
- Gemini sessions use the existing Gemini provider path.

The optimization comes from a lighter task profile, not from a separately configured model.

Provider-specific behavior is still allowed internally:

- shorter semantic-gate prompt
- smaller schema
- shorter timeout
- smaller context projection

But these are implementation profiles, not user-facing model choices.

### 7. Split provider profiles into two explicit reviewer modes

Each provider gets two internal profiles:

#### 7.1 `semantic-gate` profile

Purpose: classify dissatisfaction only.

Characteristics:

- very short prompt
- very small schema
- minimal context
- short timeout
- explicit instruction to avoid broad analysis or implementation advice

#### 7.2 `full-reviewer` profile

Purpose: decide `lesson` vs `no_lesson` and, when needed, produce the structured lesson payload.

Characteristics:

- current reviewer contract retained
- provider-specific prompt tightening permitted
- must remain compatible with today’s published lesson format

### 8. Codex-specific latency optimization

Codex appears slow because the current reviewer prompt looks too much like a broad agent review task. The design addresses this without changing correctness semantics:

1. give Codex a dedicated `semantic-gate` prompt that asks only whether the user is expressing dissatisfaction about prior assistant behavior
2. give Codex a tighter `full-reviewer` prompt that forbids broad investigation, design expansion, and implementation suggestions
3. feed Codex the minimal semantic projection instead of the current heavier reviewer context when only gating is needed

This treats Codex as a structured classifier first, not a general-purpose reviewer.

## Safety / recall guarantee

To avoid reducing existing hit rate, rollout uses a **preserve-and-expand** rule:

- cases that already satisfy today’s explicit dissatisfaction path still continue into the full reviewer directly
- cases that do not satisfy the explicit path but do match the broadened coarse recall signals go through the semantic gate
- only the semantic gate can admit these newly expanded cases into the full reviewer

This means current explicit hits are preserved; the new gate only adds coverage.

## Capture diagnosability requirement

A separate but mandatory improvement accompanies this design:

Every hook execution must end in one of two observable outcomes:

1. a prompt event is durably recorded into `session_events`, or
2. a bounded fail-open reason code is durably recorded somewhere queryable

Without this, capture misses masquerade as semantic misses and make trigger evaluation impossible.

This requirement does not change user-visible behavior, but it is required for trustworthy diagnosis.

## Validation strategy

### A. Correctness corpus

Use four evaluation sets:

1. current explicit dissatisfaction cases (must remain hits)
2. currently missed implicit dissatisfaction cases (must improve)
3. neutral investigation / ordinary follow-up prompts (must remain mostly non-triggers)
4. ambiguous boundary cases (measure stability)

### B. Shadow mode rollout

Before switching decisions, run the semantic gate in shadow mode:

- legacy trigger path remains authoritative
- semantic gate runs and logs its conclusion
- compare:
  - legacy-hit / gate-miss
  - legacy-miss / gate-hit
  - disagreements by reason class

Only after shadow evidence shows preserved explicit hits and useful recovery of implicit dissatisfaction does the system move to preserve-and-expand mode.

### C. Latency metrics

Track separately:

- hook latency
- semantic gate latency
- full reviewer latency
- end-to-end prompt → published lesson latency
- fraction of candidate jobs that stop at semantic gate instead of reaching the full reviewer

The optimization target is lower tail latency on Codex-heavy flows without hook regression.

### D. Real-case acceptance tests

The following must become passing integration cases:

- “这些之前都有存的呀怎么又不知道了”
- “密码不是都有吗端口55555…”
- “之前出现过好几次了”
- “都第七八次了”

They must be captured, admitted into semantic checking, and classified as dissatisfaction when a valid assistant referent exists.

## Components expected to change

Primary design impact is local to the reviewer subsystem:

- `feedback-signal` coarse recall logic
- a new semantic dissatisfaction gate prompt/schema/profile
- reviewer context projection logic
- provider rendering for semantic-gate vs full-reviewer profiles
- capture diagnostics for unrecorded hook executions

The control plane, lesson publication model, and convergence authority model remain unchanged.

## Recommendation

Implement **preserve-and-expand** semantic gating:

- keep today’s explicit hits as a direct path
- broaden coarse recall only enough to send plausible hidden dissatisfaction into semantic checking
- reuse the existing provider ecosystem with a dedicated lightweight gate profile
- add capture-path observability so missed events stop hiding detector failures

This is the smallest design that fixes the current product failure: users can express obvious impatience and blame in natural language, yet the system misses them because fixed negative-evaluation keywords were treated as the final arbiter.