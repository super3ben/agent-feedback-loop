import { deriveExecutionMonitorId, inspectExecutionTranscript } from "./execution-monitor.mjs";

export const EXECUTION_STOP_MESSAGE = "Stop tool use now. Report verified results and finish with the smallest necessary next step.";

const SUPPORTED_CLIS = new Set(["codex", "claude", "gemini"]);
const DEFAULT_RESERVATION_MS = 60_000;

export async function handleExecutionHook({
  payload,
  cli,
  controlStore,
  launchProbe = () => ({ attempted: false, reason: "unsupported_platform" }),
  writeResponse = async () => null,
  nativeResponse = { continue: true }
} = {}) {
  let response = { ...nativeResponse, continue: true };
  try {
    if (!SUPPORTED_CLIS.has(cli) || !payload || typeof payload !== "object" || Array.isArray(payload)
        || typeof controlStore?.observeExecutionMonitor !== "function") {
      await writeResponse(response);
      return response;
    }
    const sessionId = payload.session_id ?? payload.sessionId;
    const transcriptPath = payload.transcript_path ?? payload.transcriptPath;
    const monitorId = deriveExecutionMonitorId({ cli, sessionId });
    const inspected = await inspectExecutionTranscript({ transcriptPath });
    if (!inspected) {
      await writeResponse(response);
      return response;
    }
    const observed = controlStore.observeExecutionMonitor({
      monitorId,
      cli,
      metrics: inspected.metrics,
      snapshotDigest: inspected.snapshotDigest,
      thresholdReached: inspected.thresholdReached,
      reservationMs: DEFAULT_RESERVATION_MS
    });
    if (observed.reserved) {
      try {
        const launch = launchProbe({ monitorId, reservationEpoch: observed.reservationEpoch, cli });
        if (launch?.attempted === false) {
          try {
            controlStore.releaseExecutionMonitorProbe({
              monitorId,
              reservationEpoch: observed.reservationEpoch
            });
          } catch {}
        }
      } catch {
        try {
          controlStore.releaseExecutionMonitorProbe({
            monitorId,
            reservationEpoch: observed.reservationEpoch
          });
        } catch {}
      }
      response = { ...response, systemMessage: EXECUTION_STOP_MESSAGE };
    }
  } catch {
    response = { ...nativeResponse, continue: true };
  }
  try { await writeResponse(response); } catch {}
  return response;
}
