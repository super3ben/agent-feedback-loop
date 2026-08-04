import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// Environment locale is not the signal. This machine reports LANG=en_US.UTF-8
// while 12 of its 15 published lessons carry Chinese titles: the locale says
// what the shell was configured with, not what the person actually writes in.
// So the language is read from what the project has accumulated.
const CJK = /[㐀-䶿一-鿿]/u;
const SAMPLE_LIMIT = 40;

export const LANGUAGES = Object.freeze(["en", "zh"]);

/**
 * Explicit choice wins. Returns null for anything unrecognised so a typo falls
 * through to detection rather than silently selecting a language.
 */
export function normalizeLanguage(value) {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  if (lower === "zh" || lower.startsWith("zh-") || lower === "cn" || lower === "chinese") return "zh";
  if (lower === "en" || lower.startsWith("en-") || lower === "english") return "en";
  return null;
}

/**
 * Which language the project's own lessons are written in. Reads titles rather
 * than whole documents: a lesson body quotes code and command output, so it is
 * full of ASCII regardless of who wrote it, while the title is prose.
 *
 * Falls back to English when there is nothing to read — a first run has no
 * evidence, and guessing Chinese for everyone would be worse than a neutral
 * default that the --lang flag can override.
 */
export async function detectLanguageFromLessons(reflectionsDir) {
  let names = [];
  try {
    names = (await readdir(reflectionsDir)).filter((name) => name.endsWith(".md"));
  } catch {
    return "en";
  }
  if (!names.length) return "en";
  let chinese = 0;
  let counted = 0;
  for (const name of names.slice(0, SAMPLE_LIMIT)) {
    try {
      const text = await readFile(path.join(reflectionsDir, name), "utf8");
      const title = text.split("\n", 1)[0] ?? "";
      counted += 1;
      if (CJK.test(title)) chinese += 1;
    } catch {}
  }
  if (!counted) return "en";
  return chinese * 2 > counted ? "zh" : "en";
}

/**
 * The language to report in: an explicit flag, otherwise what the project writes.
 */
export async function resolveLanguage({ explicit = null, reflectionsDir } = {}) {
  const chosen = normalizeLanguage(explicit);
  if (chosen) return chosen;
  return detectLanguageFromLessons(reflectionsDir);
}

// Only prose is translated. Paths, command names, tool names, CLI ids and state
// codes stay verbatim: they are identifiers a reader has to type or grep for,
// and a translated `reviewed_no_lesson` would match nothing in the store.
const STRINGS = Object.freeze({
  en: Object.freeze({
    statusTitle: "agent-feedback-loop status",
    guardHeading: (count) => `Guard — ${count} sessions observed`,
    guardBlocked: "blocked at least once",
    guardDispatched: "review dispatched",
    guardCorrected: "direction corrected",
    guardEscalated: "escalated to a person",
    guardRecent: "Most recent blocks (newest first, no timestamps recorded):",
    calls: (n) => `${n} calls`,
    blocks: (n) => `${n} block${n === 1 ? "" : "s"}`,
    artifacts: (n) => `${n} artifact${n === 1 ? "" : "s"}`,
    corrected: (n) => `${n} corrected`,
    review: (state) => `review ${state}`,
    verdictLabel: "verdict",
    reviewsHeading: (count) => `Reviews — ${count} jobs`,
    reviewsRecent: "Most recent:",
    declinesHeading: "Declined reviews — what was looked at and why it was not published:",
    declineWhy: "why not",
    declineQualify: "would qualify if",
    declineNoRecord: "(no reasoning recorded — this review predates the change that keeps it)",
    lessonsHeading: (count, dir) => `Lessons — ${count} published in ${dir}`,
    lessonsNone: "(none here — lessons are written per project, so run this from a project directory)",
    installed: "agent-feedback-loop installed",
    installDryRun: "agent-feedback-loop install dry-run",
    uninstalled: "agent-feedback-loop uninstalled",
    uninstallDryRun: "agent-feedback-loop uninstall dry-run"
  }),
  zh: Object.freeze({
    statusTitle: "agent-feedback-loop 状态",
    guardHeading: (count) => `守卫 — 已观察 ${count} 个会话`,
    guardBlocked: "至少拦截过一次",
    guardDispatched: "已派发独立评审",
    guardCorrected: "方向已纠正",
    guardEscalated: "已转交给人处理",
    guardRecent: "最近的拦截（新的在前，记录未保存时间）：",
    calls: (n) => `${n} 次工具调用`,
    blocks: (n) => `拦截 ${n} 次`,
    artifacts: (n) => `涉及 ${n} 个文件`,
    corrected: (n) => `纠正 ${n} 次`,
    review: (state) => `评审 ${state}`,
    verdictLabel: "判定",
    reviewsHeading: (count) => `评审 — 共 ${count} 个作业`,
    reviewsRecent: "最近的：",
    declinesHeading: "未沉淀的评审 —— 看了什么、为什么没落成文档：",
    declineWhy: "不沉淀的原因",
    declineQualify: "什么情况下会改判",
    declineNoRecord: "（未记录理由 —— 这次评审早于该功能上线）",
    lessonsHeading: (count, dir) => `沉淀 — ${dir} 下已发布 ${count} 篇`,
    lessonsNone: "（此处没有 — 沉淀按项目存放，请在项目目录下运行）",
    installed: "agent-feedback-loop 安装完成",
    installDryRun: "agent-feedback-loop 安装预演",
    uninstalled: "agent-feedback-loop 卸载完成",
    uninstallDryRun: "agent-feedback-loop 卸载预演"
  })
});

export function strings(language) {
  return STRINGS[language] ?? STRINGS.en;
}

/**
 * Pads to a display width rather than a character count. A CJK glyph occupies
 * two terminal columns, so String.padEnd — which counts characters — leaves
 * Chinese labels visibly ragged while English ones line up.
 */
export function padLabel(label, width) {
  const text = String(label);
  let columns = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    columns += (code >= 0x1100 && (code <= 0x115f
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6))) ? 2 : 1;
  }
  return text + " ".repeat(Math.max(0, width - columns));
}
