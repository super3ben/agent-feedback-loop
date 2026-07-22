import assert from "node:assert/strict";
import { rename, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildConvergenceProbeEvidence,
  canonicalProbeEvidence,
  ConvergenceProbeContextStore,
  validateConvergenceProbeEvidence,
  validateConvergenceProbeSemanticEnvelope
} from "../src/convergence-probe-context.mjs";
import { BlobKeyProvider } from "../src/crypto-store.mjs";

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

function semanticEnvelope(probeContext = {}) {
  return {
    reviewEvidence: {
      hypothesis: "  One bounded stdin record should carry all semantic evidence  ",
      newEvidence: "  Review bodies still appear in the supported argv contract  ",
      falsificationTest: "  Inspect a blocked real process and then run its Probe path  "
    },
    probeContext: {
      producer: "sdd",
      goalSummary: "Keep semantic decision evidence out of argv",
      acceptanceCriteria: ["One exact envelope reaches the existing Probe path"],
      exclusions: ["No second input channel"],
      importance: "important",
      importanceAuthority: "explicit_user",
      contractRevision: A,
      generationObservations: [],
      ...probeContext
    }
  };
}

async function storeFixture({ keyRootName = "keys" } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "afl-probe-context-"));
  const root = path.join(home, "probe-context");
  const keyRoot = path.join(home, keyRootName);
  const store = new ConvergenceProbeContextStore({
    root,
    keyProvider: new BlobKeyProvider({ keyRoot })
  });
  return { home, root, keyRoot, store };
}

function artifactPath(root, digest) {
  return path.join(root, `${digest}.enc`);
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

test("semantic stdin validator detaches review evidence and returns explicit frozen context states", () => {
  const input = semanticEnvelope();
  const valid = validateConvergenceProbeSemanticEnvelope(input);
  assert.deepEqual(valid.reviewEvidence, {
    hypothesis: "One bounded stdin record should carry all semantic evidence",
    newEvidence: "Review bodies still appear in the supported argv contract",
    falsificationTest: "Inspect a blocked real process and then run its Probe path"
  });
  assert.equal(valid.probeContextState.status, "valid");
  assert.notEqual(valid.probeContextState.value, input.probeContext);
  assert.equal(Object.isFrozen(valid), true);
  assert.equal(Object.isFrozen(valid.reviewEvidence), true);
  assert.equal(Object.isFrozen(valid.probeContextState), true);
  assert.equal(Object.isFrozen(valid.probeContextState.value.acceptanceCriteria), true);

  const missing = semanticEnvelope();
  delete missing.probeContext;
  assert.deepEqual(validateConvergenceProbeSemanticEnvelope(missing).probeContextState, {
    status: "missing"
  });

  const invalidContext = semanticEnvelope({ acceptanceCriteria: [] });
  assert.deepEqual(validateConvergenceProbeSemanticEnvelope(invalidContext).probeContextState, {
    status: "invalid"
  });
});

test("semantic stdin rejects untrusted outer or review evidence without invoking accessors", () => {
  for (const mutate of [
    (value) => { value.unknown = true; },
    (value) => { delete value.reviewEvidence.hypothesis; },
    (value) => { value.reviewEvidence.unknown = true; },
    (value) => { value.reviewEvidence.newEvidence = "token=super-secret-value"; }
  ]) {
    const value = semanticEnvelope();
    mutate(value);
    assert.throws(() => validateConvergenceProbeSemanticEnvelope(value), TypeError);
  }

  const accessor = semanticEnvelope();
  let calls = 0;
  Object.defineProperty(accessor.reviewEvidence, "newEvidence", {
    enumerable: true,
    get() { calls += 1; return "must not run"; }
  });
  assert.throws(() => validateConvergenceProbeSemanticEnvelope(accessor), TypeError);
  assert.equal(calls, 0);
  assert.throws(
    () => validateConvergenceProbeSemanticEnvelope(new Proxy(semanticEnvelope(), {})),
    TypeError
  );
});

test("semantic stdin converts malformed producer projections into typed invalid context", () => {
  for (const mutate of [
    (value) => { value.probeContext.unknown = true; },
    (value) => { value.probeContext.acceptanceCriteria = new Array(1); },
    (value) => { value.probeContext.exclusions.semanticTag = "hidden"; },
    (value) => { value.probeContext = new Proxy(value.probeContext, {}); }
  ]) {
    const value = semanticEnvelope();
    mutate(value);
    assert.deepEqual(validateConvergenceProbeSemanticEnvelope(value).probeContextState, {
      status: "invalid"
    });
  }
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

test("context store publishes one private digest artifact and reuses identical canonical evidence", async (t) => {
  const fixture = await storeFixture();
  const concurrent = await storeFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));
  t.after(() => rm(concurrent.home, { recursive: true, force: true }));

  const first = await fixture.store.put(envelope());
  const replay = await fixture.store.put(structuredClone(envelope()));
  const file = artifactPath(fixture.root, first.digest);

  assert.deepEqual(first, { digest: first.digest, created: true });
  assert.deepEqual(replay, { digest: first.digest, created: false });
  assert.match(first.digest, /^[a-f0-9]{64}$/u);
  assert.equal((await lstat(fixture.root)).mode & 0o777, 0o700);
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(fixture.root), [`${first.digest}.enc`]);

  const restored = await fixture.store.read(first.digest);
  assert.deepEqual(restored, envelope());
  assert.equal(Object.isFrozen(restored), true);
  assert.equal(Object.isFrozen(restored.contract.acceptanceCriteria), true);

  const contenders = await Promise.all(
    Array.from({ length: 8 }, () => concurrent.store.put(structuredClone(envelope())))
  );
  assert.equal(contenders.filter(({ created }) => created).length, 1);
  assert.equal(new Set(contenders.map(({ digest }) => digest)).size, 1);
  assert.equal((await readdir(concurrent.root)).length, 1);
});

test("context store rejects permissive roots and artifacts without repairing their modes", async (t) => {
  const permissiveRoot = await storeFixture();
  t.after(() => rm(permissiveRoot.home, { recursive: true, force: true }));
  await mkdir(permissiveRoot.root, { recursive: true, mode: 0o755 });
  await chmod(permissiveRoot.root, 0o755);
  await assert.rejects(() => permissiveRoot.store.put(envelope()), /probe_context_root_invalid/u);
  assert.equal((await lstat(permissiveRoot.root)).mode & 0o777, 0o755);

  const permissiveFile = await storeFixture();
  t.after(() => rm(permissiveFile.home, { recursive: true, force: true }));
  const publication = await permissiveFile.store.put(envelope());
  const file = artifactPath(permissiveFile.root, publication.digest);
  await chmod(file, 0o644);
  await assert.rejects(() => permissiveFile.store.read(publication.digest), /probe_context_artifact_invalid/u);
  assert.equal((await lstat(file)).mode & 0o777, 0o644);
});

test("context store rejects symlink and simulated unowned roots or artifacts", async (t) => {
  const rootSymlink = await storeFixture();
  const outside = await mkdtemp(path.join(tmpdir(), "afl-probe-outside-"));
  t.after(() => rm(rootSymlink.home, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, rootSymlink.root);
  await assert.rejects(() => rootSymlink.store.put(envelope()), /probe_context_root_invalid/u);

  const artifactSymlink = await storeFixture();
  t.after(() => rm(artifactSymlink.home, { recursive: true, force: true }));
  const target = path.join(artifactSymlink.home, "outside.enc");
  await writeFile(target, "outside", { mode: 0o600 });
  await mkdir(artifactSymlink.root, { recursive: true, mode: 0o700 });
  const digest = "d".repeat(64);
  await symlink(target, artifactPath(artifactSymlink.root, digest));
  await assert.rejects(() => artifactSymlink.store.read(digest), /probe_context_artifact_invalid/u);
  assert.equal(await readFile(target, "utf8"), "outside");

  if (typeof process.getuid === "function") {
    const unowned = await storeFixture();
    t.after(() => rm(unowned.home, { recursive: true, force: true }));
    const publication = await unowned.store.put(envelope());
    const originalGetuid = process.getuid;
    process.getuid = () => originalGetuid() + 1;
    try {
      await assert.rejects(() => unowned.store.read(publication.digest), /probe_context_root_invalid/u);
    } finally {
      process.getuid = originalGetuid;
    }
  }
});

test("context store rejects truncated, corrupt, wrong-key, replaced, and digest-mismatched artifacts", async (t) => {
  const fixture = await storeFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));
  const publication = await fixture.store.put(envelope());
  const file = artifactPath(fixture.root, publication.digest);
  const original = await readFile(file);

  for (const damaged of [original.subarray(0, 20), Buffer.from(original).fill(0, 40, 41)]) {
    await writeFile(file, damaged, { mode: 0o600 });
    await assert.rejects(() => fixture.store.read(publication.digest), /probe_context_artifact_invalid/u);
    await writeFile(file, original, { mode: 0o600 });
  }

  const wrongKeyStore = new ConvergenceProbeContextStore({
    root: fixture.root,
    keyProvider: new BlobKeyProvider({ keyRoot: path.join(fixture.home, "wrong-key") })
  });
  await assert.rejects(() => wrongKeyStore.read(publication.digest), /probe_context_artifact_invalid/u);

  const different = envelope();
  different.contract.goalSummary = "A different approved goal";
  const other = await fixture.store.put(different);
  await rename(artifactPath(fixture.root, other.digest), file);
  await assert.rejects(() => fixture.store.read(publication.digest), /probe_context_artifact_invalid/u);

  const mismatchedName = "e".repeat(64);
  await rename(file, artifactPath(fixture.root, mismatchedName));
  await assert.rejects(() => fixture.store.read(mismatchedName), /probe_context_artifact_invalid/u);
});

test("context store removes only a verified artifact and never follows unsafe replacements", async (t) => {
  const fixture = await storeFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));
  const publication = await fixture.store.put(envelope());
  const file = artifactPath(fixture.root, publication.digest);

  assert.equal(await fixture.store.remove(publication.digest), true);
  assert.equal(await fixture.store.remove(publication.digest), false);

  const target = path.join(fixture.home, "outside.enc");
  await writeFile(target, "outside", { mode: 0o600 });
  await symlink(target, file);
  await assert.rejects(() => fixture.store.remove(publication.digest), /probe_context_artifact_invalid/u);
  assert.equal(await readFile(target, "utf8"), "outside");
  assert.equal((await lstat(file)).isSymbolicLink(), true);

  await assert.rejects(() => fixture.store.remove("../outside"), /probe_context_digest_invalid/u);
});

test("orphan pruning inspects at most 32 entries and retains live or younger-than-24h contexts", async (t) => {
  const fixture = await storeFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));
  const publications = [];
  for (let index = 0; index < 35; index += 1) {
    const value = envelope();
    value.contract.goalSummary = `Bounded semantic evidence goal ${index}`;
    publications.push(await fixture.store.put(value));
  }

  const now = Date.now();
  for (const publication of publications) {
    const old = new Date(now - 25 * 60 * 60 * 1_000);
    await utimes(artifactPath(fixture.root, publication.digest), old, old);
  }
  const live = publications[0].digest;
  const fresh = publications[1].digest;
  const young = new Date(now - 23 * 60 * 60 * 1_000);
  await utimes(artifactPath(fixture.root, fresh), young, young);

  const result = await fixture.store.pruneOrphans(new Set([live]));
  assert.equal(result.inspected, 32);
  assert.equal(result.removed.length <= 32, true);
  assert.equal((await lstat(artifactPath(fixture.root, live))).isFile(), true);
  assert.equal((await lstat(artifactPath(fixture.root, fresh))).isFile(), true);
  assert.equal((await readdir(fixture.root)).length >= 3, true);
  assert.equal(result.removed.every((digest) => /^[a-f0-9]{64}$/u.test(digest)), true);
  assert.equal(JSON.stringify(result).includes(fixture.root), false);
});

test("orphan pruning rejects unsafe candidate artifacts without deleting them or crossing the root", async (t) => {
  const fixture = await storeFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));
  const outside = path.join(fixture.home, "outside.enc");
  await writeFile(outside, "outside", { mode: 0o600 });
  await mkdir(fixture.root, { recursive: true, mode: 0o700 });
  const digest = "0".repeat(64);
  const file = artifactPath(fixture.root, digest);
  await symlink(outside, file);
  const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
  await utimes(file, old, old);

  await assert.rejects(() => fixture.store.pruneOrphans(new Set()), /probe_context_artifact_invalid/u);
  assert.equal(await readFile(outside, "utf8"), "outside");
  assert.equal((await lstat(file)).isSymbolicLink(), true);
});
