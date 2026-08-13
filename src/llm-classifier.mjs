// Detached LLM gate for candidates the wordlist missed.
//
// classifyRetrospectiveEvidence requires a negative_evaluation pattern, so a
// genuine "还是这样" or "乱套了" never becomes a candidate. The fallback admits
// the event anyway (state=llm_pending) and this detached process asks a lean
// binary verb ("is the user expressing dissatisfaction?") of the same claude /
// codex subprocess the full reviewer uses. Yes admits the job to the reviewer;
// no discards it. Runs outside the 5s hook timeout.
import path from "node:path";

import {
  resolveReviewerExecutable,
  reviewerEnvironment,
  runProcessWithInput
} from "./reviewer-provider.mjs";
import { redactText } from "./capture.mjs";

const EVENT_TEXT_FIELDS = ["text", "prompt", "message", "content", "output", "response"];
const MAX_PROMPT_CHARACTERS = 8_192;
const MAX_OUTPUT_CHARACTERS = 2_048;
const DEFAULT_TIMEOUT_MS = 60_000;
// After a failed classifier call the job is released with this backoff so the
// per-hook recovery pass does not re-fire a classifier that keeps failing.
const RELEASE_BACKOFF_MS = 30_000;

class LLMClassifyError extends Error {
  constructor(code, cause) {
    super(code);
    this.name = "LLMClassifyError";
    this.code = code;
  }
}

function boundedText(value, maxCharacters = MAX_PROMPT_CHARACTERS) {
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
    if (typeof value === "string") selected[field] = boundedText(value, 4_096);
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

async function sourceEventText({ store, blobs, jobId }) {
  const context = store.getReviewContext({ jobId, priorLimit: 0, followingLimit: 0 });
  if (!context?.job || !context.source) throw new LLMClassifyError("context_invalid");
  const raw = await blobs.read(context.source.encrypted_raw_ref);
  const userText = hostText(raw);
  let referentText = null;
  if (context.referent?.encrypted_raw_ref) {
    const referentRaw = await blobs.read(context.referent.encrypted_raw_ref);
    referentText = hostText(referentRaw);
  }
  return {
    userText,
    referentText,
    sourceProvider: context.source.source_provider
  };
}

function classifyPrompt({ userText, referentText }) {
  const lines = [
    "You are a simple classifier. Determine whether a user message expresses",
    "dissatisfaction about an AI assistant's work.",
    "",
    "Reply with ONLY \"yes\" or \"no\", nothing else.",
    "",
    "User message:",
    userText
  ];
  if (referentText) {
    lines.push(
      "",
      "The assistant's preceding response (for context only):",
      referentText
    );
  }
  return lines.join("\n");
}

function parseVerdict(stdout) {
  const trimmed = String(stdout ?? "").trim().toLowerCase();
  if (/\byes\b/u.test(trimmed)) return { admission: true, reasonCode: "llm_confirmed" };
  if (/\bno\b/u.test(trimmed)) return { admission: false, reasonCode: "llm_rejected" };
  return null;
}

// A lean yes/no call, not the full evidence/schema contract the reviewer uses.
// The prompt goes on stdin; the CLI's plain-text output is the verdict.
function classifierInvocation({ cli, executable }) {
  if (cli === "claude") {
    return {
      command: executable,
      args: [
        "-p",
        "--safe-mode",
        "--no-session-persistence",
        "--tools", "",
        "--output-format", "text",
        "-"
      ]
    };
  }
  if (cli === "codex") {
    return {
      command: executable,
      args: [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--sandbox", "read-only",
        "--color", "never",
        "-"
      ]
    };
  }
  throw new LLMClassifyError("provider_unavailable");
}

export async function runLLMClassifier({
  store,
  blobs,
  jobId,
  ownerId,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  runProcess = runProcessWithInput,
  resolveExecutable = resolveReviewerExecutable
}) {
  if (!store || !blobs || typeof runProcess !== "function" || typeof resolveExecutable !== "function") {
    throw new LLMClassifyError("context_invalid");
  }
  const claimed = store.claimLLMClassification({ jobId, ownerId, leaseMs: timeoutMs });
  if (!claimed) throw new LLMClassifyError("lease_lost");

  let evidence;
  try {
    evidence = await sourceEventText({ store, blobs, jobId });
  } catch (error) {
    const code = error instanceof LLMClassifyError ? error.code : "context_invalid";
    store.releaseLLMClassification({ jobId, ownerId, leaseEpoch: claimed.leaseEpoch, backoffMs: RELEASE_BACKOFF_MS });
    throw new LLMClassifyError(code, error);
  }

  const executable = await resolveExecutable({ cli: evidence.sourceProvider, env });
  if (!executable) {
    store.releaseLLMClassification({ jobId, ownerId, leaseEpoch: claimed.leaseEpoch, backoffMs: RELEASE_BACKOFF_MS });
    throw new LLMClassifyError("provider_unavailable");
  }
  // The provider shell-outs bind the schema to their own transport. The
  // classifier has no schema; it reads plain yes/no, so use the claude shorthand.
  const invocation = classifierInvocation({
    cli: evidence.sourceProvider,
    executable
  });
  const input = classifyPrompt({ userText: evidence.userText, referentText: evidence.referentText });
  let output;
  try {
    output = await runProcess({
      ...invocation,
      cwd: path.dirname(invocation.command),
      env: reviewerEnvironment(env),
      input,
      timeoutMs
    });
  } catch (error) {
    store.releaseLLMClassification({ jobId, ownerId, leaseEpoch: claimed.leaseEpoch, backoffMs: RELEASE_BACKOFF_MS });
    const code = String(error?.code || "provider_unavailable");
    throw new LLMClassifyError(code === "reviewer_timeout" ? "provider_timeout" : code, error);
  }
  const verdict = parseVerdict(output?.stdout);
  if (!verdict) {
    store.releaseLLMClassification({ jobId, ownerId, leaseEpoch: claimed.leaseEpoch, backoffMs: RELEASE_BACKOFF_MS });
    throw new LLMClassifyError("provider_invalid");
  }
  let resolved;
  try {
    resolved = store.resolveLLMAdmission({
      jobId,
      ownerId,
      leaseEpoch: claimed.leaseEpoch,
      admission: verdict.admission,
      reasonCode: verdict.reasonCode
    });
  } catch (error) {
    throw new LLMClassifyError("lease_lost", error);
  }
  return {
    jobId,
    admission: verdict.admission,
    reasonCode: verdict.reasonCode,
    state: resolved.state
  };
}
