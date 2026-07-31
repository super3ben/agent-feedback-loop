import {
  EXECUTION_REWORK_LIMIT,
  EXECUTION_SPREAD_LIMIT,
  deriveExecutionMonitorId,
  deriveReworkTarget,
  executionToolLabel,
  isMutatingTool,
  runsTests
} from "./execution-monitor.mjs";
import { diagnosisExpired } from "./direction-review.mjs";

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

// Codex and Claude Code are both guarded. Claude was left out at first on the
// grounds that it halts by itself after one refusal, but halting is not the
// behaviour wanted: the run is supposed to attribute the over-reach and narrow,
// and a refusal with no reason attached teaches it nothing. Gemini still has no
// evidence behind it and is deliberately not wired.
const GUARDED_CLIS = new Set(["codex", "claude"]);

// The two hosts read different fields, and a block written in the wrong shape is
// ignored rather than rejected — it fails open silently, which is the worst way
// for a guard to be wrong. Both shapes below were confirmed against live
// payloads, not documentation: Codex 0.145.0 exposes `decision`/`reason` (its
// binary carries no `systemMessage` field at all), while Claude Code takes
// `hookSpecificOutput.permissionDecision` and hands the reason back to the model
// so the turn continues. Claude's legacy top-level `decision` is deprecated for
// PreToolUse, so it is not used here.
function blockResponse(cli, reason) {
  if (cli === "claude") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason
      }
    };
  }
  return { decision: "block", reason };
}

// Escalation text. It must not claim corrections happened: the reachable route
// to here is repeated blocks, meaning the attribution instruction was delivered
// several times and writes kept coming. Telling an agent it "corrected twice"
// when it did not invites it to argue with the premise instead of stopping.
const HUMAN_REQUIRED = "This direction has now been blocked several times in the same run and the writes have continued, so automatic correction stops here. Do not start another attempt and do not retry the write. Report to the user: what you were trying to do, what you have already changed, and why you kept going after being asked to narrow — then let them decide the direction.";

// Said only when a review really was launched. The retry instruction is
// load-bearing: a verdict can only be handed over on a later blocked call, so a
// run that stops entirely never collects it. Reads stay allowed, so the wait is
// not idle time.
const REVIEW_DISPATCHED = "An independent review of this direction has been started. It runs outside your session and takes about a minute. Do not ask the user to intervene yet. Keep reading and gathering evidence, then retry a write to collect its verdict.";

const REVIEW_PENDING = "The independent review of this direction is still running. Keep reading rather than writing, then retry to collect its verdict.";

// The verdict replaces the generic text rather than being appended to it: by this
// point the run knows it is circling, and what it lacks is the specific finding.
const VERDICT_PREFIX = "Convergence guard: an independent review of this run has returned a verdict on the direction. It was produced outside your session, so adopting it is not self-approval — treat it as a decision already made, not a suggestion to weigh.";

const VERDICT_SUFFIX = "Act on this now: say what you are withdrawing or narrowing to, then continue within that narrower scope. If you believe the verdict is wrong, stop and say so with evidence rather than continuing as planned.";

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
  // Launching the review belongs to the caller: the guard must not depend on
  // being able to spawn. Absent means no review can run, and a block falls back
  // to asking the run to attribute the over-reach itself — honest, rather than a
  // promise nothing will keep. The previous attempt defaulted to a stub nobody
  // replaced and still announced a review, leaving one session waiting 2h20m.
  launchDirectionReview = null
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
    // The review's only evidence about what the run has been doing. Both hosts
    // supply it under the same key. The file is read by the detached process,
    // never here — the guard has a few hundred milliseconds, not enough to read a
    // transcript that reached 11.6MB in this project's own session.
    const transcriptPath = payload.transcript_path ?? payload.transcriptPath ?? null;
    const monitorId = deriveExecutionMonitorId({ cli, sessionId });
    const observed = controlStore.recordExecutionToolCall({
      monitorId,
      cli,
      mutating: isMutatingTool(toolName),
      toolLabel: executionToolLabel(toolName),
      target: deriveReworkTarget({ toolName, toolInput }),
      // A suite that actually ran is evidence the rewrites were a red-green
      // cycle rather than circling, so it forgives what came before. Rewriting
      // one file repeatedly is exactly what TDD looks like, and counting it as
      // non-convergence would block the discipline the guard wants.
      tested: runsTests({ toolName, toolInput }),
      limit,
      spreadLimit,
      // Only claim a review is possible when something can actually launch one.
      // The store decides to dispatch on the strength of this, and a block that
      // announced a review nobody could run is what left a session waiting.
      canReview: typeof launchDirectionReview === "function",
      diagnosisExpired
    });
    if (observed?.stop) {
      // The reason names the shape that tripped, because narrowing one artifact
      // and narrowing a widening direction are different instructions.
      const shapeReason = observed.shape === "spread" ? EXECUTION_SPREAD_STOP_REASON : EXECUTION_STOP_REASON;
      // Repeated blocks that changed nothing mean the text is not landing, so
      // the direction goes to a person instead of being asked for a fourth time.
      let reason = shapeReason;
      if (observed.outcome === "dispatch") {
        // The block holds while this runs, so there is nothing to wait for here.
        // A spawn that fails is not fatal: the block still stands, and the run is
        // told to attribute the over-reach itself rather than to wait for an
        // answer that is not coming.
        let launched = false;
        try {
          launched = launchDirectionReview({ monitorId, transcriptPath, cli })?.attempted === true;
        } catch {}
        if (launched) reason = `${shapeReason} ${REVIEW_DISPATCHED}`;
      } else if (observed.outcome === "await") {
        reason = `${shapeReason} ${REVIEW_PENDING}`;
      } else if (observed.outcome === "correct" && observed.verdict) {
        // A verdict produced outside the session is not self-approval, so the run
        // can act on it and narrow without waiting for a person.
        reason = `${VERDICT_PREFIX}\n\n${observed.verdict}\n\n${VERDICT_SUFFIX}`;
      } else if (observed.outcome === "human") {
        // Repeated blocks that changed nothing mean the text is not landing, so
        // the direction goes to a person rather than being asked for again.
        reason = `${shapeReason} ${HUMAN_REQUIRED}`;
      }
      response = blockResponse(cli, reason);
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
