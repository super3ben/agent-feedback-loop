import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { openControlStore } from "../src/control-store.mjs";
import { install, pathsFor } from "../src/index.mjs";
import {
  parseReflectionMarkdown,
  publishReflectionDocument,
  validateReflectionModel
} from "../src/reflection-document.mjs";
import { resolveReviewerExecutable } from "../src/reviewer-provider.mjs";
import { loadReflectionDocuments } from "../src/selector.mjs";

const EXPLICIT_FEEDBACK = "是的，而且为什么你改造这些之前没有去考虑这些东西呢，而是等到我发现事情变复杂了才开始思考这些东西";
const REPEATED_FEEDBACK = "之前你仍然没有考虑用户目标，而是等我再次指出后才开始思考，应该先验证需求再改架构。";
const NEUTRAL_REVIEWER_QUESTION = "reviewer job 是干嘛的？";
const CUTOFF_PROMPT = "platform cutoff exact matching document";
const CUTOFF_INSTANT = "2030-01-02T03:04:05.000Z";
const TOP_FOUR_PROMPT = "topfour deterministic ranking fixture";
const CONTROL_TEXT = /\[AFL\]|afl-receipt|Output this receipt|reviewer.*queued|hookPrompt|runner_transition/iu;
const FIRST_METHOD = "method change alpha: verify user value before architecture";
const SECOND_METHOD = "method change beta: compare emitted guidance with recurrence before architecture";

function unavailableCodexHost() {
  return { async synchronize() { return { available: false, configured: true, runnable: false, status: "unavailable" }; } };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(operation, { timeoutMs, failureCode }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(failureCode);
}

function hookPayload({ projectDir, sessionId, eventId, turnId, prompt, taskFingerprint = "platform-architecture-task" }) {
  const timestamp = new Date().toISOString();
  return {
    session_id: sessionId,
    event_id: eventId,
    turn_id: turnId,
    context_epoch: 1,
    task_fingerprint: taskFingerprint,
    cwd: projectDir,
    timestamp,
    prompt,
    previous_assistant_message: {
      role: "assistant",
      id: `${eventId}-assistant`,
      turn_id: `${turnId}-previous`,
      timestamp: new Date(Date.parse(timestamp) - 1_000).toISOString(),
      content: [{ type: "output_text", text: "I changed the architecture before checking the user's required value." }]
    }
  };
}

function runProcess(file, args, { input, env, cwd }) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("platform_smoke_hook_timeout"));
    }, 15_000);
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) {
        child.kill("SIGKILL");
        finish(new Error("platform_smoke_output_limit"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", () => finish(new Error("platform_smoke_spawn_failed")));
    child.on("close", (code) => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        elapsedMs: performance.now() - startedAt
      };
      finish(code === 0 ? null : new Error(`platform_smoke_process_exit_${code}`), result);
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") finish(new Error("platform_smoke_stdin_failed"));
    });
    child.stdin.end(input);
  });
}

function readStore(paths, operation) {
  const store = openControlStore({ paths });
  try {
    return operation(store);
  } finally {
    store.close();
  }
}

function reviewJobs(paths) {
  return readStore(paths, (store) => store.database.prepare(
    "SELECT * FROM reviewer_jobs ORDER BY created_at, job_id"
  ).all());
}

function emittedRows(paths) {
  return readStore(paths, (store) => store.database.prepare(
    "SELECT * FROM reflection_emissions WHERE outcome='emitted' ORDER BY id"
  ).all());
}

async function reflectionFiles(projectDir) {
  try {
    return (await readdir(path.join(projectDir, ".agent", "reflections")))
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => path.join(projectDir, ".agent", "reflections", name));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function parsedReflections(projectDir) {
  return Promise.all((await reflectionFiles(projectDir)).map(async (file) => ({
    file,
    bytes: await readFile(file),
    parsed: parseReflectionMarkdown(await readFile(file, "utf8"), { path: file })
  })));
}

async function writeDeterministicProvider(file, { providerStarted, providerRelease }) {
  await writeFile(file, `#!/usr/bin/env node
import { access, chmod, writeFile } from "node:fs/promises";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const evidence = /<afl_evidence>\\n([\\s\\S]*?)\\n<\\/afl_evidence>/u.exec(input);
if (!evidence) process.exit(21);
for (const argument of ["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--output-schema", "--output-last-message"]) {
  if (!process.argv.includes(argument)) process.exit(20);
}
const context = JSON.parse(evidence[1]);
await writeFile(${JSON.stringify(providerStarted)}, "started", { mode: 0o600 });
while (!await access(${JSON.stringify(providerRelease)}).then(() => true, () => false)) await sleep(25);
const prior = context.reflectionCatalog.find((item) => item.methodClass === "requirements_before_architecture") || null;
const result = {
  outcome: "lesson",
  final_severity: "Critical",
  responsibility: "agent_fault",
  method_class: "requirements_before_architecture",
  family_id: prior?.familyId || null,
  proposed_family_key: prior ? null : "task15-platform-family",
  applies_when: ["modify architecture user value"],
  facts: ["A completed turn changed architecture before validating the required value."],
  user_complaint: "The process waited for the user to identify avoidable complexity.",
  root_cause: "The implementation direction was chosen before checking the smallest value path.",
  class_of_mistake: "architecture before requirement validation",
  method_changes: [prior ? ${JSON.stringify(SECOND_METHOD)} : ${JSON.stringify(FIRST_METHOD)}],
  repeated_pattern_evidence: prior ? ["A later distinct complaint confirmed the same method family."] : [],
  recurrence_of: prior ? [prior.reflectionId] : []
};
const outputIndex = process.argv.indexOf("--output-last-message");
if (outputIndex < 0 || !process.argv[outputIndex + 1]) process.exit(22);
await writeFile(process.argv[outputIndex + 1], JSON.stringify({ result }), { mode: 0o600 });
await chmod(process.argv[outputIndex + 1], 0o600);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
`, { mode: 0o700 });
  await chmod(file, 0o700);
}

async function writeFrozenClock(file) {
  await writeFile(file, `const fixed = process.env.AFL_PLATFORM_NOW;
if (fixed) {
  const NativeDate = Date;
  const fixedMilliseconds = NativeDate.parse(fixed);
  if (!Number.isFinite(fixedMilliseconds)) throw new Error("invalid_platform_test_clock");
  globalThis.Date = class FrozenDate extends NativeDate {
    constructor(...args) {
      if (args.length === 0) super(fixedMilliseconds);
      else super(...args);
    }
    static now() { return fixedMilliseconds; }
  };
}
`, { mode: 0o600 });
}

async function invokeInstalledHook({ home, paths, payload, env, realProvider }) {
  const commonArgs = ["--event", "UserPromptSubmit", "--cli", "codex", "--continue"];
  if (realProvider) {
    return runProcess(paths.runtimeLauncher, ["hook", "--home", home, ...commonArgs], {
      input: JSON.stringify(payload),
      env,
      cwd: payload.cwd
    });
  }
  return runProcess(paths.coreHook, commonArgs, {
    input: JSON.stringify(payload),
    env: { ...env, HOME: home },
    cwd: payload.cwd
  });
}

function hostResponse(result) {
  assert.equal(result.stderr, "");
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, CONTROL_TEXT);
  return JSON.parse(result.stdout);
}

async function publishAdditionalFamilies(projectDir, count) {
  const baseline = Date.now() - 5_000;
  const families = [];
  for (let index = 0; index < count; index += 1) {
    const method = `check platform boundary ${index}`;
    const model = validateReflectionModel({
      outcome: "lesson",
      final_severity: "Blocker",
      responsibility: "agent_fault",
      method_class: `platform_boundary_${index}`,
      family_id: null,
      proposed_family_key: `platform-boundary-${index}`,
      applies_when: [TOP_FOUR_PROMPT],
      facts: [`Platform boundary ${index} was verified with local filesystem evidence.`],
      user_complaint: `Platform boundary ${index} was missed.`,
      root_cause: `Platform boundary ${index} was not checked before execution.`,
      class_of_mistake: `platform boundary ${index} omitted`,
      method_changes: [method],
      repeated_pattern_evidence: [],
      recurrence_of: []
    }, {
      sourceIdentity: `task15-platform-source-${index}`,
      createdAt: new Date(baseline + index * 100).toISOString(),
      publishedAt: new Date(baseline + index * 100 + 1).toISOString()
    });
    const published = await publishReflectionDocument({ projectDir, model });
    families.push({ index, method, published });
  }
  return families;
}

function guidanceHashes(guidance) {
  return [...guidance.matchAll(/^document_hash: ([a-f0-9]{64})$/gmu)].map((match) => match[1]);
}

function guidanceMethods(guidance) {
  return [...guidance.matchAll(/^1\. (.+)$/gmu)].map((match) => match[1]);
}

async function publishCutoffFamily(projectDir, publishedAt) {
  const model = validateReflectionModel({
    outcome: "lesson",
    final_severity: "Critical",
    responsibility: "agent_fault",
    method_class: "platform_cutoff_boundary",
    family_id: null,
    proposed_family_key: "platform-cutoff-boundary",
    applies_when: [CUTOFF_PROMPT],
    facts: ["The exact prompt cutoff boundary was verified with a fixed clock."],
    user_complaint: "The current-cutoff document was not isolated from later prompts.",
    root_cause: "The platform test did not control the hook clock and publication timestamp together.",
    class_of_mistake: "current cutoff boundary omitted",
    method_changes: ["exclude exact-cutoff guidance until a later prompt"],
    repeated_pattern_evidence: [],
    recurrence_of: []
  }, {
    sourceIdentity: "task15-platform-cutoff-source",
    createdAt: publishedAt,
    publishedAt
  });
  return publishReflectionDocument({ projectDir, model });
}

test("canonical hard-link visibility after a prompt cutoff is omitted without changing adoption identity", async (t) => {
  assert.match(process.platform, /^(?:darwin|linux)$/u);
  const projectDir = await realpath(await mkdtemp(path.join(tmpdir(), "afl-cutoff-visibility-")));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const publishedAt = new Date(Date.now() - 2_000).toISOString();
  let releasePublication;
  const publicationHeld = new Promise((resolve) => { releasePublication = resolve; });
  let publicationReached;
  const publicationReady = new Promise((resolve) => { publicationReached = resolve; });
  const model = validateReflectionModel({
    outcome: "lesson",
    final_severity: "Critical",
    responsibility: "agent_fault",
    method_class: "platform_cutoff_visibility",
    family_id: null,
    proposed_family_key: "platform-cutoff-visibility",
    applies_when: [CUTOFF_PROMPT],
    facts: ["Canonical visibility must be fenced separately from stable identity metadata."],
    user_complaint: "A document published after this prompt started must not guide it.",
    root_cause: "Published metadata precedes the hard-link visibility fence.",
    class_of_mistake: "current cutoff visibility leak",
    method_changes: ["Require target visibility before selection"],
    repeated_pattern_evidence: [],
    recurrence_of: []
  }, {
    sourceIdentity: "platform-cutoff-visibility-source",
    createdAt: publishedAt,
    publishedAt
  });
  const publishing = publishReflectionDocument({
    projectDir,
    model,
    beforeRename: async () => {
      publicationReached();
      await publicationHeld;
    }
  });
  await publicationReady;
  const cutoff = new Date().toISOString();
  await sleep(25);
  releasePublication();
  const published = await publishing;

  const current = await loadReflectionDocuments({ projectDir, publishedBefore: cutoff });
  assert.equal(current.documents.length, 0);
  assert.equal(current.omissions.some((item) => item.reason === "published_after_cutoff"), true);

  const laterCutoff = new Date(Date.now() + 1_000).toISOString();
  const later = await loadReflectionDocuments({ projectDir, publishedBefore: laterCutoff });
  assert.equal(later.documents.length, 1);
  assert.equal(later.documents[0].path, published.path);
  assert.equal(later.documents[0].documentHash, published.sha256);

  const adopted = await publishReflectionDocument({ projectDir, model });
  assert.deepEqual(adopted, { path: published.path, sha256: published.sha256, created: false });
  const currentAfterAdoption = await loadReflectionDocuments({ projectDir, publishedBefore: cutoff });
  const laterAfterAdoption = await loadReflectionDocuments({ projectDir, publishedBefore: laterCutoff });
  assert.equal(currentAfterAdoption.documents.length, 0);
  assert.equal(laterAfterAdoption.documents[0].documentHash, published.sha256);
});

test("installed prompt pipeline publishes and reuses reflection guidance on the host platform", async (t) => {
  assert.match(process.platform, /^(?:darwin|linux)$/u);
  const realProvider = process.env.AFL_REAL_PROVIDER === "1";
  const suppliedHome = process.env.AFL_SMOKE_HOME;
  const ownsHome = !suppliedHome;
  const home = await realpath(suppliedHome || await mkdtemp(path.join(tmpdir(), "afl-platform-home-")));
  const projectDir = await realpath(await mkdtemp(path.join(home, "afl-platform-project-")));
  const fakeBin = realProvider ? null : await realpath(await mkdtemp(path.join(home, "afl-platform-bin-")));
  let providerRelease = null;
  const paths = pathsFor(home);
  if (ownsHome) await install({ home, codexHost: unavailableCodexHost() });
  else await access(paths.runtimeLauncher);
  t.after(async () => {
    if (providerRelease) await writeFile(providerRelease, "release", { mode: 0o600 }).catch(() => {});
    if (ownsHome) await rm(home, { recursive: true, force: true });
    else await Promise.all([
      rm(projectDir, { recursive: true, force: true }),
      ...(fakeBin ? [rm(fakeBin, { recursive: true, force: true })] : [])
    ]);
  });

  const env = { ...process.env, TMPDIR: home };
  if (realProvider) {
    if (!await resolveReviewerExecutable({ cli: "codex", env: { PATH: env.PATH || "" } })) {
      throw new Error("real_provider_unavailable");
    }
  } else {
    const fakeProvider = path.join(fakeBin, "codex");
    const providerStarted = path.join(fakeBin, "provider-started");
    providerRelease = path.join(fakeBin, "provider-release");
    const frozenClock = path.join(fakeBin, "frozen-clock.mjs");
    await writeDeterministicProvider(fakeProvider, { providerStarted, providerRelease });
    await writeFrozenClock(frozenClock);
    env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH || ""}`;
    env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(frozenClock).href}`].filter(Boolean).join(" ");
    env.AFL_PLATFORM_PROVIDER_STARTED = providerStarted;
    env.AFL_PLATFORM_PROVIDER_RELEASE = providerRelease;
  }

  const neutral = await invokeInstalledHook({
    home,
    paths,
    payload: hookPayload({
      projectDir,
      sessionId: "platform-neutral-session",
      eventId: "platform-neutral-event",
      turnId: "platform-neutral-turn",
      prompt: NEUTRAL_REVIEWER_QUESTION
    }),
    env,
    realProvider
  });
  assert.deepEqual(hostResponse(neutral), { continue: true });
  assert.equal(reviewJobs(paths).length, 0);
  assert.equal((await reflectionFiles(projectDir)).length, 0);

  const firstPromptPending = invokeInstalledHook({
    home,
    paths,
    payload: hookPayload({
      projectDir,
      sessionId: "platform-feedback-session-1",
      eventId: "platform-feedback-event-1",
      turnId: "platform-feedback-turn-1",
      prompt: EXPLICIT_FEEDBACK
    }),
    env,
    realProvider
  });
  if (!realProvider) {
    await waitFor(
      () => access(env.AFL_PLATFORM_PROVIDER_STARTED).then(() => true, () => false),
      { timeoutMs: 5_000, failureCode: "deterministic_provider_started_timeout" }
    );
  }
  const firstPrompt = await firstPromptPending;
  assert.equal(firstPrompt.elapsedMs < 2_000, true);
  assert.deepEqual(hostResponse(firstPrompt), { continue: true });
  assert.equal(reviewJobs(paths).length, 1);
  if (!realProvider) {
    assert.equal((await reflectionFiles(projectDir)).length, 0);
    await writeFile(providerRelease, "release", { mode: 0o600 });
  }

  const firstDocuments = await waitFor(async () => {
    const documents = await parsedReflections(projectDir);
    const jobs = reviewJobs(paths);
    const [job] = jobs;
    if (realProvider && job?.error_code === "provider_unavailable") throw new Error("real_provider_unavailable");
    if (realProvider && job?.state === "reviewed_no_lesson") throw new Error("real_provider_no_lesson");
    if (documents.length === 1 && jobs.length === 1 && jobs.every((current) => current.state === "published")) {
      return documents;
    }
    return null;
  }, { timeoutMs: realProvider ? 190_000 : 10_000, failureCode: realProvider ? "real_provider_timeout" : "deterministic_provider_timeout" });
  assert.deepEqual(reviewJobs(paths).map((job) => job.state), ["published"]);
  const firstDocument = firstDocuments[0];
  assert.equal(firstDocument.parsed.eligible, true);
  assert.equal(firstDocument.parsed.canonical, true);

  const matchingPrompt = firstDocument.parsed.appliesWhen.join(" ");
  const firstMatching = await invokeInstalledHook({
    home,
    paths,
    payload: hookPayload({
      projectDir,
      sessionId: "platform-guidance-session",
      eventId: "platform-guidance-event-1",
      turnId: "platform-guidance-turn-1",
      prompt: matchingPrompt
    }),
    env,
    realProvider
  });
  const firstMatchingResponse = hostResponse(firstMatching);
  assert.match(firstMatchingResponse.hookSpecificOutput.additionalContext, new RegExp(realProvider ? "method_changes:" : FIRST_METHOD, "u"));
  assert.equal(emittedRows(paths).length, 1);

  if (realProvider) return;

  await sleep(25);
  const repeatedPrompt = await invokeInstalledHook({
    home,
    paths,
    payload: hookPayload({
      projectDir,
      sessionId: "platform-feedback-session-2",
      eventId: "platform-feedback-event-2",
      turnId: "platform-feedback-turn-2",
      prompt: REPEATED_FEEDBACK
    }),
    env,
    realProvider: false
  });
  assert.equal(repeatedPrompt.elapsedMs < 2_000, true);
  assert.deepEqual(hostResponse(repeatedPrompt), { continue: true });
  assert.equal(reviewJobs(paths).length, 2);

  const documents = await waitFor(async () => {
    const current = await parsedReflections(projectDir);
    const jobs = reviewJobs(paths);
    return current.length === 2 && jobs.length === 2 && jobs.every((job) => job.state === "published")
      ? current
      : null;
  }, { timeoutMs: 10_000, failureCode: "deterministic_recurrence_timeout" });
  assert.deepEqual(reviewJobs(paths).map((job) => job.state), ["published", "published"]);
  const recurrence = documents.find((document) => document.parsed.effectiveness === "recurrence_after_emission");
  assert.ok(recurrence);
  assert.equal(recurrence.parsed.familyId, firstDocument.parsed.familyId);
  assert.deepEqual(await readFile(firstDocument.file), firstDocument.bytes);

  const latestMatching = await invokeInstalledHook({
    home,
    paths,
    payload: hookPayload({
      projectDir,
      sessionId: "platform-guidance-session",
      eventId: "platform-guidance-event-2",
      turnId: "platform-guidance-turn-2",
      prompt: matchingPrompt
    }),
    env,
    realProvider: false
  });
  const latestGuidance = hostResponse(latestMatching).hookSpecificOutput.additionalContext;
  assert.match(latestGuidance, new RegExp(SECOND_METHOD, "u"));
  assert.doesNotMatch(latestGuidance, new RegExp(FIRST_METHOD, "u"));

  const cutoffPublishedAt = CUTOFF_INSTANT;
  const cutoffDocument = await publishCutoffFamily(projectDir, cutoffPublishedAt);
  assert.equal(
    parseReflectionMarkdown(await readFile(cutoffDocument.path, "utf8"), { path: cutoffDocument.path }).publishedAt,
    cutoffPublishedAt
  );
  env.AFL_PLATFORM_NOW = cutoffPublishedAt;
  const currentCutoffPrompt = await invokeInstalledHook({
    home,
    paths,
    payload: hookPayload({
      projectDir,
      sessionId: "platform-cutoff-current-session",
      eventId: "platform-cutoff-current-event",
      turnId: "platform-cutoff-current-turn",
      prompt: CUTOFF_PROMPT,
      taskFingerprint: "platform-cutoff-task"
    }),
    env,
    realProvider: false
  });
  assert.equal("hookSpecificOutput" in hostResponse(currentCutoffPrompt), false);

  env.AFL_PLATFORM_NOW = new Date(Date.parse(cutoffPublishedAt) + 1).toISOString();
  const laterCutoffPrompt = await invokeInstalledHook({
    home,
    paths,
    payload: hookPayload({
      projectDir,
      sessionId: "platform-cutoff-later-session",
      eventId: "platform-cutoff-later-event",
      turnId: "platform-cutoff-later-turn",
      prompt: CUTOFF_PROMPT,
      taskFingerprint: "platform-cutoff-task"
    }),
    env,
    realProvider: false
  });
  assert.match(hostResponse(laterCutoffPrompt).hookSpecificOutput.additionalContext, new RegExp(cutoffDocument.sha256, "u"));
  delete env.AFL_PLATFORM_NOW;

  const topFamilies = await publishAdditionalFamilies(projectDir, 5);
  const expectedTopFour = [topFamilies[4], topFamilies[3], topFamilies[2], topFamilies[1]];
  const fiveFamilyPrompt = await invokeInstalledHook({
    home,
    paths,
    payload: hookPayload({
      projectDir,
      sessionId: "platform-top-four-session",
      eventId: "platform-top-four-event",
      turnId: "platform-top-four-turn",
      prompt: TOP_FOUR_PROMPT,
      taskFingerprint: "platform-top-four-task"
    }),
    env,
    realProvider: false
  });
  const fiveFamilyResponse = hostResponse(fiveFamilyPrompt);
  assert.equal("hold" in fiveFamilyResponse, false);
  const firstTopFourGuidance = fiveFamilyResponse.hookSpecificOutput.additionalContext;
  assert.deepEqual(guidanceHashes(firstTopFourGuidance), expectedTopFour.map((family) => family.published.sha256));
  assert.deepEqual(guidanceMethods(firstTopFourGuidance), expectedTopFour.map((family) => family.method));
  assert.doesNotMatch(firstTopFourGuidance, new RegExp(topFamilies[0].published.sha256, "u"));

  const repeatedFiveFamilyPrompt = await invokeInstalledHook({
    home,
    paths,
    payload: hookPayload({
      projectDir,
      sessionId: "platform-top-four-session-later",
      eventId: "platform-top-four-event-later",
      turnId: "platform-top-four-turn-later",
      prompt: TOP_FOUR_PROMPT,
      taskFingerprint: "platform-top-four-task"
    }),
    env,
    realProvider: false
  });
  const repeatedTopFourGuidance = hostResponse(repeatedFiveFamilyPrompt).hookSpecificOutput?.additionalContext || "";
  assert.deepEqual(guidanceHashes(repeatedTopFourGuidance), expectedTopFour.map((family) => family.published.sha256));
  assert.deepEqual(guidanceMethods(repeatedTopFourGuidance), expectedTopFour.map((family) => family.method));
  assert.doesNotMatch(repeatedTopFourGuidance, new RegExp(topFamilies[0].published.sha256, "u"));
  assert.equal(reviewJobs(paths).length, 2);
});
