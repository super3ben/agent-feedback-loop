import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { RUNTIME_VERSION, install, pathsFor, uninstall } from "../src/index.mjs";
import { listUserTables, openControlStore } from "../src/control-store.mjs";

const ALLOWED_CONTROL_TABLES = [
  "event_observations",
  "reflection_emissions",
  "review_job_events",
  "reviewer_jobs",
  "schema_migrations",
  "session_events",
  "sessions",
  "store_meta"
];

test("legacy database has no normal path alias", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-runtime-"));
  const paths = pathsFor(home);

  assert.match(paths.runtimeRoot, /feedback-loop[\\/]versions/);
  assert.match(paths.dataRoot, /feedback-loop-data$/);
  assert.match(paths.keyRoot, /feedback-loop-keys$/);
  assert.notEqual(paths.runtimeRoot, paths.dataRoot);
  assert.notEqual(paths.dataRoot, paths.keyRoot);
  assert.equal(Object.hasOwn(paths, ["store", "File"].join("")), false);
  assert.match(paths.legacyDatabase, /store[\\/]feedback-loop\.sqlite3$/);
  assert.match(paths.controlDatabase, /store[\\/]control\.sqlite3$/);
});

function staticRelativeImportGraph(entry) {
  const reachable = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (reachable.has(file)) continue;
    reachable.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\s*)["'](\.{1,2}\/[^"]+)["']/g)) {
      const target = path.resolve(path.dirname(file), match[1]);
      pending.push(target);
    }
  }
  return reachable;
}

test("normal runtime imports only the control store", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const reachable = staticRelativeImportGraph(path.join(root, "bin", "agent-feedback-loop.mjs"));
  for (const banned of [
    "schema.mjs",
    "store.mjs",
    "receipt.mjs",
    "notification-delivery.mjs",
    "codex-reconcile.mjs",
    "reconcile-scheduler.mjs"
  ]) {
    assert.equal([...reachable].some((file) => file.endsWith(path.sep + banned)), false, banned);
  }
});

test("install initializes only the lean control database", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-control-install-"));
  const paths = pathsFor(home);

  await install({ home });
  const controlStore = openControlStore({ paths });
  assert.deepEqual(listUserTables(controlStore.database), ALLOWED_CONTROL_TABLES);
  controlStore.close();
});

test("fresh install is prompt-only", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-prompt-only-install-"));
  await install({ home });
  const paths = pathsFor(home);
  const codex = await readFile(paths.codexConfig, "utf8");
  const claude = JSON.parse(await readFile(paths.claudeSettings, "utf8"));
  const gemini = JSON.parse(await readFile(paths.geminiSettings, "utf8"));

  assert.equal([...codex.matchAll(/^\[\[hooks\.([^\].]+)\]\]$/gm)].map((match) => match[1]).includes("Stop"), false);
  assert.equal(claude.hooks.Stop?.some((entry) => entry.hooks?.some((hook) => hook.command?.includes("feedback-loop"))) ?? false, false);
  assert.equal(gemini.hooks.AfterAgent?.some((entry) => entry.hooks?.some((hook) => hook.command?.includes("feedback-loop"))) ?? false, false);
  assert.equal(existsSync(path.join(paths.packRoot, "hooks", "stop-hook.sh")), false);
  assert.equal("stopHook" in paths, false);
  assert.equal("reconcileLaunchAgent" in paths, false);
  assert.equal("reconcileLog" in paths, false);
});

test("stable launcher resolves an atomically selected versioned runtime", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-current-runtime-"));
  await install({ home });
  const paths = pathsFor(home);
  const launcher = await readFile(paths.runtimeLauncher, "utf8");
  const current = JSON.parse(await readFile(paths.runtimeCurrent, "utf8"));
  assert.match(launcher, /current\.json/);
  assert.doesNotMatch(launcher, /versions\/[0-9.]+\/bin\/agent-feedback-loop/);
  assert.equal(current.runtimeRoot, paths.runtimeRoot);
  assert.equal(current.runtimeVersion, RUNTIME_VERSION);
  assert.equal(current.schemaVersion, 1);
});

test("package excludes removed control plane files", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const packed = await new Promise((resolve, reject) => {
    execFile("npm", ["pack", "--dry-run", "--json"], { cwd: root }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }));
      else resolve(JSON.parse(stdout));
    });
  });
  const files = packed[0].files.map((entry) => entry.path);

  assert.equal(RUNTIME_VERSION, "0.8.0");
  assert.equal(packageJson.version, RUNTIME_VERSION);
  for (const missing of [
    "src/receipt.mjs",
    "src/notification-delivery.mjs",
    "src/codex-reconcile.mjs",
    "src/reconcile-scheduler.mjs",
    "templates/hooks/stop-hook.sh"
  ]) assert.equal(files.includes(missing), false, missing);
  for (const required of [
    "templates/schemas/reviewer-result.schema.json",
    "src/reflection-document.mjs",
    "src/feedback-signal.mjs"
  ]) assert.equal(files.includes(required), true, required);
});

test("documentation describes only the immediate prompt pipeline", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const [english, chinese, rule] = await Promise.all([
    readFile(path.join(root, "README.md"), "utf8"),
    readFile(path.join(root, "README-zh.md"), "utf8"),
    readFile(path.join(root, "templates", "rules", "feedback-loop.md"), "utf8")
  ]);
  const documentation = `${english}\n${chinese}\n${rule}`;

  assert.match(documentation, /later matching prompt|后续匹配的提示/u);
  assert.match(documentation, /legacy export|旧版导出/u);
  assert.match(documentation, /hooks-disabled|关闭 hooks/u);
  assert.doesNotMatch(documentation, /(?:runs|starts|installs).{0,80}(?:resident scheduler|KeepAlive LaunchAgent)|(?:运行|启动|安装).{0,40}(?:常驻.*调度|KeepAlive.*LaunchAgent)/ui);
  assert.doesNotMatch(documentation, /(?:provides|emits|generates).{0,20}(?:session receipt|status output)|(?:提供|显示|生成).{0,20}(?:会话回执|状态输出)/ui);
});

test("installed prompt wrapper has no legacy queue or control transport", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-prompt-template-"));
  await install({ home });
  const paths = pathsFor(home);
  const coreHook = await readFile(paths.coreHook, "utf8");

  assert.match(coreHook, /"\$runtime_launcher" hook "\$@"/);
  assert.doesNotMatch(coreHook, /trigger-rules|QUEUE_DIR|backstop|receipt|reviewer|notification/i);
});

test("remove-files removes runtime but preserves durable data and keys", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-uninstall-"));
  const paths = pathsFor(home);
  await mkdir(paths.dataRoot, { recursive: true, mode: 0o700 });
  await mkdir(paths.keyRoot, { recursive: true, mode: 0o700 });
  await writeFile(path.join(paths.dataRoot, "sentinel"), "durable\n", { mode: 0o600 });
  await writeFile(path.join(paths.keyRoot, "sentinel"), "key\n", { mode: 0o600 });

  await install({ home });
  await uninstall({ home, removeFiles: true });

  await assert.rejects(access(paths.runtimeRoot));
  assert.equal(await readFile(path.join(paths.dataRoot, "sentinel"), "utf8"), "durable\n");
  assert.equal(await readFile(path.join(paths.keyRoot, "sentinel"), "utf8"), "key\n");
});

test("install rejects an unsupported Node runtime before modifying user files", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-old-node-"));
  await assert.rejects(() => install({ home, nodeVersion: "20.19.0" }), /Node 24\.15|transactional backend/i);
  await assert.rejects(access(pathsFor(home).packRoot));
});

test("install rejects symlinked runtime and durable roots before copying files", async () => {
  for (const rootName of ["packRoot", "dataRoot", "keyRoot"]) {
    const home = await mkdtemp(path.join(tmpdir(), `afl-install-${rootName}-`));
    const outside = await mkdtemp(path.join(tmpdir(), `afl-install-outside-${rootName}-`));
    const paths = pathsFor(home);
    await mkdir(path.dirname(paths[rootName]), { recursive: true });
    await symlink(outside, paths[rootName]);
    await assert.rejects(() => install({ home }), /symlink/i);
    await assert.rejects(access(path.join(outside, "prompts", "reflection-agent.md")));
  }
});
