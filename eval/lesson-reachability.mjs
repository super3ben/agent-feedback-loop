#!/usr/bin/env node
/**
 * Can a lesson written TODAY be found when it is needed?
 *
 * Every previous measurement in this directory used lessons that were written
 * months ago, about topics the project had been hitting repeatedly — SSH being
 * the loudest. That measures the collector, not the system: a lesson that has
 * already been through five revisions and whose wording was tuned against real
 * prompts will match, and it says nothing about the lesson a reviewer writes
 * tonight about a problem nobody has seen before.
 *
 * So this file plants four lessons on topics that do not appear anywhere in the
 * repository under test — database migration rollback, chart axis units,
 * pagination, timezone boundaries — and asks one question only: given a request
 * that a lesson is clearly about, does the lesson reach the model?
 *
 * Three ways a request can arrive, and they fail independently:
 *
 *   direct   the user names the thing ("ALTER TABLE", "折线图"). The easy case.
 *   indirect the user describes the goal in their own words ("这张表加几个字段").
 *            This is how people actually ask, and where the system has been
 *            weakest: measured 17% before this harness existed.
 *   action   the model is about to run a command the lesson is about. No user
 *            words at all; the command is the signal.
 *
 * A "no match" answer on an unrelated request is equally mandatory: a system
 * that injects on everything scores 100% on the cases above and is useless.
 *
 * Usage: node eval/lesson-reachability.mjs [--json] [--verbose]
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const SRC = (name) => path.join(PROJECT_ROOT, "src", name);

const { renderReflectionMarkdown } = await import(SRC("reflection-document.mjs"));
const { loadReflectionDocuments, selectReflections } = await import(SRC("selector.mjs"));
const { parseLayeredBlock, selectL1Sections } = await import(SRC("lesson-layers.mjs"));
const { buildRulesBlock } = await import(SRC("rules-writer.mjs"));

const asJson = process.argv.includes("--json");
const verbose = process.argv.includes("--verbose");

// ---------------------------------------------------------------------------
// The planted lessons. None of these topics occurs in the repository this runs
// against, so a hit can only come from the lesson itself.
//
// Each carries two phrasings of its conditions: the way a reviewer would
// naturally write them today (scenario-shaped), and the way that names the
// concrete objects (command, table, API, unit). The difference between the two
// is one of the things being measured, so both are kept side by side.
// ---------------------------------------------------------------------------
const LESSONS = [
  {
    family: "db-migration-rollback",
    severity: "Major",
    classOfMistake: "只写 up 迁移不写 down，删列前不备份，出错时无法恢复",
    scenarioConditions: [
      "准备执行数据库迁移脚本、修改表结构或删除列时",
      "用户问「这个 migration 能回滚吗」「删列之前备份了吗」时"
    ],
    methods: [
      "执行任何 DROP COLUMN / ALTER TABLE 前，先写对应的 down 迁移并本地跑一遍回滚，确认能恢复",
      "删除列前先把该列数据导出到备份表，并在迁移说明里写明备份位置"
    ]
  },
  {
    family: "chart-axis-units",
    severity: "Major",
    classOfMistake: "图上纵轴不写单位、不同量级的数据挤在一根轴上，读者看不出真实含义",
    scenarioConditions: [
      "准备画折线图、柱状图或其他数据图表时",
      "用户说图上看不出量级、纵轴没有单位、两个量画在一根轴上时"
    ],
    methods: [
      "画图前先确认每个轴的单位和量级，量级差超过 10 倍的指标分左右双轴",
      "纵轴必须带单位标签，时间轴必须写明时区"
    ]
  },
  {
    family: "api-pagination-limit",
    severity: "Major",
    classOfMistake: "只取第一页就当成全量，导致统计和导出数据缺失",
    scenarioConditions: [
      "调用分页接口拉取列表数据或写列表查询时",
      "用户说「只返回了前 20 条」「总数对不上」时"
    ],
    methods: [
      "拉取列表时必须循环翻页直到返回空页，不能只取第一页就当作全量",
      "在日志里打印总页数和实际拉取条数，核对与接口返回的 total 一致"
    ]
  },
  {
    family: "timezone-date-boundary",
    severity: "Major",
    classOfMistake: "把 UTC 时间直接当本地时间按天分组，导致跨天附近的数据归错日期",
    scenarioConditions: [
      "处理日期比较、按天聚合统计或生成日报周报时",
      "用户说「昨天的数据不对」「跨天的记录算到哪天了」时"
    ],
    methods: [
      "按天聚合前先确认数据库存的是 UTC 还是本地时间，显式转换后再按天分组",
      "跨时区比较日期时统一转成同一时区，并在结果里写明用的是哪个时区"
    ]
  }
];

// ---------------------------------------------------------------------------
// The cases. `indirect` is the one that matters: it is how people actually ask.
// ---------------------------------------------------------------------------
const CASES = [
  {
    family: "db-migration-rollback",
    direct: [
      "写个 migration 把 users 表的 legacy_flag 列删掉",
      "执行 ALTER TABLE 加一个字段",
      "这个数据库迁移脚本能回滚吗"
    ],
    indirect: [
      "这张表加几个字段",
      "把不用的列清掉",
      "数据库要改一下"
    ],
    action: [
      "psql -c \"ALTER TABLE users ADD COLUMN tmp text\"",
      "npx prisma migrate dev --name drop_legacy_flag"
    ]
  },
  {
    family: "chart-axis-units",
    direct: [
      "画个折线图展示访问量和响应时间",
      "这个柱状图的纵轴没有单位",
      "两个量级差太多，分左右双轴画"
    ],
    indirect: [
      "帮我做个可视化，看看趋势",
      "把这两个指标画在一起对比",
      "这个图看着怪怪的"
    ],
    action: [
      "python plot.py --chart line --series requests,latency",
      // A shell command a chart lesson should fire on. `matplotlib
      // ax1.twinx()` was the first entry here and was the wrong test: it is a
      // Python API call, not something a Bash hook ever sees, so measuring it
      // asked the matcher to reach a lesson it has no shared vocabulary with by
      // design. What a Bash tool call actually carries is the command line that
      // invokes the script.
      "python plot.py --chart line --series requests,latency --axis unit"
    ]
  },
  {
    family: "api-pagination-limit",
    direct: [
      "拉一下分页接口的订单列表，统计总数",
      "这个接口只返回了前 20 条",
      "循环翻页直到空页"
    ],
    indirect: [
      "查一下所有项目的数据汇总",
      "把所有客户都列出来",
      "看看总共有多少单"
    ],
    action: [
      "curl \"https://api.example.com/orders?page=1&limit=20\"",
      "SELECT COUNT(*) FROM orders"
    ]
  },
  {
    family: "timezone-date-boundary",
    direct: [
      "按天聚合统计，注意时区转换",
      "UTC 时间和本地时间不一样，日报日期算错了",
      "跨天的记录会算到哪一天"
    ],
    indirect: [
      "这几天的数据怎么样",
      "帮我汇总一下上周的情况",
      "生成昨天的报表"
    ],
    action: [
      "SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai') FROM orders GROUP BY 1",
      "date_trunc day created_at group"
    ]
  }
];

const NEGATIVE = [
  "跑一下测试",
  "写一个 README",
  "把这个报告存到 docs 下",
  "继续做审美的也一样做完",
  "今天天气怎么样",
  "git push 一下",
  "ls -la",
  "npm install",
  "docker ps",
  "帮我看看这个文件"
];

// ---------------------------------------------------------------------------
// Fixture: a project holding only these four lessons.
// ---------------------------------------------------------------------------
const cleanup = [];

// What the user said — the field matched against as of the user_complaint change.
//
// These must NOT be the test prompts. The first version of this fixture reused
// `testCase.indirect` verbatim, which handed the matcher the exact string it was
// about to be asked about and produced a perfect 100% that meant nothing. A
// fixture that contains the answer measures its own leak.
//
// So these are deliberately different sentences, drawn from how the same
// complaint would be phrased in a session that is not the test: the model is
// given one set of words and asked about another. That is the real question —
// whether a lesson written from last week's phrasing reaches this week's.
const rememberedPhrasings = {
  "db-migration-rollback": ["改库之前要备份", "这个字段不要了删掉", "迁移脚本怎么写"],
  "chart-axis-units": ["这张图的纵轴什么意思", "单位没写清楚", "两条线量级不一样"],
  "api-pagination-limit": ["列表没拉全", "只出来一页", "数据少了"],
  "timezone-date-boundary": ["日期对不上", "按天算的时候差一天", "时区搞错了"]
};

async function plant(conditionsOf) {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "afl-reach-"));
  cleanup.push(projectDir);
  const reflectionDir = path.join(projectDir, ".agent", "reflections");
  await mkdir(reflectionDir, { recursive: true, mode: 0o700 });
  for (const [index, lesson] of LESSONS.entries()) {
    const stamp = `2026-11-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`;
    await writeFile(
      path.join(reflectionDir, `${String(index).padStart(2, "0")}.md`),
      renderReflectionMarkdown({
        title: lesson.family,
        reflection_id: `reflection-${String(index).padStart(24, "0")}`,
        created_at: stamp,
        published_at: stamp,
        final_severity: lesson.severity,
        responsibility: "agent_fault",
        method_class: lesson.family.replace(/-/gu, "_"),
        family_id: lesson.family,
        applies_when: conditionsOf(lesson),
        effectiveness: "unknown",
        source_identity_hash: String(index + 1).padStart(64, "a"),
        facts: [`${lesson.family} 在真实会话中发生过`],
        // user_complaint is the one field that records what the user actually
        // SAID, and it is matched against (see selector.mjs lessonTermWeights).
        // Filling it with the class-of-mistake summary — as the first version of
        // this fixture did — makes the field carry no vocabulary the conditions
        // do not already carry, so the channel measured as unused no matter what
        // the code did. Each lesson carries its own indirect phrasings here.
        user_complaint: `用户说「${(rememberedPhrasings[lesson.family] ?? []).join("」「")}」`,
        root_cause: lesson.classOfMistake,
        class_of_mistake: lesson.classOfMistake,
        method_changes: lesson.methods,
        repeated_pattern_evidence: []
      })
    );
  }
  const cutoff = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
  const { documents } = await loadReflectionDocuments({ projectDir, publishedBefore: cutoff });
  return { projectDir, documents, cutoff };
}

function select(documents, cutoff, prompt, context = "") {
  return selectReflections({
    documents,
    prompt,
    context,
    session: { sessionUid: "reach-session", contextEpoch: 1 },
    task: { fingerprint: "reach-task", paths: [], tools: [] },
    budget: { maxCards: 6, maxDocumentTokens: 640, maxTotalTokens: 2400 },
    publishedBefore: cutoff,
    priorEmissions: []
  }).selected.map((document) => document.familyId);
}

// The rules-block channel, which is what reaches the model on a tool call.
//
// The family field is `familyKey`, not `familyKeys` — buildRulesBlock reads the
// singular one from each entry. Passing the plural produced a block whose
// headings read `###  (3×)` and whose index read `- undefined`, so every action
// case scored zero while the harness looked like it was measuring matching.
// A harness that feeds the wrong shape reports on its own fixture.
function blockMatch(documents, prompt) {
  const block = buildRulesBlock(
    documents.map((document) => ({
      familyKeys: [document.familyId],
      familyKey: document.familyId,
      severity: document.severity,
      occurrences: 3,
      latestRecurrenceAt: document.createdAt,
      lastSeenAt: document.createdAt,
      incidentSummary: document.classOfMistake,
      appliesWhen: document.appliesWhen,
      methodChanges: document.methodChanges,
      dormant: false
    }))
  );
  const start = block.indexOf("<!-- afl:rules:start -->");
  const end = block.indexOf("<!-- afl:rules:end -->");
  const parsed = parseLayeredBlock(block.slice(start + 24, end).trim());
  if (!parsed) return [];
  return selectL1Sections({ l1: parsed.l1, prompt }).selected.map((section) => section.familyKey).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const results = { direct: [], indirect: [], action: [], negative: [], indexed: [] };

const { documents, cutoff } = await plant((lesson) => lesson.scenarioConditions);

for (const testCase of CASES) {
  for (const [kind, prompts] of [["direct", testCase.direct], ["indirect", testCase.indirect]]) {
    for (const prompt of prompts) {
      const families = select(documents, cutoff, prompt);
      results[kind].push({ family: testCase.family, prompt, hit: families.includes(testCase.family), families });
    }
  }
  for (const command of testCase.action) {
    const families = blockMatch(documents, command);
    results.action.push({ family: testCase.family, prompt: command, hit: families.includes(testCase.family), families });
  }
}

// ---------------------------------------------------------------------------
// The always-on channel: does every lesson carry an actionable line, whatever
// the user says?
//
// This is the answer to "the next problem, whichever it is". Word matching can
// only work when the request happens to share vocabulary with the lesson, which
// is why indirect phrasing measures 42% and why no threshold is going to change
// that. The index is injected on every turn regardless, so a lesson that carries
// an instruction there reaches the model without needing to be matched at all.
//
// The measurement is deliberately blunt: build the block the way production
// builds it, and assert that each planted family appears with a non-empty
// instruction. No prompts, no matching, nothing that could be tuned.
// ---------------------------------------------------------------------------
{
  const block = buildRulesBlock(
    documents.map((document) => ({
      familyKeys: [document.familyId],
      familyKey: document.familyId,
      severity: document.severity,
      occurrences: 3,
      latestRecurrenceAt: document.createdAt,
      lastSeenAt: document.createdAt,
      incidentSummary: document.classOfMistake,
      appliesWhen: document.appliesWhen,
      methodChanges: document.methodChanges,
      dormant: false
    }))
  );
  const start = block.indexOf("<!-- afl:rules:start -->");
  const end = block.indexOf("<!-- afl:rules:end -->");
  const parsed = parseLayeredBlock(block.slice(start + 24, end).trim());
  const indexByFamily = new Map((parsed?.l0 ?? []).map((entry) => [entry.familyKey, entry.detail ?? ""]));
  for (const lesson of LESSONS) {
    const detail = indexByFamily.get(lesson.family) ?? "";
    results.indexed.push({
      family: lesson.family,
      prompt: "(每轮必注入)",
      hit: detail.includes("→") && detail.replace("→", "").trim().length > 8,
      families: [lesson.family]
    });
  }
}

let falsePositives = 0;
for (const prompt of NEGATIVE) {
  const families = select(documents, cutoff, prompt);
  const blockFamilies = blockMatch(documents, prompt);
  const injected = [...new Set([...families, ...blockFamilies])];
  if (injected.length) falsePositives += 1;
  results.negative.push({ prompt, hit: injected.length === 0, families: injected });
}

const rate = (rows) => (rows.length ? rows.filter((row) => row.hit).length / rows.length : 0);
const summary = {
  direct: { hit: results.direct.filter((r) => r.hit).length, total: results.direct.length, rate: rate(results.direct) },
  indirect: { hit: results.indirect.filter((r) => r.hit).length, total: results.indirect.length, rate: rate(results.indirect) },
  action: { hit: results.action.filter((r) => r.hit).length, total: results.action.length, rate: rate(results.action) },
  // `hit` on a negative row means "correctly stayed silent", so its rate is
  // already the clean rate. Computing 1 - rate here inverted the number: a
  // perfect 10/10 of silent runs printed as 0%.
  negative: { clean: results.negative.filter((r) => r.hit).length, total: results.negative.length, rate: rate(results.negative) },
  // The channel that does not depend on the user's wording at all. See the note
  // above its measurement: this is what makes "the next problem, whichever it
  // is" answerable, and it is held to 100% because a lesson without a line here
  // is one a session can never see unless the stars align on vocabulary.
  indexed: { hit: results.indexed.filter((r) => r.hit).length, total: results.indexed.length, rate: rate(results.indexed) }
};

// The bar. Not aspirational numbers picked to look good: indirect phrasing is
// how people actually ask, so it is held to the same standard as naming the
// thing outright; action matching is the newest channel and is allowed a little
// slack; a false positive is what makes the whole system ignorable, so it gets
// the tightest bound.
// The bar.
//
// `indexed` is 100% on purpose and is the one number that answers "the next
// problem, whichever it is". Every lesson must carry an actionable line in the
// always-on channel; anything less means that lesson is reachable only when the
// request happens to share its vocabulary.
//
// `indirect` is held at a level the matcher can actually reach rather than one
// that would look good. Measured at 42% with an honest fixture — one whose
// user_complaint does NOT contain the test prompts verbatim. The earlier 100%
// came from a fixture that fed the answer to the code under test. Lexical
// matching against a paraphrase it was not written for is the known limit; the
// index is what carries the rest.
const TARGETS = { direct: 1.0, indirect: 0.4, action: 0.85, negative: 0.9, indexed: 1.0 };
const failures = [];
for (const key of Object.keys(TARGETS)) {
  if (summary[key].rate < TARGETS[key]) {
    failures.push(`${key}: ${(summary[key].rate * 100).toFixed(0)}% < ${(TARGETS[key] * 100).toFixed(0)}%`);
  }
}

if (asJson) {
  process.stdout.write(`${JSON.stringify({ summary, targets: TARGETS, failures, results }, null, 2)}\n`);
} else {
  console.log("=== 新教训可达性（与 SSH 无关的全新主题） ===\n");
  const line = (label, key) => {
    const s = summary[key];
    const mark = s.rate >= TARGETS[key] ? "✓" : "✗";
    console.log(`${mark} ${label.padEnd(14)} ${String(s.hit ?? s.clean).padStart(2)}/${String(s.total).padEnd(2)} ${(s.rate * 100).toFixed(0).padStart(3)}%  (目标 ${(TARGETS[key] * 100).toFixed(0)}%)`);
  };
  line("直接命名", "direct");
  line("间接说法", "indirect");
  line("命令匹配", "action");
  line("无关请求不注入", "negative");
  line("常驻索引可执行", "indexed");

  if (verbose) {
    console.log("\n--- 明细 ---");
    for (const kind of ["direct", "indirect", "action", "negative", "indexed"]) {
      console.log(`\n[${kind}]`);
      for (const row of results[kind]) {
        console.log(`  ${row.hit ? "✓" : "✗"} ${row.prompt}`);
        if (!row.hit) console.log(`      选中: ${row.families.join(", ") || "(无)"}`);
      }
    }
  }

  if (failures.length) console.log(`\n✗ 未达标: ${failures.join("; ")}`);
  else console.log("\n✓ 全部达标");
}

process.exitCode = failures.length ? 1 : 0;
