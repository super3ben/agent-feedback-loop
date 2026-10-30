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

  // A family is "quiet" only once enough time has passed for a recurrence to
  // have been plausible. Anything newer is "too early", not "fixed".
  const quietCutoff = now - quietWindowDays * 24 * 60 * 60 * 1_000;

  const families = [];
  for (const job of publishedJobs) {
    const family = job.family_key;
    if (!family) continue;
    const delivery = deliveries.get(family) ?? null;
    const publishedAt = job.completed_at ? Date.parse(job.completed_at) : NaN;

    // Recurrences are counted from the job table by the caller's decline data;
    // a published family that keeps being declined afterwards is recurring.
    const declinesAfter = delivery?.firstAt
      ? (declineCounts.get(family) ?? 0)
      : 0;

    let state;
    if (!delivery) state = "never_delivered";
    else if (declinesAfter > 0) state = "recurred_after_delivery";
    else if (Number.isFinite(publishedAt) && publishedAt > quietCutoff) state = "too_early_to_tell";
    else state = "quiet_since_delivery";

    families.push({
      family,
      state,
      severity: job.final_severity ?? null,
      publishedAt: job.completed_at ?? null,
      deliveries: delivery?.count ?? 0,
      firstDeliveredAt: delivery?.firstAt ?? null,
      lastDeliveredAt: delivery?.lastAt ?? null,
      declines: declineCounts.get(family) ?? 0
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
