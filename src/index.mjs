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

// Declarative CLI registry. Adding a new model-visible CLI = adding one entry.
// configKey/configPath are resolved against home in pathsFor.
const CLIS = [
  {
    id: "codex",
    label: "Codex",
    format: "toml",
    configKey: "codexConfig",
    configPath: [".codex", "config.toml"],
    hookEvent: "UserPromptSubmit",
    hookArgs: ["--event", "UserPromptSubmit", "--continue"]
  },
  {
    id: "claude",
    label: "Claude Code",
    format: "json",
    configKey: "claudeSettings",
    configPath: [".claude", "settings.json"],
    hookEvent: "UserPromptSubmit",
    hookArgs: ["--event", "UserPromptSubmit"]
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    format: "json",
    configKey: "geminiSettings",
    configPath: [".gemini", "settings.json"],
    hookEvent: "BeforeAgent",
    hookArgs: ["--event", "BeforeAgent"]
  }
];

export function pathsFor(home = os.homedir()) {
  const packRoot = path.join(home, ".agent", "feedback-loop");
  const paths = {
    home,
    packRoot,
    promptFile: path.join(packRoot, "prompts", "reflection-agent.md"),
    ruleFile: path.join(packRoot, "rules", "feedback-loop.md"),
    coreHook: path.join(packRoot, "hooks", "core-hook.sh"),
    triggerRules: path.join(packRoot, "hooks", "trigger-rules.sh"),
    // Per-CLI hooks from <=0.1.x, replaced by the single core-hook.sh.
    // Deleted on install/uninstall so stale copies can't confuse the model.
    legacyHooks: [
      path.join(packRoot, "hooks", "codex-hook.sh"),
      path.join(packRoot, "hooks", "claude-hook.sh")
    ]
  };
  for (const cli of CLIS) {
    paths[cli.configKey] = path.join(home, ...cli.configPath);
  }
  return paths;
}

// Full shell command a CLI config should invoke for this hook.
function hookCommand(paths, cli) {
  return [paths.coreHook, ...cli.hookArgs].join(" ");
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

function codexHookBlock(paths, cli) {
  return [
    CODEX_MARKER_START,
    "[[hooks.UserPromptSubmit]]",
    "",
    "[[hooks.UserPromptSubmit.hooks]]",
    'type = "command"',
    `command = ${tomlString(hookCommand(paths, cli))}`,
    "timeout = 2",
    'statusMessage = "Injecting feedback reflection prompt"',
    CODEX_MARKER_END
  ].join("\n");
}

// Remove our managed entries for a given JSON-config CLI (Claude/Gemini).
// Matches by event key + the core-hook path appearing in command, so it cleans
// both the current core-hook wiring and any legacy per-CLI hook commands.
function removeJsonHookEntries(settings, paths, cli) {
  const event = cli.hookEvent;
  const hooks = settings.hooks?.[event];
  if (!Array.isArray(hooks)) return settings;
  settings.hooks[event] = hooks
    .map((entry) => {
      if (!entry || !Array.isArray(entry.hooks)) return entry;
      return {
        ...entry,
        hooks: entry.hooks.filter((hook) => {
          const command = typeof hook.command === "string" ? hook.command : "";
          const prompt = typeof hook.prompt === "string" ? hook.prompt : "";
          return !command.includes(paths.coreHook)
            && !command.includes("codex-hook.sh")
            && !command.includes("claude-hook.sh")
            && !prompt.includes(paths.promptFile);
        })
      };
    })
    .filter((entry) => !entry || !Array.isArray(entry.hooks) || entry.hooks.length > 0);
  return settings;
}

async function readJsonSettings(file) {
  if (!(await exists(file))) return {};
  const text = await readFile(file, "utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

async function removeLegacyHooks(paths, dryRun, actions) {
  for (const file of paths.legacyHooks) {
    if (!(await exists(file))) continue;
    actions.push(`remove legacy hook ${file}`);
    if (!dryRun) await rm(file, { force: true });
  }
}

async function writePromptPack(paths, dryRun, actions) {
  actions.push(`copy templates -> ${paths.packRoot}`);
  if (dryRun) {
    await removeLegacyHooks(paths, dryRun, actions);
    return;
  }
  await mkdir(path.dirname(paths.packRoot), { recursive: true });
  await cp(TEMPLATE_ROOT, paths.packRoot, { recursive: true });
  await chmod(paths.coreHook, 0o755);
  // cp does not delete files absent from templates, so pre-0.2 per-CLI hooks
  // linger after an upgrade. Remove them explicitly.
  await removeLegacyHooks(paths, dryRun, actions);
}

async function installTomlBlock(paths, cli, dryRun, actions) {
  const configFile = paths[cli.configKey];
  await backup(configFile, dryRun, actions);
  const current = (await exists(configFile)) ? await readFile(configFile, "utf8") : "";
  const cleaned = removeMarkedCodexBlock(current);
  const block = codexHookBlock(paths, cli);
  const next = `${cleaned.trimEnd()}${cleaned.trim() ? "\n\n" : ""}${block}\n`;
  actions.push(`connect ${cli.label} hook -> ${paths.coreHook}`);
  if (!dryRun) {
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, next, "utf8");
  }
}

async function installJsonHooks(paths, cli, dryRun, actions) {
  const configFile = paths[cli.configKey];
  await backup(configFile, dryRun, actions);
  const settings = removeJsonHookEntries(await readJsonSettings(configFile), paths, cli);
  settings.hooks = settings.hooks || {};
  settings.hooks[cli.hookEvent] = settings.hooks[cli.hookEvent] || [];
  settings.hooks[cli.hookEvent].push({
    matcher: "",
    hooks: [
      {
        type: "command",
        command: hookCommand(paths, cli),
        timeout: 2
      }
    ]
  });
  actions.push(`connect ${cli.label} hook -> ${paths.coreHook}`);
  if (!dryRun) {
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }
}

async function installCli(paths, cli, dryRun, actions) {
  if (cli.format === "toml") {
    await installTomlBlock(paths, cli, dryRun, actions);
  } else {
    await installJsonHooks(paths, cli, dryRun, actions);
  }
}

export async function install(options = {}) {
  const home = options.home || os.homedir();
  const dryRun = Boolean(options.dryRun);
  const paths = pathsFor(home);
  const actions = [];
  await writePromptPack(paths, dryRun, actions);
  for (const cli of CLIS) {
    await installCli(paths, cli, dryRun, actions);
  }
  return { dryRun, paths, actions };
}

async function uninstallCli(paths, cli, dryRun, actions) {
  const configFile = paths[cli.configKey];
  if (!(await exists(configFile))) return;
  await backup(configFile, dryRun, actions);
  if (cli.format === "toml") {
    const current = await readFile(configFile, "utf8");
    const next = `${removeMarkedCodexBlock(current)}\n`;
    actions.push(`disconnect ${cli.label} hook`);
    if (!dryRun) await writeFile(configFile, next, "utf8");
  } else {
    const settings = removeJsonHookEntries(await readJsonSettings(configFile), paths, cli);
    actions.push(`disconnect ${cli.label} hook`);
    if (!dryRun) await writeFile(configFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }
}

export async function uninstall(options = {}) {
  const home = options.home || os.homedir();
  const dryRun = Boolean(options.dryRun);
  const removeFiles = Boolean(options.removeFiles);
  const paths = pathsFor(home);
  const actions = [];

  for (const cli of CLIS) {
    await uninstallCli(paths, cli, dryRun, actions);
  }

  if (removeFiles) {
    actions.push(`remove ${paths.packRoot}`);
    if (!dryRun) await rm(paths.packRoot, { recursive: true, force: true });
  } else {
    await removeLegacyHooks(paths, dryRun, actions);
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

  const files = {
    prompt: await exists(paths.promptFile),
    rule: await exists(paths.ruleFile),
    coreHook: await exists(paths.coreHook),
    triggerRules: await exists(paths.triggerRules),
    coreHookExecutable: await isExecutable(paths.coreHook)
  };

  const clis = {};
  for (const cli of CLIS) {
    const configFile = paths[cli.configKey];
    if (cli.format === "toml") {
      const text = (await exists(configFile)) ? await readFile(configFile, "utf8") : "";
      clis[cli.id] = {
        connected: text.includes(paths.coreHook),
        managedBlock: text.includes(CODEX_MARKER_START)
      };
    } else {
      let settings = {};
      try {
        settings = await readJsonSettings(configFile);
      } catch {
        settings = {};
      }
      const entries = Array.isArray(settings.hooks?.[cli.hookEvent])
        ? settings.hooks[cli.hookEvent].flatMap((entry) => (Array.isArray(entry.hooks) ? entry.hooks : []))
        : [];
      clis[cli.id] = {
        connected: entries.some((hook) => typeof hook.command === "string" && hook.command.includes(paths.coreHook))
      };
    }
  }

  const healthy = Object.values(files).every(Boolean)
    && CLIS.every((cli) => clis[cli.id].connected);
  return { healthy, home, files, clis };
}

export async function assertTemplateTree() {
  await stat(TEMPLATE_ROOT);
}
