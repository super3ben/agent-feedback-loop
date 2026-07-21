import assert from "node:assert/strict";
import { test } from "node:test";

import {
  projectCometCheckpoint,
  projectGenericAudit,
  projectOpenSpecCheckpoint
} from "../src/convergence-adapters.mjs";

function clauses() {
  return {
    requirements: [
      { id: "acceptance_proven", authority: "approved_spec" },
      { id: "task_boundary", authority: "approved_plan" }
    ],
    exclusions: [{ id: "no_scheduler", authority: "explicit_user" }]
  };
}

function approvedOpenSpecFixture(overrides = {}) {
  return {
    nativeTaskId: "task_8",
    declaredRevision: "rev_8",
    activeRevision: "rev_8",
    approvalState: "approved",
    approvalRevision: "rev_8",
    approvalAuthority: "approved_spec",
    sourceRef: "openspec/change/task-8",
    ...clauses(),
    importance: "important",
    importanceAuthority: "approved_spec",
    ...overrides
  };
}

function approvedCometFixture(overrides = {}) {
  return {
    nativeChangeId: "change_guard_adapters",
    nativeTaskId: "task_8",
    declaredRevision: "rev_8",
    activeRevision: "rev_8",
    approvalState: "approved",
    approvalRevision: "rev_8",
    approvalAuthority: "approved_plan",
    sourceRef: "comet/change/task-8",
    ...clauses(),
    importance: "important",
    importanceAuthority: "approved_plan",
    ...overrides
  };
}

function genericFixture(overrides = {}) {
  return {
    observationKind: "prompt",
    nativeTaskId: "task_8",
    declaredRevision: "turn_12",
    sourceRef: "turn-12",
    ...clauses(),
    importance: "critical",
    importanceAuthority: "explicit_user",
    ...overrides
  };
}

function assertAdvisory(result, reasonCode) {
  assert.equal(result.adapterCapability, "audit_only");
  assert.equal(result.maximumEnforcement, "warn");
  assert.equal(result.gateEligible, false);
  assert.equal(result.reasonCode, reasonCode);
}

function assertDeepFrozen(value, visited = new Set()) {
  if (value === null || typeof value !== "object" || visited.has(value)) return;
  visited.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, visited);
}

test("OpenSpec may hold the next task but generic audit cannot claim a mutation block", () => {
  const openspec = projectOpenSpecCheckpoint(approvedOpenSpecFixture());
  const generic = projectGenericAudit(genericFixture());

  assert.deepEqual({
    adapterKind: openspec.adapterKind,
    adapterCapability: openspec.adapterCapability,
    maximumEnforcement: openspec.maximumEnforcement,
    gateEligible: openspec.gateEligible,
    reasonCode: openspec.reasonCode
  }, {
    adapterKind: "openspec",
    adapterCapability: "checkpoint_gate",
    maximumEnforcement: "checkpoint_required",
    gateEligible: true,
    reasonCode: null
  });
  assertAdvisory(generic, "generic_audit_only");
});

test("approved OpenSpec and Comet preserve distinct native identities and declared revisions", () => {
  const openspec = projectOpenSpecCheckpoint(approvedOpenSpecFixture());
  const comet = projectCometCheckpoint(approvedCometFixture());

  assert.deepEqual(Object.keys(openspec), [
    "adapterKind", "adapterCapability", "maximumEnforcement", "gateEligible", "reasonCode",
    "nativeTaskId", "nativeRevision", "contract"
  ]);
  assert.deepEqual(Object.keys(comet), [
    "adapterKind", "adapterCapability", "maximumEnforcement", "gateEligible", "reasonCode",
    "nativeChangeId", "nativeTaskId", "nativeRevision", "contract"
  ]);
  assert.equal(openspec.nativeTaskId, "task_8");
  assert.equal(openspec.nativeRevision, "rev_8");
  assert.equal(openspec.contract.sourceKind, "openspec");
  assert.equal(openspec.contract.sourceRevision, "rev_8");
  assert.equal(comet.nativeChangeId, "change_guard_adapters");
  assert.equal(comet.nativeTaskId, "task_8");
  assert.equal(comet.nativeRevision, "rev_8");
  assert.equal(comet.contract.sourceKind, "comet");
  assert.equal(comet.contract.sourceRevision, "rev_8");
  assert.match(openspec.contract.sourceRefDigest, /^[a-f0-9]{64}$/u);
  assert.match(comet.contract.sourceRefDigest, /^[a-f0-9]{64}$/u);
});

test("unapproved stale mismatched inferred and missing checkpoint authority all downgrade", () => {
  const cases = [
    ["unapproved_contract", approvedOpenSpecFixture({ approvalState: "draft" })],
    ["stale_revision", approvedOpenSpecFixture({ activeRevision: "rev_9" })],
    ["approval_revision_mismatch", approvedOpenSpecFixture({ approvalRevision: "rev_7" })],
    ["unsupported_approval_authority", approvedOpenSpecFixture({ approvalAuthority: "inferred_advisory" })],
    ["inferred_contract_authority", approvedOpenSpecFixture({ importanceAuthority: "inferred_advisory" })],
    ["inferred_contract_authority", approvedOpenSpecFixture({
      requirements: [{ id: "semantic_guess", authority: "inferred_advisory" }]
    })]
  ];
  const missing = [
    ["missing_active_revision", "activeRevision"],
    ["missing_approval_state", "approvalState"],
    ["missing_approval_revision", "approvalRevision"],
    ["missing_approval_authority", "approvalAuthority"]
  ];

  for (const [reasonCode, input] of cases) {
    assertAdvisory(projectOpenSpecCheckpoint(input), reasonCode);
  }
  for (const [reasonCode, field] of missing) {
    const input = approvedOpenSpecFixture();
    delete input[field];
    assertAdvisory(projectOpenSpecCheckpoint(input), reasonCode);
  }
});

test("OpenSpec and Comet accept only their own explicit approval authority", () => {
  assertAdvisory(
    projectOpenSpecCheckpoint(approvedOpenSpecFixture({ approvalAuthority: "approved_plan" })),
    "unsupported_approval_authority"
  );
  assertAdvisory(
    projectCometCheckpoint(approvedCometFixture({ approvalAuthority: "approved_spec" })),
    "unsupported_approval_authority"
  );
});

test("advisory checkpoint output retains normalized facts without making inferred clauses hard", () => {
  const result = projectOpenSpecCheckpoint(approvedOpenSpecFixture({
    requirements: [
      { id: "explicit_fact", authority: "approved_spec" },
      { id: "semantic_guess", authority: "inferred_advisory" }
    ]
  }));

  assertAdvisory(result, "inferred_contract_authority");
  assert.deepEqual(result.contract.requirements, [
    { id: "explicit_fact", authority: "approved_spec", hard: true },
    { id: "semantic_guess", authority: "inferred_advisory", hard: false }
  ]);
});

test("generic prompt and tool observations always force every contract authority advisory", () => {
  for (const observationKind of ["prompt", "tool"]) {
    const input = genericFixture({ observationKind });
    const result = projectGenericAudit(input);

    assertAdvisory(result, "generic_audit_only");
    assert.equal(result.observationKind, observationKind);
    assert.equal(result.adapterKind, "generic_prompt");
    assert.equal(result.nativeTaskId, "task_8");
    assert.equal(result.nativeRevision, "turn_12");
    assert.equal(result.contract.sourceKind, `generic_${observationKind}`);
    assert.equal(result.contract.importance, "routine");
    assert.equal(result.contract.importanceAuthority, "inferred_advisory");
    assert.equal(result.contract.requirements.every((clause) =>
      clause.authority === "inferred_advisory" && clause.hard === false), true);
    assert.equal(result.contract.exclusions.every((clause) =>
      clause.authority === "inferred_advisory" && clause.hard === false), true);
  }
});

test("source references are digested and source paths prompts policy and grants are never returned", () => {
  const sensitiveSource = "RAW PROMPT /Users/example/private/project/spec.md";
  const outputs = [
    projectOpenSpecCheckpoint(approvedOpenSpecFixture({ sourceRef: sensitiveSource })),
    projectCometCheckpoint(approvedCometFixture({ sourceRef: sensitiveSource })),
    projectGenericAudit(genericFixture({ sourceRef: sensitiveSource }))
  ];

  for (const result of outputs) {
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(sensitiveSource), false);
    assert.equal(serialized.includes("/Users/example"), false);
    for (const field of ["policy", "grant", "token", "store", "sourcePath", "sourceBody", "prompt"]) {
      assert.equal(Object.hasOwn(result, field), false, field);
    }
    assert.equal(Object.values(result).some((value) => typeof value === "function"), false);
  }
});

test("projectors reject unknown aliases conflicting fields and caller-supplied hard flags", () => {
  const invalid = [
    () => projectOpenSpecCheckpoint({ ...approvedOpenSpecFixture(), taskId: "task_8" }),
    () => projectOpenSpecCheckpoint({ ...approvedOpenSpecFixture(), revision: "rev_8" }),
    () => projectCometCheckpoint({ ...approvedCometFixture(), changeId: "change_guard_adapters" }),
    () => projectGenericAudit({ ...genericFixture(), prompt: "raw prompt" }),
    () => projectGenericAudit({ ...genericFixture(), policy: { decision: "hold" } }),
    () => projectOpenSpecCheckpoint({
      ...approvedOpenSpecFixture(),
      requirements: [{ id: "acceptance_proven", authority: "approved_spec", hard: true }]
    })
  ];

  for (const invoke of invalid) {
    assert.throws(invoke, (error) => error?.code === "adapter_unknown_field");
  }
});

test("projectors reject noncanonical and oversized identities collections and source references", () => {
  const oversizedClauses = Array.from({ length: 129 }, (_, index) => ({
    id: `requirement_${index}`,
    authority: "approved_spec"
  }));
  const cases = [
    () => projectOpenSpecCheckpoint(approvedOpenSpecFixture({ nativeTaskId: "Task 8" })),
    () => projectCometCheckpoint(approvedCometFixture({ nativeChangeId: `c${"x".repeat(128)}` })),
    () => projectGenericAudit(genericFixture({ sourceRef: "source\0body" })),
    () => projectOpenSpecCheckpoint(approvedOpenSpecFixture({ requirements: oversizedClauses })),
    () => projectGenericAudit(genericFixture({ observationKind: "mutation" }))
  ];

  for (const invoke of cases) assert.throws(invoke, /adapter_/u);
});

test("projectors reject accessors proxies symbols and decorated arrays without invoking user code", () => {
  let getterCalls = 0;
  const accessor = approvedOpenSpecFixture();
  Object.defineProperty(accessor, "approvalState", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "approved";
    }
  });
  const decorated = approvedOpenSpecFixture();
  decorated.requirements.semanticTag = "hidden";
  const symbol = approvedOpenSpecFixture();
  symbol[Symbol("authority")] = "approved_spec";

  for (const input of [accessor, new Proxy(approvedOpenSpecFixture(), {}), decorated, symbol]) {
    assert.throws(() => projectOpenSpecCheckpoint(input), /adapter_/u);
  }
  assert.equal(getterCalls, 0);
});

test("projectors do not mutate inputs and return deeply frozen detached data", () => {
  for (const [project, input] of [
    [projectOpenSpecCheckpoint, approvedOpenSpecFixture()],
    [projectCometCheckpoint, approvedCometFixture()],
    [projectGenericAudit, genericFixture()]
  ]) {
    const before = structuredClone(input);
    const result = project(Object.freeze(input));

    assert.deepEqual(input, before);
    assertDeepFrozen(result);
    assert.notEqual(result.contract.requirements, input.requirements);
    assert.notEqual(result.contract.requirements[0], input.requirements[0]);
    assert.throws(() => {
      result.contract.requirements[0].authority = "explicit_user";
    }, TypeError);
  }
});
