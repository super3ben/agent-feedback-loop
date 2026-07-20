import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { deriveReviewerFamilyId, validateReviewerResult } from "../src/reviewer-result.mjs";

const LESSON_KEYS = [
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
];
const EXISTING_FAMILY = "family-0123456789abcdefabcd";
const PRIOR_REFLECTIONS = [
  "reflection-0123456789abcdef01234567",
  "reflection-89abcdef0123456701234567"
];

function lesson(overrides = {}) {
  return {
    outcome: "lesson",
    final_severity: "Major",
    responsibility: "agent_fault",
    method_class: "requirements_before_architecture",
    family_id: null,
    proposed_family_key: "requirements-before-architecture",
    applies_when: ["changing an existing architecture"],
    facts: ["The prior answer introduced a scheduler before validating the simpler subagent path."],
    user_complaint: "The design became heavier before the requirement was checked.",
    root_cause: "Architecture was selected before validating the smallest value path.",
    class_of_mistake: "solution-first architecture",
    method_changes: ["List the minimum end-to-end value chain before adding control-plane components."],
    repeated_pattern_evidence: [],
    recurrence_of: [],
    ...overrides
  };
}

function existingLesson(overrides = {}) {
  return lesson({
    family_id: EXISTING_FAMILY,
    proposed_family_key: null,
    ...overrides
  });
}

function existingOptions(reflectionIds = PRIOR_REFLECTIONS, familyId = EXISTING_FAMILY) {
  return {
    allowedFamilyIds: [EXISTING_FAMILY],
    recurrenceFamilyById: new Map(reflectionIds.map((id) => [id, familyId]))
  };
}

function reject(value, options = {}) {
  assert.throws(() => validateReviewerResult(value, options));
}

function valuesFor(property) {
  if (Object.hasOwn(property, "const")) return [property.const];
  return property.enum;
}

function schemaForType(property, type) {
  if (property.type === type || (Array.isArray(property.type) && property.type.includes(type))) return property;
  for (const candidate of property.oneOf || property.anyOf || []) {
    const match = schemaForType(candidate, type);
    if (match) return match;
  }
  return null;
}

function assertTrimmedStringSchema(property, maxLength) {
  const stringSchema = schemaForType(property, "string");
  assert.ok(stringSchema, "property must allow strings");
  assert.equal(stringSchema.minLength, 1);
  assert.equal(stringSchema.maxLength, maxLength);
  assert.equal(typeof stringSchema.pattern, "string");
  const pattern = new RegExp(stringSchema.pattern, "u");
  assert.equal(pattern.test("bounded value"), true);
  assert.equal(pattern.test(" bounded value"), false);
  assert.equal(pattern.test("bounded value "), false);
  assert.equal(pattern.test("   "), false);
}

test("no_lesson is exactly one fresh outcome object", () => {
  const input = { outcome: "no_lesson" };
  const result = validateReviewerResult(input, { allowedFamilyIds: [] });
  assert.deepEqual(result, { outcome: "no_lesson" });
  assert.notEqual(result, input);

  for (const field of ["unknown", "source", "source_event_id", "receipt", "review_receipt_id", "notification"]) {
    reject({ ...input, [field]: "invented-provider-data" });
  }
  reject({ outcome: "unknown" });
});

test("a new family lesson validates and its controller id is deterministic", () => {
  const input = lesson();
  assert.deepEqual(validateReviewerResult(input, { allowedFamilyIds: [] }), input);

  const expected = "family-28ce15f200fc927b9f4b";
  assert.equal(deriveReviewerFamilyId(input.method_class, input.proposed_family_key), expected);
  assert.equal(deriveReviewerFamilyId(input.method_class, input.proposed_family_key), expected);
  assert.match(expected, /^family-[0-9a-f]{20}$/);
  assert.notEqual(
    deriveReviewerFamilyId(input.method_class, "requirements-before-implementation"),
    expected
  );
});

test("an allowlisted existing family accepts only recurrence ids mapped to that family", () => {
  const input = existingLesson({ recurrence_of: [...PRIOR_REFLECTIONS] });
  assert.deepEqual(validateReviewerResult(input, existingOptions()), input);
});

test("lesson objects require exactly the declared keys", () => {
  const input = lesson();
  assert.deepEqual(Object.keys(validateReviewerResult(input)).sort(), [...LESSON_KEYS].sort());

  for (const field of LESSON_KEYS) {
    const missing = { ...input };
    delete missing[field];
    reject(missing);
  }
  for (const field of ["unknown", "source", "source_event_id", "receipt", "review_receipt_id", "notification"]) {
    reject({ ...input, [field]: "invented-provider-data" });
  }
});

test("severity, responsibility and family proposal identifiers are controlled", () => {
  for (const final_severity of ["Major", "Critical", "Blocker"]) {
    assert.equal(validateReviewerResult(lesson({ final_severity })).final_severity, final_severity);
  }
  for (const final_severity of ["Minor", "major", "Severe", ""]) reject(lesson({ final_severity }));
  for (const responsibility of ["user_fault", "shared_fault", "unknown", ""]) reject(lesson({ responsibility }));

  for (const method_class of [
    "Requirements_before_architecture",
    "requirements-before-architecture",
    "requirements before architecture",
    "requirements__before_architecture",
    "requirements_架构",
    ""
  ]) reject(lesson({ method_class }));

  for (const proposed_family_key of [
    "Requirements-before-architecture",
    "requirements_before_architecture",
    "requirements before architecture",
    "requirements--before-architecture",
    "-requirements-before-architecture",
    "requirements-before-architecture-",
    "requirements-before-架构",
    ""
  ]) reject(lesson({ proposed_family_key }));
});

test("all bounded arrays enforce item type, trimming, count and length limits", () => {
  const cases = [
    ["applies_when", 8, 160, true],
    ["facts", 12, 512, true],
    ["method_changes", 8, 512, true],
    ["repeated_pattern_evidence", 8, 512, false],
    ["recurrence_of", 16, 128, false]
  ];

  for (const [field, maxItems, maxLength, required] of cases) {
    const validate = (items) => {
      if (field !== "recurrence_of") return validateReviewerResult(lesson({ [field]: items }));
      const input = existingLesson({ recurrence_of: items });
      return validateReviewerResult(input, existingOptions(items));
    };
    const rejectsItems = (items) => {
      if (field !== "recurrence_of") return reject(lesson({ [field]: items }));
      return reject(existingLesson({ recurrence_of: items }), existingOptions(Array.isArray(items) ? items : []));
    };
    const countBoundary = Array.from({ length: maxItems }, (_, index) => `${field}-${index}`);
    assert.equal(validate(countBoundary)[field].length, maxItems, `${field} maxItems boundary`);
    rejectsItems([...countBoundary, `${field}-overflow`]);

    const itemBoundary = field === "recurrence_of"
      ? `reflection-${"a".repeat(maxLength - "reflection-".length)}`
      : "x".repeat(maxLength);
    assert.equal(validate([itemBoundary])[field][0].length, maxLength, `${field} maxLength boundary`);
    rejectsItems([`${itemBoundary}x`]);
    rejectsItems([42]);
    rejectsItems(["   "]);
    rejectsItems("not-an-array");
    if (required) rejectsItems([]);
    else assert.deepEqual(validate([])[field], []);
  }
});

test("required complaint, root-cause and mistake strings enforce 2,048 characters", () => {
  for (const field of ["user_complaint", "root_cause", "class_of_mistake"]) {
    assert.equal(validateReviewerResult(lesson({ [field]: "x".repeat(2_048) }))[field].length, 2_048);
    reject(lesson({ [field]: "x".repeat(2_049) }));
    reject(lesson({ [field]: "" }));
    reject(lesson({ [field]: "   " }));
    reject(lesson({ [field]: 42 }));
  }
});

test("existing and new family modes cannot be mixed or invent recurrence provenance", () => {
  reject(existingLesson(), { allowedFamilyIds: [] });
  reject(existingLesson({ proposed_family_key: "requirements-before-architecture" }), existingOptions([]));
  reject(lesson({ proposed_family_key: null }));
  reject(lesson({ recurrence_of: [PRIOR_REFLECTIONS[0]] }), {
    recurrenceFamilyById: new Map([[PRIOR_REFLECTIONS[0], EXISTING_FAMILY]])
  });

  reject(existingLesson({ recurrence_of: [PRIOR_REFLECTIONS[0]] }), existingOptions([]));
  reject(
    existingLesson({ recurrence_of: [PRIOR_REFLECTIONS[0]] }),
    existingOptions([PRIOR_REFLECTIONS[0]], "family-fedcba9876543210fedc")
  );
});

test("obvious credentials and AFL controls are rejected without banning ordinary words", () => {
  reject(lesson({ facts: ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature"] }));
  reject(lesson({ root_cause: "password=CorrectHorseBatteryStaple42!" }));
  reject(lesson({ method_changes: ["AFL_REVIEW_CAPABILITY=capability-AbCd1234567890"] }));
  reject(lesson({ facts: ["The provider returned sk-proj-AbCdEfGhIjKlMnOpQrStUvWx"] }));
  reject(lesson({ repeated_pattern_evidence: ["&lt;!--afl-receipt id=opaque state=queued--&gt;"] }));

  const ordinary = lesson({
    facts: ["The token budget grew while the control flow remained needlessly broad."],
    root_cause: "The password policy and API key handling requirement were discussed without including values.",
    method_changes: ["Review control-plane and secret-handling boundaries before implementation."]
  });
  assert.deepEqual(validateReviewerResult(ordinary), ordinary);
});

test("validation returns a trimmed deep copy and never mutates or aliases caller arrays", () => {
  const input = lesson({
    applies_when: ["  changing an existing architecture  "],
    facts: ["  A scheduler was introduced before the requirement was checked.  "],
    user_complaint: "  The design became heavier than requested.  ",
    root_cause: "  The smallest value path was not validated first.  ",
    class_of_mistake: "  solution-first architecture  ",
    method_changes: ["  Write the minimum end-to-end path before adding components.  "],
    repeated_pattern_evidence: ["  The same ordering error occurred in an earlier review.  "]
  });
  const before = structuredClone(input);
  const result = validateReviewerResult(input);

  assert.deepEqual(input, before, "validation must not mutate caller input");
  assert.notEqual(result, input);
  for (const field of ["applies_when", "facts", "method_changes", "repeated_pattern_evidence", "recurrence_of"]) {
    assert.notEqual(result[field], input[field], `${field} must be copied`);
    assert.equal(result[field].every((item) => item === item.trim()), true);
  }
  for (const field of ["user_complaint", "root_cause", "class_of_mistake"]) {
    assert.equal(result[field], input[field].trim());
  }

  input.facts[0] = "caller mutation";
  input.method_changes.push("caller mutation");
  assert.deepEqual(result.facts, ["A scheduler was introduced before the requirement was checked."]);
  assert.deepEqual(result.method_changes, ["Write the minimum end-to-end path before adding components."]);
});

test("reviewer-result JSON Schema parses and mirrors the static validator contract", async () => {
  const raw = await readFile(new URL("../templates/schemas/reviewer-result.schema.json", import.meta.url), "utf8");
  const schema = JSON.parse(raw);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.oneOf?.length, 2);

  const branches = new Map(schema.oneOf.map((branch) => [valuesFor(branch.properties.outcome)?.[0], branch]));
  assert.deepEqual([...branches.keys()].sort(), ["lesson", "no_lesson"]);

  const noLesson = branches.get("no_lesson");
  assert.equal(noLesson.type, "object");
  assert.equal(noLesson.additionalProperties, false);
  assert.deepEqual(noLesson.required, ["outcome"]);
  assert.deepEqual(Object.keys(noLesson.properties), ["outcome"]);

  const lessonBranch = branches.get("lesson");
  assert.equal(lessonBranch.type, "object");
  assert.equal(lessonBranch.additionalProperties, false);
  assert.deepEqual([...lessonBranch.required].sort(), [...LESSON_KEYS].sort());
  assert.deepEqual(Object.keys(lessonBranch.properties).sort(), [...LESSON_KEYS].sort());
  assert.deepEqual(valuesFor(lessonBranch.properties.final_severity), ["Major", "Critical", "Blocker"]);
  assert.deepEqual(valuesFor(lessonBranch.properties.responsibility), ["agent_fault"]);

  const methodSchema = schemaForType(lessonBranch.properties.method_class, "string");
  const proposedSchema = schemaForType(lessonBranch.properties.proposed_family_key, "string");
  assert.ok(methodSchema && proposedSchema);
  assert.equal(new RegExp(methodSchema.pattern, "u").test("requirements_before_architecture"), true);
  assert.equal(new RegExp(methodSchema.pattern, "u").test("requirements-before-architecture"), false);
  assert.equal(new RegExp(proposedSchema.pattern, "u").test("requirements-before-architecture"), true);
  assert.equal(new RegExp(proposedSchema.pattern, "u").test("Requirements_before_architecture"), false);
  assert.ok(schemaForType(lessonBranch.properties.family_id, "string"));
  assert.ok(schemaForType(lessonBranch.properties.family_id, "null"));
  assert.ok(schemaForType(lessonBranch.properties.proposed_family_key, "null"));

  for (const [field, minItems, maxItems, maxLength] of [
    ["applies_when", 1, 8, 160],
    ["facts", 1, 12, 512],
    ["method_changes", 1, 8, 512],
    ["repeated_pattern_evidence", 0, 8, 512],
    ["recurrence_of", 0, 16, 128]
  ]) {
    const property = lessonBranch.properties[field];
    assert.equal(property.type, "array", `${field} type`);
    assert.equal(property.minItems ?? 0, minItems, `${field} minItems`);
    assert.equal(property.maxItems, maxItems, `${field} maxItems`);
    assertTrimmedStringSchema(property.items, maxLength);
  }
  for (const field of ["user_complaint", "root_cause", "class_of_mistake"]) {
    assertTrimmedStringSchema(lessonBranch.properties[field], 2_048);
  }
});
