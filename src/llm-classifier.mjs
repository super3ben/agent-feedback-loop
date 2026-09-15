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
  codexProviderRouting,
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
    "判断用户是否表达不满、质疑或抱怨，然后以 JSON 收尾：",
    '{ "dissatisfied": true } 或 { "dissatisfied": false }。',
    "",
    "先给一句简短理由，再输出 JSON。只输出理由和 JSON，不要别的。",
    "",
    "判定原则：",
    "- 看用户说出口的话本身。反问、质疑、指责、抱怨就是不满，",
    "  即使助手觉得自己有道理。",
    "- 助手的辩解或解释不能作为用户没有不满的理由。",
    "",
    "【不满 / 质疑 / 抱怨】",
    "- 反问或质问：为什么还这样？本机都直连了还不能做？其他会话都部署过了你还不能做？",
    "  怎么又不行？你根本没改对吧？",
    "- 明确说助手错了 / 没用 / 没做到：不是这样，没用，你又说错，这不是我想要的",
    "- 抱怨反复 / 又来了：每次都要问，又来了，之前不是说过吗，还是这样",
    "- 预期没达到：不是让你直接做吗？明明能用为什么不用？你绕了半天",
    "- 助手把活推回、用户反对：还要我自己做？你直接做啊",
    "",
    "【中性，判 false】",
    "- 纯信息性提问、无情绪：这个怎么配置？这条命令是干嘛的？",
    "- 继续或确认：继续，好的，可以，明白，下一步，收到",
    "",
    "用户消息：",
    userText
  ];
  if (referentText) {
    lines.push(
      "",
      "助手此前的回应（仅作背景，不能作为用户没有不满的理由）：",
      referentText
    );
  }
  return lines.join("\n");
}

function parseVerdict(stdout) {
  const text = String(stdout ?? "");
  // The model emits a reason then a JSON verdict. Match the last
  // {"dissatisfied": true|false} so a reason mentioning "不满" or "true"
  // earlier cannot flip the result.
  const json = /[{\[]\s*"dissatisfied"\s*:\s*(true|false)\s*[}\]]/u.exec(text);
  if (!json) return null;
  return json[1] === "true"
    ? { admission: true, reasonCode: "llm_confirmed" }
    : { admission: false, reasonCode: "llm_rejected" };
}

// A lean yes/no call, not the full evidence/schema contract the reviewer uses.
// The prompt goes on stdin; the CLI's plain-text output is the verdict.
function classifierInvocation({ cli, executable, codexRouting = [] }) {
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
        // --ignore-user-config drops the user's model_provider gateway routing
        // (base_url etc.). Without re-injecting it the isolated codex call
        // cannot reach the gateway and reconnect-loops until the timeout —
        // exactly what wedged every codex classification in llm_pending.
        ...codexRouting,
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

  // dsh has no own binary: the classifier subprocess runs on a host CLI
  // (resolveExecutable applies the same fallback order as the reviewer).
  const invocationCli = evidence.sourceProvider === "dsh" ? "claude" : evidence.sourceProvider;
  const executable = await resolveExecutable({ cli: invocationCli, env });
  if (!executable) {
    store.releaseLLMClassification({ jobId, ownerId, leaseEpoch: claimed.leaseEpoch, backoffMs: RELEASE_BACKOFF_MS });
    throw new LLMClassifyError("provider_unavailable");
  }
  // Same gateway routing the full reviewer injects for codex: without it the
  // isolated call cannot reach the user's model provider.
  let codexRouting = [];
  if (invocationCli === "codex" && typeof env?.HOME === "string" && env.HOME) {
    try {
      codexRouting = await codexProviderRouting({ configFile: path.join(env.HOME, ".codex", "config.toml") });
    } catch {
      codexRouting = [];
    }
  }
  // The provider shell-outs bind the schema to their own transport. The
  // classifier has no schema; it reads plain yes/no, so use the claude shorthand.
  const invocation = classifierInvocation({
    cli: invocationCli,
    executable,
    codexRouting
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
