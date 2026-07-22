import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { RUNTIME_VERSION, doctor, install, pathsFor, uninstall } from "../src/index.mjs";
import { listUserTables, openControlStore } from "../src/control-store.mjs";

const ALLOWED_CONTROL_TABLES = [
  "continuation_grants",
  "convergence_events",
  "convergence_loops",
  "convergence_tasks",
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
  assert.match(paths.convergenceProbePrompt, /prompts[\\/]convergence-probe\.md$/);
  assert.match(paths.convergenceProbeSchema, /schemas[\\/]convergence-probe-result\.schema\.json$/);
  assert.equal(path.relative(paths.dataRoot, paths.continuationGrantRoot).startsWith(".."), false);
  assert.match(paths.continuationGrantRoot, /convergence[\\/]grants$/);
  assert.equal(
    paths.probeContextRoot,
    path.join(home, ".agent", "feedback-loop-data", "convergence", "probe-context")
  );
  assert.equal(path.relative(paths.dataRoot, paths.probeContextRoot).startsWith(".."), false);
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
  assert.equal(current.schemaVersion, 2);
});

test("0.9.0 package includes every convergence module and exact Probe asset", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const packed = await new Promise((resolve, reject) => {
    execFile("npm", ["pack", "--dry-run", "--json"], { cwd: root }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }));
      else resolve(JSON.parse(stdout));
    });
  });
  const files = packed[0].files.map((entry) => entry.path);

  assert.equal(RUNTIME_VERSION, "0.9.0");
  assert.equal(packageJson.version, RUNTIME_VERSION);
  for (const missing of [
    "src/receipt.mjs",
    "src/notification-delivery.mjs",
    "src/codex-reconcile.mjs",
    "src/reconcile-scheduler.mjs",
    "templates/hooks/stop-hook.sh"
  ]) assert.equal(files.includes(missing), false, missing);
  for (const required of [
    "src/convergence-adapters.mjs",
    "src/convergence-cli.mjs",
    "src/convergence-controller.mjs",
    "src/convergence-identity.mjs",
    "src/convergence-migration.mjs",
    "src/convergence-policy.mjs",
    "src/convergence-probe-launcher.mjs",
    "src/convergence-probe-result.mjs",
    "src/convergence-probe-runner.mjs",
    "src/convergence-sdd-adapter.mjs",
    "src/convergence-store.mjs",
    "templates/prompts/convergence-probe.md",
    "templates/schemas/convergence-probe-result.schema.json",
    "templates/schemas/reviewer-result.schema.json",
    "src/reflection-document.mjs",
    "src/feedback-signal.mjs"
  ]) assert.equal(files.includes(required), true, required);
});

test("doctor separates package installed capability and repository authority evidence", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-convergence-doctor-"));
  await install({ home });
  const health = await doctor({ home, cwd: home });
  const convergence = health.status.convergence;

  assert.deepEqual(Object.keys(convergence).sort(), [
    "adapters", "codePackage", "installedRuntime", "repositoryAuthority"
  ]);
  assert.equal(convergence.codePackage.available, true);
  assert.equal(convergence.codePackage.version, RUNTIME_VERSION);
  assert.equal(convergence.installedRuntime.selected, true);
  assert.equal(convergence.installedRuntime.schema.expectedVersion, 2);
  assert.equal(convergence.installedRuntime.schema.available, true);
  assert.match(convergence.installedRuntime.platform.status, /^(?:supported|unsupported)$/u);
  assert.deepEqual(Object.fromEntries(Object.entries(convergence.adapters).map(([name, value]) => [name, value.capability])), {
    generic: "audit_only",
    openspec: "checkpoint_gate",
    comet: "checkpoint_gate",
    sdd: "workflow_gate"
  });
  assert.deepEqual(convergence.repositoryAuthority, {
    checked: false,
    status: "unknown",
    reason: "repository_check_not_requested"
  });
  const serialized = JSON.stringify(convergence);
  assert.doesNotMatch(serialized, /real[-_ ]?time blocking|production_effective|cut.?over.{0,16}(?:true|active)|native_linux_verified/ui);
  assert.equal(serialized.includes(home), false);
});

test("doctor marks Probe unavailable when the installed control schema is unusable", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "afl-convergence-doctor-schema-"));
  await install({ home });
  const paths = pathsFor(home);
  const controlStore = openControlStore({ paths });
  controlStore.database.prepare("UPDATE schema_migrations SET version=999").run();
  controlStore.close();

  const health = await doctor({
    home,
    cwd: home,
    reviewerDetector: async () => ({
      codex: { available: true, executable: "codex" },
      claude: { available: false, executable: null },
      gemini: { available: false, executable: null }
    })
  });
  const installed = health.status.convergence.installedRuntime;

  assert.equal(installed.modules.available, true);
  assert.deepEqual(installed.assets, { prompt: true, schema: true });
  assert.equal(installed.provider.available, true);
  assert.equal(installed.platform.status, "supported");
  assert.equal(health.status.controlStore.available, false);
  assert.equal(installed.schema.compatible, false);
  assert.deepEqual(installed.probe, {
    available: false,
    status: "unavailable",
    reason: "control_store_unavailable",
    provider: {
      available: installed.provider.available,
      operational: installed.provider.operational
    }
  });
  assert.doesNotMatch(JSON.stringify(installed), new RegExp(home.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
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
  assert.match(documentation, /lineage-init --repo-root [^\n]+ --apply/u);
  assert.match(documentation, /identity initialization|身份初始化/u);
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
