import { constants, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 8_000;
const APP_CODEX_CANDIDATES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex"
];

function canonicalPath(file) {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function boundedReason(error) {
  return String(error?.message || error || "unknown Codex host error")
    .replace(/((?:token|api[_-]?key|secret|password|passwd)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

async function executable(file) {
  if (!path.isAbsolute(file)) return true;
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function commandCandidates(explicitCommand, explicitCommands) {
  if (Array.isArray(explicitCommands) && explicitCommands.length > 0) {
    return [...new Set(explicitCommands.filter(Boolean))];
  }
  const requested = explicitCommand || process.env.AGENT_FEEDBACK_LOOP_CODEX_COMMAND;
  if (requested) return [requested];
  const appCandidates = [];
  for (const candidate of APP_CODEX_CANDIDATES) {
    if (await executable(candidate)) appCandidates.push(candidate);
  }
  return appCandidates.length > 0 ? [...new Set(appCandidates)] : ["codex"];
}

function createRpcSession({ command, home, cwd, timeoutMs }) {
  const child = spawn(command, ["app-server"], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: path.join(home, ".codex")
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let nextId = 1;
  let stdout = "";
  let stderr = "";
  let closed = false;
  const pending = new Map();

  function rejectPending(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id == null || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(new Error(`Codex ${entry.method} failed: ${message.error.message || "request error"}`));
    } else {
      entry.resolve(message.result);
    }
  }

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    let newline;
    while ((newline = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      handleLine(line);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4_096);
  });
  child.on("error", (error) => rejectPending(error));
  child.on("close", (code) => {
    closed = true;
    if (pending.size > 0) {
      const detail = stderr.trim() ? `: ${boundedReason(stderr)}` : "";
      rejectPending(new Error(`Codex app-server exited ${code}${detail}`));
    }
  });

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { method, resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
        if (!error) return;
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        clearTimeout(entry.timer);
        reject(error);
      });
    });
  }

  function notify(method, params = {}) {
    child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async function close() {
    if (closed) return;
    const completed = new Promise((resolve) => child.once("close", resolve));
    child.stdin.end();
    child.kill("SIGTERM");
    await Promise.race([completed, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    if (!closed) {
      child.kill("SIGKILL");
      await Promise.race([completed, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    }
  }

  return { request, notify, close };
}

async function withAppServer(input, operation) {
  const candidates = await commandCandidates(input.command, input.commands);
  const failures = [];
  for (const command of candidates) {
    const session = createRpcSession({
      command,
      home: input.home,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs || DEFAULT_TIMEOUT_MS
    });
    let initialized = false;
    try {
      await session.request("initialize", {
        clientInfo: {
          name: "agent_feedback_loop",
          title: "Agent Feedback Loop",
          version: input.version || "0.0.0"
        },
        capabilities: null
      });
      initialized = true;
      session.notify("initialized");
      return await operation(session, command);
    } catch (error) {
      failures.push(`${command}: ${boundedReason(error)}`);
      if (initialized) throw new Error(failures.at(-1));
    } finally {
      await session.close();
    }
  }
  throw new Error(failures.join("; ") || "no Codex app-server command is available");
}

function hookRunnable(hook) {
  return Boolean(hook?.enabled && (hook.isManaged || hook.trustStatus === "trusted"));
}

function hookSummary(hook) {
  if (!hook) return { found: false, enabled: false, trustStatus: "missing", runnable: false };
  return {
    found: true,
    key: hook.key,
    enabled: Boolean(hook.enabled),
    isManaged: Boolean(hook.isManaged),
    trustStatus: hook.isManaged ? "managed" : hook.trustStatus,
    currentHash: hook.currentHash,
    runnable: hookRunnable(hook)
  };
}

export function assessCodexHookListing({ listing, cwd, home, promptCommand }) {
  const rows = Array.isArray(listing?.data) ? listing.data : [];
  const target = rows.find((row) => row?.cwd && canonicalPath(row.cwd) === canonicalPath(cwd));
  if (!target) {
    return {
      available: true,
      configured: false,
      runnable: false,
      status: "cwd_missing",
      prompt: hookSummary(null),
      warnings: [],
      errors: []
    };
  }
  const hooks = Array.isArray(target.hooks) ? target.hooks : [];
  const expectedSourcePath = path.join(home, ".codex", "config.toml");
  const matchesIdentity = (hook, eventName, command) => hook?.eventName === eventName
    && hook?.handlerType === "command"
    && hook?.source === "user"
    && hook?.sourcePath
    && canonicalPath(hook.sourcePath) === canonicalPath(expectedSourcePath)
    && hook?.command === command;
  const promptHook = hooks.find((hook) => matchesIdentity(hook, "userPromptSubmit", promptCommand));
  const prompt = hookSummary(promptHook);
  const configured = prompt.found;
  const runnable = configured && prompt.runnable;
  let status = "trusted";
  if (!configured) status = "missing";
  else if (!runnable) {
    const statuses = [prompt.trustStatus];
    status = statuses.includes("modified") ? "modified"
      : statuses.includes("untrusted") ? "untrusted"
        : statuses.includes("missing") ? "missing"
          : "disabled";
  }
  return {
    available: true,
    configured,
    runnable,
    status,
    prompt,
    warnings: target.warnings || [],
    errors: target.errors || []
  };
}

function unavailableAssessment(error) {
  return {
    available: false,
    configured: false,
    runnable: false,
    status: "unavailable",
    inspectionScope: "spawned_app_server",
    activeDesktopState: "not_observed",
    reason: boundedReason(error),
    prompt: { found: false, enabled: false, trustStatus: "unknown", runnable: false },
    warnings: [],
    errors: []
  };
}

export function createCodexHost(options = {}) {
  const base = {
    command: options.command,
    commands: options.commands,
    timeoutMs: options.timeoutMs,
    version: options.version
  };

  async function inspect(input) {
    try {
      return await withAppServer({ ...base, ...input }, async (session, hostCommand) => {
        const listing = await session.request("hooks/list", { cwds: [input.cwd] });
        return {
          ...assessCodexHookListing({ ...input, listing }),
          hostCommand,
          inspectionScope: "spawned_app_server",
          activeDesktopState: "not_observed"
        };
      });
    } catch (error) {
      return unavailableAssessment(error);
    }
  }

  async function synchronize(input) {
    try {
      return await withAppServer({ ...base, ...input }, async (session, hostCommand) => {
        const beforeListing = await session.request("hooks/list", { cwds: [input.cwd] });
        const before = assessCodexHookListing({ ...input, listing: beforeListing });
        if (!before.configured) return { ...before, hostCommand, inspectionScope: "spawned_app_server", activeDesktopState: "not_observed" };
        if (!before.runnable) {
          const state = {};
          for (const hook of [before.prompt]) {
            if (!hook.key || !hook.currentHash) continue;
            state[hook.key] = { trusted_hash: hook.currentHash, enabled: true };
          }
          await session.request("config/batchWrite", {
            edits: [{ keyPath: "hooks.state", value: state, mergeStrategy: "upsert" }],
            reloadUserConfig: true
          });
        }
        const afterListing = await session.request("hooks/list", { cwds: [input.cwd] });
        return {
          ...assessCodexHookListing({ ...input, listing: afterListing }),
          hostCommand,
          inspectionScope: "spawned_app_server",
          activeDesktopState: "not_observed",
          changed: !before.runnable
        };
      });
    } catch (error) {
      return unavailableAssessment(error);
    }
  }

  return { inspect, synchronize };
}
