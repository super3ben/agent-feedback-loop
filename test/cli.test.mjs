import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { doctor, install, pathsFor, uninstall } from "../src/index.mjs";
import * as cliModule from "../src/cli.mjs";
import { BlobKeyProvider, EncryptedBlobStore } from "../src/crypto-store.mjs";
import { initializeControlStore } from "../src/control-store.mjs";
import { executeGuardCli } from "../src/convergence-cli.mjs";
import { ConvergenceProbeContextStore } from "../src/convergence-probe-context.mjs";
import { ensureRepositoryLineage } from "../src/convergence-identity.mjs";
import { publishReflectionDocument } from "../src/reflection-document.mjs";
import { recoverDueReviewers } from "../src/reviewer-launcher.mjs";
import { loadReflectionDocuments } from "../src/selector.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "bin", "agent-feedback-loop.mjs");

async function legacyCliFixture({ configuredLegacyPath = false } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "afl-legacy-cli-")));
  const sourceDb = configuredLegacyPath
    ? pathsFor(root).legacyDatabase
    : path.join(root, "legacy.sqlite3");
  const outputDir = path.join(root, "exports");
  await mkdir(path.dirname(sourceDb), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(sourceDb);
  try {
    database.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE review_receipts(receipt_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE report_contents(content_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, content_text TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE lessons(lesson_id TEXT PRIMARY KEY, severity TEXT NOT NULL, responsibility TEXT, method_class TEXT, class_id TEXT, current_revision INTEGER NOT NULL);
      CREATE TABLE lesson_revisions(lesson_id TEXT NOT NULL, revision INTEGER NOT NULL, card_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(lesson_id, revision));
    `);
    const timestamp = "2026-07-20T08:03:00.000Z";
    const lesson = {
      lesson_id: "cli-raw-lesson",
      revision: 1,
      severity: "Major",
      responsibility: "agent_fault",
      confidence: "high",
      causal_chain: ["one cause", "two causes", "three causes", "four causes", "five causes"],
      method_class: "verification-closure",
      class_id: "cli-class",
      generalizable: true,
      evidence_refs: [{ feedback_event_id: "cli-event", feedback_quote: "private cli quote", referent_event_ids: ["cli-referent"] }]
    };
    database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (8, ?)").run(timestamp);
    database.prepare("INSERT INTO review_receipts(receipt_id, job_id, payload_json, created_at) VALUES (?, ?, ?, ?)").run(
      "cli-raw-receipt", "cli-raw-job", JSON.stringify({
        write_complete: true,
        review_receipt_id: "cli-raw-receipt",
        report_content_id: "cli-raw-report",
        report_content: "private payload report",
        status: "reviewed",
        lessons: [lesson]
      }), timestamp
    );
    database.prepare("INSERT INTO report_contents(content_id, job_id, content_text, created_at) VALUES (?, ?, ?, ?)")
      .run("cli-raw-report", "cli-raw-job", "private persisted report body with enough substantive detail", timestamp);
    database.prepare("INSERT INTO lessons(lesson_id, severity, responsibility, method_class, class_id, current_revision) VALUES (?, ?, ?, ?, ?, ?)")
      .run("cli-raw-lesson", "Major", "agent_fault", "verification-closure", "cli-class", 1);
    database.prepare("INSERT INTO lesson_revisions(lesson_id, revision, card_json, created_at) VALUES (?, ?, ?, ?)").run(
      "cli-raw-lesson", 1, JSON.stringify({
        when: "when checking CLI completion",
        must_do: "run the CLI verification",
        must_not: "do not infer CLI success",
        verify: "inspect the CLI output",
        why: "the previous result was not checked",
        exception: "none",
        source_ids: ["cli-raw-report"]
      }), timestamp
    );
  } finally {
    database.close();
  }
  return { root, sourceDb: await realpath(sourceDb), outputDir };
}

async function tempHome() {
  return mkdtemp(path.join(tmpdir(), "afl-home-"));
}

function unavailableCodexHost() {
  return {
    async synchronize() { return { available: false, configured: true, runnable: false, status: "unavailable" }; },
    async inspect() { return { available: false, configured: false, runnable: false, status: "unavailable", prompt: {} }; }
  };
}

function mixedCodexConfig(home) {
  const packRoot = path.join(home, ".agent", "feedback-loop");
  return `unrelated_value = "keep-root"

# agent-feedback-loop:start
[[hooks.Stop]]
matcher = "marked-stop-parent"
options = { source = "user" }

[[hooks.Stop.hooks]]
type = "command"
command = "${packRoot}/hooks/stop-hook.sh --mode codex"

[[hooks.Stop.hooks]]
type = "command"
command = "/opt/user/keep-stop.sh"
# migration note: the old ${packRoot}/hooks/stop-hook.sh handler must be removed
# agent-feedback-loop:end

[[hooks.UserPromptSubmit]]
matcher = "unmarked-prompt-parent"
options = { source = "user" }

[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "${packRoot}/hooks/core-hook.sh --legacy-core"

[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "${packRoot}/hooks/codex-hook.sh"

[[hooks.UserPromptSubmit.hooks]]
type = "prompt"
prompt = "${packRoot}/prompts/reflection-agent.md"

[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "/opt/user/keep-prompt.sh"

[unrelated]
value = "keep-table"
`;
}

function runWithInput(file, input, env, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${file} exited ${code}: ${stderr}`)));
    child.stdin.end(input);
  });
}

const EXPLICIT_FEEDBACK = "是的，而且为什么你改造这些之前没有去考虑这些东西呢，而是等到我发现事情变复杂了才开始思考这些东西";
const PROMPT_CUTOFF = "2030-07-20T08:00:00.000Z";

function explicitFeedbackPayload(overrides = {}) {
  const sessionId = overrides.session_id || "feedback-session-1";
  return {
    session_id: sessionId,
    event_id: "feedback-event-1",
    turn_id: "feedback-turn-2",
    cwd: "/tmp/afl-task-5-project",
    timestamp: "2026-07-20T07:59:59.000Z",
    prompt: EXPLICIT_FEEDBACK,
    previous_assistant_message: {
      role: "assistant",
      id: "assistant-event-1",
      turn_id: "feedback-turn-1",
      timestamp: "2026-07-20T07:59:58.000Z",
      content: [{ type: "output_text", text: "I changed the design before confirming the simpler boundary." }]
    },
    ...overrides
  };
}

async function promptOrchestrationFixture() {
  const home = await tempHome();
  const paths = pathsFor(home);
  const controlStore = initializeControlStore({ paths, now: () => new Date(PROMPT_CUTOFF) });
  const blobs = new EncryptedBlobStore({
    root: paths.blobRoot,
    keyProvider: new BlobKeyProvider({ keyRoot: paths.keyRoot })
  });
  return { home, paths, controlStore, blobs };
}

function reviewJobCount(store) {
  return Number(store.database.prepare("SELECT COUNT(*) AS count FROM reviewer_jobs").get().count);
}

function capturedEventCount(store) {
  return Number(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count);
}

async function publishSelectableReflection(fixture, overrides = {}) {
  const projectDir = await realpath(fixture.home);
  const model = {
    title: "check the requirement boundary first",
    reflection_id: "reflection-000000000000000000000011",
    created_at: "2026-07-20T07:58:00.000Z",
    published_at: "2026-07-20T07:59:00.000Z",
    final_severity: "Critical",
    responsibility: "agent_fault",
    method_class: "requirement_boundary",
    family_id: "family-requirement-boundary",
    applies_when: ["修改已有架构前先核对用户目标"],
    effectiveness: "unknown",
    source_identity_hash: "11".padStart(64, "0"),
    facts: ["private selection fact"],
    user_complaint: "private selection complaint",
    root_cause: "private selection cause",
    class_of_mistake: "未先核对用户目标",
    method_changes: ["先核对用户目标再修改架构"],
    repeated_pattern_evidence: [],
    ...overrides
  };
  const published = await publishReflectionDocument({ projectDir, model });
  return { projectDir, model, published };
}

describe("agent-feedback-loop package", () => {
  it("explicit feedback commits one job before launch", async () => {
    const fixture = await promptOrchestrationFixture();
    const calls = [];

    const response = await cliModule.handlePromptHook({
      payload: explicitFeedbackPayload(),
      cli: "codex",
      controlStore: fixture.controlStore,
      blobs: fixture.blobs,
      launchReviewer(jobId, launchEpoch) {
        assert.equal(reviewJobCount(fixture.controlStore), 1);
        assert.deepEqual(
          fixture.controlStore.database.prepare("SELECT role FROM session_events ORDER BY role").all().map((row) => row.role),
          ["assistant", "user"]
        );
        calls.push(`launch:${jobId}:${launchEpoch}`);
      },
      async writeResponse(result) {
        calls.push("response");
        assert.deepEqual(result, { continue: true });
        return { continue: true };
      },
      now() {
        calls.push("cutoff");
        return new Date(PROMPT_CUTOFF);
      }
    });

    const job = fixture.controlStore.database.prepare("SELECT * FROM reviewer_jobs").get();
    assert.deepEqual(calls, ["cutoff", `launch:${job.job_id}:1`, "response"]);
    assert.equal(job.source_event_uid, fixture.controlStore.database.prepare("SELECT event_uid FROM session_events WHERE role='user'").get().event_uid);
    assert.equal(job.referent_event_uid, fixture.controlStore.database.prepare("SELECT event_uid FROM session_events WHERE role='assistant'").get().event_uid);
    assert.equal(response.selectionPublishedBefore, PROMPT_CUTOFF);
    assert.equal(response.selectionInput.publishedBefore, PROMPT_CUTOFF);
    assert.equal(response.operationalText, null);
    assert.deepEqual(response.hostResponse, { continue: true });
    fixture.controlStore.close();
  });

  it("hook replay reuses the job", async () => {
    const fixture = await promptOrchestrationFixture();
    const launches = [];
    let responses = 0;
    const input = {
      payload: explicitFeedbackPayload(),
      cli: "codex",
      controlStore: fixture.controlStore,
      blobs: fixture.blobs,
      launchReviewer(jobId, launchEpoch) { launches.push([jobId, launchEpoch]); },
      async writeResponse() { responses += 1; return { continue: true }; },
      now: () => new Date(PROMPT_CUTOFF)
    };

    await cliModule.handlePromptHook(input);
    await cliModule.handlePromptHook(input);

    assert.equal(reviewJobCount(fixture.controlStore), 1);
    assert.equal(capturedEventCount(fixture.controlStore), 2);
    assert.equal(launches.length, 1);
    assert.equal(responses, 2);
    fixture.controlStore.close();
  });

  it("launcher cutoff excludes an equal-time atomic publication then admits it on the next prompt", async () => {
    const fixture = await promptOrchestrationFixture();
    const projectDir = await realpath(fixture.home);
    const reflectionModel = {
        title: "check goals before redesign",
        reflection_id: "reflection-000000000000000000000010",
        created_at: "2026-07-20T07:59:58.000Z",
        published_at: PROMPT_CUTOFF,
        final_severity: "Critical",
        responsibility: "agent_fault",
        method_class: "goal_check",
        family_id: "family-goal-check",
        applies_when: [EXPLICIT_FEEDBACK],
        effectiveness: "unknown",
        source_identity_hash: "10".padStart(64, "0"),
        facts: ["private launcher fact"],
        user_complaint: "private launcher complaint",
        root_cause: "private launcher cause",
        class_of_mistake: "未先核对用户目标",
        method_changes: ["先核对用户目标再修改架构"],
        repeated_pattern_evidence: []
      };
    let publication = null;
    const responses = [];
    const input = {
      payload: explicitFeedbackPayload({ cwd: projectDir }),
      cli: "codex",
      controlStore: fixture.controlStore,
      blobs: fixture.blobs,
      launchReviewer() {
        publication = publishReflectionDocument({ projectDir, model: reflectionModel });
        return { attempted: true };
      },
      async loadDocuments(options) {
        await publication;
        return loadReflectionDocuments(options);
      },
      writeResponse: async (response) => { responses.push(response); return response; }
    };

    const current = await cliModule.handlePromptHook({ ...input, now: () => new Date(PROMPT_CUTOFF) });
    const next = await cliModule.handlePromptHook({ ...input, now: () => new Date(Date.parse(PROMPT_CUTOFF) + 1) });

    assert.deepEqual(responses[0], { continue: true });
    assert.equal("hookSpecificOutput" in current.hostResponse, false);
    assert.equal(responses[1].hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(responses[1].hookSpecificOutput.additionalContext, /document_hash: [a-f0-9]{64}/u);
    assert.doesNotMatch(responses[1].hookSpecificOutput.additionalContext, /private launcher/u);
    assert.deepEqual(next.hostResponse, responses[1]);
    fixture.controlStore.close();
  });

  it("selected is not emitted when the host writer rejects", async () => {
    const fixture = await promptOrchestrationFixture();
    const { projectDir } = await publishSelectableReflection(fixture);
    const writerError = new Error("synthetic_writer_failure");
    let directWriterCalls = 0;
    await assert.rejects(
      cliModule.writePromptResponse({
        cli: "codex",
        response: { continue: true },
        writer: async () => {
          directWriterCalls += 1;
          throw writerError;
        }
      }),
      (error) => error === writerError
    );
    assert.equal(directWriterCalls, 1, "the output boundary must call its writer exactly once");

    let hookWriterCalls = 0;
    const result = await cliModule.handlePromptHook({
      payload: explicitFeedbackPayload({
        session_id: "selection-write-failure",
        context_epoch: 3,
        task_fingerprint: "task-write-failure",
        cwd: projectDir,
        prompt: "修改已有架构前先核对用户目标",
        previous_assistant_message: undefined
      }),
      cli: "codex",
      controlStore: fixture.controlStore,
      blobs: fixture.blobs,
      launchReviewer() { throw new Error("neutral prompt must not launch"); },
      writeResponse: async () => {
        hookWriterCalls += 1;
        throw writerError;
      },
      now: () => new Date(PROMPT_CUTOFF)
    });

    const [row] = fixture.controlStore.database.prepare("SELECT * FROM reflection_emissions").all();
    assert.equal(hookWriterCalls, 1);
    assert.equal(result.hostResponse, null);
    assert.equal(result.reason, "response_failed");
    assert.match(result.guidance, /document_hash: [a-f0-9]{64}/u);
    assert.equal(row.outcome, "selected");
    assert.equal(row.emitted_at, null);
    assert.deepEqual(fixture.controlStore.listPriorReflectionEmissions({
      sessionUid: "codex:default:selection-write-failure",
      contextEpoch: 3,
      taskFingerprint: "task-write-failure"
    }), []);

    let retryWriterCalls = 0;
    const retry = await cliModule.handlePromptHook({
      payload: explicitFeedbackPayload({
        session_id: "selection-write-failure",
        context_epoch: 3,
        task_fingerprint: "task-write-failure",
        cwd: projectDir,
        prompt: "修改已有架构前先核对用户目标",
        previous_assistant_message: undefined
      }),
      cli: "codex",
      controlStore: fixture.controlStore,
      blobs: fixture.blobs,
      launchReviewer() { throw new Error("neutral prompt must not launch"); },
      writeResponse: async (response) => {
        retryWriterCalls += 1;
        return response;
      },
      now: () => new Date(PROMPT_CUTOFF)
    });
    const upgraded = fixture.controlStore.database.prepare("SELECT * FROM reflection_emissions").get();
    assert.equal(retryWriterCalls, 1, "selected-only state must permit another host-write attempt");
    assert.equal(upgraded.id, row.id);
    assert.equal(upgraded.outcome, "emitted");
    assert.equal(upgraded.emitted_at, PROMPT_CUTOFF);
    assert.deepEqual(retry.hostResponse, retry.nativeResponse);
    fixture.controlStore.close();
  });

  it("successful host write records emitted only after the writer resolves", async () => {
    const fixture = await promptOrchestrationFixture();
    const { projectDir } = await publishSelectableReflection(fixture, {
      reflection_id: "reflection-000000000000000000000012",
      source_identity_hash: "12".padStart(64, "0")
    });
    let writerCalls = 0;
    const result = await cliModule.handlePromptHook({
      payload: explicitFeedbackPayload({
        session_id: "selection-write-success",
        context_epoch: 4,
        task_fingerprint: "task-write-success",
        cwd: projectDir,
        prompt: "修改已有架构前先核对用户目标",
        previous_assistant_message: undefined
      }),
      cli: "codex",
      controlStore: fixture.controlStore,
      blobs: fixture.blobs,
      launchReviewer() { throw new Error("neutral prompt must not launch"); },
      writeResponse: async (response) => {
        writerCalls += 1;
        const rowDuringWrite = fixture.controlStore.database.prepare("SELECT * FROM reflection_emissions").get();
        assert.equal(rowDuringWrite.outcome, "selected");
        assert.equal(rowDuringWrite.emitted_at, null);
        return response;
      },
      now: () => new Date(PROMPT_CUTOFF)
    });

    const row = fixture.controlStore.database.prepare("SELECT * FROM reflection_emissions").get();
    assert.equal(writerCalls, 1);
    assert.equal(row.outcome, "emitted");
    assert.equal(row.emitted_at, PROMPT_CUTOFF);
    assert.deepEqual(result.hostResponse, result.nativeResponse);
    assert.equal(fixture.controlStore.listPriorReflectionEmissions({
      sessionUid: "codex:default:selection-write-success",
      contextEpoch: 4,
      taskFingerprint: "task-write-success"
    }).length, 1);

    const replay = await cliModule.handlePromptHook({
      payload: explicitFeedbackPayload({
        session_id: "selection-write-success",
        context_epoch: 4,
        task_fingerprint: "task-write-success",
        cwd: projectDir,
        prompt: "修改已有架构前先核对用户目标",
        previous_assistant_message: undefined
      }),
      cli: "codex",
      controlStore: fixture.controlStore,
      blobs: fixture.blobs,
      launchReviewer() { throw new Error("neutral prompt must not launch"); },
      writeResponse: async (response) => {
        writerCalls += 1;
        return response;
      },
      now: () => new Date(PROMPT_CUTOFF)
    });
    assert.equal(writerCalls, 2);
    assert.equal(replay.selection.selectedCount, 0, "only a prior emitted row suppresses the exact tuple");
    assert.equal(
      fixture.controlStore.database.prepare("SELECT COUNT(*) AS count FROM reflection_emissions").get().count,
      1
    );
    fixture.controlStore.close();
  });

  it("selection ledger failures preserve already-built safe guidance", async () => {
    for (const failedMethod of ["listPriorReflectionEmissions", "recordReflectionSelected"]) {
      const fixture = await promptOrchestrationFixture();
      const { projectDir } = await publishSelectableReflection(fixture);
      let failedCalls = 0;
      let writerCalls = 0;
      const store = new Proxy(fixture.controlStore, {
        get(target, property, receiver) {
          if (property === failedMethod) {
            return () => {
              failedCalls += 1;
              throw Object.assign(new Error("body-must-remain-opaque"), { code: "ledger_unavailable" });
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });

      const result = await cliModule.handlePromptHook({
        payload: explicitFeedbackPayload({
          session_id: `selection-ledger-${failedMethod}`,
          task_fingerprint: `task-${failedMethod}`,
          cwd: projectDir,
          prompt: "修改已有架构前先核对用户目标",
          previous_assistant_message: undefined
        }),
        cli: "codex",
        controlStore: store,
        blobs: fixture.blobs,
        launchReviewer() { throw new Error("neutral prompt must not launch"); },
        writeResponse: async (response) => {
          writerCalls += 1;
          assert.match(response.hookSpecificOutput.additionalContext, /document_hash: [a-f0-9]{64}/u);
          return response;
        },
        now: () => new Date(PROMPT_CUTOFF)
      });

      assert.equal(failedCalls, 1);
      assert.equal(writerCalls, 1);
      assert.match(result.guidance, /method_changes:/u);
      fixture.controlStore.close();
    }
  });

  it("emission record failure never retries the successful host writer", async () => {
    const fixture = await promptOrchestrationFixture();
    const { projectDir } = await publishSelectableReflection(fixture);
    let markCalls = 0;
    let writerCalls = 0;
    const store = new Proxy(fixture.controlStore, {
      get(target, property, receiver) {
        if (property === "markReflectionEmitted") {
          return () => {
            markCalls += 1;
            throw Object.assign(new Error("body-must-remain-opaque"), { code: "ledger_unavailable" });
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });

    const result = await cliModule.handlePromptHook({
      payload: explicitFeedbackPayload({
        session_id: "emission-record-failure",
        task_fingerprint: "task-emission-record-failure",
        cwd: projectDir,
        prompt: "修改已有架构前先核对用户目标",
        previous_assistant_message: undefined
      }),
      cli: "codex",
      controlStore: store,
      blobs: fixture.blobs,
      launchReviewer() { throw new Error("neutral prompt must not launch"); },
      writeResponse: async (response) => {
        writerCalls += 1;
        return response;
      },
      now: () => new Date(PROMPT_CUTOFF)
    });

    const row = fixture.controlStore.database.prepare("SELECT * FROM reflection_emissions").get();
    assert.equal(writerCalls, 1);
    assert.equal(markCalls, 1);
    assert.deepEqual(result.hostResponse, result.nativeResponse);
    assert.equal(row.outcome, "selected", "audit failure must underclaim delivery");
    assert.equal(row.emitted_at, null);
    fixture.controlStore.close();
  });

  it("same complaint in another session starts another review", async () => {
    const fixture = await promptOrchestrationFixture();
    const launches = [];
    const invoke = (payload) => cliModule.handlePromptHook({
      payload,
      cli: "codex",
      controlStore: fixture.controlStore,
      blobs: fixture.blobs,
      launchReviewer(jobId, launchEpoch) { launches.push([jobId, launchEpoch]); },
      writeResponse: async () => ({ continue: true }),
      now: () => new Date(PROMPT_CUTOFF)
    });

    await invoke(explicitFeedbackPayload());
    await invoke(explicitFeedbackPayload({
      session_id: "feedback-session-2",
      event_id: "feedback-event-2",
      turn_id: "feedback-turn-4",
      previous_assistant_message: {
        role: "assistant",
        id: "assistant-event-2",
        turn_id: "feedback-turn-3",
        timestamp: "2026-07-20T07:59:58.000Z",
        content: [{ type: "output_text", text: "I changed the design before confirming the simpler boundary." }]
      }
    }));

    assert.equal(reviewJobCount(fixture.controlStore), 2);
    assert.equal(launches.length, 2);
    assert.notEqual(launches[0][0], launches[1][0]);
    fixture.controlStore.close();
  });

  it("prompt failures remain host-pass", async () => {
    const ordinary = await promptOrchestrationFixture();
    let ordinaryResponses = 0;
    const ordinaryResult = await cliModule.handlePromptHook({
      payload: explicitFeedbackPayload({ prompt: "reviewer job 是干嘛的？" }),
      cli: "codex",
      controlStore: ordinary.controlStore,
      blobs: ordinary.blobs,
      launchReviewer() { throw new Error("ordinary prompt must not launch"); },
      writeResponse: async () => { ordinaryResponses += 1; return { continue: true }; },
      now: () => new Date(PROMPT_CUTOFF)
    });
    assert.equal(reviewJobCount(ordinary.controlStore), 0);
    assert.equal(capturedEventCount(ordinary.controlStore), 0);
    assert.equal(ordinaryResponses, 1);
    assert.equal(ordinaryResult.operationalText, null);
    ordinary.controlStore.close();

    const failedCapture = await promptOrchestrationFixture();
    let captureFailureResponses = 0;
    const captureFailureResult = await cliModule.handlePromptHook({
      payload: explicitFeedbackPayload(),
      cli: "codex",
      controlStore: failedCapture.controlStore,
      blobs: { async write() { throw new Error("fixture_blob_failure"); } },
      launchReviewer() { throw new Error("capture failure must not launch"); },
      writeResponse: async () => { captureFailureResponses += 1; return { continue: true }; },
      now: () => new Date(PROMPT_CUTOFF)
    });
    assert.equal(reviewJobCount(failedCapture.controlStore), 0);
    assert.equal(capturedEventCount(failedCapture.controlStore), 0);
    assert.equal(captureFailureResponses, 1);
    assert.equal(captureFailureResult.operationalText, null);
    failedCapture.controlStore.close();

    const failedStore = await promptOrchestrationFixture();
    let storeFailureResponses = 0;
    const storeProxy = new Proxy(failedStore.controlStore, {
      get(target, property, receiver) {
        if (property === "createReviewCandidate") return () => { throw new Error("fixture_store_failure"); };
        return Reflect.get(target, property, receiver);
      }
    });
    const storeFailureResult = await cliModule.handlePromptHook({
      payload: explicitFeedbackPayload(),
      cli: "codex",
      controlStore: storeProxy,
      blobs: failedStore.blobs,
      launchReviewer() { throw new Error("store failure must not launch"); },
      writeResponse: async () => { storeFailureResponses += 1; return { continue: true }; },
      now: () => new Date(PROMPT_CUTOFF)
    });
    assert.equal(reviewJobCount(failedStore.controlStore), 0);
    assert.equal(capturedEventCount(failedStore.controlStore), 2);
    assert.equal(storeFailureResponses, 1);
    assert.equal(storeFailureResult.operationalText, null);
    failedStore.controlStore.close();

    const failedLaunch = await promptOrchestrationFixture();
    let launchFailureResponses = 0;
    const launchFailureResult = await cliModule.handlePromptHook({
      payload: explicitFeedbackPayload(),
      cli: "codex",
      controlStore: failedLaunch.controlStore,
      blobs: failedLaunch.blobs,
      launchReviewer() { throw new Error("fixture_launch_failure"); },
      writeResponse: async () => { launchFailureResponses += 1; return { continue: true }; },
      now: () => new Date(PROMPT_CUTOFF)
    });
    assert.equal(reviewJobCount(failedLaunch.controlStore), 1);
    const failedLaunchJob = failedLaunch.controlStore.database.prepare("SELECT * FROM reviewer_jobs").get();
    assert.equal(failedLaunchJob.next_launch_at, null);
    assert.equal(failedLaunchJob.error_code, "spawn_failed");
    assert.equal(launchFailureResponses, 1);
    assert.equal(launchFailureResult.operationalText, null);
    failedLaunch.controlStore.close();

    const failedSelection = await promptOrchestrationFixture();
    let selectionFailureResponses = 0;
    const selectionFailureResult = await cliModule.handlePromptHook({
      payload: explicitFeedbackPayload({ prompt: "按推荐执行" }),
      cli: "codex",
      controlStore: failedSelection.controlStore,
      loadDocuments() { throw Object.assign(new Error("fixture_selection_failure"), { code: "catalog_failed" }); },
      blobs: failedSelection.blobs,
      launchReviewer() { throw new Error("ordinary prompt must not launch"); },
      writeResponse: async () => { selectionFailureResponses += 1; return { continue: true }; },
      now: () => new Date(PROMPT_CUTOFF)
    });
    assert.equal(reviewJobCount(failedSelection.controlStore), 0);
    assert.equal(selectionFailureResponses, 1);
    assert.equal(selectionFailureResult.operationalText, null);
    failedSelection.controlStore.close();
  });

  it("prompt hook never awaits launcher completion", async () => {
    const fixture = await promptOrchestrationFixture();
    const never = new Promise(() => {});
    let timer;
    const response = await Promise.race([
      cliModule.handlePromptHook({
        payload: explicitFeedbackPayload(),
        cli: "codex",
        controlStore: fixture.controlStore,
        blobs: fixture.blobs,
        launchReviewer: () => never,
        writeResponse: async () => ({ continue: true }),
        now: () => new Date(PROMPT_CUTOFF)
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("prompt hook awaited launcher completion")), 1_000);
      })
    ]);
    clearTimeout(timer);

    assert.equal(reviewJobCount(fixture.controlStore), 1);
    assert.equal(response.operationalText, null);
    fixture.controlStore.close();
  });

  it("a neutral prompt synchronously recovers at most one older due review without awaiting it", async () => {
    const fixture = await promptOrchestrationFixture();
    await cliModule.handlePromptHook({
      payload: explicitFeedbackPayload(),
      cli: "codex",
      controlStore: fixture.controlStore,
      blobs: fixture.blobs,
      launchReviewer: () => ({ attempted: false, reason: "spawn_failed" }),
      writeResponse: async () => ({ continue: true }),
      now: () => new Date(PROMPT_CUTOFF)
    });
    const due = fixture.controlStore.database.prepare("SELECT * FROM reviewer_jobs").get();
    const launches = [];
    let recoveries = 0;

    const response = await cliModule.handlePromptHook({
      payload: explicitFeedbackPayload({
        session_id: "neutral-session",
        event_id: "neutral-event",
        turn_id: "neutral-turn",
        prompt: "Please explain what this command does.",
        previous_assistant_message: undefined
      }),
      cli: "codex",
      controlStore: fixture.controlStore,
      blobs: fixture.blobs,
      launchReviewer: () => { throw new Error("neutral prompt must not create a new review"); },
      recoverReviewers() {
        recoveries += 1;
        return recoverDueReviewers({
          store: fixture.controlStore,
          limit: 1,
          launchReviewer(jobId, launchEpoch) {
            launches.push([jobId, launchEpoch]);
            return { attempted: true, reason: "spawn_attempted" };
          }
        });
      },
      writeResponse: async () => ({ continue: true }),
      now: () => new Date(PROMPT_CUTOFF)
    });

    assert.equal(response.candidate, false);
    assert.equal(recoveries, 1);
    assert.deepEqual(launches, [[due.job_id, 2]]);
    assert.equal(reviewJobCount(fixture.controlStore), 1);
    fixture.controlStore.close();
  });

  it("unstable prompt identity creates no evidence or job", async () => {
    const fixture = await promptOrchestrationFixture();
    let launches = 0;
    const payload = explicitFeedbackPayload({
      session_id: undefined,
      event_id: "native-but-unscoped-feedback",
      turn_id: undefined,
      previous_assistant_message: {
        role: "assistant",
        id: "unstable-referent",
        content: [{ type: "output_text", text: "I changed the design too early." }]
      }
    });
    delete payload.session_id;
    delete payload.turn_id;

    const response = await cliModule.handlePromptHook({
      payload,
      cli: "codex",
      controlStore: fixture.controlStore,
      blobs: fixture.blobs,
      launchReviewer() { launches += 1; },
      writeResponse: async () => ({ continue: true }),
      now: () => new Date(PROMPT_CUTOFF)
    });

    assert.equal(capturedEventCount(fixture.controlStore), 0);
    assert.equal(reviewJobCount(fixture.controlStore), 0);
    assert.equal(launches, 0);
    assert.equal(response.reason, "identity_unstable");
    fixture.controlStore.close();
  });

  it("trusted structural feedback without a referent creates a source-only job", async () => {
    const fixture = await promptOrchestrationFixture();
    const launches = [];
    const payload = {
      session_id: "structural-session",
      event_id: "structural-feedback-1",
      turn_id: "structural-turn-1",
      cwd: "/tmp/afl-task-5-project",
      timestamp: "2026-07-20T07:59:59.000Z",
      prompt: "停止刚才的等待，直接处理当前问题。",
      active_turn_steering: true
    };

    await cliModule.handlePromptHook({
      payload,
      cli: "codex",
      controlStore: fixture.controlStore,
      blobs: fixture.blobs,
      launchReviewer(jobId, launchEpoch) { launches.push([jobId, launchEpoch]); },
      writeResponse: async () => ({ continue: true }),
      now: () => new Date(PROMPT_CUTOFF)
    });

    const job = fixture.controlStore.database.prepare("SELECT * FROM reviewer_jobs").get();
    assert.equal(capturedEventCount(fixture.controlStore), 1);
    assert.equal(job.referent_event_uid, null);
    assert.deepEqual(launches, [[job.job_id, 1]]);
    fixture.controlStore.close();
  });

  it("retrospective text without a referent creates no evidence or job", async () => {
    const fixture = await promptOrchestrationFixture();
    let launches = 0;
    await cliModule.handlePromptHook({
      payload: {
        session_id: "no-referent-session",
        event_id: "no-referent-feedback",
        turn_id: "no-referent-turn",
        cwd: "/tmp/afl-task-5-project",
        timestamp: "2026-07-20T07:59:59.000Z",
        prompt: EXPLICIT_FEEDBACK
      },
      cli: "codex",
      controlStore: fixture.controlStore,
      blobs: fixture.blobs,
      launchReviewer() { launches += 1; },
      writeResponse: async () => ({ continue: true }),
      now: () => new Date(PROMPT_CUTOFF)
    });

    assert.equal(capturedEventCount(fixture.controlStore), 0);
    assert.equal(reviewJobCount(fixture.controlStore), 0);
    assert.equal(launches, 0);
    fixture.controlStore.close();
  });

  it("synchronizes Codex trust for only the generated prompt command", async () => {
    const home = await tempHome();
    const calls = [];
    const codexHost = {
      async synchronize(input) {
        calls.push(input);
        return { available: true, configured: true, runnable: true, status: "trusted", prompt: { trustStatus: "trusted", enabled: true } };
      }
    };

    const result = await install({ home, cwd: home, codexHost });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].home, home);
    assert.match(calls[0].promptCommand, /core-hook\.sh/);
    assert.equal("backstopCommand" in calls[0], false);
    assert.ok(result.actions.some((action) => /prompt hook verified/i.test(action)));
    assert.equal(result.actions.some((action) => /reconcil|scheduler|backstop/i.test(action)), false);
  });

  it("doctor reports the prompt pipeline and bounded convergence capability families separately", async () => {
    const home = await tempHome();
    await install({ home, codexHost: unavailableCodexHost() });
    const codexHost = {
      async inspect() {
        return {
          available: true,
          configured: true,
          runnable: false,
          status: "modified",
          prompt: { found: true, trustStatus: "modified", enabled: true, runnable: false }
        };
      }
    };
    const reviewerDetector = async () => ({
      codex: { cli: "codex", available: true, executable: "/opt/codex" },
      claude: { cli: "claude", available: false, executable: null },
      gemini: { cli: "gemini", available: false, executable: null }
    });

    const health = await doctor({ home, cwd: home, codexHost, reviewerDetector });

    assert.deepEqual(Object.keys(health).sort(), ["status", "version"]);
    assert.deepEqual(Object.keys(health.status).sort(), [
      "controlStore",
      "convergence",
      "legacyStopRemoved",
      "promptHook",
      "ready",
      "reflectionDirectory",
      "reviewerProvider"
    ]);
    assert.equal(health.status.promptHook.configured, true);
    assert.equal(health.status.promptHook.runnable, false);
    assert.equal(health.status.controlStore.exists, true);
    assert.equal(health.status.convergence.codePackage.available, true);
    assert.equal(health.status.convergence.installedRuntime.probe.provider.available, true);
    assert.equal(health.status.convergence.adapters.generic.capability, "audit_only");
    assert.equal(health.status.convergence.adapters.openspec.capability, "checkpoint_gate");
    assert.equal(health.status.convergence.adapters.sdd.capability, "workflow_gate");
    assert.equal(health.status.convergence.repositoryAuthority.status, "unknown");
    assert.equal(health.status.convergence.repositoryAuthority.checked, false);
    assert.equal(health.status.legacyStopRemoved, true);
    assert.equal(health.status.ready, false);
    assert.doesNotMatch(JSON.stringify(health), /scheduler|notification|maintenance|receipt/ui);
  });

  it("doctor ready gates every runtime dependency", async () => {
    const codexHost = {
      async inspect() {
        return {
          available: true,
          configured: true,
          runnable: true,
          status: "trusted",
          prompt: { found: true, trustStatus: "trusted", enabled: true, runnable: true }
        };
      }
    };
    const reviewerDetector = async () => ({
      codex: { cli: "codex", available: true, executable: "/opt/codex" },
      claude: { cli: "claude", available: false, executable: null },
      gemini: { cli: "gemini", available: false, executable: null }
    });
    const setup = async () => {
      const home = await tempHome();
      const paths = pathsFor(home);
      await install({ home, codexHost: unavailableCodexHost() });
      await mkdir(path.join(home, ".agent", "reflections"), { recursive: true, mode: 0o700 });
      return { home, paths };
    };
    const inspect = (home) => doctor({ home, cwd: home, codexHost, reviewerDetector });

    const healthy = await setup();
    const baseline = await inspect(healthy.home);
    assert.equal(baseline.status.controlStore.available, true);
    assert.equal(baseline.status.reflectionDirectory.available, true);
    assert.equal(baseline.status.ready, true);

    const missingStore = await setup();
    await rm(missingStore.paths.controlDatabase);
    const storeStatus = await inspect(missingStore.home);
    assert.equal(storeStatus.status.controlStore.available, false);
    assert.equal(storeStatus.status.ready, false);

    const unusableStore = await setup();
    await rm(unusableStore.paths.controlDatabase);
    await writeFile(unusableStore.paths.controlDatabase, "not a control database", "utf8");
    const unusableStoreStatus = await inspect(unusableStore.home);
    assert.equal(unusableStoreStatus.status.controlStore.exists, true);
    assert.equal(unusableStoreStatus.status.controlStore.available, false);
    assert.equal(unusableStoreStatus.status.ready, false);

    const missingReflection = await setup();
    await rm(path.join(missingReflection.home, ".agent", "reflections"), { recursive: true });
    const reflectionStatus = await inspect(missingReflection.home);
    assert.equal(reflectionStatus.status.reflectionDirectory.available, false);
    assert.equal(reflectionStatus.status.ready, false);

    const unusableReflection = await setup();
    const reflectionPath = path.join(unusableReflection.home, ".agent", "reflections");
    await rm(reflectionPath, { recursive: true });
    await writeFile(reflectionPath, "not a reflection directory", "utf8");
    const unusableReflectionStatus = await inspect(unusableReflection.home);
    assert.equal(unusableReflectionStatus.status.reflectionDirectory.available, false);
    assert.equal(unusableReflectionStatus.status.ready, false);

    const legacyStop = await setup();
    await writeFile(legacyStop.paths.codexConfig, `${await readFile(legacyStop.paths.codexConfig, "utf8")}\ncommand = "${path.join(legacyStop.paths.packRoot, "hooks", "stop-hook.sh")}"\n`, "utf8");
    const legacyStatus = await inspect(legacyStop.home);
    assert.equal(legacyStatus.status.legacyStopRemoved, false);
    assert.equal(legacyStatus.status.ready, false);
  });

  it("structured logs never contain content", () => {
    const emitted = [];
    const writer = (line) => emitted.push(line);
    cliModule.structuredLog("prompt_capture_completed", {
      reason: "secret-user-text",
      document: "full-review-body",
      job: "a5e1767b-5b8f-4ef5-9b2a-f2d620a7d526",
      family: "family-method-boundary",
      count: 2,
      ignored: "method-body"
    }, writer);
    cliModule.structuredLog("not_an_event", { reason: "secret-user-text" }, writer);

    assert.equal(emitted.length, 1);
    assert.doesNotMatch(emitted[0], /secret-user-text|full-review-body|method-body/u);
    const event = JSON.parse(emitted[0]);
    assert.equal(event.event, "prompt_capture_completed");
    assert.equal(event.reason, "invalid_reason_code");
    assert.match(event.document, /^[a-f0-9]{64}$/u);
    assert.equal(event.family, createHash("sha256").update("family-method-boundary", "utf8").digest("hex"));
    assert.deepEqual(Object.keys(event).sort(), ["count", "document", "event", "family", "job", "reason"]);

    const content = "secret-user-text/full-review-body/token/path";
    const stringCases = [
      ["job", content, (entry) => assert.equal("job" in entry, false)],
      ["family", content, (entry) => assert.equal(entry.family, createHash("sha256").update(content, "utf8").digest("hex"))],
      ["document", content, (entry) => assert.equal(entry.document, createHash("sha256").update(content, "utf8").digest("hex"))],
      ["reason", content, (entry) => assert.equal(entry.reason, "invalid_reason_code")],
      ["result", content, (entry) => assert.equal(entry.result, "invalid_result_code")]
    ];
    for (const [key, value, check] of stringCases) {
      const lines = [];
      cliModule.structuredLog("reflection_selected", { [key]: value }, (line) => lines.push(line));
      assert.equal(lines.length, 1);
      assert.doesNotMatch(lines[0], /secret-user-text|full-review-body|token\/path/u);
      check(JSON.parse(lines[0]));
    }
    const invalidEvent = [];
    assert.equal(cliModule.structuredLog(content, {}, (line) => invalidEvent.push(line)), false);
    assert.deepEqual(invalidEvent, []);

    const terminal = [];
    cliModule.reviewerTerminalLog({
      outcome: "failed",
      job: "a5e1767b-5b8f-4ef5-9b2a-f2d620a7d526",
      reason: "provider_timeout",
      durationMs: 7,
      writer: (line) => terminal.push(line)
    });
    assert.deepEqual(JSON.parse(terminal[0]), {
      event: "review_failed",
      job: "a5e1767b-5b8f-4ef5-9b2a-f2d620a7d526",
      reason: "provider_timeout",
      result: "failed",
      duration_ms: 7
    });
  });

  it("launcher diagnostics distinguish attempted and synchronous failed spawn", async () => {
    const originalWrite = process.stderr.write;
    const originalDebug = process.env.AGENT_FEEDBACK_LOOP_DEBUG;
    process.env.AGENT_FEEDBACK_LOOP_DEBUG = "1";
    const lines = [];
    process.stderr.write = (line) => { lines.push(String(line)); return true; };
    try {
      for (const scenario of [
        { attempted: true, reason: "spawn_attempted", expectedReason: "launch_reserved", expectedResult: "attempted" },
        { attempted: false, reason: "spawn_failed", expectedReason: "spawn_failed", expectedResult: "failed" },
        { attempted: false, reason: "unsupported_platform", expectedReason: "unsupported_platform", expectedResult: "failed" }
      ]) {
        const fixture = await promptOrchestrationFixture();
        try {
          const result = await cliModule.handlePromptHook({
            payload: explicitFeedbackPayload({ event_id: `feedback-${scenario.reason}` }),
            cli: "codex",
            controlStore: fixture.controlStore,
            blobs: fixture.blobs,
            launchReviewer() { return { attempted: scenario.attempted, reason: scenario.reason }; },
            writeResponse: async () => ({ continue: true }),
            now: () => new Date(PROMPT_CUTOFF)
          });
          assert.equal(result.launchRequested, scenario.attempted);
          assert.equal(result.reason, scenario.expectedReason);
          const spawn = lines.map((line) => JSON.parse(line)).filter((event) => event.event === "review_spawn_attempted").at(-1);
          assert.equal(spawn.result, scenario.expectedResult);
          if (scenario.attempted) assert.equal("reason" in spawn, false);
          else assert.equal(spawn.reason, scenario.expectedReason);
        } finally {
          fixture.controlStore.close();
        }
      }
    } finally {
      process.stderr.write = originalWrite;
      if (originalDebug === undefined) delete process.env.AGENT_FEEDBACK_LOOP_DEBUG;
      else process.env.AGENT_FEEDBACK_LOOP_DEBUG = originalDebug;
    }
  });

  it("debug feedback evaluation emits normal bounded evidence", async () => {
    const fixture = await promptOrchestrationFixture();
    const lines = [];
    const originalWrite = process.stderr.write;
    const originalDebug = process.env.AGENT_FEEDBACK_LOOP_DEBUG;
    process.env.AGENT_FEEDBACK_LOOP_DEBUG = "1";
    process.stderr.write = (line) => { lines.push(String(line)); return true; };
    try {
      await cliModule.handlePromptHook({
        payload: explicitFeedbackPayload(),
        cli: "codex",
        controlStore: fixture.controlStore,
        blobs: fixture.blobs,
        launchReviewer() { return { attempted: true }; },
        writeResponse: async () => ({ continue: true }),
        now: () => new Date(PROMPT_CUTOFF)
      });
    } finally {
      process.stderr.write = originalWrite;
      if (originalDebug === undefined) delete process.env.AGENT_FEEDBACK_LOOP_DEBUG;
      else process.env.AGENT_FEEDBACK_LOOP_DEBUG = originalDebug;
      fixture.controlStore.close();
    }
    const events = lines.map((line) => JSON.parse(line));
    assert.equal(events.some((event) => event.event === "feedback_signal_evaluated" && event.reason === "candidate"), true);
    assert.doesNotMatch(lines.join(""), /private|secret-user-text|full-review-body/u);
  });

  it("installs prompt-only host config and uninstalls only AFL entries", async () => {
    const home = await tempHome();
    const paths = pathsFor(home);
    await install({ home, codexHost: unavailableCodexHost() });

    const codex = await readFile(paths.codexConfig, "utf8");
    const claude = JSON.parse(await readFile(paths.claudeSettings, "utf8"));
    const gemini = JSON.parse(await readFile(paths.geminiSettings, "utf8"));
    assert.match(codex, /\[\[hooks\.UserPromptSubmit\]\]/);
    assert.doesNotMatch(codex, /\[\[hooks\.Stop\]\]|stop-hook\.sh/);
    assert.equal(claude.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks).some((hook) => hook.command?.includes("core-hook.sh") && hook.timeout === 5), true);
    assert.equal(claude.hooks.Stop?.some((entry) => entry.hooks?.some((hook) => hook.command?.includes("feedback-loop"))) ?? false, false);
    assert.equal(gemini.hooks.BeforeAgent.flatMap((entry) => entry.hooks).some((hook) => hook.command?.includes("core-hook.sh") && hook.timeout === 5000), true);
    assert.equal(gemini.hooks.AfterAgent?.some((entry) => entry.hooks?.some((hook) => hook.command?.includes("feedback-loop"))) ?? false, false);
    assert.equal((await stat(paths.coreHook)).mode & 0o111, 0o111);

    await uninstall({ home, removeFiles: false });
    assert.doesNotMatch(await readFile(paths.codexConfig, "utf8"), /agent-feedback-loop:start|core-hook\.sh/);
    const claudeAfter = JSON.parse(await readFile(paths.claudeSettings, "utf8"));
    const geminiAfter = JSON.parse(await readFile(paths.geminiSettings, "utf8"));
    assert.equal(claudeAfter.hooks.UserPromptSubmit?.some((entry) => entry.hooks?.some((hook) => hook.command?.includes("core-hook.sh"))) ?? false, false);
    assert.equal(geminiAfter.hooks.BeforeAgent?.some((entry) => entry.hooks?.some((hook) => hook.command?.includes("core-hook.sh"))) ?? false, false);
  });

  it("upgrade removes only managed AFL handlers from mixed Codex parents", async () => {
    for (const operation of ["install", "uninstall"]) {
      const home = await tempHome();
      const paths = pathsFor(home);
      await mkdir(path.dirname(paths.codexConfig), { recursive: true });
      await writeFile(paths.codexConfig, mixedCodexConfig(home), "utf8");

      if (operation === "install") await install({ home, codexHost: unavailableCodexHost() });
      else await uninstall({ home, removeFiles: false });

      const codex = await readFile(paths.codexConfig, "utf8");
      assert.match(codex, /matcher = "marked-stop-parent"/);
      assert.match(codex, /matcher = "unmarked-prompt-parent"/);
      assert.equal((codex.match(/options = \{ source = "user" \}/g) || []).length, 2);
      assert.match(codex, /command = "\/opt\/user\/keep-stop\.sh"/);
      assert.match(codex, /command = "\/opt\/user\/keep-prompt\.sh"/);
      assert.match(codex, /unrelated_value = "keep-root"/);
      assert.match(codex, /\[unrelated\]\s+value = "keep-table"/);
      assert.doesNotMatch(codex, /^\s*(?:command|prompt)\s*=.*(?:stop-hook\.sh|codex-hook\.sh|--legacy-core|prompts\/reflection-agent\.md)/gm);
      assert.match(codex, /# migration note:.*stop-hook\.sh/);
      if (operation === "install") {
        assert.equal((codex.match(/agent-feedback-loop:start/g) || []).length, 1);
        assert.equal((codex.match(/agent-feedback-loop:end/g) || []).length, 1);
      } else {
        assert.doesNotMatch(codex, /agent-feedback-loop:(?:start|end)/);
      }
    }
  });

  it("upgrade and uninstall remove the legacy LaunchAgent with bounded fake bootout", async () => {
    const label = "io.github.super3ben.agent-feedback-loop.reconcile";
    for (const operation of ["install", "uninstall"]) {
      const home = await tempHome();
      const plistFile = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
      await mkdir(path.dirname(plistFile), { recursive: true });
      await writeFile(plistFile, "legacy-scheduler-sentinel\n", "utf8");
      const calls = [];
      const legacySchedulerHost = { async bootout(input) { calls.push(input); throw new Error("already unloaded"); } };

      if (operation === "install") {
        await install({
          home,
          platform: "darwin",
          activateLegacySchedulerCleanup: true,
          legacySchedulerHost,
          codexHost: unavailableCodexHost()
        });
      } else {
        await uninstall({
          home,
          platform: "darwin",
          activateLegacySchedulerCleanup: true,
          legacySchedulerHost,
          removeFiles: false
        });
      }

      await assert.rejects(stat(plistFile));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].label, label);
    }

    const dryRunHome = await tempHome();
    const dryRunPlist = path.join(dryRunHome, "Library", "LaunchAgents", `${label}.plist`);
    await mkdir(path.dirname(dryRunPlist), { recursive: true });
    await writeFile(dryRunPlist, "dry-run-sentinel\n", "utf8");
    const dryRunCalls = [];
    await install({
      home: dryRunHome,
      dryRun: true,
      platform: "darwin",
      activateLegacySchedulerCleanup: true,
      legacySchedulerHost: { async bootout(input) { dryRunCalls.push(input); } }
    });
    assert.equal(await readFile(dryRunPlist, "utf8"), "dry-run-sentinel\n");
    assert.equal(dryRunCalls.length, 0);
  });

  it("install removes obsolete hook files left by an older runtime", async () => {
    const home = await tempHome();
    const paths = pathsFor(home);
    await install({ home, codexHost: unavailableCodexHost() });
    const hookDir = path.join(paths.packRoot, "hooks");
    const obsolete = ["codex-hook.sh", "claude-hook.sh", "stop-hook.sh", "trigger-rules.sh"].map((name) => path.join(hookDir, name));
    for (const file of obsolete) await writeFile(file, "#!/bin/sh\n", "utf8");

    await install({ home, codexHost: unavailableCodexHost() });

    for (const file of obsolete) await assert.rejects(stat(file));
    assert.equal((await stat(paths.coreHook)).mode & 0o111, 0o111);
  });

  it("core hook preserves native response schemas and emits no diagnostics", async () => {
    const home = await tempHome();
    await install({ home, codexHost: unavailableCodexHost() });
    const env = { ...process.env, HOME: home, TMPDIR: home };
    const payload = JSON.stringify({ session_id: "prompt-only", prompt: "continue" });

    const codex = await runWithInput(pathsFor(home).coreHook, payload, env, ["--event", "UserPromptSubmit", "--cli", "codex", "--continue"]);
    const claude = await runWithInput(pathsFor(home).coreHook, payload, env, ["--event", "UserPromptSubmit", "--cli", "claude"]);
    const gemini = await runWithInput(pathsFor(home).coreHook, payload, env, ["--event", "BeforeAgent", "--cli", "gemini"]);
    assert.deepEqual(JSON.parse(codex.stdout), { continue: true });
    assert.deepEqual(JSON.parse(claude.stdout), {});
    assert.deepEqual(JSON.parse(gemini.stdout), {});
    assert.equal(`${codex.stderr}${claude.stderr}${gemini.stderr}`, "");
  });

  it("dry-run install reports actions without writing files", async () => {
    const home = await tempHome();
    const result = await install({ home, dryRun: true });
    assert.equal(result.dryRun, true);
    await assert.rejects(stat(path.join(home, ".agent", "feedback-loop")));
  });

  it("legacy-export emits only bounded opaque results and dry-run creates no output", async () => {
    const fixture = await legacyCliFixture();
    try {
      const env = { ...process.env, HOME: fixture.root, TMPDIR: fixture.root };
      const dryRun = await execFileAsync(BIN, [
        "legacy-export",
        "--source-db", fixture.sourceDb,
        "--output-dir", fixture.outputDir,
        "--dry-run"
      ], { env });
      const dryOutput = JSON.parse(dryRun.stdout);
      assert.equal(dryOutput.status, "dry_run");
      assert.deepEqual(dryOutput.counts, {
        planned: 1, written: 0, skipped: 0, incomplete: 0, conflicts: 0
      });
      assert.deepEqual(dryOutput.items.map((item) => item.status), ["planned"]);
      assert.ok(dryOutput.items.every((item) => /^legacy-[a-f0-9]{64}$/u.test(item.id)));
      assert.equal(dryRun.stderr, "");
      await assert.rejects(stat(fixture.outputDir));

      const applied = await execFileAsync(BIN, [
        "legacy-export",
        "--source-db", fixture.sourceDb,
        "--output-dir", fixture.outputDir,
        "--apply"
      ], { env });
      const appliedOutput = JSON.parse(applied.stdout);
      assert.equal(appliedOutput.status, "applied");
      assert.deepEqual(appliedOutput.counts, {
        planned: 1, written: 1, skipped: 0, incomplete: 0, conflicts: 0
      });
      assert.equal(applied.stderr, "");

      for (const visible of [dryRun.stdout, applied.stdout]) {
        assert.doesNotMatch(visible, /cli-raw-|private|legacy\.sqlite3|afl-legacy-cli/u);
        assert.doesNotMatch(visible, /report|quote|completion/u);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("legacy-export strictly rejects duplicate, unknown, missing, and ambiguous arguments", async () => {
    const fixture = await legacyCliFixture();
    try {
      const env = { ...process.env, HOME: fixture.root, TMPDIR: fixture.root };
      const base = ["legacy-export", "--source-db", fixture.sourceDb, "--output-dir", fixture.outputDir];
      const invalid = [
        [...base, "--source-db", fixture.sourceDb, "--dry-run"],
        [...base, "--output-dir", fixture.outputDir, "--dry-run"],
        [...base, "--unknown", "value", "--dry-run"],
        ["legacy-export", "--source-db", "--output-dir", fixture.outputDir, "--dry-run"],
        [...base],
        [...base, "--dry-run", "--apply"]
      ];
      for (const args of invalid) {
        await assert.rejects(
          execFileAsync(BIN, args, { env }),
          (error) => {
            assert.equal(error.code, 1);
            assert.match(String(error.stderr), /legacy_export_invalid_arguments/u);
            assert.doesNotMatch(String(error.stderr), /private|cli-raw-/u);
            return true;
          }
        );
      }
      await assert.rejects(stat(fixture.outputDir));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("legacy-export apply refuses the configured HOME legacy database before output creation", async () => {
    const fixture = await legacyCliFixture({ configuredLegacyPath: true });
    try {
      const env = { ...process.env, HOME: fixture.root, TMPDIR: fixture.root };
      await assert.rejects(
        execFileAsync(BIN, [
          "legacy-export",
          "--source-db", fixture.sourceDb,
          "--output-dir", fixture.outputDir,
          "--apply"
        ], { env }),
        (error) => {
          assert.equal(error.code, 1);
          assert.equal(String(error.stderr), "live_legacy_database_refused\n");
          return true;
        }
      );
      await assert.rejects(stat(fixture.outputDir));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("CLI exposes no receipt or reconcile control plane", async () => {
    const home = await tempHome();
    const result = await execFileAsync(BIN, ["--help"], { env: { ...process.env, HOME: home } });
    assert.match(result.stdout, /agent-feedback-loop/);
    assert.doesNotMatch(result.stdout, /capture[-]stop|reconcile(?:-daemon)?|receipt|reviewer-submit|notifier/i);
  });

  it("guard is an explicit machine-only branch with bounded nonzero exits", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "afl-guard-cli-")));
    const repoRoot = path.join(root, "repo");
    const home = path.join(root, "home");
    await mkdir(repoRoot, { mode: 0o700 });
    await execFileAsync("git", ["init", "-q", repoRoot]);
    try {
      await assert.rejects(
        execFileAsync(BIN, [
          "guard", "--repo-root", repoRoot, "--home", home,
          "record-review",
          "--task-id", "task-4", "--invariant-id", "cli-writer", "--boundary", "cli-boundary",
          "--review-run-id", "cli-review-1", "--severity", "Important",
          "--verdict", "approved", "--commit", "deadbeef", "--review-ref", "reviews/cli-1.md"
        ], { env: { ...process.env, HOME: root } }),
        (error) => {
          assert.equal(error.code, 6);
          assert.deepEqual(JSON.parse(String(error.stdout)), { error: "lineage_not_initialized" });
          return true;
        }
      );
      await assert.rejects(stat(home));
      await execFileAsync(BIN, ["lineage-init", "--repo-root", repoRoot, "--apply"], {
        env: { ...process.env, HOME: root }
      });
      await assert.rejects(
        execFileAsync(BIN, [
          "guard", "--repo-root", repoRoot, "--home", home,
          "record-review", "--unknown", "private-value"
        ], { env: { ...process.env, HOME: root } }),
        (error) => {
          assert.equal(error.code, 2);
          assert.deepEqual(JSON.parse(String(error.stdout)), { error: "guard_invalid_arguments" });
          return true;
        }
      );
      await assert.rejects(stat(home));
      const valid = await execFileAsync(BIN, [
        "guard", "--repo-root", repoRoot, "--home", home,
        "record-review",
        "--task-id", "task-4", "--invariant-id", "cli-writer", "--boundary", "cli-boundary",
        "--review-run-id", "cli-review-1", "--severity", "Important",
        "--verdict", "changes_required", "--commit", "deadbeef",
        "--review-ref", "reviews/cli-1.md", "--hypothesis", "one writer is missing",
        "--new-evidence", "cli-counterexample", "--falsification-test", "prove one writer",
        "--failure-next-action", "direction_review"
      ], { env: { ...process.env, HOME: root } });
      assert.equal(valid.stderr, "");
      assert.equal(valid.stdout.trim().split("\n").length, 1);
      const body = JSON.parse(valid.stdout);
      assert.equal(body.action, "local_fix_allowed");
      assert.equal("exitCode" in body, false);

      await assert.rejects(
        execFileAsync(BIN, [
          "guard", "--repo-root", repoRoot, "--home", home,
          "record-review", "--unknown", "private-value"
        ], { env: { ...process.env, HOME: root } }),
        (error) => {
          assert.equal(error.code, 2);
          assert.deepEqual(JSON.parse(String(error.stdout)), { error: "guard_invalid_arguments" });
          assert.equal(String(error.stderr), "guard_invalid_arguments\n");
          assert.doesNotMatch(`${error.stdout}${error.stderr}`, /afl-guard-cli|private-value|repo/u);
          return true;
        }
      );

      const source = await readFile(path.join(ROOT, "src", "cli.mjs"), "utf8");
      const mainBody = source.slice(source.indexOf("export async function main"));
      assert.ok(mainBody.indexOf('args[0] === "guard"') < mainBody.indexOf("parseArgs(args)"));
      const hookBody = source.slice(source.indexOf("export async function handlePromptHook"), source.indexOf("export function reviewerTerminalLog"));
      assert.doesNotMatch(hookBody, /executeGuardCli|runGuardCommand/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("guard reads bounded semantic stdin only for the explicit Probe context flag", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "afl-guard-stdin-")));
    const repoRoot = path.join(root, "repo");
    const home = path.join(root, "home");
    await mkdir(repoRoot, { mode: 0o700 });
    await execFileAsync("git", ["init", "-q", repoRoot]);
    let reads = 0;
    try {
      const invalid = await executeGuardCli([
        "--repo-root", repoRoot, "--home", home,
        "record-review",
        "--task-id", "task-5", "--invariant-id", "probe-evidence", "--boundary", "probe-boundary",
        "--review-run-id", "stdin-review", "--severity", "Important",
        "--verdict", "changes_required", "--commit", "deadbeef",
        "--review-ref", "reviews/stdin.md", "--hypothesis", "opaque input is insufficient",
        "--new-evidence", "provider lacks semantic facts", "--falsification-test", "observe exact evidence",
        "--failure-next-action", "direction_review", "--probe-context-stdin"
      ], {
        readStdin: async ({ maxBytes }) => {
          reads += 1;
          assert.equal(maxBytes, 16 * 1_024);
          return "{";
        }
      });
      assert.equal(reads, 1);
      assert.deepEqual(invalid.payload, { error: "probe_context_invalid" });
      await assert.rejects(stat(home));

      const noFlag = await executeGuardCli([
        "--repo-root", repoRoot, "--home", home,
        "record-review", "--unknown", "private-value"
      ], {
        readStdin: async () => { throw new Error("stdin must remain unread"); }
      });
      assert.equal(noFlag.payload.error, "guard_invalid_arguments");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Probe context stdin accepts 16 KiB and rejects overflow, truncation, UTF-8 errors, and trailing JSON", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "afl-guard-stdin-bounds-")));
    const repoRoot = path.join(root, "repo");
    const home = path.join(root, "home");
    await mkdir(repoRoot, { mode: 0o700 });
    await execFileAsync("git", ["init", "-q", repoRoot]);
    const context = JSON.stringify({
      producer: "sdd",
      goalSummary: "Bound semantic context without exposing it",
      acceptanceCriteria: ["Reject every byte outside the explicit envelope"],
      exclusions: ["No semantic bytes in argv or output"],
      importance: "routine",
      importanceAuthority: "approved_plan",
      contractRevision: "a".repeat(64),
      generationObservations: []
    });
    const args = [
      "--repo-root", repoRoot, "--home", home,
      "record-review",
      "--task-id", "task-5", "--invariant-id", "probe-evidence", "--boundary", "probe-boundary",
      "--review-run-id", "stdin-bounds", "--severity", "Important",
      "--verdict", "changes_required", "--commit", "deadbeef",
      "--review-ref", "reviews/stdin.md", "--hypothesis", "opaque input is insufficient",
      "--new-evidence", "provider lacks semantic facts", "--falsification-test", "observe exact evidence",
      "--failure-next-action", "direction_review", "--probe-context-stdin"
    ];
    try {
      const exact = Buffer.alloc(16 * 1_024, 0x20);
      exact.write(context, 0, "utf8");
      const accepted = await executeGuardCli(args, { readStdin: async () => exact });
      assert.equal(accepted.payload.error, "lineage_not_initialized");

      for (const raw of [
        Buffer.concat([exact, Buffer.from(" ")]),
        Buffer.from(context.slice(0, -1), "utf8"),
        Buffer.from([0xc3, 0x28]),
        Buffer.from(`${context}{}`, "utf8")
      ]) {
        const rejected = await executeGuardCli(args, { readStdin: async () => raw });
        assert.deepEqual(rejected.payload, { error: "probe_context_invalid" });
        assert.doesNotMatch(JSON.stringify(rejected), /Bound semantic|provider lacks/u);
      }
      await assert.rejects(stat(home));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("orphan cleanup runs only after an explicit mutation and never from status", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "afl-probe-orphan-cli-")));
    const repoRoot = path.join(root, "repo");
    const home = path.join(root, "home");
    await mkdir(repoRoot, { mode: 0o700 });
    await execFileAsync("git", ["init", "-q", repoRoot]);
    await ensureRepositoryLineage({ repoRoot });
    const paths = pathsFor(home);
    const contextStore = new ConvergenceProbeContextStore({
      root: paths.probeContextRoot,
      keyProvider: new BlobKeyProvider({ keyRoot: paths.keyRoot })
    });
    try {
      const published = await contextStore.put({
        version: 1,
        identity: {
          taskUid: "orphan-task",
          fingerprint: "orphan-fingerprint",
          boundaryId: "task-5",
          canonicalInvariantId: "probe-context"
        },
        contract: {
          goalSummary: "Remove only an old unreferenced Probe artifact",
          acceptanceCriteria: ["Read commands never trigger cleanup"],
          exclusions: ["No scheduler or prompt cleanup"],
          importance: "routine",
          importanceAuthority: "approved_plan",
          contractRevision: "a".repeat(64)
        },
        trigger: {
          decision: "reflection_required",
          breakerReason: "unjustified_architecture_expansion",
          failureCount: 1,
          currentGeneration: 0,
          decisionBasisDigest: "b".repeat(64)
        },
        recentGenerations: [],
        reviewEvidence: {
          severity: "important",
          verdict: "changes_required",
          hypothesis: "Read paths may mutate cleanup state",
          newEvidence: "An old orphan remains available before status",
          falsificationTest: "Compare status and explicit mutation"
        }
      });
      const artifact = contextStore.artifactFile(published.digest);
      const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
      await utimes(artifact, old, old);

      const statusResult = await executeGuardCli([
        "--repo-root", repoRoot, "--home", home, "status", "--task-id", "task-5"
      ]);
      assert.equal(statusResult.exitCode, 0);
      await stat(artifact);

      const mutation = await executeGuardCli([
        "--repo-root", repoRoot, "--home", home,
        "record-review",
        "--task-id", "task-5", "--invariant-id", "probe-evidence", "--boundary", "probe-boundary",
        "--review-run-id", "orphan-cleanup", "--severity", "Important",
        "--verdict", "changes_required", "--commit", "deadbeef",
        "--review-ref", "reviews/orphan.md", "--hypothesis", "an orphan can survive a crash",
        "--new-evidence", "an old digest is not live", "--falsification-test", "run one explicit mutation",
        "--failure-next-action", "direction_review"
      ]);
      assert.equal(mutation.payload.action, "local_fix_allowed");
      await assert.rejects(stat(artifact));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
