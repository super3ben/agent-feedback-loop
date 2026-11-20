/**
 * An offline pass over published lessons: re-read them, find what no longer
 * holds, and say so.
 *
 * Why this exists. A lesson is written once, at the moment of the complaint, by
 * a reviewer that saw a partial conversation. Nothing ever looks at it again.
 * Measured on a live project this session: 22 published families, 18 of them
 * absent from the always-on channel for months while the same mistakes kept
 * recurring, and a project memory file whose index still said "key auth works
 * since 2026-09-11" two months after the body had been corrected to say it was
 * dead. Memory that is never re-read does not decay honestly — it becomes a
 * confident liar, and a confident liar is worse than a blank page.
 *
 * The constraint that shapes everything here: A DOCUMENT'S BYTES ARE ITS
 * IDENTITY. `documentHash = sha256(bytes)` keys `reflection_emissions`, which is
 * how the system knows a lesson was delivered and refrains from delivering it
 * twice in one session. Rewriting a file in place silently detaches it from its
 * own delivery history, and `publicationForIdentity` will refuse to publish that
 * reflection_id again. So this pass NEVER rewrites. It reports, and with
 * `--apply` it tags. A rewrite needs a revision path that records the old hash,
 * which is a different feature and not one to build by accident.
 *
 * The second constraint: a path that no longer exists is only evidence of drift
 * if the lesson really cited it. The extraction below is deliberately narrow and
 * drops anything that looks like a placeholder, so a false positive is rare and
 * the report can be trusted.
 */

/** Extensions a lesson is likely to cite by name. */
const PATH_EXTENSION = /\.(?:mjs|cjs|js|ts|tsx|jsx|vue|json|ya?ml|toml|md|sh|py|rb|go|rs|java|sql|html|css|scss)$/iu;

/** Directories that are never part of a project's own source. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "target",
  ".next", ".nuxt", "coverage", "__pycache__", ".venv", "venv", ".cache"
]);

/**
 * Paths a lesson mentions that a reader would act on.
 *
 * Two shapes: an inline code span that looks like a path, and a bare token with
 * a separator and a known extension. Everything ambiguous is dropped rather than
 * guessed — a finding that names the wrong file costs more attention than the
 * check saves.
 *
 * @param {string[]} texts
 * @returns {string[]} unique, project-relative or absolute
 */
export function extractCitedPaths(texts) {
  const found = new Set();
  for (const text of Array.isArray(texts) ? texts : [texts]) {
    const source = String(text ?? "");
    if (!source) continue;

    const push = (raw) => {
      const value = String(raw ?? "").trim().replace(/^["'`]|["'`]$/gu, "");
      if (!value) return;
      // Placeholders and globs describe a shape, not a file that can be checked.
      if (/[<>*${}?]/u.test(value)) return;
      if (/^[a-z]+:\/\//iu.test(value)) return;
      if (!PATH_EXTENSION.test(value)) return;
      found.add(value);
    };

    // Inline code spans are the reviewer's own way of naming a file.
    for (const match of source.matchAll(/`([^`\n]{3,200})`/gu)) push(match[1]);
    // Bare tokens: must contain a separator AND an extension, so a bare
    // `package.json` (which may be mentioned without a directory) still counts
    // but a word like `e.g` does not.
    for (const match of source.matchAll(/(?:^|[\s(（])((?:\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)+\.\w{1,8})(?=[\s)）`，,。]|$)/gu)) {
      push(match[1]);
    }
  }
  return [...found];
}

/**
 * A bounded search of the project for a file name, used to tell "moved" from
 * "gone". Without this the report can only say a path is missing, which is a
 * worse diagnosis than it should be: most drift is a rename, not a deletion.
 *
 * Bounded on purpose. An unbounded walk of a large project on every dream run is
 * how a maintenance command becomes something nobody runs.
 *
 * @param {{root: string, basename: string, maxEntries?: number}} params
 * @returns {Promise<string[]>} absolute paths found, at most a few
 */
export async function findByName({ root, basename, maxEntries = 20_000 }) {
  const { readdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const matches = [];
  let visited = 0;
  const queue = [root];
  while (queue.length && visited < maxEntries) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited >= maxEntries) break;
      if (entry.name === basename && entry.isFile()) matches.push(path.join(dir, entry.name));
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        // `.` prefixed directories are almost always tooling state, and the one
        // that matters here (`.agent`) is the lesson store itself, not source.
        if (entry.name.startsWith(".") && entry.name !== ".github") continue;
        queue.push(path.join(dir, entry.name));
      }
    }
  }
  return matches;
}

/** Character trigrams of a normalised string, for near-duplicate detection. */
function trigrams(value) {
  const normalised = String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\s\p{P}]/gu, "");
  const points = Array.from(normalised);
  const grams = new Set();
  for (let index = 0; index + 2 < points.length; index += 1) {
    grams.add(`${points[index]}${points[index + 1]}${points[index + 2]}`);
  }
  return grams;
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * Two lessons that say the same thing in different words.
 *
 * Read-time merging already collapses documents whose `class_of_mistake` shares
 * an exact 60-character prefix. It cannot see the same class worded two ways,
 * and that is the pair worth finding: both spend budget in the always-on index,
 * and both match the same prompts.
 *
 * Same-family pairs are excluded — those are supersession, which
 * `mergeReflectionDocuments` already handles.
 *
 * @param {Array<object>} documents
 * @param {{threshold?: number}} [options]
 */
export function findNearDuplicates(documents, { threshold = 0.62 } = {}) {
  const usable = (Array.isArray(documents) ? documents : [])
    .filter((document) => document && document.canonical !== false && document.familyId)
    .map((document) => ({
      document,
      family: document.familyId,
      className: document.classOfMistake ?? "",
      grams: trigrams(document.classOfMistake ?? "")
    }))
    .filter((entry) => entry.grams.size >= 12);

  const pairs = [];
  for (let left = 0; left < usable.length; left += 1) {
    for (let right = left + 1; right < usable.length; right += 1) {
      if (usable[left].family === usable[right].family) continue;
      const score = jaccard(usable[left].grams, usable[right].grams);
      if (score < threshold) continue;
      pairs.push({
        score: Number(score.toFixed(3)),
        left: { family: usable[left].family, path: usable[left].document.path },
        right: { family: usable[right].family, path: usable[right].document.path },
        leftClass: usable[left].className.slice(0, 80),
        rightClass: usable[right].className.slice(0, 80)
      });
    }
  }
  return pairs.sort((first, second) => second.score - first.score);
}

/**
 * The full pass.
 *
 * Every check is deterministic and read-only. `apply` only ever writes a tag
 * into a sidecar report — it does not touch a document, because a document's
 * bytes are the key to its delivery history.
 *
 * @param {object} params
 * @param {string} params.projectDir
 * @param {Array<object>} params.documents - parsed catalog
 * @param {Array<{path: string, omission: string}>} [params.omissions]
 * @param {boolean} [params.checkPaths] - resolving paths needs the disk; slow on big trees
 */
export async function dreamOverReflections({
  projectDir,
  documents = [],
  omissions = [],
  checkPaths = true
} = {}) {
  const { stat } = await import("node:fs/promises");
  const path = await import("node:path");

  const findings = [];

  // --- Check 0: documents the catalog cannot read at all -------------------
  //
  // These are invisible to every channel — no index line, no section, no
  // selection. Nothing downstream can reason about a document the parser
  // rejected, and the failure is total rather than partial, so it goes first.
  const PERMANENT = new Set(["canonical_invalid", "legacy_incomplete", "invalid_utf8", "file_too_large"]);
  for (const omission of omissions) {
    if (!PERMANENT.has(omission.reason)) continue;
    findings.push({
      kind: "unreadable_document",
      reason: omission.reason,
      path: omission.path ?? null,
      action: "report_only",
      note: "解析器读不出这篇；所有注入通道都看不到它。修格式，不要删。"
    });
  }

  // --- Check A: a cited path that is gone or moved --------------------------
  if (checkPaths) {
    for (const document of documents) {
      const cited = extractCitedPaths([
        ...(document.methodChanges ?? []),
        document.rootCause ?? "",
        document.classOfMistake ?? "",
        ...(document.facts ?? [])
      ]);
      if (!cited.length) continue;
      for (const value of cited) {
        const absolute = path.isAbsolute(value) ? value : path.join(projectDir, value);
        // A path outside the project is not this project's drift to judge.
        if (!absolute.startsWith(projectDir)) continue;
        let exists = true;
        try {
          await stat(absolute);
        } catch {
          exists = false;
        }
        if (exists) continue;
        const basename = path.basename(absolute);
        const candidates = await findByName({ root: projectDir, basename });
        findings.push({
          kind: candidates.length === 1 ? "path_moved" : candidates.length === 0 ? "path_gone" : "path_gone_ambiguous",
          family: document.familyId,
          document: document.path,
          cited: value,
          suggested: candidates.length === 1 ? path.relative(projectDir, candidates[0]) : null,
          candidateCount: candidates.length,
          action: candidates.length === 0 ? "demote_after_review" : "report_only",
          note: "教训里引用的文件已经不在原位；按旧路径执行的 agent 会找不到。"
        });
      }
    }
  }

  // --- Check C: two families that say the same thing -----------------------
  for (const pair of findNearDuplicates(documents)) {
    findings.push({
      kind: "near_duplicate",
      score: pair.score,
      left: pair.left,
      right: pair.right,
      action: "merge_after_review",
      note: "两个家族描述同一类错误；它们在索引里各占一行，也在匹配时互相抢分。"
    });
  }

  // --- Check D: instructions with nothing to act on ------------------------
  //
  // Pure text, no disk. Reported here rather than fixed here: rewriting a
  // lesson is a review decision, and the bytes are the document's identity.
  for (const vague of findVagueInstructions(documents)) findings.push(vague);

  const byKind = {};
  for (const finding of findings) byKind[finding.kind] = (byKind[finding.kind] ?? 0) + 1;

  return {
    projectDir,
    documents: documents.length,
    findings,
    totals: { findings: findings.length, byKind },
    // Stated in the output so nobody reads a clean report as "the lessons are
    // true". These checks cover file drift and wording drift. They cannot tell
    // whether a lesson's claim about the world still holds.
    coverage: [
      "检查了文件引用是否还在原位",
      "检查了不同家族是否在说同一件事",
      "检查了有没有文档根本读不出来",
      "未检查：教训里关于行为的断言是否仍然成立（需要对照原始会话，是另一个任务）"
    ]
  };
}

/**
 * A method change that says nothing the agent could not have worked out for
 * itself.
 *
 * Measured on a live project: 78% of usable lessons describe a direction
 * ("用密码登录") rather than an action ("ssh -o PubkeyAuthentication=no …").
 * A direction is re-derivable from the repository in the time it takes to read
 * it, so it does not need to be remembered — and, worse, it occupies a line in
 * the channel that runs on every turn.
 *
 * The test is deliberately crude: does the sentence contain any ANCHOR — a
 * backticked span, a path, a flag, an identifier, a quoted literal, a number
 * with a unit? A sentence with none of those is advice, not an instruction.
 *
 * Crude is the point. A cleverer classifier would disagree with its own author
 * about borderline cases; this one produces a list a human can scan in a minute,
 * and every entry on it is genuinely vague.
 *
 * @param {string} value
 * @returns {boolean} true when the sentence has no concrete anchor
 */
export function looksReDerivable(value) {
  const text = String(value ?? "").trim();
  if (text.length < 8) return true;

  const anchors = [
    /`[^`]+`/u,                                   // a code span: the reviewer's own way of being concrete
    /\b[\w.@-]+(?:\/[\w.@-]+)+\b/u,               // a path
    /\s--?[A-Za-z][\w-]*/u,                       // a flag: --foo / -x
    /\b[a-z]+[A-Z]\w+\b/u,                        // camelCase identifier
    /\b[a-z]+_[a-z_]+\b/u,                        // snake_case identifier
    /\b[A-Z][A-Z0-9_]{2,}\b/u,                    // CONSTANT
    /\b\d+(?:\.\d+)?\s*(?:ms|s|秒|分钟|小时|天|次|条|个|字节|KB|MB|GB|px|%)/iu, // a quantity
    /\{[a-z_][a-z0-9_]*\}/iu,                     // a template with named slots: cache:{tenant}:{id}
    /[「"'][^」"']{2,}[」"']/u                    // a quoted literal
  ];
  return !anchors.some((pattern) => pattern.test(text));
}

/**
 * Adds "this instruction cannot be acted on" findings.
 *
 * Kept separate from dreamOverReflections so it can be run over the whole corpus
 * without touching the disk — it is pure text.
 *
 * @param {Array<object>} documents
 * @returns {Array<object>}
 */
export function findVagueInstructions(documents) {
  const findings = [];
  for (const document of Array.isArray(documents) ? documents : []) {
    const changes = (document?.methodChanges ?? []).filter((entry) => String(entry ?? "").trim());
    if (!changes.length) continue;
    const vague = changes.filter(looksReDerivable);
    // Only report when EVERY instruction is vague. One concrete instruction is
    // enough for the lesson to be actionable, and flagging the other entries
    // would bury the lessons that need attention under the ones that do not.
    if (vague.length !== changes.length) continue;
    findings.push({
      kind: "vague_instruction",
      family: document.familyId,
      document: document.path,
      sample: String(vague[0]).slice(0, 100),
      action: "rewrite_after_review",
      note: "这条教训的每一条方法都只是方向，没有命令/路径/参数；重启会话后 agent 自己也能推出来。"
    });
  }
  return findings;
}
