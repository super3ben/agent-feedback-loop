import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { renderReflectionMarkdown } from "../src/reflection-document.mjs";
import * as selectorModule from "../src/selector.mjs";

const { loadReflectionDocuments, selectReflections } = selectorModule;
const CUTOFF = "2026-07-20T10:00:00.000Z";
const SESSION = { sessionUid: "codex:default:session-1", contextEpoch: 2 };
const TASK = { fingerprint: "task-1", paths: [], tools: [] };
const BUDGET = { maxCards: 4, maxTotalTokens: 900, maxDocumentTokens: 320 };

function model(index, overrides = {}) {
  const hex = index.toString(16).padStart(24, "0");
  return {
    title: `reflection ${index}`,
    reflection_id: `reflection-${hex}`,
    created_at: `2026-07-20T09:${String(index).padStart(2, "0")}:00.000Z`,
    published_at: `2026-07-20T09:${String(index).padStart(2, "0")}:30.000Z`,
    final_severity: "Critical",
    responsibility: "agent_fault",
    method_class: `architecture_check_${index}`,
    family_id: `family-${index}`,
    applies_when: ["修改已有架构前先核对用户目标"],
    effectiveness: "unknown",
    source_identity_hash: index.toString(16).padStart(64, "0"),
    facts: ["private fact that must never enter guidance"],
    user_complaint: "private complaint that must never enter guidance",
    root_cause: "private root cause that must never enter guidance",
    class_of_mistake: `忽略目标边界 ${index}`,
    method_changes: [`先核对用户目标 ${index}`],
    repeated_pattern_evidence: [],
    ...overrides
  };
}

async function projectFixture(t, entries) {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "afl-selector-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const reflectionDir = path.join(projectDir, ".agent", "reflections");
  await mkdir(reflectionDir, { recursive: true, mode: 0o700 });
  for (const [name, content] of entries) await writeFile(path.join(reflectionDir, name), content);
  return projectDir;
}

async function load(t, models, options = {}) {
  const entries = models.map((entry, index) => [`${String(index).padStart(2, "0")}.md`, renderReflectionMarkdown(entry)]);
  const projectDir = await projectFixture(t, entries);
  return loadReflectionDocuments({ projectDir, publishedBefore: CUTOFF, ...options });
}

function select(documents, overrides = {}) {
  return selectReflections({
    documents,
    prompt: "修改已有架构前先核对用户目标",
    session: SESSION,
    task: TASK,
    budget: BUDGET,
    priorEmissions: [],
    publishedBefore: CUTOFF,
    ...overrides
  });
}

test("selector exposes the direct-document APIs", () => {
  assert.equal(typeof loadReflectionDocuments, "function");
  assert.equal(typeof selectReflections, "function");
});

test("five relevant severe documents produce deterministic Top-4 guidance and one count omission", async (t) => {
  const { documents } = await load(t, [model(1), model(2), model(3), model(4), model(5)]);
  const first = select(documents);
  const second = select([...documents].reverse());

  assert.equal(first.selected.length, 4);
  assert.equal(first.omissions.filter((item) => item.reason === "count_budget").length, 1);
  assert.equal("hold" in first, false);
  assert.deepEqual(first, second);
  assert.deepEqual(first.selected.map((item) => item.reflectionId), [
    model(5).reflection_id, model(4).reflection_id, model(3).reflection_id, model(2).reflection_id
  ]);
  assert.match(first.guidance, /applies_when:/u);
  assert.match(first.guidance, /class_of_mistake:/u);
  assert.match(first.guidance, /method_changes:\n1\./u);
  assert.match(first.guidance, /document_hash: [a-f0-9]{64}/u);
  assert.doesNotMatch(first.guidance, /private fact|private complaint|private root cause/u);
});

test("an oversized Markdown file is omitted while a safe sibling remains selectable", async (t) => {
  const safe = renderReflectionMarkdown(model(1));
  const oversized = `${renderReflectionMarkdown(model(2))}\n${"x".repeat(8_192)}`;
  const projectDir = await projectFixture(t, [["safe.md", safe], ["oversized.md", oversized]]);
  const loaded = await loadReflectionDocuments({ projectDir, publishedBefore: CUTOFF, maxFileBytes: 4_096 });

  assert.equal(loaded.documents.length, 1);
  assert.equal(loaded.omissions.filter((item) => item.reason === "oversized_document").length, 1);
  assert.match(loaded.omissions[0].opaqueId, /^[a-f0-9]{64}$/u);
  assert.equal("path" in loaded.omissions[0], false);
  assert.equal(select(loaded.documents).selected.length, 1);
});

test("family recurrence counts all complete documents but projects the newest applicable method", async (t) => {
  const familyId = "family-shared";
  const first = model(1, { family_id: familyId, method_changes: ["先核对用户目标 old"] });
  const newestApplicable = model(2, { family_id: familyId, method_changes: ["先核对用户目标 newest applicable"] });
  const newestOverall = model(3, {
    family_id: familyId,
    method_class: "credential_rotation",
    applies_when: ["轮换凭据并检查密钥"],
    class_of_mistake: "凭据轮换遗漏",
    method_changes: ["轮换凭据并检查密钥"]
  });
  const { documents } = await load(t, [first, newestApplicable, newestOverall]);
  const result = select(documents);

  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].reflectionId, newestApplicable.reflection_id);
  assert.equal(result.selected[0].familyRecurrence, 3);
  assert.match(result.guidance, /newest applicable/u);
  assert.equal(result.omissions.filter((item) => item.reason === "not_applicable").length, 1);
  assert.equal(result.omissions.filter((item) => item.reason === "family_projection").length, 1);
});

test("catalog omissions map incomplete legacy and unsafe input to bounded reasons", async (t) => {
  const projectDir = await projectFixture(t, [
    ["incomplete.md", "# old report\n\n- final_severity: Major\n- responsibility: agent_fault\n"],
    ["invalid.md", Buffer.from([0xc3, 0x28])]
  ]);
  const loaded = await loadReflectionDocuments({ projectDir, publishedBefore: CUTOFF });

  assert.deepEqual(loaded.omissions.map((item) => item.reason).sort(), ["legacy_incomplete", "parse_error"]);
  assert.ok(loaded.omissions.every((item) => /^[a-f0-9]{64}$/u.test(item.opaqueId)));
  assert.ok(loaded.omissions.every((item) => !("path" in item) && !("content" in item)));
});

test("Chinese and English lexical relevance select documents while zero relevance never injects severity", async (t) => {
  const chinese = model(1, { method_class: "goal_validation" });
  const english = model(2, {
    applies_when: ["verify architecture boundary before implementation"],
    class_of_mistake: "Architecture boundary was skipped",
    method_changes: ["Verify the architecture boundary first"]
  });
  const unrelated = model(3, {
    final_severity: "Blocker",
    method_class: "credential_rotation",
    applies_when: ["轮换凭据并检查密钥"],
    class_of_mistake: "凭据轮换遗漏",
    method_changes: ["轮换凭据并检查密钥"]
  });
  const { documents } = await load(t, [chinese, english, unrelated]);

  assert.equal(select(documents).selected.length, 1);
  const englishResult = select(documents, { prompt: "Please verify the architecture boundary before implementation" });
  assert.deepEqual(englishResult.selected.map((entry) => entry.reflectionId), [english.reflection_id]);
  assert.equal(englishResult.omissions.filter((item) => item.reason === "not_applicable").length, 2);
});

test("exact normalized path/tool metadata adds relevance but otherwise prompt overlap is required", async (t) => {
  const scoped = model(1, {
    applies_when: ["src/cli.mjs"],
    class_of_mistake: "computer-use",
    method_class: "prompt_boundary",
    method_changes: ["run focused tests"]
  });
  const { documents } = await load(t, [scoped]);

  const noMetadata = select(documents, { prompt: "continue", task: TASK });
  assert.equal(noMetadata.selected.length, 0);
  const metadata = select(documents, {
    prompt: "continue",
    task: { ...TASK, paths: [" SRC/CLI.MJS "], tools: ["computer-use", "computer-use"] }
  });
  assert.equal(metadata.selected.length, 1);
  assert.equal(metadata.selected[0].relevanceScore, 16);
});

test("prior emission suppresses the same document/session/context/task tuple only", async (t) => {
  const { documents } = await load(t, [model(1)]);
  const tuple = {
    documentHash: documents[0].documentHash,
    sessionUid: SESSION.sessionUid,
    contextEpoch: SESSION.contextEpoch,
    taskFingerprint: TASK.fingerprint
  };
  const suppressed = select(documents, { priorEmissions: [tuple] });
  assert.equal(suppressed.selected.length, 0);
  assert.equal(suppressed.omissions[0].reason, "prior_emission");
  assert.equal(select(documents, { priorEmissions: [{ ...tuple, contextEpoch: 3 }] }).selected.length, 1);
});

test("per-document and total token budgets omit guidance without a hold", async (t) => {
  const longMethod = "核对架构边界".repeat(70);
  const { documents } = await load(t, [
    model(1, { method_changes: [longMethod] }),
    model(2),
    model(3)
  ]);
  const perDocument = select(documents, { budget: { ...BUDGET, maxDocumentTokens: 40 } });
  assert.equal(perDocument.omissions.some((item) => item.reason === "token_budget"), true);
  assert.equal("hold" in perDocument, false);

  const one = select(documents, { budget: { ...BUDGET, maxTotalTokens: 80 } });
  assert.ok(one.selected.length < 3);
  assert.equal(one.omissions.some((item) => item.reason === "token_budget"), true);
});

test("per-document token-budget omissions follow the exact rank before stable identity", async (t) => {
  const overBudgetMethod = "核对架构边界".repeat(70);
  const { documents } = await load(t, [
    model(1, { final_severity: "Major", method_changes: [overBudgetMethod] }),
    model(2, { final_severity: "Blocker", method_changes: [overBudgetMethod] })
  ]);
  const [lowerRank, higherRank] = documents;
  const lowIdentity = "a".repeat(64);
  const highIdentity = "b".repeat(64);
  const result = select([
    { ...higherRank, documentHash: highIdentity },
    { ...lowerRank, documentHash: lowIdentity }
  ], { budget: { ...BUDGET, maxDocumentTokens: 40 } });

  assert.deepEqual(
    result.omissions.filter((item) => item.reason === "token_budget").map((item) => item.documentHash),
    [highIdentity, lowIdentity]
  );
});

test("document hashes identify the exact Markdown bytes already loaded", async (t) => {
  const markdown = renderReflectionMarkdown(model(1));
  const projectDir = await projectFixture(t, [["one.md", markdown]]);
  const loaded = await loadReflectionDocuments({ projectDir, publishedBefore: CUTOFF });
  const bytes = await readFile(path.join(projectDir, ".agent", "reflections", "one.md"));
  const expected = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  assert.equal(loaded.documents[0].documentHash, expected);
});
