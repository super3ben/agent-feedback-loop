import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export const RECONCILE_LAUNCHD_LABEL = "io.github.super3ben.agent-feedback-loop.reconcile";

const execFileAsync = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function launchDomain() {
  return `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;
}

export function createLaunchdSchedulerHost({ run = execFileAsync, sleep = wait } = {}) {
  return {
    async install({ plistFile, label }) {
      const domain = launchDomain();
      try { await run("launchctl", ["bootout", `${domain}/${label}`]); } catch {}
      let bootstrapError = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await run("launchctl", ["bootstrap", domain, plistFile]);
          bootstrapError = null;
          break;
        } catch (error) {
          bootstrapError = error;
          if (attempt < 4) await sleep(Math.min(100 * (2 ** attempt), 800));
        }
      }
      if (bootstrapError) throw bootstrapError;
      await run("launchctl", ["kickstart", "-k", `${domain}/${label}`]);
      return { active: true };
    },
    async inspect({ label }) {
      try {
        const result = await run("launchctl", ["print", `${launchDomain()}/${label}`]);
        const output = String(result?.stdout || "");
        const active = /state\s*=\s*running/i.test(output) || /active count\s*=\s*[1-9]\d*/i.test(output);
        return { active, state: active ? "running" : "loaded_idle" };
      } catch {
        return { active: false, state: "unloaded" };
      }
    },
    async remove({ label }) {
      try { await run("launchctl", ["bootout", `${launchDomain()}/${label}`]); } catch {}
      return { active: false };
    }
  };
}

export function renderReconcileLaunchAgent({ paths, intervalSeconds = 60 }) {
  const args = [paths.runtimeLauncher, "reconcile-daemon", "--home", paths.home];
  const argXml = args.map((value) => `      <string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${RECONCILE_LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(paths.dataRoot)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>LowPriorityIO</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xml(paths.reconcileLog)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(paths.reconcileLog)}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>AGENT_FEEDBACK_LOOP_DEBUG</key>
      <string>1</string>
      <key>AGENT_FEEDBACK_LOOP_RECONCILE_INTERVAL</key>
      <string>${Math.max(30, Math.floor(Number(intervalSeconds) || 60))}</string>
    </dict>
  </dict>
</plist>
`;
}

async function safeConfiguredFile(file) {
  try {
    const info = await lstat(file);
    return info.isFile() && !info.isSymbolicLink()
      && (typeof process.getuid !== "function" || info.uid === process.getuid());
  } catch {
    return false;
  }
}

export async function installReconcileScheduler({
  paths,
  platform = process.platform,
  dryRun = false,
  activate = false,
  host = createLaunchdSchedulerHost(),
  intervalSeconds = 60
}) {
  if (platform !== "darwin") {
    return { supported: false, configured: false, active: false, reason: "unsupported_platform" };
  }
  if (!dryRun) {
    await mkdir(path.dirname(paths.reconcileLaunchAgent), { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(paths.reconcileLog), { recursive: true, mode: 0o700 });
    const temp = `${paths.reconcileLaunchAgent}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, renderReconcileLaunchAgent({ paths, intervalSeconds }), { mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, paths.reconcileLaunchAgent);
  }
  const activation = !dryRun && activate
    ? await host.install({ plistFile: paths.reconcileLaunchAgent, label: RECONCILE_LAUNCHD_LABEL })
    : { active: false };
  return { supported: true, configured: true, active: Boolean(activation.active), activation: activate ? "requested" : "not_requested" };
}

export async function inspectReconcileScheduler({ paths, platform = process.platform, host = createLaunchdSchedulerHost() }) {
  if (platform !== "darwin") {
    return { supported: false, configured: false, active: false, reason: "unsupported_platform" };
  }
  const configured = await safeConfiguredFile(paths.reconcileLaunchAgent);
  if (!configured) return { supported: true, configured: false, active: false };
  const status = await host.inspect({ plistFile: paths.reconcileLaunchAgent, label: RECONCILE_LAUNCHD_LABEL });
  return { supported: true, configured: true, active: Boolean(status.active), state: status.state || (status.active ? "running" : "loaded_idle") };
}

export async function removeReconcileScheduler({
  paths,
  platform = process.platform,
  dryRun = false,
  activate = false,
  host = createLaunchdSchedulerHost()
}) {
  if (platform !== "darwin") return { supported: false, removed: false, reason: "unsupported_platform" };
  if (!dryRun && activate) await host.remove({ plistFile: paths.reconcileLaunchAgent, label: RECONCILE_LAUNCHD_LABEL });
  if (!dryRun) await rm(paths.reconcileLaunchAgent, { force: true });
  return { supported: true, removed: true };
}
