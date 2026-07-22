import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildConvergenceProbeEvidence,
  canonicalProbeEvidence,
  validateConvergenceProbeEvidence
} from "../src/convergence-probe-context.mjs";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

function envelope(overrides = {}) {
  return {
    version: 1,
    identity: {
      taskUid: "task-5",
      fingerprint: "probe-evidence-fingerprint",
      boundaryId: "task-5",
      canonicalInvariantId: "probe-bounded-input-carries-semantic-decision-evidence"
    },
    contract: {
      goalSummary: "Give the detached Probe bounded semantic evidence",
      acceptanceCriteria: ["The provider receives the approved evidence envelope"],
      exclusions: ["No semantic body enters SQLite"],
      importance: "important",
      importanceAuthority: "approved_plan",
      contractRevision: A
    },
    trigger: {
      decision: "reflection_required",
      breakerReason: "repeated_review_invariant",
      failureCount: 2,
      currentGeneration: 2,
      decisionBasisDigest: B
    },
    recentGenerations: [{
      generation: 2,
      action: "architecture_fix",
      changedFileCount: 2,
      additions: 40,
      deletions: 12,
      pathCategories: ["source", "tests"],
      testStatus: "passed",
      evidenceClass: "review_finding",
      evidenceDigest: C
    }],
    reviewEvidence: {
      severity: "important",
      verdict: "changes_required",
      hypothesis: "Opaque status cannot support a semantic Probe judgment",
      newEvidence: "The provider input contains identifiers and digests only",
      falsificationTest: "Supply two approved goals and observe distinct provider evidence"
    },
    ...overrides
  };
}

function buildInput(overrides = {}) {
  return {
    hostProjection: {
      producer: "sdd",
      goalSummary: "Give the detached Probe bounded semantic evidence",
      acceptanceCriteria: ["The provider receives the approved evidence envelope"],
      exclusions: ["No semantic body enters SQLite"],
      importance: "important",
      importanceAuthority: "approved_plan",
      contractRevision: A,
      generationObservations: [{
        generation: 2,
        changedFileCount: 2,
        additions: 40,
        deletions: 12,
        pathCategories: ["source", "tests"],
        testStatus: "passed"
      }],
      reviewEvidence: {
        severity: "important",
        verdict: "changes_required",
        hypothesis: "Opaque status cannot support a semantic Probe judgment",
        newEvidence: "The provider input contains identifiers and digests only",
        falsificationTest: "Supply two approved goals and observe distinct provider evidence",
        evidenceDigest: C,
        decisionBasisDigest: B
      }
    },
    controllerFacts: {
      taskUid: "task-5",
      fingerprint: "probe-evidence-fingerprint",
      boundaryId: "task-5",
      canonicalInvariantId: "probe-bounded-input-carries-semantic-decision-evidence",
      importance: "important",
      importanceAuthority: "approved_plan",
      contractRevision: A,
      decision: "reflection_required",
      breakerReason: "repeated_review_invariant",
      failureCount: 2,
      currentGeneration: 2,
      decisionBasisDigest: B,
      latestEvidenceDigest: C,
      recentGenerations: [{
        generation: 2,
        action: "architecture_fix",
        evidenceClass: "review_finding",
        evidenceDigest: C
      }]
    },
    ...overrides
  };
}

function assertInvalid(value) {
  assert.throws(() => validateConvergenceProbeEvidence(value), TypeError);
}

test("validator accepts the exact envelope and returns a detached deeply frozen value", () => {
  const input = envelope();
  const validated = validateConvergenceProbeEvidence(input);

  assert.deepEqual(validated, input);
  assert.notEqual(validated, input);
  assert.notEqual(validated.contract, input.contract);
  assert.notEqual(validated.recentGenerations, input.recentGenerations);
  assert.notEqual(validated.recentGenerations[0], input.recentGenerations[0]);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.contract), true);
  assert.equal(Object.isFrozen(validated.contract.acceptanceCriteria), true);
  assert.equal(Object.isFrozen(validated.recentGenerations[0].pathCategories), true);
  input.contract.goalSummary = "mutated after validation";
  assert.notEqual(validated.contract.goalSummary, input.contract.goalSummary);
});

test("validator enforces exact keys at every record boundary", () => {
  const mutations = [
    (value) => { value.unknown = true; },
    (value) => { delete value.version; },
    (value) => { value.identity.unknown = true; },
    (value) => { delete value.identity.taskUid; },
    (value) => { value.contract.unknown = true; },
    (value) => { value.trigger.unknown = true; },
    (value) => { value.recentGenerations[0].unknown = true; },
    (value) => { value.reviewEvidence.unknown = true; }
  ];
  for (const mutate of mutations) {
    const value = structuredClone(envelope());
    mutate(value);
    assertInvalid(value);
  }
});

test("validator rejects accessors without invoking getters, including array elements", () => {
  for (const makeValue of [
    () => {
      const value = envelope();
      let calls = 0;
      Object.defineProperty(value.contract, "goalSummary", {
        enumerable: true,
        get() { calls += 1; return "must not run"; }
      });
      return { value, calls: () => calls };
    },
    () => {
      const value = envelope();
      let calls = 0;
      Object.defineProperty(value.contract.acceptanceCriteria, "0", {
        enumerable: true,
        get() { calls += 1; return "must not run"; }
      });
      return { value, calls: () => calls };
    }
  ]) {
    const fixture = makeValue();
    assertInvalid(fixture.value);
    assert.equal(fixture.calls(), 0);
  }
});

test("validator rejects proxies, sparse or decorated arrays, and unsupported prototypes", () => {
  const proxy = envelope();
  proxy.contract = new Proxy(proxy.contract, {});
  assertInvalid(proxy);

  const sparse = envelope();
  sparse.contract.acceptanceCriteria = new Array(1);
  assertInvalid(sparse);

  const decorated = envelope();
  decorated.contract.exclusions.semanticTag = "hidden scope";
  assertInvalid(decorated);

  const prototype = envelope();
  prototype.reviewEvidence = Object.assign(Object.create(null), prototype.reviewEvidence);
  assertInvalid(prototype);
});

test("validator enforces text and collection bounds in Unicode characters", () => {
  const textCases = [
    ["goalSummary", "", 513],
    ["hypothesis", "", 1_025],
    ["newEvidence", "", 1_025],
    ["falsificationTest", "", 1_025]
  ];
  for (const [field, empty, oversized] of textCases) {
    const missing = envelope();
    const target = field === "goalSummary" ? missing.contract : missing.reviewEvidence;
    target[field] = empty;
    assertInvalid(missing);

    const over = envelope();
    const overTarget = field === "goalSummary" ? over.contract : over.reviewEvidence;
    overTarget[field] = "界".repeat(oversized);
    assertInvalid(over);
  }

  for (const [field, minimum, maximum, itemMaximum] of [
    ["acceptanceCriteria", 1, 8, 256],
    ["exclusions", 0, 8, 256]
  ]) {
    const tooFew = envelope();
    tooFew.contract[field] = [];
    if (minimum > 0) assertInvalid(tooFew);
    const tooMany = envelope();
    tooMany.contract[field] = Array.from({ length: maximum + 1 }, (_, index) => `item-${index}`);
    assertInvalid(tooMany);
    const longItem = envelope();
    longItem.contract[field] = ["界".repeat(itemMaximum + 1)];
    assertInvalid(longItem);
  }

  const generations = envelope();
  generations.recentGenerations = [generations.recentGenerations[0], generations.recentGenerations[0], generations.recentGenerations[0]];
  assertInvalid(generations);

  const categories = envelope();
  categories.recentGenerations[0].pathCategories = Array.from({ length: 9 }, () => "source");
  assertInvalid(categories);
});

test("validator rejects NUL, ill-formed Unicode, secrets, and control receipts", () => {
  const forbidden = [
    "contains\0nul",
    "bad\ud800unicode",
    "Authorization: Bearer synthetic-secret",
    "token=synthetic-secret",
    "sk-1234567890123456",
    "-----BEGIN PRIVATE KEY-----",
    "<!-- afl-receipt id=opaque -->",
    "[AFL] control instruction"
  ];
  for (const text of forbidden) {
    const value = envelope();
    value.reviewEvidence.newEvidence = text;
    assertInvalid(value);
  }
});

test("validator enforces canonical identifiers and lowercase SHA-256 digests", () => {
  for (const invalidId of ["", "bad id", "/absolute/path", "x".repeat(257), "bad\ud800id"]) {
    const value = envelope();
    value.identity.boundaryId = invalidId;
    assertInvalid(value);
  }
  for (const digest of ["a".repeat(63), "A".repeat(64), `g${"a".repeat(63)}`]) {
    const value = envelope();
    value.contract.contractRevision = digest;
    assertInvalid(value);
  }
});

test("validator enforces every enum boundary", () => {
  const mutations = [
    (value) => { value.contract.importance = "urgent"; },
    (value) => { value.contract.importanceAuthority = "model_guess"; },
    (value) => { value.trigger.decision = "pass"; },
    (value) => { value.trigger.breakerReason = "model_reason"; },
    (value) => { value.recentGenerations[0].action = "rewrite_everything"; },
    (value) => { value.recentGenerations[0].pathCategories = ["src/private.mjs"]; },
    (value) => { value.recentGenerations[0].testStatus = "greenish"; },
    (value) => { value.recentGenerations[0].evidenceClass = "model_claim"; },
    (value) => { value.reviewEvidence.severity = "blocker"; },
    (value) => { value.reviewEvidence.verdict = "maybe"; }
  ];
  for (const mutate of mutations) {
    const value = envelope();
    mutate(value);
    assertInvalid(value);
  }
});

test("validator caps counts at ten million and binds recent generations to the current generation", () => {
  for (const field of ["changedFileCount", "additions", "deletions"]) {
    for (const invalidCount of [-1, 10_000_001, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const value = envelope();
      value.recentGenerations[0][field] = invalidCount;
      assertInvalid(value);
    }
  }
  for (const field of ["failureCount", "currentGeneration"]) {
    const value = envelope();
    value.trigger[field] = 10_000_001;
    assertInvalid(value);
  }
  const future = envelope();
  future.recentGenerations[0].generation = 3;
  assertInvalid(future);
});

test("canonical JSON is stable, validated, and capped at 16 KiB UTF-8", () => {
  const value = envelope();
  const reordered = {
    reviewEvidence: value.reviewEvidence,
    recentGenerations: value.recentGenerations,
    trigger: value.trigger,
    contract: value.contract,
    identity: value.identity,
    version: value.version
  };
  const canonical = canonicalProbeEvidence(reordered);
  assert.equal(canonical, canonicalProbeEvidence(value));
  assert.equal(Buffer.byteLength(canonical, "utf8") <= 16 * 1_024, true);
  assert.equal(canonical.startsWith('{"contract":'), true);

  const oversized = envelope();
  oversized.contract.goalSummary = "界".repeat(512);
  oversized.contract.acceptanceCriteria = Array.from({ length: 8 }, () => "界".repeat(256));
  oversized.contract.exclusions = Array.from({ length: 8 }, () => "界".repeat(256));
  oversized.reviewEvidence.hypothesis = "界".repeat(1_024);
  oversized.reviewEvidence.newEvidence = "界".repeat(1_024);
  oversized.reviewEvidence.falsificationTest = "界".repeat(1_024);
  assertInvalid(oversized);
  assert.throws(() => canonicalProbeEvidence(oversized), TypeError);
});

test("builder projects semantic host input and controller/Store facts into the exact envelope", () => {
  assert.deepEqual(buildConvergenceProbeEvidence(buildInput()), envelope());
});

test("builder rejects host attempts to override controller identity, decision, generations, or review authority", () => {
  for (const [field, value] of [
    ["identity", { taskUid: "attacker" }],
    ["decision", "pass"],
    ["failureCount", 0],
    ["currentGeneration", 0],
    ["latestEvidenceDigest", "d".repeat(64)]
  ]) {
    const input = buildInput();
    input.hostProjection[field] = value;
    assert.throws(() => buildConvergenceProbeEvidence(input), TypeError);
  }
});

test("builder fails closed on stale contract, importance, review, decision-basis, or generation bindings", () => {
  const staleInputs = [
    () => { const input = buildInput(); input.hostProjection.contractRevision = "d".repeat(64); return input; },
    () => { const input = buildInput(); input.hostProjection.importance = "routine"; return input; },
    () => { const input = buildInput(); input.hostProjection.importanceAuthority = "inferred_advisory"; return input; },
    () => { const input = buildInput(); input.hostProjection.reviewEvidence.evidenceDigest = "d".repeat(64); return input; },
    () => { const input = buildInput(); input.hostProjection.reviewEvidence.decisionBasisDigest = "d".repeat(64); return input; },
    () => { const input = buildInput(); input.hostProjection.generationObservations[0].generation = 1; return input; },
    () => { const input = buildInput(); input.controllerFacts.recentGenerations[0].generation = 3; return input; }
  ];
  for (const makeInput of staleInputs) {
    assert.throws(() => buildConvergenceProbeEvidence(makeInput()), TypeError);
  }
});

test("builder validates the named producer and does not publish it in the exact artifact", () => {
  const input = buildInput();
  input.hostProjection.producer = "bad producer/path";
  assert.throws(() => buildConvergenceProbeEvidence(input), TypeError);

  const built = buildConvergenceProbeEvidence(buildInput());
  assert.equal(JSON.stringify(built).includes("producer"), false);
  assert.deepEqual(Object.keys(built), [
    "version", "identity", "contract", "trigger", "recentGenerations", "reviewEvidence"
  ]);
});
