import { createHash } from "node:crypto";

import { readReflectionCatalog } from "./reflection-document.mjs";

const HARD_LIMITS = Object.freeze({
  maxFileBytes: 131_072,
  maxCards: 4,
  maxDocumentTokens: 320,
  maxTotalTokens: 900
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

function documentGuidance(document) {
  return [
    `document_hash: ${document.documentHash}`,
    "applies_when:",
    ...document.appliesWhen.map((value) => `- ${value}`),
    `class_of_mistake: ${document.classOfMistake}`,
    "method_changes:",
    ...document.methodChanges.map((value, index) => `${index + 1}. ${value}`)
  ].join("\n");
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
  publishedBefore
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

  const recurrence = new Map();
  for (const document of loaded) recurrence.set(document.familyId, (recurrence.get(document.familyId) ?? 0) + 1);
  const applicable = [];
  for (const document of loaded) {
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
    const guidance = documentGuidance(document);
    const tokenEstimate = estimateGuidanceTokens(guidance);
    if (tokenEstimate > limits.maxDocumentTokens) {
      omissions.push(omission(document, "token_budget"));
      continue;
    }
    ranked.push({ ...document, guidance, tokenEstimate });
  }
  ranked.sort(compareRank);

  const selected = [];
  let tokenEstimate = 0;
  for (const document of ranked) {
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
