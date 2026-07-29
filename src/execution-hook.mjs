import {
  EXECUTION_MUTATION_LIMIT,
  deriveExecutionMonitorId,
  executionToolLabel,
  isMutatingTool
} from "./execution-monitor.mjs";

export const EXECUTION_STOP_REASON = "Convergence guard: this run has made too many tool calls without the user stepping in. Stop, report what is verified and what is not, and wait for the user to decide the next step.";

// Only Codex is hard-blocked. Claude Code halts on its own after one refusal
// and hands control back, so blocking it buys nothing; Gemini has no evidence
// behind it at all and is deliberately not wired.
const GUARDED_CLIS = new Set(["codex"]);

/**
 * PreToolUse guard. Blocks before the tool runs — a post-run hook cannot stop a
 * mutation that already happened, and an advisory message does not stop this
 * agent either: when asked to review its own direction it wrote a review, then
 * approved itself and carried on.
 *
 * Fails open on every internal error: a broken guard must not break the run.
 */
export async function handleExecutionHook({
  payload,
  cli,
  controlStore,
  writeResponse = async () => null,
  nativeResponse = { continue: true },
  limit = EXECUTION_MUTATION_LIMIT
} = {}) {
  let response = { ...nativeResponse, continue: true };
  try {
    if (!GUARDED_CLIS.has(cli) || !payload || typeof payload !== "object" || Array.isArray(payload)
        || typeof controlStore?.recordExecutionToolCall !== "function") {
      await writeResponse(response);
      return response;
    }
    const sessionId = payload.session_id ?? payload.sessionId;
    const toolName = payload.tool_name ?? payload.toolName;
    const monitorId = deriveExecutionMonitorId({ cli, sessionId });
    const observed = controlStore.recordExecutionToolCall({
      monitorId,
      cli,
      mutating: isMutatingTool(toolName),
      toolLabel: executionToolLabel(toolName),
      limit
    });
    if (observed?.stop) {
      response = { decision: "block", reason: EXECUTION_STOP_REASON };
    }
  } catch {
    response = { ...nativeResponse, continue: true };
  }
  try { await writeResponse(response); } catch {}
  return response;
}

/**
 * Clears the counter when the user speaks. The counter means "tool calls since
 * the user last intervened", so a new prompt is exactly the reset condition.
 */
export function resetExecutionMonitorForPrompt({ payload, cli, controlStore } = {}) {
  try {
    if (!GUARDED_CLIS.has(cli) || !payload || typeof payload !== "object" || Array.isArray(payload)
        || typeof controlStore?.resetExecutionMonitor !== "function") return { reset: false };
    const sessionId = payload.session_id ?? payload.sessionId;
    return controlStore.resetExecutionMonitor({
      monitorId: deriveExecutionMonitorId({ cli, sessionId })
    });
  } catch {
    return { reset: false };
  }
}
