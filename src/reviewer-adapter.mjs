import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

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

export async function detectReviewerAdapter({ cli = "unknown", command = process.env.AGENT_FEEDBACK_LOOP_REVIEWER_COMMAND, pathValue = process.env.PATH || "" } = {}) {
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
  const hostExecutable = CLI_COMMANDS[cli] ? await resolveExecutable(CLI_COMMANDS[cli], pathValue) : null;
  return {
    cli,
    label: CLI_LABELS[cli] || cli,
    mode: "prompt_delegated_subagent",
    available: Boolean(hostExecutable),
    assurance: hostExecutable ? "delegated_unattested" : "unavailable",
    command: null,
    reason: hostExecutable
      ? "model-visible hook delegates to a background subagent and accepts only a one-time receipt; native platform identity is not cryptographically attested"
      : "the CLI executable is not present on PATH; hook configuration alone does not prove a usable reviewer host"
  };
}

export async function detectAllReviewerAdapters({ command = process.env.AGENT_FEEDBACK_LOOP_REVIEWER_COMMAND } = {}) {
  const result = {};
  for (const cli of Object.keys(CLI_LABELS)) result[cli] = await detectReviewerAdapter({ cli, command });
  return result;
}
