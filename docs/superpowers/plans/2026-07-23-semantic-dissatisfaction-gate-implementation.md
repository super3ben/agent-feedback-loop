# Semantic Dissatisfaction Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a preserve-and-expand semantic dissatisfaction gate so AFL stops missing natural-language impatience / blame, while reducing unnecessary full-reviewer work and keeping current explicit-hit behavior unchanged.

**Architecture:** Keep the existing prompt hook, event capture, detached reviewer job, and lesson publication pipeline. Refactor the current lexical dissatisfaction detector into a coarse recall stage, add a lightweight semantic-gate reviewer profile inside the detached reviewer job, and only run the existing full reviewer after the semantic gate affirms real dissatisfaction about prior assistant behavior. Add capture-path observability so misses caused by unrecorded turns are distinguishable from semantic-gate misses.

**Tech Stack:** Node.js ESM, `node:test`, existing `codex` / `claude` / `gemini` reviewer providers, existing control SQLite store, existing prompt/schema packaging in `templates/`

## Global Constraints

- Do **not** reduce current explicit dissatisfaction hit rate; legacy explicit hits must remain a direct path into the full reviewer.
- Do **not** change the lesson / no_lesson contract, lesson publication format, or storage model.
- Do **not** introduce a new resident service, queue, or scheduler.
- Do **not** require the user to configure a separate model; the semantic gate must reuse the existing provider ecosystem.
- Do **not** move semantic checking into the foreground hook; the prompt hook must remain fast and silent.
- Do **not** use an LLM summarizer in the projection step; projection must be deterministic and rule-based.
- Do **not** weaken candidate coverage to gain speed.
- Preserve provider-specific transport correctness (`codex` result wrapping, `claude` wrapped `result` schema, `gemini` policy isolation).
- Add diagnosability for capture misses: every hook execution must either record the prompt event or record a bounded fail-open reason code somewhere queryable.

---

## File structure and responsibilities

- `src/feedback-signal.mjs` — keep raw evidence classification, expand coarse recall signals, and downgrade lexical rules from final gate to candidate expansion.
- `src/reviewer-provider.mjs` — add `semantic-gate` vs `full-reviewer` provider profiles, including prompt/schema selection and provider-specific rendering.
- `src/reviewer-runner.mjs` — run semantic gate first, stop early on `not_dissatisfaction`, continue to full reviewer only on positive gate.
- `src/cli.mjs` — thread new reviewer profile selection through `reviewer-run`, preserve existing CLI entry points.
- `src/capture.mjs` — record explicit capture fail-open reason codes when prompt events cannot be durably recorded.
- `templates/prompts/semantic-dissatisfaction-gate.md` — new lightweight semantic gate prompt.
- `templates/schemas/semantic-dissatisfaction-gate.schema.json` — new narrow semantic gate schema.
- `test/capture.test.mjs` — capture-path observability and fail-open recording coverage.
- `test/reviewer-provider.test.mjs` — provider profile routing, prompt/schema selection, and transport wrapping for semantic gate.
- `test/reviewer-runner.test.mjs` — semantic-gate-first control flow, early stop, and preserve-and-expand semantics.
- `test/e2e-smoke.test.mjs` — real-case prompt coverage for “不是都有吗 / 怎么又不知道了 / 之前出现过好几次了 / 都第七八次了”.
- `README.md`, `README-zh.md` — document new behavior only if user-visible semantics change (likely brief note on natural-language dissatisfaction coverage and capture diagnosability).

## Task 1: Expand coarse recall without changing current direct-hit behavior

**Files:**
- Modify: `src/feedback-signal.mjs:27-439`
- Test: `test/e2e-smoke.test.mjs`

**Interfaces:**
- Consumes: `detectFeedbackCandidate({ payload, userText, referent, now, maxBytes, maxSignalAgeMs }) -> { candidate, reasonCodes, score, referent }`
- Produces: `detectFeedbackCandidate(...).reasonCodes` must include new coarse-recall reasons for known-info forgetting, recurrence complaints, and rhetorical accountability; `candidate` must remain `true` for existing explicit dissatisfaction paths.

- [ ] **Step 1: Write failing coarse-recall tests for the real missed phrases**

```js
test("coarse recall admits repeated known-info complaints into semantic checking", async () => {
  const { detectFeedbackCandidate } = await import("../src/feedback-signal.mjs");
  const referent = {
    eventUid: "assistant:1",
    sessionUid: "codex:default:demo",
    projectId: "/tmp/demo",
    contentHash: "a".repeat(64),
    text: "I asked for the server password again instead of using the stored credentials."
  };

  const result = await detectFeedbackCandidate({
    payload: { cli: "codex", previous_assistant_message: { role: "assistant", content: [{ type: "output_text", text: referent.text }] } },
    userText: "这些之前都有存的呀怎么又不知道了，密码不是都有吗端口55555",
    referent
  });

  assert.equal(result.candidate, true);
  assert.match(result.reasonCodes.join(","), /known|forget|recurr|accountability|backward/u);
});

test("coarse recall admits recurrence frustration without requiring fixed negative keywords", async () => {
  const { detectFeedbackCandidate } = await import("../src/feedback-signal.mjs");
  const referent = {
    eventUid: "assistant:2",
    sessionUid: "codex:default:demo",
    projectId: "/tmp/demo",
    contentHash: "b".repeat(64),
    text: "I asked the user for the same credentials again."
  };

  const result = await detectFeedbackCandidate({
    payload: { cli: "codex", previous_assistant_message: { role: "assistant", content: [{ type: "output_text", text: referent.text }] } },
    userText: "之前出现过好几次了，都第七八次了，怎么每次还是要我再说一遍",
    referent
  });

  assert.equal(result.candidate, true);
  assert.ok(result.reasonCodes.length >= 2);
});
```

- [ ] **Step 2: Run the new focused tests and confirm they fail under today’s detector**

Run: `node --test --test-name-pattern "coarse recall admits" test/e2e-smoke.test.mjs`
Expected: FAIL because `candidate` is currently `false` for one or both prompts.

- [ ] **Step 3: Add new coarse-recall reason classes and broaden candidate admission**

```js
// In src/feedback-signal.mjs
const REASON_ORDER = Object.freeze([
  "negative_evaluation",
  "backward_reference",
  "causal_accountability",
  "expected_process_contrast",
  "explicit_correction",
  "known_info_forgetting",
  "recurrence_complaint",
  "rhetorical_accountability"
]);

const EVIDENCE_PATTERNS = Object.freeze({
  // keep existing patterns unchanged, then add:
  known_info_forgetting: Object.freeze([
    /(?:不是都(?:有|存)了吗?|这些之前都(?:有|存)的呀?)/u,
    /(?:密码|端口|路径|账号|host|hostname|token|open_id)[^。！？?\n]{0,64}(?:不是都|之前都)/u
  ]),
  recurrence_complaint: Object.freeze([
    /(?:之前出现过好几次了|都第[一二三四五六七八九十0-9]+次了|怎么每次都是|又来问这个)/u
  ]),
  rhetorical_accountability: Object.freeze([
    /(?:怎么又不知道了|还要我再说一遍吗|你为什么之前没有)/u
  ])
});

export function classifyRetrospectiveEvidence({ userText, hasReferent }) {
  const text = normalizedText(userText);
  const reasons = new Set();
  for (const reason of REASON_ORDER) {
    if (EVIDENCE_PATTERNS[reason].some((pattern) => pattern.test(text))) reasons.add(reason);
  }

  const explicit = Boolean(hasReferent) && reasons.has("negative_evaluation");
  const expanded = Boolean(hasReferent)
    && !explicit
    && (
      (reasons.has("known_info_forgetting") && reasons.has("backward_reference"))
      || reasons.has("recurrence_complaint")
      || reasons.has("rhetorical_accountability")
    );

  return {
    candidate: explicit || expanded,
    reasonCodes: REASON_ORDER.filter((reason) => reasons.has(reason)),
    score: 40 + REASON_ORDER.filter((reason) => reasons.has(reason)).length * 10
  };
}
```

- [ ] **Step 4: Run focused tests and the current explicit-feedback regression**

Run: `node --test --test-name-pattern "coarse recall admits|explicit-feedback" test/e2e-smoke.test.mjs test/capture.test.mjs`
Expected: PASS; existing explicit dissatisfaction cases still pass.

- [ ] **Step 5: Commit coarse recall expansion**

```bash
git add src/feedback-signal.mjs test/e2e-smoke.test.mjs test/capture.test.mjs
git commit -m "feat: broaden dissatisfaction coarse recall without replacing explicit hits"
```

## Task 2: Add semantic gate prompt/schema and provider profile selection

**Files:**
- Create: `templates/prompts/semantic-dissatisfaction-gate.md`
- Create: `templates/schemas/semantic-dissatisfaction-gate.schema.json`
- Modify: `src/reviewer-provider.mjs:190-459`
- Test: `test/reviewer-provider.test.mjs`

**Interfaces:**
- Consumes: `runReviewerProvider({ cli, executable, context, promptFile, schemaFile, resultKind, ... })`
- Produces:
  - `resultKind: "semantic_dissatisfaction_gate"` must be accepted
  - semantic-gate output shape `{ is_dissatisfaction: boolean, confidence: "low"|"medium"|"high", reason_class: string }`
  - provider routing must select the semantic prompt/schema pair for the new result kind

- [ ] **Step 1: Write failing provider tests for the new result kind**

```js
test("semantic gate result kind routes to the lightweight prompt and schema", async () => {
  const files = await inputFiles();
  let observed;
  const result = await runReviewerProvider({
    cli: "claude",
    executable: "/opt/claude",
    ...files,
    resultKind: "semantic_dissatisfaction_gate",
    context: { prompt: "这些之前都有存的呀怎么又不知道了", referent: { text: "I asked for the password again." } },
    runProcess: async (input) => {
      observed = input;
      return {
        stdout: JSON.stringify({ type: "result", structured_output: { result: {
          is_dissatisfaction: true,
          confidence: "high",
          reason_class: "forgetting_known_info"
        } } }),
        stderr: ""
      };
    }
  });

  assert.deepEqual(result, {
    is_dissatisfaction: true,
    confidence: "high",
    reason_class: "forgetting_known_info"
  });
  assert.match(observed.input, /dissatisfaction/i);
  assert.doesNotMatch(observed.input, /method_changes|root_cause|final_severity/);
});
```

- [ ] **Step 2: Run the focused provider test and confirm it fails**

Run: `node --test --test-name-pattern "semantic gate result kind" test/reviewer-provider.test.mjs`
Expected: FAIL because `resultKind: "semantic_dissatisfaction_gate"` is not supported yet.

- [ ] **Step 3: Add the semantic gate prompt and schema assets**

```md
# templates/prompts/semantic-dissatisfaction-gate.md
You are a lightweight semantic gate for background feedback review.

Task: Decide whether the current user message is expressing dissatisfaction,
blame, impatience, accountability, or correction about the assistant's prior
behavior.

Use only the supplied facts. Do not investigate, do not suggest fixes, do not
write a lesson, and do not expand scope.

Return structured output only.

Classify as dissatisfaction when the user is holding the assistant accountable
for forgetting known information, repeating a solved failure, forcing the user
to restate something, or otherwise complaining about prior assistant behavior.
```

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "is_dissatisfaction": { "type": "boolean" },
    "confidence": { "type": "string", "enum": ["low", "medium", "high"] },
    "reason_class": {
      "type": "string",
      "enum": [
        "forgetting_known_info",
        "repeated_failure",
        "process_complaint",
        "direct_correction",
        "accountability_rhetorical",
        "not_dissatisfaction"
      ]
    }
  },
  "required": ["is_dissatisfaction", "confidence", "reason_class"]
}
```

- [ ] **Step 4: Add result-kind routing and wrapped transport handling**

```js
// In src/reviewer-provider.mjs
const RESULT_PROFILES = Object.freeze({
  reviewer: Object.freeze({
    promptKey: "reviewer",
    discriminator: "outcome"
  }),
  convergence_probe: Object.freeze({
    promptKey: "convergence_probe",
    discriminator: "action"
  }),
  semantic_dissatisfaction_gate: Object.freeze({
    promptKey: "semantic_dissatisfaction_gate",
    discriminator: "reason_class"
  })
});

function promptAndSchemaFor(resultKind, paths) {
  if (resultKind === "semantic_dissatisfaction_gate") {
    return {
      promptFile: paths.semanticGatePrompt,
      schemaFile: paths.semanticGateSchema
    };
  }
  // existing branches unchanged
}
```

- [ ] **Step 5: Run the full provider test file**

Run: `node --test test/reviewer-provider.test.mjs`
Expected: PASS with all provider transport tests green.

- [ ] **Step 6: Commit semantic gate provider profile support**

```bash
git add templates/prompts/semantic-dissatisfaction-gate.md templates/schemas/semantic-dissatisfaction-gate.schema.json src/reviewer-provider.mjs test/reviewer-provider.test.mjs
git commit -m "feat: add semantic dissatisfaction gate provider profile"
```

## Task 3: Build deterministic semantic-gate projection and integrate gate-first job flow

**Files:**
- Modify: `src/reviewer-runner.mjs:199-311`
- Modify: `src/cli.mjs:630-780`
- Test: `test/reviewer-runner.test.mjs`

**Interfaces:**
- Consumes: `runReviewJob({ jobId, ownerId, store, blobs, projectDir, provider })`
- Produces:
  - a deterministic projected semantic-gate context
  - a new early-stop path when the gate returns `is_dissatisfaction: false`
  - preserve-and-expand behavior: existing explicit hits still bypass gate and reach full reviewer directly

- [ ] **Step 1: Write failing runner tests for gate-first behavior and preserve-and-expand bypass**

```js
test("semantic gate stops the job before full reviewer when candidate is expanded but not real dissatisfaction", async () => {
  const calls = [];
  const result = await runReviewJob({
    jobId,
    ownerId: "reviewer-test",
    store,
    blobs,
    projectDir,
    provider: async (context, { resultKind }) => {
      calls.push(resultKind);
      if (resultKind === "semantic_dissatisfaction_gate") {
        return { is_dissatisfaction: false, confidence: "high", reason_class: "not_dissatisfaction" };
      }
      throw new Error("full reviewer should not run");
    }
  });

  assert.deepEqual(calls, ["semantic_dissatisfaction_gate"]);
  assert.equal(result.outcome, "no_lesson");
});

test("existing explicit dissatisfaction path still reaches the full reviewer directly", async () => {
  const calls = [];
  await runReviewJob({
    jobId,
    ownerId: "reviewer-test",
    store,
    blobs,
    projectDir,
    provider: async (_context, { resultKind }) => {
      calls.push(resultKind);
      if (resultKind === "reviewer") return { outcome: "no_lesson" };
      throw new Error("semantic gate should be bypassed for explicit hits");
    }
  });

  assert.deepEqual(calls, ["reviewer"]);
});
```

- [ ] **Step 2: Run the focused runner tests and confirm failure**

Run: `node --test --test-name-pattern "semantic gate stops|explicit dissatisfaction path" test/reviewer-runner.test.mjs`
Expected: FAIL because the runner currently has no semantic-gate stage.

- [ ] **Step 3: Add a deterministic semantic-gate projection helper**

```js
// In src/reviewer-runner.mjs
function semanticGateProjection(context) {
  return Object.freeze({
    prompt: context.source?.text ?? "",
    referent: context.referent?.text ?? null,
    provider: context.source?.source_provider ?? "unknown",
    sessionUid: context.source?.session_uid ?? null,
    projectId: context.job?.project_id ?? null,
    reasonCodes: Array.isArray(context.candidate?.reasonCodes) ? context.candidate.reasonCodes : [],
    priorEmission: context.recurrence?.priorEmission ?? false,
    recurrenceObserved: context.recurrence?.recurrenceObserved ?? false
  });
}
```

- [ ] **Step 4: Integrate semantic-gate-first runner flow with preserve-and-expand semantics**

```js
// Pseudocode structure in src/reviewer-runner.mjs
if (context.candidate?.source === "explicit_legacy_hit") {
  return runFullReviewer(...);
}

if (context.candidate?.source === "expanded_coarse_recall") {
  const gate = await provider(semanticGateProjection(context), { resultKind: "semantic_dissatisfaction_gate" });
  if (!gate.is_dissatisfaction) {
    return finishWithoutLesson({ reason: gate.reason_class, via: "semantic_gate" });
  }
}

return runFullReviewer(...);
```

- [ ] **Step 5: Thread `resultKind` through the CLI reviewer-run provider callback**

```js
// In src/cli.mjs reviewer-run branch
provider: (context, { resultKind }) => runReviewerProvider({
  cli: providerName,
  executable,
  context,
  resultKind,
  promptFile: paths.promptFile,
  schemaFile: paths.reviewerSchema,
  policyFile: paths.geminiReviewerPolicy,
  geminiSettingsFile: paths.geminiSettingsFile,
  timeoutMs,
  env: process.env
})
```

- [ ] **Step 6: Run the full reviewer-runner test file**

Run: `node --test test/reviewer-runner.test.mjs`
Expected: PASS with semantic-gate control-flow coverage green.

- [ ] **Step 7: Commit runner and CLI integration**

```bash
git add src/reviewer-runner.mjs src/cli.mjs test/reviewer-runner.test.mjs
git commit -m "feat: run semantic dissatisfaction gate before full reviewer"
```

## Task 4: Add capture-path diagnosability for unrecorded prompt turns

**Files:**
- Modify: `src/capture.mjs:55-340`
- Modify: `src/control-store.mjs` (only if a small existing table can safely store reason codes; otherwise use an existing audit table path)
- Test: `test/capture.test.mjs`

**Interfaces:**
- Consumes: `normalizeHookEvent({ cli, payload, installationId, timeout, timeoutUnit, capturePolicyRevision })`
- Produces: a bounded queryable reason code whenever a hook execution cannot durably record a prompt event

- [ ] **Step 1: Write failing capture tests for “no silent drop” behavior**

```js
test("capture records a bounded fail-open reason when the prompt event cannot be stored", async () => {
  const result = await runHook(coreHook, payload, {
    HOME: home,
    AFL_TEST_FORCE_CAPTURE_FAILURE: "session_event_write_failed"
  }, ["--event", "UserPromptSubmit", "--cli", "codex", "--continue"]);

  assert.equal(result.stdout, '{"continue":true}\n');
  const audit = store.database.prepare(
    "SELECT reason_code FROM review_job_events WHERE event_type='capture_fail_open' ORDER BY rowid DESC LIMIT 1"
  ).get();
  assert.equal(audit.reason_code, "session_event_write_failed");
});
```

- [ ] **Step 2: Run the focused capture test and confirm failure**

Run: `node --test --test-name-pattern "capture records a bounded fail-open reason" test/capture.test.mjs`
Expected: FAIL because capture currently has no explicit queryable fail-open audit for this path.

- [ ] **Step 3: Add a bounded fail-open audit path**

```js
// In src/capture.mjs, on prompt-event durability failure
recordCaptureFailOpen({
  eventType: "capture_fail_open",
  reasonCode: boundedReason(error, "session_event_write_failed"),
  sourceProvider: event.cli,
  sessionUid: event.session_uid,
  eventUid: event.event_uid,
  createdAt: nowIso()
});

return { continue: true };
```

Use an existing audit/event table if possible; only extend storage minimally.

- [ ] **Step 4: Run the full capture test file**

Run: `node --test test/capture.test.mjs`
Expected: PASS, including the new diagnosability assertion.

- [ ] **Step 5: Commit capture diagnosability**

```bash
git add src/capture.mjs src/control-store.mjs test/capture.test.mjs
git commit -m "feat: record capture fail-open reasons for missed prompt events"
```

## Task 5: End-to-end preserve-and-expand regression and documentation

**Files:**
- Modify: `test/e2e-smoke.test.mjs:386-497`
- Modify: `README.md`
- Modify: `README-zh.md`

**Interfaces:**
- Consumes: installed hook + real detached reviewer flow
- Produces: documented user-visible behavior that natural-language impatience is covered via semantic gating while explicit hits remain preserved

- [ ] **Step 1: Write failing end-to-end tests for the four real missed prompts**

```js
test("installed hook admits repeated known-info frustration into semantic dissatisfaction review", async () => {
  const payload = makePayload({
    prompt: "密码不是都有吗端口55555，root Hik@123++",
    previousAssistant: "I asked again for the already-known root password and port."
  });
  const result = await runInstalledHook(payload);
  assert.equal(result.stdout, '{"continue":true}\n');
  assert.equal(await latestReviewerJobState(home), "pending-or-running");
});
```

Repeat for:

- “这些之前都有存的呀怎么又不知道了”
- “之前出现过好几次了”
- “都第七八次了”

- [ ] **Step 2: Run the focused end-to-end tests and confirm failure on at least one real phrase**

Run: `node --test --test-name-pattern "repeated known-info frustration|怎么又不知道了|出现过好几次|第七八次" test/e2e-smoke.test.mjs`
Expected: FAIL under current shipped behavior.

- [ ] **Step 3: Extend the installed-flow fixtures to exercise preserve-and-expand behavior**

```js
// In test/e2e-smoke.test.mjs
// 1. explicit dissatisfaction still creates a full reviewer job immediately
// 2. expanded coarse-recall phrases create a semantic-gate-reviewed job
// 3. a neutral investigation prompt still does not create a reviewer job
```

- [ ] **Step 4: Document the user-visible semantic change briefly**

```md
### Natural-language dissatisfaction coverage

AFL no longer requires a fixed negative keyword such as “做错了” or “不合理”
to recognize dissatisfaction. Repeated known-information complaints, recurrence
frustration, and rhetorical accountability can be admitted into a lightweight
semantic dissatisfaction gate before the full reviewer runs. Existing explicit
hits remain a direct path.
```

Add the same meaning to `README-zh.md`.

- [ ] **Step 5: Run the full regression suite**

Run: `npm test`
Expected: PASS with 0 failures and the new semantic-gate / capture-diagnosability tests included.

- [ ] **Step 6: Commit end-to-end coverage and docs**

```bash
git add test/e2e-smoke.test.mjs README.md README-zh.md
git commit -m "test: cover semantic dissatisfaction gate end to end"
```

## Spec coverage check

- **Preserve current explicit hits:** Task 1 and Task 3 preserve the direct full-reviewer path.
- **Recover implicit missed dissatisfaction:** Task 1 broadens coarse recall; Task 5 adds real-case regression coverage.
- **Keep hook fast and silent:** Task 3 keeps the semantic gate inside the detached reviewer job, not in the hook.
- **Reduce unnecessary full-reviewer invocations / Codex latency:** Task 2 and Task 3 add a lightweight semantic-gate profile and gate-first flow.
- **Diagnosable capture misses:** Task 4 adds explicit capture fail-open recording.
- **Reuse existing provider ecosystem:** Task 2 / Task 3 keep the same provider paths, only with a new result kind/profile.
- **No new service / queue / scheduler:** No task introduces new infrastructure.

## Placeholder scan

- No TBD / TODO placeholders remain.
- All new files and modified files have exact paths.
- All test steps include exact commands.
- All new interfaces (`semantic_dissatisfaction_gate`, projection shape, reason_class values) are explicitly named.

## Type consistency check

- New `resultKind` value: `semantic_dissatisfaction_gate`
- New gate output fields: `is_dissatisfaction`, `confidence`, `reason_class`
- New reason classes reused consistently across Tasks 2–5.
- Runner integration calls provider with `{ resultKind }`, matching existing `runReviewerProvider` shape.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-23-semantic-dissatisfaction-gate-implementation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
