import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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
