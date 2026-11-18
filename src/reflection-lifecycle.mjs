/**
 * Decides whether a published lesson earned its place, from evidence the store
 * already keeps — and separates two things an earlier report conflated.
 *
 * A lesson that was delivered and whose family then went quiet can mean either
 * of two very different things:
 *
 *   - The subject came up again, the lesson was injected, and nothing went
 *     wrong. The lesson did its job. Call this PREEMPTED.
 *   - The user never did that kind of work again. The family went quiet because
 *     nothing triggered it, not because anything was prevented. This is DORMANT,
 *     and it is not evidence of effectiveness — it is an absence of evidence.
 *
 * Treating both as "quiet since delivery" is what made the earlier effectiveness
 * report unreadable: measured across one live workspace, 36 of 71 delivered
 * families were dormant and only 2 were actually preempted, yet both landed in
 * the same bucket.
 *
 * The distinction matters because the two deserve opposite treatment. A dormant
 * family that has stayed dormant for long enough is a lesson about something
 * that happened once — the user's rule for it is that it is not long-term
 * experience and should stop occupying a slot every turn. A preempted family has
 * earned the slot. A recurred family has not, and should be rewritten or demoted
 * rather than kept at full weight.
 *
 * "The subject came up again" is measured from the emission log: each emission
 * is a turn where the lesson was injected, and a lesson is only injected when
 * its conditions matched what the user was asking about. Two emissions in
 * different sessions means the subject came up twice.
 *
 * Nothing here is causal. A preempted family is credited with surviving a test,
 * not with having caused the outcome — the injection and the absence of a
 * complaint happened in the same turn, and no control group exists in a live
 * session. The states exist to decide where a lesson sits in the ranking, and
 * that decision is reversible.
 */

/** Default window: how long an opportunity has to recur before silence counts. */
export const DEFAULT_OBSERVATION_DAYS = 30;

/** How long a dormant family keeps its slot before it is retired. */
export const DEFAULT_RETIRE_AFTER_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * @typedef {"never_delivered"|"recurred"|"preempted"|"dormant"|"too_early"} LifecycleState
 */

/**
 * Computes the lifecycle state for one family.
 *
 * @param {object} params
 * @param {Array<{sessionUid: string|null, emittedAt: string}>} params.emissions
 *   Every turn this family's lesson was injected, oldest first.
 * @param {Array<{sessionUid: string|null, createdAt: string}>} params.complaints
 *   Every time this family was reviewed as a fresh complaint.
 * @param {number} [params.observationDays] - how long an opportunity has to recur
 * @param {number} [params.retireAfterDays] - how long dormancy must last to retire
 * @param {number} [params.now]
 */
export function classifyFamily({
  emissions = [],
  complaints = [],
  observationDays = DEFAULT_OBSERVATION_DAYS,
  retireAfterDays = DEFAULT_RETIRE_AFTER_DAYS,
  now = Date.now()
}) {
  const delivered = emissions
    .map((entry) => ({ sessionUid: entry.sessionUid ?? null, at: Date.parse(entry.emittedAt) }))
    .filter((entry) => Number.isFinite(entry.at))
    .sort((left, right) => left.at - right.at);

  if (!delivered.length) {
    return {
      state: "never_delivered",
      reason: "no_emission",
      firstDeliveredAt: null,
      lastDeliveredAt: null,
      opportunityCount: 0,
      recurrences: 0,
      observedDays: 0
    };
  }

  const firstAt = delivered[0].at;
  const lastAt = delivered[delivered.length - 1].at;
  const observationMs = observationDays * DAY_MS;

  // A recurrence is a complaint that arrived in a session where this family's
  // lesson HAD ALREADY been injected.
  //
  // Both halves are required, and the second one is what an earlier version got
  // wrong. Ordering alone ("delivered somewhere, complaint came later") counts a
  // delivery failure as a lesson failure: measured on a live project, 7 of 18
  // families marked recurred had complaint sessions that never received the
  // lesson at all. The lesson cannot have failed in a session it never reached —
  // that is the delivery problem this project spends its time on, and demoting
  // the lesson for it would punish exactly the wrong thing.
  //
  // Complaints that predate any injection are what produced the lesson, not
  // evidence against it. Counting those would mark every lesson disproven the
  // moment it was written — the bug an earlier effectiveness report had, where
  // 32 of 32 families read as "recurred".
  //
  // A complaint with no session id cannot be attributed either way. It is left
  // out rather than guessed at, so an unattributable row never costs a lesson
  // its slot.
  let recurrences = 0;
  const recurrenceSessions = new Set();
  for (const complaint of complaints) {
    const at = Date.parse(complaint.createdAt);
    if (!Number.isFinite(at)) continue;
    const sessionUid = complaint.sessionUid ?? null;
    if (!sessionUid) continue;
    const injectedHere = delivered.some((entry) =>
      entry.at < at && entry.sessionUid === sessionUid);
    if (!injectedHere) continue;
    // One session can file the same complaint many times — measured on a live
    // project, a single conversation produced 14 same-family review rows. The
    // state cares only whether it recurred at all, but the COUNT is reported to
    // people, and 14 would read as "this failed fourteen times" when it failed
    // once, in one conversation. Counted per session, matching how occasions
    // are counted above.
    if (recurrenceSessions.has(sessionUid)) continue;
    recurrenceSessions.add(sessionUid);
    recurrences += 1;
  }

  // How many separate occasions the subject came up. Counting sessions rather
  // than emissions: one conversation that injected the lesson on twelve turns
  // is one occasion, and counting rows would make a chatty session look like a
  // track record.
  const sessions = new Set(delivered.map((entry) => entry.sessionUid).filter(Boolean));
  const opportunityCount = sessions.size;
  // Two different spans, and conflating them hid the whole retirement rule:
  //
  //   observedDays  first delivery -> now. How long this family has been under
  //                 observation at all, which decides whether a verdict is
  //                 possible yet.
  //   silentDays    LAST delivery -> now. How long nothing has needed this
  //                 lesson, which is what retirement is about.
  //
  // Measured with a single span taken from the first delivery: one project's
  // delivered families all read as observed for 60-87 days, so every one of them
  // looked like a long-running success, while several had not been injected for
  // weeks. Pushing `now` a full year forward changed nothing — the number was
  // computed from the data, not from now, so the retirement path stayed at zero
  // forever.
  const observedDays = Math.max(0, Math.round((now - firstAt) / DAY_MS));
  const silentDays = Math.max(0, Math.round((now - lastAt) / DAY_MS));

  const base = {
    firstDeliveredAt: new Date(firstAt).toISOString(),
    lastDeliveredAt: new Date(lastAt).toISOString(),
    opportunityCount,
    recurrences,
    observedDays,
    silentDays
  };

  if (recurrences > 0) {
    return {
      ...base,
      state: "recurred",
      // The lesson was in front of the agent and the same complaint happened
      // anyway. Not necessarily a bad lesson — but the strongest available
      // signal that this wording is not doing the work.
      reason: "complaint_after_injection"
    };
  }

  const oldestOpportunity = delivered[0].at;
  const hasObservedFullWindow = (now - oldestOpportunity) >= observationMs;
  if (!hasObservedFullWindow) {
    return {
      ...base,
      state: "too_early",
      reason: "observation_window_not_elapsed"
    };
  }

  // The subject came up again after the first injection and no complaint
  // followed. That is the only positive evidence this system can produce.
  //
  // "Again" means a second OCCASION, not a second emission. A lesson injected on
  // twelve turns of one conversation was on screen for one piece of work; it did
  // not survive twelve tests. Counting emissions here made a chatty session read
  // as preempted, which is the same over-counting that made an earlier recurrence
  // report show 22 occurrences for a single conversation.
  const firstSessionUid = delivered[0].sessionUid;
  // Did the subject come up again WITHIN THE OBSERVATION WINDOW?
  //
  // The window is the whole point. Measuring the lifetime total instead makes
  // every family that was ever used twice read as "preempted" forever: measured
  // on a live project, all 17 delivered families landed in preempted or recurred
  // and none could ever go dormant, so the retirement path was unreachable by
  // construction. What the rule asks is narrower — after the lesson was
  // delivered, did the same kind of work come up again within the month, and was
  // it handled without a complaint?
  //
  // A second OCCASION, not a second emission: a lesson injected on twelve turns
  // of one conversation was on screen for one piece of work, not twelve. Counting
  // emissions here made a chatty session read as a track record — the same
  // over-counting that made an earlier recurrence report show 22 occurrences for
  // a single conversation.
  const windowEnd = oldestOpportunity + observationMs;
  const otherSessions = new Set(
    delivered
      .filter((entry) => entry.at > oldestOpportunity && entry.at <= windowEnd
        && entry.sessionUid && entry.sessionUid !== firstSessionUid)
      .map((entry) => entry.sessionUid)
  );
  const laterOccasion = otherSessions.size > 0;
  if (laterOccasion) {
    return {
      ...base,
      state: "preempted",
      reason: "repeated_opportunity_without_recurrence"
    };
  }

  // One occasion, then silence for the whole window. Nothing was prevented;
  // nothing happened. Whether that is "occasional" depends on how long the
  // silence has run, which `shouldRetire` decides.
  return {
    ...base,
    state: "dormant",
    reason: "single_opportunity_then_silence"
  };
}

/**
 * Whether a dormant family has been dormant long enough to stop occupying a slot.
 *
 * Only dormant qualifies. A preempted family is doing its job and a recurred one
 * needs its wording fixed — retiring either would discard the only two kinds of
 * evidence this system has. Dormancy is the one state that carries none.
 *
 * The clock runs from the last time the subject came up, not from publication:
 * what matters is how long nothing has needed this lesson, and a family that was
 * used last week has not been idle for long however old the file is.
 *
 * `silentDays` is carried on the classification so this and the report agree on
 * the number. Recomputing it here from `lastDeliveredAt` looks equivalent but is
 * not: the report printed `observedDays`, which measured a different span
 * entirely, so the two disagreed about how long a family had been quiet.
 */
export function shouldRetire(family, {
  retireAfterDays = DEFAULT_RETIRE_AFTER_DAYS,
  now = Date.now()
} = {}) {
  if (family?.state !== "dormant") return false;
  const silentDays = Number(family.silentDays);
  if (Number.isFinite(silentDays)) return silentDays >= retireAfterDays;
  // Older callers pass a classification without the field; fall back to the
  // timestamp so a stale shape cannot silently disable retirement.
  const lastAt = Date.parse(family.lastDeliveredAt ?? "");
  if (!Number.isFinite(lastAt)) return false;
  return (now - lastAt) >= retireAfterDays * DAY_MS;
}

/**
 * The ranking penalty a family's state earns, as a multiplier on relevance.
 *
 * A recurred family is not retired — its lesson may be the right subject written
 * the wrong way, and a reviewer needs it on screen to rewrite it. It is demoted
 * so a lesson that has never been disproven wins the same slot instead.
 *
 * Preempted and dormant families rank as they are: neither has been contradicted,
 * and dormancy is decided by `shouldRetire`, not by a nudge.
 */
export function lifecycleWeight(state) {
  return state === "recurred" ? 0.5 : 1;
}

/**
 * Turns the store's raw rows into one state per family.
 *
 * Kept separate from classifyFamily so the per-family rule stays pure and
 * testable: this function only groups, and every judgement lives in the
 * classifier above.
 *
 * @param {object} params
 * @param {Array<{family: string, session_uid: string|null, emitted_at: string}>} params.emissions
 * @param {Array<{family: string, session_uid: string|null, created_at: string}>} params.complaints
 * @param {number} [params.observationDays]
 * @param {number} [params.retireAfterDays]
 * @param {number} [params.now]
 * @returns {{states: Record<string, LifecycleState>, families: Array<object>}}
 */
export function classifyProject({
  emissions = [],
  complaints = [],
  observationDays = DEFAULT_OBSERVATION_DAYS,
  retireAfterDays = DEFAULT_RETIRE_AFTER_DAYS,
  now = Date.now()
}) {
  const families = new Map();
  const ensure = (family) => {
    const key = String(family ?? "");
    if (!key) return null;
    let entry = families.get(key);
    if (!entry) {
      entry = { emissions: [], complaints: [] };
      families.set(key, entry);
    }
    return entry;
  };

  for (const row of emissions) {
    const entry = ensure(row.family);
    if (entry) entry.emissions.push({ sessionUid: row.session_uid ?? null, emittedAt: row.emitted_at });
  }
  for (const row of complaints) {
    const entry = ensure(row.family);
    if (entry) entry.complaints.push({ sessionUid: row.session_uid ?? null, createdAt: row.created_at });
  }

  const states = {};
  const details = [];
  for (const [family, entry] of families) {
    const classification = classifyFamily({
      emissions: entry.emissions,
      complaints: entry.complaints,
      observationDays,
      retireAfterDays,
      now
    });
    states[family] = classification.state;
    details.push({
      family,
      ...classification,
      retire: shouldRetire(classification, { retireAfterDays, now }),
      weight: lifecycleWeight(classification.state)
    });
  }

  const byState = {};
  for (const detail of details) byState[detail.state] = (byState[detail.state] ?? 0) + 1;

  return {
    observationDays,
    retireAfterDays,
    states,
    families: details.sort((left, right) => left.family.localeCompare(right.family, "en-US")),
    totals: {
      families: details.length,
      byState,
      retireCandidates: details.filter((detail) => detail.retire).length,
      demoted: details.filter((detail) => detail.weight < 1).length
    }
  };
}
