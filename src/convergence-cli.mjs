import { fileURLToPath } from "node:url";
import os from "node:os";
import { TextDecoder } from "node:util";

import {
  initializeControlStore,
  openControlStore,
  openControlStoreReadOnly
} from "./control-store.mjs";
import { readRepositoryLineage } from "./convergence-identity.mjs";
import { launchDetachedConvergenceProbe } from "./convergence-probe-launcher.mjs";
import {
  applyGuardImport,
  compareGuardShadow,
  cutoverGuard,
  inspectGuardRepository,
  inspectGuardImport,
  rollbackGuardCutover
} from "./convergence-migration.mjs";
import { runGuardCommand } from "./convergence-sdd-adapter.mjs";
import {
  ConvergenceProbeContextStore,
  validateConvergenceProbeProducerProjection
} from "./convergence-probe-context.mjs";
import { BlobKeyProvider } from "./crypto-store.mjs";
import { pathsFor } from "./index.mjs";

const CLI_FILE = fileURLToPath(new URL("../bin/agent-feedback-loop.mjs", import.meta.url));

const EXIT_BY_CODE = Object.freeze({
  guard_invalid_arguments: 2,
  review_evidence_required: 2,
  direction_review_required: 3,
  human_decision_required: 4,
  guard_state_invalid: 5,
  guard_apply_required: 5,
  guard_authority_locked: 5,
  legacy_guard_authoritative: 5
});
const MIGRATION_COMMANDS = new Set(["import", "shadow", "cutover", "rollback"]);
const MAX_PROBE_CONTEXT_BYTES = 16 * 1_024;

function boundedCode(error, fallback = "guard_transition_invalid") {
  const code = String(error?.code ?? "").toLowerCase();
  return /^[a-z0-9_.-]{1,64}$/u.test(code) ? code : fallback;
}

function parseGuardCliArgs(args) {
  if (!Array.isArray(args)) throw Object.assign(new Error("guard_invalid_arguments"), { code: "guard_invalid_arguments" });
  let repoRoot = null;
  let home = null;
  let probeContextStdin = false;
  const commandArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--probe-context-stdin") {
      if (probeContextStdin) {
        throw Object.assign(new Error("guard_invalid_arguments"), { code: "guard_invalid_arguments" });
      }
      probeContextStdin = true;
      continue;
    }
    if (flag !== "--repo-root" && flag !== "--home") {
      commandArgs.push(flag);
      continue;
    }
    const value = args[++index];
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
  }
  if (repoRoot === null || commandArgs.length === 0) {
    throw Object.assign(new Error("guard_invalid_arguments"), { code: "guard_invalid_arguments" });
  }
  const migration = MIGRATION_COMMANDS.has(commandArgs[0]);
  if (probeContextStdin && commandArgs[0] !== "record-review") {
    throw Object.assign(new Error("guard_invalid_arguments"), { code: "guard_invalid_arguments" });
  }
  if (!migration && home === null) {
    throw Object.assign(new Error("guard_invalid_arguments"), { code: "guard_invalid_arguments" });
  }
  return { repoRoot, home: home ?? os.homedir(), commandArgs, migration, probeContextStdin };
}

async function readProcessStdin({ maxBytes }) {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) {
      throw Object.assign(new Error("probe_context_invalid"), { code: "probe_context_invalid" });
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

async function readProbeContext(readStdin) {
  if (typeof readStdin !== "function") {
    throw Object.assign(new Error("probe_context_invalid"), { code: "probe_context_invalid" });
  }
  try {
    const raw = await readStdin({ maxBytes: MAX_PROBE_CONTEXT_BYTES });
    const bytes = typeof raw === "string"
      ? Buffer.from(raw, "utf8")
      : Buffer.from(raw);
    if (bytes.length > MAX_PROBE_CONTEXT_BYTES) throw new Error("oversized");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return validateConvergenceProbeProducerProjection(JSON.parse(text));
  } catch {
    throw Object.assign(new Error("probe_context_invalid"), { code: "probe_context_invalid" });
  }
}

function parseMigrationArgs(args) {
  const command = args[0];
  const allowed = {
    import: new Set(["--state-file", "--dry-run", "--apply"]),
    shadow: new Set([
      "--state-file", "--legacy-decision", "--kernel-decision", "--legacy-action",
      "--kernel-action", "--legacy-generation", "--kernel-generation",
      "--legacy-eligible", "--kernel-eligible"
    ]),
    cutover: new Set(["--state-file", "--parity-set-digest", "--decision-ref", "--apply"]),
    rollback: new Set([
      "--state-file", "--authority-task-uid", "--cutover-event-uid", "--decision-ref", "--apply"
    ])
  }[command];
  if (!allowed) throw Object.assign(new Error("guard_invalid_arguments"), { code: "guard_invalid_arguments" });
  const values = Object.create(null);
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (!allowed.has(flag) || Object.hasOwn(values, flag)) {
      throw Object.assign(new Error("guard_invalid_arguments"), { code: "guard_invalid_arguments" });
    }
    if (flag === "--apply" || flag === "--dry-run") {
      values[flag] = true;
      continue;
    }
    const value = args[++index];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw Object.assign(new Error("guard_invalid_arguments"), { code: "guard_invalid_arguments" });
    }
    values[flag] = value;
  }
  if (!Object.hasOwn(values, "--state-file")) {
    throw Object.assign(new Error("guard_invalid_arguments"), { code: "guard_invalid_arguments" });
  }
  if (command === "import"
      && Number(Boolean(values["--dry-run"])) + Number(Boolean(values["--apply"])) !== 1) {
    throw Object.assign(new Error("guard_invalid_arguments"), { code: "guard_invalid_arguments" });
  }
  if (["cutover", "rollback"].includes(command) && values["--apply"] !== true) {
    throw Object.assign(new Error("guard_apply_required"), { code: "guard_apply_required" });
  }
  const required = {
    shadow: [
      "--legacy-decision", "--kernel-decision", "--legacy-action", "--kernel-action",
      "--legacy-generation", "--kernel-generation", "--legacy-eligible", "--kernel-eligible"
    ],
    cutover: ["--parity-set-digest", "--decision-ref"],
    rollback: ["--authority-task-uid", "--cutover-event-uid", "--decision-ref"]
  }[command] ?? [];
  if (required.some((flag) => !Object.hasOwn(values, flag))) {
    throw Object.assign(new Error("guard_invalid_arguments"), { code: "guard_invalid_arguments" });
  }
  return Object.freeze({ command, values });
}

function booleanFlag(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw Object.assign(new Error("guard_invalid_arguments"), { code: "guard_invalid_arguments" });
}

function generationFlag(value) {
  if (!/^[0-3]$/u.test(value)) {
    throw Object.assign(new Error("guard_invalid_arguments"), { code: "guard_invalid_arguments" });
  }
  return Number(value);
}

async function executeMigrationCommand({ parsed, repoRoot, store }) {
  const stateFile = parsed.values["--state-file"];
  if (parsed.command === "rollback") {
    const result = await rollbackGuardCutover({
      repoRoot, stateFile, store,
      authorityTaskUid: parsed.values["--authority-task-uid"],
      cutoverEventUid: parsed.values["--cutover-event-uid"],
      decisionRef: parsed.values["--decision-ref"], apply: true
    });
    return Object.freeze({ status: "rolled_back", ...result });
  }
  const plan = await inspectGuardImport({ repoRoot, stateFile, store });
  if (parsed.command === "import") {
    if (parsed.values["--dry-run"] === true) {
      return Object.freeze({ status: "dry_run", ...plan });
    }
    return Object.freeze({ status: "applied", ...(await applyGuardImport({ plan, store })) });
  }
  if (parsed.command === "shadow") {
    const comparisons = [
      { field: "decision", legacy: parsed.values["--legacy-decision"], kernel: parsed.values["--kernel-decision"] },
      { field: "next_required_action", legacy: parsed.values["--legacy-action"], kernel: parsed.values["--kernel-action"] },
      { field: "failure_generation", legacy: generationFlag(parsed.values["--legacy-generation"]), kernel: generationFlag(parsed.values["--kernel-generation"]) },
      { field: "authorization_eligibility", legacy: booleanFlag(parsed.values["--legacy-eligible"]), kernel: booleanFlag(parsed.values["--kernel-eligible"]) }
    ];
    return Object.freeze({ status: "compared", ...(await compareGuardShadow({ plan, store, comparisons })) });
  }
  const result = await cutoverGuard({
    repoRoot, stateFile, plan, store,
    paritySetDigest: parsed.values["--parity-set-digest"],
    decisionRef: parsed.values["--decision-ref"], apply: true
  });
  return Object.freeze({ status: "cut_over", ...result });
}

export async function executeGuardCli(args, { readStdin = readProcessStdin } = {}) {
  let store = null;
  try {
    const parsed = parseGuardCliArgs(args);
    const probeContext = parsed.probeContextStdin
      ? await readProbeContext(readStdin)
      : undefined;
    const paths = pathsFor(parsed.home);
    if (parsed.migration) {
      const migration = parseMigrationArgs(parsed.commandArgs);
      if (migration.command === "import" && migration.values["--dry-run"] === true) {
        await readRepositoryLineage({ repoRoot: parsed.repoRoot });
        const inertStore = Object.freeze({ transactionalGuardImport() {
          throw Object.assign(new Error("guard_dry_run_store_write"), { code: "guard_dry_run_store_write" });
        } });
        const payload = await executeMigrationCommand({
          parsed: migration, repoRoot: parsed.repoRoot, store: inertStore
        });
        return Object.freeze({ payload, exitCode: 0, stderrCode: null });
      }
      if (migration.command === "import") {
        await readRepositoryLineage({ repoRoot: parsed.repoRoot });
        const inertStore = Object.freeze({ transactionalGuardImport() {
          throw Object.assign(new Error("guard_import_store_write"), { code: "guard_import_store_write" });
        } });
        const plan = await inspectGuardImport({
          repoRoot: parsed.repoRoot,
          stateFile: migration.values["--state-file"],
          store: inertStore
        });
        const preflight = await inspectGuardRepository({ repoRoot: parsed.repoRoot, paths });
        if (preflight.repositoryState === "transition_locked") {
          throw Object.assign(new Error("guard_authority_locked"), { code: "guard_authority_locked" });
        }
        store = preflight.storeState === "valid"
          ? openControlStore({ paths }) : initializeControlStore({ paths });
        const payload = Object.freeze({
          status: "applied", ...(await applyGuardImport({ plan, store }))
        });
        return Object.freeze({ payload, exitCode: 0, stderrCode: null });
      }
      const preflight = await inspectGuardRepository({ repoRoot: parsed.repoRoot, paths });
      if (preflight.repositoryState === "uninitialized") {
        throw Object.assign(new Error("lineage_not_initialized"), { code: "lineage_not_initialized" });
      }
      if (preflight.repositoryState === "transition_locked") {
        throw Object.assign(new Error("guard_authority_locked"), { code: "guard_authority_locked" });
      }
      if (preflight.storeState !== "valid") {
        throw Object.assign(new Error("control_store_unavailable"), { code: "control_store_unavailable" });
      }
      store = openControlStore({ paths });
      const payload = await executeMigrationCommand({
        parsed: migration, repoRoot: parsed.repoRoot, store
      });
      return Object.freeze({ payload, exitCode: 0, stderrCode: null });
    }
    const preflight = await inspectGuardRepository({ repoRoot: parsed.repoRoot, paths });
    const command = parsed.commandArgs[0];
    const readOnly = command === "status" || command === "lock-status";
    const contextStore = readOnly ? null : new ConvergenceProbeContextStore({
      root: paths.probeContextRoot,
      keyProvider: new BlobKeyProvider({ keyRoot: paths.keyRoot })
    });
    if (readOnly && preflight.storeState === "valid") {
      store = openControlStoreReadOnly({ paths });
    } else if (!readOnly && preflight.repositoryState === "fresh_afl_eligible") {
      try {
        await runGuardCommand({
          args: parsed.commandArgs,
          repoRoot: parsed.repoRoot,
          preflight,
          probeContext,
          contextStore
        });
      } catch (error) {
        if (error?.code !== "control_store_required") throw error;
      }
      store = initializeControlStore({ paths });
    } else if (!readOnly && preflight.repositoryState === "afl_sqlite") {
      store = openControlStore({ paths });
    }
    const result = await runGuardCommand({
      args: parsed.commandArgs,
      repoRoot: parsed.repoRoot,
      store,
      preflight,
      probeContext,
      contextStore,
      launchProbe: ({ taskUid, fingerprint }) => launchDetachedConvergenceProbe({
        platform: process.platform,
        nodeExecutable: process.execPath,
        cliFile: CLI_FILE,
        home: parsed.home,
        taskUid,
        fingerprint
      })
    });
    if (!readOnly && store && contextStore) {
      try {
        await contextStore.pruneOrphans(store.getLiveConvergenceProbeContextDigests());
      } catch {}
    }
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
