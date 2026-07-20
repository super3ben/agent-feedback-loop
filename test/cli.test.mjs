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

  it("upgrade removes only the managed AFL Stop hook", async () => {
    const home = await tempHome();
    const paths = pathsFor(home);
    await mkdir(path.dirname(paths.codexConfig), { recursive: true });
    await mkdir(path.dirname(paths.claudeSettings), { recursive: true });
    await mkdir(path.dirname(paths.geminiSettings), { recursive: true });
    await writeFile(paths.codexConfig, `# agent-feedback-loop:start
[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "${home}/.agent/feedback-loop/hooks/stop-hook.sh --mode codex"
# agent-feedback-loop:end

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "${home}/.agent/feedback-loop/hooks/stop-hook.sh --mode codex"

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "/opt/user/keep-stop.sh"
`, "utf8");
    await writeFile(paths.claudeSettings, `${JSON.stringify({ hooks: { Stop: [{ matcher: "", hooks: [
      { type: "command", command: `${home}/.agent/feedback-loop/hooks/stop-hook.sh --mode claude` },
      { type: "command", command: "/opt/user/keep-claude-stop.sh" }
    ] }] } }, null, 2)}\n`, "utf8");
    await writeFile(paths.geminiSettings, `${JSON.stringify({ hooks: { AfterAgent: [{ matcher: "", hooks: [
      { type: "command", command: `${home}/.agent/feedback-loop/hooks/stop-hook.sh --mode gemini` },
      { type: "command", command: "/opt/user/keep-gemini-after-agent.sh" }
    ] }] } }, null, 2)}\n`, "utf8");

    await install({ home, codexHost: unavailableCodexHost() });

    const codex = await readFile(paths.codexConfig, "utf8");
    const claude = JSON.parse(await readFile(paths.claudeSettings, "utf8"));
    const gemini = JSON.parse(await readFile(paths.geminiSettings, "utf8"));
    assert.match(codex, /\/opt\/user\/keep-stop\.sh/);
    assert.doesNotMatch(codex, /feedback-loop\/hooks\/stop-hook\.sh/);
    assert.deepEqual(claude.hooks.Stop.flatMap((entry) => entry.hooks).map((hook) => hook.command), ["/opt/user/keep-claude-stop.sh"]);
    assert.deepEqual(gemini.hooks.AfterAgent.flatMap((entry) => entry.hooks).map((hook) => hook.command), ["/opt/user/keep-gemini-after-agent.sh"]);
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
