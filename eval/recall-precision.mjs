#!/usr/bin/env node
/**
 * Recall and precision of lesson selection, on a labelled corpus.
 *
 * Recall asks: when the user hits a known class of problem, is its lesson
 * selected? Precision asks the other half: does an unrelated request stay clear
 * of lessons that do not apply? They fail independently — a selector that
 * returns everything scores 100% recall and is useless.
 *
 * The corpus is deliberately small and hand-labelled. It is a regression guard,
 * not an estimator of real-world accuracy: the numbers here say "this still
 * behaves as it did when it was fixed", not "this is how well it works in
 * production". Production behaviour is measured by session-recurrence.mjs.
 *
 * Measured against the path production actually uses. Two earlier versions of
 * this file measured paths that no longer existed: one required a "reads as a
 * complaint" gate that has since been removed, so every positive case that the
 * gate held back was reported as a selector failure. A harness that exercises a
 * different code path than the one shipped reports on nothing but itself.
 *
 * Usage: node eval/recall-precision.mjs [--verbose]
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const SRC = (name) => path.join(PROJECT_ROOT, "src", name);

const { parseLayeredBlock, selectL1Sections } =
  await import(SRC("lesson-layers.mjs"));
const { loadReflectionDocuments, selectReflections } = await import(SRC("selector.mjs"));
const { deriveReviewerFamilyId } = await import(SRC("reviewer-result.mjs"));

const projectDir = process.env.AFL_EVAL_PROJECT
  ?? "/Users/sunxingda/project/rcs-2000-agent";
const verbose = process.argv.includes("--verbose");

// A lesson "applies" when its subject is credentials/SSH. The corpus is built
// around that one class because it is the one with a documented history of
// failing to reach the prompt; other classes are covered by the regression suite.
const SUBJECT = /ssh|SSH|BatchMode|凭据|credential|密码认证|密钥/i;

const SHOULD_MATCH = [
  // The host is a documented placeholder, not a real address: this corpus is
  // committed to a public repository, and a real internal IP in a fixture leaks
  // no matter how carefully the runtime handles it.
  "连 127.0.0.1 的时候用密码，别用密钥",
  "别用密钥，用密码",
  "以后都用密码登录",
  "又不知道用ssh密码",
  "这个会话又出现不知道用ssh密码",
  "为什么又问我密码 ssh 连不上",
  "ssh 连不上，之前密码不是给过你吗",
  "这个服务器怎么又连不上，密码不是给过你了吗",
  "ssh怎么又登录不上，其他会话都有在部署服务你怎么又会登录不上呢",
  "不是有密码吗之前不是都登录上去了吗怎么又会忘记密码",
  "为啥要免密登录呢，不是有密码吗？",
  "帮我用 ssh 连上 127.0.0.1，密码之前给过你",
  "ssh root@127.0.0.1 连接一下，密码之前给过你",
  "这台机器要用密码登录，别用免密",
  "为什么不直接用ssh连接？账号密码都给你了",
  "试试用生产 SSH 脚本连接，之前不是账号密码端口都跟你说过",
  "ssh不能登录吗，别跟我说又不知道账号密码",
  "连一下 127.0.0.1 那台服务器",
];

const SHOULD_NOT_MATCH = [
  "把这个汇总报告存到 docs/ 下",
  "继续做审美的也一样做完",
  "帮我看看这个文件",
  "写一个 README",
  "跑一下测试",
  "重构这个模块，拆成两个文件",
  "加一个接口，返回用户列表",
  "这个报表的数字不对，重新算一遍",
  "页面样式全乱了，按钮都错位了",
  "构建失败了，看看日志",
  "Excel 解析出来是空的",
  "worktree 创建失败了",
  "这个 token 过期了，换一个",
];

const text = await readFile(path.join(projectDir, ".agent", "rules", "feedback-loop.md"), "utf8");
const start = text.indexOf("<!-- afl:rules:start -->") + "<!-- afl:rules:start -->".length;
const end = text.indexOf("<!-- afl:rules:end -->");
const parsed = parseLayeredBlock(text.slice(start, end).trim());

const { documents } = await loadReflectionDocuments({
  projectDir,
  publishedBefore: new Date().toISOString()
});
const familyKeyOf = (document) => {
  try {
    return deriveReviewerFamilyId(document.methodClass, document.familyId);
  } catch {
    return null;
  }
};

function inspect(prompt) {
  const l1 = selectL1Sections({ l1: parsed.l1, prompt });
  const covered = new Set((l1.selected ?? []).map((section) => section.familyKey).filter(Boolean));
  const selection = selectReflections({
    documents,
    prompt,
    // Production passes the recent conversation alongside the message. Omitting
    // it here would measure a path that only runs on a session's first turn.
    context: "",
    session: {},
    task: {},
    budget: { maxCards: 4, maxDocumentTokens: 640, maxTotalTokens: 1600 },
    publishedBefore: new Date().toISOString(),
    familyRecurrence: {},
    coveredFamilies: covered,
    familyKeyOf
  });
  const matching = selection.selected.filter((document) => SUBJECT.test(
    JSON.stringify(document.appliesWhen)
    + (document.classOfMistake ?? "")
    + (document.methodChanges ?? []).join(" ")
  ));
  return { matching, l1: [...covered], selected: selection.selected.length };
}

const positiveRows = SHOULD_MATCH.map((prompt) => ({ prompt, ...inspect(prompt) }));
const negativeRows = SHOULD_NOT_MATCH.map((prompt) => ({ prompt, ...inspect(prompt) }));

// No gate. The complaint gate was removed from selection because it held back
// exactly the turns a lesson was written for — 「部署上去」 right after a lesson
// about deploy verification. What remains is the match itself, so that is what
// this measures.
const recalled = positiveRows.filter((row) => row.matching.length > 0).length;
const clean = negativeRows.filter((row) => row.matching.length === 0).length;

const pct = (part, whole) => (whole === 0 ? 0 : Math.round((100 * part) / whole));

console.log("=== 召回与精确（标注语料）===\n");
console.log(`召回率:  ${recalled}/${SHOULD_MATCH.length}  ${pct(recalled, SHOULD_MATCH.length)}%  (命中对应教训)`);
console.log(`精确率:  ${clean}/${SHOULD_NOT_MATCH.length}  ${pct(clean, SHOULD_NOT_MATCH.length)}%  (无关请求不命中)`);
const noise = negativeRows.reduce((total, row) => total + row.selected, 0);
console.log(`无关请求平均选出: ${(noise / SHOULD_NOT_MATCH.length).toFixed(2)} 篇`);

const missed = positiveRows.filter((row) => row.matching.length === 0);
const falsePositive = negativeRows.filter((row) => row.matching.length > 0);

if (missed.length) {
  console.log(`\n未命中 ${missed.length} 条:`);
  for (const row of missed) {
    console.log(`  ✗ 选出 ${row.selected} 篇但无对应教训: ${row.prompt}`);
  }
}
if (falsePositive.length) {
  console.log(`\n误报 ${falsePositive.length} 条:`);
  for (const row of falsePositive) {
    console.log(`  ✗ ${row.prompt}  → 命中 ${row.matching.length} 篇`);
  }
}
if (verbose) {
  console.log("\n=== 全部明细 ===");
  for (const [kind, rows] of [["应命中", positiveRows], ["应不命中", negativeRows]]) {
    console.log(`--- ${kind} ---`);
    for (const row of rows) {
      console.log(`  ${row.matching.length ? "命中" : "    "} | 共 ${row.selected} 篇 | ${row.prompt}`);
    }
  }
}
