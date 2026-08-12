# DriftSeal

> **Seal the intent. Stop the drift.**

[English](README.md)

Agentic coding 可以很快。**DriftSeal 让这种快不以失控为代价。**

在 agent 动手改代码之前，DriftSeal 先记下这一轮究竟要完成什么、准备如何证明完成；工作结束后，再记录实际发生了什么。这个轻量契约不会因为 context loss、范围悄悄膨胀，或者一句过于乐观的“完成了”而消失。

```text
封存 intent → 执行工作 → 证明结果 → 关闭本轮
```

**一个 open intent，一份预先声明的验证标准，一条可靠留存的工作轨迹。** 不需要 service，也不需要 database；只有本地 Node.js tools，以及跟着 repo 一起走的普通文件。

## 真正麻烦的不是慢，而是偏航

| 没有 DriftSeal | 使用 DriftSeal |
| --- | --- |
| 任务做到一半，范围悄悄扩大 | 当前轮次始终只有一个清晰可见的 intent |
| 没有可靠证据，也可以宣布“完成” | 实现前就先声明 verification |
| Context compaction 后忘记最初目标 | `status` 和 `log` 能准确找回 intent 与历史 |
| 同一场架构争论被不同 agent 反复重演 | 克制使用的 [MADR](https://adr.github.io/madr/) 记录保留真正重要的理由 |
| 并发或中断写入让状态变得可疑 | Lock、schema check、atomic write 与 recovery 让异常可检测、可恢复 |

DriftSeal 不会取代 Git，而是补上 Git 不负责记录的部分：intent 说明原本要做什么，decision log 保存为什么，commit 展示最终落地了什么。

## 30 秒开始使用

```sh
npm install --global driftseal
cd your-project
driftseal init
```

`driftseal init` 会安全地把协议加入 `AGENTS.md`，重复运行也不会产生副本。DriftSeal 需要 Node.js 18+。

从当前 checkout 本地开发时：

```sh
npm link
```

## 让 coding agent 掌握完整工作流

npm package 内含 `skills/use-driftseal`。这是一个不绑定特定 agent runtime 的配套 skill，会按完整 DriftSeal 闭环执行仓库任务，同时克制地使用 decision record。按照所用 agent runtime 的 skill discovery 约定安装或 link，之后通过名称 `use-driftseal` 调用即可。

## 通过 MCP 使用 DriftSeal

同一个 package 还提供本地 stdio MCP server：`driftseal-mcp`。它为完整的
intent 与 decision 工作流提供结构化 tools，并与 CLI 复用同一套锁、WAL、
atomic write、schema 和 recovery 实现。server 不会启动 `driftseal` 子进程，
也不需要解析 CLI 输出。

启动时把 server 固定到一个 repository：

```sh
driftseal-mcp --root /absolute/path/to/repository
```

在 Codex 中，可以把安装后的命令添加为 stdio MCP server：

```sh
codex mcp add driftseal -- driftseal-mcp --root /absolute/path/to/repository
```

root 只能在启动时配置，不是 tool input。MCP 模式也会忽略继承到进程中的
`DRIFTSEAL_HOME` 和 `DRIFTSEAL_DECISION_HOME` override，因此 tool call 不能把
写入重定向到所选 repository 之外。

v1 server 提供：

| MCP capability | 用途 |
| --- | --- |
| `driftseal_status`, `driftseal_log` | 读取当前 intent 和 intent 历史。 |
| `driftseal_begin`, `driftseal_end` | 开启并诚实关闭一轮工作。 |
| `driftseal_reclaim`, `driftseal_unreclaim` | 用 append-only 标记隐藏已无意义的已关闭记录，或将其恢复。 |
| `driftseal_decision_list`, `driftseal_decision_show` | 查找并读取 MADR record。 |
| `driftseal_decision_add`, `driftseal_decision_update` | 克制地增加 decision，并 reconcile 已关联的 decision。 |
| `driftseal://intent/current` | 以 JSON resource 读取当前 intent。 |
| `driftseal://intents/recent` | 以 JSON resource 读取最近十条 intent。 |
| `driftseal://decisions` | 以 JSON resource 读取 decision catalog。 |

配套 skill 仍然不可替代：MCP 提供受控、结构化的操作，skill 则告诉 agent
何时使用这些操作，以及怎样避免 drift。

## 一轮标准工作流

修改文件前，先声明这轮工作的目标：

```sh
driftseal begin "add rate limiting to /api/login" \
  --verify "npm test test/rate-limit.test.js"
```

完成工作并运行约定的 check 后，记录实际结果：

```sh
driftseal end \
  --status completed \
  --note "Added the limiter and covered the failure path" \
  --verify-result "4 tests pass"
```

如果范围发生变化，先把当前 intent 以 `partial` 或 `abandoned` 关闭，再开启新的 intent。发生 context loss 后，用 `driftseal status` 和 `driftseal log --last 3` 重新锚定当前目标。

只负责构建、检查或记录已完成工作的单步命令（编译、跑测试、`git add`/`git commit`）不需要单独开启 intent。如果用户已经授权创建 Git commit，只把已验证的改动和刚关闭的 intent log 进行 stage 和 commit，就属于这一轮的持久化收尾。准备 commit 时一旦需要修改内容，就必须开启新一轮。

## 命令速览

| Command | 用途 |
| --- | --- |
| `driftseal begin "<intent>" [-v "<verify>"] [--decision id] [--force]` | 开启一轮工作，并可关联已有 decision。 |
| `driftseal end [id] [-s status] [-n note] [-r verify-result]` | 诚实地关闭 intent。 |
| `driftseal status` | 查看当前进行中的 intent。 |
| `driftseal log [-n N] [--all]` | 查看 intent 历史（`--all` 包含已回收的记录）。 |
| `driftseal reclaim [id ...] --reason "..." [--older-than days] [--force] [--dry-run]` | 用 append-only 标记隐藏已无意义的已关闭记录。 |
| `driftseal unreclaim <id> --reason "..."` | 把已回收的记录恢复到可见历史中。 |
| `driftseal decision add "<title>" -c "..." -o "..."` | 写入编号化的 MADR decision。 |
| `driftseal decision update <id> [-s status] -n "..."` | 在当前 intent 中 reconcile 已关联的 decision。 |
| `driftseal decision list [-s status] [--last N \| --count]` | 列出或统计 decision records，也可按 status 筛选。 |
| `driftseal decision show <id>` | 查看单条 decision record。 |
| `driftseal init` | 把接入协议写入 `AGENTS.md`。 |
| `driftseal help` | 查看 CLI 用法。 |

如果 `begin` 通过一个或多个 `--decision <id>` 声明了关联，那么 intent
以 `completed` 或 `partial` 关闭前，必须用 `driftseal decision update` reconcile
每一条关联 decision。update 可以改变当前 status，并会追加一条包含时间和
intent ID 的 history。没有关联 decision 的 intent 仍沿用普通流程。

## 回收已无意义的记录

有些已关闭的记录会随着时间失去意义：harness 或 sandbox 导致的失败会被如实记录为
`failed`，但它与项目本身无关。`driftseal reclaim` 可以在不改写历史的前提下让这类
记录退场——它只是向同一个 append-only log 追加一条 `reclaim` 标记（必须附带
`--reason`），被回收的记录会从 `driftseal log` 和 `driftseal status` 的输出中隐藏，
但仍保留在 `events.jsonl` 中，并可通过 `log --all` 查看。若事后发现某条记录仍然
重要，用 `driftseal unreclaim <id> --reason "..."` 恢复。

不带 id 的批量模式只回收已关闭、未关联 decision、且早于 `--older-than` 天（默认 7
天）的 `failed`/`abandoned` 记录；可以先用 `--dry-run` 预览。`completed` 和 `partial`
记录，以及任何关联了 decision 的记录，只能按显式 id 加 `--force` 回收。

## 一致性与恢复

DriftSeal 会对配置后的 intent log 与 decision log 根目录加锁，并按固定顺序获取这些
lock，从而串行执行 mutating commands。Decision reconciliation 会先写 prepare
event，再以 atomic replacement 更新 MADR，最后写 commit event。如果进程在中间
停止，下一次 linked `decision update` 或 successful `end` 会根据 content hash
恢复 transaction。linked intent 成功关闭前，还会验证 decision 文件自最近一次
reconciliation 后没有发生变化。未关联 decision 的 intent 不会解析 decision log；
当 decision recovery 无法完成时，`failed` 与 `abandoned` 仍可作为退出路径。
这两个 terminal status 会取消对应 pending transaction 的后续 recovery；同时，
recovery 只处理当前 intent，因此历史冲突不会阻塞之后的 decision 工作。

新 event 带有 schema version。遇到更高且不支持的版本时，DriftSeal 会拒绝继续；如果
旧 client 未经 reconciliation 就关闭 linked intent，新 client 也会 fail closed。
`driftseal init` 会写入带版本的 managed blocks，并且只升级内容完全匹配的已知旧版本。
遇到更新的协议版本、无法识别的 block 或自定义内容时，它会保持 `AGENTS.md`
不变并拒绝继续。

`--count` 只输出 status 筛选后的记录总数。它不能与 `--last` 一起使用，以免
“先限制再计数”造成歧义。Decision 文件名会构成一个轻量的内存索引：`show` 只
解析目标 record；不带 status 的 `--count` 完全不读取 MADR 正文。按 status 筛选
时仍需解析全部 records，因为 status 保存在各个 MADR 文档中；DriftSeal 不维护容易
滞后的 sidecar index。

## 数据保存在哪里

- `.intent-log/events.jsonl`：append-only intent log。所有读写都必须经过 `driftseal`（CLI 或 MCP）——不要直接读取、修改、移动或删除该文件；需要让无意义的记录退场时使用 `driftseal reclaim`，而不是删除日志行。
- `.decision-log/`：编号化的 MADR decision records。
- 设置 `DRIFTSEAL_HOME` 或 `DRIFTSEAL_DECISION_HOME`，即可把对应 log 放到当前项目之外。

Intent event、克制使用的 decision record 和 Git commit 共同构成分层的项目日志：intent event 说明一轮工作准备做什么、将如何验证；decision record 保存其他两层无法重建的理由、被拒绝路径或暂缓选择；commit 则展示最终实际落地的完整改动。DriftSeal 是对 Git history 的补充，不是对它的重复或替代。

建议把 DriftSeal logs 和代码一起放进 version control，让项目的工作约定与决策轨迹能够共同演进。npm package 使用显式文件白名单，因此项目本地的 agent log 不会被发布到 npm。

## 开发与贡献

```sh
npm test
```

欢迎贡献。请尽量保持改动聚焦；如果改变了行为，请补充 regression coverage，并在提交 pull request 前运行测试。

## License

MIT，详见 [`LICENSE`](LICENSE)。
