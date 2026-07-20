import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { doctor, install, pathsFor, uninstall } from "../src/index.mjs";
import * as cliModule from "../src/cli.mjs";
import { BlobKeyProvider, EncryptedBlobStore } from "../src/crypto-store.mjs";
import { initializeControlStore } from "../src/control-store.mjs";
import { recoverDueReviewers } from "../src/reviewer-launcher.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "bin", "agent-feedback-loop.mjs");

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
const PROMPT_CUTOFF = "2026-07-20T08:00:00.000Z";

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

describe("agent-feedback-loop package", () => {
  it("explicit feedback commits one job before launch", async () => {
    const fixture = await promptOrchestrationFixture();
    const calls = [];

    const response = await cliModule.handlePromptHook({
      payload: explicitFeedbackPayload(),
      cli: "codex",
      controlStore: fixture.controlStore,
      legacyMemoryStore: null,
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
        assert.equal(result.operationalText, null);
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
      legacyMemoryStore: null,
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

  it("same complaint in another session starts another review", async () => {
    const fixture = await promptOrchestrationFixture();
    const launches = [];
    const invoke = (payload) => cliModule.handlePromptHook({
      payload,
      cli: "codex",
      controlStore: fixture.controlStore,
      legacyMemoryStore: null,
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
      legacyMemoryStore: null,
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
      legacyMemoryStore: null,
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
      legacyMemoryStore: null,
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
      legacyMemoryStore: null,
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
      legacyMemoryStore: { selectLessons() { throw new Error("fixture_selection_failure"); } },
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
        legacyMemoryStore: null,
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
      legacyMemoryStore: null,
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
      legacyMemoryStore: null,
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
      legacyMemoryStore: null,
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
      legacyMemoryStore: null,
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
      legacyMemoryStore: null,
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

  it("doctor reports prompt-only status without scheduler or backstop fields", async () => {
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

    assert.equal(health.healthy, false);
    assert.equal(health.clis.codex.configured, true);
    assert.equal(health.clis.codex.runnable, false);
    assert.equal(health.clis.codex.promptTrustStatus, "modified");
    assert.equal("backstopTrustStatus" in health.clis.codex, false);
    assert.equal("scheduler" in health, false);
    assert.equal("reconciliation" in health, false);
    assert.equal(health.controlStore.exists, true);
    assert.equal(health.legacyStopRemoved, true);
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

  it("CLI exposes no receipt or reconcile control plane", async () => {
    const home = await tempHome();
    const result = await execFileAsync(BIN, ["--help"], { env: { ...process.env, HOME: home } });
    assert.match(result.stdout, /agent-feedback-loop/);
    assert.doesNotMatch(result.stdout, /capture[-]stop|reconcile(?:-daemon)?|receipt|reviewer-submit|notifier/i);
  });
});
