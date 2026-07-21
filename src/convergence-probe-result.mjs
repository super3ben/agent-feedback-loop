const FIELDS = Object.freeze([
  "assessment",
  "action",
  "unmet_user_value",
  "wrong_assumption",
  "unnecessary_scope",
  "minimal_next_step",
  "falsification_test"
]);
const FIELD_SET = new Set(FIELDS);
const ASSESSMENTS = new Set([
  "aligned_and_necessary",
  "wrong_direction",
  "overdesigned",
  "overoptimized",
  "insufficient_evidence",
  "scope_drift",
  "acceptance_already_satisfied"
]);
const ACTIONS = new Set([
  "continue_once",
  "simplify_current_generation",
  "rollback_to_generation",
  "direction_checkpoint",
  "human_decision",
  "finish_now"
]);
const FORBIDDEN_CONTENT = Object.freeze([
  /\bauthorization\s*:\s*bearer\s+\S+/iu,
  /\b(?:password|passwd|passcode|api[_ -]?key|secret|token)\s*[=:]\s*\S+/iu,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{12,})\b/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\bAFL_REVIEW_[A-Z0-9_]*\s*=\s*\S+/iu,
  /\[AFL\]|(?:<!--|&lt;!--)\s*afl-receipt\b|<hook_prompt\b|\bhookPrompt\b|Output this receipt verbatim before stopping/iu
]);

function invalid() {
  throw new TypeError("probe result is invalid");
}

function exactPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const keys = Object.keys(value);
  if (keys.length !== FIELD_SET.size || keys.some((key) => !FIELD_SET.has(key))) invalid();
  for (const field of FIELDS) if (!Object.hasOwn(value, field)) invalid();
}

function boundedScannedText(value, maximum) {
  if (typeof value !== "string" || value !== value.trim()) invalid();
  if (Array.from(value).length < 1 || Array.from(value).length > maximum) invalid();
  if (FORBIDDEN_CONTENT.some((pattern) => pattern.test(value))) invalid();
  return value;
}

function boundedUniqueArray(value, maximumItems, maximumLength) {
  if (!Array.isArray(value) || value.length > maximumItems) invalid();
  const result = value.map((item) => boundedScannedText(item, maximumLength));
  if (new Set(result).size !== result.length) invalid();
  return Object.freeze(result);
}

export function validateConvergenceProbeResult(value) {
  exactPlainObject(value);
  if (!ASSESSMENTS.has(value.assessment) || !ACTIONS.has(value.action)) invalid();
  return Object.freeze({
    assessment: value.assessment,
    action: value.action,
    unmet_user_value: boundedScannedText(value.unmet_user_value, 1_024),
    wrong_assumption: boundedScannedText(value.wrong_assumption, 1_024),
    unnecessary_scope: boundedUniqueArray(value.unnecessary_scope, 8, 256),
    minimal_next_step: boundedScannedText(value.minimal_next_step, 1_024),
    falsification_test: boundedScannedText(value.falsification_test, 1_024)
  });
}
