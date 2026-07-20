import { createHash } from "node:crypto";

const LESSON_KEYS = new Set([
  "outcome",
  "final_severity",
  "responsibility",
  "method_class",
  "family_id",
  "proposed_family_key",
  "applies_when",
  "facts",
  "user_complaint",
  "root_cause",
  "class_of_mistake",
  "method_changes",
  "repeated_pattern_evidence",
  "recurrence_of"
]);
const SEVERITIES = new Set(["Major", "Critical", "Blocker"]);
const METHOD_CLASS_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const FAMILY_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FAMILY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BLOCKED_CONTENT = [
  /\bauthorization\s*:\s*bearer\s+\S+/i,
  /\b(?:password|passwd|passcode|api[_ -]?key|secret|token)\s*[=:]\s*\S+/i,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{12,})\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bAFL_REVIEW_[A-Z0-9_]*\s*=\s*\S+/i,
  /\[AFL\]|(?:<!--|&lt;!--)\s*afl-receipt\b|<hook_prompt\b|\bhookPrompt\b|Output this receipt verbatim before stopping/i
];

function fail(message) {
  throw new TypeError(message);
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    fail("reviewer result has unexpected fields");
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) fail("reviewer result is missing a required field");
  }
}

function characterLength(value) {
  return Array.from(value).length;
}

function normalizedString(value, { name, maxLength, pattern = null, scan = false, canonical = false }) {
  if (typeof value !== "string") fail(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || characterLength(normalized) > maxLength) fail(`${name} is outside its length bound`);
  if (canonical && value !== normalized) fail(`${name} must already be canonical`);
  if (pattern && !pattern.test(normalized)) fail(`${name} has an invalid format`);
  if (scan && BLOCKED_CONTENT.some((blocked) => blocked.test(normalized))) {
    fail(`${name} contains a forbidden payload`);
  }
  return normalized;
}

function normalizedArray(value, { name, minItems = 0, maxItems, maxLength, scan = false }) {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) {
    fail(`${name} is outside its item bound`);
  }
  const normalized = value.map((item) => normalizedString(item, { name, maxLength, scan }));
  if (new Set(normalized).size !== normalized.length) fail(`${name} contains duplicate items`);
  return normalized;
}

function allowedFamilySet(value) {
  if (!Array.isArray(value) || value.length > 512) fail("allowedFamilyIds must be a bounded array");
  const result = new Set();
  for (const item of value) {
    const id = normalizedString(item, {
      name: "allowedFamilyIds",
      maxLength: 128,
      pattern: FAMILY_ID_PATTERN,
      canonical: true
    });
    if (result.has(id)) fail("allowedFamilyIds contains duplicates");
    result.add(id);
  }
  return result;
}

export function deriveReviewerFamilyId(methodClass, proposedFamilyKey) {
  const method = normalizedString(methodClass, {
    name: "methodClass",
    maxLength: 64,
    pattern: METHOD_CLASS_PATTERN,
    canonical: true
  });
  const key = normalizedString(proposedFamilyKey, {
    name: "proposedFamilyKey",
    maxLength: 128,
    pattern: FAMILY_KEY_PATTERN,
    canonical: true
  });
  const digest = createHash("sha256").update(`${method}\n${key}`).digest("hex").slice(0, 20);
  return `family-${digest}`;
}

export function validateReviewerResult(value, {
  allowedFamilyIds = [],
  recurrenceFamilyById = new Map()
} = {}) {
  if (!isRecord(value)) fail("reviewer result must be an object");
  if (value.outcome === "no_lesson") {
    exactKeys(value, new Set(["outcome"]));
    return { outcome: "no_lesson" };
  }
  if (value.outcome !== "lesson") fail("reviewer result has an unsupported outcome");
  exactKeys(value, LESSON_KEYS);
  if (!SEVERITIES.has(value.final_severity)) fail("final_severity is unsupported");
  if (value.responsibility !== "agent_fault") fail("responsibility is unsupported");
  if (!(recurrenceFamilyById instanceof Map) || recurrenceFamilyById.size > 4_096) {
    fail("recurrenceFamilyById must be a bounded Map");
  }

  const methodClass = normalizedString(value.method_class, {
    name: "method_class",
    maxLength: 64,
    pattern: METHOD_CLASS_PATTERN,
    canonical: true
  });
  const recurrenceOf = normalizedArray(value.recurrence_of, {
    name: "recurrence_of",
    maxItems: 16,
    maxLength: 128
  });
  const families = allowedFamilySet(allowedFamilyIds);
  let familyId = null;
  let proposedFamilyKey = null;
  if (value.family_id === null) {
    if (recurrenceOf.length !== 0) fail("a new family cannot claim recurrence");
    proposedFamilyKey = normalizedString(value.proposed_family_key, {
      name: "proposed_family_key",
      maxLength: 128,
      pattern: FAMILY_KEY_PATTERN,
      canonical: true,
      scan: true
    });
  } else {
    familyId = normalizedString(value.family_id, {
      name: "family_id",
      maxLength: 128,
      pattern: FAMILY_ID_PATTERN,
      canonical: true
    });
    if (!families.has(familyId)) fail("family_id is not in the controller catalog");
    if (value.proposed_family_key !== null) fail("an existing family cannot include a proposed key");
    for (const reflectionId of recurrenceOf) {
      if (!recurrenceFamilyById.has(reflectionId)
          || recurrenceFamilyById.get(reflectionId) !== familyId) {
        fail("recurrence_of is not proven for the selected family");
      }
    }
  }

  return {
    outcome: "lesson",
    final_severity: value.final_severity,
    responsibility: "agent_fault",
    method_class: methodClass,
    family_id: familyId,
    proposed_family_key: proposedFamilyKey,
    applies_when: normalizedArray(value.applies_when, {
      name: "applies_when", minItems: 1, maxItems: 8, maxLength: 160, scan: true
    }),
    facts: normalizedArray(value.facts, {
      name: "facts", minItems: 1, maxItems: 12, maxLength: 512, scan: true
    }),
    user_complaint: normalizedString(value.user_complaint, {
      name: "user_complaint", maxLength: 2_048, scan: true
    }),
    root_cause: normalizedString(value.root_cause, {
      name: "root_cause", maxLength: 2_048, scan: true
    }),
    class_of_mistake: normalizedString(value.class_of_mistake, {
      name: "class_of_mistake", maxLength: 2_048, scan: true
    }),
    method_changes: normalizedArray(value.method_changes, {
      name: "method_changes", minItems: 1, maxItems: 8, maxLength: 512, scan: true
    }),
    repeated_pattern_evidence: normalizedArray(value.repeated_pattern_evidence, {
      name: "repeated_pattern_evidence", maxItems: 8, maxLength: 512, scan: true
    }),
    recurrence_of: recurrenceOf
  };
}
