import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

function runWithInput(file, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [], { env });
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
    const codexHook = path.join(home, ".agent", "feedback-loop", "hooks", "codex-hook.sh");
    const claudeHook = path.join(home, ".agent", "feedback-loop", "hooks", "claude-hook.sh");
    const codexConfig = path.join(home, ".codex", "config.toml");
    const claudeSettings = path.join(home, ".claude", "settings.json");

    assert.match(await readText(promptFile), /user_misunderstanding/);
    assert.equal((await stat(codexHook)).mode & 0o111, 0o111);
    assert.equal((await stat(claudeHook)).mode & 0o111, 0o111);
    assert.match(await readText(codexConfig), /agent-feedback-loop:start/);
    assert.match(await readText(codexConfig), /codex-hook\.sh/);

    const settings = JSON.parse(await readText(claudeSettings));
    const userPromptHooks = settings.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks);
    assert.ok(userPromptHooks.some((hook) => hook.command?.includes("claude-hook.sh")));
    assert.equal(userPromptHooks.some((hook) => hook.type === "agent"), false);

    const health = await doctor({ home });
    assert.equal(health.healthy, true);
    assert.equal(health.codex.connected, true);
    assert.equal(health.claude.commandHookConnected, true);
    assert.equal(health.claude.agentPromptConnected, false);

    await uninstall({ home, dryRun: false, removeFiles: false });

    assert.doesNotMatch(await readText(codexConfig), /agent-feedback-loop:start/);
    const settingsAfter = JSON.parse(await readText(claudeSettings));
    const hooksAfter = settingsAfter.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks);
    assert.equal(hooksAfter.some((hook) => hook.command?.includes("claude-hook.sh")), false);
  });

  it("dry-run install reports actions without writing files", async () => {
    const home = await tempHome();

    const result = await install({ home, dryRun: true });

    assert.equal(result.dryRun, true);
    await assert.rejects(stat(path.join(home, ".agent", "feedback-loop")));
  });

  it("shell hooks emit non-blocking CLI-specific JSON", async () => {
    const home = await tempHome();
    await install({ home, dryRun: false });

    const codexHook = path.join(home, ".agent", "feedback-loop", "hooks", "codex-hook.sh");
    const claudeHook = path.join(home, ".agent", "feedback-loop", "hooks", "claude-hook.sh");
    const payload = JSON.stringify({ prompt: "严重问题，每次你都漏上下文" });

    const codex = await runWithInput(codexHook, payload, { ...process.env, HOME: home });
    assert.equal(JSON.parse(codex.stdout).continue, true);
    assert.match(codex.stdout, /released_agent_ids/);

    const claude = await runWithInput(claudeHook, payload, { ...process.env, HOME: home });
    const claudeJson = JSON.parse(claude.stdout);
    assert.equal(claudeJson.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(claudeJson.hookSpecificOutput.additionalContext, /reflection-agent\.md/);
  });

  it("shell hooks inject a semantic gate for normal prompts", async () => {
    const home = await tempHome();
    await install({ home, dryRun: false });

    const codexHook = path.join(home, ".agent", "feedback-loop", "hooks", "codex-hook.sh");
    const claudeHook = path.join(home, ".agent", "feedback-loop", "hooks", "claude-hook.sh");
    const payload = JSON.stringify({ prompt: "Please summarize the README in two bullets." });

    const codex = await runWithInput(codexHook, payload, { ...process.env, HOME: home });
    const codexJson = JSON.parse(codex.stdout);
    assert.equal(codexJson.continue, true);
    assert.match(codexJson.systemMessage, /Feedback gate/);
    assert.doesNotMatch(codexJson.systemMessage, /Feedback reflection triggered/);

    const claude = await runWithInput(claudeHook, payload, { ...process.env, HOME: home });
    const claudeJson = JSON.parse(claude.stdout);
    assert.equal(claudeJson.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(claudeJson.hookSpecificOutput.additionalContext, /Feedback gate/);
    assert.doesNotMatch(claudeJson.hookSpecificOutput.additionalContext, /Feedback reflection triggered/);
  });

  it("shell hooks inject a semantic gate for implicit dissatisfaction in multiple languages", async () => {
    const home = await tempHome();
    await install({ home, dryRun: false });

    const codexHook = path.join(home, ".agent", "feedback-loop", "hooks", "codex-hook.sh");
    const claudeHook = path.join(home, ".agent", "feedback-loop", "hooks", "claude-hook.sh");
    const prompts = [
      "这里显示也是呀只显示数字不明显，就不能有点设计性？让这些东西显示明显点，以后这种页面的这种都要调用设计性的skill类似front-desgin等等",
      "为什么当时做文档的时候没考虑要用术语呢，mode AB让别人怎么理解，这种问题以后不要再出现",
      "This is not clear enough. Why did you not use a design skill for this kind of visible page? These pages should use a design skill in the future."
    ];

    for (const prompt of prompts) {
      const payload = JSON.stringify({ prompt });

      const codex = await runWithInput(codexHook, payload, { ...process.env, HOME: home });
      assert.match(codex.stdout, /Feedback gate/);

      const claude = await runWithInput(claudeHook, payload, { ...process.env, HOME: home });
      assert.match(claude.stdout, /Feedback gate/);
    }
  });

  it("shell hooks fail open when shared trigger rules are missing", async () => {
    const home = await tempHome();
    await install({ home, dryRun: false });

    const hookDir = path.join(home, ".agent", "feedback-loop", "hooks");
    const codexHook = path.join(hookDir, "codex-hook.sh");
    const claudeHook = path.join(hookDir, "claude-hook.sh");
    await rm(path.join(hookDir, "trigger-rules.sh"));

    const payload = JSON.stringify({ prompt: "这里显示太差了，重做" });

    const codex = await runWithInput(codexHook, payload, { ...process.env, HOME: home });
    assert.equal(JSON.parse(codex.stdout).continue, true);

    const claude = await runWithInput(claudeHook, payload, { ...process.env, HOME: home });
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
