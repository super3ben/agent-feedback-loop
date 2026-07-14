import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { install, pathsFor } from "../src/index.mjs";
import { openStore } from "../src/store.mjs";

const execFileAsync = promisify(execFile);

function runHook(file, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, ["--event", "UserPromptSubmit", "--cli", "codex"], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr)));
    child.stdin.end(input);
  });
}

function runStopHook(file, input, env, mode = "claude") {
  return new Promise((resolve, reject) => {
    const child = spawn(file, ["--mode", mode], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr)));
    child.stdin.end(input);
  });
}

test("installed hook captures a real prompt into the durable store", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-e2e-"));
  await install({ home });
  const paths = pathsFor(home);
  const payload = JSON.stringify({ session_id: "live-session", turn_id: "live-turn", cwd: "/tmp/live-project", prompt: "检查 token=secret-value" });
  const result = await runHook(paths.coreHook, payload, { ...process.env, HOME: home, TMPDIR: home, AGENT_FEEDBACK_LOOP_REVIEW_COOLDOWN: "3600", AGENT_FEEDBACK_LOOP_DEBUG: "1" });
  assert.ok(JSON.parse(result.stdout));
  const store = openStore({ paths });
  const events = store.listSessionEvents("/tmp/live-project");
  assert.equal(events.length, 1);
  assert.doesNotMatch(events[0].redacted_text, /secret-value/);
  const runtimeLog = path.join(paths.dataRoot, "logs", "runtime.log");
  assert.equal((await stat(runtimeLog)).mode & 0o777, 0o600);
  const logText = await readFile(runtimeLog, "utf8");
  assert.match(logText, /hook\.capture\.ok/);
  assert.doesNotMatch(logText, /secret-value/);
  store.close();
});

test("installed hook follows an existing capture policy revision", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-policy-hook-"));
  await install({ home });
  const paths = pathsFor(home);
  const store = openStore({ paths });
  store.setCapturePolicy({ enabled: true, revision: 1783926763075 });
  store.close();
  const result = await runHook(paths.coreHook, JSON.stringify({ session_id: "policy-session", turn_id: "1", cwd: "/tmp/policy-project", prompt: "capture" }), { ...process.env, HOME: home, TMPDIR: home });
  assert.deepEqual(JSON.parse(result.stdout), {});
  const reopened = openStore({ paths });
  assert.equal(reopened.listSessionEvents("/tmp/policy-project").length, 1);
  reopened.close();
});

test("installed stop hook captures assistant output as reviewer evidence", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-stop-capture-"));
  await install({ home });
  const paths = pathsFor(home);
  const env = { ...process.env, HOME: home, TMPDIR: home };
  await runHook(paths.coreHook, JSON.stringify({ session_id: "stop-session", turn_id: "1", cwd: "/tmp/stop-project", prompt: "did you verify?" }), env);
  const stop = await runStopHook(paths.stopHook, JSON.stringify({ session_id: "stop-session", turn_id: "1", cwd: "/tmp/stop-project", last_assistant_message: "I claimed success without verification" }), env);
  assert.deepEqual(JSON.parse(stop.stdout), {});
  const store = openStore({ paths });
  const events = store.listSessionEvents("/tmp/stop-project");
  assert.deepEqual(events.map((item) => item.role), ["user", "assistant"]);
  assert.match(events[1].redacted_text, /without verification/);
  store.close();
});

test("real hook creates one pending reviewer job at the due threshold without main-session text", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-review-due-"));
  await install({ home });
  const paths = pathsFor(home);
  const env = { ...process.env, HOME: home, TMPDIR: home, AGENT_FEEDBACK_LOOP_REVIEW_MIN_ENTRIES: "3", AGENT_FEEDBACK_LOOP_REVIEW_COOLDOWN: "0" };
  for (const turn of ["1", "2", "3"]) {
    const result = await runHook(paths.coreHook, JSON.stringify({ session_id: "review-session", turn_id: turn, cwd: "/tmp/review-due", prompt: `turn ${turn}` }), env);
    const output = JSON.parse(result.stdout);
    if (turn === "3") {
      assert.match(output.hookSpecificOutput.additionalContext, /reviewer-context/);
      assert.match(output.hookSpecificOutput.additionalContext, /reflection-agent\.md/);
      assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /completion marker/);
    }
    else assert.deepEqual(output, {});
  }
  const duplicate = JSON.parse((await runHook(paths.coreHook, JSON.stringify({ session_id: "review-session", turn_id: "4", cwd: "/tmp/review-due", prompt: "turn 4" }), env)).stdout);
  assert.deepEqual(duplicate, {});
  const store = openStore({ paths });
  assert.equal(store.pendingReviewEventCount("/tmp/review-due"), 4);
  const job = store.submitDueReview({ projectId: "/tmp/review-due", minEntries: 3, cooldownMs: 0 });
  assert.equal(job.status, "pending");
  assert.equal(job.eventCount, 3);
  store.close();
});

test("three-turn feedback becomes a verified lesson that benefits the next matching task", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-closed-loop-"));
  await install({ home });
  const paths = pathsFor(home);
  const projectId = "/tmp/closed-loop-project";
  const env = {
    ...process.env,
    HOME: home,
    TMPDIR: home,
    AGENT_FEEDBACK_LOOP_REVIEW_MIN_ENTRIES: "3",
    AGENT_FEEDBACK_LOOP_REVIEW_COOLDOWN: "0"
  };
  await runHook(paths.coreHook, JSON.stringify({ session_id: "closed-loop", turn_id: "1", cwd: projectId, prompt: "请检查完成条件" }), env);
  await runStopHook(paths.stopHook, JSON.stringify({ session_id: "closed-loop", turn_id: "1", cwd: projectId, last_assistant_message: "已经完成，不需要再看产物" }), env, "codex");
  await runHook(paths.coreHook, JSON.stringify({ session_id: "closed-loop", turn_id: "2", cwd: projectId, prompt: "继续" }), env);
  await runStopHook(paths.stopHook, JSON.stringify({ session_id: "closed-loop", turn_id: "2", cwd: projectId, last_assistant_message: "我仍然按推断给出了完成结论" }), env, "codex");
  const complaint = "你没有检查真实产物，之前的完成结论不成立";
  const third = JSON.parse((await runHook(paths.coreHook, JSON.stringify({ session_id: "closed-loop", turn_id: "3", cwd: projectId, prompt: complaint }), env)).stdout);
  const injected = third.hookSpecificOutput.additionalContext;
  const capability = injected.match(/reviewer_capability=([A-Za-z0-9_-]+)/)?.[1];
  assert.ok(capability);

  const store = openStore({ paths });
  const job = store.submitDueReview({ projectId, minEntries: 3, cooldownMs: 0 });
  const events = store.listSessionEvents(projectId);
  const feedback = events.find((item) => item.role === "user" && item.redacted_text === complaint);
  const referent = events.find((item) => item.role === "assistant" && /不需要再看产物/.test(item.redacted_text));
  assert.ok(feedback);
  assert.ok(referent);
  store.close();

  const receiptFile = path.join(paths.dataRoot, "reviewer-receipts", `${job.job_id}.json`);
  const receiptTemp = `${receiptFile}.tmp`;
  const receipt = {
    write_complete: true,
    review_receipt_id: "closed-loop-receipt",
    report_content_id: "closed-loop-report",
    report_content: "用户指出完成结论没有真实产物证据。根因是执行方法把推断当成验收结果。",
    status: "reviewed",
    mode: "background_subagent",
    background_agent_id: "e2e-native-subagent",
    reviewer_capability: capability,
    lessons: [{
      lesson_id: "closed-loop-lesson",
      revision: 1,
      base_revision: 0,
      project_id: projectId,
      severity: "Major",
      responsibility: "agent_fault",
      confidence: "high",
      causal_chain: ["没有读取真实产物", "把实现路径当成验收证据", "完成结论来自推断", "流程没有证据检查点", "默认方法优先结束任务而不是证明结果"],
      method_class: "verification-closure",
      class_id: "completion-without-artifact-evidence",
      generalizable: true,
      rule_action: "update_project_rule",
      evidence_refs: [{ feedback_event_id: feedback.event_uid, feedback_quote: complaint, referent_event_ids: [referent.event_uid] }],
      scope: { repository_lineage_id: "closed-loop-lineage", task_types: ["verification"], paths: [], tools: [], signals: [] },
      card: { when: "对任务给出完成结论前", must_do: "读取并核对真实产物", must_not: "用实现推断代替验收证据", verify: "输出可复核的产物检查结果", why: "先前结论因缺少真实证据被用户否定", exception: "用户明确只要求方案分析", source_ids: ["closed-loop-report"] }
    }]
  };
  await writeFile(receiptTemp, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  await rename(receiptTemp, receiptFile);
  await execFileAsync(process.execPath, ["bin/agent-feedback-loop.mjs", "reviewer-submit", "--home", home, "--job-id", job.job_id, "--receipt-file", receiptFile], { cwd: path.resolve(import.meta.dirname, "..") });

  const committed = openStore({ paths });
  assert.equal(committed.pendingReviewEventCount(projectId), 0);
  assert.match(committed.getReportContent("closed-loop-report").content_text, /真实产物证据/);
  assert.equal(committed.listIncidents(projectId).length, 1);
  committed.close();

  const fourth = JSON.parse((await runHook(paths.coreHook, JSON.stringify({ session_id: "closed-loop-next", turn_id: "1", cwd: projectId, task_type: "verification", task_fingerprint: "closed-loop-next-verification", prompt: "再次检查完成条件" }), env)).stdout);
  assert.match(fourth.hookSpecificOutput.additionalContext, /读取并核对真实产物/);
  assert.match(fourth.hookSpecificOutput.additionalContext, /用实现推断代替验收证据/);
});

test("configured reviewer command runs detached and acknowledges the job", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-review-detached-"));
  await install({ home });
  const paths = pathsFor(home);
  const env = {
    ...process.env,
    HOME: home,
    TMPDIR: home,
    AGENT_FEEDBACK_LOOP_REVIEW_MIN_ENTRIES: "3",
    AGENT_FEEDBACK_LOOP_REVIEW_COOLDOWN: "0",
    AGENT_FEEDBACK_LOOP_REVIEWER_COMMAND: process.execPath,
    AGENT_FEEDBACK_LOOP_REVIEWER_ARGS_JSON: JSON.stringify(["-e", "process.stdout.write(JSON.stringify({review_receipt_id:'detached-r',report_content_id:'detached-report',status:'reviewed_no_lesson',lessons:[]}))"])
  };
  for (const turn of ["1", "2", "3"]) {
    const result = await runHook(paths.coreHook, JSON.stringify({ session_id: "detached-session", turn_id: turn, cwd: "/tmp/detached-review", prompt: `turn ${turn}` }), env);
    assert.deepEqual(JSON.parse(result.stdout), {});
  }
  let acknowledged = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const store = openStore({ paths });
    acknowledged = store.pendingReviewEventCount("/tmp/detached-review") === 0;
    store.close();
    if (acknowledged) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(acknowledged, true);
});

test("hook injects a stored lesson once and records emitted delivery", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-lesson-hook-"));
  await install({ home });
  const paths = pathsFor(home);
  const store = openStore({ paths });
  store.upsertLessonRevision({
    lesson_id: "lesson-hook",
    revision: 1,
    base_revision: 0,
    project_id: "/tmp/lesson-hook",
    severity: "Critical",
    card_json: JSON.stringify({ when: "working on lesson-hook", must_do: "verify the real artifact", must_not: "claim success without evidence", verify: "read the registered result", why: "the prior process skipped verification", exception: "none", source_ids: ["report-hook"] })
  }, 0);
  store.promoteLesson({ lessonId: "lesson-hook", projectId: "/tmp/lesson-hook" });
  store.close();
  const env = { ...process.env, HOME: home, TMPDIR: home, AGENT_FEEDBACK_LOOP_REVIEW_COOLDOWN: "3600" };
  const first = JSON.parse((await runHook(paths.coreHook, JSON.stringify({ session_id: "lesson-session", turn_id: "1", task_fingerprint: "lesson-task", cwd: "/tmp/lesson-hook", prompt: "continue" }), env)).stdout);
  assert.match(first.hookSpecificOutput.additionalContext, /verify the real artifact/);
  const nonce = first.hookSpecificOutput.additionalContext.match(/nonce=([a-f0-9]+)/)[1];
  const transcript = path.join(home, "lesson-transcript.jsonl");
  await writeFile(transcript, JSON.stringify({ system: first.hookSpecificOutput.additionalContext }), { mode: 0o600 });
  await runStopHook(paths.stopHook, JSON.stringify({ session_id: "lesson-session", turn_id: "1", cwd: "/tmp/lesson-hook", last_assistant_message: "verified", transcript_path: transcript }), env, "codex");
  const observedStore = openStore({ paths });
  assert.equal(observedStore.getDeliveryByNonce(nonce).state, "observed");
  observedStore.close();
  const second = JSON.parse((await runHook(paths.coreHook, JSON.stringify({ session_id: "lesson-session", turn_id: "2", task_fingerprint: "lesson-task", cwd: "/tmp/lesson-hook", prompt: "continue again" }), env)).stdout);
  assert.deepEqual(second, {});
});

test("CLI live doctor runs an isolated synthetic canary", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-doctor-"));
  await install({ home });
  const result = await execFileAsync(process.execPath, ["bin/agent-feedback-loop.mjs", "doctor", "--home", home, "--live"], { cwd: path.resolve(import.meta.dirname, "..") });
  const parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf("{\n")));
  assert.equal(parsed.live.status, "healthy");
  assert.equal(parsed.live.syntheticExcluded, true);
  assert.equal(parsed.capability.status, "healthy");
});

test("installed hook manifests preserve native timeout units", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-timeouts-"));
  await install({ home });
  const claude = JSON.parse(await readFile(path.join(home, ".claude", "settings.json"), "utf8"));
  const gemini = JSON.parse(await readFile(path.join(home, ".gemini", "settings.json"), "utf8"));
  const claudeTimeouts = claude.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks).map((hook) => hook.timeout);
  const geminiTimeouts = gemini.hooks.BeforeAgent.flatMap((entry) => entry.hooks).map((hook) => hook.timeout);
  assert.ok(claudeTimeouts.includes(2));
  assert.ok(geminiTimeouts.includes(2000));
});
