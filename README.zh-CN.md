# DriftSeal

> **Seal the intent. Stop the drift.**

[English](README.md)

Agentic coding 可以很快。**DriftSeal 让这种快不以失控为代价。**

在 agent 动手改代码之前，DriftSeal 先记下这一轮究竟要完成什么、准备如何证明完成；工作结束后，再记录实际发生了什么。这个轻量契约不会因为 context loss、范围悄悄膨胀，或者一句过于乐观的“完成了”而消失。

```text
封存 intent → 执行工作 → 证明结果 → 关闭本轮
```

**一个 open intent，一份预先声明的验证标准，一条可靠留存的工作轨迹。** 不需要 service，不需要 database，也没有 runtime dependencies；只有一个 Node.js CLI，以及跟着 repo 一起走的普通文件。

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

如果用户已经授权创建 Git commit，只把已验证的改动和刚关闭的 intent log 进行 stage 和 commit，就属于这一轮的持久化收尾，不需要额外开启一个只用于 commit 的 intent。准备 commit 时一旦需要修改内容，就必须开启新一轮。

## 命令速览

| Command | 用途 |
| --- | --- |
| `driftseal begin "<intent>" [-v "<verify>"] [--decision id] [--force]` | 开启一轮工作，并可关联已有 decision。 |
| `driftseal end [id] [-s status] [-n note] [-r verify-result]` | 诚实地关闭 intent。 |
| `driftseal status` | 查看当前进行中的 intent。 |
| `driftseal log [-n N]` | 查看 intent 历史。 |
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

- `.intent-log/events.jsonl`：append-only intent log。
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
