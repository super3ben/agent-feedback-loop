import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { doctor, install, uninstall } from "../src/index.mjs";

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
  it("installs prompt pack, patches configs, and uninstalls config hooks", async () => {
    const home = await tempHome();

    await install({ home, dryRun: false });

    const promptFile = path.join(home, ".agent", "feedback-loop", "prompts", "reflection-agent.md");
    const coreHook = path.join(home, ".agent", "feedback-loop", "hooks", "core-hook.sh");
    const codexConfig = path.join(home, ".codex", "config.toml");
    const claudeSettings = path.join(home, ".claude", "settings.json");
    const geminiSettings = path.join(home, ".gemini", "settings.json");

    assert.match(await readText(promptFile), /user_misunderstanding/);
    assert.match(await readText(promptFile), /默认使用中文/);
    assert.match(await readText(promptFile), /用户明确选择的语言/);
    assert.match(await readText(promptFile), /\.agent\/reflections/);
    assert.equal((await stat(coreHook)).mode & 0o111, 0o111);
    assert.match(await readText(codexConfig), /agent-feedback-loop:start/);
    assert.match(await readText(codexConfig), /core-hook\.sh/);
    assert.match(await readText(codexConfig), /--continue/);
    // backstop: Codex Stop hook wired to stop-hook.sh
    assert.match(await readText(codexConfig), /\[\[hooks\.Stop\]\]/);
    assert.match(await readText(codexConfig), /stop-hook\.sh --mode codex/);

    const settings = JSON.parse(await readText(claudeSettings));
    const userPromptHooks = settings.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks);
    assert.ok(userPromptHooks.some((hook) => hook.command?.includes("core-hook.sh")));
    assert.equal(userPromptHooks.some((hook) => hook.type === "agent"), false);
    const claudeStop = settings.hooks.Stop.flatMap((entry) => entry.hooks);
    assert.ok(claudeStop.some((hook) => hook.command?.includes("stop-hook.sh --mode claude")));

    const gemini = JSON.parse(await readText(geminiSettings));
    const beforeAgentHooks = gemini.hooks.BeforeAgent.flatMap((entry) => entry.hooks);
    assert.ok(beforeAgentHooks.some((hook) => hook.command?.includes("core-hook.sh")));
    assert.ok(beforeAgentHooks.some((hook) => hook.command?.includes("--event BeforeAgent")));
    const geminiAfterAgent = gemini.hooks.AfterAgent.flatMap((entry) => entry.hooks);
    assert.ok(geminiAfterAgent.some((hook) => hook.command?.includes("stop-hook.sh --mode gemini")));

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

  it("core hook writes a per-turn marker on forced reflection, gate defers to the model", async () => {
    const home = await tempHome();
    await install({ home, dryRun: false });
    const coreHook = path.join(home, ".agent", "feedback-loop", "hooks", "core-hook.sh");
    const tmp = await mkdtemp(path.join(tmpdir(), "afl-mk-"));
    const env = { ...process.env, HOME: home, TMPDIR: tmp };

    // forced (shell word match) -> shell touches the marker file
    await runWithInput(coreHook, JSON.stringify({ session_id: "s1", turn_id: 1, prompt: "严重问题" }), env, ["--event", "UserPromptSubmit", "--continue"]);
    await stat(path.join(tmp, "afl-reflect", "s1.1.required"));

    // gate (normal-but-maybe-unhappy) -> shell does NOT touch; injects touch instruction for the model
    const gate = await runWithInput(coreHook, JSON.stringify({ session_id: "s1", turn_id: 2, prompt: "summarize" }), env, ["--event", "UserPromptSubmit"]);
    const ctx = JSON.parse(gate.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /touch/);
    assert.match(ctx, /s1\.2\.required/);
    assert.match(ctx, /afl-reflection:done/);
    await assert.rejects(stat(path.join(tmp, "afl-reflect", "s1.2.required")));
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
    const done = await runWithInput(stopHook, JSON.stringify({ session_id: "s1", turn_id: 1, last_assistant_message: "ok <!--afl-reflection:done responsibility=agent_fault-->" }), env, ["--mode", "codex"]);
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

  it("core hook emits non-blocking CLI-specific JSON", async () => {
    const home = await tempHome();
    await install({ home, dryRun: false });

    const coreHook = path.join(home, ".agent", "feedback-loop", "hooks", "core-hook.sh");
    const payload = JSON.stringify({ prompt: "严重问题，每次你都漏上下文" });

    const codex = await runWithInput(coreHook, payload, { ...process.env, HOME: home }, ["--event", "UserPromptSubmit", "--continue"]);
    const codexJson = JSON.parse(codex.stdout);
    assert.equal(codexJson.continue, true);
    assert.equal(codexJson.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(codexJson.hookSpecificOutput.additionalContext, /released_agent_ids/);

    const claude = await runWithInput(coreHook, payload, { ...process.env, HOME: home }, ["--event", "UserPromptSubmit"]);
    const claudeJson = JSON.parse(claude.stdout);
    assert.equal(claudeJson.continue, undefined);
    assert.equal(claudeJson.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(claudeJson.hookSpecificOutput.additionalContext, /reflection-agent\.md/);

    const gemini = await runWithInput(coreHook, payload, { ...process.env, HOME: home }, ["--event", "BeforeAgent"]);
    const geminiJson = JSON.parse(gemini.stdout);
    assert.equal(geminiJson.continue, undefined);
    assert.equal(geminiJson.hookSpecificOutput.hookEventName, "BeforeAgent");
    assert.match(geminiJson.hookSpecificOutput.additionalContext, /reflection-agent\.md/);
  });

  it("core hook forces reflection for live incident and explicit self-reflection wording", async () => {
    const home = await tempHome();
    await install({ home, dryRun: false });

    const coreHook = path.join(home, ".agent", "feedback-loop", "hooks", "core-hook.sh");
    const prompts = [
      "这次是很严重的现场事故，为什么没有触发自我反思？",
      "你调用agent-feedback-loop去反思了吗，这次是这么严重的现场事故",
      "为什么不触发自我反思"
    ];

    for (const prompt of prompts) {
      const codex = await runWithInput(coreHook, JSON.stringify({ prompt }), { ...process.env, HOME: home }, ["--event", "UserPromptSubmit", "--continue"]);
      const codexContext = JSON.parse(codex.stdout).hookSpecificOutput.additionalContext;
      assert.match(codexContext, /反馈反思已触发/);
      assert.match(codexContext, /\.agent\/reflections/);
      assert.match(codexContext, /不要暂停当前工作/);
    }
  });

  it("core hook injects a semantic gate for normal prompts", async () => {
    const home = await tempHome();
    await install({ home, dryRun: false });

    const coreHook = path.join(home, ".agent", "feedback-loop", "hooks", "core-hook.sh");
    const payload = JSON.stringify({ prompt: "Please summarize the README in two bullets." });

    const codex = await runWithInput(coreHook, payload, { ...process.env, HOME: home }, ["--event", "UserPromptSubmit", "--continue"]);
    const codexJson = JSON.parse(codex.stdout);
    assert.equal(codexJson.continue, true);
    assert.match(codexJson.hookSpecificOutput.additionalContext, /反馈检查/);
    assert.doesNotMatch(codexJson.hookSpecificOutput.additionalContext, /反馈反思已触发/);

    const claude = await runWithInput(coreHook, payload, { ...process.env, HOME: home }, ["--event", "UserPromptSubmit"]);
    const claudeJson = JSON.parse(claude.stdout);
    assert.equal(claudeJson.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(claudeJson.hookSpecificOutput.additionalContext, /反馈检查/);
    assert.doesNotMatch(claudeJson.hookSpecificOutput.additionalContext, /反馈反思已触发/);
  });

  it("core hook injects a semantic gate for implicit dissatisfaction in multiple languages", async () => {
    const home = await tempHome();
    await install({ home, dryRun: false });

    const coreHook = path.join(home, ".agent", "feedback-loop", "hooks", "core-hook.sh");
    const prompts = [
      "这里显示也是呀只显示数字不明显，就不能有点设计性？让这些东西显示明显点，以后这种页面的这种都要调用设计性的skill类似front-desgin等等",
      "为什么当时做文档的时候没考虑要用术语呢，mode AB让别人怎么理解，这种问题以后不要再出现",
      "This is not clear enough. Why did you not use a design skill for this kind of visible page? These pages should use a design skill in the future."
    ];

    for (const prompt of prompts) {
      const payload = JSON.stringify({ prompt });

      const codex = await runWithInput(coreHook, payload, { ...process.env, HOME: home }, ["--event", "UserPromptSubmit", "--continue"]);
      assert.match(codex.stdout, /反馈检查/);

      const gemini = await runWithInput(coreHook, payload, { ...process.env, HOME: home }, ["--event", "BeforeAgent"]);
      assert.match(gemini.stdout, /反馈检查/);
    }
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
