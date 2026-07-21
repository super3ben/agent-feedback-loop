import { fileURLToPath } from "node:url";

import { initializeControlStore } from "./control-store.mjs";
import { launchDetachedConvergenceProbe } from "./convergence-probe-launcher.mjs";
import { runGuardCommand } from "./convergence-sdd-adapter.mjs";
import { pathsFor } from "./index.mjs";

const CLI_FILE = fileURLToPath(new URL("./cli.mjs", import.meta.url));

const EXIT_BY_CODE = Object.freeze({
  guard_invalid_arguments: 2,
  review_evidence_required: 2,
  direction_review_required: 3,
  human_decision_required: 4,
  guard_state_invalid: 5
});

function boundedCode(error, fallback = "guard_transition_invalid") {
  const code = String(error?.code ?? "").toLowerCase();
  return /^[a-z0-9_.-]{1,64}$/u.test(code) ? code : fallback;
}

function parseGuardCliArgs(args) {
  if (!Array.isArray(args)) throw Object.assign(new Error("guard_invalid_arguments"), { code: "guard_invalid_arguments" });
  let repoRoot = null;
  let home = null;
  let index = 0;
  while (index < args.length && (args[index] === "--repo-root" || args[index] === "--home")) {
    const flag = args[index];
    const value = args[index + 1];
    if (typeof value !== "string" || !value || value.startsWith("--")) {
      throw Object.assign(new Error("guard_invalid_arguments"), { code: "guard_invalid_arguments" });
    }
    if (flag === "--repo-root") {
      if (repoRoot !== null) throw Object.assign(new Error("guard_invalid_arguments"), { code: "guard_invalid_arguments" });
      repoRoot = value;
    } else {
      if (home !== null) throw Object.assign(new Error("guard_invalid_arguments"), { code: "guard_invalid_arguments" });
      home = value;
    }
    index += 2;
  }
  if (repoRoot === null || home === null || index >= args.length) {
    throw Object.assign(new Error("guard_invalid_arguments"), { code: "guard_invalid_arguments" });
  }
  return { repoRoot, home, commandArgs: args.slice(index) };
}

export async function executeGuardCli(args) {
  let store = null;
  try {
    const parsed = parseGuardCliArgs(args);
    store = initializeControlStore({ paths: pathsFor(parsed.home) });
    const result = await runGuardCommand({
      args: parsed.commandArgs,
      repoRoot: parsed.repoRoot,
      store,
      launchProbe: ({ taskUid, fingerprint }) => launchDetachedConvergenceProbe({
        platform: process.platform,
        nodeExecutable: process.execPath,
        cliFile: CLI_FILE,
        home: parsed.home,
        taskUid,
        fingerprint
      })
    });
    const { exitCode = 0, ...payload } = result;
    return Object.freeze({ payload, exitCode, stderrCode: null });
  } catch (error) {
    const code = boundedCode(error);
    return Object.freeze({
      payload: Object.freeze({ error: code }),
      exitCode: EXIT_BY_CODE[code] ?? (code.includes("state") || code.includes("locked") ? 5 : 6),
      stderrCode: code
    });
  } finally {
    store?.close();
  }
}
