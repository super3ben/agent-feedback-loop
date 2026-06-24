# Contributing

Thanks for improving Agent Feedback Loop.

## Development

```bash
npm test
node ./bin/agent-feedback-loop.mjs install --home /tmp/afl-home
node ./bin/agent-feedback-loop.mjs doctor --home /tmp/afl-home
```

## Contribution Guidelines

- Keep the runtime prompt-first.
- Do not move reflection reasoning into JavaScript.
- Keep hooks fail-open.
- Keep user-editable behavior in Markdown templates.
- Add tests for install, uninstall, doctor, and hook output changes.

## 中文

欢迎改进 Agent Feedback Loop。

贡献时请保持这几个原则：

- 默认机制仍然是 prompt-first。
- 不要把反思推理逻辑写进 JavaScript。
- hook 失败时必须放行，不能阻塞 CLI。
- 用户可维护的规则应放在 Markdown 模板里。
- 修改安装、卸载、诊断或 hook 输出时需要补测试。
