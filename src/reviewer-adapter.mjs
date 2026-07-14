import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { resolveReviewerExecutable } from "./reviewer-provider.mjs";

const CLI_LABELS = { codex: "Codex", claude: "Claude Code", gemini: "Gemini CLI" };
const CLI_COMMANDS = { codex: "codex", claude: "claude", gemini: "gemini" };

async function resolveExecutable(command, pathValue = process.env.PATH || "") {
  const candidates = command.includes("/") || command.startsWith(".")
    ? [command]
    : pathValue.split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

export async function detectReviewerAdapter({ cli = "unknown", command = process.env.AGENT_FEEDBACK_LOOP_REVIEWER_COMMAND, pathValue = process.env.PATH || "", env = process.env } = {}) {
  if (command) {
    const executable = await resolveExecutable(command, pathValue);
    return {
      cli,
      label: CLI_LABELS[cli] || cli,
      mode: "isolated_cli_process",
      available: Boolean(executable),
      assurance: executable ? "process_lifecycle_isolated" : "unavailable",
      command: executable ? command : null,
      reason: executable
        ? "explicit short-lived reviewer process configured; this is not an OS, filesystem, or network sandbox"
        : "configured reviewer command is not executable or not present on PATH"
    };
  }
  const hostExecutable = CLI_COMMANDS[cli]
    ? await resolveReviewerExecutable({ cli, env: { ...env, PATH: pathValue } })
    : null;
  return {
    cli,
    label: CLI_LABELS[cli] || cli,
    mode: "isolated_cli_process",
    available: Boolean(hostExecutable),
    assurance: hostExecutable ? "process_lifecycle_isolated" : "unavailable",
    command: hostExecutable,
    reason: hostExecutable
      ? "built-in provider launches a short-lived isolated CLI process with bounded evidence; this is not an OS, filesystem, or network sandbox"
      : "the provider CLI executable is unavailable; the review job remains pending without using the main conversation"
  };
}

export async function detectAllReviewerAdapters({ command = process.env.AGENT_FEEDBACK_LOOP_REVIEWER_COMMAND } = {}) {
  const result = {};
  for (const cli of Object.keys(CLI_LABELS)) result[cli] = await detectReviewerAdapter({ cli, command });
  return result;
}
