/**
 * Answers "is this lesson doing anything", from the two records the store
 * already keeps.
 *
 * The honest answer this can give is not causal. A lesson that was delivered
 * and whose family never recurred MIGHT have prevented it, or the user might
 * simply never have done that kind of work again. So the report separates the
 * three states the data can actually distinguish — never delivered, delivered
 * and then recurred, delivered and quiet — and never calls the last one
 * "effective". Calling correlation effectiveness is the mistake this tool
 * already made once, in its own rules.
 */

/**
 * @param {object} params
 * @param {Array<{family, document_path, emitted_at}>} params.emitters
 * @param {Array<{family_key, published_path, completed_at}>} params.publishedJobs
 * @param {Array<{family_key, declines}>} params.declines
 * @param {number} [params.quietWindowDays]
 * @param {number} [params.now]
 */
export function summarizeReflectionEffectiveness({
  emitters = [],
  publishedJobs = [],
  declines = [],
  quietWindowDays = 14,
  now = Date.now()
}) {
  const deliveries = new Map();
  for (const emission of emitters) {
    // The row carries the reviewer's family key under `family` — the store joins
    // it in from the publishing job. reflection_emissions.family_id is a derived
    // document identity and does not match reviewer_jobs.family_key.
    const family = emission.family ?? "(unknown)";
    const entry = deliveries.get(family) ?? { count: 0, firstAt: null, lastAt: null };
    entry.count += 1;
    if (!entry.firstAt || emission.emitted_at < entry.firstAt) entry.firstAt = emission.emitted_at;
    if (!entry.lastAt || emission.emitted_at > entry.lastAt) entry.lastAt = emission.emitted_at;
    deliveries.set(family, entry);
  }

  const declineCounts = new Map(
    declines.map((row) => [row.family_key, Number(row.declines) || 0])
  );
  // The same rows, kept whole, because the count alone cannot answer "when".
  const declineRows = new Map(
    declines.map((row) => [row.family_key, row])
  );

  // A family is "quiet" only once enough time has passed for a recurrence to
  // have been plausible. Anything newer is "too early", not "fixed".
  const quietCutoff = now - quietWindowDays * 24 * 60 * 60 * 1_000;

  const families = [];
  for (const job of publishedJobs) {
    const family = job.family_key;
    if (!family) continue;
    const delivery = deliveries.get(family) ?? null;
    const publishedAt = job.completed_at ? Date.parse(job.completed_at) : NaN;

    // A recurrence is a decline that happened AFTER the lesson was delivered.
    //
    // The previous version counted every decline the family had ever collected,
    // including the ones that produced the lesson in the first place. Every
    // family is by definition declined at least once before it is published — so
    // any family that was ever delivered had already "recurred", and the report
    // said recurred_after_delivery for 32 of 32. A lesson could have prevented
    // every subsequent recurrence and the number would not have moved, which is
    // the one property a measuring instrument must not have.
    //
    // The lower bound is the first delivery: that is the earliest moment the
    // lesson could have had any effect. Rows carry a count, not timestamps, so
    // the caller passes per-family decline history with `last_declined_at`; when
    // that is missing the family is reported as `too_early_to_tell` rather than
    // being credited with a recurrence it may not have had.
    const deliveryAt = delivery?.firstAt ? Date.parse(delivery.firstAt) : NaN;
    const declineEntry = declineRows.get(family) ?? null;
    const lastDeclineAt = declineEntry?.last_declined_at ? Date.parse(declineEntry.last_declined_at) : NaN;
    const hasDeclines = (Number(declineCounts.get(family)) || 0) > 0;
    const declinesAfter = Number.isFinite(deliveryAt) && Number.isFinite(lastDeclineAt)
      ? lastDeclineAt >= deliveryAt
      : false;

    let state;
    if (!delivery) state = "never_delivered";
    else if (declinesAfter) state = "recurred_after_delivery";
    else if (hasDeclines && !Number.isFinite(lastDeclineAt)) {
      // Declines exist but carry no timestamp, so whether they happened before
      // or after delivery is unknowable. Saying "quiet" would claim the lesson
      // held; saying "recurred" would repeat the original bug of counting the
      // declines that produced the lesson. Neither is honest, so the state says
      // exactly what is known: something happened, and when it happened is
      // missing. The store always supplies last_declined_at, so this is a
      // backfilled-row case rather than a normal one.
      state = "recurrence_timing_unknown";
    } else if (Number.isFinite(publishedAt) && publishedAt > quietCutoff) state = "too_early_to_tell";
    else state = "quiet_since_delivery";

    families.push({
      family,
      state,
      severity: job.final_severity ?? null,
      publishedAt: job.completed_at ?? null,
      deliveries: delivery?.count ?? 0,
      firstDeliveredAt: delivery?.firstAt ?? null,
      lastDeliveredAt: delivery?.lastAt ?? null,
      declines: declineCounts.get(family) ?? 0,
      // Kept so a reader can see WHY a family landed in its state: the whole
      // point of the fix is that "declined before delivery" no longer counts as
      // recurrence, and that is only checkable if both timestamps are visible.
      firstDeclinedAt: declineEntry?.first_declined_at ?? null,
      lastDeclinedAt: declineEntry?.last_declined_at ?? null
    });
  }

  const byState = {};
  for (const entry of families) byState[entry.state] = (byState[entry.state] ?? 0) + 1;

  return {
    // Stated explicitly so nobody reads the quiet count as proof of effect.
    causality: "correlation_only",
    quietWindowDays,
    totals: {
      families: families.length,
      byState,
      deliveredFamilies: families.filter((entry) => entry.deliveries > 0).length,
      neverDeliveredFamilies: families.filter((entry) => entry.state === "never_delivered").length
    },
    families
  };
}
