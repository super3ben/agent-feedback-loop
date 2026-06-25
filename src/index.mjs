import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SRC_DIR, "..");
const TEMPLATE_ROOT = path.join(PACKAGE_ROOT, "templates");

const CODEX_MARKER_START = "# agent-feedback-loop:start";
const CODEX_MARKER_END = "# agent-feedback-loop:end";

export function pathsFor(home = os.homedir()) {
  const packRoot = path.join(home, ".agent", "feedback-loop");
  return {
    home,
    packRoot,
    promptFile: path.join(packRoot, "prompts", "reflection-agent.md"),
    ruleFile: path.join(packRoot, "rules", "feedback-loop.md"),
    codexHook: path.join(packRoot, "hooks", "codex-hook.sh"),
    claudeHook: path.join(packRoot, "hooks", "claude-hook.sh"),
    codexConfig: path.join(home, ".codex", "config.toml"),
    claudeSettings: path.join(home, ".claude", "settings.json")
  };
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds())
  ].join("");
}

async function backup(file, dryRun, actions) {
  if (!(await exists(file))) return null;
  const target = `${file}.backup-${timestamp()}`;
  actions.push(`backup ${file} -> ${target}`);
  if (!dryRun) await copyFile(file, target);
  return target;
}

function tomlString(value) {
  return JSON.stringify(value);
}

function removeMarkedCodexBlock(text) {
  const lines = text.split(/\r?\n/);
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    if (line.trim() === CODEX_MARKER_START) {
      skipping = true;
      continue;
    }
    if (line.trim() === CODEX_MARKER_END) {
      skipping = false;
      continue;
    }
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function codexHookBlock(paths) {
  return [
    CODEX_MARKER_START,
    "[[hooks.UserPromptSubmit]]",
    "",
    "[[hooks.UserPromptSubmit.hooks]]",
    'type = "command"',
    `command = ${tomlString(paths.codexHook)}`,
    "timeout = 2",
    'statusMessage = "Injecting feedback reflection prompt"',
    CODEX_MARKER_END
  ].join("\n");
}

function removeClaudeEntries(settings, paths) {
  const hooks = settings.hooks?.UserPromptSubmit;
  if (!Array.isArray(hooks)) return settings;
  settings.hooks.UserPromptSubmit = hooks
    .map((entry) => {
      if (!entry || !Array.isArray(entry.hooks)) return entry;
      return {
        ...entry,
        hooks: entry.hooks.filter((hook) => {
          const command = typeof hook.command === "string" ? hook.command : "";
          const prompt = typeof hook.prompt === "string" ? hook.prompt : "";
          return !command.includes(paths.claudeHook) && !prompt.includes(paths.promptFile);
        })
      };
    })
    .filter((entry) => !entry || !Array.isArray(entry.hooks) || entry.hooks.length > 0);
  return settings;
}

async function readClaudeSettings(file) {
  if (!(await exists(file))) return {};
  const text = await readFile(file, "utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

async function writePromptPack(paths, dryRun, actions) {
  actions.push(`copy templates -> ${paths.packRoot}`);
  if (dryRun) return;
  await mkdir(path.dirname(paths.packRoot), { recursive: true });
  await cp(TEMPLATE_ROOT, paths.packRoot, { recursive: true });
  await chmod(paths.codexHook, 0o755);
  await chmod(paths.claudeHook, 0o755);
}

async function installCodex(paths, dryRun, actions) {
  await backup(paths.codexConfig, dryRun, actions);
  const current = (await exists(paths.codexConfig)) ? await readFile(paths.codexConfig, "utf8") : "";
  const cleaned = removeMarkedCodexBlock(current);
  const next = cleaned.includes(paths.codexHook)
    ? `${cleaned.trimEnd()}\n`
    : `${cleaned.trimEnd()}${cleaned.trim() ? "\n\n" : ""}${codexHookBlock(paths)}\n`;
  actions.push(`connect Codex hook -> ${paths.codexHook}`);
  if (!dryRun) {
    await mkdir(path.dirname(paths.codexConfig), { recursive: true });
    await writeFile(paths.codexConfig, next, "utf8");
  }
}

async function installClaude(paths, dryRun, actions) {
  await backup(paths.claudeSettings, dryRun, actions);
  const settings = removeClaudeEntries(await readClaudeSettings(paths.claudeSettings), paths);
  settings.hooks = settings.hooks || {};
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit || [];
  settings.hooks.UserPromptSubmit.push({
    matcher: "",
    hooks: [
      {
        type: "command",
        command: paths.claudeHook,
        timeout: 2
      }
    ]
  });
  actions.push(`connect Claude Code hook -> ${paths.claudeHook}`);
  if (!dryRun) {
    await mkdir(path.dirname(paths.claudeSettings), { recursive: true });
    await writeFile(paths.claudeSettings, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }
}

export async function install(options = {}) {
  const home = options.home || os.homedir();
  const dryRun = Boolean(options.dryRun);
  const paths = pathsFor(home);
  const actions = [];
  await writePromptPack(paths, dryRun, actions);
  await installCodex(paths, dryRun, actions);
  await installClaude(paths, dryRun, actions);
  return { dryRun, paths, actions };
}

export async function uninstall(options = {}) {
  const home = options.home || os.homedir();
  const dryRun = Boolean(options.dryRun);
  const removeFiles = Boolean(options.removeFiles);
  const paths = pathsFor(home);
  const actions = [];

  if (await exists(paths.codexConfig)) {
    await backup(paths.codexConfig, dryRun, actions);
    const current = await readFile(paths.codexConfig, "utf8");
    const next = `${removeMarkedCodexBlock(current)}\n`;
    actions.push("disconnect Codex hook");
    if (!dryRun) await writeFile(paths.codexConfig, next, "utf8");
  }

  if (await exists(paths.claudeSettings)) {
    await backup(paths.claudeSettings, dryRun, actions);
    const settings = removeClaudeEntries(await readClaudeSettings(paths.claudeSettings), paths);
    actions.push("disconnect Claude Code hook");
    if (!dryRun) await writeFile(paths.claudeSettings, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }

  if (removeFiles) {
    actions.push(`remove ${paths.packRoot}`);
    if (!dryRun) await rm(paths.packRoot, { recursive: true, force: true });
  }

  return { dryRun, paths, actions };
}

async function isExecutable(file) {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function doctor(options = {}) {
  const home = options.home || os.homedir();
  const paths = pathsFor(home);
  const codexText = (await exists(paths.codexConfig)) ? await readFile(paths.codexConfig, "utf8") : "";
  let claude = {};
  try {
    claude = await readClaudeSettings(paths.claudeSettings);
  } catch {
    claude = {};
  }
  const claudeHooks = Array.isArray(claude.hooks?.UserPromptSubmit)
    ? claude.hooks.UserPromptSubmit.flatMap((entry) => (Array.isArray(entry.hooks) ? entry.hooks : []))
    : [];

  const files = {
    prompt: await exists(paths.promptFile),
    rule: await exists(paths.ruleFile),
    codexHook: await exists(paths.codexHook),
    claudeHook: await exists(paths.claudeHook),
    codexHookExecutable: await isExecutable(paths.codexHook),
    claudeHookExecutable: await isExecutable(paths.claudeHook)
  };
  const codex = {
    connected: codexText.includes(paths.codexHook),
    managedBlock: codexText.includes(CODEX_MARKER_START)
  };
  const claudeStatus = {
    commandHookConnected: claudeHooks.some((hook) => hook.command === paths.claudeHook),
    agentPromptConnected: claudeHooks.some((hook) => typeof hook.prompt === "string" && hook.prompt.includes(paths.promptFile))
  };
  const healthy = Object.values(files).every(Boolean)
    && codex.connected
    && claudeStatus.commandHookConnected;
  return { healthy, home, files, codex, claude: claudeStatus };
}

export async function assertTemplateTree() {
  await stat(TEMPLATE_ROOT);
}
