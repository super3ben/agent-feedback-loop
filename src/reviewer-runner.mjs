import { lstat } from "node:fs/promises";
import path from "node:path";

import { redactText } from "./capture.mjs";
import {
  publishReflectionDocument,
  readReflectionCatalog,
  validateReflectionModel
} from "./reflection-document.mjs";
import { validateReviewerResult } from "./reviewer-result.mjs";
import { maybeUpdateRulesTier } from "./update-rules-tier.mjs";
import { escalateDeclinedFamily } from "./reviewer-escalate.mjs";

const DEFAULT_LEASE_MS = 185_000;
const PUBLICATION_LEASE_MS = 30_000;
const FAILURE_CODES = new Set([
  "provider_unavailable",
  "provider_timeout",
  "provider_invalid",
  "context_invalid",
  "lease_lost",
  "publication_failed",
  "publication_collision"
]);
const EVENT_TEXT_FIELDS = ["text", "prompt", "message", "content", "output", "response"];
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const TIMEZONE_TIMESTAMP = /(?:Z|[+-]\d{2}:\d{2})$/iu;

class ReviewJobError extends Error {
  constructor(code, cause) {
    super(code);
    this.name = "ReviewJobError";
    this.code = code;
  }
}

function boundedText(value, maxCharacters = 16_384) {
  const redacted = redactText(String(value ?? "").normalize("NFC")).text;
  return Array.from(redacted).slice(0, maxCharacters).join("");
}

function hostText(raw) {
  const plain = String(raw ?? "");
  let parsed;
  try {
    parsed = JSON.parse(plain);
  } catch {
    return boundedText(plain);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return boundedText(plain);
  const selected = {};
  for (const field of EVENT_TEXT_FIELDS) {
    const value = parsed[field];
    if (typeof value === "string") selected[field] = boundedText(value, 8_192);
    else if (Array.isArray(value)) {
      selected[field] = value.slice(0, 32).map((item) => {
        if (typeof item === "string") return boundedText(item, 2_048);
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const allowed = {};
        for (const key of ["type", "text", "content"]) {
          if (typeof item[key] === "string") allowed[key] = boundedText(item[key], 2_048);
        }
        return allowed;
      }).filter((item) => item !== null);
    }
  }
  return boundedText(JSON.stringify(selected));
}

async function contextEvent(row, blobs) {
  if (!row) return null;
  if (!row.encrypted_raw_ref) throw new ReviewJobError("context_invalid");
  const raw = await blobs.read(row.encrypted_raw_ref);
  return {
    eventUid: row.event_uid,
    sourceProvider: row.source_provider,
    role: row.role,
    referentEventUid: row.referent_event_uid ?? null,
    contentHash: row.content_hash,
    completeness: row.completeness,
    sourceTimestamp: row.source_timestamp ?? null,
    createdAt: row.created_at,
    text: hostText(raw)
  };
}

async function catalogSummaries(projectDir, publishedBefore) {
  const catalog = await readReflectionCatalog({ projectDir, publishedBefore });
  return catalog.documents.map((document) => ({
    reflectionId: document.reflectionId,
    familyId: document.familyId,
    methodClass: document.methodClass,
    appliesWhen: [...document.appliesWhen],
    sha256: document.documentHash
  }));
}

function recurrenceSummary({ store, jobId }) {
  // Known family keys with how often each was reached. A later review reuses a
  // key from this list instead of minting a new one for the same problem, which
  // is what makes a repeat countable at all.
  const knownFamilies = store.listReviewFamilyKeys({ jobId, limit: 32 });
  // Each family's most recent decline, including the condition that review set
  // for changing its mind. Without this every review is effectively the first:
  // it writes "would qualify if the family recurs", the family recurs, and the
  // next review — never shown the promise — declines the same way again.
  let priorDeclines = [];
  try {
    const projectId = store.getReviewJob(jobId)?.project_id;
    if (projectId && typeof store.listLatestDeclinesByFamily === "function") {
      priorDeclines = store.listLatestDeclinesByFamily({ projectId, limit: 32 });
    }
  } catch {}
  return {
    known_families: knownFamilies.map((entry) => ({
      family_key: entry.familyKey,
      occurrences: entry.occurrences
    })),
    prior_declines: priorDeclines.map((entry) => ({
      family_key: entry.familyKey,
      reason_code: entry.reasonCode,
      declined_at: entry.declinedAt,
      incident_summary: entry.incidentSummary,
      would_qualify_if: entry.wouldQualifyIf
    }))
  };
}

function controllerRecurrenceEntry(emission, familyId) {
  if (!emission || emission.family_id !== familyId
      || !SHA256_PATTERN.test(String(emission.document_sha256 ?? ""))
      || typeof emission.emitted_at !== "string"
      || !TIMEZONE_TIMESTAMP.test(emission.emitted_at)
      || !Number.isFinite(Date.parse(emission.emitted_at))) {
    throw new ReviewJobError("context_invalid");
  }
  return JSON.stringify({
    family_id: familyId,
    document_sha256: emission.document_sha256,
    emitted_at: new Date(Date.parse(emission.emitted_at)).toISOString()
  });
}

async function assertProjectBoundary(projectDir) {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new ReviewJobError("context_invalid");
  }
  if (typeof projectDir !== "string" || !path.isAbsolute(projectDir)) {
    throw new ReviewJobError("context_invalid");
  }
  const root = path.parse(projectDir).root;
  let current = root;
  let info = await lstat(current);
  for (const component of path.relative(root, projectDir).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new ReviewJobError("context_invalid");
  }
  if (typeof process.getuid !== "function" || info.uid !== process.getuid()) {
    throw new ReviewJobError("context_invalid");
  }
}

async function buildReviewContext({ store, blobs, jobId, projectDir }) {
  const stored = store.getReviewContext({ jobId, priorLimit: 6, followingLimit: 2 });
  if (!stored?.job || !stored.source) throw new ReviewJobError("context_invalid");
  if (stored.job.project_id !== projectDir || stored.source.source_provider !== "codex"
      && stored.source.source_provider !== "claude" && stored.source.source_provider !== "gemini") {
    throw new ReviewJobError("context_invalid");
  }
  await assertProjectBoundary(projectDir);
  const reflectionCatalog = await catalogSummaries(projectDir, stored.job.created_at);
  const recurrence = recurrenceSummary({ store, jobId });
  const sourceEnvelope = {
    sourceIdentity: stored.job.source_identity,
    createdAt: stored.source.source_timestamp ?? stored.source.created_at,
    publishedAt: stored.job.created_at
  };
  return {
    job: {
      job_id: stored.job.job_id,
      source_identity: stored.job.source_identity,
      created_at: stored.job.created_at,
      project_id: stored.job.project_id
    },
    source: { ...await contextEvent(stored.source, blobs), ...sourceEnvelope },
    referent: await contextEvent(stored.referent, blobs),
    prior: await Promise.all(stored.prior.slice(-6).map((row) => contextEvent(row, blobs))),
    following: await Promise.all(stored.following.slice(0, 2).map((row) => contextEvent(row, blobs))),
    reflectionCatalog,
    recurrence
  };
}

function causeCode(error) {
  let current = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (typeof current.code === "string") {
      if (current.code === "review_lease_lost" || current.code === "lease_lost") return "lease_lost";
      if (current.code === "publication_collision") return "publication_collision";
    }
    current = current.cause;
  }
  return null;
}

function providerFailure(error) {
  const code = String(error?.code || "");
  if (code === "reviewer_timeout" || code === "provider_timeout") return "provider_timeout";
  if (["reviewer_unavailable", "provider_unavailable", "ENOENT", "EACCES"].includes(code)) {
    return "provider_unavailable";
  }
  return "provider_invalid";
}

function publicationFailure(error) {
  return causeCode(error) || "publication_failed";
}

function asFailure(error, fallback) {
  if (error instanceof ReviewJobError && FAILURE_CODES.has(error.code)) return error;
  return new ReviewJobError(fallback, error);
}

function recordFailure(store, { jobId, ownerId, leaseEpoch, code }) {
  if (code === "lease_lost") return;
  try {
    store.failReviewJob({ jobId, ownerId, leaseEpoch, reasonCode: code });
  } catch {
    // A concurrent owner or process failure owns subsequent recovery.
  }
}

export async function runReviewJob({
  jobId,
  ownerId,
  store,
  blobs,
  provider,
  projectDir,
  leaseMs = DEFAULT_LEASE_MS
}) {
  if (!store || !blobs || typeof provider !== "function") {
    throw new ReviewJobError("context_invalid");
  }
  const claimed = store.claimReviewJob({ jobId, ownerId, leaseMs });
  if (!claimed?.job) throw new ReviewJobError("lease_lost");
  const leaseEpoch = claimed.leaseEpoch;
  let context;
  try {
    context = await buildReviewContext({ store, blobs, jobId, projectDir });
  } catch (error) {
    const failure = asFailure(error, "context_invalid");
    recordFailure(store, { jobId, ownerId, leaseEpoch, code: failure.code });
    throw failure;
  }

  let rawResult;
  try {
    rawResult = await provider(context, { resultKind: "lesson" });
  } catch (error) {
    const failure = new ReviewJobError(providerFailure(error), error);
    recordFailure(store, { jobId, ownerId, leaseEpoch, code: failure.code });
    throw failure;
  }

  const allowedFamilyIds = context.reflectionCatalog.map((item) => item.familyId);
  const recurrenceFamilyById = new Map(
    context.reflectionCatalog.map((item) => [item.reflectionId, item.familyId])
  );
  let result;
  try {
    result = validateReviewerResult(rawResult, { allowedFamilyIds, recurrenceFamilyById });
  } catch (error) {
    const failure = new ReviewJobError("provider_invalid", error);
    recordFailure(store, { jobId, ownerId, leaseEpoch, code: failure.code });
    throw failure;
  }

  if (result.outcome === "no_lesson") {
    // The LLM declined. Before accepting the decline, check whether this family
    // has already been declined repeatedly in the window — if so, the loop of
    // "decline, recur, decline again" has proven the promise was met, and a
    // deterministic escalation publishes a lesson instead of letting a third
    // excuse win. This does not rely on the model honoring its own
    // would_qualify_if.
    const escalated = escalateDeclinedFamily({
      verdict: result,
      declines: context.recurrence?.prior_declines ?? [],
      job: context.job,
      hasPublishedLesson: Boolean(
        context.job.project_id
        && typeof store.getLatestPublishedJobForFamily === "function"
        && store.getLatestPublishedJobForFamily({
          projectId: context.job.project_id,
          familyKey: result.family_key
        })
      )
    });
    if (escalated) {
      let escalatedModel;
      try {
        escalatedModel = validateReflectionModel(escalated, {
          sourceIdentity: context.job.source_identity,
          createdAt: context.source.sourceTimestamp ?? context.source.createdAt,
          publishedAt: context.job.created_at
        });
      } catch (error) {
        const failure = new ReviewJobError("provider_invalid", error);
        recordFailure(store, { jobId, ownerId, leaseEpoch, code: failure.code });
        throw failure;
      }
      try {
        store.renewReviewLease({ jobId, ownerId, leaseEpoch, leaseMs: PUBLICATION_LEASE_MS });
        store.assertReviewLease({ jobId, ownerId, leaseEpoch });
        const published = await publishReflectionDocument({
          projectDir,
          model: escalatedModel,
          beforeRename: () => store.renewReviewLease({
            jobId,
            ownerId,
            leaseEpoch,
            leaseMs: PUBLICATION_LEASE_MS
          })
        });
        store.completeReviewPublished({
          jobId,
          ownerId,
          leaseEpoch,
          path: published.path,
          sha256: published.sha256,
          familyKey: escalated.proposed_family_key ?? null,
          severity: escalated.final_severity ?? null
        });
        // Same projection the normal publish path runs: an escalated family has
        // by definition recurred enough for the rules tier, and the rules file
        // is the channel that reaches every later turn. Publishing without this
        // step leaves the lesson stored but never enforced.
        try {
          await maybeUpdateRulesTier({ store, projectId: context.job.project_id, projectDir });
        } catch {
          // The document is the durable record; a failed rules projection is
          // retried on the next publication.
        }
        return { outcome: "lesson", documentPath: published.path, escalated: true };
      } catch (error) {
        const failure = new ReviewJobError(causeCode(error) || "lease_lost", error);
        recordFailure(store, { jobId, ownerId, leaseEpoch, code: failure.code });
        throw failure;
      }
    }
    try {
      store.completeReviewNoLesson({
        jobId,
        ownerId,
        leaseEpoch,
        reasonCode: result.reason_code,
        familyKey: result.family_key,
        // Why this review declined. Without it a decline is a bare code, and
        // nobody can tell a correct one from a threshold set too high.
        incidentSummary: result.incident_summary,
        whyNotALesson: result.why_not_a_lesson,
        wouldQualifyIf: result.would_qualify_if
      });
      return { outcome: "reviewed_no_lesson", documentPath: null };
    } catch (error) {
      const failure = new ReviewJobError(causeCode(error) || "lease_lost", error);
      recordFailure(store, { jobId, ownerId, leaseEpoch, code: failure.code });
      throw failure;
    }
  }

  let model;
  try {
    model = validateReflectionModel(result, {
      sourceIdentity: context.job.source_identity,
      createdAt: context.source.sourceTimestamp ?? context.source.createdAt,
      publishedAt: context.job.created_at
    });
    const priorEmission = store.findPriorFamilyEmission({
      familyId: model.family_id,
      before: context.source.sourceTimestamp ?? context.source.createdAt
    });
    if (priorEmission) {
      model = {
        ...model,
        effectiveness: "recurrence_after_emission",
        repeated_pattern_evidence: [
          ...model.repeated_pattern_evidence.slice(0, 7),
          controllerRecurrenceEntry(priorEmission, model.family_id)
        ]
      };
    }
  } catch (error) {
    const failure = error instanceof ReviewJobError
      ? error
      : new ReviewJobError("provider_invalid", error);
    recordFailure(store, { jobId, ownerId, leaseEpoch, code: failure.code });
    throw failure;
  }

  try {
    store.renewReviewLease({ jobId, ownerId, leaseEpoch, leaseMs: PUBLICATION_LEASE_MS });
    store.assertReviewLease({ jobId, ownerId, leaseEpoch });
    const published = await publishReflectionDocument({
      projectDir,
      model,
      beforeRename: () => store.renewReviewLease({
        jobId,
        ownerId,
        leaseEpoch,
        leaseMs: PUBLICATION_LEASE_MS
      })
    });
    store.completeReviewPublished({
      jobId,
      ownerId,
      leaseEpoch,
      path: published.path,
      sha256: published.sha256,
      // A new family proposes its key; an existing one already has recurrence
      // recorded against the key its earlier reviews used.
      familyKey: result.proposed_family_key ?? null,
      // Severity drives the rules-tier gate: Major + 3 → .agent/rules/,
      // Critical + 2, Blocker + 1.
      severity: result.final_severity ?? null
    });
    // A lesson that keeps recurring has already proved that advisory injection
    // is not enough, so it is compiled into the rules file the host reads every
    // turn. Failure here must not undo a published lesson: the document is the
    // durable record, the rules file is a projection of it.
    try {
      await maybeUpdateRulesTier({
        store,
        // A job is rejected earlier unless its project_id equals projectDir, so
        // the directory is the project identity here.
        projectId: projectDir,
        projectDir
      });
    } catch {}
    return { outcome: "published", documentPath: published.path };
  } catch (error) {
    const failure = new ReviewJobError(publicationFailure(error), error);
    recordFailure(store, { jobId, ownerId, leaseEpoch, code: failure.code });
    throw failure;
  }
}
