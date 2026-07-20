import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { inspectLegacyExport, executeLegacyExport } from "../src/legacy-export.mjs";
import { parseReflectionMarkdown } from "../src/reflection-document.mjs";

const CREATED_AT = "2026-07-20T08:01:00.000Z";
const REPORT_AT = "2026-07-20T08:02:00.000Z";
const RECEIPT_AT = "2026-07-20T08:03:00.000Z";
const REPORT_BODY = "The persisted redacted report proves that completion was claimed before the required verification ran.";
const PAYLOAD_REPORT_POISON = "PAYLOAD REPORT CONTENT MUST NEVER BE EXPORTED";
const PAYLOAD_CARD_POISON = "PAYLOAD CARD MUST NEVER BE EXPORTED";
const FEEDBACK_QUOTE = "You claimed this was complete before you verified it.";

const LEGACY_SCHEMA_SQL = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE review_receipts (
  receipt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE report_contents (
  content_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  content_text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE lessons (
  lesson_id TEXT PRIMARY KEY,
  severity TEXT NOT NULL,
  responsibility TEXT,
  method_class TEXT,
  class_id TEXT,
  current_revision INTEGER NOT NULL
);
CREATE TABLE lesson_revisions (
  lesson_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  card_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(lesson_id, revision)
);
`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function completeLesson(overrides = {}) {
  return {
    lesson_id: "raw-lesson-complete",
    revision: 1,
    base_revision: 0,
    project_id: "raw-project",
    severity: "Major",
    responsibility: "agent_fault",
    confidence: "high",
    causal_chain: [
      "The result was inferred from implementation progress.",
      "The required verification was not run.",
      "The completion response had no evidence gate.",
      "The workflow treated implementation as proof.",
      "The method optimized for closure instead of observable evidence."
    ],
    method_class: "verification-closure",
    class_id: "completion-claim-without-evidence",
    generalizable: true,
    rule_action: "update_project_rule",
    evidence_refs: [{
      feedback_event_id: "raw-feedback-event",
      feedback_quote: FEEDBACK_QUOTE,
      referent_event_ids: ["raw-assistant-event"]
    }],
    card: {
      when: PAYLOAD_CARD_POISON,
      must_do: PAYLOAD_CARD_POISON,
      must_not: PAYLOAD_CARD_POISON,
      verify: PAYLOAD_CARD_POISON,
      why: PAYLOAD_CARD_POISON,
      exception: PAYLOAD_CARD_POISON,
      source_ids: ["raw-report-valid"]
    },
    ...overrides
  };
}

function revisionCard(overrides = {}) {
  return {
    when: "When preparing a completion claim for work that has a required verification.",
    must_do: "Run the required verification immediately before reporting completion.",
    must_not: "Do not infer success from implementation progress.",
    verify: "Read the fresh verification result and cite the observed outcome.",
    why: "The earlier completion claim was not grounded in observed evidence.",
    exception: "Only an explicit user-approved deferral may leave verification pending.",
    source_ids: ["raw-report-valid"],
    ...overrides
  };
}

async function copyWalSet(builderDb, sourceDb) {
  for (const suffix of ["", "-wal", "-shm"]) {
    await copyFile(`${builderDb}${suffix}`, `${sourceDb}${suffix}`);
  }
}

async function legacyFixture(t, {
  version = 8,
  includeBadLesson = true,
  includeReport = true,
  malformedReceipt = false,
  cardSourceIds = ["raw-report-valid"],
  persistedLessonOverrides = {}
} = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "afl-legacy-export-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const builderDir = path.join(root, "builder");
  const sourceDir = path.join(root, "source");
  await mkdir(builderDir, { mode: 0o700 });
  await mkdir(sourceDir, { mode: 0o700 });
  const builderDb = path.join(builderDir, "legacy.sqlite3");
  const sourceDb = path.join(sourceDir, "legacy.sqlite3");
  const outputDir = path.join(root, "exports");
  const database = new DatabaseSync(builderDb);
  try {
    database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    database.exec(LEGACY_SCHEMA_SQL);
    if (version === 9) {
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (8, ?), (9, ?)")
        .run(CREATED_AT, RECEIPT_AT);
    } else {
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (8, ?)").run(CREATED_AT);
    }

    const lessons = [completeLesson()];
    if (includeBadLesson) {
      lessons.push(completeLesson({
        lesson_id: "raw-lesson-incomplete",
        class_id: "incomplete-card"
      }));
    }
    const payload = {
      write_complete: true,
      review_receipt_id: "raw-receipt-valid",
      report_content_id: "raw-report-valid",
      report_content: PAYLOAD_REPORT_POISON,
      status: "reviewed",
      lessons
    };
    database.prepare("INSERT INTO review_receipts(receipt_id, job_id, payload_json, created_at) VALUES (?, ?, ?, ?)")
      .run("raw-receipt-valid", "raw-job-valid", JSON.stringify(payload), RECEIPT_AT);
    if (malformedReceipt) {
      database.prepare("INSERT INTO review_receipts(receipt_id, job_id, payload_json, created_at) VALUES (?, ?, ?, ?)")
        .run("raw-receipt-malformed", "raw-job-malformed", "{not-json", RECEIPT_AT);
    }
    if (includeReport) {
      database.prepare("INSERT INTO report_contents(content_id, job_id, content_text, created_at) VALUES (?, ?, ?, ?)")
        .run("raw-report-valid", "raw-job-valid", REPORT_BODY, REPORT_AT);
    }
    const insertLesson = database.prepare(`INSERT INTO lessons
      (lesson_id, severity, responsibility, method_class, class_id, current_revision)
      VALUES (?, ?, ?, ?, ?, ?)`);
    const insertRevision = database.prepare(`INSERT INTO lesson_revisions
      (lesson_id, revision, card_json, created_at) VALUES (?, ?, ?, ?)`);
    const persistedLesson = {
      severity: "Major",
      responsibility: "agent_fault",
      method_class: "verification-closure",
      class_id: "completion-claim-without-evidence",
      current_revision: 1,
      ...persistedLessonOverrides
    };
    insertLesson.run(
      "raw-lesson-complete",
      persistedLesson.severity,
      persistedLesson.responsibility,
      persistedLesson.method_class,
      persistedLesson.class_id,
      persistedLesson.current_revision
    );
    insertRevision.run(
      "raw-lesson-complete", 1,
      JSON.stringify(revisionCard({ source_ids: cardSourceIds })),
      CREATED_AT
    );
    if (persistedLesson.current_revision > 1) {
      insertRevision.run(
        "raw-lesson-complete", persistedLesson.current_revision,
        JSON.stringify(revisionCard({
          when: "When the latest projection supersedes an older receipt revision."
        })),
        RECEIPT_AT
      );
    }
    if (includeBadLesson) {
      insertLesson.run(
        "raw-lesson-incomplete", "Major", "agent_fault", "verification-closure",
        "incomplete-card", 1
      );
      const malformedCard = revisionCard();
      delete malformedCard.verify;
      insertRevision.run("raw-lesson-incomplete", 1, JSON.stringify(malformedCard), CREATED_AT);
    }

    // Copy a transactionally stable WAL set while its builder connection is open.
    // The copy itself has no open connection and is the immutable legacy fixture.
    await copyWalSet(builderDb, sourceDb);
  } finally {
    database.close();
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    assert.equal((await stat(`${sourceDb}${suffix}`)).isFile(), true);
  }
  return { root, sourceDb: await realpath(sourceDb), outputDir };
}

async function hashLegacyFiles(sourceDb) {
  const result = {};
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      result[suffix || "database"] = sha256(await readFile(`${sourceDb}${suffix}`));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return result;
}

async function listReflectionFiles(outputDir) {
  try {
    return (await readdir(outputDir)).filter((name) => name.endsWith(".md")).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

for (const version of [8, 9]) {
  test(`schema v${version} dry-run is side-effect free and apply is idempotent`, async (t) => {
    const { sourceDb, outputDir } = await legacyFixture(t, { version });
    const originalHashes = await hashLegacyFiles(sourceDb);

    const dryRun = await inspectLegacyExport({ sourceDb, outputDir });
    assert.deepEqual(dryRun.counts, { planned: 1, incomplete: 1, conflicts: 0 });
    assert.equal(
      dryRun.items.find((item) => item.status === "planned").id,
      `legacy-${sha256(JSON.stringify([
        "legacy-export-v1", "raw-receipt-valid", "raw-lesson-complete", 1
      ]))}`
    );
    assert.equal((await listReflectionFiles(outputDir)).length, 0);
    assert.deepEqual(await executeLegacyExport({ plan: dryRun, dryRun: true }), {
      planned: 1, written: 0, skipped: 0, incomplete: 1, conflicts: 0
    });
    assert.equal((await listReflectionFiles(outputDir)).length, 0);

    const first = await executeLegacyExport({ plan: dryRun, dryRun: false });
    const second = await executeLegacyExport({
      plan: await inspectLegacyExport({ sourceDb, outputDir }),
      dryRun: false
    });
    assert.deepEqual(first, { planned: 1, written: 1, skipped: 0, incomplete: 1, conflicts: 0 });
    assert.deepEqual(second, { planned: 1, written: 0, skipped: 1, incomplete: 1, conflicts: 0 });
    assert.deepEqual(await hashLegacyFiles(sourceDb), originalHashes);

    const [name] = await listReflectionFiles(outputDir);
    const markdown = await readFile(path.join(outputDir, name), "utf8");
    const parsed = parseReflectionMarkdown(markdown, { path: path.join(outputDir, name) });
    assert.equal(parsed.eligible, true);
    assert.equal(parsed.canonical, true);
    assert.equal(parsed.methodClass, "verification_closure");
    assert.equal(parsed.familyId, sha256("verification-closure\u0000completion-claim-without-evidence"));
    assert.deepEqual(parsed.facts, [FEEDBACK_QUOTE]);
    assert.equal(parsed.userComplaint, FEEDBACK_QUOTE);
    assert.equal(parsed.rootCause, REPORT_BODY);
    assert.deepEqual(parsed.methodChanges, [
      revisionCard().must_do,
      revisionCard().must_not,
      revisionCard().verify
    ]);
    assert.doesNotMatch(markdown, new RegExp(`${PAYLOAD_REPORT_POISON}|${PAYLOAD_CARD_POISON}`, "u"));
    assert.equal((await stat(outputDir)).mode & 0o777, 0o700);

    const visiblePlan = JSON.stringify(dryRun);
    assert.doesNotMatch(visiblePlan, /raw-(?:receipt|lesson|report|job|project|feedback|assistant)/u);
    assert.doesNotMatch(visiblePlan, /PAYLOAD|persisted redacted|afl-legacy-export/u);
  });
}

const EXACT_CURRENT_MISMATCHES = [
  ["severity", { severity: "Critical" }],
  ["responsibility", { responsibility: "shared_fault" }],
  ["method_class", { method_class: "different-method" }],
  ["class_id", { class_id: "different-completion-class" }]
];

for (const version of [8, 9]) {
  test(`schema v${version} rejects exact-current lesson row mismatches opaquely`, async (t) => {
    for (const [field, persistedLessonOverrides] of EXACT_CURRENT_MISMATCHES) {
      await t.test(field, async (t) => {
        const fixture = await legacyFixture(t, {
          version,
          includeBadLesson: false,
          persistedLessonOverrides
        });
        const plan = await inspectLegacyExport(fixture);

        assert.deepEqual(plan.counts, { planned: 0, incomplete: 1, conflicts: 0 });
        assert.equal(plan.items.length, 1);
        assert.deepEqual(Object.keys(plan.items[0]).sort(), ["id", "reason", "status"]);
        assert.match(plan.items[0].id, /^legacy-[a-f0-9]{64}$/u);
        assert.equal(plan.items[0].status, "incomplete");
        assert.equal(plan.items[0].reason, "mismatched_lesson");
        assert.ok(plan.items[0].reason.length <= 64);
      });
    }
  });
}

for (const version of [8, 9]) {
  test(`schema v${version} exports an older receipt from its historical fields`, async (t) => {
    const fixture = await legacyFixture(t, {
      version,
      includeBadLesson: false,
      persistedLessonOverrides: {
        severity: "Critical",
        responsibility: "shared_fault",
        method_class: "different-method",
        class_id: "different-completion-class",
        current_revision: 2
      }
    });
    const plan = await inspectLegacyExport(fixture);

    assert.deepEqual(plan.counts, { planned: 1, incomplete: 0, conflicts: 0 });
    assert.deepEqual(await executeLegacyExport({ plan, dryRun: false }), {
      planned: 1, written: 1, skipped: 0, incomplete: 0, conflicts: 0
    });
    const [name] = await listReflectionFiles(fixture.outputDir);
    const markdown = await readFile(path.join(fixture.outputDir, name), "utf8");
    const parsed = parseReflectionMarkdown(markdown, { path: name });
    assert.equal(parsed.methodClass, "verification_closure");
    assert.equal(parsed.familyId, sha256("verification-closure\u0000completion-claim-without-evidence"));
    assert.doesNotMatch(markdown, /different-method|different-completion-class/u);
  });
}

test("each bad receipt lesson is incomplete without suppressing complete siblings", async (t) => {
  const fixture = await legacyFixture(t, { malformedReceipt: true });
  const plan = await inspectLegacyExport(fixture);

  assert.deepEqual(plan.counts, { planned: 1, incomplete: 2, conflicts: 0 });
  assert.equal(plan.items.filter((item) => item.status === "planned").length, 1);
  assert.equal(plan.items.filter((item) => item.status === "incomplete").length, 2);
  assert.ok(plan.items.every((item) => /^legacy-[a-f0-9]{64}$/u.test(item.id)));
  assert.ok(plan.items.every((item) => Object.keys(item).every((key) => ["id", "status", "reason"].includes(key))));
});

test("missing persisted report marks every dependent tuple incomplete", async (t) => {
  const fixture = await legacyFixture(t, { includeReport: false });
  const plan = await inspectLegacyExport(fixture);

  assert.deepEqual(plan.counts, { planned: 0, incomplete: 2, conflicts: 0 });
  assert.ok(plan.items.every((item) => item.status === "incomplete" && item.reason === "missing_report"));
  assert.deepEqual(await executeLegacyExport({ plan, dryRun: false }), {
    planned: 0, written: 0, skipped: 0, incomplete: 2, conflicts: 0
  });
});

test("card source ids need not duplicate the receipt report binding", async (t) => {
  const fixture = await legacyFixture(t, {
    includeBadLesson: false,
    cardSourceIds: ["raw-feedback-event", "raw-assistant-event"]
  });
  const plan = await inspectLegacyExport(fixture);

  assert.deepEqual(plan.counts, { planned: 1, incomplete: 0, conflicts: 0 });
});

test("publication collision is counted and never overwrites the existing document", async (t) => {
  const fixture = await legacyFixture(t, { includeBadLesson: false });
  const firstPlan = await inspectLegacyExport(fixture);
  await executeLegacyExport({ plan: firstPlan, dryRun: false });
  const [name] = await listReflectionFiles(fixture.outputDir);
  const target = path.join(fixture.outputDir, name);
  const conflicting = (await readFile(target, "utf8")).replace(REPORT_BODY, "A different but still canonical root cause.");
  await writeFile(target, conflicting, "utf8");

  const collisionPlan = await inspectLegacyExport(fixture);
  assert.deepEqual(collisionPlan.counts, { planned: 1, incomplete: 0, conflicts: 1 });
  assert.deepEqual(collisionPlan.items.map(({ status, reason }) => [status, reason]), [
    ["conflict", "publication_collision"]
  ]);
  const result = await executeLegacyExport({ plan: collisionPlan, dryRun: false });

  assert.deepEqual(result, { planned: 1, written: 0, skipped: 0, incomplete: 0, conflicts: 1 });
  assert.equal(await readFile(target, "utf8"), conflicting);
  assert.deepEqual(await listReflectionFiles(fixture.outputDir), [name]);
});

test("source and output symlinks are rejected without writes", async (t) => {
  const fixture = await legacyFixture(t, { includeBadLesson: false });
  const sourceAlias = path.join(fixture.root, "source-alias.sqlite3");
  await symlink(fixture.sourceDb, sourceAlias);
  await assert.rejects(
    inspectLegacyExport({ sourceDb: sourceAlias, outputDir: fixture.outputDir }),
    /source_(?:path_)?symlink/u
  );

  const outside = path.join(fixture.root, "outside");
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, fixture.outputDir);
  await assert.rejects(
    inspectLegacyExport({ sourceDb: fixture.sourceDb, outputDir: fixture.outputDir }),
    /output_(?:path_)?symlink/u
  );
  assert.deepEqual(await readdir(outside), []);
});

test("source-set errors expose only a bounded reason without path-bearing causes", async (t) => {
  const fixture = await legacyFixture(t, { includeBadLesson: false });
  const walPath = `${fixture.sourceDb}-wal`;
  await unlink(walPath);
  await symlink(fixture.sourceDb, walPath);

  await assert.rejects(
    inspectLegacyExport({ sourceDb: fixture.sourceDb, outputDir: fixture.outputDir }),
    (error) => {
      assert.equal(error.message, "source_path_symlink");
      assert.equal(Object.hasOwn(error, "cause"), false);
      assert.doesNotMatch(String(error.stack), /afl-legacy-export|legacy\.sqlite3/u);
      return true;
    }
  );
});

test("apply rejects a source-set change before creating the output leaf", async (t) => {
  const fixture = await legacyFixture(t, { includeBadLesson: false });
  const plan = await inspectLegacyExport(fixture);
  await writeFile(`${fixture.sourceDb}-wal`, "changed after inspection", { flag: "a" });

  await assert.rejects(
    executeLegacyExport({ plan, dryRun: false }),
    /source_changed/u
  );
  await assert.rejects(stat(fixture.outputDir));
});
