import assert from "node:assert/strict";
import { test } from "node:test";

import { compileLessonCard } from "../src/lessons.mjs";
import { applicationId, estimateCardTokens, selectLessons } from "../src/selector.mjs";

const card = (severity, overrides = {}) => ({
  lesson_id: `${severity}-1`, revision: 1, severity, project_id: "project-a", conflict_state: "none",
  lifecycle: "active", enablement: "enabled", load_policy: severity === "Minor" ? "trend_only" : "conditional",
  card: { when: "working on the affected task", must_do: "verify the real artifact", must_not: "claim completion without evidence", verify: "run the registered check", why: "previous delivery missed the evidence", exception: "none", source_ids: ["incident-1"] },
  ...overrides
});

test("lesson compiler rejects a standalone must-not card", () => {
  assert.throws(() => compileLessonCard({ when: "always", must_not: "do not guess" }), /must_do|verify/i);
});

test("selector loads severe lessons by scope and keeps minor lessons trend-only", () => {
  const result = selectLessons({
    lessons: [card("Blocker"), card("Critical"), card("Major", { scope: { task_types: ["review"] } }), card("Minor")],
    session: { session_uid: "s1", context_epoch: 1, project_id: "project-a" },
    task: { project_id: "project-a", fingerprint: "task-1", task_type: "review" },
    budget: 10_000
  });
  assert.deepEqual(result.cards.map((item) => item.severity), ["Blocker", "Critical", "Major"]);
  assert.equal(result.cards.some((item) => item.severity === "Minor"), false);
});

test("Major lessons require a matching task signal and do not load project-wide by default", () => {
  const base = { lessons: [card("Major")], session: { session_uid: "s", context_epoch: 1 }, budget: 10_000 };
  assert.equal(selectLessons({ ...base, task: { project_id: "project-a", fingerprint: "one", prompt: "continue" } }).cards.length, 0);
  const signaled = card("Major", { scope: { signals: ["live verification", "真机验证"] } });
  assert.equal(selectLessons({ ...base, lessons: [signaled], task: { project_id: "project-a", fingerprint: "two", prompt: "请做真机验证" } }).cards.length, 1);
});

test("default local budget is calibrated from complete cards instead of a fixed 320 token guess", () => {
  const chinese = card("Critical", { card: { when: "准备声明功能已经完成时", must_do: "必须读取真实运行结果并保留可核对的证据，然后再给出完成结论", must_not: "不能只依据单元测试或自己构造的数据声称真实链路已经生效", verify: "运行实际入口并核对用户可见输出、运行日志和持久化回执", why: "此前完整中文行动卡被固定预算错误跳过", exception: "宿主明确不可用时必须报告未验证而非伪装成功", source_ids: ["incident-cn"] } });
  assert.ok(estimateCardTokens(chinese.card, "agent feedback memory") > 80);
  const result = selectLessons({ lessons: [chinese], session: { session_uid: "s", context_epoch: 1 }, task: { project_id: "project-a", fingerprint: "cn" } });
  assert.equal(result.cards.length, 1);
  assert.ok(result.budgets.absolute > 320);
});

test("an oversized Major is skipped while an oversized severe card produces a hold", () => {
  const major = selectLessons({ lessons: [card("Major", { scope: { task_types: ["review"] } })], session: { session_uid: "s", context_epoch: 1 }, task: { project_id: "project-a", fingerprint: "major", task_type: "review" }, budget: 1 });
  assert.equal(major.cards.length, 0);
  assert.equal(major.hold, null);
  const severe = selectLessons({ lessons: [card("Critical")], session: { session_uid: "s", context_epoch: 1 }, task: { project_id: "project-a", fingerprint: "critical" }, budget: 1 });
  assert.equal(severe.cards.length, 0);
  assert.equal(severe.hold, "memory_overflow_hold");
});

test("project and promoted global copies of one lesson family are injected only once", () => {
  const local = card("Blocker", { lesson_id: "family-local", family_id: "family-1", project_id: "project-a", promotion_state: "project" });
  const global = card("Blocker", { lesson_id: "family-global", family_id: "family-1", project_id: null, promotion_state: "active_global", revision: 2 });
  const result = selectLessons({ lessons: [local, global], session: { session_uid: "s", context_epoch: 1 }, task: { project_id: "project-a", fingerprint: "family" }, budget: 10_000 });
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].lesson_id, "family-global");
});

test("safety conflict produces a hold instead of silent fail-open", () => {
  const result = selectLessons({
    lessons: [card("Critical", { conflict_state: "safety_hold" })],
    session: { session_uid: "s1", context_epoch: 1, project_id: "project-a" },
    task: { project_id: "project-a", fingerprint: "task-1" },
    budget: 10_000
  });
  assert.equal(result.hold, "safety_hold");
  assert.equal(result.cards.length, 0);
});

test("budget overflow is bounded and application IDs are stable", () => {
  const lesson = card("Blocker", { project_id: "p", card: { when: "a", must_do: "b", must_not: "c", verify: "d", why: "e", exception: "f", source_ids: ["i"] } });
  const result = selectLessons({ lessons: [lesson], session: { session_uid: "s1", context_epoch: 1, project_id: "p" }, task: { project_id: "p", fingerprint: "t" }, budget: 1 });
  assert.equal(result.hold, "memory_overflow_hold");
  assert.equal(applicationId({ sessionUid: "s1", contextEpoch: 1, taskFingerprint: "t", lessonId: "l", revision: 1 }), applicationId({ sessionUid: "s1", contextEpoch: 1, taskFingerprint: "t", lessonId: "l", revision: 1 }));
  assert.ok(estimateCardTokens(lesson.card, "host prefix") > 0);
});

test("selector does not re-emit an already delivered application", () => {
  const lesson = card("Critical");
  const session = { session_uid: "s1", context_epoch: 1, project_id: "project-a" };
  const task = { project_id: "project-a", fingerprint: "t" };
  const id = applicationId({ sessionUid: "s1", contextEpoch: 1, taskFingerprint: "t", lessonId: lesson.lesson_id, revision: 1 });
  const result = selectLessons({ lessons: [lesson], session, task, budget: 10_000, store: { hasDelivery: (candidate) => candidate === id } });
  assert.equal(result.cards.length, 0);
});

test("selector filters lesson cards by task type, path, and tool scope", () => {
  const lesson = card("Critical", { scope: { task_types: ["review"], paths: ["src"], tools: ["pytest"] } });
  const base = { project_id: "project-a", fingerprint: "t", task_type: "review", paths: ["src/store.mjs"], tools: ["pytest"] };
  assert.equal(selectLessons({ lessons: [lesson], session: { session_uid: "s", context_epoch: 1 }, task: base, budget: 10_000 }).cards.length, 1);
  assert.equal(selectLessons({ lessons: [lesson], session: { session_uid: "s", context_epoch: 1 }, task: { ...base, tools: ["npm"] }, budget: 10_000 }).cards.length, 0);
});

test("Major retrieval treats absent host metadata as unknown and matches the action-card trigger locally", () => {
  const lesson = card("Major", {
    lesson_id: "ssh-before-termius",
    scope: {
      task_types: ["remote-environment-testing", "deployment-debugging"],
      paths: [],
      tools: ["ssh", "Termius", "computer-use"],
      signals: ["user says use ssh", "remote host access required"]
    },
    card: {
      when: "需要连接用户已有服务器、公司主机、现场机器或真机环境时",
      must_do: "优先使用既有 SSH 入口",
      must_not: "不要默认启用 Termius",
      verify: "保留 SSH 连接证据",
      why: "远程访问方式是已有项目约定",
      exception: "用户明确要求 GUI 时除外",
      source_ids: ["incident-ssh"]
    }
  });
  const result = selectLessons({
    lessons: [lesson],
    session: { session_uid: "codex:default:ssh-task", context_epoch: 1, project_id: "project-a" },
    task: {
      project_id: "project-a",
      fingerprint: "ssh-task",
      prompt: "现在连接的服务器环境就是公司主机，本机作为现场桥接笔记本"
    },
    budget: 10_000
  });
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].lesson_id, "ssh-before-termius");

  const unrelated = selectLessons({
    lessons: [lesson],
    session: { session_uid: "codex:default:server-health", context_epoch: 1, project_id: "project-a" },
    task: {
      project_id: "project-a",
      fingerprint: "server-health",
      prompt: "请检查服务器状态和磁盘空间"
    },
    budget: 10_000
  });
  assert.equal(unrelated.cards.length, 0);
});

test("a lesson created from the current session is injected on the next turn even when the user only says continue", () => {
  const session = { session_uid: "codex:default:active-task", context_epoch: 1, project_id: "project-a" };
  const lesson = card("Major", {
    lesson_id: "active-task-correction",
    scope: { task_types: ["remote-environment-testing"], tools: ["ssh"], signals: ["remote host access required"] },
    card: {
      when: "需要连接远程主机时",
      must_do: "使用已经确认的 SSH 入口",
      must_not: "不要切回 GUI 远程工具",
      verify: "记录连接结果",
      why: "本任务刚因远程入口选择错误被纠正",
      exception: "SSH 已被真实证据证明不可用",
      source_ids: [`${session.session_uid}:generated:feedback-1`]
    }
  });
  const result = selectLessons({
    lessons: [lesson],
    session,
    task: { project_id: "project-a", fingerprint: "active-task", prompt: "继续" },
    budget: 10_000
  });
  assert.equal(result.cards.length, 1);
});
