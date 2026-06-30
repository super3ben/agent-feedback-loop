# Feedback Loop 项目规则

本文件记录本项目特有的、由反馈反思得出的可执行规则。

## Verification Honesty（验证诚实）

不得把单元测试或安装接线检查等同于端到端验证。

在向用户声称「验证通过 / 全部通过 / 已验证」之前,必须:

1. 显式区分两类验证并分别标注状态:
   - **机制层**:单元测试、JSON 形状、doctor/healthy、安装与幂等接线。
   - **端到端层**:在真实 Codex/Claude/Gemini 会话里发强触发,确认 hook 真被 CLI 调用、
     `additionalContext` 真进入模型上下文、模型真的开始反思。
2. 明确列出「实际做了哪些验证项」和「哪些没做 / 无法做」,不得用机制层证据隐含端到端结论。
3. 对本项目这类「价值 = 注入指令真正进入模型上下文并改变模型行为」的工具,
   doctor/healthy 与形状检查只能证明「接线正确」,不能证明「功能生效」。
4. 端到端未做或受环境限制无法做时,用限定措辞,例如:
   「机制层已验证通过;端到端尚未验证,原因是 ___。」不得使用无限定的「全部验证通过」。

反例(避免过度收窄):若用户只要求跑单元测试,如实声明「单元测试通过」即可,不必扩大范围。

## No False Positives in Test Assertions（测试判据不得假阳性）

用 grep/字符串匹配判断「模型是否收到注入内容」时,判断范围不得混入命令自身的字面量。

- 曾犯:`grep 反馈反思已触发` 同时扫了 stdout 和「我自己 shell 命令里的中文」,得到假阳性,差点据此声称验证通过。
- 要求:只对**被测程序的真实输出文件**做断言;命令里若出现待匹配字符串,必须隔离(写独立文件再 grep,或用探针留痕)。
- 一条 grep 命中不足以下结论;需有独立的、不依赖命令字面量的证据(如 hook 留痕探针)。

## Never Copy Auth Credentials Across CODEX_HOME（不要跨 CODEX_HOME 复制凭据）

做 codex 隔离测试时,**禁止**复制 `~/.codex/auth.json` 到临时 home。

- 曾犯:为隔离测试把 `auth.json` 复制进临时 `CODEX_HOME`,OpenAI 检测到同一 token 多处使用,
  触发 `token_invalidated` / `refresh_token_invalidated`,把用户**真实**的 codex 登录也弄失效了。
- 正确做法:用真实 `~/.codex`(凭据/登录都在那),仅用命令行 `-c hooks.UserPromptSubmit...` 临时覆盖 hook
  指向待测脚本,既不写用户 `config.toml`,也不动凭据。
- 任何「复制凭据」「在两个目录间共享 token」的隔离测法都禁止。
