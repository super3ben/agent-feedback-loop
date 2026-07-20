import { resolveReviewerExecutable } from "./reviewer-provider.mjs";

const CLI_LABELS = { codex: "Codex", claude: "Claude Code", gemini: "Gemini CLI" };

export async function detectReviewerAdapter({
  cli = "unknown",
  pathValue = process.env.PATH || "",
  env = process.env
} = {}) {
  const executable = Object.hasOwn(CLI_LABELS, cli)
    ? await resolveReviewerExecutable({ cli, env: { ...env, PATH: pathValue } })
    : null;
  return {
    cli,
    label: CLI_LABELS[cli] || cli,
    mode: "isolated_cli_process",
    available: Boolean(executable),
    assurance: executable ? "process_lifecycle_isolated" : "unavailable",
    command: executable,
    reason: executable
      ? "captured provider launches a short-lived isolated CLI process with bounded evidence; this is not an OS, filesystem, or network sandbox"
      : "the captured provider CLI executable is unavailable; the review job remains retryable without using the main conversation"
  };
}

export async function detectAllReviewerAdapters() {
  const result = {};
  for (const cli of Object.keys(CLI_LABELS)) result[cli] = await detectReviewerAdapter({ cli });
  return result;
}
