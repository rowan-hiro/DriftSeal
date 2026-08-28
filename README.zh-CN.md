# DriftSeal

> **Seal the outcome. Stop the drift.**

DriftSeal 是一套跟随 repo 保存的协议与工具，用来让 coding agent 始终围绕一个
完整的交付 outcome 工作。它要求在持久改动开始前记录 outcome，允许以 append-only
方式补充同一 outcome 的后续步骤，把验证结果绑定到累计 contract，并只为确实需要
长期保留理由的选择建立 MADR。

```text
开启 outcome → 扩展同一 outcome → 验证累计 contract → 关闭
```

一个 worktree 只持有一个 open outcome。Git 记录最终落地了什么；DriftSeal 记录这轮
工作想交付什么、如何证明完成，以及长期 decision 背后的理由。

## v2 的变化

DriftSeal v2 从“按步骤记录 intent”改为“按交付记录 outcome”。

- 所有状态归到同一个 seal root：`.seal/outcomes/events.jsonl` 与 `.seal/madr/`。
- `DRIFTSEAL_HOME` 覆盖整个 v2 `.seal` root。从 v1 继承的值仍指向 intent-log
  目录；migration 时需要显式传入旧位置，之后再 unset 或替换这个变量。
- `driftseal extend` 可以向当前 outcome 追加步骤、acceptance、verifier 或 decision link。
- 每次 extend 都会改变 contract hash，并让之前的 verification 与 MADR reconciliation 失效。
- event 使用 `logVersion: 2`。兼容客户端接受 `schemaVersion` `1` 或 `2`；lane
  事件以及非默认的 `begin.lane` 使用 `schemaVersion: 2`。
- `AGENTS.md` 的新协议版本是 `2.1`。`driftseal init` 会升级可识别的 `2.0` block。
- 具名 lane 在同一条 WAL 上切分 outcome 历史。默认 lane 是 `main`；`driftseal log`
  跟随当前 lane。
- CLI、Node API、MCP tool 与 resource 全部使用 outcome 命名；v1 名称和路径不会作为
  runtime alias 保留。

## 安装

DriftSeal 需要 Node.js 22.13 或更高版本。派生 outcome index 使用 Node 内置的
`node:sqlite`，不会安装 native database package。

```sh
npm install --global driftseal
driftseal --version
```

安装后也可以用短别名 `ds`，它与 `driftseal` 使用同一个 CLI 入口。
例如，`ds status` 等同于 `driftseal status`。

在源码 checkout 中使用：

```sh
npm install
node bin/driftseal.js --version
```

让 repo 接入协议：

```sh
driftseal init
```

`init` 会写入或升级 `AGENTS.md` 中的 managed blocks，添加 outcome log 的 merge
attribute，并配置本地 Git merge driver。Git config 不会随 clone 传播，因此新 clone
需要再执行一次 `init`。

`driftseal init --lang <BCP-47-tag>` 用来指定 outcome 与 MADR 正文的语言。
`--local-log` 会让 `.seal/` 保持本地、不被跟踪；DriftSeal 只报告当前 tracked 状态，
不会替你修改仓库根目录的 `.gitignore` 或 Git index。seal 在 Git worktree 内时，
`init` 仍可能写入 `.seal/outcomes/.gitignore`，用来忽略派生 sidecar。

## 基本工作流

在修改持久项目内容前，先开启完整的交付 outcome：

```sh
driftseal begin "Ship account recovery" \
  --accept "expired links are rejected" \
  --accept "a valid link resets the password" \
  --verify "npm test"
```

如果下一步仍属于同一个交付目标，就把它追加到当前 outcome：

```sh
driftseal extend "Document recovery-link expiry" \
  --accept "the expiry behavior is documented" \
  --verify "npm test && npm run docs:check"
```

新增 acceptance 时，必须提供一个能证明完整累计 contract 的替代 verifier。没有新增
acceptance 的 extend 可以沿用原 verifier，也可以替换它。任何 extend 都会让之前的
machine evidence 失效。如果交付目标本身变了，应诚实关闭当前 outcome，再开启新的。

完成前依次执行：

```sh
driftseal status
driftseal verify
driftseal end --status completed --note "Shipped recovery with expiry documentation."
```

acceptance-bound outcome 只有在最新 verification 成功后才能关闭为 `completed`。证据
同时绑定 contract hash 与 Git-visible workspace fingerprint。若 verification command
只来自 tracked log、没有匹配的本地 provenance，检查后还必须显式使用
`--allow-tracked-command`。

发生 context loss 或 handoff 后，先重新锚定：

```sh
driftseal status
driftseal log --last 3
```

## 哪些工作需要 outcome

准备长期留在项目中的代码、配置、文档、依赖及同类文件改动需要 outcome。Git 操作、
检查命令、临时辅助工作，以及不会把持久内容写进项目的外部状态变化都不需要。

作用域属于 worktree，而不是某一个 agent process。同一 worktree 内的 agent 与
subagent 重新锚定并继续匹配的 open outcome；不同 worktree 各自持有 outcome。

## Lane

彼此正交、会长期回来接着做的能力，可以共用一条 append-only log，而不共用叙事上下文。
每个 outcome 只属于一条具名 lane。未打标签的历史在 `main` 上。`status` 与
`log --last 3` 跟随当前 lane，指针是 worktree 本地的。

```sh
driftseal lane add index --desc "On-disk inverted index"
driftseal lane switch index
driftseal begin "Ship the inverted index" --accept "lookups return stored postings" --verify "npm test"
```

有 open outcome 时不能切 lane。以后回到同一能力，是切回去再 `begin` 新的 outcome，
而不是重开已关闭的记录。`driftseal lane assign <id> <name>` 可以把已关闭的 outcome
移过去。跨切工作留在 `main`。open outcome 即使属于别的 lane，也会出现在 `log` 里；
若它和当前 lane 不同，`status` 会写出它的 lane。

lane 不能改名或删除。`lane add` 打错的名字会一直出现在 `driftseal lane` 输出里；
补上正确名字，旧名字不要再用。

如果 `begin` 引用了 WAL 里没有 `lane_add` 的 lane，DriftSeal 会推断这条 lane，
让 `status` / `log` / `lane` 仍可读，也允许再用 `lane add` 补上缺失事件。重复的
`lane_add` 只更新 description，不会让 fold 失败；没有前置 `lane_add` 的
`lane_assign` 同样会推断该 lane。若 worktree 的 current-lane 指针指向 WAL 里已
不存在的 lane，`status` / `log` / `lane` 会警告并回落到 `main`；`begin` 仍会拒绝，
直到 `lane switch main` 或把该 lane 加回来。`log --last N` 在 open outcome 属于
别的 lane 时，返回条数可以多于 N。

派生的 SQLite outcome index 放在 WAL 旁边（`outcomes/.outcome-index.sqlite`）。
它只是可以随时删除重建的 read model；`events.jsonl` 仍是唯一 canonical history。
增量同步跟随 `indexedThrough` 和 `indexedLines`。未变化的 hot read 用 file
identity 做常量时间校验；增量追赶前会校验此前全部 WAL prefix 的 checksum。
source 被改写、schema 不兼容、indexed row 损坏或 SQLite read 失败时，DriftSeal
会全量重建。

`log --last N` 使用 `(lane, reclaimed, ordinal)` SQLite index，只读取命中的 outcome
row，并补上其他 lane 的 open outcome。parked event 会依据 index 中保存的 committed
event identity 做定向 overlay，不再因此重扫 committed WAL。无锁读取遇到缺失或 stale
database 时，会在内存中 fold canonical WAL，绝不会返回 stale index。保存的 WAL byte
range 留给后续 projection 使用，但 recent-log lookup 不依赖它。database 可以重建，
不会随 log 一起提交。sidecar 放在 `events.jsonl` 旁边；该目录在 Git worktree
内时，由目录里的 `.gitignore` 忽略。文件留在工作树里，避免被默认禁止写入
`.git/` 的 agent sandbox 拦住。

## Decision 与 MADR

只有当 outcome log 与 Git 无法还原重要上下文时才建立 MADR，例如值得以后重访的
rejected/deferred 路径、长期且难回退的选择理由，或 deprecated/superseded decision。

```sh
driftseal decision add "Expire recovery links after one hour" \
  --context "Recovery links are security-sensitive bearer tokens." \
  --outcome "Use a one-hour lifetime and reject older links." \
  --driver "Limit token exposure" \
  --option "No expiry" \
  --option "One-hour expiry" \
  --consequence "Users must request another link after expiry."
```

通过 `begin` 或 `extend` 的 `--decision <id>` 关联已有 MADR。outcome 关闭为
`completed` 或 `partial` 前，必须 reconcile 每一条关联记录：

```sh
driftseal decision update 1 --status accepted --note "Confirmed by the final implementation."
```

## 命令速查

| 命令 | 用途 |
|---|---|
| `driftseal begin "<outcome>" [--accept "..."] [--verify "..."] [--decision id] [--force]` | 开启一个完整 outcome。 |
| `driftseal extend "<addition>" [--accept "..."] [--verify "..."] [--decision id]` | 向同一 outcome 追加内容，并让旧 verification 失效。 |
| `driftseal verify [--allow-tracked-command]` | 执行累计 verifier 并绑定证据。 |
| `driftseal end [id] [-s status] [-n note] [-r verify-result]` | 诚实关闭 outcome。 |
| `driftseal status` | 查看进行中的 outcome 和当前 lane。 |
| `driftseal log [--last N] [--all] [--all-lanes]` | 查看 outcome 历史（默认当前 lane）。 |
| `driftseal lane add\|switch\|assign\|show` | 按长期能力切分历史。 |
| `driftseal reclaim [id ...] --reason "..." [--force]` | 通过 append-only marker 隐藏无意义的已关闭记录。 |
| `driftseal unreclaim <id> --reason "..."` | 恢复 reclaimed record。 |
| `driftseal absorb [other-events.jsonl] [--decisions dir] [--abandon-theirs\|--abandon-ours]` | 合并另一条 lineage 并处理撞号。 |
| `driftseal decision add\|update\|list\|show` | 管理 MADR。 |
| `driftseal migrate v1-to-v2 inspect --json [migration paths]` | 规范化 v1 状态，供模型分组。 |
| `driftseal migrate v1-to-v2 apply --plan <file> [migration paths]` | 校验分组计划，并在 v1 旁边创建 v2 seal。 |
| `driftseal migrate v1-to-v2 check [migration paths]` | 校验 migration 结果并报告 review/deletion gate。 |
| `driftseal init [--lang tag] [--local-log]` | 安装或升级 repo 协议。 |

完整语法以及 skill、MCP、hook 的安装 target 请查看 `driftseal help`。

## 从 v1 migration

把按步骤记录的 intent 合并为真正交付的 outcome 需要语义判断，因此 migration 特意
采用 model-assisted 流程。

如果发现尚未 migration 的 v1 intent log 或 MADR 目录，普通 v2 repo 命令会 fail
closed，避免悄悄创建一条与 v1 历史无关的 `.seal` lineage。只有 MADR、没有 intent
log 的 v1 repo 也可以直接 migration，不必先创建空 log。

1. 先关闭所有 v1 intent。parked v1 intent 会挡住 migration；升级 CLI 之后用
   `driftseal end`（例如 `--status abandoned`）关掉它，再跑 `inspect`。先合并或冻结
   仍会改 `.intent-log` 的分支；`absorb --git` 会保留 v1 log 合并的两侧，而不是丢掉
   theirs。
2. 读取规范化后的源数据：

   ```sh
   driftseal migrate v1-to-v2 inspect --json > /tmp/driftseal-inspection.json
   ```

3. 让模型生成 `driftseal-v1-to-v2-plan` JSON。所有可见 v1 record 必须按原顺序组成
   完整 partition。只有已经在 v1 中 reclaimed 的记录可以排除，而且每项都要给出理由。
   如果没有剩余的可见记录，`groups` 可以为空；MADR 仍会照常 migration。
4. 用户审阅 outcome 分组后，应用认可的 plan：

   ```sh
   driftseal migrate v1-to-v2 apply --plan /tmp/driftseal-plan.json
   driftseal migrate v1-to-v2 check
   ```

`apply` 会为 source 计算 fingerprint，校验 partition 与 staged v2 log，逐字节复制
所有 v1 MADR，并记录文件名、大小与 hash manifest，使 v1 删除后 `check` 仍能验证
完整性。后续 MADR 内容只有在最新的有效 v2 reconciliation 已记录其当前 hash 时才会被接受。
`apply` 只会在 `.intent-log/`、`.decision-log/` 旁边新建 `.seal/`，绝不删除 v1 数据。
用户审阅并明确认可后，再手动移除旧路径。`check` 在这些路径仍被 git 跟踪时打印
`git rm`，在 `--local-log` 这类未跟踪布局下打印 `rm -rf`。随后执行 `check` 会报告
migration 已完成。

如果 v1 使用自定义存储，inspect 与 apply 都要明确给出 source 和 destination。
`DRIFTSEAL_DECISION_HOME` 只作为 v1 的 MADR source 默认值和 fail-closed 检测来源，
v2 运行期会忽略它。migration marker 会保存这些路径的规范 identity，之后 `check` 可以从 destination 找回
source。source 与 destination 不能互相包含，尤其不能把从 v1 继承的
`DRIFTSEAL_HOME` 同时当成 v2 destination：

```sh
driftseal migrate v1-to-v2 inspect --json \
  --source-log /path/to/v1-intents/events.jsonl \
  --source-decisions /path/to/v1-decisions \
  --destination /path/to/repository/.seal
driftseal migrate v1-to-v2 apply --plan /tmp/driftseal-plan.json \
  --source-log /path/to/v1-intents/events.jsonl \
  --source-decisions /path/to/v1-decisions \
  --destination /path/to/repository/.seal
driftseal migrate v1-to-v2 check \
  --destination /path/to/repository/.seal
```

apply 后应 unset v1 的 `DRIFTSEAL_HOME`，或让它指向新的 seal root。Node API 提供
`sourceLog`、`sourceDecisions`、`destination`；MCP migration tools 可指定自定义 v1
source，但 destination 固定为 server 所属 repo 的 `.seal`，因此普通 MCP workflow
tools 可以立刻看到 migration 后的状态。

## Git 与 merge

在默认 Git-repository seal 中，`begin` 会把 open outcome park 到 WAL 旁边
（`.seal/outcomes/.in-progress.jsonl`，已被 gitignore），避免弄脏 tracked log。
自定义 `$DRIFTSEAL_HOME` 会把该 open outcome 直接写入 `events.jsonl`。`end`
再把 parked lineage flush 到 `.seal/outcomes/events.jsonl`。正常工作期间 event
log 保持 append-only。

发生 merge collision 后执行：

```sh
driftseal absorb
```

不要手改 JSONL。`absorb` 会给撞号的 outcome 与 decision id 重新编号，重新绑定受影响的
contract hash，并拒绝自动合并 shared MADR 的并发编辑。若两条 lineage 都处于 open
状态，必须显式选择 `--abandon-theirs` 或 `--abandon-ours`。

`absorb` 还会通过 reconciliation ID 将 MADR 的 Decision History 条目与合并后的 log
对应，修正其中的 outcome 引用，并同步匹配的内容 hash。默认处理当前 seal 的 `madr/`；
导入其他 log 时，默认从该 log 的 `../madr/` 读取 MADR，可用 `--decisions` 指定其他来源。
运行 `driftseal absorb --dry-run` 可预览修复；旧版本合并后留下的错链，即使 outcome ID
已经没有冲突，也可以修复。找不到对应 reconciliation ID 的条目会保持原样。若 Git merge
driver 提示 decision history 需要修复，运行 `driftseal absorb`，将修复后的 log 和 MADR
加入 staging area，再完成 merge。

## Node API 与 MCP

```js
const { createApi } = require('driftseal');

const seal = createApi({ root: process.cwd(), isolateStorage: true });
seal.begin({
  outcome: 'Ship account recovery',
  acceptance: ['the recovery tests pass'],
  verify: 'npm test',
});
seal.extend({ extension: 'Document token expiry' });
```

API 还提供 `status`、`verify`、`end`、`log`、`lane`、`laneAdd`、`laneSwitch`、
`laneAssign`、`absorb`、reclaim、decision、init 与 migration 方法。

stdio MCP server 会把所有操作固定在一个 repo root。v2 tools 包括
`driftseal_status`、`driftseal_begin`、`driftseal_extend`、`driftseal_verify`、
`driftseal_end`、outcome history、lane、absorb、MADR，以及三个 migration tools。
resources 为：

- `driftseal://outcome/current`
- `driftseal://outcomes/recent`
- `driftseal://lanes`
- `driftseal://madr`

## 存储与信任边界

- `.seal/outcomes/events.jsonl` 是 append-only outcome log。通过 DriftSeal 访问它；
  需要调整可见性、切分 lane 或处理 merge 时使用 `reclaim`、`unreclaim`、`lane`、
  `absorb`，不要手改。
- `.seal/madr/` 保存编号化 MADR。
- `$DRIFTSEAL_HOME` 替换整个 `.seal` root。
- 派生 SQLite outcome index 和当前 lane 指针放在 WAL 旁边
  （`outcomes/.outcome-index.sqlite`、`outcomes/.current-lane`）。index 可以从
  `events.jsonl` 重建；缺失或过期的 current-lane 会回退到 `main`。默认 repo
  seal 还会把 open outcome 和本地 verification provenance park 在 WAL 旁边
  （`outcomes/.in-progress.jsonl`、`outcomes/.driftseal-local-outcome.json`）。
  这两份文件不能重建：删掉 park 会丢掉尚未 flush 的 open outcome，删掉
  provenance 会改变 verifier 信任。自定义 `$DRIFTSEAL_HOME` 会把 open outcome
  直接写入 WAL，provenance 仍放在该 log 旁边。outcomes 目录在 Git worktree 内时，
  这些 sidecar 会被 gitignore。默认 repo seal 下每个 worktree 各自一份；共享的
  `$DRIFTSEAL_HOME` 会共用那里实际存在的文件。
- advisory hook 只提示 lifecycle 状态，不会扩大 repo 中 `AGENTS.md` 的政策边界。

DriftSeal 不会替你判断 verification command 是否安全，也不会判断测试本身是否充分。
执行前应检查命令，并继续遵守正常的 repo 授权与安全规则。

## 开发

```sh
npm test
node --check bin/driftseal.js
node --check bin/driftseal-mcp.js
npm pack --dry-run
```

使用 MIT License。
