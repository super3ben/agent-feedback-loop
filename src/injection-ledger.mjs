/**
 * Decides whether a turn gets the FULL rules block, a compact index of it, or
 * nothing.
 *
 * The budget in rules-writer caps how big the block is; it says nothing about
 * how often the same bytes are pasted into one conversation. Measured on live
 * sessions: a 6 KB block in a 31-turn session was injected 36 times, 224.7 KB
 * cumulative — 37× the size of the file the cap was protecting. The cap was
 * working and the context still filled up, because per-turn size and cumulative
 * size are different budgets and only the first one existed.
 *
 * The two modes exist because the two failure directions are different:
 *
 * - Re-sending identical bytes every turn is pure waste. The text has not
 *   changed, and the model has already read it.
 * - Never re-sending is not safe either. A hook message from twenty turns ago
 *   competes with everything said since, and compaction can remove it outright,
 *   which is why "I told the model once" has never been a guarantee.
 *
 * So the full text is re-anchored on a fixed cadence and immediately whenever
 * it changes, and the turns in between get an index that names every covered
 * family without repeating the prose. The index is not a pointer to a file the
 * model must choose to open: it names the lessons itself, so a turn that only
 * gets the index still knows which classes of mistake exist.
 */

/**
 * Turns between full re-anchors.
 *
 * Long enough that the savings are real, short enough that no plausible span of
 * ordinary conversation can bury the text. Chosen against the measured shape
 * rather than a round number: half the live sessions we sampled ran under 10
 * turns and would pay at most one extra full injection.
 */
export const REANCHOR_TURNS = 8;

/**
 * Decides how the next turn receives the rules block.
 *
 * The caller does not supply the turn number: the ledger already knows how many
 * prompts this session has had, so deriving the next one here removes the way
 * this went wrong the first time — a caller passing the previous turn as the
 * current one makes the cadence difference permanently zero, which silently
 * disables re-anchoring instead of failing.
 *
 * @param {object} params
 * @param {{digest: string, turn: number, lastFullTurn?: number}|null} [params.prior]
 *   what this session was last sent. Null means the session has never been seen.
 * @param {string} params.digest - digest of the block as it stands now.
 * @param {number} [params.reanchorTurns]
 * @returns {{mode: 'full'|'compact', reason: string, turn: number, lastFullTurn: number}}
 *   `turn` and `lastFullTurn` are the values to persist for this injection.
 */
export function planRulesInjection({ prior = null, digest, reanchorTurns = REANCHOR_TURNS }) {
  const every = Number.isSafeInteger(reanchorTurns) && reanchorTurns > 0
    ? reanchorTurns
    : REANCHOR_TURNS;
  const priorTurn = Number.isSafeInteger(prior?.turn) && prior.turn >= 0 ? prior.turn : 0;
  const nextTurn = priorTurn + 1;

  // A session with no record is indistinguishable from a compacted one: the
  // history we thought was there may be gone. Send the full text.
  if (!prior || !prior.digest) {
    return { mode: "full", reason: "first_turn", turn: nextTurn, lastFullTurn: nextTurn };
  }

  // Any change to the block is sent in full. A rule that was rewritten is new
  // information, and the cost of one injection is far below the cost of a model
  // acting on a superseded version. lastFullTurn restarts from here so the
  // cadence counts from the version the model actually holds.
  if (prior.digest !== digest) {
    return { mode: "full", reason: "block_changed", turn: nextTurn, lastFullTurn: nextTurn };
  }

  const lastFullTurn = Number.isSafeInteger(prior.lastFullTurn) && prior.lastFullTurn >= 0
    ? Math.min(prior.lastFullTurn, priorTurn)
    : 0;

  // Re-anchor on a fixed cadence so the text never recedes arbitrarily far.
  if (nextTurn - lastFullTurn >= every) {
    return { mode: "full", reason: "reanchor", turn: nextTurn, lastFullTurn: nextTurn };
  }

  return { mode: "compact", reason: "unchanged", turn: nextTurn, lastFullTurn };
}

/**
 * The index a compact turn receives: every covered family, no prose.
 *
 * Family names are the durable handle — they are what tells the model which
 * classes of mistake this project has already hit, and they are what the full
 * block's headings say too. What is dropped is the incident narrative and the
 * method changes, which the model has already been shown this session.
 *
 * @param {{families: string[], nextFullAt: number|null}} params
 */
export function renderRulesIndex({ families = [], nextFullAt = null }) {
  const keys = families.map((key) => String(key ?? "").trim()).filter(Boolean);
  if (!keys.length) return null;
  const lines = [
    "【复发教训规则 — 本会话前文已完整注入，此处只列已覆盖的家族索引】",
    `已覆盖：${keys.join(", ")}`
  ];
  if (Number.isFinite(nextFullAt)) {
    lines.push(`完整条目将在本会话第 ${nextFullAt} 轮重新注入。若当前任务命中上述任一家族，先按该家族已给出的方法要求执行。`);
  } else {
    lines.push("若当前任务命中上述任一家族，先按该家族已给出的方法要求执行。");
  }
  return lines.join("\n");
}
