import { createHash } from "node:crypto";

import { readReflectionCatalog } from "./reflection-document.mjs";

const HARD_LIMITS = Object.freeze({
  maxFileBytes: 131_072,
  maxCards: 4,
  maxDocumentTokens: 640,
  maxTotalTokens: 1600
});

/**
 * What goes into the injected text, as opposed to what selection matches on.
 *
 * Matching runs over the FULL document (every applies_when entry, every method
 * change), so trimming the injected copy costs no recall — it only stops the
 * model from being shown the same match surface twice. Measured on a live
 * project: the average document cost 667 tokens against a 640-token per-document
 * cap, so 57% of documents could not be selected at all. These limits bring the
 * average under the cap without dropping any lesson.
 */
const GUIDANCE_LIMITS = Object.freeze({
  appliesWhen: 3,
  methodChanges: 4,
  classOfMistakeChars: 240,
  methodChangeChars: 300
});
const SEVERITY_RANK = Object.freeze({ Major: 1, Critical: 2, Blocker: 3 });
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const LATIN_WORD = /[\p{Script=Latin}\p{Number}]+/gu;
const TOKEN_PART = /[A-Za-z0-9]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[^\s]/gu;
const CATALOG_REASON = Object.freeze({
  file_too_large: "oversized_document",
  max_files_exceeded: "catalog_limit",
  legacy_incomplete: "legacy_incomplete",
  published_after_cutoff: "published_after_cutoff"
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

function textFeatures(values) {
  const latin = new Set();
  const cjk = new Set();
  for (const source of Array.isArray(values) ? values : [values]) {
    const value = normalize(source);
    for (const token of value.match(LATIN_WORD) ?? []) latin.add(token);
    for (const run of value.match(CJK_RUN) ?? []) {
      const points = Array.from(run);
      for (let index = 0; index + 1 < points.length; index += 1) {
        cjk.add(`${points[index]}${points[index + 1]}`);
      }
    }
  }
  return { latin, cjk };
}

function intersectionSize(left, right) {
  let count = 0;
  for (const token of left.latin) if (right.latin.has(token)) count += 1;
  for (const token of left.cjk) if (right.cjk.has(token)) count += 1;
  return count;
}

function exactMetadataMatches(document, task) {
  const targets = new Set([
    ...(document.appliesWhen ?? []),
    document.classOfMistake,
    document.methodClass,
    ...(document.methodChanges ?? [])
  ].map(normalize).filter(Boolean));
  const metadata = new Set([
    ...(Array.isArray(task?.paths) ? task.paths : []),
    ...(Array.isArray(task?.tools) ? task.tools : [])
  ].map(normalize).filter(Boolean));
  let matches = 0;
  for (const value of metadata) if (targets.has(value)) matches += 1;
  return matches;
}

function relevanceScore(document, prompt, task) {
  const promptFeatures = textFeatures(prompt);
  const lexical =
    4 * intersectionSize(promptFeatures, textFeatures(document.appliesWhen ?? []))
    + 3 * intersectionSize(promptFeatures, textFeatures(document.classOfMistake))
    + 2 * intersectionSize(promptFeatures, textFeatures(document.methodClass))
    + intersectionSize(promptFeatures, textFeatures(document.methodChanges ?? []));
  const metadata = 8 * exactMetadataMatches(document, task);
  return Math.min(40, lexical + metadata);
}

function boundedLimit(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, fallback) : fallback;
}

function limitsFrom(budget = {}) {
  return {
    maxCards: boundedLimit(budget.maxCards, HARD_LIMITS.maxCards),
    maxDocumentTokens: boundedLimit(budget.maxDocumentTokens, HARD_LIMITS.maxDocumentTokens),
    maxTotalTokens: boundedLimit(budget.maxTotalTokens, HARD_LIMITS.maxTotalTokens)
  };
}

function clip(value, max) {
  const text = String(value ?? "");
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  // Cut on a clause boundary when one is near the end, so a clipped condition
  // still reads as a complete phrase instead of stopping mid-word.
  const clipped = chars.slice(0, max).join("");
  const boundary = Math.max(
    clipped.lastIndexOf("；"), clipped.lastIndexOf("。"), clipped.lastIndexOf("，"), clipped.lastIndexOf("; ")
  );
  return `${(boundary > max * 0.6 ? clipped.slice(0, boundary) : clipped).trimEnd()}…`;
}

/**
 * The text injected into the model's context.
 *
 * Deliberately narrower than the document: selection matched on every
 * applies_when entry and every method change, and repeating all of them here
 * doubles the cost for no extra recall.
 *
 * The list of applies_when entries is capped, not the document: a lesson with
 * twelve conditions still matches on all twelve, it just shows the first few.
 *
 * When `pointerOnly` is set the document body is replaced by a reference. That
 * is the case when the rules block already carries this document's family: the
 * block renders the same method changes from the same file, so sending both is
 * one lesson twice in one prompt. Measured on a live project, the selected
 * documents accounted for 4.7 KB of a 6.9 KB injection while the layered rules
 * block — which held every one of those lessons, plus the index — cost 1.8 KB.
 *
 * A pointer still carries the hash, so "was this lesson delivered" stays
 * answerable from the session, and the path, so the reader can open the whole
 * incident when the summary is not enough. What it drops is the duplication.
 */
function documentGuidance(document, { pointerOnly = false } = {}) {
  if (pointerOnly) {
    return [
      `document_hash: ${document.documentHash}`,
      `（本家族的完整条目已在上方规则块中，此处只登记送达；需要完整经过时读 ${document.path ?? "对应反思文档"}）`
    ].join("\n");
  }
  const conditions = (document.appliesWhen ?? []).slice(0, GUIDANCE_LIMITS.appliesWhen);
  const changes = (document.methodChanges ?? []).slice(0, GUIDANCE_LIMITS.methodChanges);
  const lines = [
    // Kept despite costing ~21 tokens: it is the only handle that ties the text
    // the model sees back to the exact document in the store, which is what makes
    // "was this lesson actually delivered" answerable from the session itself.
    `document_hash: ${document.documentHash}`,
    "applies_when:",
    ...conditions.map((value) => `- ${clip(value, GUIDANCE_LIMITS.methodChangeChars)}`)
  ];
  if ((document.appliesWhen ?? []).length > conditions.length) {
    lines.push(`- (共 ${(document.appliesWhen ?? []).length} 条匹配条件，此处只列前 ${conditions.length} 条)`);
  }
  lines.push(`class_of_mistake: ${clip(document.classOfMistake, GUIDANCE_LIMITS.classOfMistakeChars)}`);
  lines.push("method_changes:");
  for (const [index, value] of changes.entries()) {
    lines.push(`${index + 1}. ${clip(value, GUIDANCE_LIMITS.methodChangeChars)}`);
  }
  if ((document.methodChanges ?? []).length > changes.length) {
    lines.push(`(共 ${(document.methodChanges ?? []).length} 条方法，此处只列前 ${changes.length} 条)`);
  }
  return lines.join("\n");
}

export function estimateGuidanceTokens(value) {
  let total = 0;
  for (const part of String(value ?? "").match(TOKEN_PART) ?? []) {
    total += /^[A-Za-z0-9]+$/u.test(part) ? Math.ceil(part.length / 4) : 1;
  }
  return total;
}

function stableIdentity(document) {
  return document.documentHash || document.reflectionId || "";
}

function omission(document, reason) {
  return { documentHash: stableIdentity(document), reason };
}

function compareNewest(left, right) {
  const time = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (time !== 0) return time;
  const leftId = left.reflectionId ?? "";
  const rightId = right.reflectionId ?? "";
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function rankKey(document) {
  return [
    -document.relevanceScore,
    -(SEVERITY_RANK[document.finalSeverity] ?? 0),
    -document.familyRecurrence,
    -Date.parse(document.createdAt),
    document.reflectionId ?? ""
  ];
}

function compareRank(left, right) {
  const leftKey = rankKey(left);
  const rightKey = rankKey(right);
  for (let index = 0; index < leftKey.length; index += 1) {
    if (leftKey[index] < rightKey[index]) return -1;
    if (leftKey[index] > rightKey[index]) return 1;
  }
  const leftIdentity = stableIdentity(left);
  const rightIdentity = stableIdentity(right);
  return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
}

function emissionMatches(prior, document, session, task) {
  return (prior?.documentHash ?? prior?.document_hash) === document.documentHash
    && (prior?.sessionUid ?? prior?.session_uid) === (session?.sessionUid ?? session?.session_uid)
    && Number(prior?.contextEpoch ?? prior?.context_epoch) === Number(session?.contextEpoch ?? session?.context_epoch)
    && (prior?.taskFingerprint ?? prior?.task_fingerprint) === (task?.fingerprint ?? task?.taskFingerprint ?? task?.task_fingerprint);
}

function completeDocument(document) {
  return Boolean(document && typeof document === "object"
    && typeof document.documentHash === "string"
    && typeof document.familyId === "string"
    && typeof document.createdAt === "string"
    && Array.isArray(document.appliesWhen)
    && typeof document.classOfMistake === "string"
    && Array.isArray(document.methodChanges)
    && document.methodChanges.length > 0);
}

export async function loadReflectionDocuments({
  projectDir,
  publishedBefore,
  maxFileBytes = HARD_LIMITS.maxFileBytes
}) {
  const catalog = await readReflectionCatalog({
    projectDir,
    publishedBefore,
    maxFileBytes: boundedLimit(maxFileBytes, HARD_LIMITS.maxFileBytes)
  });
  return {
    documents: catalog.documents,
    omissions: catalog.omissions.map((item) => ({
      opaqueId: sha256(`catalog\u0000${item.path}`),
      reason: CATALOG_REASON[item.omission] ?? "parse_error"
    }))
  };
}

export function selectReflections({
  documents,
  prompt,
  session,
  task,
  budget,
  priorEmissions = [],
  publishedBefore,
  familyRecurrence = {},
  coveredFamilies = null,
  // The families the rules block rendered IN FULL this turn. Distinct from
  // coveredFamilies, which is what selection must skip; this is what selection
  // may compress to a pointer because the instructions are already above it.
  expandedFamilies = null,
  // The text the rules block already contributed to this same prompt. Used to
  // detect a document whose instructions are already stated verbatim above it;
  // family identity cannot catch that, because the duplicated sentences come
  // from a shared template rather than from a shared family.
  injectedText = "",
  familyKeyOf = null
}) {
  const limits = limitsFrom(budget);
  const cutoffMs = Date.parse(publishedBefore);
  if (!Number.isFinite(cutoffMs)) throw new TypeError("publishedBefore must be a valid timestamp");
  const ordered = [...(Array.isArray(documents) ? documents : [])]
    .sort((left, right) => stableIdentity(left).localeCompare(stableIdentity(right), "en-US"));
  const omissions = [];
  const loaded = [];
  for (const document of ordered) {
    if (!completeDocument(document)) {
      omissions.push(omission(document, document?.canonical === false ? "legacy_incomplete" : "parse_error"));
      continue;
    }
    if (!Number.isFinite(Date.parse(document.publishedAt)) || Date.parse(document.publishedAt) >= cutoffMs) {
      omissions.push(omission(document, "published_after_cutoff"));
      continue;
    }
    loaded.push(document);
  }

  // A family that reached the rules tier is injected on every prompt by the
  // every-turn block. Selecting its document here too would put the same lesson
  // in one prompt twice and spend the selection budget on a repeat — measured
  // on a live project, 29 of 53 catalog documents duplicated a family the rules
  // block already carried. The block is the mechanical channel; selection is
  // for everything that did not make that cut.
  let candidates = loaded;
  if (coveredFamilies && typeof coveredFamilies.has === "function" && typeof familyKeyOf === "function") {
    const kept = [];
    for (const document of loaded) {
      let familyKey = null;
      try {
        familyKey = familyKeyOf(document);
      } catch {
        familyKey = null;
      }
      if (familyKey && coveredFamilies.has(familyKey)) {
        omissions.push(omission(document, "covered_by_rules"));
        continue;
      }
      kept.push(document);
    }
    candidates = kept;
  }

  // How often each family has actually recurred. Counting documents instead
  // only ever yields 1, because family projection keeps one document per
  // family — so without this the tie-break carried no information at all.
  const recurrence = new Map();
  for (const document of candidates) recurrence.set(document.familyId, (recurrence.get(document.familyId) ?? 0) + 1);
  for (const [familyId, occurrences] of Object.entries(familyRecurrence ?? {})) {
    if (Number.isSafeInteger(occurrences) && occurrences > 0) {
      recurrence.set(familyId, Math.max(recurrence.get(familyId) ?? 0, occurrences));
    }
  }
  const applicable = [];
  for (const document of candidates) {
    const score = relevanceScore(document, prompt, task);
    if (score <= 0) {
      omissions.push(omission(document, "not_applicable"));
      continue;
    }
    applicable.push({
      ...document,
      finalSeverity: document.severity,
      relevanceScore: score,
      familyRecurrence: recurrence.get(document.familyId)
    });
  }

  const projected = new Map();
  for (const document of applicable) {
    const current = projected.get(document.familyId);
    if (!current || compareNewest(document, current) > 0) {
      if (current) omissions.push(omission(current, "family_projection"));
      projected.set(document.familyId, document);
    } else {
      omissions.push(omission(document, "family_projection"));
    }
  }

  const ranked = [];
  for (const document of projected.values()) {
    if (priorEmissions.some((prior) => emissionMatches(prior, document, session, task))) {
      omissions.push(omission(document, "prior_emission"));
      continue;
    }
    ranked.push(document);
  }
  ranked.sort(compareRank);

  const budgeted = [];
  for (const document of ranked) {
    // When is a document's body redundant with what the rules block already
    // put in this same prompt? Two distinct cases, and the second is the one
    // that actually occurs:
    //
    // 1. Its family was expanded in full above. Selection normally skips those
    //    already (covered_by_rules), so this is a belt-and-braces check for a
    //    family that resolved here but not there.
    // 2. Its instructions already appear verbatim in the block. This is the
    //    real case: the escalation template writes the same two method sentences
    //    for every family it rescues, so a document for family A repeats what
    //    the block says about family B. Measured on a live project, the injected
    //    document was 1,492 B and both of its method changes were byte-identical
    //    to lines already in the block — 2 of 2.
    //
    // Identity alone cannot catch case 2; the families genuinely differ. Only
    // comparing the text can, so that is what decides.
    let pointerOnly = false;
    if (expandedFamilies && typeof expandedFamilies.has === "function" && typeof familyKeyOf === "function") {
      try {
        const familyKey = familyKeyOf(document);
        pointerOnly = Boolean(familyKey && expandedFamilies.has(familyKey));
      } catch {
        pointerOnly = false;
      }
    }
    if (!pointerOnly && injectedText) {
      const changes = (document.methodChanges ?? []).filter((entry) => String(entry ?? "").trim());
      const unique = changes.filter((entry) => !injectedText.includes(clip(entry, GUIDANCE_LIMITS.methodChangeChars)));
      pointerOnly = changes.length > 0 && unique.length === 0;
    }
    const guidance = documentGuidance(document, { pointerOnly });
    const tokenEstimate = estimateGuidanceTokens(guidance);
    if (tokenEstimate > limits.maxDocumentTokens) {
      omissions.push(omission(document, "token_budget"));
      continue;
    }
    budgeted.push({ ...document, guidance, tokenEstimate, pointerOnly });
  }

  const selected = [];
  let tokenEstimate = 0;
  for (const document of budgeted) {
    if (selected.length >= limits.maxCards) {
      omissions.push(omission(document, "count_budget"));
      continue;
    }
    if (tokenEstimate + document.tokenEstimate > limits.maxTotalTokens) {
      omissions.push(omission(document, "token_budget"));
      continue;
    }
    selected.push(document);
    tokenEstimate += document.tokenEstimate;
  }

  return {
    guidance: selected.map((document) => document.guidance).join("\n\n"),
    selected: selected.map(({ guidance: ignored, ...document }) => document),
    omissions,
    tokenEstimate
  };
}
