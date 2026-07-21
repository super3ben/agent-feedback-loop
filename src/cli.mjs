import os from "node:os";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { doctor, install, pathsFor, uninstall } from "./index.mjs";
import { captureObservedSession, normalizeAssistantReferentEvent, normalizeHookEvent } from "./capture.mjs";
import { initializeControlStore, openControlStore } from "./control-store.mjs";
import { BlobKeyProvider, EncryptedBlobStore } from "./crypto-store.mjs";
import { detectFeedbackCandidate, feedbackSourceIdentity } from "./feedback-signal.mjs";
import { launchDetachedReviewer, recoverDueReviewers } from "./reviewer-launcher.mjs";
import { runReviewJob } from "./reviewer-runner.mjs";
import { resolveReviewerExecutable, runReviewerProvider } from "./reviewer-provider.mjs";
import { loadReflectionDocuments, selectReflections } from "./selector.mjs";
import { executeLegacyExport, inspectLegacyExport } from "./legacy-export.mjs";
import { executeGuardCli } from "./convergence-cli.mjs";
import { runConvergenceProbeJob } from "./convergence-probe-runner.mjs";
import { ensureRepositoryLineage } from "./convergence-identity.mjs";

const CLI_FILE = fileURLToPath(new URL("../bin/agent-feedback-loop.mjs", import.meta.url));

function optionValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function parseArgs(args) {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { command: "help", options: { home: os.homedir(), dryRun: false, removeFiles: false, help: true } };
  }
  const command = args[0] || "help";
  const options = { home: os.homedir(), dryRun: false, removeFiles: false, live: false, args: [], cli: null };
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--home") {
      options.home = args[++i];
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--remove-files") {
      options.removeFiles = true;
    } else if (arg === "--live") {
      options.live = true;
    } else if (arg === "--cli") {
      options.cli = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      options.args.push(arg);
    }
  }
  return { command, options };
}

function parseLegacyExportArgs(args) {
  let sourceDb = null;
  let outputDir = null;
  let dryRun = null;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--source-db" || argument === "--output-dir") {
      const value = args[index + 1];
      if (typeof value !== "string" || !value || value.startsWith("--")) {
        throw Object.assign(new Error("legacy_export_invalid_arguments"), { code: "legacy_export_invalid_arguments" });
      }
      if ((argument === "--source-db" && sourceDb !== null)
          || (argument === "--output-dir" && outputDir !== null)) {
        throw Object.assign(new Error("legacy_export_invalid_arguments"), { code: "legacy_export_invalid_arguments" });
      }
      if (argument === "--source-db") sourceDb = value;
      else outputDir = value;
      index += 1;
      continue;
    }
    if (argument === "--dry-run" || argument === "--apply") {
      if (dryRun !== null) {
        throw Object.assign(new Error("legacy_export_invalid_arguments"), { code: "legacy_export_invalid_arguments" });
      }
      dryRun = argument === "--dry-run";
      continue;
    }
    throw Object.assign(new Error("legacy_export_invalid_arguments"), { code: "legacy_export_invalid_arguments" });
  }
  if (sourceDb === null || outputDir === null || dryRun === null) {
    throw Object.assign(new Error("legacy_export_invalid_arguments"), { code: "legacy_export_invalid_arguments" });
  }
  return { sourceDb, outputDir, dryRun };
}

function parseLineageInitArgs(args) {
  let repoRoot = null;
  let apply = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--repo-root") {
      const value = args[index + 1];
      if (repoRoot !== null || typeof value !== "string" || !value || value.startsWith("--")) {
        throw Object.assign(new Error("lineage_invalid_arguments"), { code: "lineage_invalid_arguments" });
      }
      repoRoot = value;
      index += 1;
      continue;
    }
    if (argument === "--apply") {
      if (apply) {
        throw Object.assign(new Error("lineage_invalid_arguments"), { code: "lineage_invalid_arguments" });
      }
      apply = true;
      continue;
    }
    throw Object.assign(new Error("lineage_invalid_arguments"), { code: "lineage_invalid_arguments" });
  }
  if (repoRoot === null) {
    throw Object.assign(new Error("lineage_invalid_arguments"), { code: "lineage_invalid_arguments" });
  }
  if (!apply) {
    throw Object.assign(new Error("lineage_apply_required"), { code: "lineage_apply_required" });
  }
  return { repoRoot };
}

const LINEAGE_REPAIR_REQUIRED = new Set([
  "invalid_lineage_id",
  "lineage_not_owned",
  "unsafe_lineage_file",
  "unsafe_lineage_mode"
]);

async function executeLineageInitCli(args) {
  try {
    const { repoRoot } = parseLineageInitArgs(args);
    const lineage = await ensureRepositoryLineage({ repoRoot });
    return Object.freeze({
      payload: Object.freeze({
        status: "lineage_initialized",
        created: lineage.created,
        lineageDigest: createHash("sha256").update(lineage.lineageId, "utf8").digest("hex")
      }),
      exitCode: 0,
      stderrCode: null
    });
  } catch (error) {
    const code = boundedReason(error, "lineage_initialization_failed");
    const exitCode = code === "lineage_invalid_arguments"
      ? 2
      : code === "lineage_apply_required" || LINEAGE_REPAIR_REQUIRED.has(code)
        ? 5
        : 6;
    return Object.freeze({
      payload: Object.freeze({ error: code }),
      exitCode,
      stderrCode: code
    });
  }
}

const PROMPT_INPUT_MAX_BYTES = 2 * 1024 * 1024;
const REVIEW_LAUNCH_COOLDOWN_MS = 5_000;
const PROMPT_SELECTION_LIMITS = Object.freeze({
  maxFileBytes: 131_072,
  maxCards: 4,
  maxDocumentTokens: 320,
  maxTotalTokens: 900
});
const LOG_EVENTS = new Set([
  "prompt_capture_completed",
  "feedback_signal_evaluated",
  "review_job_created",
  "review_job_reused",
  "review_spawn_attempted",
  "review_job_claimed",
  "review_job_recovered",
  "review_failed",
  "review_completed_no_lesson",
  "reflection_published",
  "reflection_parse_omitted",
  "reflection_selected",
  "reflection_emitted",
  "recurrence_after_emission"
]);
const LOG_FIELDS = new Set(["event", "job", "document", "family", "reason", "count", "bytes", "tokens", "attempt", "lease_epoch", "duration_ms", "result"]);
const LOG_REASONS = new Set([
  "invalid_cutoff", "detector_failed", "identity_unstable", "capture_failed", "store_failed",
  "spawn_failed", "launch_failed", "recovery_failed", "selection_record_failed", "log_limit",
  "selection_failed", "response_failed", "emission_record_failed", "invalid_input", "hook_failed",
  "candidate", "not_candidate", "launch_reserved", "reserved", "terminal", "not_found", "cooldown",
  "not_due", "unsupported_platform", "provider_unavailable", "provider_timeout", "provider_invalid", "context_invalid",
  "lease_lost", "publication_failed", "publication_collision", "reviewer_failed"
]);
const LOG_RESULTS = new Set(["attempted", "reviewed_no_lesson", "published", "failed", "created", "reused", "selected", "emitted"]);
const LOG_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LOG_HASH = /^[a-f0-9]{64}$/u;
const LOG_MAX_INTEGER = 2_147_483_647;
const LAUNCH_FAILURE_REASONS = new Set(["spawn_failed", "unsupported_platform", "invalid_input"]);

function boundedReason(error, fallback) {
  const value = String(error?.code || "").toLowerCase();
  return /^[a-z0-9_.-]{1,64}$/.test(value) ? value : fallback;
}

function boundedSelectionReason(error) {
  const code = boundedReason(error, "");
  if (code) return code;
  const message = String(error?.message || "").toLowerCase();
  return /^[a-z0-9_.-]{1,64}$/.test(message) ? message : "selection_failed";
}

function opaqueLogValue(value, fallback) {
  const normalized = String(value ?? "");
  return /^[a-zA-Z0-9_.:-]{1,128}$/u.test(normalized) ? normalized : fallback;
}

function hashOpaque(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

export function structuredLog(event, fields = {}, writer = (line) => process.stderr.write(line)) {
  if (!LOG_EVENTS.has(event) || !fields || typeof fields !== "object" || Array.isArray(fields)) return false;
  const safe = { event };
  for (const [key, value] of Object.entries(fields)) {
    if (!LOG_FIELDS.has(key) || key === "event") continue;
    if (key === "job") {
      if (typeof value === "string" && LOG_UUID.test(value)) safe.job = value;
    } else if (key === "family") {
      if (typeof value === "string" && value) safe.family = LOG_HASH.test(value) ? value : hashOpaque(value);
    } else if (key === "document") {
      if (typeof value === "string" && value) safe.document = LOG_HASH.test(value) ? value : hashOpaque(value);
    } else if (key === "reason") {
      safe.reason = typeof value === "string" && LOG_REASONS.has(value) ? value : "invalid_reason_code";
    } else if (key === "result") {
      safe.result = typeof value === "string" && LOG_RESULTS.has(value) ? value : "invalid_result_code";
    } else if (Number.isSafeInteger(value) && value >= 0 && value <= LOG_MAX_INTEGER) {
      safe[key] = value;
    }
  }
  writer(`${JSON.stringify(safe)}\n`);
  return true;
}

function promptLog(event, fields = {}) {
  if (process.env.AGENT_FEEDBACK_LOOP_DEBUG !== "1") return;
  structuredLog(event, fields);
}

function launchFailureReason(value) {
  return LAUNCH_FAILURE_REASONS.has(value) ? value : "spawn_failed";
}

function cutoffIso(value) {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError("hook cutoff must be a valid timestamp");
  return parsed.toISOString();
}

function lowerOnlyLimit(value, hardLimit) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, hardLimit) : hardLimit;
}

async function readPromptInput(stream = process.stdin, maxBytes = PROMPT_INPUT_MAX_BYTES) {
  let input = "";
  let bytes = 0;
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    bytes += Buffer.byteLength(chunk, "utf8");
    if (bytes > maxBytes) throw new Error("prompt_input_too_large");
    input += chunk;
  }
  return input;
}

export async function writePromptResponse({ cli, response, writer }) {
  if (typeof cli !== "string" || !cli.trim() || cli.length > 64) {
    throw new TypeError("cli must be a bounded non-empty string");
  }
  if (typeof writer !== "function") throw new TypeError("writer must be a function");
  await writer(response);
}

export async function handlePromptHook({
  payload,
  cli,
  controlStore,
  blobs,
  launchReviewer = () => {},
  recoverReviewers = () => ({ scanned: 0, attempted: 0 }),
  writeResponse = async () => null,
  nativeResponse = { continue: true },
  nativeHookEventName = null,
  selectionLimits = {},
  loadDocuments = loadReflectionDocuments,
  selectDocuments = selectReflections,
  now = () => new Date()
}) {
  let selectionPublishedBefore;
  try {
    selectionPublishedBefore = cutoffIso(now());
  } catch (error) {
    selectionPublishedBefore = new Date().toISOString();
    promptLog("feedback_signal_evaluated", { reason: "invalid_cutoff" });
  }

  const result = {
    operationalText: null,
    selectionPublishedBefore,
    selectionInput: { publishedBefore: selectionPublishedBefore },
    candidate: false,
    reason: "not_candidate",
    jobId: null,
    launchRequested: false
  };
  const input = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : { prompt: String(payload ?? "") };
  const userText = String(input.prompt ?? input.text ?? "");
  let event = null;
  let signal = null;

  try {
    event = normalizeHookEvent({
      cli,
      payload: input,
      installationId: "default",
      capturePolicyRevision: 1
    });
    signal = await detectFeedbackCandidate({
      payload: { ...input, cli },
      userText,
      now: () => new Date(selectionPublishedBefore)
    });
    result.candidate = signal.candidate === true;
    result.reason = signal.candidate ? "candidate" : "not_candidate";
    promptLog("feedback_signal_evaluated", { reason: result.reason });
  } catch (error) {
    result.reason = "detector_failed";
    promptLog("feedback_signal_evaluated", { reason: "detector_failed" });
  }

  if (signal?.candidate && event?.identity_unstable) {
    result.candidate = false;
    result.reason = "identity_unstable";
    promptLog("feedback_signal_evaluated", { reason: "identity_unstable" });
  } else if (signal?.candidate && event) {
    let sourceCapture = null;
    let referentCapture = null;
    try {
      if (signal.referent) {
        const referentEvent = normalizeAssistantReferentEvent({
          cli,
          event,
          referent: signal.referent,
          installationId: "default",
          capturePolicyRevision: 1
        });
        referentCapture = await captureObservedSession({
          store: controlStore,
          blobs,
          event: referentEvent,
          rawText: signal.referent.text
        });
      }
      sourceCapture = await captureObservedSession({
        store: controlStore,
        blobs,
        event: {
          ...event,
          referent_event_uid: referentCapture?.eventUid ?? null
        },
        rawText: userText
      });
      if (sourceCapture) promptLog("prompt_capture_completed", { result: "created" });
    } catch (error) {
      result.reason = "capture_failed";
      promptLog("prompt_capture_completed", { reason: "capture_failed" });
    }

    if (sourceCapture) {
      let candidate = null;
      let reservation = null;
      try {
        const referentEventUid = referentCapture?.eventUid ?? null;
        candidate = controlStore.createReviewCandidate({
          sourceEventUid: sourceCapture.eventUid,
          referentEventUid,
          sourceIdentity: feedbackSourceIdentity({
            cli: event.cli,
            sessionUid: sourceCapture.eventView.session_uid,
            contextEpoch: event.context_epoch,
            sourceEventId: sourceCapture.eventView.source_event_id,
            referentEventUid: referentEventUid ?? "none"
          }),
          projectId: event.project_id
        });
        result.jobId = candidate.jobId;
        promptLog(candidate.created ? "review_job_created" : "review_job_reused", {
          job: candidate.jobId,
          result: candidate.created ? "created" : "reused"
        });
        reservation = controlStore.reserveReviewLaunch({
          jobId: candidate.jobId,
          cooldownMs: REVIEW_LAUNCH_COOLDOWN_MS
        });
      } catch (error) {
        result.reason = "store_failed";
        promptLog("review_job_created", { reason: "store_failed", job: candidate?.jobId });
      }

      if (candidate && reservation?.launch) {
        try {
          const launch = launchReviewer(candidate.jobId, reservation.launchEpoch);
          if (launch?.attempted !== false) {
            result.launchRequested = true;
            result.reason = "launch_reserved";
            promptLog("review_spawn_attempted", {
              job: candidate.jobId,
              lease_epoch: reservation.launchEpoch,
              result: "attempted"
            });
          } else {
            const reason = launchFailureReason(launch?.reason);
            controlStore.recordReviewLaunchFailure({
              jobId: candidate.jobId,
              launchEpoch: reservation.launchEpoch,
              reasonCode: reason
            });
            result.reason = reason;
            promptLog("review_spawn_attempted", {
              job: candidate.jobId,
              lease_epoch: reservation.launchEpoch,
              result: "failed",
              reason
            });
          }
        } catch (error) {
          try {
            controlStore.recordReviewLaunchFailure({
              jobId: candidate.jobId,
              launchEpoch: reservation.launchEpoch,
              reasonCode: "spawn_failed"
            });
          } catch {}
          result.reason = "spawn_failed";
          promptLog("review_spawn_attempted", { job: candidate.jobId, result: "failed", reason: "spawn_failed" });
        }
      } else if (candidate && reservation) {
        result.reason = reservation.reason;
        promptLog("review_spawn_attempted", { job: candidate.jobId, reason: reservation.reason });
      }
    }
  }

  // A failed durable capture means this synchronous entrypoint cannot safely
  // recover, select, or emit state that could contradict the failed write.
  if (result.reason === "capture_failed") {
    result.nativeResponse = { ...nativeResponse };
    try {
      await writePromptResponse({ cli, response: result.nativeResponse, writer: writeResponse });
      result.hostResponse = result.nativeResponse;
    } catch {
      result.hostResponse = null;
      result.reason = "response_failed";
      promptLog("reflection_emitted", { reason: "response_failed" });
    }
    return result;
  }

  try {
    recoverReviewers();
  } catch (error) {
    promptLog("review_job_recovered", { reason: "recovery_failed", job: result.jobId });
  }

  result.selectionInput = {
    publishedBefore: selectionPublishedBefore,
    projectDir: event?.cwd ?? event?.project_id ?? null,
    prompt: event?.redacted_text ?? userText,
    session: {
      sessionUid: event?.session_uid ?? null,
      contextEpoch: event?.context_epoch ?? null
    },
    task: {
      fingerprint: event?.task_fingerprint ?? null,
      taskType: event?.task_type ?? null,
      paths: event?.paths ?? [],
      tools: [...new Set([...(event?.tools ?? []), ...(event?.tool_refs ?? []), event?.tool_name].filter(Boolean))]
    },
    maxFileBytes: lowerOnlyLimit(selectionLimits.maxFileBytes, PROMPT_SELECTION_LIMITS.maxFileBytes)
  };
  const selectedEmissionIds = [];
  let priorEmissions = [];
  try {
    priorEmissions = controlStore.listPriorReflectionEmissions({
      sessionUid: result.selectionInput.session.sessionUid,
      contextEpoch: result.selectionInput.session.contextEpoch,
      taskFingerprint: result.selectionInput.task.fingerprint
    });
  } catch {
    promptLog("reflection_parse_omitted", { reason: "selection_record_failed" });
  }
  try {
    const catalog = await loadDocuments({
      projectDir: result.selectionInput.projectDir,
      publishedBefore: selectionPublishedBefore,
      maxFileBytes: result.selectionInput.maxFileBytes
    });
    const selection = selectDocuments({
      documents: catalog.documents,
      prompt: result.selectionInput.prompt,
      session: result.selectionInput.session,
      task: result.selectionInput.task,
      budget: {
        maxCards: lowerOnlyLimit(selectionLimits.maxCards, PROMPT_SELECTION_LIMITS.maxCards),
        maxDocumentTokens: lowerOnlyLimit(selectionLimits.maxDocumentTokens, PROMPT_SELECTION_LIMITS.maxDocumentTokens),
        maxTotalTokens: lowerOnlyLimit(selectionLimits.maxTotalTokens, PROMPT_SELECTION_LIMITS.maxTotalTokens)
      },
      priorEmissions,
      publishedBefore: selectionPublishedBefore
    });
    const selectionOmissions = [...catalog.omissions, ...selection.omissions];
    for (const item of selectionOmissions.slice(0, 8)) {
      promptLog("reflection_parse_omitted", { reason: item.reason, document: item.opaqueId ?? item.documentHash });
    }
    if (selectionOmissions.length > 8) promptLog("reflection_parse_omitted", { reason: "log_limit", count: selectionOmissions.length });
    result.guidance = selection.guidance;
    result.selection = {
      selectedCount: selection.selected.length,
      omissionCount: selectionOmissions.length,
      tokenEstimate: selection.tokenEstimate
    };
    for (const document of selection.selected) {
      try {
        selectedEmissionIds.push(controlStore.recordReflectionSelected({
          document,
          familyId: document.familyId,
          sessionUid: result.selectionInput.session.sessionUid,
          contextEpoch: result.selectionInput.session.contextEpoch,
          taskFingerprint: result.selectionInput.task.fingerprint
        }));
        promptLog("reflection_selected", { document: document.documentHash, family: document.familyId, result: "selected" });
      } catch {
        promptLog("reflection_parse_omitted", { reason: "selection_record_failed", document: document.documentHash });
      }
    }
  } catch (error) {
    promptLog("reflection_parse_omitted", { reason: "selection_failed" });
    result.guidance = "";
    result.selection = { selectedCount: 0, omissionCount: 0, tokenEstimate: 0 };
  }

  const hookEventName = opaqueLogValue(
    nativeHookEventName ?? input.hook_event_name ?? input.hookEventName,
    "UserPromptSubmit"
  );
  result.nativeResponse = result.guidance
    ? {
        ...nativeResponse,
        hookSpecificOutput: { hookEventName, additionalContext: result.guidance }
      }
    : { ...nativeResponse };
  let responseWritten = false;
  try {
    await writePromptResponse({ cli, response: result.nativeResponse, writer: writeResponse });
    responseWritten = true;
    result.hostResponse = result.nativeResponse;
  } catch (error) {
    result.hostResponse = null;
    result.reason = "response_failed";
    promptLog("reflection_emitted", { reason: "response_failed" });
  }
  if (responseWritten) {
    for (const emissionId of selectedEmissionIds) {
      try {
        controlStore.markReflectionEmitted({ emissionId });
        promptLog("reflection_emitted", { result: "emitted" });
      } catch {
        promptLog("reflection_emitted", { reason: "emission_record_failed" });
      }
    }
  }
  return result;
}

function printHelp() {
  console.log(`agent-feedback-loop

Usage:
  agent-feedback-loop install [--home <path>] [--dry-run]
  agent-feedback-loop uninstall [--home <path>] [--dry-run] [--remove-files]
  agent-feedback-loop doctor [--home <path>]
  agent-feedback-loop doctor --live [--home <path>]
  agent-feedback-loop legacy-export --source-db <absolute-path> --output-dir <absolute-path> --dry-run|--apply
  agent-feedback-loop lineage-init --repo-root <path> --apply
  agent-feedback-loop paths [--home <path>]
`);
}

function printActions(result, title) {
  console.log(title);
  for (const action of result.actions) {
    console.log(`- ${action}`);
  }
}

export function reviewerTerminalLog({ outcome, job, reason = "reviewer_failed", durationMs, writer } = {}) {
  const fields = { job, duration_ms: durationMs };
  if (outcome === "published") {
    return structuredLog("reflection_published", { ...fields, result: "published" }, writer);
  }
  if (outcome === "reviewed_no_lesson") {
    return structuredLog("review_completed_no_lesson", { ...fields, result: "reviewed_no_lesson" }, writer);
  }
  return structuredLog("review_failed", { ...fields, result: "failed", reason }, writer);
}

async function executeConvergenceProbeRun({ home, taskUid, fingerprint }) {
  const paths = pathsFor(home);
  const store = openControlStore({ paths });
  try {
    const providerName = "codex";
    const executable = await resolveReviewerExecutable({ cli: providerName, env: process.env });
    await runConvergenceProbeJob({
      store,
      taskUid,
      fingerprint,
      ownerId: `probe-${process.pid}`,
      provider: (context, { resultKind }) => runReviewerProvider({
        cli: providerName,
        executable,
        context,
        resultKind,
        policyFile: paths.geminiReviewerPolicy,
        geminiSettingsFile: paths.geminiReviewerSettings,
        env: process.env
      })
    });
  } finally {
    store.close();
  }
}

export async function main(args, {
  runConvergenceProbeCommand = executeConvergenceProbeRun
} = {}) {
  if (args[0] === "lineage-init") {
    const machine = await executeLineageInitCli(args);
    process.stdout.write(`${JSON.stringify(machine.payload)}\n`);
    if (machine.stderrCode !== null) process.stderr.write(`${machine.stderrCode}\n`);
    if (machine.exitCode !== 0) process.exitCode = machine.exitCode;
    return;
  }
  if (args[0] === "guard") {
    const machine = await executeGuardCli(args.slice(1));
    process.stdout.write(`${JSON.stringify(machine.payload)}\n`);
    if (machine.stderrCode !== null) process.stderr.write(`${machine.stderrCode}\n`);
    if (machine.exitCode !== 0) process.exitCode = machine.exitCode;
    return;
  }
  if (args[0] === "legacy-export") {
    let explicit;
    try {
      explicit = parseLegacyExportArgs(args);
      const plan = await inspectLegacyExport({
        sourceDb: explicit.sourceDb,
        outputDir: explicit.outputDir
      });
      const counts = await executeLegacyExport({ plan, dryRun: explicit.dryRun });
      console.log(JSON.stringify({
        status: explicit.dryRun ? "dry_run" : "applied",
        counts,
        items: plan.items
      }));
      return;
    } catch (error) {
      const code = boundedReason(error, "legacy_export_failed");
      throw Object.assign(new Error(code), { code });
    }
  }
  const { command, options } = parseArgs(args);
  if (options.help || command === "help") {
    printHelp();
    return;
  }
  if (command === "install") {
    const result = await install(options);
    printActions(result, result.dryRun ? "agent-feedback-loop install dry-run" : "agent-feedback-loop installed");
    return;
  }
  if (command === "uninstall") {
    const result = await uninstall(options);
    printActions(result, result.dryRun ? "agent-feedback-loop uninstall dry-run" : "agent-feedback-loop uninstalled");
    return;
  }
  if (command === "doctor") {
    const result = await doctor(options);
    if (options.live) {
      const tempHome = await mkdtemp(path.join(tmpdir(), "afl-live-doctor-"));
      try {
        const livePaths = pathsFor(tempHome);
        const liveStore = initializeControlStore({ paths: livePaths });
        liveStore.close();
        const configuredPaths = pathsFor(options.home);
        const configuredStore = openControlStore({ paths: configuredPaths });
        const configuredBlobs = new EncryptedBlobStore({ root: configuredPaths.blobRoot, keyProvider: new BlobKeyProvider({ keyRoot: configuredPaths.keyRoot }) });
        const canaryHash = "f".repeat(64);
        const canaryFile = await configuredBlobs.write(canaryHash, "synthetic-canary");
        const canaryText = await configuredBlobs.read(canaryFile);
        await configuredBlobs.remove(canaryHash);
        configuredStore.close();
        if (canaryText !== "synthetic-canary") throw new Error("configured encryption canary mismatch");
        result.status.controlStore.live = {
          status: "healthy",
          syntheticExcluded: true,
          configuredStore: "healthy",
          encryption: "healthy"
        };
      } catch (error) {
        result.status.controlStore.live = { status: "unhealthy", reason: "canary_failed" };
        result.status.ready = false;
      } finally {
        await rm(tempHome, { recursive: true, force: true });
      }
    }
    console.log(result.status.ready ? "agent-feedback-loop healthy" : "agent-feedback-loop unhealthy");
    console.log(JSON.stringify(result, null, 2));
    if (!result.status.ready) process.exitCode = 1;
    return;
  }
  if (command === "paths") {
    console.log(JSON.stringify(pathsFor(options.home), null, 2));
    return;
  }
  if (command === "convergence-probe-run") {
    await runConvergenceProbeCommand({
      home: options.home,
      taskUid: optionValue(options.args, "--task-uid"),
      fingerprint: optionValue(options.args, "--fingerprint")
    });
    return;
  }
  if (command === "reviewer-run") {
    const paths = pathsFor(options.home);
    const store = openControlStore({ paths });
    const blobs = new EncryptedBlobStore({
      root: paths.blobRoot,
      keyProvider: new BlobKeyProvider({ keyRoot: paths.keyRoot })
    });
    const jobId = optionValue(options.args, "--job-id");
    const ownerId = `reviewer-${process.pid}`;
    const startedAt = Date.now();
    let providerName = "unknown";
    try {
      const storedContext = store.getReviewContext({ jobId, priorLimit: 0, followingLimit: 0 });
      providerName = storedContext?.source?.source_provider ?? "unknown";
      const projectDir = storedContext?.job?.project_id ?? null;
      const executable = await resolveReviewerExecutable({ cli: providerName, env: process.env });
      const timeoutMs = Number(optionValue(options.args, "--timeout-ms", process.env.AGENT_FEEDBACK_LOOP_REVIEWER_TIMEOUT_MS || 180_000));
      const result = await runReviewJob({
        jobId,
        ownerId,
        store,
        blobs,
        projectDir,
        provider: (context) => runReviewerProvider({
            cli: providerName,
            executable,
            context,
            promptFile: paths.promptFile,
            schemaFile: paths.reviewerSchema,
            policyFile: paths.geminiReviewerPolicy,
            geminiSettingsFile: paths.geminiReviewerSettings,
            timeoutMs,
            env: process.env
          })
      });
      reviewerTerminalLog({
        outcome: result.outcome,
        job: jobId,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      reviewerTerminalLog({
        job: jobId,
        reason: boundedReason(error, "reviewer_failed"),
        durationMs: Date.now() - startedAt
      });
      throw error;
    } finally {
      store.close();
    }
    return;
  }
  if (command === "hook") {
    const cli = options.cli || options.args[0] || "unknown";
    const nativeHookEventName = optionValue(args, "--event", "UserPromptSubmit");
    const withContinue = options.args.includes("--continue");
    const nativeResponse = withContinue ? { continue: true } : {};
    let responseWritten = false;
    const writeResponse = async (response = nativeResponse) => {
      if (!responseWritten) console.log(JSON.stringify(response));
      responseWritten = true;
      return response;
    };
    let rawPayload;
    let payload;
    try {
      rawPayload = await readPromptInput();
      payload = JSON.parse(rawPayload || "{}");
    } catch (error) {
      promptLog("feedback_signal_evaluated", { reason: "invalid_input" });
      await writeResponse();
      return;
    }

    const paths = pathsFor(options.home);
    let controlStore = null;
    try {
      controlStore = openControlStore({ paths, busyTimeoutMs: 250 });
      const blobs = new EncryptedBlobStore({
        root: paths.blobRoot,
        keyProvider: new BlobKeyProvider({ keyRoot: paths.keyRoot })
      });
      await handlePromptHook({
        payload,
        cli,
        controlStore,
        blobs,
        launchReviewer(jobId, launchEpoch) {
          return launchDetachedReviewer({
            platform: process.platform,
            nodeExecutable: process.execPath,
            cliFile: CLI_FILE,
            home: paths.home,
            jobId,
            launchEpoch,
            env: process.env
          });
        },
        recoverReviewers() {
          return recoverDueReviewers({
            store: controlStore,
            limit: 1,
            launchReviewer(jobId, launchEpoch) {
              return launchDetachedReviewer({
                platform: process.platform,
                nodeExecutable: process.execPath,
                cliFile: CLI_FILE,
                home: paths.home,
                jobId,
                launchEpoch,
                env: process.env
              });
            }
          });
        },
        writeResponse,
        nativeResponse,
        nativeHookEventName,
        now: () => new Date()
      });
    } catch (error) {
      promptLog("feedback_signal_evaluated", { reason: "hook_failed" });
      await writeResponse();
    } finally {
      controlStore?.close();
    }
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
