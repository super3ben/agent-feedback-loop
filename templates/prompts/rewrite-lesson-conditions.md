You are rewriting the matching conditions and instructions of an already-published lesson.

The lesson below was written by an earlier review. Its evidence and its root cause
are correct and must not change. What is being rewritten is only:

1. `applies_when` — the conditions a future session is matched against.
2. `method_changes` — what the next session must do.

## What is wrong with the current text

**Conditions are transcriptions instead of summaries.** Matching is word overlap
between the condition and the user's opening request. A condition that quotes
this one incident is reached only by a user who happens to phrase it the same
way, which is rare: the same problem comes back as 「连不上」「登不进去」
「又问我要密码」「密码不是给过吗」. Write a summary of the situation that
carries those variants.

**Conditions are duplicated in two languages.** The user writes in one language.
A rendering in the other language can never match anything they type and spends
the condition budget, which is capped at six. Write each condition once, in the
language given below.

**Method changes point somewhere else instead of saying what to do.** "先检查项目
规则和已有反思，确认是否已有授权认证方式" reads as advice but gives no action
to execute; a reader who cannot execute it falls back to what it was going to do
anyway. This exact shape delivered for months while the mistake kept recurring.
State the action and its concrete parameters.

## How to write them

`applies_when` — 2 to 5 conditions, each a summary of the situation:

- Name the concrete objects that stay stable across rephrasings: the server, the
  command, the flag, the file, the tool.
- Fold in the variants of the complaint the evidence supports, so each shape of
  the user's wording reaches the lesson.
- Keep the user's own wording inside the summary. Matching is literal: a
  condition that says 连接 does not match a request that says 登录.
- Describe the moment BEFORE the mistake, not after it. The lesson must arrive
  while it can still prevent the failure, so phrase it as the trigger the next
  session is about to enter.
- Technical identifiers (tool names, flags, paths, hostnames, command names) stay
  verbatim.

`method_changes` — 1 to 4 entries, each an instruction:

- Lead with the action, then its object and parameters. 「连 192.168.100.1 用密码
  认证，不加 BatchMode=yes」 is an instruction. 「检查是否已有认证路径」 is not.
- Use vague pointer phrasing only if the evidence genuinely supports no specific
  action, and then say what is missing.
- Never repeat the complaint. Never restate the root cause. Say what to do.

Write everything in the language named under "Output language" below. Do not
translate, do not add a rendering in another language.

## Do not

- Do not invent evidence, hosts, flags, or commands that are not in the lesson.
- Do not change the severity, the family, or the root cause.
- Do not copy credentials or secret values into the output.

Return one JSON object and no prose.
