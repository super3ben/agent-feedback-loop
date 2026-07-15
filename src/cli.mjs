import os from "node:os";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { doctor, install, pathsFor, uninstall } from "./index.mjs";
import { captureObservedSession, detectStructuralFeedbackSignal, extractTranscriptExcerpt, hasCaptureEvidence, normalizeHookEvent, normalizeStopEvent } from "./capture.mjs";
import { discoverCodexTranscriptCandidates, reconcileCodexTranscripts } from "./codex-reconcile.mjs";
import { BlobKeyProvider, EncryptedBlobStore } from "./crypto-store.mjs";
import { openStore } from "./store.mjs";
import { ReviewerRunner } from "./reviewer-runner.mjs";
import { resolveReviewerExecutable, runReviewerProvider } from "./reviewer-provider.mjs";
import { readSecureReceipt } from "./reviewer-auth.mjs";
import { detectReceiptLanguage, renderReceiptControl, renderReceiptInstruction } from "./receipt.mjs";
import { selectLessons } from "./selector.mjs";

function optionValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function debugLog(message) {
  if (process.env.AGENT_FEEDBACK_LOOP_DEBUG === "1") console.error(`agent-feedback-loop: ${new Date().toISOString()} ${message}`);
}

function receiptLog(message) {
  console.error(`agent-feedback-loop: ${new Date().toISOString()} ${message}`);
}

function logCreatedNotifications(notifications) {
  for (const notification of notifications || []) {
    const sessionHash = createHash("sha256").update(String(notification.session_uid)).digest("hex").slice(0, 12);
    receiptLog(`receipt.outbox.created notification=${notification.notification_id} kind=${notification.kind} session=${sessionHash}`);
  }
}

function stopResponse(cli, result) {
  if (result.action !== "block") return cli === "codex" ? { continue: true } : {};
  const reason = `Output this receipt verbatim before stopping:\n${renderReceiptControl(result.notification).text}`;
  return cli === "gemini"
    ? { decision: "deny", reason }
    : { decision: "block", reason };
}

async function runRetentionMaintenance({ store, blobs }) {
  const retentionDays = Number(process.env.AGENT_FEEDBACK_LOOP_RETENTION_DAYS || 10);
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return { status: "disabled" };
  const previous = store.getRuntimeStatus("retention_gc");
  const previousAt = Date.parse(previous?.updatedAt || "");
  if (Number.isFinite(previousAt) && Date.now() - previousAt < 24 * 60 * 60 * 1000) {
    return { status: "not_due", previousAt: previous.updatedAt };
  }
  const beforeMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const gc = store.gcExpired({ beforeMs });
  const prunedBlobs = gc.eventCount > 0
    ? await blobs.pruneUnreferenced(store.listEncryptedRawRefs(), { beforeMs })
    : [];
  const result = { status: "completed", retentionDays, eventCount: gc.eventCount, jobCount: gc.jobCount, prunedBlobCount: prunedBlobs.length };
  store.setRuntimeStatus("retention_gc", result);
  return result;
}

async function rotateManagedLog(logFile, maxBytes = Number(process.env.AGENT_FEEDBACK_LOOP_MAX_LOG_BYTES || 5 * 1024 * 1024)) {
  if (!logFile || logFile === "/dev/null") return false;
  let info;
  try { info = await lstat(logFile); } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("managed log must be a regular non-symlink file");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("managed log must be owned by the current user");
  if (info.size <= Math.max(256 * 1024, Number(maxBytes) || 5 * 1024 * 1024)) return false;
  const rotated = `${logFile}.1`;
  await rm(rotated, { force: true });
  await rename(logFile, rotated);
  return true;
}

async function readOwnedFileTail(file, maxBytes = 128 * 1024) {
  const linkInfo = await lstat(file);
  if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) throw new Error("transcript must be a regular non-symlink file");
  if (typeof process.getuid === "function" && linkInfo.uid !== process.getuid()) throw new Error("transcript must be owned by the current user");
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== linkInfo.dev || info.ino !== linkInfo.ino) throw new Error("transcript changed while opening");
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("transcript must be owned by the current user");
    const length = Math.min(Math.max(0, Number(maxBytes) || 0), info.size);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, info.size - length));
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function openRuntimeLog(paths) {
  const logFile = process.env.AGENT_FEEDBACK_LOOP_LOG || path.join(paths.dataRoot, "logs", "runtime.log");
  if (logFile !== "/dev/null") {
    await mkdir(path.dirname(logFile), { recursive: true, mode: 0o700 });
    await rotateManagedLog(logFile);
    try {
      const info = await lstat(logFile);
      if (info.isSymbolicLink()) throw new Error("runtime log must not be a symlink");
      if (!info.isFile()) throw new Error("runtime log must be a regular file");
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("runtime log must be owned by the current user");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const handle = await open(logFile, "a", 0o600);
  if (logFile !== "/dev/null") await chmod(logFile, 0o600);
  return handle;
}

export async function runReconcileDaemon(options) {
  const paths = pathsFor(options.home);
  const intervalMs = Math.max(30_000, Number(process.env.AGENT_FEEDBACK_LOOP_RECONCILE_INTERVAL || 60) * 1_000);
  const killGraceMs = Math.max(100, Number(process.env.AGENT_FEEDBACK_LOOP_RECONCILE_KILL_GRACE_MS || 2_000));
  const groupIsolated = process.platform !== "win32";
  let stopping = false;
  let activeChild = null;
  let hardKillTimer = null;
  let wakeSleep = null;
  const signalChild = (signal) => {
    if (!activeChild) return;
    try {
      if (groupIsolated && activeChild.pid) process.kill(-activeChild.pid, signal);
      else activeChild.kill(signal);
    } catch (error) {
      if (error.code !== "ESRCH") debugLog(`reconcile.daemon.signal_failed signal=${signal} reason=${error.message}`);
    }
  };
  const stop = () => {
    stopping = true;
    if (wakeSleep) wakeSleep();
    if (activeChild && !hardKillTimer) {
      signalChild("SIGTERM");
      hardKillTimer = setTimeout(() => {
        if (!activeChild) return;
        debugLog(`reconcile.daemon.force_kill pid=${activeChild.pid || "unknown"}`);
        signalChild("SIGKILL");
      }, killGraceMs);
    }
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!stopping) {
      if (await rotateManagedLog(paths.reconcileLog)) return;
      const exit = await new Promise((resolve) => {
        const child = spawn(paths.runtimeLauncher, ["reconcile", "--home", paths.home, "--scheduled"], {
          cwd: paths.dataRoot,
          stdio: "inherit",
          env: process.env,
          detached: groupIsolated
        });
        activeChild = child;
        child.once("error", (error) => resolve({ code: null, error }));
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      if (hardKillTimer) clearTimeout(hardKillTimer);
      hardKillTimer = null;
      activeChild = null;
      if (exit.error) debugLog(`reconcile.daemon.child_error code=${exit.error.code || "spawn_failed"} reason=${exit.error.message}`);
      else if (exit.code !== 0) debugLog(`reconcile.daemon.child_exit code=${exit.code ?? exit.signal}`);
      if (stopping) break;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        wakeSleep = () => { clearTimeout(timer); resolve(); };
      });
      wakeSleep = null;
    }
  } finally {
    if (hardKillTimer) clearTimeout(hardKillTimer);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
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
  agent-feedback-loop reconcile [--home <path>]
  agent-feedback-loop reconcile-daemon [--home <path>]
  agent-feedback-loop reviewer-context --job-id <id> [--home <path>]
  agent-feedback-loop reviewer-submit --job-id <id> --receipt-file <path> [--home <path>]
  agent-feedback-loop paths [--home <path>]
`);
}

async function launchDetachedReviewer({ paths, cli, jobId }) {
  const explicitCommand = process.env.AGENT_FEEDBACK_LOOP_REVIEWER_COMMAND;
  if (!explicitCommand) {
    const executable = await resolveReviewerExecutable({ cli, env: process.env });
    if (!executable) {
      debugLog(`reviewer.unavailable cli=${cli} job=${jobId}`);
      return { launched: false, mode: "unavailable", reason: "provider_executable_unavailable" };
    }
  }
  const reviewerArgs = [
    "reviewer-run",
    "--home", paths.home,
    "--job-id", jobId,
    ...(explicitCommand
      ? [
        "--command", explicitCommand,
        "--args-json", process.env.AGENT_FEEDBACK_LOOP_REVIEWER_ARGS_JSON || "[]"
      ]
      : ["--provider", cli]),
    "--timeout-ms", process.env.AGENT_FEEDBACK_LOOP_REVIEWER_TIMEOUT_MS || "180000"
  ];
  const logHandle = await openRuntimeLog(paths);
  try {
    const child = spawn(process.execPath, [process.argv[1], ...reviewerArgs], {
      cwd: paths.dataRoot,
      detached: true,
      stdio: ["ignore", "ignore", logHandle.fd],
      env: process.env
    });
    child.unref();
    debugLog(`reviewer.launch cli=${cli} job=${jobId} mode=${explicitCommand ? "explicit_process" : "isolated_cli_process"} pid=${child.pid}`);
    return { launched: true, pid: child.pid, mode: explicitCommand ? "explicit_process" : "isolated_cli_process" };
  } finally {
    await logHandle.close();
  }
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
  if (command === "reconcile") {
    const paths = pathsFor(options.home);
    const store = openStore({ paths });
    const ownerId = `reconcile-${process.pid}-${Date.now()}`;
    const lease = store.claimWorkerLease({ name: "codex_reconcile", ownerId, leaseMs: 120_000 });
    if (!lease.acquired) {
      debugLog(`reconcile.skipped reason=lease_held owner=${lease.ownerId}`);
      store.close();
      console.log(JSON.stringify({ status: "skipped", reason: "lease_held", leaseUntil: lease.leaseUntil }));
      return;
    }
    try {
      const lookbackSeconds = Number(process.env.AGENT_FEEDBACK_LOOP_RECONCILE_LOOKBACK || 900);
      const candidates = await discoverCodexTranscriptCandidates({
        home: options.home,
        nowMs: Date.now(),
        lookbackMs: (Number.isFinite(lookbackSeconds) && lookbackSeconds > 0 ? lookbackSeconds : 900) * 1000,
        trackedCursors: store.listTranscriptCursors("codex")
      });
      const blobs = new EncryptedBlobStore({ root: paths.blobRoot, keyProvider: new BlobKeyProvider({ keyRoot: paths.keyRoot }) });
      const result = await reconcileCodexTranscripts({
        store,
        blobs,
        candidates,
        reviewMinEntries: Number(process.env.AGENT_FEEDBACK_LOOP_REVIEW_MIN_ENTRIES || 3),
        reviewMaxEntries: Number(process.env.AGENT_FEEDBACK_LOOP_REVIEW_BATCH_MAX || 24),
        reviewMaxAgeMs: Number(process.env.AGENT_FEEDBACK_LOOP_REVIEW_MAX_AGE || 3_600) * 1000,
        reviewCooldownMs: Number(process.env.AGENT_FEEDBACK_LOOP_REVIEW_COOLDOWN || 900) * 1000,
        wakeCooldownMs: Number(process.env.AGENT_FEEDBACK_LOOP_REVIEW_WAKE_COOLDOWN || 300) * 1000,
        reviewMaxAttempts: Number(process.env.AGENT_FEEDBACK_LOOP_REVIEW_MAX_ATTEMPTS || 3),
        launchReviewer: ({ cli, jobId }) => launchDetachedReviewer({ paths, cli, jobId })
      });
      logCreatedNotifications(result.notificationRefs);
      const maintenance = await runRetentionMaintenance({ store, blobs });
      store.setRuntimeStatus("codex_reconcile", {
        status: result.errors.length > 0 ? "completed_with_errors" : "completed",
        candidates: candidates.length,
        filesScanned: result.filesScanned,
        filesSkipped: result.filesSkipped,
        eventsCaptured: result.eventsCaptured,
        duplicateEvents: result.duplicateEvents,
        immediateSignals: result.immediateSignals,
        reviewersLaunched: result.reviewersLaunched,
        recoveredReviewers: result.recoveredReviewers,
        exhaustedReviewerJobs: result.exhaustedReviewerJobs,
        maintenance,
        coverageGaps: result.coverageGaps,
        errors: result.errors
      });
      debugLog(`reconcile.done candidates=${candidates.length} scanned=${result.filesScanned} captured=${result.eventsCaptured} duplicates=${result.duplicateEvents} immediate=${result.immediateSignals} reviewers=${result.reviewersLaunched} recovered=${result.recoveredReviewers} exhausted=${result.exhaustedReviewerJobs} gc=${maintenance.status} coverage_gaps=${result.coverageGaps.length} errors=${result.errors.length}`);
      console.log(JSON.stringify(result));
    } catch (error) {
      store.setRuntimeStatus("codex_reconcile", { status: "failed", code: error.code || "reconcile_failed", reason: error.message });
      throw error;
    } finally {
      store.releaseWorkerLease({ name: "codex_reconcile", ownerId });
      store.close();
    }
    return;
  }
  if (command === "reconcile-daemon") {
    await runReconcileDaemon(options);
    return;
  }
  if (command === "capture-stop") {
    const payload = await new Promise((resolve) => {
      let value = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { value += chunk; });
      process.stdin.on("end", () => resolve(value));
    });
    const paths = pathsFor(options.home);
    const store = openStore({ paths });
    try {
      const parsedPayload = JSON.parse(payload || "{}");
      let transcriptText = "";
      if (parsedPayload.transcript_path) {
        try {
          transcriptText = await readOwnedFileTail(parsedPayload.transcript_path);
        } catch (error) {
          debugLog(`capture.stop.transcript_unavailable reason=${error.code || "invalid"}`);
        }
      }
      const cli = options.cli || options.args[0] || "unknown";
      const lastAssistantMessage = String(parsedPayload.last_assistant_message || "").slice(-32 * 1024);
      const confirmationText = [transcriptText, lastAssistantMessage].filter(Boolean).join("\n");
      const event = normalizeStopEvent({
        cli,
        payload: {
          ...parsedPayload,
          transcript_excerpt: extractTranscriptExcerpt(transcriptText),
          capture_completeness: transcriptText ? "transcript_tail_read" : "partial"
        },
        installationId: "default",
        capturePolicyRevision: store.getCapturePolicy().revision
      });
      if (hasCaptureEvidence(event)) {
        const blobs = new EncryptedBlobStore({ root: paths.blobRoot, keyProvider: new BlobKeyProvider({ keyRoot: paths.keyRoot }) });
        await captureObservedSession({ store, blobs, event, rawText: transcriptText ? JSON.stringify({ payload: parsedPayload, transcript_tail: transcriptText }) : payload });
        debugLog(`capture.stop.ok event=${event.event_uid} completeness=${event.capture_completeness} excerpt_chars=${event.redacted_text?.length || 0}`);
      }
      let confirmation = store.confirmChatNotification({
        sessionUid: event.session_uid,
        contextEpoch: event.context_epoch,
        nativeTurnId: event.native_turn_id,
        transcriptText: confirmationText
      });
      if (confirmation.action === "block" && Number(confirmation.notification?.chat_emit_attempts) > 1) {
        // A re-emission is the final delivery attempt; advance it without forcing the user through a second Stop block.
        confirmation = store.confirmChatNotification({
          sessionUid: event.session_uid,
          contextEpoch: event.context_epoch,
          nativeTurnId: event.native_turn_id,
          transcriptText: confirmationText
        });
      }
      if (confirmation.action === "observed") {
        receiptLog(`receipt.chat.observed notification=${confirmation.notification.notification_id} count=1`);
      } else if (confirmation.action === "pass_unconfirmed") {
        receiptLog(`receipt.chat.unconfirmed notification=${confirmation.notification.notification_id} count=1`);
      }
      const observed = store.observeDeliveryNonces({ session_uid: event.session_uid, context_epoch: event.context_epoch, transcriptText: confirmationText });
      const unconfirmed = store.finalizeUnconfirmedDeliveries({ session_uid: event.session_uid, context_epoch: event.context_epoch });
      debugLog(`capture.stop.delivery observed=${observed} unconfirmed=${unconfirmed}`);
      console.log(JSON.stringify(stopResponse(cli, confirmation)));
    } finally {
      store.close();
    }
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
      logCreatedNotifications(result.notificationRefs);
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
  if (command === "reviewer-submit") {
    const paths = pathsFor(options.home);
    const store = openStore({ paths });
    try {
      const receiptFile = optionValue(options.args, "--receipt-file");
      if (!receiptFile) throw new Error("--receipt-file is required");
      const receipt = await readSecureReceipt(receiptFile);
      const result = store.submitPromptReview(optionValue(options.args, "--job-id"), receipt);
      logCreatedNotifications(result.notificationRefs);
      await rm(receiptFile, { force: true });
      console.log(JSON.stringify(result, null, 2));
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
    const payload = await new Promise((resolve) => {
      let value = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { value += chunk; });
      process.stdin.on("end", () => resolve(value));
    });
    const paths = pathsFor(options.home);
    const store = openStore({ paths });
    const parsedPayload = JSON.parse(payload || "{}");
    const interruptionWindowSeconds = Number(process.env.AGENT_FEEDBACK_LOOP_INTERRUPTION_WINDOW || 900);
    const signal = await detectStructuralFeedbackSignal(parsedPayload, {
      maxSignalAgeMs: (Number.isFinite(interruptionWindowSeconds) && interruptionWindowSeconds >= 0 ? interruptionWindowSeconds : 900) * 1000
    });
    const event = normalizeHookEvent({
      cli,
      payload: parsedPayload,
      installationId: "default",
      capturePolicyRevision: store.getCapturePolicy().revision
    });
    debugLog(`hook.capture.start cli=${event.cli} project=${event.project_id || "_"} session=${event.session_uid}`);
    const blobs = new EncryptedBlobStore({ root: paths.blobRoot, keyProvider: new BlobKeyProvider({ keyRoot: paths.keyRoot }) });
    if (signal.referent) {
      const referentId = String(signal.referent.id).slice(0, 512);
      const referentEvent = normalizeStopEvent({
        cli,
        installationId: "default",
        capturePolicyRevision: store.getCapturePolicy().revision,
        payload: {
          session_id: event.native_session_id,
          turn_id: signal.referent.turnId || event.native_turn_id,
          event_id: `message:${referentId}`,
          cwd: event.cwd,
          project_id: event.project_id,
          timestamp: signal.referent.timestamp,
          last_assistant_message: signal.referent.text,
          capture_completeness: "transcript_visible_assistant",
          transcript_path: parsedPayload.transcript_path
        }
      });
      referentEvent.event_uid = `${cli}:default:${event.native_session_id}:message:${referentId}`;
      referentEvent.source_event_id = `message:${referentId}`;
      referentEvent.source_namespace = "transcript_message";
      referentEvent.observation_source_id = referentId;
      referentEvent.capture_source = "hook_transcript_referent";
      referentEvent.capture_completeness = "transcript_visible_assistant";
      const referentCapture = await captureObservedSession({
        store,
        blobs,
        event: referentEvent,
        rawText: JSON.stringify({ id: referentId, turn_id: signal.referent.turnId, text: signal.referent.text })
      });
      debugLog(`hook.referent.ok event=${referentCapture.eventUid} duplicate=${referentCapture.duplicate ? 1 : 0}`);
    }
    const captured = await captureObservedSession({ store, blobs, event, rawText: payload });
    const canonicalEventUid = captured.eventUid;
    debugLog(`hook.capture.ok event=${canonicalEventUid} duplicate=${captured.duplicate ? 1 : 0}`);
    const receiptLanguage = detectReceiptLanguage(event.redacted_text, process.env.AGENT_FEEDBACK_LOOP_RECEIPT_LANGUAGE || "auto");
    if (signal.immediateReview) {
      const candidate = store.createNotification({
        sessionUid: event.session_uid,
        contextEpoch: event.context_epoch,
        kind: "candidate_captured",
        eventUid: canonicalEventUid,
        payload: {},
        language: receiptLanguage
      });
      logCreatedNotifications([candidate]);
    }
    const due = store.submitDueReview({
      projectId: event.project_id,
      minEntries: signal.immediateReview ? 1 : Number(process.env.AGENT_FEEDBACK_LOOP_REVIEW_MIN_ENTRIES || 3),
      maxEntries: Number(process.env.AGENT_FEEDBACK_LOOP_REVIEW_BATCH_MAX || 24),
      maxAgeMs: Number(process.env.AGENT_FEEDBACK_LOOP_REVIEW_MAX_AGE || 3_600) * 1000,
      cooldownMs: Number(process.env.AGENT_FEEDBACK_LOOP_REVIEW_COOLDOWN || 900) * 1000,
      promptVersion: "v1",
      immediateEventUid: signal.immediateReview ? canonicalEventUid : null
    });
    logCreatedNotifications(due.notificationRefs);
    debugLog(`hook.signal signal=${signal.reason} immediate_review=${signal.immediateReview ? 1 : 0}`);
    debugLog(`hook.review status=${due.status} events=${due.eventCount}`);
    const injectedContexts = [];
    if (signal.immediateReview) {
      injectedContexts.push([
        "[agent-feedback-loop correction checkpoint]",
        "Apply the user's correction now and stop the superseded execution path before doing more work.",
        "A background reviewer handles durable learning independently; do not perform, display, or wait for it in the main conversation."
      ].join("\n"));
    }
    const wake = due.status === "pending"
      ? store.claimReviewerWake({ jobId: due.job_id, cooldownMs: Number(process.env.AGENT_FEEDBACK_LOOP_REVIEW_WAKE_COOLDOWN || 300) * 1000 })
      : { action: "not_due", attempt: 0 };
    const shouldWake = wake.action === "inject" || wake.action === "retry";
    debugLog(`hook.review.wake action=${wake.action} attempt=${wake.attempt}`);
    if (shouldWake) {
      const launched = await launchDetachedReviewer({ paths, cli, jobId: due.job_id });
      debugLog(`hook.review.background job=${due.job_id} launched=${launched.launched ? 1 : 0} mode=${launched.mode}`);
    }
    if (due.status === "pending" && process.env.AGENT_FEEDBACK_LOOP_DEBUG === "1") {
      console.error(`agent-feedback-loop: reviewer_job=${due.job_id} status=pending events=${due.eventCount}`);
    }
    const selection = selectLessons({
      lessons: store.selectLessons({ projectId: event.project_id }),
      session: { session_uid: event.session_uid, context_epoch: event.context_epoch, project_id: event.project_id },
      task: { project_id: event.project_id, fingerprint: event.task_fingerprint, task_type: event.task_type, paths: event.paths, tools: event.tools, prompt: event.redacted_text },
      budget: process.env.AGENT_FEEDBACK_LOOP_MEMORY_BUDGET ? Number(process.env.AGENT_FEEDBACK_LOOP_MEMORY_BUDGET) : undefined,
      hostPrefix: "agent feedback memory",
      store
    });
    debugLog(`hook.selection cards=${selection.cards.length} hold=${selection.hold || "none"} tokens=${selection.tokenEstimate}`);
    if (signal.immediateReview || selection.cards.length > 0 || selection.hold) {
      console.error(`agent-feedback-loop: ${new Date().toISOString()} hook.outcome signal=${signal.reason} immediate=${signal.immediateReview ? 1 : 0} cards=${selection.cards.length} hold=${selection.hold || "none"} review=${due.status} job=${due.job_id || "none"}`);
    }
    if (selection.cards.length > 0) {
      const nonce = selection.cards.map((card) => card.application_id).join("").slice(0, 16);
      const deliveryResult = store.recordDeliveries({
        deliveries: selection.cards.map((card) => ({
          application_id: card.application_id,
          lesson_id: card.lesson_id,
          revision: card.revision,
          state: "emitted",
          nonce
        })),
        sessionUid: event.session_uid,
        contextEpoch: event.context_epoch,
        language: receiptLanguage
      });
      logCreatedNotifications([deliveryResult.notification]);
      debugLog(`hook.delivery emitted=${selection.cards.length}`);
      injectedContexts.push([
        "[agent-feedback-loop memory]",
        ...selection.cards.map((card) => `When: ${card.card.when}\nMust do: ${card.card.must_do}\nMust not: ${card.card.must_not}\nVerify: ${card.card.verify}\nWhy: ${card.card.why}\nException: ${card.card.exception}`),
        `nonce=${nonce}`
      ].join("\n"));
    }
    if (selection.hold) {
      injectedContexts.push(`[agent-feedback-loop checkpoint hold]\nstate=${selection.hold}\nThe applicable severe memory set could not be loaded as complete cards within the local absolute budget. Stop before high-risk or irreversible actions, keep the current task pending, and report that memory enforcement is checkpoint-only until a background reviewer compacts the conflicting cards.`);
      debugLog(`hook.selection.hold state=${selection.hold} absolute_budget=${selection.budgets?.absolute || 0}`);
    }
    if (process.env.AGENT_FEEDBACK_LOOP_CHAT_RECEIPTS === "0") {
      const suppressed = store.suppressPendingChatNotifications({ sessionUid: event.session_uid, contextEpoch: event.context_epoch });
      debugLog(`hook.receipt.suppressed count=${suppressed}`);
    } else {
      const claimed = store.claimChatNotification({
        sessionUid: event.session_uid,
        contextEpoch: event.context_epoch,
        nativeTurnId: event.native_turn_id
      });
      if (claimed) {
        injectedContexts.push(renderReceiptInstruction(claimed));
        receiptLog(`receipt.chat.emitted notification=${claimed.notification_id} count=1`);
      }
    }
    if (injectedContexts.length > 0) {
      store.close();
      console.log(JSON.stringify({ ...(withContinue ? { continue: true } : {}), hookSpecificOutput: { hookEventName: optionValue(options.args, "--event", "UserPromptSubmit"), additionalContext: injectedContexts.join("\n\n") } }));
      return;
    }
    store.close();
    console.log(JSON.stringify(withContinue ? { continue: true } : {}));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
