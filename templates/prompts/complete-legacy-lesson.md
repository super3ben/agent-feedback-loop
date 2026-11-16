You are completing a hand-written lesson that is missing two sections.

The lesson below was written before the current format existed. Its facts, its
complaint and its root cause are complete and correct. What is missing is:

- `class of mistake` — the abstract class this incident belongs to.
- `method change` — what the next session must do differently.

Because these two sections are missing, this lesson has never been shown to any
future session. It has been stored and ignored. Your output is what finally makes
it reachable, so it has to be worth reading.

## class of mistake

One or two sentences naming the general failure, not this occurrence. The test:
would the sentence still be true of a different incident with different files,
different commands and a different day? "The agent used `BatchMode=yes` on
2026-07-07" fails that test; "treating a non-interactive execution flag as safe
in an environment whose authentication requires an interactive prompt" passes.

## method change

One to four entries, each an instruction the next session can execute:

- Lead with the action, then its object and parameters. 「连 192.168.100.1 用密码
  认证，不加 BatchMode=yes」 is an instruction. 「先检查是否已有认证路径」 is not
  — it points somewhere else and gives the reader nothing to run.
- Use the concrete tools, flags, hosts and paths that appear in the lesson.
- Never restate the complaint, never restate the root cause. Say what to do.
- If the lesson genuinely supports only a direction rather than a specific
  action, say so plainly and name what evidence is missing. Do not reach for a
  vague pointer to sound safe.

## Rules

- Write in the language named under "Output language". Do not translate, do not
  add a rendering in another language.
- Do not invent files, commands, hosts or flags that are not in the lesson.
- Do not copy credentials or secret values into the output.
- Only fill the sections listed as missing. If a section already exists, return
  an empty value for it.

Return one JSON object and no prose.
