import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { doctor, install, pathsFor, uninstall } from "./index.mjs";
import { captureObservedSession, normalizeAssistantReferentEvent, normalizeHookEvent } from "./capture.mjs";
import { openControlStore } from "./control-store.mjs";
import { BlobKeyProvider, EncryptedBlobStore } from "./crypto-store.mjs";
import { detectFeedbackCandidate, feedbackSourceIdentity } from "./feedback-signal.mjs";
import { openStore } from "./store.mjs";
import { ReviewerRunner } from "./reviewer-runner.mjs";
import { resolveReviewerExecutable, runReviewerProvider } from "./reviewer-provider.mjs";

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

const PROMPT_INPUT_MAX_BYTES = 2 * 1024 * 1024;
const REVIEW_LAUNCH_COOLDOWN_MS = 5_000;

function boundedReason(error, fallback) {
  const value = String(error?.code || "").toLowerCase();
  return /^[a-z0-9_.-]{1,64}$/.test(value) ? value : fallback;
}

function promptDebug(stage, reason, opaqueId = null) {
  if (process.env.AGENT_FEEDBACK_LOOP_DEBUG !== "1") return;
  const safeStage = /^[a-z0-9_.-]{1,48}$/.test(String(stage)) ? String(stage) : "unknown";
  const safeReason = /^[a-z0-9_.-]{1,64}$/.test(String(reason)) ? String(reason) : "unknown";
  const safeId = /^[a-zA-Z0-9_.:-]{1,128}$/.test(String(opaqueId || "")) ? String(opaqueId) : "none";
  console.error(`agent-feedback-loop: hook.stage=${safeStage} reason=${safeReason} id=${safeId}`);
}

function cutoffIso(value) {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError("hook cutoff must be a valid timestamp");
  return parsed.toISOString();
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

export async function handlePromptHook({
  payload,
  cli,
  controlStore,
  legacyMemoryStore = null,
  blobs,
  launchReviewer = () => {},
  writeResponse = async () => null,
  now = () => new Date()
}) {
  let selectionPublishedBefore;
  try {
    selectionPublishedBefore = cutoffIso(now());
  } catch (error) {
    selectionPublishedBefore = new Date().toISOString();
    promptDebug("cutoff", boundedReason(error, "invalid_cutoff"));
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
  } catch (error) {
    result.reason = "detector_failed";
    promptDebug("detector", boundedReason(error, "detector_failed"));
  }

  if (signal?.candidate && event?.identity_unstable) {
    result.candidate = false;
    result.reason = "identity_unstable";
    promptDebug("candidate", "identity_unstable");
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
    } catch (error) {
      result.reason = "capture_failed";
      promptDebug("capture", boundedReason(error, "capture_failed"));
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
        reservation = controlStore.reserveReviewLaunch({
          jobId: candidate.jobId,
          cooldownMs: REVIEW_LAUNCH_COOLDOWN_MS
        });
      } catch (error) {
        result.reason = "store_failed";
        promptDebug("store", boundedReason(error, "store_failed"), candidate?.jobId);
      }

      if (candidate && reservation?.launch) {
        try {
          const ignored = launchReviewer(candidate.jobId, reservation.launchEpoch);
          if (ignored && typeof ignored.catch === "function") void ignored.catch(() => {});
          result.launchRequested = true;
          result.reason = "launch_reserved";
        } catch (error) {
          result.reason = "launch_failed";
          promptDebug("launch", boundedReason(error, "launch_failed"), candidate.jobId);
        }
      } else if (candidate && reservation) {
        result.reason = reservation.reason;
      }
    }
  }

  result.selectionInput = {
    publishedBefore: selectionPublishedBefore,
    projectId: event?.project_id ?? null,
    sessionUid: event?.session_uid ?? null,
    contextEpoch: event?.context_epoch ?? null
  };
  try {
    if (legacyMemoryStore && typeof legacyMemoryStore.selectLessons === "function") {
      legacyMemoryStore.selectLessons({ projectId: event?.project_id ?? null });
    }
  } catch (error) {
    promptDebug("selection", boundedReason(error, "selection_failed"));
  }

  try {
    result.hostResponse = await writeResponse(result);
  } catch (error) {
    result.hostResponse = null;
    result.reason = "response_failed";
    promptDebug("response", boundedReason(error, "response_failed"));
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
  agent-feedback-loop memory list|show [--home <path>]
  agent-feedback-loop memory explain <session-id> [--verbose] [--home <path>]
  agent-feedback-loop memory promote <lesson-id> [project-id] [--home <path>]
  agent-feedback-loop capture status|on|off [--home <path>]
  agent-feedback-loop gc status|run [--home <path>]
  agent-feedback-loop reviewer-context --job-id <id> [--home <path>]
  agent-feedback-loop paths [--home <path>]
`);
}

function printActions(result, title) {
  console.log(title);
  for (const action of result.actions) {
    console.log(`- ${action}`);
  }
}

export async function main(args) {
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
        const liveStore = openStore({ paths: livePaths });
        liveStore.setCapturePolicy({ enabled: true, revision: 1 });
        liveStore.captureSessionEvent({ event_uid: "synthetic:doctor", session_uid: "synthetic:doctor", event_seq: 1, context_epoch: 1, project_id: "synthetic_canary", role: "system", redacted_text: "synthetic", content_hash: "synthetic", capture_policy_revision: 1, data_class: "synthetic_canary" });
        liveStore.close();
        const configuredPaths = pathsFor(options.home);
        const configuredStore = openStore({ paths: configuredPaths });
        const configuredBlobs = new EncryptedBlobStore({ root: configuredPaths.blobRoot, keyProvider: new BlobKeyProvider({ keyRoot: configuredPaths.keyRoot }) });
        const canaryHash = "f".repeat(64);
        const canaryFile = await configuredBlobs.write(canaryHash, "synthetic-canary");
        const canaryText = await configuredBlobs.read(canaryFile);
        await configuredBlobs.remove(canaryHash);
        configuredStore.close();
        if (canaryText !== "synthetic-canary") throw new Error("configured encryption canary mismatch");
        result.live = { status: "healthy", syntheticExcluded: true, configuredStore: "healthy", encryption: "healthy" };
        result.capability.status = "healthy";
        result.capability.reason = "isolated SQLite synthetic canary passed";
      } catch (error) {
        result.live = { status: "unhealthy", reason: error.message };
        result.healthy = false;
      } finally {
        await rm(tempHome, { recursive: true, force: true });
      }
    }
    console.log(result.healthy ? "agent-feedback-loop healthy" : "agent-feedback-loop unhealthy");
    console.log(JSON.stringify(result, null, 2));
    if (!result.healthy) process.exitCode = 1;
    return;
  }
  if (command === "paths") {
    console.log(JSON.stringify(pathsFor(options.home), null, 2));
    return;
  }
  if (command === "reviewer-run") {
    const paths = pathsFor(options.home);
    const store = openStore({ paths });
    const runner = new ReviewerRunner({ store, mode: "isolated_cli_process" });
    const jobId = optionValue(options.args, "--job-id");
    try {
      const provider = optionValue(options.args, "--provider");
      const commandPath = optionValue(options.args, "--command", process.env.AGENT_FEEDBACK_LOOP_REVIEWER_COMMAND);
      const argsJson = optionValue(options.args, "--args-json", process.env.AGENT_FEEDBACK_LOOP_REVIEWER_ARGS_JSON || "[]");
      if (!provider && !commandPath) throw new Error("reviewer command or provider is not configured");
      const executable = provider ? await resolveReviewerExecutable({ cli: provider, env: process.env }) : null;
      if (provider && !executable) throw new Error(`reviewer provider executable is unavailable: ${provider}`);
      const timeoutMs = Number(optionValue(options.args, "--timeout-ms", process.env.AGENT_FEEDBACK_LOOP_REVIEWER_TIMEOUT_MS || 180_000));
      console.error(`agent-feedback-loop: ${new Date().toISOString()} reviewer.job.start job=${jobId || "unknown"} provider=${provider || "command"}`);
      const result = await runner.runJob({
        jobId,
        ownerId: `reviewer-${process.pid}`,
        command: commandPath,
        args: JSON.parse(argsJson),
        cwd: paths.dataRoot,
        timeoutMs,
        contextRoot: path.join(paths.dataRoot, "reviewer-contexts"),
        promptFile: paths.promptFile,
        review: provider
          ? ({ contextFile, promptFile, cwd, env }) => runReviewerProvider({
            cli: provider,
            executable,
            contextFile,
            promptFile,
            schemaFile: paths.reviewerSchema,
            policyFile: paths.geminiReviewerPolicy,
            geminiSettingsFile: paths.geminiReviewerSettings,
            cwd,
            timeoutMs,
            env
          })
          : null
      });
      console.error(`agent-feedback-loop: ${new Date().toISOString()} reviewer.job.complete job=${jobId || "unknown"} status=${result.status} lessons=${Number(result.lessonCount || 0)}`);
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(`agent-feedback-loop: ${new Date().toISOString()} reviewer.job.failed job=${jobId || "unknown"} reason=${error.code || error.name || "reviewer_failed"}`);
      throw error;
    } finally {
      store.close();
    }
    return;
  }
  if (command === "reviewer-context") {
    const paths = pathsFor(options.home);
    const store = openStore({ paths });
    try {
      console.log(JSON.stringify(store.getReviewerContext(optionValue(options.args, "--job-id")), null, 2));
    } finally {
      store.close();
    }
    return;
  }
  if (command === "memory" || command === "capture" || command === "gc") {
    const paths = pathsFor(options.home);
    const store = openStore({ paths });
    try {
      if (command === "memory") {
        const action = options.args[0] || "list";
        if (action === "promote") {
          const promoted = store.promoteLesson({ lessonId: options.args[1], projectId: options.args[2] || null });
          console.log(JSON.stringify({ command, action, lesson: promoted }, null, 2));
        } else if (action === "explain") {
          const reference = options.args[1];
          if (!reference) throw new Error("memory explain requires a session id");
          const trace = store.explainMemory(reference);
          if (!trace) throw new Error(`feedback memory session not found: ${reference}`);
          const outputTrace = options.args.includes("--verbose") ? trace : { ...trace };
          if (!options.args.includes("--verbose")) delete outputTrace.events;
          console.log(JSON.stringify({ command, action, trace: outputTrace }, null, 2));
        } else {
          const rows = store.selectLessons({ projectId: action === "list" ? (options.args[1] || null) : null });
          console.log(JSON.stringify({ command, action, lessons: rows }, null, 2));
        }
      } else if (command === "capture") {
        const action = options.args[0] || "status";
        const current = action === "on" || action === "off"
          ? store.setCapturePolicy({ enabled: action === "on", revision: Date.now() })
          : store.getCapturePolicy();
        console.log(JSON.stringify({ command, action: options.args[0] || "status", policy: current }, null, 2));
      } else {
        const action = options.args[0] || "status";
        if (action === "run") {
          const days = Number(process.env.AGENT_FEEDBACK_LOOP_RETENTION_DAYS || 10);
          const beforeMs = Date.now() - days * 24 * 60 * 60 * 1000;
          const result = store.gcExpired({ beforeMs });
          const blobs = new EncryptedBlobStore({ root: paths.blobRoot, keyProvider: new BlobKeyProvider({ keyRoot: paths.keyRoot }) });
          const removedBlobs = await blobs.pruneUnreferenced(store.listEncryptedRawRefs(), { beforeMs });
          console.log(JSON.stringify({ command, action, retentionDays: days, status: "completed", ...result, removedBlobCount: removedBlobs.length }, null, 2));
        } else {
          console.log(JSON.stringify({ command, action, status: "ready", retentionDays: Number(process.env.AGENT_FEEDBACK_LOOP_RETENTION_DAYS || 10) }, null, 2));
        }
      }
    } finally {
      store.close();
    }
    return;
  }
  if (command === "hook") {
    const cli = options.cli || options.args[0] || "unknown";
    const withContinue = options.args.includes("--continue");
    const nativeResponse = withContinue ? { continue: true } : {};
    let responseWritten = false;
    const writeResponse = async () => {
      if (!responseWritten) console.log(JSON.stringify(nativeResponse));
      responseWritten = true;
      return nativeResponse;
    };
    let rawPayload;
    let payload;
    try {
      rawPayload = await readPromptInput();
      payload = JSON.parse(rawPayload || "{}");
    } catch (error) {
      promptDebug("input", boundedReason(error, "invalid_input"));
      await writeResponse();
      return;
    }

    const paths = pathsFor(options.home);
    let controlStore = null;
    try {
      controlStore = openControlStore({ paths });
      const blobs = new EncryptedBlobStore({
        root: paths.blobRoot,
        keyProvider: new BlobKeyProvider({ keyRoot: paths.keyRoot })
      });
      await handlePromptHook({
        payload,
        cli,
        controlStore,
        legacyMemoryStore: null,
        blobs,
        launchReviewer(jobId) {
          promptDebug("launch", "runner_transition", jobId);
          return { launched: false, reason: "runner_transition" };
        },
        writeResponse,
        now: () => new Date()
      });
    } catch (error) {
      promptDebug("hook", boundedReason(error, "hook_failed"));
      await writeResponse();
    } finally {
      controlStore?.close();
    }
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
