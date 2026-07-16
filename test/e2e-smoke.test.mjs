import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

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

async function waitFor(check, { timeoutMs = 5_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
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

test("installed Stop hook never forwards an internal receipt decision", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-stop-forward-"));
  await install({ home });
  const paths = pathsFor(home);
  const store = openStore({ paths });
  const event = {
    event_uid: "installed-stop-forward-event",
    session_uid: "codex:default:installed-stop-forward-session",
    event_seq: 1,
    context_epoch: 1,
    project_id: "/tmp/installed-stop-forward",
    source_event_id: "installed-stop-forward-event",
    role: "user",
    redacted_text: "forward the transactional result",
    content_hash: "installed-stop-forward-hash",
    capture_policy_revision: 1,
    data_class: "normal"
  };
  store.captureSessionEvent(event);
  store.createNotification({
    sessionUid: event.session_uid,
    contextEpoch: 1,
    kind: "candidate_captured",
    eventUid: event.event_uid,
    payload: {},
    language: "en"
  });
  store.claimChatNotification({ sessionUid: event.session_uid, contextEpoch: 1, nativeTurnId: "turn-1" });
  store.close();

  const result = await runStopHook(paths.stopHook, JSON.stringify({
    session_id: "installed-stop-forward-session",
    turn_id: "turn-1",
    cwd: "/tmp/installed-stop-forward",
    last_assistant_message: "Completed without the receipt."
  }), { ...process.env, HOME: home, TMPDIR: home }, "codex");

  assert.deepEqual(JSON.parse(result.stdout), { continue: true });
});

test("installed Stop hook fail-opens malformed capture input with bounded diagnostics", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-stop-invalid-"));
  await install({ home });
  const paths = pathsFor(home);
  const logFile = path.join(paths.dataRoot, "logs", "runtime.log");

  for (const mode of ["codex", "claude", "gemini"]) {
    const result = await runStopHook(paths.stopHook, '{"session_id":"do-not-log"', {
      ...process.env,
      HOME: home,
      TMPDIR: home
    }, mode);
    assert.deepEqual(JSON.parse(result.stdout), mode === "codex" ? { continue: true } : {});
  }

  const log = await readFile(logFile, "utf8");
  assert.match(log, /hook\.non_interference event=stop result=pass capture=failed reason=invalid_input/);
  assert.doesNotMatch(log, /do-not-log|SyntaxError|Unexpected end|JSON/);
});

test("installed Stop hook fail-opens capture storage failure with bounded diagnostics", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-stop-capture-failure-"));
  await install({ home });
  const paths = pathsFor(home);
  await rm(paths.blobRoot, { recursive: true, force: true });
  await mkdir(path.dirname(paths.blobRoot), { recursive: true });
  await writeFile(paths.blobRoot, "not-a-directory", { mode: 0o600 });

  const result = await runStopHook(paths.stopHook, JSON.stringify({
    session_id: "capture-failure-session",
    turn_id: "turn-1",
    cwd: "/tmp/capture-failure",
    last_assistant_message: "sensitive capture payload"
  }), { ...process.env, HOME: home, TMPDIR: home }, "codex");

  assert.deepEqual(JSON.parse(result.stdout), { continue: true });
  const log = await readFile(path.join(paths.dataRoot, "logs", "runtime.log"), "utf8");
  assert.match(log, /hook\.non_interference event=stop result=pass capture=failed reason=capture_failed/);
  assert.doesNotMatch(log, /sensitive capture payload|ENOTDIR|not a directory/i);
});

test("installed Stop hook times out behind a busy SQLite writer and still passes", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-stop-sqlite-busy-"));
  await install({ home });
  const paths = pathsFor(home);
  const initialized = openStore({ paths });
  initialized.close();
  const lock = new DatabaseSync(paths.storeFile);
  lock.exec("BEGIN IMMEDIATE");
  try {
    const result = await runStopHook(paths.stopHook, JSON.stringify({
      session_id: "sqlite-busy-session",
      turn_id: "turn-1",
      cwd: "/tmp/sqlite-busy",
      last_assistant_message: "Done."
    }), {
      ...process.env,
      HOME: home,
      TMPDIR: home,
      AGENT_FEEDBACK_LOOP_STOP_CAPTURE_TIMEOUT_MS: "100"
    }, "codex");
    assert.deepEqual(JSON.parse(result.stdout), { continue: true });
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
  }
  const log = await readFile(path.join(paths.dataRoot, "logs", "runtime.log"), "utf8");
  assert.match(log, /hook\.non_interference event=stop result=pass capture=failed reason=capture_timeout/);
  assert.doesNotMatch(log, /SQLITE_BUSY|database is locked/i);
});

test("same-turn steering starts review only after the transcript assistant referent is durable", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-steering-referent-"));
  await install({ home });
  const paths = pathsFor(home);
  const transcript = path.join(home, "steering.jsonl");
  await writeFile(transcript, [
    JSON.stringify({ timestamp: "2026-07-14T12:00:00.000Z", type: "turn_context", payload: { turn_id: "turn-active", cwd: "/tmp/steering-referent" } }),
    JSON.stringify({ timestamp: "2026-07-14T12:00:05.000Z", type: "response_item", payload: { id: "msg-steering-user", type: "message", role: "user", content: [{ type: "input_text", text: "send the preview" }] } }),
    JSON.stringify({ timestamp: "2026-07-14T12:00:10.000Z", type: "response_item", payload: { id: "msg-steering-assistant", type: "message", role: "assistant", content: [{ type: "output_text", text: "I will send it to the project group" }] } })
  ].join("\n"), { mode: 0o600 });
  const reviewer = path.join(home, "referent-reviewer.mjs");
  await writeFile(reviewer, `#!/usr/bin/env node
import fs from 'node:fs';
const context=JSON.parse(fs.readFileSync(process.env.AFL_REVIEW_CONTEXT_FILE,'utf8'));
const referent=context.events.find((event)=>event.role==='assistant'&&event.redacted_text.includes('project group'));
const correction=context.events.find((event)=>event.role==='user'&&event.redacted_text.includes('only to me'));
if(!referent||!correction)process.exit(7);
process.stdout.write(JSON.stringify({write_complete:true,review_receipt_id:'referent-receipt',report_content_id:'referent-report',report_content:'The same-turn correction and its preceding assistant referent were both reviewed.',status:'reviewed_no_lesson',lessons:[]}));
`, { mode: 0o700 });
  await chmod(reviewer, 0o700);
  const env = {
    ...process.env,
    HOME: home,
    TMPDIR: home,
    AGENT_FEEDBACK_LOOP_REVIEWER_COMMAND: reviewer,
    AGENT_FEEDBACK_LOOP_REVIEWER_TIMEOUT_MS: "5000",
    AGENT_FEEDBACK_LOOP_REVIEW_COOLDOWN: "0"
  };

  const result = await runHook(paths.coreHook, JSON.stringify({
    session_id: "steering-session",
    turn_id: "turn-active",
    cwd: "/tmp/steering-referent",
    transcript_path: transcript,
    timestamp: "2026-07-14T12:00:20.000Z",
    prompt: "do not send it to the group; send it only to me"
  }), env);
  const immediate = JSON.parse(result.stdout);
  assert.match(immediate.hookSpecificOutput.additionalContext, /correction checkpoint/i);
  assert.match(immediate.hookSpecificOutput.additionalContext, /apply the user's correction now/i);
  assert.doesNotMatch(immediate.hookSpecificOutput.additionalContext, /full causal|5[- ]why|report_content/i);
  await waitFor(() => {
    const store = openStore({ paths });
    try { return store.getReportContent("referent-report"); } finally { store.close(); }
  });
  const completed = openStore({ paths });
  const events = completed.listSessionEvents("/tmp/steering-referent");
  assert.deepEqual(events.map((event) => event.role), ["assistant", "user"]);
  assert.equal(events[0].capture_completeness, "transcript_visible_assistant");
  completed.close();
  const runtimeLog = await readFile(path.join(paths.dataRoot, "logs", "runtime.log"), "utf8");
  assert.match(runtimeLog, /hook\.outcome signal=active_turn_steering immediate=1 cards=0/);
  assert.match(runtimeLog, /agent-feedback-loop: \d{4}-\d{2}-\d{2}T[^ ]+ reviewer\.job\.complete job=/);
  assert.doesNotMatch(runtimeLog, /send it only to me/);
});

test("reconcile command repairs a stale Codex thread and completes review in a detached process", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-reconcile-e2e-"));
  await install({ home, codexHost: { synchronize: async () => ({ available: false, configured: true, runnable: false, status: "test" }) } });
  const paths = pathsFor(home);
  const sessions = path.join(home, ".codex", "sessions", "2026", "07", "14");
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  const transcript = path.join(sessions, "rollout-stale-e2e.jsonl");
  const line = (timestamp, type, payload) => `${JSON.stringify({ timestamp, type, payload })}\n`;
  await writeFile(transcript, [
    line("2026-07-14T12:00:00.000Z", "turn_context", { turn_id: "turn-1", cwd: "/tmp/stale-e2e" }),
    line("2026-07-14T12:00:00.010Z", "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "perform the action" }] }),
    line("2026-07-14T12:00:10.000Z", "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "I chose the wrong destination" }] }),
    line("2026-07-14T12:00:20.000Z", "event_msg", { type: "turn_aborted", turn_id: "turn-1" }),
    line("2026-07-14T12:00:25.000Z", "turn_context", { turn_id: "turn-2", cwd: "/tmp/stale-e2e" }),
    line("2026-07-14T12:00:25.010Z", "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "use the direct destination instead" }] })
  ].join(""), { mode: 0o600 });
  const state = new DatabaseSync(path.join(home, ".codex", "state_5.sqlite"));
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, updated_at_ms INTEGER, source TEXT, thread_source TEXT, cwd TEXT, cli_version TEXT)");
  state.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)").run("stale-e2e", transcript, Date.now(), "vscode", "user", "/tmp/stale-e2e", "0.142.5");
  state.close();

  const reviewer = path.join(home, "reviewer.mjs");
  await writeFile(reviewer, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({write_complete:true,review_receipt_id:'stale-e2e-receipt',report_content_id:'stale-e2e-report',report_content:'No durable lesson: synthetic reconciliation canary.',status:'reviewed_no_lesson',lessons:[]}));\n`, { mode: 0o700 });
  await chmod(reviewer, 0o700);

  const run = await execFileAsync(process.execPath, ["bin/agent-feedback-loop.mjs", "reconcile", "--home", home], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      HOME: home,
      AGENT_FEEDBACK_LOOP_REVIEWER_COMMAND: reviewer,
      AGENT_FEEDBACK_LOOP_REVIEWER_TIMEOUT_MS: "5000",
      AGENT_FEEDBACK_LOOP_RECONCILE_LOOKBACK: "3600"
    }
  });
  const output = JSON.parse(run.stdout);
  assert.equal(output.immediateSignals, 1);
  assert.equal(output.reviewersLaunched, 1);

  await waitFor(() => {
    const store = openStore({ paths });
    try {
      return store.getReportContent("stale-e2e-report");
    } finally {
      store.close();
    }
  });
  const completed = openStore({ paths });
  assert.equal(completed.pendingReviewEventCount("/tmp/stale-e2e"), 0);
  assert.match(completed.getReportContent("stale-e2e-report").content_text, /synthetic reconciliation canary/);
  completed.close();
});

test("reconcile daemon escalates to SIGKILL when a scheduled child ignores SIGTERM", { timeout: 10_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-daemon-stop-"));
  await install({ home, codexHost: { synchronize: async () => ({ available: false, configured: true, runnable: false, status: "test" }) } });
  const paths = pathsFor(home);
  const childPidFile = path.join(home, "scheduled-child.pid");
  await writeFile(paths.runtimeLauncher, `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));
process.on('SIGTERM',()=>{});
process.on('SIGINT',()=>{});
setInterval(()=>{},1000);
`, { mode: 0o700 });
  await chmod(paths.runtimeLauncher, 0o700);
  const daemon = spawn(process.execPath, ["bin/agent-feedback-loop.mjs", "reconcile-daemon", "--home", home], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, HOME: home, AGENT_FEEDBACK_LOOP_RECONCILE_INTERVAL: "30" },
    stdio: "ignore"
  });
  let childPid = null;
  try {
    childPid = await waitFor(async () => {
      try { return Number(await readFile(childPidFile, "utf8")); } catch { return null; }
    });
    const exited = new Promise((resolve) => daemon.once("close", (code, signal) => resolve({ code, signal })));
    daemon.kill("SIGTERM");
    const result = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve(null), 4_500))
    ]);
    assert.ok(result, "daemon must not wait forever for an uncooperative scheduled child");
  } finally {
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
    if (childPid) {
      try { process.kill(childPid, "SIGKILL"); } catch {}
      try { process.kill(-childPid, "SIGKILL"); } catch {}
    }
  }
});

test("reviewer-run auto-selects an isolated Codex provider without a user command", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-provider-e2e-"));
  await install({ home, codexHost: { synchronize: async () => ({ available: false, configured: true, runnable: false, status: "test" }) } });
  const paths = pathsFor(home);
  const store = openStore({ paths });
  store.captureSessionEvent({ event_uid: "provider-e2e-user", session_uid: "provider-e2e-session", event_seq: 1, context_epoch: 1, project_id: "/tmp/provider-e2e", source_event_id: "provider-e2e-user", role: "user", redacted_text: "synthetic feedback", content_hash: "provider-e2e-hash", capture_policy_revision: 1, data_class: "normal" });
  const job = store.submitDueReview({ projectId: "/tmp/provider-e2e", minEntries: 1, cooldownMs: 0 });
  store.close();

  const fakeCodex = path.join(home, "fake-codex.mjs");
  await writeFile(fakeCodex, `#!/usr/bin/env node\nlet input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(!input.includes('Untrusted Evidence Boundary'))process.exit(9);process.stdout.write(JSON.stringify({write_complete:true,review_receipt_id:'provider-e2e-receipt',report_content_id:'provider-e2e-report',report_content:'Synthetic provider canary completed.',status:'reviewed_no_lesson',lessons:[]}));});\n`, { mode: 0o700 });
  await chmod(fakeCodex, 0o700);

  const run = await execFileAsync(process.execPath, ["bin/agent-feedback-loop.mjs", "reviewer-run", "--home", home, "--job-id", job.job_id, "--provider", "codex", "--timeout-ms", "5000"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, HOME: home, AGENT_FEEDBACK_LOOP_CODEX_COMMAND: fakeCodex }
  });
  assert.equal(JSON.parse(run.stdout).status, "completed");
  const completed = openStore({ paths });
  assert.match(completed.getReportContent("provider-e2e-report").content_text, /provider canary/);
  completed.close();
});

test("real hook creates one pending reviewer job at the due threshold without main-session text", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-review-due-"));
  await install({ home });
  const paths = pathsFor(home);
  const env = {
    ...process.env,
    HOME: home,
    TMPDIR: home,
    AGENT_FEEDBACK_LOOP_REVIEW_MIN_ENTRIES: "3",
    AGENT_FEEDBACK_LOOP_REVIEW_COOLDOWN: "0",
    AGENT_FEEDBACK_LOOP_CODEX_COMMAND: path.join(home, "missing-codex")
  };
  for (const turn of ["1", "2", "3"]) {
    const result = await runHook(paths.coreHook, JSON.stringify({ session_id: "review-session", turn_id: turn, cwd: "/tmp/review-due", prompt: `turn ${turn}` }), env);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output, {});
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
  const reviewer = path.join(home, "closed-loop-reviewer.mjs");
  await writeFile(reviewer, `#!/usr/bin/env node
import fs from 'node:fs';
const context=JSON.parse(fs.readFileSync(process.env.AFL_REVIEW_CONTEXT_FILE,'utf8'));
const complaint='你没有检查真实产物，之前的完成结论不成立';
const feedback=context.events.find((event)=>event.role==='user'&&event.redacted_text===complaint);
const referent=context.events.find((event)=>event.role==='assistant'&&event.redacted_text.includes('不需要再看产物'));
if(!feedback||!referent)process.exit(7);
process.stdout.write(JSON.stringify({
  write_complete:true,
  review_receipt_id:'closed-loop-receipt',
  report_content_id:'closed-loop-report',
  report_content:'用户指出完成结论没有真实产物证据。根因是执行方法把推断当成验收结果。',
  status:'reviewed',
  lessons:[{
    lesson_id:'closed-loop-lesson',revision:1,base_revision:0,project_id:${JSON.stringify(projectId)},severity:'Major',
    responsibility:'agent_fault',confidence:'high',
    causal_chain:['没有读取真实产物','把实现路径当成验收证据','完成结论来自推断','流程没有证据检查点','默认方法优先结束任务而不是证明结果'],
    method_class:'verification-closure',class_id:'completion-without-artifact-evidence',generalizable:true,rule_action:'update_project_rule',
    evidence_refs:[{feedback_event_id:feedback.event_uid,feedback_quote:complaint,referent_event_ids:[referent.event_uid]}],
    scope:{repository_lineage_id:'closed-loop-lineage',task_types:['verification'],paths:[],tools:[],signals:[]},
    card:{when:'对任务给出完成结论前',must_do:'读取并核对真实产物',must_not:'用实现推断代替验收证据',verify:'输出可复核的产物检查结果',why:'先前结论因缺少真实证据被用户否定',exception:'用户明确只要求方案分析',source_ids:['closed-loop-report']}
  }]
}));
`, { mode: 0o700 });
  await chmod(reviewer, 0o700);
  const env = {
    ...process.env,
    HOME: home,
    TMPDIR: home,
    AGENT_FEEDBACK_LOOP_REVIEW_MIN_ENTRIES: "3",
    AGENT_FEEDBACK_LOOP_REVIEW_COOLDOWN: "0",
    AGENT_FEEDBACK_LOOP_REVIEWER_COMMAND: reviewer,
    AGENT_FEEDBACK_LOOP_REVIEWER_TIMEOUT_MS: "5000"
  };
  await runHook(paths.coreHook, JSON.stringify({ session_id: "closed-loop", turn_id: "1", cwd: projectId, prompt: "请检查完成条件" }), env);
  await runStopHook(paths.stopHook, JSON.stringify({ session_id: "closed-loop", turn_id: "1", cwd: projectId, last_assistant_message: "已经完成，不需要再看产物" }), env, "codex");
  await runHook(paths.coreHook, JSON.stringify({ session_id: "closed-loop", turn_id: "2", cwd: projectId, prompt: "继续" }), env);
  await runStopHook(paths.stopHook, JSON.stringify({ session_id: "closed-loop", turn_id: "2", cwd: projectId, last_assistant_message: "我仍然按推断给出了完成结论" }), env, "codex");
  const complaint = "你没有检查真实产物，之前的完成结论不成立";
  const third = JSON.parse((await runHook(paths.coreHook, JSON.stringify({ session_id: "closed-loop", turn_id: "3", cwd: projectId, prompt: complaint }), env)).stdout);
  assert.deepEqual(third, {});
  await waitFor(() => {
    const store = openStore({ paths });
    try { return store.getReportContent("closed-loop-report"); } finally { store.close(); }
  });

  const committed = openStore({ paths });
  assert.equal(committed.pendingReviewEventCount(projectId), 0);
  assert.match(committed.getReportContent("closed-loop-report").content_text, /真实产物证据/);
  assert.equal(committed.listIncidents(projectId).length, 1);
  committed.close();

  const explained = JSON.parse((await execFileAsync(process.execPath, [
    "bin/agent-feedback-loop.mjs", "memory", "explain", "closed-loop", "--home", home
  ], { cwd: path.resolve(import.meta.dirname, ".."), env })).stdout);
  assert.equal(explained.trace.stages.captured, true);
  assert.equal(explained.trace.stages.reviewed, true);
  assert.equal(explained.trace.stages.lesson_compiled, true);
  assert.equal(explained.trace.stages.emitted, false);
  assert.ok(explained.trace.produced_lessons.some((lesson) => lesson.lesson_id === "closed-loop-lesson"));
  assert.equal(explained.trace.events, undefined);
  const verboseExplain = JSON.parse((await execFileAsync(process.execPath, [
    "bin/agent-feedback-loop.mjs", "memory", "explain", "closed-loop", "--verbose", "--home", home
  ], { cwd: path.resolve(import.meta.dirname, ".."), env })).stdout);
  assert.ok(verboseExplain.trace.events.length > 0);
  assert.equal(verboseExplain.trace.events.some((event) => Object.hasOwn(event, "redacted_text")), false);

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
    AGENT_FEEDBACK_LOOP_REVIEWER_ARGS_JSON: JSON.stringify(["-e", "process.stdout.write(JSON.stringify({write_complete:true,review_receipt_id:'detached-r',report_content_id:'detached-report',report_content:'No durable lesson was proven from the detached fixture.',status:'reviewed_no_lesson',lessons:[]}))"])
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
  await writeFile(transcript, [
    JSON.stringify({ type: "turn_context", payload: { prompt: first.hookSpecificOutput.additionalContext } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `verified nonce=${nonce}` }] } })
  ].join("\n"), { mode: 0o600 });
  await runStopHook(paths.stopHook, JSON.stringify({ session_id: "lesson-session", turn_id: "1", cwd: "/tmp/lesson-hook", last_assistant_message: "verified", transcript_path: transcript }), env, "codex");
  const observedStore = openStore({ paths });
  assert.equal(observedStore.getDeliveryByNonce(nonce).state, "observed");
  observedStore.close();
  const second = JSON.parse((await runHook(paths.coreHook, JSON.stringify({ session_id: "lesson-session", turn_id: "2", task_fingerprint: "lesson-task", cwd: "/tmp/lesson-hook", prompt: "continue again" }), env)).stdout);
  assert.deepEqual(second, {});
});

test("real hook retrieves the SSH-over-Termius lesson from a Chinese remote-host prompt without host metadata", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-ssh-memory-hook-"));
  await install({ home });
  const paths = pathsFor(home);
  const projectId = "/tmp/ssh-memory-project";
  const store = openStore({ paths });
  store.upsertLessonRevision({
    lesson_id: "ssh-before-termius",
    revision: 1,
    project_id: projectId,
    severity: "Major",
    scope: {
      task_types: ["remote-environment-testing", "deployment-debugging"],
      paths: [],
      tools: ["ssh", "Termius", "computer-use"],
      signals: ["user says use ssh", "remote host access required"]
    },
    card_json: JSON.stringify({
      when: "需要连接用户已有服务器、公司主机、现场机器或真机环境时",
      must_do: "优先使用既有 SSH 入口",
      must_not: "不要默认启用 Termius",
      verify: "保留 SSH 连接证据",
      why: "远程访问方式是已有项目约定",
      exception: "用户明确要求 GUI 时除外",
      source_ids: ["prior-ssh-incident"]
    })
  }, 0);
  store.promoteLesson({ lessonId: "ssh-before-termius", projectId });
  store.close();

  const response = JSON.parse((await runHook(paths.coreHook, JSON.stringify({
    session_id: "remote-host-task",
    turn_id: "1",
    cwd: projectId,
    prompt: "现在连接的服务器环境就是公司主机，本机作为现场桥接笔记本"
  }), { ...process.env, HOME: home, TMPDIR: home })).stdout);
  assert.match(response.hookSpecificOutput.additionalContext, /优先使用既有 SSH 入口/);
  assert.match(response.hookSpecificOutput.additionalContext, /不要默认启用 Termius/);

  const delivered = openStore({ paths });
  const trace = delivered.explainMemory("remote-host-task");
  assert.equal(trace.stages.lesson_compiled, false);
  assert.equal(trace.stages.emitted, false);
  assert.equal(trace.stages.delivered_into_session, true);
  assert.equal(trace.deliveries_into_session[0].lesson_id, "ssh-before-termius");
  delivered.close();
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
  assert.ok(claudeTimeouts.includes(5));
  assert.ok(geminiTimeouts.includes(5000));
});
