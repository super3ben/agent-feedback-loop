import os from "node:os";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { doctor, install, pathsFor, uninstall } from "./index.mjs";
import { captureSession, extractTranscriptExcerpt, normalizeHookEvent, normalizeStopEvent } from "./capture.mjs";
import { BlobKeyProvider, EncryptedBlobStore } from "./crypto-store.mjs";
import { openStore } from "./store.mjs";
import { ReviewerRunner } from "./reviewer-runner.mjs";
import { readSecureReceipt } from "./reviewer-auth.mjs";
import { selectLessons } from "./selector.mjs";

function optionValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function debugLog(message) {
  if (process.env.AGENT_FEEDBACK_LOOP_DEBUG === "1") console.error(`agent-feedback-loop: ${message}`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

async function openRuntimeLog(paths) {
  const logFile = process.env.AGENT_FEEDBACK_LOOP_LOG || path.join(paths.dataRoot, "logs", "runtime.log");
  if (logFile !== "/dev/null") {
    await mkdir(path.dirname(logFile), { recursive: true, mode: 0o700 });
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
  agent-feedback-loop memory promote <lesson-id> [project-id] [--home <path>]
  agent-feedback-loop capture status|on|off [--home <path>]
  agent-feedback-loop gc status|run [--home <path>]
  agent-feedback-loop reviewer-context --job-id <id> [--home <path>]
  agent-feedback-loop reviewer-submit --job-id <id> --receipt-file <path> [--home <path>]
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
          const info = await lstat(parsedPayload.transcript_path);
          if (info.isFile() && !info.isSymbolicLink() && info.size <= 2 * 1024 * 1024 && (typeof process.getuid !== "function" || info.uid === process.getuid())) {
            transcriptText = (await readFile(parsedPayload.transcript_path, "utf8")).slice(-128 * 1024);
          }
        } catch (error) {
          debugLog(`capture.stop.transcript_unavailable reason=${error.code || "invalid"}`);
        }
      }
      const event = normalizeStopEvent({
        cli: options.cli || options.args[0] || "unknown",
        payload: {
          ...parsedPayload,
          transcript_excerpt: extractTranscriptExcerpt(transcriptText),
          capture_completeness: transcriptText ? "transcript_tail_read" : "partial"
        },
        installationId: "default",
        capturePolicyRevision: store.getCapturePolicy().revision
      });
      if (event.redacted_text || event.tool_name || event.textual_output_ref) {
        const blobs = new EncryptedBlobStore({ root: paths.blobRoot, keyProvider: new BlobKeyProvider({ keyRoot: paths.keyRoot }) });
        await captureSession({ store, blobs, event, rawText: transcriptText ? JSON.stringify({ payload: parsedPayload, transcript_tail: transcriptText }) : payload });
        debugLog(`capture.stop.ok event=${event.event_uid} completeness=${event.capture_completeness} excerpt_chars=${event.redacted_text?.length || 0}`);
      }
      const observed = store.observeDeliveryNonces({ session_uid: event.session_uid, context_epoch: event.context_epoch, transcriptText });
      const unconfirmed = store.finalizeUnconfirmedDeliveries({ session_uid: event.session_uid, context_epoch: event.context_epoch });
      debugLog(`capture.stop.delivery observed=${observed} unconfirmed=${unconfirmed}`);
      console.log(JSON.stringify({}));
    } finally {
      store.close();
    }
    return;
  }
  if (command === "reviewer-run") {
    const paths = pathsFor(options.home);
    const store = openStore({ paths });
    const runner = new ReviewerRunner({ store, mode: "isolated_cli_process" });
    try {
      const commandPath = optionValue(options.args, "--command", process.env.AGENT_FEEDBACK_LOOP_REVIEWER_COMMAND);
      if (!commandPath) throw new Error("reviewer command is not configured");
      const argsJson = optionValue(options.args, "--args-json", process.env.AGENT_FEEDBACK_LOOP_REVIEWER_ARGS_JSON || "[]");
      const result = await runner.runJob({
        jobId: optionValue(options.args, "--job-id"),
        ownerId: `reviewer-${process.pid}`,
        command: commandPath,
        args: JSON.parse(argsJson),
        cwd: paths.dataRoot,
        timeoutMs: Number(optionValue(options.args, "--timeout-ms", process.env.AGENT_FEEDBACK_LOOP_REVIEWER_TIMEOUT_MS || 30_000)),
        contextRoot: path.join(paths.dataRoot, "reviewer-contexts"),
        promptFile: paths.promptFile
      });
      console.log(JSON.stringify(result));
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
    const payload = await new Promise((resolve) => {
      let value = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { value += chunk; });
      process.stdin.on("end", () => resolve(value));
    });
    const paths = pathsFor(options.home);
    const store = openStore({ paths });
    const event = normalizeHookEvent({
      cli,
      payload: JSON.parse(payload || "{}"),
      installationId: "default",
      capturePolicyRevision: store.getCapturePolicy().revision
    });
    debugLog(`hook.capture.start cli=${event.cli} project=${event.project_id || "_"} session=${event.session_uid}`);
    const blobs = new EncryptedBlobStore({ root: paths.blobRoot, keyProvider: new BlobKeyProvider({ keyRoot: paths.keyRoot }) });
    await captureSession({ store, blobs, event, rawText: payload });
    debugLog(`hook.capture.ok event=${event.event_uid}`);
    const retentionDays = Number(process.env.AGENT_FEEDBACK_LOOP_RETENTION_DAYS || 10);
    if (Number.isFinite(retentionDays) && retentionDays > 0) {
      const gc = store.gcExpired({ beforeMs: Date.now() - retentionDays * 24 * 60 * 60 * 1000 });
      if (gc.eventCount > 0) {
        await blobs.pruneUnreferenced(store.listEncryptedRawRefs(), { beforeMs: Date.now() - retentionDays * 24 * 60 * 60 * 1000 });
      }
      if (gc.eventCount || gc.jobCount) debugLog(`gc events=${gc.eventCount} jobs=${gc.jobCount} retention_days=${retentionDays}`);
    }
    const due = store.submitDueReview({
      projectId: event.project_id,
      minEntries: Number(process.env.AGENT_FEEDBACK_LOOP_REVIEW_MIN_ENTRIES || 3),
      maxEntries: Number(process.env.AGENT_FEEDBACK_LOOP_REVIEW_BATCH_MAX || 24),
      maxAgeMs: Number(process.env.AGENT_FEEDBACK_LOOP_REVIEW_MAX_AGE || 3_600) * 1000,
      cooldownMs: Number(process.env.AGENT_FEEDBACK_LOOP_REVIEW_COOLDOWN || 900) * 1000,
      promptVersion: "v1"
    });
    debugLog(`hook.review status=${due.status} events=${due.eventCount}`);
    const injectedContexts = [];
    const wake = due.status === "pending"
      ? store.claimReviewerWake({ jobId: due.job_id, cooldownMs: Number(process.env.AGENT_FEEDBACK_LOOP_REVIEW_WAKE_COOLDOWN || 300) * 1000 })
      : { action: "not_due", attempt: 0 };
    const shouldWake = wake.action === "inject" || wake.action === "retry";
    debugLog(`hook.review.wake action=${wake.action} attempt=${wake.attempt}`);
    if (shouldWake && process.env.AGENT_FEEDBACK_LOOP_REVIEWER_COMMAND) {
      const reviewerArgs = [
        "reviewer-run",
        "--home", paths.home,
        "--job-id", due.job_id,
        "--command", process.env.AGENT_FEEDBACK_LOOP_REVIEWER_COMMAND,
        "--args-json", process.env.AGENT_FEEDBACK_LOOP_REVIEWER_ARGS_JSON || "[]",
        "--timeout-ms", process.env.AGENT_FEEDBACK_LOOP_REVIEWER_TIMEOUT_MS || "30000"
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
      } finally {
        await logHandle.close();
      }
    }
    if (shouldWake && !process.env.AGENT_FEEDBACK_LOOP_REVIEWER_COMMAND) {
      const launcher = paths.runtimeLauncher;
      const receiptFile = path.join(paths.dataRoot, "reviewer-receipts", `${due.job_id}.json`);
      await mkdir(path.dirname(receiptFile), { recursive: true, mode: 0o700 });
      const contextCommand = [launcher, "reviewer-context", "--home", paths.home, "--job-id", due.job_id].map(shellQuote).join(" ");
      const submitCommand = [launcher, "reviewer-submit", "--home", paths.home, "--job-id", due.job_id, "--receipt-file", receiptFile].map(shellQuote).join(" ");
      injectedContexts.push(`[agent-feedback-loop review required]\n立即启动一个真正的后台 subagent 完成反思，主会话不得自己做完整反思。把 ${shellQuote(paths.promptFile)} 作为 reviewer 规则，把以下命令返回的有界上下文作为证据：${contextCommand}。receipt 必须包含 write_complete=true、review_receipt_id、report_content_id、report_content、status、lessons、mode=background_subagent、background_agent_id，以及一次性 reviewer_capability=${wake.capability}。先写 ${shellQuote(`${receiptFile}.tmp`)}，设置权限 0600，完整关闭后原子 rename 为 ${shellQuote(receiptFile)}。后台 subagent 返回后，主会话只执行一次提交：${submitCommand}。主会话继续当前任务，不得代写完整反思或把报告贴进用户对话。平台没有后台 subagent 工具时保持 job pending，并仅在运行日志中记录 reviewer_unavailable，不得向用户追问，也不得由主会话伪造 receipt。`);
      debugLog(`hook.review prompt_required job=${due.job_id}`);
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
    if (selection.cards.length > 0) {
      const nonce = selection.cards.map((card) => card.application_id).join("").slice(0, 16);
      for (const card of selection.cards) {
        store.recordDelivery({ application_id: card.application_id, lesson_id: card.lesson_id, revision: card.revision, session_uid: event.session_uid, context_epoch: event.context_epoch, state: "emitted", nonce });
      }
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
    if (injectedContexts.length > 0) {
      store.close();
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: optionValue(options.args, "--event", "UserPromptSubmit"), additionalContext: injectedContexts.join("\n\n") } }));
      return;
    }
    store.close();
    console.log(JSON.stringify({}));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
