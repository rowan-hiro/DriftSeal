# DriftSeal

> **Seal the outcome. Stop the drift.**

DriftSeal is a repository-local protocol and toolchain for keeping coding agents
anchored to a coherent delivery outcome. It records the outcome before durable
work begins, permits append-only extensions toward that same outcome, binds
verification to the accumulated contract, and preserves only the decisions that
need durable rationale.

```text
begin an outcome → extend the same outcome → verify the cumulative contract → close
```

One worktree owns one open outcome. Git records what landed; DriftSeal records
what the work was meant to achieve, how completion was proved, and why durable
decisions were made.

## What changed in v2

DriftSeal v2 is an outcome log rather than an intent-per-step log.

- State lives under one seal root: `.seal/outcomes/events.jsonl` and `.seal/madr/`.
- `DRIFTSEAL_HOME` overrides the whole v2 `.seal` root. A value inherited from
  v1 still points at an intent-log directory; pass that legacy location to the
  migration command explicitly, then unset or replace the variable.
- `driftseal extend` appends another step, acceptance criterion, verifier, or
  decision link to the currently open outcome.
- Every extension changes the contract hash and invalidates earlier verification
  and MADR reconciliation.
- Stored events use `logVersion: 2`. Compatible clients accept `schemaVersion`
  `1` or `2`; lane events and non-default `begin.lane` use `schemaVersion: 2`.
- The generated `AGENTS.md` protocol series is `2.1`. `driftseal init` upgrades
  recognized `2.0` blocks.
- Named lanes partition outcome history on the same WAL. The default lane is
  `main`; `driftseal log` follows the current lane.
- The public CLI, Node API, MCP tools, and MCP resources use outcome terminology.
  v1 names and storage paths are not runtime aliases.

## Install

DriftSeal requires Node.js 22.13 or newer. Its derived outcome index uses the
built-in `node:sqlite` module; no native database package is installed.

```sh
npm install --global driftseal
driftseal --version
```

From a source checkout:

```sh
npm install
node bin/driftseal.js --version
```

Adopt the protocol in a repository:

```sh
driftseal init
```

`init` writes or upgrades the managed blocks in `AGENTS.md`, adds the outcome-log
merge attribute, and configures the local Git merge driver. Run it again in a
fresh clone because Git config is local to each clone.

Use `driftseal init --lang <BCP-47-tag>` to choose the prose language stored in
outcome and MADR records. Use `--local-log` only when `.seal/` should remain
untracked; DriftSeal reports tracked state but does not edit `.gitignore` or the
Git index.

## Core workflow

Open the coherent delivery outcome before changing durable project content:

```sh
driftseal begin "Ship account recovery" \
  --accept "expired links are rejected" \
  --accept "a valid link resets the password" \
  --verify "npm test"
```

If another step is still part of that same delivered outcome, append it:

```sh
driftseal extend "Document recovery-link expiry" \
  --accept "the expiry behavior is documented" \
  --verify "npm test && npm run docs:check"
```

Adding acceptance requires a replacement verifier that proves the complete
accumulated contract. An extension without new acceptance may keep the existing
verifier or replace it. Every extension invalidates previous machine evidence.
If the delivery outcome itself changes, close the current outcome honestly and
begin another one.

Before completion:

```sh
driftseal status
driftseal verify
driftseal end --status completed --note "Shipped recovery with expiry documentation."
```

An acceptance-bound outcome can be completed only after fresh successful
verification. Evidence is bound to both the contract hash and the Git-visible
workspace fingerprint. A verification command that arrived only through tracked
log data requires inspection and an explicit `--allow-tracked-command` opt-in.

After context loss or handoff, re-anchor before changing durable content:

```sh
driftseal status
driftseal log --last 3
```

## What needs an outcome

Record an outcome for durable project-content changes: code, configuration,
documentation, dependencies, and equivalent files. Git operations, checks,
temporary auxiliary work, and external state changes are exempt when they do not
write durable content into the project.

The scope belongs to the worktree, not to the agent process. Agents and subagents
working in the same worktree resume its matching open outcome. Separate worktrees
hold separate outcomes.

## Lanes

Orthogonal long-lived capabilities can share one append-only log without sharing
narrative context. Each outcome belongs to one named lane. Untagged history lives
on `main`. `status` and `log --last 3` follow the current lane, which is local to
the worktree.

```sh
driftseal lane add index --desc "On-disk inverted index"
driftseal lane switch index
driftseal begin "Ship the inverted index" --accept "lookups return stored postings" --verify "npm test"
```

Close the open outcome before switching. Later work on the same capability
switches back and begins a new outcome on that lane; it does not reopen a closed
record. `driftseal lane assign <id> <name>` moves a closed outcome. Cross-cutting
work stays on `main`. An open outcome stays visible in `log` even when it belongs
to another lane; `status` prints that lane when it differs from the current one.

Lanes cannot be renamed or removed. A typo in `lane add` stays in `driftseal lane`
output; add the intended name and stop using the old one.

If a `begin` names a lane whose `lane_add` is missing, DriftSeal infers the lane
so `status`, `log`, and `lane` still work, and `lane add` can write the missing
event. Duplicate `lane_add` records last-write the description instead of failing
the fold. A `lane_assign` that names an unknown lane infers it the same way.
If the worktree's current-lane pointer names a lane the WAL no longer
has, `status`, `log`, and `lane` fall back to `main` with a warning; `begin`
still refuses until you `lane switch main` or add the lane. `log --last N` can
return more than N records when an open outcome sits on another lane.

A derived SQLite outcome index stores folded records beside the WAL
(`outcomes/.outcome-index.sqlite`). It is a disposable read model;
`events.jsonl` remains the only canonical history. Incremental sync follows
`indexedThrough` and `indexedLines`. File identity makes unchanged hot reads
constant-time, while a full checksum of the previously indexed WAL prefix
validates every incremental catch-up. A source rewrite, incompatible schema,
malformed indexed row, or SQLite read error triggers a full rebuild.

`log --last N` uses a `(lane, reclaimed, ordinal)` SQLite index and reads only
the selected outcome rows plus open outcomes from other lanes. Parked events
are checked and folded as a targeted overlay using indexed committed event
identities, so an open outcome does not force a committed-WAL scan. When a
lock-free read sees a missing or stale database, DriftSeal folds the canonical
WAL in memory instead of serving stale index data. Stored WAL byte ranges remain
available for future projections but are not required for recent-log lookup.
The database is reconstructable and is not committed with the log. Sidecars sit
next to `events.jsonl`; when that directory is inside a Git worktree, they are
listed in its `.gitignore`. Keeping the file in the workspace avoids agent
sandboxes that deny writes under `.git/`.

## Decisions and MADR

Use a MADR only for context that the outcome log and Git cannot recover: a
rejected or deferred path worth revisiting, non-obvious rationale for a durable
choice, or a deprecated or superseded decision.

```sh
driftseal decision add "Expire recovery links after one hour" \
  --context "Recovery links are security-sensitive bearer tokens." \
  --outcome "Use a one-hour lifetime and reject older links." \
  --driver "Limit token exposure" \
  --option "No expiry" \
  --option "One-hour expiry" \
  --consequence "Users must request another link after expiry."
```

Link an existing decision from `begin` or `extend` with `--decision <id>`. Before
closing the outcome as `completed` or `partial`, reconcile every linked decision:

```sh
driftseal decision update 1 --status accepted --note "Confirmed by the final implementation."
```

## Command reference

| Command | Purpose |
|---|---|
| `driftseal begin "<outcome>" [--accept "..."] [--verify "..."] [--decision id] [--force]` | Open one coherent outcome. |
| `driftseal extend "<addition>" [--accept "..."] [--verify "..."] [--decision id]` | Append scope to the same outcome and invalidate earlier verification. |
| `driftseal verify [--allow-tracked-command]` | Execute the declared cumulative verifier and bind evidence. |
| `driftseal end [id] [-s status] [-n note] [-r verify-result]` | Close an outcome honestly. |
| `driftseal status` | Show the outcome in progress and the current lane. |
| `driftseal log [--last N] [--all] [--all-lanes]` | Review outcome history (current lane unless `--all-lanes`). |
| `driftseal lane add\|switch\|assign\|show` | Partition history by long-lived capability. |
| `driftseal reclaim [id ...] --reason "..." [--force]` | Hide meaningless closed records with append-only markers. |
| `driftseal unreclaim <id> --reason "..."` | Restore a reclaimed record. |
| `driftseal absorb [other-events.jsonl] [--decisions dir] [--abandon-theirs\|--abandon-ours]` | Merge another lineage and remap colliding outcome or MADR ids. |
| `driftseal decision add\|update\|list\|show` | Manage MADR records. |
| `driftseal migrate v1-to-v2 inspect --json [migration paths]` | Normalize v1 state for model-assisted grouping. |
| `driftseal migrate v1-to-v2 apply --plan <file> [migration paths]` | Validate a grouping plan and stage the v2 seal beside v1. |
| `driftseal migrate v1-to-v2 check [migration paths]` | Validate the staged result and report the review/deletion gate. |
| `driftseal init [--lang tag] [--local-log]` | Install or upgrade the repository protocol. |

Run `driftseal help` for the complete syntax, including skill, MCP, and hook
installation targets.

## Migrating from v1

Migration is deliberately model-assisted because grouping step-sized intents
into delivered outcomes is semantic work.

When an unmigrated v1 intent log or MADR directory is present, normal v2
repository commands fail closed instead of silently starting an unrelated
`.seal` lineage. A MADR-only v1 repository may migrate without creating an
empty intent log first.

1. Close every v1 intent. A parked v1 intent blocks migration. After upgrading
   the CLI, close it with `driftseal end` (for example `--status abandoned`)
   before `inspect`. Merge or freeze branches that still edit `.intent-log`
   first; `absorb --git` keeps both sides of a v1 log merge instead of dropping
   theirs.
2. Inspect the normalized source:

   ```sh
   driftseal migrate v1-to-v2 inspect --json > /tmp/driftseal-inspection.json
   ```

3. Have the model propose a `driftseal-v1-to-v2-plan` JSON document. Its groups
   must form an ordered, complete partition of all visible v1 records. Only
   records already reclaimed in v1 may be excluded, and every exclusion needs a
   reason. `groups` may be empty when no visible records remain; MADRs are still
   migrated.
4. Review the proposed outcomes, then apply the approved plan:

   ```sh
   driftseal migrate v1-to-v2 apply --plan /tmp/driftseal-plan.json
   driftseal migrate v1-to-v2 check
   ```

`apply` fingerprints the source, validates the partition, validates the staged
v2 log, copies every v1 MADR byte-for-byte, and records a name, size, and hash
manifest so `check` can still verify them after v1 is removed. Later MADR content
is accepted only when the latest valid v2 reconciliation attests its current hash. `apply`
creates `.seal/` beside `.intent-log/` and `.decision-log/`; it never deletes v1
data. After the user has reviewed and approved the result, remove the old paths
manually. `check` prints `git rm` when those paths are tracked and `rm -rf` when
they are local-only. Running `check` afterward reports migration complete.

If v1 used custom storage, keep the source and destination explicit for inspect
and apply. `DRIFTSEAL_DECISION_HOME` is a v1-only default for the MADR source
and for fail-closed detection; v2 runtime ignores it. The migration marker records repository-local paths as portable
identities, so later checks recover the source paths from the destination even
after the repository moves. The destination must not contain, or be contained
by, the source log file or MADR directory. In particular, an inherited v1
`DRIFTSEAL_HOME` must not also be used as the v2 destination:

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

After applying, unset the v1 `DRIFTSEAL_HOME` or point it at the new seal root.
The Node API exposes `sourceLog`, `sourceDecisions`, and `destination`. MCP
migration tools accept custom v1 sources but always stage into the server's
fixed repository `.seal`, so ordinary MCP workflow tools immediately see the
migrated state.

## Git and merge behavior

In a Git worktree, `begin` parks the open outcome in Git metadata so it does not
dirty the tracked log. `end` flushes the lineage to
`.seal/outcomes/events.jsonl`. The event log is append-only during normal work.

After a merge collision, run:

```sh
driftseal absorb
```

Do not edit the JSONL manually. `absorb` remaps colliding outcome and decision
ids, rebinds affected contract hashes, and refuses concurrent edits of a shared
MADR. If both lineages remain open, choose explicitly with `--abandon-theirs` or
`--abandon-ours`.

## Node API and MCP

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

The API also exposes `status`, `verify`, `end`, `log`, `lane`, `laneAdd`,
`laneSwitch`, `laneAssign`, `absorb`, reclaim, decision, init, and migration
methods.

The stdio MCP server fixes all operations to one repository root. Its v2 tools
include `driftseal_status`, `driftseal_begin`, `driftseal_extend`,
`driftseal_verify`, `driftseal_end`, outcome history, lane, and absorb tools,
MADR tools, and the three migration tools. Resources are:

- `driftseal://outcome/current`
- `driftseal://outcomes/recent`
- `driftseal://lanes`
- `driftseal://madr`

## Storage and trust boundary

- `.seal/outcomes/events.jsonl` is the append-only outcome log. Access it through
  DriftSeal; use `reclaim`, `unreclaim`, `lane`, and `absorb` instead of manual edits.
- `.seal/madr/` stores numbered MADR documents.
- `$DRIFTSEAL_HOME` replaces the `.seal` root.
- The current lane lives in Git metadata for a default repository seal, or
  beside a custom seal (`outcomes/.current-lane`). The derived SQLite outcome
  index always sits next to the WAL (`outcomes/.outcome-index.sqlite`). When that
  directory is inside a Git worktree, the index sidecars are gitignored. They
  are reconstructable and are not part of the committed WAL.
- Advisory hooks remind agents about lifecycle state but never broaden the
  repository's `AGENTS.md` policy.

DriftSeal does not decide whether a verification command is safe or whether a
test is adequate. Inspect commands before execution and apply normal repository
authorization and security rules.

## Development

```sh
npm test
node --check bin/driftseal.js
node --check bin/driftseal-mcp.js
npm pack --dry-run
```

Licensed under the MIT License.
