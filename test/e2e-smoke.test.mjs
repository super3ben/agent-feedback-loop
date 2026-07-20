import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { install, pathsFor } from "../src/index.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");

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

test("CLI live doctor runs only an isolated temporary canary", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-doctor-"));
  await install({ home, codexHost: unavailableCodexHost() });
  const result = await execFileAsync(process.execPath, ["bin/agent-feedback-loop.mjs", "doctor", "--home", home, "--live"], {
    cwd: ROOT,
    env: { ...process.env, HOME: home }
  }).catch((error) => error);
  const stdout = result.stdout || "";
  const parsed = JSON.parse(stdout.slice(stdout.indexOf("{\n")));
  assert.equal(parsed.live.status, "healthy");
  assert.equal(parsed.live.syntheticExcluded, true);
  assert.equal(parsed.capability.status, "healthy");
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
