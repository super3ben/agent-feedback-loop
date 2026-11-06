// Native DeepSeek Harness plugin for agent-feedback-loop (AFL).
//
// On every prompt submission (`agent/pre-step`) it feeds the prompt into the
// local AFL capture pipeline (`core-hook.sh`) and, when AFL returns additional
// context (compiled recurrence rules, applicable lesson guidance), attaches it
// to the turn. It never blocks a prompt: a slow or failing hook degrades to
// running without AFL for that turn.
//
// Deliberately dependency-free: no dsh packages are imported, so the plugin
// links into any profile without peer-resolution constraints. The injected
// context message is a plain user-role message of the same shape the harness
// itself builds (id/role/content/source).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

export const name = "agent-feedback-loop";

const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

/**
 * The `source` this plugin stamps on the message it injects.
 *
 * DSH's durable session format owns message-source syntax, and it changed
 * between versions. Format v3 accepted `{ kind: "plugin", plugin: "<name>" }`;
 * format v4 refuses it — `@deepseek-ai/dsh-session-format-v3-to-v4` throws
 * "format v4 message requires a producer-owned source kind" from row admission,
 * and the throw terminates the whole turn. The failure surfaces to the user as
 * "本轮运行失败" with no assistant message logged at all, because the injected
 * message is rejected as it is written to disk.
 *
 * v4's own rule (`producerKind`) is to name the producer: third-party plugins
 * get `plugin:<package>`, which is also what historical v3 rows were migrated
 * to. Emitting that shape is therefore correct on v4 and consistent with what
 * the same log already contains.
 *
 * The version comes from the session header — the log's format version, not the
 * plugin's. Anything that is not a number below 4 gets the v4 shape, including
 * an absent header: guessing "old" would recreate the exact failure this exists
 * to prevent, while guessing "new" at worst produces a source kind a v3 log
 * tolerates (v3 does not police `kind`).
 */
export function producerSource(sessionFormatVersion) {
  return typeof sessionFormatVersion === "number" && sessionFormatVersion < 4
    ? { kind: "plugin", plugin: name }
    : { kind: `plugin:${name}` };
}

function defaultHookCommand() {
  return path.join(homedir(), ".agent", "feedback-loop", "hooks", "core-hook.sh");
}

/** Run one hook process with the payload on stdin; resolve the parsed JSON response. */
function runHookProcess(command, args, { input, timeoutMs, cwd, signal }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], ...(signal ? { signal } : {}) });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      if (!settled) { settled = true; reject(new Error(`hook timeout after ${timeoutMs}ms`)); }
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`hook exit ${code}: ${stderr.slice(0, 200)}`));
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

/** Flatten the incoming turn's content blocks to the prompt text. */
function promptText(messages) {
  return (messages ?? [])
    .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

export function apply(ctx, config = {}) {
  const hookCommand = typeof config.hookCommand === "string" && config.hookCommand.trim()
    ? config.hookCommand
    : defaultHookCommand();
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_HOOK_TIMEOUT_MS;

  ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    const prompt = promptText(messages);
    if (!prompt.trim()) return next();
    const workspace = agent?.session?.header?.cwd;
    const payload = JSON.stringify({
      // CC-dialect payload: core-hook parses these field names for every CLI.
      // transcript_path stays empty — the harness exposes no transcript file;
      // AFL treats a dialect that cannot carry one as classifier-eligible.
      session_id: agent?.session?.header?.id ?? "",
      cwd: workspace ?? process.cwd(),
      prompt,
      transcript_path: ""
    });
    let additionalContext = null;
    try {
      const { stdout } = await runHookProcess(
        hookCommand,
        ["--event", "UserPromptSubmit", "--cli", "dsh"],
        { input: payload, timeoutMs, cwd: workspace || undefined, signal }
      );
      const parsed = JSON.parse(stdout);
      const text = parsed?.hookSpecificOutput?.additionalContext;
      if (typeof text === "string" && text.trim()) additionalContext = text.trim();
    } catch (error) {
      // Never block the user's prompt on AFL trouble; the turn runs without us.
      ctx.logger?.warn?.(`agent-feedback-loop: hook skipped (${String(error?.message || error)})`);
    }

    const downstream = await next();
    if (!additionalContext || downstream?.kind !== "enter") return downstream;
    return {
      ...downstream,
      messages: [
        ...downstream.messages,
        {
          id: randomUUID(),
          role: "user",
          content: [{ type: "text", text: additionalContext }],
          source: producerSource(agent?.session?.header?.version)
        }
      ]
    };
  });
}
