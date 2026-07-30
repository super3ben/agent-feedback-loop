import {
  EXECUTION_REWORK_LIMIT,
  EXECUTION_SPREAD_LIMIT,
  deriveExecutionMonitorId,
  deriveReworkTarget,
  executionToolLabel,
  isMutatingTool
} from "./execution-monitor.mjs";

// The block has to ask for a verdict on the direction, not a status report.
//
// The previous wording said stop, report, and let the user decide. An agent did
// exactly that: it stopped and asked for authorisation to continue editing the
// same file, and only re-examined its approach after the user explicitly asked
// whether it had over-designed. The guard had detected circling and then said
// nothing about why the run was circling, so the default next move was to
// request permission to keep going in the same direction.
//
// Both texts refuse a self-approval. An agent asked to review its own approach
// wrote a review document, concluded its approach was fine, and carried on, so
// "consider whether you over-designed" is not a usable instruction. What is
// asked for instead is a decision between two named causes, each with a
// concrete consequence: name the scope to withdraw, or state what forces the
// work to continue.
const STOP_PREAMBLE = "Convergence guard: this run is not converging, so the direction is now under review rather than the next edit.";

const STOP_VERDICT = [
  "Do not resume, and do not ask for authorisation to continue as planned. Decide which of these happened, from the work itself:",
  "(a) scope growth — you extended a narrow fix into a general mechanism the task never asked for. Name the extension, state the smallest change that satisfies the original request, and withdraw the rest.",
  "(b) contradiction — the existing design or tests genuinely conflict with the requested change. State the conflict and what must be settled first.",
  "Then report which one it was and what you are withdrawing or narrowing to. If it is (a), also say what review or design work now becomes unnecessary. A review of your own approach that concludes it was correct is not an answer to this."
].join(" ");

export const EXECUTION_STOP_REASON = `${STOP_PREAMBLE} One artifact has been rewritten repeatedly with no new input from the user, so further passes are refining rather than converging. ${STOP_VERDICT}`;

// Spreading sideways needs its own text: every per-file counter stayed low, so
// telling the agent "this file was rewritten repeatedly" would not match what it
// just did and would point it at the wrong thing to narrow.
export const EXECUTION_SPREAD_STOP_REASON = `${STOP_PREAMBLE} Many separate artifacts have been rewritten in this run without the user stepping in — the direction keeps widening rather than closing. ${STOP_VERDICT}`;

// Only Codex is hard-blocked. Claude Code halts on its own after one refusal
// and hands control back, so blocking it buys nothing; Gemini has no evidence
// behind it at all and is deliberately not wired.
const GUARDED_CLIS = new Set(["codex"]);

// An independent process is now reviewing the direction. The retry instruction
// is load-bearing: the verdict can only be handed over on a later blocked call,
// so an agent that stops entirely never collects it. Reads stay available, so
// waiting is not idle time.
const DIAGNOSIS_DISPATCHED = "An independent review of this direction has been started; it does not run inside your session and takes roughly a minute. Do not ask the user to intervene yet. Keep reading and gathering evidence, then retry a write to collect the verdict.";

const DIAGNOSIS_PENDING = "The independent review of this direction is still running. Keep reading rather than writing, then retry to collect the verdict.";

// The verdict replaces the generic text rather than being appended to it: by
// this point the agent already knows it is circling, and what it needs is the
// specific finding.
const DIAGNOSIS_VERDICT_PREFIX = "Convergence guard: an independent review of this run has returned a verdict on the direction. It was produced outside your session, so adopting it is not self-approval — treat it as a decision already made, not a suggestion to evaluate.";

const DIAGNOSIS_VERDICT_SUFFIX = "Act on this now: state what you are withdrawing or narrowing to, then continue within that narrower scope. If you believe the verdict is wrong, stop and say so with the evidence rather than continuing as planned.";

// Two corrections that did not converge mean the plan is the problem, and a
// third machine-generated verdict would only reach the same place faster.
const HUMAN_REQUIRED = "This run has already corrected its direction twice and is still not converging, so automatic correction stops here. Do not start another attempt. Report to the user: what was tried, what each correction changed, and why the work is still widening — and let them decide the direction.";

/**
 * PreToolUse guard. Counts how often one artifact is rewritten while the user
 * stays silent, and blocks before the tool runs — a post-run hook cannot stop a
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
  limit = EXECUTION_REWORK_LIMIT,
  spreadLimit = EXECUTION_SPREAD_LIMIT,
  // Dispatching the review is the caller's business: the hook must not depend
  // on being able to spawn, and a dispatch that fails leaves the block standing.
  launchDiagnosis = () => ({ attempted: false, reason: "not_wired" })
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
    const toolInput = payload.tool_input ?? payload.toolInput;
    const monitorId = deriveExecutionMonitorId({ cli, sessionId });
    const observed = controlStore.recordExecutionToolCall({
      monitorId,
      cli,
      mutating: isMutatingTool(toolName),
      toolLabel: executionToolLabel(toolName),
      target: deriveReworkTarget({ toolName, toolInput }),
      limit,
      spreadLimit
    });
    if (observed?.stop) {
      // The reason names the shape that tripped, because narrowing one artifact
      // and narrowing a widening direction are different instructions.
      const shapeReason = observed.shape === "spread" ? EXECUTION_SPREAD_STOP_REASON : EXECUTION_STOP_REASON;
      let reason = shapeReason;
      if (observed.outcome === "dispatch") {
        // The block holds while this runs, so there is no need to wait for it
        // inside the hook's few seconds. Measured review latency is 29-90s.
        // A failed dispatch is not fatal: the block still stands, and the next
        // blocked call tries again.
        try {
          launchDiagnosis({ monitorId, sessionId, payload });
        } catch {}
        reason = `${shapeReason} ${DIAGNOSIS_DISPATCHED}`;
      } else if (observed.outcome === "await") {
        reason = `${shapeReason} ${DIAGNOSIS_PENDING}`;
      } else if (observed.outcome === "correct" && observed.verdict) {
        // An external verdict is not self-approval, so acting on it directly is
        // legitimate: the run narrows itself without waiting for a person.
        reason = `${DIAGNOSIS_VERDICT_PREFIX}\n\n${observed.verdict}\n\n${DIAGNOSIS_VERDICT_SUFFIX}`;
      } else if (observed.outcome === "human") {
        reason = `${shapeReason} ${HUMAN_REQUIRED}`;
      }
      response = { decision: "block", reason };
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
