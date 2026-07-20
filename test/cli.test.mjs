import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { doctor, install, pathsFor, uninstall } from "../src/index.mjs";

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

describe("agent-feedback-loop package", () => {
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
