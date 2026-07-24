import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { captureObservedSession } from "../src/capture.mjs";
import { install, pathsFor } from "../src/index.mjs";
import { openControlStore } from "../src/control-store.mjs";
import { BlobKeyProvider, EncryptedBlobStore } from "../src/crypto-store.mjs";
import { ensureRepositoryLineage } from "../src/convergence-identity.mjs";
import { launchDetachedConvergenceProbe } from "../src/convergence-probe-launcher.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "bin", "agent-feedback-loop.mjs");
const EXPLICIT_FEEDBACK = "是的，而且为什么你改造这些之前没有去考虑这些东西呢，而是等到我发现事情变复杂了才开始思考这些东西";

function runHook(file, input, env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr)));
    child.stdin.end(input);
  });
}

function unavailableCodexHost() {
  return { async synchronize() { return { available: false, configured: true, runnable: false, status: "unavailable" }; } };
}

async function readEventually(file, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for detached fixture: ${path.basename(file)}`);
}

test("core hook returns a successful launcher response verbatim", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-wrapper-success-"));
  const launcher = path.join(home, ".agent", "feedback-loop", "bin", "afl-hook");
  await mkdir(path.dirname(launcher), { recursive: true });
  await writeFile(launcher, "#!/bin/sh\nprintf '{\"continue\":true,\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"method\"}}\\n\\n'\n", { mode: 0o700 });
  await chmod(launcher, 0o700);

  const result = await runHook(path.join(ROOT, "templates", "hooks", "core-hook.sh"), '{"prompt":"hello"}', { ...process.env, HOME: home, TMPDIR: home }, ["--event", "UserPromptSubmit", "--cli", "codex", "--continue"]);

  assert.equal(result.stdout, '{"continue":true,"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"method"}}\n\n');
  assert.equal(result.stderr, "");
});

test("core hook maps launcher failures to exact host no-ops", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-wrapper-failure-"));
  const launcher = path.join(home, ".agent", "feedback-loop", "bin", "afl-hook");
  await mkdir(path.dirname(launcher), { recursive: true });
  await writeFile(launcher, "#!/bin/sh\nprintf 'sensitive operational failure' >&2\nexit 17\n", { mode: 0o700 });
  await chmod(launcher, 0o700);
  const env = { ...process.env, HOME: home, TMPDIR: home };

  const codex = await runHook(path.join(ROOT, "templates", "hooks", "core-hook.sh"), "invalid", env, ["--continue"]);
  const claude = await runHook(path.join(ROOT, "templates", "hooks", "core-hook.sh"), "invalid", env, []);

  assert.equal(codex.stdout, '{"continue":true}\n');
  assert.equal(claude.stdout, '{}\n');
  assert.equal(`${codex.stderr}${claude.stderr}`, "");
});

test("installed prompt hook remains bounded fail-open", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-installed-prompt-"));
  await install({ home, codexHost: unavailableCodexHost() });
  const paths = pathsFor(home);
  const env = { ...process.env, HOME: home, TMPDIR: home };

  const result = await runHook(paths.coreHook, '{"prompt":"hello"}', env, ["--event", "UserPromptSubmit", "--cli", "codex", "--continue"]);

  assert.deepEqual(JSON.parse(result.stdout), { continue: true });
  assert.equal(result.stderr, "");
});

test("installed explicit feedback launches a detached reviewer and publishes no stdout control message", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-installed-feedback-"));
  const projectPath = path.join(home, "project");
  const fakeBin = path.join(home, "fake-bin");
  const fakeProvider = path.join(fakeBin, "codex");
  const providerSentinel = path.join(home, "provider-stdin.json");
  await mkdir(projectPath, { recursive: true, mode: 0o700 });
  await mkdir(fakeBin, { recursive: true, mode: 0o700 });
  const projectDir = await realpath(projectPath);
  await writeFile(fakeProvider, `#!/usr/bin/env node
import { chmodSync, writeFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const index = process.argv.indexOf("--output-last-message");
if (index < 0 || !process.argv[index + 1]) process.exit(23);
writeFileSync(process.argv[index + 1], JSON.stringify({ result: { outcome: "no_lesson" } }));
chmodSync(process.argv[index + 1], 0o600);
const jobId = /"job_id":"([^"]+)"/.exec(input)?.[1] || "unknown";
writeFileSync(process.env.AFL_REVIEW_PROVIDER_SENTINEL + "." + jobId, JSON.stringify({
  receivedEvidenceOnStdin: input.includes("<afl_evidence>"),
  argvContainsEvidence: process.argv.some((value) => value.includes("previous response ignored"))
}));
`, { mode: 0o700 });
  await install({ home, codexHost: unavailableCodexHost() });
  const paths = pathsFor(home);
  const controlStore = openControlStore({ paths });
  const blobs = new EncryptedBlobStore({
    root: paths.blobRoot,
    keyProvider: new BlobKeyProvider({ keyRoot: paths.keyRoot })
  });
  const recoverRawText = "Recover this older bounded review job.";
  const oldCapture = await captureObservedSession({
    store: controlStore,
    blobs,
    event: {
      event_uid: "recover-source-event",
      session_uid: "recover-session",
      cli: "codex",
      project_id: projectDir,
      context_epoch: 1,
      source_namespace: "hook",
      source_id: "recover-source-event",
      source_event_id: "recover-source-event",
      source_offset: 1,
      capture_source: "prompt_hook",
      native_turn_id: "recover-turn",
      source_timestamp: "2026-07-20T07:00:00.000Z",
      role: "user",
      referent_event_uid: null,
      content_hash: createHash("sha256").update(recoverRawText).digest("hex"),
      completeness: "complete"
    },
    rawText: recoverRawText
  });
  const recoverCandidate = controlStore.createReviewCandidate({
    sourceEventUid: oldCapture.eventUid,
    sourceIdentity: "codex:recover-session:recover-source-event",
    projectId: projectDir
  });
  controlStore.close();
  const payload = JSON.stringify({
    session_id: "installed-feedback-session",
    event_id: "installed-feedback-event",
    turn_id: "installed-feedback-turn-2",
    cwd: projectDir,
    timestamp: "2026-07-20T08:00:00.000Z",
    prompt: EXPLICIT_FEEDBACK,
    previous_assistant_message: {
      role: "assistant",
      id: "installed-assistant-event",
      turn_id: "installed-feedback-turn-1",
      timestamp: "2026-07-20T07:59:59.000Z",
      content: [{ type: "output_text", text: "I changed the design before confirming the boundary." }]
    }
  });

  const result = await runHook(paths.coreHook, payload, {
    ...process.env,
    HOME: home,
    TMPDIR: home,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
    AFL_REVIEW_PROVIDER_SENTINEL: providerSentinel
  }, ["--event", "UserPromptSubmit", "--cli", "codex", "--continue"]);
  assert.deepEqual(JSON.parse(result.stdout), { continue: true });
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\[AFL\]|afl-receipt|Output this receipt|reviewer.*queued|hookPrompt|checkpoint|runner_transition/i);
  assert.equal(result.stderr, "");

  const deadline = Date.now() + 3_000;
  let jobs = [];
  while (Date.now() < deadline) {
    const currentStore = openControlStore({ paths });
    try {
      jobs = currentStore.database.prepare("SELECT * FROM reviewer_jobs ORDER BY created_at, job_id").all();
    } finally {
      currentStore.close();
    }
    if (jobs.length === 2 && jobs.every((job) => job.state === "reviewed_no_lesson")) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(jobs.length, 2);
  assert.equal(jobs.every((job) => job.state === "reviewed_no_lesson"), true);
  assert.equal(jobs.every((job) => Number(job.launch_epoch) === 1), true);
  assert.equal(jobs.every((job) => job.published_path === null && job.published_sha256 === null), true);
  for (const job of jobs) {
    const providerRecord = JSON.parse(await readEventually(`${providerSentinel}.${job.job_id}`));
    assert.equal(providerRecord.receivedEvidenceOnStdin, true);
    assert.equal(providerRecord.argvContainsEvidence, false);
  }
  assert.ok(jobs.some((job) => job.job_id === recoverCandidate.jobId));
});

test("installed neutral reviewer question creates no review work", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-installed-neutral-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const projectDir = await realpath(await mkdtemp(path.join(home, "project-")));
  await install({ home, codexHost: unavailableCodexHost() });
  const paths = pathsFor(home);
  const payload = JSON.stringify({
    session_id: "neutral-reviewer-session",
    event_id: "neutral-reviewer-event",
    turn_id: "neutral-reviewer-turn-2",
    cwd: projectDir,
    timestamp: new Date().toISOString(),
    prompt: "reviewer job 是干嘛的？",
    previous_assistant_message: {
      role: "assistant",
      id: "neutral-reviewer-assistant",
      turn_id: "neutral-reviewer-turn-1",
      timestamp: new Date(Date.now() - 1_000).toISOString(),
      content: [{ type: "output_text", text: "The reviewer runs outside the prompt turn." }]
    }
  });

  const result = await runHook(paths.coreHook, payload, {
    ...process.env,
    HOME: home,
    TMPDIR: home
  }, ["--event", "UserPromptSubmit", "--cli", "codex", "--continue"]);
  assert.deepEqual(JSON.parse(result.stdout), { continue: true });
  assert.equal(result.stderr, "");

  const store = openControlStore({ paths });
  try {
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM reviewer_jobs").get().count, 0);
  } finally {
    store.close();
  }
  await assert.rejects(access(path.join(projectDir, ".agent", "reflections")), { code: "ENOENT" });
});

test("parse and control-store failures return native prompt no-ops", async () => {
  const installedHome = await mkdtemp(path.join(tmpdir(), "afl-installed-parse-failure-"));
  await install({ home: installedHome, codexHost: unavailableCodexHost() });
  const installedPaths = pathsFor(installedHome);
  const parseFailure = await runHook(
    installedPaths.coreHook,
    "{not-json",
    { ...process.env, HOME: installedHome, TMPDIR: installedHome },
    ["--event", "UserPromptSubmit", "--cli", "codex", "--continue"]
  );
  assert.equal(parseFailure.stdout, '{"continue":true}\n');
  assert.equal(parseFailure.stderr, "");

  const uninitializedHome = await mkdtemp(path.join(tmpdir(), "afl-uninitialized-store-"));
  const storeFailure = await runHook(
    process.execPath,
    JSON.stringify({ session_id: "missing-store", turn_id: "turn-1", prompt: "hello" }),
    { ...process.env, HOME: uninitializedHome, TMPDIR: uninitializedHome },
    [BIN, "hook", "--home", uninitializedHome, "--event", "UserPromptSubmit", "--cli", "codex", "--continue"]
  );
  assert.equal(storeFailure.stdout, '{"continue":true}\n');
  assert.equal(storeFailure.stderr, "");
});

test("installed prompt output is native and silent when convergence assets or identity are unavailable", async (t) => {
  const scenarios = ["schema_mismatch", "probe_spawn_failed", "identity_partial"];
  for (const scenario of scenarios) {
    const home = await mkdtemp(path.join(tmpdir(), `afl-convergence-${scenario}-`));
    t.after(() => rm(home, { recursive: true, force: true }));
    await install({ home, codexHost: unavailableCodexHost() });
    const paths = pathsFor(home);
    const projectDir = scenario === "identity_partial"
      ? path.join(home, "not-a-git-repository")
      : home;
    await mkdir(projectDir, { recursive: true, mode: 0o700 });
    if (scenario === "schema_mismatch") {
      const database = new DatabaseSync(paths.controlDatabase);
      try {
        database.prepare("UPDATE schema_migrations SET version=999").run();
      } finally {
        database.close();
      }
    } else if (scenario === "probe_spawn_failed") {
      assert.deepEqual(launchDetachedConvergenceProbe({
        platform: process.platform,
        nodeExecutable: process.execPath,
        cliFile: BIN,
        home,
        taskUid: "a".repeat(64),
        fingerprint: "b".repeat(64),
        spawnImpl() { throw new Error("injected_probe_spawn_failure"); }
      }), { attempted: false, reason: "spawn_failed" });
      await rm(paths.convergenceProbePrompt);
      await rm(paths.convergenceProbeSchema);
    } else {
      await assert.rejects(() => ensureRepositoryLineage({ repoRoot: projectDir }));
    }
    const payload = JSON.stringify({
      session_id: `convergence-${scenario}`,
      turn_id: `turn-${scenario}`,
      cwd: projectDir,
      prompt: "reviewer job 是干嘛的？"
    });
    const env = { ...process.env, HOME: home, TMPDIR: home };
    const cases = [
      ["codex", ["--event", "UserPromptSubmit", "--cli", "codex", "--continue"], "{\"continue\":true}\n"],
      ["claude", ["--event", "UserPromptSubmit", "--cli", "claude"], "{}\n"],
      ["gemini", ["--event", "BeforeAgent", "--cli", "gemini"], "{}\n"]
    ];
    for (const [cli, args, nativeNoOp] of cases) {
      const result = await runHook(paths.coreHook, payload, env, args);
      assert.equal(result.stdout, nativeNoOp, `${scenario}:${cli}`);
      assert.equal(result.stderr, "", `${scenario}:${cli}`);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /AFL|Guard|grant|receipt|Probe|operational/iu);
    }
  }
});

test("CLI live doctor runs only an isolated temporary canary", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-doctor-"));
  await install({ home, codexHost: unavailableCodexHost() });
  const result = await execFileAsync(process.execPath, ["bin/agent-feedback-loop.mjs", "doctor", "--home", home, "--live"], {
    cwd: ROOT,
    env: { ...process.env, HOME: home }
  }).catch((error) => error);
  const stdout = result.stdout || "";
  const parsed = JSON.parse(stdout.slice(stdout.indexOf("{\n")));
  assert.deepEqual(Object.keys(parsed).sort(), ["status", "version"]);
  assert.equal(parsed.status.controlStore.live.status, "healthy");
  assert.equal(parsed.status.controlStore.live.syntheticExcluded, true);
  assert.equal(parsed.status.ready, false);
});

test("CLI exposes no receipt or reconcile control plane", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-help-prompt-only-"));
  const result = await execFileAsync(process.execPath, ["bin/agent-feedback-loop.mjs", "--help"], {
    cwd: ROOT,
    env: { ...process.env, HOME: home }
  });
  assert.doesNotMatch(result.stdout, /capture[-]stop|reconcile(?:-daemon)?|receipt|reviewer-submit|notifier/i);
});

test("installed hook manifests preserve native timeout units", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-timeouts-"));
  await install({ home, codexHost: unavailableCodexHost() });
  const claude = JSON.parse(await readFile(path.join(home, ".claude", "settings.json"), "utf8"));
  const gemini = JSON.parse(await readFile(path.join(home, ".gemini", "settings.json"), "utf8"));
  assert.deepEqual(claude.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks).map((hook) => hook.timeout), [5]);
  assert.deepEqual(gemini.hooks.BeforeAgent.flatMap((entry) => entry.hooks).map((hook) => hook.timeout), [5000]);
});

test("Codex reinstall removes the legacy managed status message without replacing it", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-codex-silent-install-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configPath = path.join(home, ".codex", "config.toml");
  const legacyCoreHook = pathsFor(home).coreHook;
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, `# agent-feedback-loop:start
[[hooks.UserPromptSubmit]]
matcher = "*"

[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = ${JSON.stringify(`${legacyCoreHook} --event UserPromptSubmit --cli codex --continue`)}
timeout = 5
statusMessage = "Injecting feedback reflection prompt"
# agent-feedback-loop:end
`, { mode: 0o600 });

  await install({ home, codexHost: unavailableCodexHost() });
  const config = await readFile(configPath, "utf8");
  assert.match(config, /\[\[hooks\.UserPromptSubmit\]\]/u);
  assert.match(config, /command = .*core-hook\.sh/u);
  assert.match(config, /timeout = 5/u);
  assert.doesNotMatch(config, /statusMessage\s*=/u);
  assert.doesNotMatch(config, /Injecting feedback reflection prompt/u);
});

test("installed explicit-feedback hook fails open without waiting for a held control writer", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-busy-prompt-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const projectDir = await realpath(await mkdtemp(path.join(home, "project-")));
  await install({ home, codexHost: unavailableCodexHost() });
  const paths = pathsFor(home);
  const holder = spawn(process.execPath, ["-e", `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.env.AFL_TEST_CONTROL_STORE);
    db.exec("BEGIN IMMEDIATE");
    process.stdout.write("locked\\n");
    setTimeout(() => { db.exec("COMMIT"); db.close(); }, 6500);
  `], {
    env: { ...process.env, AFL_TEST_CONTROL_STORE: paths.controlDatabase },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const holderExit = once(holder, "exit");
  const [ready] = await once(holder.stdout, "data");
  assert.match(String(ready), /locked/u);

  const payload = JSON.stringify({
    session_id: "busy-feedback-session",
    event_id: "busy-feedback-event",
    turn_id: "busy-feedback-turn",
    cwd: projectDir,
    timestamp: new Date().toISOString(),
    prompt: EXPLICIT_FEEDBACK,
    previous_assistant_message: {
      role: "assistant",
      id: "busy-feedback-assistant",
      turn_id: "busy-feedback-previous-turn",
      timestamp: new Date(Date.now() - 1_000).toISOString(),
      content: [{ type: "output_text", text: "I changed the design before confirming the boundary." }]
    }
  });
  const startedAt = Date.now();
  const result = await runHook(paths.coreHook, payload, { ...process.env, HOME: home, TMPDIR: home }, ["--event", "UserPromptSubmit", "--cli", "codex", "--continue"]);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.stdout, '{"continue":true}\n');
  assert.equal(result.stderr, "");
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\[AFL\]|afl-receipt|Output this receipt|reviewer.*queued|hookPrompt|runner_transition/iu);
  // Must finish well below the 5s default SQLite busy timeout and the 6.5s writer
  // hold: that proves the hook took the short-timeout fail-open path instead of
  // blocking on the lock. 4s keeps that distinction with headroom for loaded hosts.
  assert.ok(elapsedMs < 4_000, `expected fail-open below busy-timeout, received ${elapsedMs}ms`);
  t.diagnostic(`held-writer hook response elapsed ${elapsedMs}ms; writer cleanup is awaited separately`);

  const [exitCode] = await holderExit;
  assert.equal(exitCode, 0);
  const store = openControlStore({ paths });
  try {
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM reviewer_jobs").get().count, 0);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 0);
  } finally {
    store.close();
  }
});

test("detached reviewer outlives its macOS launcher parent without leaking output", {
  skip: process.platform !== "darwin"
}, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-detached-reviewer-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const fixtureCli = path.join(home, "fixture-reviewer.mjs");
  const launcherParent = path.join(home, "launcher-parent.mjs");
  const sentinel = path.join(home, "reviewer-finished.json");
  const moduleUrl = pathToFileURL(path.join(ROOT, "src", "reviewer-launcher.mjs")).href;
  const childStdout = "DETACHED_FIXTURE_STDOUT";
  const childStderr = "DETACHED_FIXTURE_STDERR";

  await writeFile(fixtureCli, `
import { writeFile } from "node:fs/promises";
console.log(${JSON.stringify(childStdout)});
console.error(${JSON.stringify(childStderr)});
await new Promise((resolve) => setTimeout(resolve, 750));
await writeFile(process.env.AFL_REVIEW_SENTINEL, JSON.stringify({ writtenAt: Date.now() }));
`);
  await writeFile(launcherParent, `
import { launchDetachedReviewer } from ${JSON.stringify(moduleUrl)};
const result = launchDetachedReviewer({
  platform: "darwin",
  nodeExecutable: process.execPath,
  cliFile: ${JSON.stringify(fixtureCli)},
  home: ${JSON.stringify(home)},
  jobId: "fixture-job",
  launchEpoch: 1,
  env: {
    PATH: process.env.PATH,
    HOME: ${JSON.stringify(home)},
    TMPDIR: ${JSON.stringify(home)},
    AFL_REVIEW_SENTINEL: ${JSON.stringify(sentinel)}
  }
});
console.log(JSON.stringify({ result, returnedAt: Date.now() }));
`);

  const startedAt = Date.now();
  const parent = await execFileAsync(process.execPath, [launcherParent], {
    cwd: home,
    env: { ...process.env, HOME: home, TMPDIR: home }
  });
  const parentExitedAt = Date.now();
  const parentRecord = JSON.parse(parent.stdout.trim());

  assert.deepEqual(parentRecord.result, { attempted: true, reason: "spawn_attempted" });
  assert.ok(parentRecord.returnedAt >= startedAt && parentRecord.returnedAt <= parentExitedAt);
  assert.doesNotMatch(`${parent.stdout}${parent.stderr}`, new RegExp(`${childStdout}|${childStderr}`));
  await assert.rejects(access(sentinel), { code: "ENOENT" });

  const completion = JSON.parse(await readEventually(sentinel));
  assert.ok(completion.writtenAt > parentExitedAt);
});

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

// End-to-end preserve-and-expand coverage through the installed hook plus the
// real detached reviewer. A minimal fake `codex` provider stands in for the CLI:
// it writes the Codex transport envelope { result: <logical> } that the runner
// unwraps, returning `no_lesson` for both the semantic gate and the full reviewer
// so every admitted job settles at `reviewed_no_lesson`. The candidate reason_code
// recorded on `review_job_events` proves which path a prompt took: explicit hits
// keep the direct full-reviewer path (`explicit_feedback`), while expanded coarse
// recall is routed through the semantic gate (`expanded_feedback`).
async function installWithFakeCodexProvider(t) {
  const home = await mkdtemp(path.join(tmpdir(), "afl-e2e-gate-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const fakeBin = path.join(home, "fake-bin");
  const fakeProvider = path.join(fakeBin, "codex");
  await mkdir(fakeBin, { recursive: true, mode: 0o700 });
  await writeFile(fakeProvider, `#!/usr/bin/env node
import { chmodSync, writeFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const index = process.argv.indexOf("--output-last-message");
if (index < 0 || !process.argv[index + 1]) process.exit(23);
writeFileSync(process.argv[index + 1], JSON.stringify({ result: { outcome: "no_lesson" } }));
chmodSync(process.argv[index + 1], 0o600);
`, { mode: 0o700 });
  await install({ home, codexHost: unavailableCodexHost() });
  return { home, paths: pathsFor(home), fakeBin };
}

async function submitInstalledPrompt({ paths, home, fakeBin, projectDir, session, prompt, previousAssistant }) {
  const payload = JSON.stringify({
    session_id: `${session}-session`,
    event_id: `${session}-event`,
    turn_id: `${session}-turn-2`,
    cwd: projectDir,
    timestamp: "2026-07-20T08:00:00.000Z",
    prompt,
    previous_assistant_message: {
      role: "assistant",
      id: `${session}-assistant`,
      turn_id: `${session}-turn-1`,
      timestamp: "2026-07-20T07:59:59.000Z",
      content: [{ type: "output_text", text: previousAssistant }]
    }
  });
  return runHook(paths.coreHook, payload, {
    ...process.env,
    HOME: home,
    TMPDIR: home,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`
  }, ["--event", "UserPromptSubmit", "--cli", "codex", "--continue"]);
}

function reviewerJobsWithReasonCodes(paths) {
  const store = openControlStore({ paths });
  try {
    return store.database.prepare("SELECT * FROM reviewer_jobs ORDER BY created_at, job_id").all().map((job) => ({
      ...job,
      reasonCode: store.database.prepare(
        "SELECT reason_code FROM review_job_events WHERE job_id=? AND event_type='candidate_created' ORDER BY id LIMIT 1"
      ).get(job.job_id)?.reason_code ?? null
    }));
  } finally {
    store.close();
  }
}

async function waitForReviewedJobs(paths, expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let jobs = reviewerJobsWithReasonCodes(paths);
  while (Date.now() < deadline) {
    if (jobs.length === expected && jobs.every((job) => job.state === "reviewed_no_lesson")) return jobs;
    await new Promise((resolve) => setTimeout(resolve, 25));
    jobs = reviewerJobsWithReasonCodes(paths);
  }
  return jobs;
}

// The literal port/credential string is deliberate fixture data for a real user
// complaint that the shipped keyword detector previously missed; it is only ever
// hook input and is never echoed to logs or documentation.
const EXPANDED_MISSED_PROMPTS = Object.freeze([
  ["installed hook admits repeated known-info frustration into semantic dissatisfaction review",
    "密码不是都有吗端口55555，root Hik@123++",
    "I asked again for the already-known root password and port."],
  ["installed hook admits 这些之前都有存的呀怎么又不知道了 into semantic dissatisfaction review",
    "这些之前都有存的呀怎么又不知道了",
    "I asked for the stored connection details again."],
  ["installed hook admits 之前出现过好几次了 recurrence into semantic dissatisfaction review",
    "之前出现过好几次了",
    "I repeated a mistake we already solved."],
  ["installed hook admits 都第七八次了 rhetorical recurrence into semantic dissatisfaction review",
    "都第七八次了",
    "I asked the user to restate the same thing once more."]
]);

for (const [name, prompt, previousAssistant] of EXPANDED_MISSED_PROMPTS) {
  test(name, async (t) => {
    const { home, paths, fakeBin } = await installWithFakeCodexProvider(t);
    const projectDir = await realpath(await mkdtemp(path.join(home, "project-")));

    const result = await submitInstalledPrompt({
      paths, home, fakeBin, projectDir, session: "expanded", prompt, previousAssistant
    });
    assert.equal(result.stdout, '{"continue":true}\n');
    assert.equal(result.stderr, "");

    const jobs = await waitForReviewedJobs(paths, 1);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].state, "reviewed_no_lesson");
    assert.equal(jobs[0].reasonCode, "expanded_feedback");
  });
}

test("installed flow preserves explicit hits, expands coarse recall, and skips neutral prompts", async (t) => {
  const { home, paths, fakeBin } = await installWithFakeCodexProvider(t);
  const cases = [
    { session: "explicit", prompt: EXPLICIT_FEEDBACK,
      previousAssistant: "I changed the design before confirming the boundary.", expected: "explicit_feedback" },
    { session: "expanded-known-info", prompt: "密码不是都有吗端口55555，root Hik@123++",
      previousAssistant: "I asked again for the already-known root password and port.", expected: "expanded_feedback" },
    { session: "expanded-recall", prompt: "这些之前都有存的呀怎么又不知道了",
      previousAssistant: "I asked for the stored connection details again.", expected: "expanded_feedback" },
    { session: "expanded-recurrence", prompt: "之前出现过好几次了",
      previousAssistant: "I repeated a mistake we already solved.", expected: "expanded_feedback" },
    { session: "expanded-rhetorical", prompt: "都第七八次了",
      previousAssistant: "I asked the user to restate the same thing once more.", expected: "expanded_feedback" },
    { session: "neutral", prompt: "reviewer job 是干嘛的？",
      previousAssistant: "The reviewer runs outside the prompt turn.", expected: null }
  ];

  for (const testCase of cases) {
    const projectDir = await realpath(await mkdtemp(path.join(home, "project-")));
    const result = await submitInstalledPrompt({ paths, home, fakeBin, projectDir, ...testCase });
    assert.equal(result.stdout, '{"continue":true}\n', testCase.session);
    assert.equal(result.stderr, "", testCase.session);
  }

  const expectedJobs = cases.filter((testCase) => testCase.expected !== null).length;
  const jobs = await waitForReviewedJobs(paths, expectedJobs);
  assert.equal(jobs.length, expectedJobs);
  assert.equal(jobs.every((job) => job.state === "reviewed_no_lesson"), true);
  const tally = jobs.reduce((totals, job) => {
    totals[job.reasonCode] = (totals[job.reasonCode] ?? 0) + 1;
    return totals;
  }, {});
  assert.deepEqual(tally, { explicit_feedback: 1, expanded_feedback: 4 });
});
