import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { deriveReviewerFamilyId } from "../src/reviewer-result.mjs";
import {
  parseReflectionMarkdown,
  publishReflectionDocument,
  readReflectionCatalog,
  renderReflectionMarkdown,
  validateReflectionModel
} from "../src/reflection-document.mjs";

const FIXTURES = new URL("./fixtures/reflections/", import.meta.url);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function lesson(overrides = {}) {
  return {
    outcome: "lesson",
    final_severity: "Major",
    responsibility: "agent_fault",
    method_class: "verify_before_completion",
    family_id: null,
    proposed_family_key: "fresh-verification-gate",
    applies_when: ["A completion claim is about to be made"],
    facts: ["The required verification had not run."],
    user_complaint: "The result was reported before it was verified.",
    root_cause: "The workflow confused implementation with proof.",
    class_of_mistake: "Completion claims without fresh verification",
    method_changes: ["Run the required verification immediately before reporting."],
    repeated_pattern_evidence: [],
    recurrence_of: [],
    ...overrides
  };
}

function source(overrides = {}) {
  return {
    sourceIdentity: "feedback-event/project-7/event-42",
    createdAt: "2026-07-20T08:09:10+08:00",
    publishedAt: "2026-07-20T00:10:11Z",
    ...overrides
  };
}

function canonicalModel(overrides = {}) {
  return { ...validateReflectionModel(lesson(), source()), ...overrides };
}

async function disposableProject(t) {
  const projectDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "afl-reflection-document-")));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  return projectDir;
}

async function copyFixture(name, destination) {
  await writeFile(destination, await readFile(new URL(name, FIXTURES)));
}

function injectedFs(stage) {
  let published = false;
  return new Proxy(fsPromises, {
    get(target, property) {
      if (property === "open") {
        return async (...args) => {
          const handle = await target.open(...args);
          if (args[1] === "wx") {
            return new Proxy(handle, {
              get(handleTarget, handleProperty) {
                if (stage === "write" && handleProperty === "writeFile") {
                  return async () => { throw Object.assign(new Error("injected write failure"), { code: "EIO" }); };
                }
                if (stage === "file-sync" && handleProperty === "sync") {
                  return async () => { throw Object.assign(new Error("injected sync failure"), { code: "EIO" }); };
                }
                const value = Reflect.get(handleTarget, handleProperty, handleTarget);
                return typeof value === "function" ? value.bind(handleTarget) : value;
              }
            });
          }
          return handle;
        };
      }
      if (property === "link" && stage === "rename") {
        return async () => { throw Object.assign(new Error("injected rename failure"), { code: "EIO" }); };
      }
      if (property === "link") {
        return async (...args) => {
          await target.link(...args);
          published = true;
        };
      }
      if (property === "readFile" && stage === "post-rename-hash") {
        return async (...args) => {
          if (published) throw Object.assign(new Error("injected verification read failure"), { code: "EIO" });
          return target.readFile(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

test("validateReflectionModel derives controller provenance and canonical UTC timestamps", () => {
  const result = lesson({
    effectiveness: "provider-claim",
    source_identity_hash: "provider-hash",
    reflection_id: "provider-id",
    title: "provider-title"
  });
  const cleanResult = lesson();
  const model = validateReflectionModel(cleanResult, source());

  const identityHash = sha256(source().sourceIdentity);
  assert.equal(model.reflection_id, `reflection-${identityHash.slice(0, 24)}`);
  assert.equal(model.source_identity_hash, identityHash);
  assert.equal(model.created_at, "2026-07-20T00:09:10.000Z");
  assert.equal(model.published_at, "2026-07-20T00:10:11.000Z");
  assert.equal(model.family_id, deriveReviewerFamilyId(cleanResult.method_class, cleanResult.proposed_family_key));
  assert.equal(model.title, cleanResult.class_of_mistake);
  assert.equal(model.effectiveness, "unknown");
  assert.throws(() => validateReflectionModel(result, source()), /unexpected fields/);
  assert.throws(() => validateReflectionModel(cleanResult, source({ createdAt: "2026-07-20T00:09:10" })), /timezone/);
  assert.throws(() => validateReflectionModel(cleanResult, { ...source(), extra: true }), /source.*fields/);
});

test("canonical effectiveness is limited to truthful controller states", () => {
  const recurrenceModel = canonicalModel({ effectiveness: "recurrence_after_emission" });
  const recurrence = parseReflectionMarkdown(renderReflectionMarkdown(recurrenceModel), {
    path: "/project/.agent/reflections/recurrence.md"
  });
  assert.equal(recurrence.eligible, true);
  assert.equal(recurrence.effectiveness, "recurrence_after_emission");

  for (const invalidState of ["provider_claim", `obser${"ved"}`, `effec${"tive"}`]) {
    assert.throws(
      () => renderReflectionMarkdown(canonicalModel({ effectiveness: invalidState })),
      /effectiveness/u
    );
    const invalidMarkdown = renderReflectionMarkdown(canonicalModel())
      .replace("- effectiveness: unknown", `- effectiveness: ${invalidState}`);
    assert.deepEqual(
      parseReflectionMarkdown(invalidMarkdown, { path: "/project/.agent/reflections/invalid.md" }),
      {
        eligible: false,
        omission: "canonical_invalid",
        path: "/project/.agent/reflections/invalid.md"
      }
    );
  }
});

test("validateReflectionModel reuses a validated existing family and bounds heading text", () => {
  const existing = lesson({ family_id: "family-existing", proposed_family_key: null });
  const model = validateReflectionModel(existing, source());
  assert.equal(model.family_id, "family-existing");

  const longTitle = "A".repeat(100) + "\n# injected";
  const bounded = validateReflectionModel(lesson({ class_of_mistake: longTitle }), source());
  assert.ok(Array.from(bounded.title).length <= 80);
  assert.doesNotMatch(bounded.title, /\n/);
});

test("canonical Markdown renders the exact readable contract and round-trips", () => {
  const model = canonicalModel();
  const markdown = renderReflectionMarkdown(model);
  assert.match(markdown, /^# 反思报告：/);
  for (const key of [
    "reflection_id", "created_at", "published_at", "final_severity", "responsibility",
    "method_class", "family_id", "applies_when", "effectiveness", "source_identity_hash"
  ]) assert.match(markdown, new RegExp(`^- ${key}: `, "m"));
  for (const heading of [
    "## facts proven by context",
    "## user complaint in plain language",
    "## root cause",
    "## class of mistake",
    "## method change",
    "## repeated pattern evidence"
  ]) assert.match(markdown, new RegExp(heading));

  const parsed = parseReflectionMarkdown(markdown, { path: "/project/.agent/reflections/report.md" });
  assert.equal(parsed.eligible, true);
  assert.equal(parsed.canonical, true);
  assert.equal(parsed.familyId, model.family_id);
  assert.deepEqual(parsed.methodChanges, model.method_changes);
  assert.equal(parsed.publishedAt, model.published_at);
  assert.equal(parsed.sourceIdentityHash, model.source_identity_hash);
});

test("canonical Markdown losslessly round-trips structural text values", () => {
  const model = canonicalModel({
    applies_when: ["prompt contains A | B", String.raw`a literal \\ backslash`],
    facts: ["first line\nsecond line", String.raw`path C:\review\facts`],
    user_complaint: "line one\nline two | still one complaint",
    root_cause: String.raw`the parser treated \\ and | as syntax`,
    class_of_mistake: "serialization\nmust be injective",
    method_changes: ["preserve line one\npreserve line two", String.raw`keep C:\review\method`],
    repeated_pattern_evidence: ["none", "A | B", String.raw`literal \\ evidence`]
  });

  const parsed = parseReflectionMarkdown(renderReflectionMarkdown(model), {
    path: "/project/.agent/reflections/lossless.md"
  });

  assert.equal(parsed.eligible, true);
  assert.deepEqual(parsed.appliesWhen, model.applies_when);
  assert.deepEqual(parsed.facts, model.facts);
  assert.equal(parsed.userComplaint, model.user_complaint);
  assert.equal(parsed.rootCause, model.root_cause);
  assert.equal(parsed.classOfMistake, model.class_of_mistake);
  assert.deepEqual(parsed.methodChanges, model.method_changes);
  assert.deepEqual(parsed.repeatedPatternEvidence, model.repeated_pattern_evidence);
});

test("legacy aliases are explicit, case-insensitive, and derive only from normalized class text", async () => {
  const modern = parseReflectionMarkdown(await readFile(new URL("legacy-modern.md", FIXTURES), "utf8"), {
    path: "/tmp/20260102-030405-modern.md"
  });
  const zh = parseReflectionMarkdown(await readFile(new URL("legacy-zh.md", FIXTURES), "utf8"), {
    path: "/tmp/20260102-030406-zh.md"
  });
  assert.equal(modern.eligible, true);
  assert.equal(zh.eligible, true);
  assert.equal(modern.createdAt, "2026-01-02T03:04:05.000Z");
  for (const parsed of [modern, zh]) {
    const normalizedClass = parsed.classOfMistake.normalize("NFC").trim().replace(/\s+/gu, " ");
    const methodClass = `legacy-method-${sha256(normalizedClass).slice(0, 20)}`;
    assert.equal(parsed.methodClass, methodClass);
    assert.equal(parsed.familyId, `legacy-family-${sha256(`${normalizedClass}\n${methodClass}`).slice(0, 20)}`);
    assert.ok(parsed.methodChanges.length > 0);
  }

  const arbitrary = (await readFile(new URL("legacy-modern.md", FIXTURES), "utf8"))
    .replace("## Class Of Mistake", "## A Similar Looking Heading");
  assert.deepEqual(parseReflectionMarkdown(arbitrary, { path: "/tmp/no-timestamp.md" }), {
    eligible: false,
    omission: "legacy_incomplete",
    path: "/tmp/no-timestamp.md"
  });
});

test("legacy documents missing required metadata or mistake class are ineligible", async () => {
  const older = await readFile(new URL("legacy-list.md", FIXTURES), "utf8");
  assert.deepEqual(parseReflectionMarkdown(older, { path: "/tmp/2026-01-02-export.md" }), {
    eligible: false,
    omission: "legacy_incomplete",
    path: "/tmp/2026-01-02-export.md"
  });
  const noSeverity = (await readFile(new URL("legacy-modern.md", FIXTURES), "utf8"))
    .replace("- final_severity: Major\n", "");
  assert.equal(parseReflectionMarkdown(noSeverity, { path: "/tmp/x.md" }).omission, "legacy_incomplete");
  const noAction = (await readFile(new URL("legacy-modern.md", FIXTURES), "utf8"))
    .replace(/## Method Change[\s\S]*?## Repeated Pattern Evidence/, "## Method Change\n\n## Repeated Pattern Evidence");
  assert.equal(parseReflectionMarkdown(noAction, { path: "/tmp/x.md" }).omission, "legacy_incomplete");
});

test("catalog reads direct regular Markdown in stable order with strict cutoffs", async (t) => {
  const projectDir = await disposableProject(t);
  const reflectionDir = path.join(projectDir, ".agent", "reflections");
  await mkdir(reflectionDir, { recursive: true, mode: 0o700 });
  await copyFixture("legacy-zh.md", path.join(reflectionDir, "b-legacy.md"));
  await copyFixture("legacy-modern.md", path.join(reflectionDir, "a-legacy.md"));
  await writeFile(path.join(reflectionDir, "c-canonical.md"), renderReflectionMarkdown(canonicalModel()));
  await writeFile(path.join(reflectionDir, "ignore.txt"), "not markdown");
  await mkdir(path.join(reflectionDir, "nested.md"));
  await symlink(path.join(reflectionDir, "a-legacy.md"), path.join(reflectionDir, "linked.md"));
  const legacyTime = new Date("2026-07-19T23:59:00Z");
  await utimes(path.join(reflectionDir, "a-legacy.md"), legacyTime, legacyTime);
  await utimes(path.join(reflectionDir, "b-legacy.md"), legacyTime, legacyTime);

  const catalog = await readReflectionCatalog({
    projectDir,
    publishedBefore: "2026-07-20T00:11:00Z"
  });
  assert.deepEqual(catalog.documents.map((entry) => path.basename(entry.path)), [
    "a-legacy.md", "b-legacy.md", "c-canonical.md"
  ]);
  assert.ok(catalog.documents.filter((entry) => !entry.canonical).every((entry) => entry.publishedAt === legacyTime.toISOString()));
  assert.deepEqual(catalog.omissions.map((entry) => [path.basename(entry.path), entry.omission]), [
    ["linked.md", "symlink"],
    ["nested.md", "not_regular_file"]
  ]);

  const equalCanonical = canonicalModel({ published_at: "2026-07-20T00:11:00.000Z" });
  await writeFile(path.join(reflectionDir, "c-canonical.md"), renderReflectionMarkdown(equalCanonical));
  const cutoff = new Date("2026-07-20T00:11:00Z");
  await utimes(path.join(reflectionDir, "b-legacy.md"), cutoff, cutoff);
  const strict = await readReflectionCatalog({ projectDir, publishedBefore: cutoff.toISOString() });
  assert.deepEqual(strict.documents.map((entry) => path.basename(entry.path)), ["a-legacy.md"]);
  assert.deepEqual(strict.omissions.filter((entry) => entry.omission === "published_after_cutoff").map((entry) => path.basename(entry.path)), [
    "b-legacy.md", "c-canonical.md"
  ]);
});

test("catalog enforces maxFiles, maxFileBytes, strict UTF-8, and the strict legacy mtime cutoff", async (t) => {
  const projectDir = await disposableProject(t);
  const reflectionDir = path.join(projectDir, ".agent", "reflections");
  await mkdir(reflectionDir, { recursive: true, mode: 0o700 });
  await copyFixture("legacy-modern.md", path.join(reflectionDir, "a.md"));
  await copyFixture("legacy-zh.md", path.join(reflectionDir, "b.md"));
  await writeFile(path.join(reflectionDir, "c.md"), Buffer.from([0xc3, 0x28]));
  await writeFile(path.join(reflectionDir, "d.md"), "x".repeat(8_192));
  const old = new Date("2026-01-01T00:00:00Z");
  for (const name of ["a.md", "b.md", "c.md", "d.md"]) await utimes(path.join(reflectionDir, name), old, old);

  const bounded = await readReflectionCatalog({ projectDir, publishedBefore: "2027-01-01T00:00:00Z", maxFiles: 3, maxFileBytes: 4_096 });
  assert.ok(bounded.documents.length <= 3);
  assert.deepEqual(bounded.omissions.map((entry) => [path.basename(entry.path), entry.omission]), [
    ["c.md", "invalid_utf8"],
    ["d.md", "max_files_exceeded"]
  ]);

  const byteBound = await readReflectionCatalog({ projectDir, publishedBefore: "2027-01-01T00:00:00Z", maxFiles: 4, maxFileBytes: 4_096 });
  assert.equal(byteBound.omissions.find((entry) => path.basename(entry.path) === "d.md").omission, "file_too_large");
});

test("pre-rename write, file-sync, hook, and rename failures leave no canonical target", async (t) => {
  for (const stage of ["write", "file-sync", "rename"]) {
    const projectDir = await disposableProject(t);
    await assert.rejects(
      publishReflectionDocument({ projectDir, model: canonicalModel(), fsImpl: injectedFs(stage) }),
      /publication_.*failed/
    );
    const entries = await readdir(path.join(projectDir, ".agent", "reflections"));
    assert.deepEqual(entries, [], `${stage} must leave no target or temp file`);
  }

  const projectDir = await disposableProject(t);
  await assert.rejects(
    publishReflectionDocument({ projectDir, model: canonicalModel(), beforeRename: () => { throw new Error("stop before rename"); } }),
    /publication_before_rename_failed/
  );
  assert.deepEqual(await readdir(path.join(projectDir, ".agent", "reflections")), []);
});

test("post-rename verification failure is recoverable by identical-hash adoption", async (t) => {
  const projectDir = await disposableProject(t);
  const model = canonicalModel();
  await assert.rejects(
    publishReflectionDocument({ projectDir, model, fsImpl: injectedFs("post-rename-hash") }),
    /publication_verification_failed/
  );
  const adopted = await publishReflectionDocument({ projectDir, model });
  assert.equal(adopted.created, false);
  assert.equal(adopted.sha256, sha256(renderReflectionMarkdown(model)));
});

test("publication is private, idempotent, verified, and refuses content collisions", async (t) => {
  const projectDir = await disposableProject(t);
  const model = canonicalModel();
  const published = await publishReflectionDocument({ projectDir, model });
  assert.equal(published.created, true);
  assert.equal((await stat(published.path)).mode & 0o777, 0o600);
  assert.equal(published.sha256, sha256(await readFile(published.path)));
  assert.match(path.basename(published.path), /^20260720-000910-[a-z0-9-]+-[a-f0-9]{12}\.md$/);

  const adopted = await publishReflectionDocument({ projectDir, model });
  assert.deepEqual(adopted, { ...published, created: false });

  const collision = { ...model, root_cause: "Different canonical content." };
  await assert.rejects(publishReflectionDocument({ projectDir, model: collision }), /publication_collision/);
  assert.equal(await readFile(published.path, "utf8"), renderReflectionMarkdown(model));

  const differentSlug = {
    ...model,
    title: "A different title for the same identity",
    class_of_mistake: "A different class for the same identity"
  };
  await assert.rejects(publishReflectionDocument({ projectDir, model: differentSlug }), /publication_collision/);
  assert.deepEqual((await readdir(path.dirname(published.path))).filter((name) => name.endsWith(".md")), [path.basename(published.path)]);

  const catalog = await readReflectionCatalog({ projectDir, publishedBefore: "2026-07-20T00:12:00Z" });
  assert.equal(catalog.documents.length, 1);
  assert.equal(catalog.documents[0].reflectionId, model.reflection_id);
  assert.equal(catalog.documents[0].documentHash, sha256(await readFile(published.path)));
});

test("concurrent same-identity publishers never overwrite a conflicting target", async (t) => {
  const projectDir = await disposableProject(t);
  const first = canonicalModel({ root_cause: "First competing content." });
  const second = canonicalModel({ root_cause: "Second competing content." });
  let hooksWaiting = 0;
  let releaseHooks;
  const hooksReady = new Promise((resolve) => { releaseHooks = resolve; });
  let finalReads = 0;
  let releaseReads;
  const readsReady = new Promise((resolve) => { releaseReads = resolve; });
  let finalScanPhase = false;
  const beforeRename = async () => {
    hooksWaiting += 1;
    if (hooksWaiting === 2) {
      finalScanPhase = true;
      releaseHooks();
    }
    await hooksReady;
  };
  const coordinatedFs = new Proxy(fsPromises, {
    get(target, property) {
      if (property === "readdir") {
        return async (...args) => {
          const entries = await target.readdir(...args);
          if (finalScanPhase && finalReads < 2) {
            finalReads += 1;
            if (finalReads === 2) releaseReads();
            await readsReady;
          }
          return entries;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  const settled = await Promise.allSettled([
    publishReflectionDocument({ projectDir, model: first, beforeRename, fsImpl: coordinatedFs }),
    publishReflectionDocument({ projectDir, model: second, beforeRename, fsImpl: coordinatedFs })
  ]);
  const fulfilled = settled.map((result, index) => ({ result, index }))
    .filter(({ result }) => result.status === "fulfilled");
  const rejected = settled.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /publication_collision/);
  const winningModel = [first, second][fulfilled[0].index];
  assert.equal(await readFile(fulfilled[0].result.value.path, "utf8"), renderReflectionMarkdown(winningModel));
});

test("publication validates exclusive absolute roots and rejects symlinked protected directories", async (t) => {
  const projectDir = await disposableProject(t);
  const exportDir = await disposableProject(t);
  const model = canonicalModel();
  await assert.rejects(publishReflectionDocument({ model }), /exactly one/);
  await assert.rejects(publishReflectionDocument({ projectDir, reflectionDir: exportDir, model }), /exactly one/);
  await assert.rejects(publishReflectionDocument({ projectDir: "relative", model }), /absolute/);

  const outside = await disposableProject(t);
  await symlink(outside, path.join(projectDir, ".agent"));
  await assert.rejects(publishReflectionDocument({ projectDir, model }), /symlink/);
  assert.deepEqual(await readdir(outside), []);

  const exported = await publishReflectionDocument({ reflectionDir: exportDir, model });
  assert.equal(path.dirname(exported.path), exportDir);
});

test("publication rejects project and reflection roots beneath symlinked ancestors before writing", async (t) => {
  const aliases = await disposableProject(t);
  const physical = await disposableProject(t);
  const physicalProject = path.join(physical, "project");
  const physicalReflectionDir = path.join(physical, "export");
  await mkdir(physicalProject);
  await mkdir(physicalReflectionDir);
  await symlink(physical, path.join(aliases, "linked-parent"));

  const projectDir = path.join(aliases, "linked-parent", "project");
  await assert.rejects(
    publishReflectionDocument({ projectDir, model: canonicalModel() }),
    /project_root_symlink/
  );
  assert.deepEqual(await readdir(physicalProject), []);

  const reflectionDir = path.join(aliases, "linked-parent", "export");
  await assert.rejects(
    publishReflectionDocument({ reflectionDir, model: canonicalModel() }),
    /reflection_directory_symlink/
  );
  assert.deepEqual(await readdir(physicalReflectionDir), []);
});
