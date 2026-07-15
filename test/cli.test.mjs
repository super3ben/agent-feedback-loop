import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { doctor, install, pathsFor, uninstall } from "../src/index.mjs";
import { openStore } from "../src/store.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "bin", "agent-feedback-loop.mjs");

async function tempHome() {
  return mkdtemp(path.join(tmpdir(), "afl-home-"));
}

async function readText(file) {
  return readFile(file, "utf8");
}

function runWithInput(file, input, env, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${file} exited ${code}: ${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}

describe("agent-feedback-loop package", () => {
  it("synchronizes Codex trust after writing its managed hook block", async () => {
    const home = await tempHome();
    const calls = [];
    const codexHost = {
      async synchronize(input) {
        calls.push(input);
        return {
          available: true,
          configured: true,
          runnable: true,
          status: "trusted",
          prompt: { trustStatus: "trusted", enabled: true },
          backstop: { trustStatus: "trusted", enabled: true }
        };
      }
    };

    const result = await install({ home, cwd: home, codexHost });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].home, home);
    assert.match(calls[0].promptCommand, /core-hook\.sh/);
    assert.match(calls[0].backstopCommand, /stop-hook\.sh/);
    assert.ok(result.actions.some((action) => /newly spawned app-server/i.test(action)));
    assert.ok(result.actions.some((action) => /already-running Desktop tasks.*transcript reconciliation/i.test(action)));
  });

  it("doctor reports a configured but modified Codex hook as non-runnable", async () => {
    const home = await tempHome();
    await install({ home, codexHost: { synchronize: async () => ({ available: false, configured: true, runnable: false, status: "unavailable" }) } });
    const codexHost = {
      async inspect() {
        return {
          available: true,
          configured: true,
          runnable: false,
          status: "modified",
          prompt: { found: true, trustStatus: "modified", enabled: true },
          backstop: { found: true, trustStatus: "modified", enabled: true }
        };
      }
    };

    const health = await doctor({ home, cwd: home, codexHost });

    assert.equal(health.healthy, false);
    assert.equal(health.clis.codex.configured, true);
    assert.equal(health.clis.codex.runnable, false);
    assert.equal(health.clis.codex.connected, false);
    assert.equal(health.clis.codex.promptTrustStatus, "modified");
    assert.equal(health.clis.codex.backstopTrustStatus, "modified");
  });

  it("doctor requires an active fresh reconciliation loop for the real-home operating mode", async () => {
    const home = await tempHome();
    const codexHost = {
      async synchronize() { return { available: true, configured: true, runnable: true, status: "trusted" }; },
      async inspect() {
        return {
          available: true,
          configured: true,
          runnable: true,
          status: "trusted",
          prompt: { runnable: true, trustStatus: "trusted" },
          backstop: { runnable: true, trustStatus: "trusted" }
        };
      }
    };
    const schedulerHost = {
      async install() { return { active: false }; },
      async inspect() { return { active: false }; }
    };
    const reviewerDetector = async () => ({
      codex: { cli: "codex", available: true, executable: "/opt/codex" },
      claude: { cli: "claude", available: false, executable: null },
      gemini: { cli: "gemini", available: false, executable: null }
    });
    await install({ home, codexHost, schedulerHost, activateScheduler: false });

    const inactive = await doctor({ home, codexHost, schedulerHost, reviewerDetector, requireScheduler: true });
    assert.equal(inactive.healthy, false);
    assert.equal(inactive.operational.schedulerReady, false);
    assert.equal(inactive.operational.reconciliationReady, false);

    schedulerHost.inspect = async () => ({ active: true });
    const store = openStore({ paths: pathsFor(home) });
    store.setRuntimeStatus("codex_reconcile", { status: "completed", filesScanned: 1 });
    store.close();
    const ready = await doctor({ home, codexHost, schedulerHost, reviewerDetector, requireScheduler: true });
    assert.equal(ready.healthy, true);
    assert.equal(ready.operational.schedulerReady, true);
    assert.equal(ready.operational.reconciliationReady, true);
    assert.deepEqual(ready.operational.readyClis, ["codex"]);
    assert.equal(ready.clis.gemini.operational, false);

    const failedStore = openStore({ paths: pathsFor(home) });
    failedStore.setRuntimeStatus("codex_reconcile", {
      status: "completed_with_errors",
      filesScanned: 0,
      candidates: 1,
      errors: [{ code: "EIO", path: "/tmp/unreadable-rollout.jsonl" }]
    });
    failedStore.close();
    const failed = await doctor({ home, codexHost, schedulerHost, reviewerDetector, requireScheduler: true });
    assert.equal(failed.healthy, false);
    assert.equal(failed.degraded, true);
    assert.equal(failed.operational.reconciliationReady, false);
  });

  it("installs prompt pack, patches configs, and uninstalls config hooks", async () => {
    const home = await tempHome();

    await install({ home, dryRun: false });

    const promptFile = path.join(home, ".agent", "feedback-loop", "prompts", "reflection-agent.md");
    const coreHook = path.join(home, ".agent", "feedback-loop", "hooks", "core-hook.sh");
    const reviewerSchema = path.join(home, ".agent", "feedback-loop", "schemas", "reviewer-receipt.schema.json");
    const geminiReviewerPolicy = path.join(home, ".agent", "feedback-loop", "policies", "gemini-reviewer-deny-all.toml");
    const geminiReviewerSettings = path.join(home, ".agent", "feedback-loop", "settings", "gemini-reviewer.json");
    const codexConfig = path.join(home, ".codex", "config.toml");
    const claudeSettings = path.join(home, ".claude", "settings.json");
    const geminiSettings = path.join(home, ".gemini", "settings.json");

    assert.match(await readText(promptFile), /user_misunderstanding/);
    assert.match(await readText(promptFile), /默认使用中文/);
    assert.match(await readText(promptFile), /用户明确选择的语言/);
    assert.match(await readText(promptFile), /transactional store is the source of truth/);
    assert.match(await readText(promptFile), /real background subagent/);
    assert.match(await readText(promptFile), /mode=background_subagent/);
    assert.match(await readText(promptFile), /project-scoped active projection/);
    assert.match(await readText(promptFile), /feedback_candidate_event_ids/);
    assert.match(await readText(path.join(home, ".agent", "feedback-loop", "rules", "feedback-loop.md")), /commit atomically/);
    assert.equal((await stat(coreHook)).mode & 0o111, 0o111);
    const schema = JSON.parse(await readText(reviewerSchema));
    assert.equal(schema.properties.status.enum.includes("reviewed_no_lesson"), true);
    assert.match(await readText(geminiReviewerPolicy), /toolName = "\*"/);
    assert.equal(JSON.parse(await readText(geminiReviewerSettings)).hooksConfig.enabled, false);
    assert.match(await readText(codexConfig), /agent-feedback-loop:start/);
    assert.match(await readText(codexConfig), /core-hook\.sh/);
    assert.match(await readText(codexConfig), /--continue/);
    const codexPromptBlock = (await readText(codexConfig)).split("[[hooks.Stop]]")[0];
    assert.match(codexPromptBlock, /timeout = 5/);
    // backstop: Codex Stop hook wired to stop-hook.sh
    assert.match(await readText(codexConfig), /\[\[hooks\.Stop\]\]/);
    assert.match(await readText(codexConfig), /stop-hook\.sh/);
    assert.match(await readText(codexConfig), /--mode/);

    const settings = JSON.parse(await readText(claudeSettings));
    const userPromptHooks = settings.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks);
    assert.ok(userPromptHooks.some((hook) => hook.command?.includes("core-hook.sh")));
    assert.ok(userPromptHooks.some((hook) => hook.command?.includes("core-hook.sh") && hook.timeout === 5));
    // Claude's type:"agent" hook starts a subagent, but it blocks the hook.
    // Keep the hook itself command-based; the injected contract forces the
    // active agent to start the platform's background subagent tool.
    assert.equal(userPromptHooks.some((hook) => hook.type === "agent"), false);
    const claudeStop = settings.hooks.Stop.flatMap((entry) => entry.hooks);
    assert.ok(claudeStop.some((hook) => hook.command?.includes("stop-hook.sh") && hook.command?.includes("--mode") && hook.command?.includes("claude")));

    const gemini = JSON.parse(await readText(geminiSettings));
    const beforeAgentHooks = gemini.hooks.BeforeAgent.flatMap((entry) => entry.hooks);
    assert.ok(beforeAgentHooks.some((hook) => hook.command?.includes("core-hook.sh")));
    assert.ok(beforeAgentHooks.some((hook) => hook.command?.includes("--event") && hook.command?.includes("BeforeAgent")));
    assert.ok(beforeAgentHooks.some((hook) => hook.command?.includes("core-hook.sh") && hook.timeout === 5000));
    const geminiAfterAgent = gemini.hooks.AfterAgent.flatMap((entry) => entry.hooks);
    assert.ok(geminiAfterAgent.some((hook) => hook.command?.includes("stop-hook.sh") && hook.command?.includes("--mode") && hook.command?.includes("gemini")));

    const health = await doctor({ home });
    assert.equal(health.healthy, true);
    assert.equal(health.clis.codex.connected, true);
    assert.equal(health.clis.claude.connected, true);
    assert.equal(health.clis.gemini.connected, true);

    await uninstall({ home, dryRun: false, removeFiles: false });

    assert.doesNotMatch(await readText(codexConfig), /agent-feedback-loop:start/);
    const settingsAfter = JSON.parse(await readText(claudeSettings));
    const hooksAfter = (settingsAfter.hooks.UserPromptSubmit || []).flatMap((entry) => entry.hooks);
    assert.equal(hooksAfter.some((hook) => hook.command?.includes("core-hook.sh")), false);
    const geminiAfter = JSON.parse(await readText(geminiSettings));
    const beforeAfter = (geminiAfter.hooks.BeforeAgent || []).flatMap((entry) => entry.hooks);
    assert.equal(beforeAfter.some((hook) => hook.command?.includes("core-hook.sh")), false);
    // backstop cleaned too
    assert.doesNotMatch(await readText(codexConfig), /stop-hook\.sh/);
    const stopAfter = (settingsAfter.hooks.Stop || []).flatMap((entry) => entry.hooks);
    assert.equal(stopAfter.some((hook) => hook.command?.includes("stop-hook.sh")), false);
    const afterAgentAfter = (geminiAfter.hooks.AfterAgent || []).flatMap((entry) => entry.hooks);
    assert.equal(afterAgentAfter.some((hook) => hook.command?.includes("stop-hook.sh")), false);
  });

  it("core hook queues normal prompts silently and injects a batch review when due", async () => {
    const home = await tempHome();
    await install({ home, dryRun: false });
    const coreHook = path.join(home, ".agent", "feedback-loop", "hooks", "core-hook.sh");
    const tmp = await mkdtemp(path.join(tmpdir(), "afl-mk-"));
    const queueDir = path.join(tmp, "queue");
    const env = {
      ...process.env,
      HOME: home,
      TMPDIR: tmp,
      AGENT_FEEDBACK_LOOP_QUEUE_DIR: queueDir,
      AGENT_FEEDBACK_LOOP_REVIEW_MIN_ENTRIES: "3",
      AGENT_FEEDBACK_LOOP_REVIEW_COOLDOWN: "0"
    };
    const payload = (turn, prompt) => JSON.stringify({ session_id: "s1", turn_id: turn, cwd: "/tmp/proj-a", prompt });

    // turns below the threshold: nothing injected, prompt recorded to the queue
    const first = await runWithInput(coreHook, payload(1, "summarize the README"), env, ["--event", "UserPromptSubmit", "--continue"]);
    assert.deepEqual(JSON.parse(first.stdout), { continue: true });
    const second = await runWithInput(coreHook, payload(2, "按照这个格式总结，记得一定要有事件依据"), env, ["--event", "UserPromptSubmit"]);
    assert.deepEqual(JSON.parse(second.stdout), {});
    const queueFile = path.join(queueDir, "_tmp_proj-a.jsonl");
    assert.equal((await readText(queueFile)).trim().split("\n").length, 2);
    await assert.rejects(stat(path.join(home, ".agent", "feedback-loop-data", "store", "feedback-loop.sqlite3")));
    await assert.rejects(stat(path.join(tmp, "afl-reflect", "s1.1.required")));

    // threshold reached: batch review injected, per-turn marker written for the backstop
    const third = await runWithInput(coreHook, payload(3, "third message"), env, ["--event", "UserPromptSubmit"]);
    const ctx = JSON.parse(third.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /反馈评审到期/);
    assert.match(ctx, /_tmp_proj-a\.jsonl/);
    assert.match(ctx, /回顾性反馈/);
    assert.match(ctx, /宁漏报不误报/);
    assert.match(ctx, /澄清\/评审轮次/);
    assert.match(ctx, /逐字引用用户原话/);
    assert.match(ctx, /5 Why/);
    assert.match(ctx, /run_in_background/);
    assert.match(ctx, /afl-reflection:done/);
    await stat(path.join(tmp, "afl-reflect", "s1.3.required"));

    // queue is only cleared by the reviewer; the review stamp suppresses re-fire under cooldown
    const cooldownEnv = { ...env, AGENT_FEEDBACK_LOOP_REVIEW_COOLDOWN: "3600" };
    const fourth = await runWithInput(coreHook, payload(4, "fourth message"), cooldownEnv, ["--event", "UserPromptSubmit"]);
    assert.deepEqual(JSON.parse(fourth.stdout), {});
  });

  it("core hook dedups repeated hook firings for the same user message", async () => {
    const home = await tempHome();
    await install({ home, dryRun: false });
    const coreHook = path.join(home, ".agent", "feedback-loop", "hooks", "core-hook.sh");
    const tmp = await mkdtemp(path.join(tmpdir(), "afl-dd-"));
    const queueDir = path.join(tmp, "queue");
    const env = { ...process.env, HOME: home, TMPDIR: tmp, AGENT_FEEDBACK_LOOP_QUEUE_DIR: queueDir };
    const queueFile = path.join(queueDir, "_tmp_proj-dd.jsonl");

    // same session + same prompt text but a fresh prompt_id -> one queue line
    const dup = (pid) => JSON.stringify({ session_id: "sd", prompt_id: pid, cwd: "/tmp/proj-dd", prompt: "检查一下部署" });
    await runWithInput(coreHook, dup("p1"), env, ["--event", "UserPromptSubmit"]);
    await runWithInput(coreHook, dup("p2"), env, ["--event", "UserPromptSubmit"]);
    assert.equal((await readText(queueFile)).trim().split("\n").length, 1);

    // a different message afterwards is appended normally
    await runWithInput(coreHook, JSON.stringify({ session_id: "sd", prompt_id: "p3", cwd: "/tmp/proj-dd", prompt: "继续" }), env, ["--event", "UserPromptSubmit"]);
    // and the same text again later (not back-to-back) is a fresh entry
    await runWithInput(coreHook, dup("p4"), env, ["--event", "UserPromptSubmit"]);
    assert.equal((await readText(queueFile)).trim().split("\n").length, 3);

    // machine-generated payloads (task notifications, local command echoes) are never queued
    for (const machine of ["<task-notification>agent finished</task-notification>", "<local-command-caveat>ran /model</local-command-caveat>", "<command-name>/model</command-name>"]) {
      const out = await runWithInput(coreHook, JSON.stringify({ session_id: "sd", prompt_id: "pm", cwd: "/tmp/proj-dd", prompt: machine }), env, ["--event", "UserPromptSubmit"]);
      assert.deepEqual(JSON.parse(out.stdout), {});
    }
    assert.equal((await readText(queueFile)).trim().split("\n").length, 3);
  });

  it("core hook debug logs decisions without logging prompt content", async () => {
    const home = await tempHome();
    await install({ home, dryRun: false });
    const coreHook = path.join(home, ".agent", "feedback-loop", "hooks", "core-hook.sh");
    const tmp = await mkdtemp(path.join(tmpdir(), "afl-dbg-"));
    const env = {
      ...process.env,
      HOME: home,
      TMPDIR: tmp,
      AGENT_FEEDBACK_LOOP_QUEUE_DIR: path.join(tmp, "queue"),
      AGENT_FEEDBACK_LOOP_DEBUG: "1"
    };

    const queued = await runWithInput(
      coreHook,
      JSON.stringify({ session_id: "s-debug", turn_id: 7, prompt: "严重问题：不要把这句完整写进日志" }),
      env,
      ["--event", "UserPromptSubmit", "--continue"]
    );

    assert.match(queued.stderr, /agent-feedback-loop: event=UserPromptSubmit decision=queue/);
    assert.match(queued.stderr, /session=s-debug/);
    assert.match(queued.stderr, /turn=7/);
    assert.doesNotMatch(queued.stderr, /不要把这句完整写进日志/);
  });

  it("stop hook backstop: blocks when required-but-not-done, passes otherwise, guards loops", async () => {
    const home = await tempHome();
    await install({ home, dryRun: false });
    const stopHook = path.join(home, ".agent", "feedback-loop", "hooks", "stop-hook.sh");
    const tmp = await mkdtemp(path.join(tmpdir(), "afl-stop-"));
    const mdir = path.join(tmp, "afl-reflect");
    await mkdir(mdir, { recursive: true });
    const env = { ...process.env, HOME: home, TMPDIR: tmp };
    const marker = path.join(mdir, "s1.1.required");

    // no marker -> pass
    const noMark = await runWithInput(stopHook, JSON.stringify({ session_id: "s1", turn_id: 1 }), env, ["--mode", "codex"]);
    assert.equal(JSON.parse(noMark.stdout).continue, true);

    // required + no done marker -> block (Codex strict: no hookSpecificOutput)
    await writeFile(marker, "");
    const blocked = await runWithInput(stopHook, JSON.stringify({ session_id: "s1", turn_id: 1, last_assistant_message: "我把bug修了" }), env, ["--mode", "codex"]);
    const blockedJson = JSON.parse(blocked.stdout);
    assert.equal(blockedJson.decision, "block");
    assert.ok(blockedJson.reason && blockedJson.reason.length > 0);
    assert.equal(blockedJson.hookSpecificOutput, undefined);

    // required + done marker present in reply -> pass and clean up marker
    await writeFile(marker, "");
    const oldMarkerOnly = await runWithInput(stopHook, JSON.stringify({ session_id: "s1", turn_id: 1, last_assistant_message: "ok <!--afl-reflection:done responsibility=agent_fault-->" }), env, ["--mode", "codex"]);
    assert.equal(JSON.parse(oldMarkerOnly.stdout).decision, "block");

    // required + done marker with background/fallback mode -> pass and clean up marker
    await writeFile(marker, "");
    const done = await runWithInput(stopHook, JSON.stringify({ session_id: "s1", turn_id: 1, last_assistant_message: "ok <!--afl-reflection:done responsibility=agent_fault mode=background_subagent agent_id=abc-->" }), env, ["--mode", "codex"]);
    assert.equal(JSON.parse(done.stdout).continue, true);
    await assert.rejects(stat(marker));

    // loop guard: stop_hook_active=true -> pass even if required and not done
    await writeFile(marker, "");
    const guarded = await runWithInput(stopHook, JSON.stringify({ session_id: "s1", turn_id: 1, stop_hook_active: true, last_assistant_message: "still nothing" }), env, ["--mode", "codex"]);
    assert.equal(JSON.parse(guarded.stdout).continue, true);
  });

  it("stop hook gemini mode denies once then passes via file counter (0.30.0 loop-guard bug workaround)", async () => {
    const home = await tempHome();
    await install({ home, dryRun: false });
    const stopHook = path.join(home, ".agent", "feedback-loop", "hooks", "stop-hook.sh");
    const tmp = await mkdtemp(path.join(tmpdir(), "afl-gem-"));
    const mdir = path.join(tmp, "afl-reflect");
    await mkdir(mdir, { recursive: true });
    const env = { ...process.env, HOME: home, TMPDIR: tmp };
    const marker = path.join(mdir, "g1.1.required");
    const payload = JSON.stringify({ session_id: "g1", turn_id: 1 });

    await writeFile(marker, "");
    const first = await runWithInput(stopHook, payload, env, ["--mode", "gemini"]);
    assert.equal(JSON.parse(first.stdout).decision, "deny");

    // second time: retries file exists -> pass (no infinite loop)
    await writeFile(marker, "");
    const second = await runWithInput(stopHook, payload, env, ["--mode", "gemini"]);
    assert.deepEqual(JSON.parse(second.stdout), {});
  });

  it("dry-run install reports actions without writing files", async () => {
    const home = await tempHome();

    const result = await install({ home, dryRun: true });

    assert.equal(result.dryRun, true);
    await assert.rejects(stat(path.join(home, ".agent", "feedback-loop")));
  });

  it("install removes legacy per-CLI hooks left over from older versions", async () => {
    const home = await tempHome();
    await install({ home, dryRun: false });

    const hookDir = path.join(home, ".agent", "feedback-loop", "hooks");
    const legacyCodex = path.join(hookDir, "codex-hook.sh");
    const legacyClaude = path.join(hookDir, "claude-hook.sh");
    // Simulate an upgrade from <=0.1.x where these still sit on disk.
    await writeFile(legacyCodex, "#!/bin/sh\n", "utf8");
    await writeFile(legacyClaude, "#!/bin/sh\n", "utf8");

    const result = await install({ home, dryRun: false });

    await assert.rejects(stat(legacyCodex));
    await assert.rejects(stat(legacyClaude));
    assert.ok(result.actions.some((a) => a.includes("remove legacy hook") && a.includes("codex-hook.sh")));
    // core hook must survive the cleanup
    assert.equal((await stat(path.join(hookDir, "core-hook.sh"))).mode & 0o111, 0o111);
  });

  it("install removes unmarked legacy Codex hook blocks without touching unrelated hooks", async () => {
    const home = await tempHome();
    const config = path.join(home, ".codex", "config.toml");
    await mkdir(path.dirname(config), { recursive: true });
    await writeFile(config, `[[hooks.UserPromptSubmit]]\n\n[[hooks.UserPromptSubmit.hooks]]\ntype = "command"\ncommand = "/tmp/context_guard.py"\ntimeout = 5\n\n[[hooks.UserPromptSubmit]]\n\n[[hooks.UserPromptSubmit.hooks]]\ntype = "command"\ncommand = "${home}/.agent/feedback-loop/hooks/codex-hook.sh"\ntimeout = 2\n`, "utf8");
    await install({ home, dryRun: false });
    const installed = await readText(config);
    assert.match(installed, /context_guard\.py/);
    assert.doesNotMatch(installed, /codex-hook\.sh/);
    assert.match(installed, /core-hook\.sh/);
  });

  it("install removes stale prompt-pack tests left over from older versions", async () => {
    const home = await tempHome();
    await install({ home, dryRun: false });

    const staleTests = path.join(home, ".agent", "feedback-loop", "tests");
    await mkdir(staleTests, { recursive: true });
    await writeFile(path.join(staleTests, "test_prompt_first_hooks.py"), "# stale legacy tests\n", "utf8");

    const result = await install({ home, dryRun: false });

    await assert.rejects(stat(staleTests));
    assert.ok(result.actions.some((a) => a.includes("remove stale tests")));
  });

  it("core hook emits CLI-specific fail-open JSON on quiet queue turns", async () => {
    const home = await tempHome();
    await install({ home, dryRun: false });

    const coreHook = path.join(home, ".agent", "feedback-loop", "hooks", "core-hook.sh");
    const tmp = await mkdtemp(path.join(tmpdir(), "afl-quiet-"));
    const env = { ...process.env, HOME: home, AGENT_FEEDBACK_LOOP_QUEUE_DIR: path.join(tmp, "queue") };
    const payload = JSON.stringify({ prompt: "严重问题，每次你都漏上下文", cwd: "/tmp/proj-b" });

    // even blocker-sounding wording is just queued — no per-turn injection at all
    const codex = await runWithInput(coreHook, payload, env, ["--event", "UserPromptSubmit", "--continue"]);
    assert.deepEqual(JSON.parse(codex.stdout), { continue: true });

    const claude = await runWithInput(coreHook, payload, env, ["--event", "UserPromptSubmit"]);
    assert.deepEqual(JSON.parse(claude.stdout), {});

    const gemini = await runWithInput(coreHook, payload, env, ["--event", "BeforeAgent"]);
    assert.deepEqual(JSON.parse(gemini.stdout), {});

    // identical session+text fired three times -> deduped to one queue entry
    const queueFile = path.join(tmp, "queue", "_tmp_proj-b.jsonl");
    assert.equal((await readText(queueFile)).trim().split("\n").length, 1);
  });

  it("core hook review instruction targets the correct event name per CLI", async () => {
    const home = await tempHome();
    await install({ home, dryRun: false });

    const coreHook = path.join(home, ".agent", "feedback-loop", "hooks", "core-hook.sh");
    const tmp = await mkdtemp(path.join(tmpdir(), "afl-due-"));
    const env = {
      ...process.env,
      HOME: home,
      TMPDIR: tmp,
      AGENT_FEEDBACK_LOOP_QUEUE_DIR: path.join(tmp, "queue"),
      AGENT_FEEDBACK_LOOP_REVIEW_MIN_ENTRIES: "1",
      AGENT_FEEDBACK_LOOP_REVIEW_COOLDOWN: "0"
    };
    const payload = (turn) => JSON.stringify({ session_id: "s2", turn_id: turn, cwd: "/tmp/proj-c", prompt: "hello" });

    const codex = await runWithInput(coreHook, payload(1), env, ["--event", "UserPromptSubmit", "--continue"]);
    const codexJson = JSON.parse(codex.stdout);
    assert.equal(codexJson.continue, true);
    assert.equal(codexJson.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(codexJson.hookSpecificOutput.additionalContext, /后台评审 subagent/);
    assert.match(codexJson.hookSpecificOutput.additionalContext, /reflection-agent\.md/);

    const gemini = await runWithInput(coreHook, payload(2), env, ["--event", "BeforeAgent"]);
    const geminiJson = JSON.parse(gemini.stdout);
    assert.equal(geminiJson.continue, undefined);
    assert.equal(geminiJson.hookSpecificOutput.hookEventName, "BeforeAgent");
    assert.match(geminiJson.hookSpecificOutput.additionalContext, /mode=background_subagent/);
  });

  it("queues an immediate background review after an interrupted prior turn", async () => {
    const home = await tempHome();
    await install({ home, dryRun: false });
    const coreHook = path.join(home, ".agent", "feedback-loop", "hooks", "core-hook.sh");
    const transcript = path.join(home, "rollout.jsonl");
    await writeFile(transcript, [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "prior-turn" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "prior-turn", reason: "interrupted" } })
    ].join("\n"), "utf8");
    const env = {
      ...process.env,
      HOME: home,
      AGENT_FEEDBACK_LOOP_REVIEW_MIN_ENTRIES: "3",
      AGENT_FEEDBACK_LOOP_REVIEW_COOLDOWN: "3600",
      AGENT_FEEDBACK_LOOP_DEBUG: "1",
      AGENT_FEEDBACK_LOOP_LOG: path.join(home, "runtime.log"),
      AGENT_FEEDBACK_LOOP_CODEX_COMMAND: path.join(home, "missing-codex")
    };
    const firstInput = JSON.stringify({
      session_id: "interrupted-session",
      turn_id: "initial-turn",
      cwd: "/tmp/interrupted-project",
      prompt: "Initial neutral evidence."
    });
    const first = await runWithInput(coreHook, firstInput, {
      ...env,
      AGENT_FEEDBACK_LOOP_REVIEW_MIN_ENTRIES: "1"
    }, ["--event", "UserPromptSubmit", "--cli", "codex", "--continue"]);
    assert.deepEqual(JSON.parse(first.stdout), { continue: true });

    const input = JSON.stringify({
      session_id: "interrupted-session",
      turn_id: "current-turn",
      cwd: "/tmp/interrupted-project",
      transcript_path: transcript,
      prompt: "This wording is deliberately neutral."
    });

    const output = await runWithInput(coreHook, input, env, ["--event", "UserPromptSubmit", "--cli", "codex", "--continue"]);
    const response = JSON.parse(output.stdout);

    assert.equal(response.continue, true);
    assert.equal(response.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(response.hookSpecificOutput.additionalContext, /correction checkpoint/i);
    assert.match(response.hookSpecificOutput.additionalContext, /stop the superseded execution path/i);
    assert.doesNotMatch(response.hookSpecificOutput.additionalContext, /5[- ]why|report_content/i);
    const log = await readText(env.AGENT_FEEDBACK_LOOP_LOG);
    assert.match(log, /signal=prior_turn_interrupted immediate_review=1/);
    assert.match(log, /reviewer\.unavailable cli=codex/);
    const jobIds = [...log.matchAll(/background job=([a-f0-9]+)/g)].map((match) => match[1]);
    assert.equal(new Set(jobIds).size, 2);
  });

  it("core hook fails open when shared trigger rules are missing", async () => {
    const home = await tempHome();
    await install({ home, dryRun: false });

    const hookDir = path.join(home, ".agent", "feedback-loop", "hooks");
    const coreHook = path.join(hookDir, "core-hook.sh");
    await rm(path.join(hookDir, "trigger-rules.sh"));

    const payload = JSON.stringify({ prompt: "这里显示太差了，重做" });

    const codex = await runWithInput(coreHook, payload, { ...process.env, HOME: home }, ["--event", "UserPromptSubmit", "--continue"]);
    assert.equal(JSON.parse(codex.stdout).continue, true);

    const claude = await runWithInput(coreHook, payload, { ...process.env, HOME: home }, ["--event", "UserPromptSubmit"]);
    assert.deepEqual(JSON.parse(claude.stdout), {});
  });

  it("doctor reports unhealthy when shared trigger rules are missing", async () => {
    const home = await tempHome();
    await install({ home, dryRun: false });

    await rm(path.join(home, ".agent", "feedback-loop", "hooks", "trigger-rules.sh"));

    const health = await doctor({ home });
    assert.equal(health.healthy, false);
    assert.equal(health.files.triggerRules, false);
  });

  it("CLI doctor exits successfully after install", async () => {
    const home = await tempHome();
    await execFileAsync(BIN, ["install", "--home", home]);

    const result = await execFileAsync(BIN, ["doctor", "--home", home]);

    assert.match(result.stdout, /healthy/i);
  });

  it("CLI prints help from top-level --help", async () => {
    const result = await execFileAsync(BIN, ["--help"]);

    assert.match(result.stdout, /agent-feedback-loop/);
    assert.match(result.stdout, /install/);
  });
});
