import { open } from "node:fs/promises";

// How much of the session transcript the review reads. Transcripts are
// unbounded — this project's own session reached 11.6MB — and the interesting
// part is always the end, because the question is what the run has been doing
// lately rather than how it started.
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

// A pending review that never returns must not hold the run forever. Blocks
// during a pending review do not advance the escalation counter, so without a
// deadline a provider that dies would make "ask a person" unreachable — the
// exact shape that left one session waiting 2h20m. Measured review latency is
// 29-90s, so this allows for the slow end plus a wide margin.
export const DIAGNOSIS_DEADLINE_MS = 240_000;

/**
 * Whether a pending review has been waiting past its deadline. Compared against
 * stored time rather than a timer, because the guard is a short-lived process.
 */
export function diagnosisExpired(diagnosis, nowMs = Date.now(), deadlineMs = DIAGNOSIS_DEADLINE_MS) {
  if (diagnosis?.state !== "pending") return false;
  const requestedMs = Date.parse(diagnosis.requestedAt ?? "");
  // An unreadable timestamp is treated as expired: refusing to expire is what
  // makes a run unrescuable, so the safe direction is to let counting resume.
  if (!Number.isFinite(requestedMs)) return true;
  return nowMs - requestedMs > deadlineMs;
}

/**
 * The last bytes of a transcript file, as text. Returns null when the file
 * cannot be read — the review then has no evidence and is not worth running.
 *
 * The tail is not parsed. The two hosts' formats have nothing in common: Claude
 * Code writes tool_use blocks with a plain `input.file_path`, while Codex writes
 * response_item entries whose tool is `exec` and whose argument is JavaScript
 * source with any path buried inside it. Parsing would mean one parser per host,
 * the Codex one reading JS source, both breaking on any format change. The
 * reviewer is a language model and reads either format itself.
 */
export async function readTranscriptTail(transcriptPath, maxBytes = TRANSCRIPT_TAIL_BYTES) {
  if (typeof transcriptPath !== "string" || !transcriptPath.startsWith("/")) return null;
  let handle = null;
  try {
    handle = await open(transcriptPath, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    if (length <= 0) return null;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * The evidence a direction review is given. Deliberately small: what the guard
 * measured, and the raw tail for the model to read. The guard's own counters are
 * included because they are what tripped, and a verdict that contradicts them
 * would be answering a different question.
 */
export function buildDirectionContext({ cli, shape, reworkCount, spreadCount, toolCounts, transcriptTail }) {
  return {
    kind: "execution_direction_review",
    host: cli,
    // Which signal tripped: one artifact coming back, or the work spreading.
    signal: shape === "spread" ? "widening_scope" : "repeated_rewrite",
    rewrites_of_one_artifact: reworkCount ?? 0,
    distinct_artifacts_rewritten: spreadCount ?? 0,
    tool_counts: toolCounts ?? {},
    transcript_tail: transcriptTail ?? ""
  };
}
