# Agent Feedback Loop 中文说明

面向 Codex、Claude Code、Gemini CLI 的本地提示时反馈学习。

**运行时版本：`0.10.0`**

## 反馈学习

1. prompt hook 捕获合格的用户不满后立即返回宿主。
2. 分离的 feedback reviewer 可在稍后读取有界本地证据。
3. 合法 reviewer 结果发布为项目 `.agent/reflections/` 下不可变 Markdown。
4. 后续匹配的提示直接读取少量适用 Markdown 文档。

当前提示永不等待 feedback reviewer。处理开始时固定 publication cutoff，因此处理中
新发布的文档只能影响后续匹配的提示。精简 control SQLite 数据库只保存生命周期
状态，不保存 lesson 正文。这是直接 Markdown 选择，不是 RAG。

### 自然语言不满覆盖

识别不满不再依赖固定的负面关键词（如"做错了""不合理"）。三层机制覆盖词表与判断
之间的空隙：

1. **扩展词表路由。** 自然语言表达的抱怨——被要求重复已知信息、对反复出现的
   问题不耐烦、以及质问式追责（"怎么又不知道了"）——直接进入 detached full
   reviewer。
2. **LLM 回退分类器。** 词表未命中但带助手 referent 的消息交给 detached 二元
   分类器（`classify-feedback`），先给理由再输出 `{"dissatisfied": true/false}`。
   Yes 放行给 reviewer，No 丢弃。分类器被明确告知：助手的辩解不能作为用户没有
   不满的理由——一句"连不通"糊弄不了判定。纯操作对话（"继续""好的""等等"）
   整句命中即跳过，不发调用。由于分类器按每条带 referent 的消息触发，codex
   调用会注入与 reviewer 相同的网关路由；缺了它所有 codex 分类都会挂到超时。
3. **确定性升级。** reviewer 反复用新借口（事后纠正、"还没部署"、前瞻建议）
   拒绝沉淀同一家族时，不再由它说了算：同族在 14 天窗口内被拒 ≥3 次后，下一次
   拒绝会被替换为用累计拒绝记录合成的 Major 经验并直接发布。已有已发布教训的
   家族交给正常复发机制，不堆积重复的 meta-lesson。

   **DeepSeek Harness（`dsh`）覆盖：** `install` 自带一个独立的 dsh 原生插件
   （`dsh-plugin/`），并按 `dsh plugin add` 的同一方式接线到 `~/.dsh/profiles/`
   下的每个 profile（node_modules symlink、`link:` 依赖、
   `dsh.profile.bundles` 登记）——不依赖任何桥接包。插件把每条
   prompt 喂给 `core-hook.sh`，并把编译好的规则区块注入回 harness。harness 不
   暴露 transcript，因此无法携带 transcript 的方言，其 prompt 也会送分类器
   而不是被静默丢弃；能带 transcript 的会话在尚无 referent 时（首轮）仍保持
   跳过。dsh 来源的评审/分类子进程运行在宿主 CLI 上（claude，其次 codex、
   gemini）。

### 从发布到下次会话生效

发布不等于送达。三条通道把教训带给后续会话：

- reviewer 合同把用户的明确事实陈述当作必须先核查再反驳的主张，把超出用户
  明确范围的扩大执行（即使事后纠正）判定为 agent 责任。
- 达到 `Major+3` / `Critical+2` / `Blocker+1` 复发次数的家族会被编译进
  `.agent/rules/feedback-loop.md` 的托管区块。
- prompt hook 每轮把该托管区块注入上下文，复发足够多的规则每一轮都被看到——
  机械保证，不依赖模型自觉打开文件。区块是分层的，只注入其中一部分，见下。

#### 规则区块是分层的：索引常驻，指令按需

区块分两层，文件本身刻意允许大于任何一次注入：

- **L0 —— 索引**：一行一个家族（`- family-key (N×)`），每轮必注入。它的职责
  是保证没有任何家族是不可见的——本项目学到过的每个家族在每一轮都被点名，
  每条约 40 字节。
- **L1 —— 指令**：每个家族的完整正文（何时适用、事故经过、要怎么做）。
  只注入当前提问真正触及的那几段，每轮最多两条。
- **L2 —— 反思文档**：完整经过，在 `.agent/reflections/` 下。从不主动注入；
  L1 不足以说明时才去读。

实测：此前的扁平设计把一个 6KB 区块撑到 97%，16 个家族里 12 个被降级成一行
只有标题、没有任何指令；而且不管用户问什么，每轮都发同一份 6KB。现在文件
容纳全部家族的完整正文（17KB），典型注入 2–5KB，而一个什么也没匹配上的普通
轮次只花约 800 字节。

#### 什么时候才注入教训

L1 的闸门看用户此刻在做什么，而不是看词面像不像：

- **用户报告问题或表达不满时展开** —— 「今天的日报没有发出去」「你这个详细设计
  也太简单了」「之前密码不是给你了怎么又问我」。教训记录的就是此前被报告过的
  问题，所以这正是它的时机。
- **普通指令时不展开** —— 「把这个汇总报告存到 docs/ 下」「继续做审美的也一样
  做完」。无论词面重合多少，都没有教训适用。

这个区分之所以必要，是因为词法相似度分不开它们。实测真实消息：「之前密码不是
给你了怎么又问我」和「继续做审美的也一样做完」得分完全相同（2.4），在得分上做
任何阈值都只是把一类错误换成另一类，最好情况 15/21。改成按用户意图判定后，
在 40 条真实用户消息上是 39/40。不展开的代价很低：L0 仍点名每个家族，省下的
2KB 本来就是一条不适用的指令。

两条通道都遵守同一道闸——分层区块和反思文档选择器。此前只拦区块时，选择器
在一个普通指令上仍会送出两篇无关文档（3KB）。

#### 规则区块是投影，不是累积日志

托管区块在每次发布时从 store 状态整体重建，因此不会无限增长，也不需要任何人
去清理。四个性质让它自动完成：

- **合并**：正文完全相同的家族会合并。family id 把评审的自由文本 `family_key`
  和方法类别一起哈希，所以同一课教训只要措辞一变就会以新 id 再次出现。实测
  有一个项目存在 7 个这样的重复，占该区块 36.6%。
- **按事故合并，不按模板合并**：升级出来的家族共享同一个 `method_class` 字面量
  和同一段套话，按它们做合并键会把 7 个互不相干的问题压成一段，而那段正文讲的
  是评审流程本身、不是这 7 个问题中的任何一个。改为按用户自己的投诉做合并键。
- **排序**：家族按严重度、复发次数、最近复发时间排序。没有第三项时，一个半年
  前踩过 39 次、之后没再犯的家族会压过这周踩了 5 次的。
- **触发条件取并集**：一个反复发生的家族每次都会产生新文档，每份都记录了那次
  投诉的原话。只读最新一份等于把其余的都丢了：实测某家族有 6 份文档，而用户
  真正会打的那句话在最老的一份里。现在该家族所有已发布文档的条件都会并入。

#### 一条事实有保质期，不是永久真理

索引行可以带一条短语事实，正是它让条目可执行而不只是被点名。但事实会过期：
十一月还对的指引，十月可能是错的，因为它描述的约束已经变了。此前区块里没有
任何东西区分这两种状态。

现在索引事实按年龄分三档：

- **现行**：90 天内被确认过，直接陈述。
- **可能已过期**：90–120 天。正文保留，加注「可能已过期·先验证」。直接删掉会丢掉
  已经学到的东西，变的是提醒，不是内容。
- **休眠**：超过 120 天且无复发、无在用。事实撤下，但家族名字保留，教训仍然可查。

休眠有前置闸门：若近期评审任务中超过 30% 分类失败，管线就分不清「安静」和
「没看到」，此时不作任何休眠判定。完全查不到时间证据的家族只标为可能已过期，
不会标为休眠——没有日期不等于年代久远。

#### 同一类错误只留一份文档

一次评审一份文档，意味着用户反复踩的同一类问题会以 N 份近乎相同的文档出现，
各自与真正不同的教训争抢同一份注入预算。错误类别相同的文档会在读取时合并成
一份——不在磁盘上合并，投递日志里的文档哈希因此保持完好——族内以最新文档的
指令为准，跨族的方法变更取并集，上限五条。

#### 每一轮实际收到了什么，有记录

每次注入都会写一行遥测：展开了哪些家族、分数多少、注入了多少字节、闸门为什么
开或没开（`not_a_problem`、`no_match`、`no_distinctive_term`）。查看方式：

```bash
sqlite3 ~/.agent/feedback-loop-data/store/control.sqlite3 \
  "select value from store_meta where key like 'injection_telemetry:%' order by rowid desc limit 5;"
```

之所以要有这个：此前每一次选择逻辑的改动都只能拿一份人工标注语料评判，而那份
语料的 47 行里有 11 行的文本逐字出现在被检索的文档中——测量给自己虚高了约 17 个
百分点，比这更小的差异完全淹没在噪声里。真实流量才是唯一有答案的地方。

`doctor` 在 `status.rulesBlock` 下报告该区块，分两个独立标志：`saturated`
（投影到达上限，属正常工作）与 `overBudget`（文件已与写入端产物不一致）。
两者都不要求你做任何清理。

### Reviewer provider 环境

detached reviewer 在被剥离的环境中运行宿主 CLI（`codex`、`claude` 或 `gemini`）。
只有 `PATH`、`HOME`、`TMPDIR`、`LANG`、`LC_ALL`、`LC_CTYPE`、`TZ` 以及任意
`AFL_REVIEW_*` 变量会传入 reviewer 进程。若某个 CLI 用自己的持久化凭据认证（例如
`~/.codex/auth.json`，或 `~/.claude/settings.json` 里的 token），则无需额外配置即可
工作，因为这类状态由 CLI 自身加载，不依赖从 shell 继承。只有当某 provider 纯粹靠
shell 环境变量认证时——例如把 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` export
到 shell 而不是存在 CLI 自己的配置里——才需要通过
`AGENT_FEEDBACK_LOOP_REVIEWER_ENV_ALLOWLIST`（逗号分隔的白名单）放行这些变量名；
其值还必须列出 `AGENT_FEEDBACK_LOOP_REVIEWER_ENV_ALLOWLIST` 和
`AGENT_FEEDBACK_LOOP_REVIEWER_TIMEOUT_MS` 本身，才能传入 detached 进程。单次审查
超时默认 300000 ms，claim lease 跟随超时伸缩，大证据量的审查跑几分钟也不会被
中途掐断或以 lease 丢失作废；真实 provider 需要更长时间时用
`AGENT_FEEDBACK_LOOP_REVIEWER_TIMEOUT_MS` 再调高。

## 安装与诊断

需要 Node.js 24.15 或更高版本。真实全局安装或修改真实 HOME 配置前，必须取得授权。

```sh
npm install -g agent-feedback-loop
agent-feedback-loop install --dry-run
```

先使用临时 HOME；这里只安装临时 runtime 与 schema，不修改真实用户配置：

```sh
tmp_home="$(mktemp -d)"
agent-feedback-loop install --home "$tmp_home"
agent-feedback-loop doctor --home "$tmp_home" --live
agent-feedback-loop uninstall --home "$tmp_home"
rm -rf "$tmp_home"
```

安装只复制 package assets、选择 runtime、迁移所选 control schema，并配置既有 prompt
hooks。它不会注册 Stop/AfterAgent hook，启动服务，或创建 learning reader。

### 发布

发布在本地发起、由 CI 执行，全程不用存量凭据：

```sh
node scripts/publish.mjs              # 校验、推 main、打 tag vX.Y.Z、等 CI 完成
node scripts/publish.mjs --dry-run    # 跑完所有检查，不推不发
```

tag 触发 `.github/workflows/publish.yml`：重跑测试套件、重跑 tarball 检查、跳过已于
registry 存在的版本、带 `--provenance` 发布，然后轮询直到 registry 真正提供新版本。
认证走 GitHub 与 npm 之间的 OIDC 交换——没有 `NODE_AUTH_TOKEN`，没有 `~/.npmrc` 里的
`_authToken`，也没有需要轮换的东西。

这件事之所以重要：npm 正在收紧可绕过 2FA 的 token 用于直接发布——账户变更自
2026 年 8 月起、直接发布自 2027 年 1 月起。本地 token 已不再是可持续的发布路径，
发布身份改由 workflow 承担。发布产物因此天然可追溯到某一个不可变的 tag。

一次性绑定在 npmjs.com 上做，不在本仓库里：Package → Settings → Trusted
Publisher → GitHub Actions，workflow 填 `publish.yml`。绑定存在之前发布步骤会以
404/401 失败，这是缺绑定的预期症状，不是 workflow 坏了。

`node scripts/marketplace.mjs` 单独更新 dsh 市场条目。它从本账号的市场仓库 fork 开
PR，绝不写入对方 `main`；用的是普通 `gh` 凭据，因此不在发布 workflow 里。

### DeepSeek Harness（`dsh`）

dsh 插件已收录于 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
插件市场（memory 分类）：[条目](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/data/plugins/super3ben__agent-feedback-loop--templates-dsh-plugin.yml)。

若存在 dsh home（`~/.dsh/profiles/`），`agent-feedback-loop install` 还会把独立
原生插件接线到每个 harness profile：插件复制到 `<packRoot>/dsh-plugin/`，链入
profile 的 `node_modules`，添加 `link:` 依赖，并在 `dsh.profile.bundles` 登记
——与 `dsh plugin add` 的最终状态一致，且重复安装幂等。插件由自带的 bundle
patch 层激活；`install` 绝不写 profile 的 `cordis.patch.yml`（那里的手动行会与
bundle 层在 loader entry id 上冲突，harness 将拒绝启动）。bundle 登记机制之前
的旧安装会被自动迁移：其写入的托管 patch 行会被移除。

插件注入的消息带一个 `source`，其 `kind` 必须是生产者自有 kind
（`plugin:<包名>`），不能再用已退役的 `{ kind: "plugin", plugin }` 包装。DSH 的
持久化会话格式管这套语法：格式 v4 在落盘准入阶段拒绝该包装
（`format v4 message requires a producer-owned source kind`），而这个异常会终止
整个轮次，用户看到的是「本轮运行失败」且日志里没有任何 assistant 消息。插件会读
会话的格式版本并下发对应写法；版本缺失时按 v4 下发——猜「旧」会重现这个故障，
猜「新」最坏只是发出一个 v3 日志本来就不校验的 kind。

安装后需重启 harness，运行中的实例才会加载插件。dsh home 跟随安装 home
（真实用户即 `~/.dsh`）；用 `--home` 指向一次性目录即可在不触碰真实 profile
的情况下试接线。

`doctor` 返回 `{ version, status }`。`status.ready` 仍是 prompt/Markdown 路径的门。

package 存在或静态 doctor 通过，不能证明 live provider 成功或生产有效性。

## 反思治理

两个以读取为主的命令用于管理已发布的反思目录：

```sh
agent-feedback-loop reflections effectiveness --project /绝对路径/项目
agent-feedback-loop reflections archive --project /绝对路径/项目            # 预演
agent-feedback-loop reflections archive --project /绝对路径/项目 --apply    # 实际移动
```

`effectiveness` 依据投递日志与评审历史回答「这条教训到底有没有起作用」，把每个家族
归入 `never_delivered`（从未投递）、`recurred_after_delivery`（投递后仍复发）、
`too_early_to_tell`（投递过早，尚不能判断）或 `quiet_since_delivery`（投递后未见复发）。
输出标注 `causality: correlation_only`：家族安静可能意味着教训生效了，也可能意味着
同类工作根本没再出现。**不要把它读成生效证明。**

`archive` 退役**同时**满足「早于 `--after-days`（默认 30 天）」且「从未投递过」的文档，
移动到 `reflections/archive/`。投递过的文档无论多旧都不动。它是移动而非删除，且默认只预演。

## 旧数据导出

旧反馈导出仍然显式且对源数据库只读：

```sh
agent-feedback-loop legacy-export --source-db /absolute/legacy.sqlite3 \
  --output-dir /absolute/export --dry-run
agent-feedback-loop legacy-export --source-db /absolute/legacy.sqlite3 \
  --output-dir /absolute/export --apply
```

prompt hook 回滚时，先检查 `agent-feedback-loop uninstall --dry-run`，获得授权后再执行
`uninstall`。它进入关闭 hooks 的状态，同时保留 durable control 数据和密钥，除非
操作员另行删除。

## 证据状态

代码测试、package inventory、临时安装 runtime 和生产有效性是不同证据状态。前一层
通过不能被报告成后一层完成。

结构化日志只包含固定事件名、有界 reason code、计数及 opaque 标识符或 hash；不得包含
原始 prompt、diff、reviewer 正文、token 或绝对项目路径。
