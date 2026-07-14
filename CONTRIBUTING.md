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
- Keep reflection reasoning in the reviewer; JavaScript owns only capture, storage, validation, selection, and receipts.
- Keep hooks fail-open.
- Keep user-editable behavior in Markdown templates.
- Add tests for install, uninstall, doctor, hook output, SQLite constraints, encryption, leases, and lesson selection changes.

## 中文

欢迎改进 Agent Feedback Loop。

贡献时请保持这几个原则：

- 反思判断仍由 reviewer 负责；JavaScript 只负责捕获、存储、校验、选择和 receipt。
- hook 失败时必须放行，不能阻塞 CLI。
- 用户可维护的规则应放在 Markdown 模板里。
- 修改安装、卸载、诊断、hook 或记忆存储时需要补测试。
