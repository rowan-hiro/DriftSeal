# DriftSeal

> **Seal the intent. Stop the drift.**

[简体中文](README.zh-CN.md)

Agentic coding moves fast. **DriftSeal keeps it honest.**

Before an agent touches the code, DriftSeal records what this round will accomplish and how completion will be proved. When the work ends, it records what actually happened. The result is a tiny, auditable contract that survives context loss, scope creep, and optimistic “done” claims.

```text
seal intent → do the work → prove the result → close the round
```

**One open intent. One declared proof. One durable trail.** No service and no database—just local Node.js tools and plain files that travel with the repo.

## The problem is not speed. It is drift.

| Without DriftSeal | With DriftSeal |
| --- | --- |
| Scope quietly expands halfway through a task | One visible intent defines the active round |
| “Done” arrives without meaningful evidence | Verification is declared before implementation |
| Context compaction erases the original goal | `status` and `log` restore the exact intent and history |
| Old architectural debates repeat forever | Selective [MADR](https://adr.github.io/madr/) records preserve the reasoning that matters |
| Concurrent or interrupted writes leave uncertainty | Locks, schema checks, atomic writes, and recovery make failures explicit and recoverable |

DriftSeal complements Git instead of competing with it: the intent says what was planned, the decision log preserves why, and the commit shows what landed.

## Start in 30 seconds

```sh
npm install --global driftseal
cd your-project
driftseal init
```

`driftseal init` writes the protocol to `AGENTS.md`, including how to `absorb`
colliding worktree logs, and configures the local git merge driver. It can be
run again without duplicating either. Pass `--lang zh-CN` (or another
[BCP 47](https://www.rfc-editor.org/rfc/rfc5646.html) tag) to declare the
language agents should use for intent and decision prose; the default is `en`.
Command names, flags, status tokens, ids, and MADR section headings stay in
English. Re-running `init` without `--lang` preserves the declared language
while upgrading the protocol. DriftSeal requires Node.js 18+.

For local development from this checkout:

```sh
npm link
```

## Recommended agent setup

Use `AGENTS.md` + the companion skill + the CLI as the default integration:

- `AGENTS.md`, installed by `driftseal init`, is the authoritative policy.
- `skills/use-driftseal` is a small, agent-agnostic discovery and recovery guide.
- `driftseal` is the default execution surface.

Install the bundled skill for one platform. Project scope is the default:

```sh
driftseal skill install --target codex
driftseal skill install --target kimi-code --scope global
```

| Target | Project scope | Global scope |
| --- | --- | --- |
| `codex` | `.agents/skills/use-driftseal` | `~/.agents/skills/use-driftseal` |
| `kimi-code` | `.kimi-code/skills/use-driftseal` | `~/.kimi-code/skills/use-driftseal` |
| `opencode` | `.opencode/skills/use-driftseal` | `~/.config/opencode/skills/use-driftseal` |
| `claude-code` | `.claude/skills/use-driftseal` | `~/.claude/skills/use-driftseal` |
| `cursor` | `.cursor/skills/use-driftseal` | `~/.cursor/skills/use-driftseal` |

Use `--root <repository>` to select a project when running the installer
elsewhere. Repeated installs of identical content are no-ops, and a skill left
by an earlier DriftSeal release is upgraded in place; only a skill this
installer never wrote requires `--force`. MCP and lifecycle hooks are optional
adapters; enable them only for a concrete host constraint or reminder need, not
as additional policy layers.

## Optional: use DriftSeal through MCP

The same package includes `driftseal-mcp`, a local stdio MCP server. It exposes
structured tools for the complete intent and decision workflow while reusing the
same locking, WAL, atomic-write, schema, and recovery implementation as the CLI.
The server never shells out to `driftseal` and does not parse CLI output.

Fix the server to one repository when starting it:

```sh
driftseal-mcp --root /absolute/path/to/repository
```

Install the server into the current repository's agent config with one of the
supported targets:

```sh
cd /path/to/repository
driftseal mcp install --target codex
driftseal mcp install --target kimi-code
driftseal mcp install --target opencode
driftseal mcp install --target claude-code
driftseal mcp install --target cursor
```

Project scope is the default because each DriftSeal MCP server belongs to one
repository. Every target pins `--root` to the repository's canonical absolute
path, and repeated installs are idempotent.

| Target | Project config | Global config |
| --- | --- | --- |
| `codex` | `.codex/config.toml` | `~/.codex/config.toml` |
| `kimi-code` | `.kimi-code/mcp.json` | `~/.kimi-code/mcp.json` or `$KIMI_CODE_HOME/mcp.json` |
| `opencode` | `opencode.json` | `~/.config/opencode/opencode.json` |
| `claude-code` | `.mcp.json` | `~/.claude.json` |
| `cursor` | `.cursor/mcp.json` | `~/.cursor/mcp.json` |

Use `--root <repository>` when running the installer elsewhere, or choose the
agent's user-level config explicitly:

```sh
driftseal mcp install --target <target> --scope global --root /absolute/path/to/repository
```

Global installs remain pinned to the selected repository. If the chosen config
already contains a different DriftSeal server entry, the installer leaves it
untouched unless `--force` is supplied. Other agent settings and MCP servers are
preserved.

The root is startup configuration, not a tool input. In MCP mode DriftSeal also
ignores inherited `DRIFTSEAL_HOME` and `DRIFTSEAL_DECISION_HOME` overrides, so a
tool call cannot redirect writes outside the selected repository.

The v1 server provides:

| MCP capability | Purpose |
| --- | --- |
| `driftseal_status`, `driftseal_log` | Read the current intent and intent history. |
| `driftseal_begin`, `driftseal_verify`, `driftseal_end` | Open a work round, capture machine verification evidence, and honestly close it. |
| `driftseal_absorb` | Repair merge collisions or absorb another worktree's logs while remapping colliding IDs. |
| `driftseal_reclaim`, `driftseal_unreclaim` | Hide meaningless closed records behind append-only markers, or restore them. |
| `driftseal_decision_list`, `driftseal_decision_show` | Find and read MADR records. |
| `driftseal_decision_add`, `driftseal_decision_update` | Add selective decisions and reconcile linked ones. |
| `driftseal://intent/current` | Read the current intent as a JSON resource. |
| `driftseal://intents/recent` | Read the ten most recent intents as a JSON resource. |
| `driftseal://decisions` | Read the decision catalog as a JSON resource. |

`driftseal_absorb` accepts optional incoming intent-log and decision-directory
paths, an `ours` or `theirs` abandon strategy, and a dry-run mode. Incoming
paths are read-only sources; all repaired output stays under the repository
fixed at server startup. The Git merge-driver form remains a CLI-only plumbing
command.

MCP changes only the execution surface. It does not add policy beyond the
repository's `AGENTS.md`, and the companion skill remains limited to discovery
and recovery guidance.

## Optional: keep the agent reminded through hooks

Agents that support lifecycle hooks can inject a short DriftSeal reminder before
the agent starts answering (`UserPromptSubmit`) and surface a warning when it
finishes (`Stop`). The reminders are advisory — they ask whether the round needs
an intent and whether an open intent still needs verification and
`driftseal end`; they never force another model turn, and they stay silent in
repositories without an intent log.

Install them with:

```sh
cd /path/to/repository
driftseal hook install --target kimi-code --scope global
driftseal hook install --target claude-code
driftseal hook install --target codex
```

| Target | Project config | Global config |
| --- | --- | --- |
| `kimi-code` | Not supported | `~/.kimi-code/config.toml` or `$KIMI_CODE_HOME/config.toml` |
| `claude-code` | `.claude/settings.json` | `~/.claude/settings.json` |
| `codex` | `.codex/hooks.json` | `~/.codex/hooks.json` |

Like `mcp install`, the hook installer accepts `--scope global`,
`--root <repository>`, and `--force`, is idempotent, and preserves unrelated
config entries. Kimi Code documents hooks only in its global `config.toml`, so
its target requires `--scope global`. Claude Code receives prompt context through
`hookSpecificOutput.additionalContext`; its `Stop` reminder uses a UI-only
`systemMessage`, avoiding a continuation loop. Codex installs only the prompt
hook because its `Stop` event has no advisory context channel. Hook commands
search the current directory and its ancestors for an intent log. OpenCode and
Cursor have no supported hook surface for this yet.

## A work round

Declare the round before making non-Git changes:

```sh
driftseal begin "add rate limiting to /api/login" \
  --accept "the sixth login attempt within one minute receives HTTP 429" \
  --verify "npm test test/rate-limit.test.js"
```

Do the work, reconcile any linked decisions, inspect the declared command with
`driftseal status`, and only then let DriftSeal run it:

```sh
driftseal verify
```

`driftseal verify` passes the exact stored string to the operating-system shell.
The command can therefore read or modify files, access the network, or run any
other program available to the current user. Treat it as executable code, not as
passive log data. DriftSeal records local provenance when an intent is opened:
the default Git workflow parks the intent in Git metadata, while non-Git and
custom `DRIFTSEAL_HOME` workflows keep a small local marker outside the intent
log. Those locally created intents run normally. If an open intent arrives only
through an intent log, without matching local provenance, DriftSeal cannot confirm
who chose its command. It prints the command to stderr and refuses to execute it
until you inspect it and explicitly run
`driftseal verify --allow-tracked-command`. The programmatic API and MCP tool
expose the equivalent `allowTrackedCommand` opt-in. Local provenance state is
removed when the intent closes. Non-Git markers are bound to the local log
file's identity, so copying a marker with the log does not transfer trust. If
local provenance is lost or no longer matches, verification fails safe and
requires the same explicit opt-in.

The verification event records the command's exit status, duration, output
digest and byte counts, Git HEAD, and a fingerprint of every tracked or
untracked non-ignored workspace file except the intent event log. A successful
result becomes stale if those workspace contents change. DriftSeal therefore
rejects `completed` until the command passes again on the current workspace.
Command output is spooled to temporary files instead of a fixed in-memory
buffer, then replayed after the command exits and removed. Output size therefore
has no DriftSeal-defined limit, though it remains bounded by available disk space.
Ignored files are deliberately outside this fingerprint. Outside a Git
worktree the fingerprint is unavailable, so the gate proves only the command's
recorded exit status and cannot detect later content changes.

This proves that the declared command passed on recorded contents; it does not
prove that the acceptance criterion or test is adequate. Existing intents
without `--accept` retain the manual verification workflow for compatibility.
Use protected CI, independent review, or human approval when the verifier was
written by the same agent, the outcome is subjective, or the change is high risk.

```sh
driftseal end \
  --status completed \
  --note "Added the limiter and covered the failure path" \
  --verify-result "4 tests pass"
```

If the scope changes, close the current intent as `partial` or `abandoned`, then start a new one. After context loss, use `driftseal status` and `driftseal log --last 3` to re-anchor.

Record an intent for changes intended to persist in the project: edits to code,
configuration, documentation, dependencies, and equivalent project files. The
boundary does not depend on Git: inside a worktree it includes content intended
for commit, while outside Git it includes durable project files. Everything else
is exempt. Git operations are entirely outside the intent log because Git
maintains their history; inspection, branch and worktree management, staging,
commits, merges, rebases, cherry-picks, tags, and pushes never need an intent of
their own, though they still require normal authorization and safety checks.
Single-step builds and checks, such as compiling or running tests, need no
intent. Auxiliary file or shell operations whose results remain outside durable
project content — an `rsync` scratch copy, temp scaffolding — need none either.
State changes to a remote machine or the local environment are also exempt when
they do not write durable project content into this workspace. When an external
operation does bring durable content into the project, record the intent for
that project-content change, not for the external operation itself.

In multi-agent work the scope belongs to the worktree, not the writer. One
worktree holds one open intent; every agent or subagent changing durable project
content there re-anchors and continues that matching intent. Agents in separate
worktrees hold separate intents. A configured project root outside Git follows
the same single-intent rule. An agent that only receives another agent's changes
through Git or into a shared worktree records no receiving intent and lets
`verify` expose misalignment. Handoff files are exempt while ignored or
otherwise kept outside durable project content and require an intent when
promoted into it. Taking over work in the same root is a re-anchor, not a
boundary: resume the open intent when its objective still matches the task.

## Commands

| Command | Purpose |
| --- | --- |
| `driftseal begin "<intent>" [--accept "<outcome>"] [-v "<command>"] [--decision id] [--force]` | Open a work-round intent. Repeat `--accept` for observable completion criteria; acceptance requires a verification command. |
| `driftseal verify [--allow-tracked-command]` | Execute the acceptance-bound intent's predeclared command and bind machine evidence to the current Git-visible workspace contents. Commands without matching local provenance require the explicit opt-in. |
| `driftseal end [id] [-s status] [-n note] [-r verify-result]` | Close an intent honestly. |
| `driftseal status` | Show the intent currently in progress. |
| `driftseal log [-n N] [--all]` | Review intent history (`--all` includes reclaimed records). |
| `driftseal reclaim [id ...] --reason "..." [--older-than days] [--force] [--dry-run]` | Hide meaningless closed records behind append-only markers. |
| `driftseal unreclaim <id> --reason "..."` | Restore a reclaimed record to the visible log. |
| `driftseal absorb [other-events.jsonl] [--decisions dir] [--abandon-theirs \| --abandon-ours] [--dry-run]` | Merge another worktree's logs, remapping colliding intent and decision ids. |
| `driftseal absorb --git <base> <ours> <theirs>` | Git merge driver for `.intent-log/events.jsonl`. |
| `driftseal decision add "<title>" -c "..." -o "..."` | Write a numbered MADR decision. |
| `driftseal decision update <id> [-s status] -n "..."` | Reconcile a linked decision in the open intent. |
| `driftseal decision list [-s status] [--last N \| --count]` | List or count decision records, optionally filtered by status. |
| `driftseal decision show <id>` | Read one decision record. |
| `driftseal skill install --target TARGET [--scope project\|global] [--root path] [--force]` | Install the bundled skill for Codex, Kimi Code, OpenCode, Claude Code, or Cursor. |
| `driftseal mcp install --target TARGET [--scope project\|global] [--root path] [--force]` | Install the repository-pinned MCP server into Codex, Kimi Code, OpenCode, Claude Code, or Cursor. |
| `driftseal hook install --target TARGET [--scope project\|global] [--root path] [--force]` | Install advisory lifecycle reminders into Kimi Code, Claude Code, or Codex. |
| `driftseal hook prompt\|stop [--format plain\|claude-code]` | Emit the reminder a lifecycle hook injects; never blocks. |
| `driftseal init [--lang <tag>] [--local-log]` | Add the adoption protocol to `AGENTS.md` and configure the git merge driver. `--lang` sets the intent/decision log language (BCP 47, default `en`). `--local-log` keeps the logs local and untracked instead of committing them with the code; if the logs are already tracked, init warns with the remediation steps and leaves the index and `.gitignore` untouched. |
| `driftseal --version` or `driftseal -V` | Print the installed DriftSeal version. |
| `driftseal help` | Print CLI usage. |

When `begin` declares one or more `--decision <id>` links, every linked
decision must be reconciled with `driftseal decision update` before that intent can
close as `completed` or `partial`. The update changes the current status when
requested and appends a timestamped history entry tied to the intent. Intents
without decision links keep the ordinary workflow. For acceptance-bound linked
intents, perform every decision update before `driftseal verify`, because a decision
update changes the workspace fingerprint: reconcile, verify, then end.

## Reclaiming noise records

Some closed records stop mattering: a harness or sandbox failure is recorded
honestly as `failed`, but it says nothing about the project. `driftseal
reclaim` retires such records without rewriting history — it appends a
`reclaim` marker (with a mandatory `--reason`) to the same append-only log,
and reclaimed records disappear from `driftseal log` and `driftseal status`
output while remaining in `events.jsonl` and visible with `log --all`.
`driftseal unreclaim <id> --reason "..."` restores a record that turned out to
matter.

Without ids, batch mode reclaims only closed `failed`/`abandoned` records that
are not linked to decisions and are older than `--older-than` days (default
7); use `--dry-run` to preview. `completed` and `partial` records, and any
decision-linked record, can only be reclaimed by explicit id with `--force`.

## Consistency and recovery

DriftSeal serializes mutating commands with locks on the configured intent and
decision-log roots, acquired in a stable order. Decision reconciliation is
journaled as prepare and commit events around an atomic MADR replacement. If
the process stops between those steps, the next linked `decision update` or
successful `end` recovers the transaction from content hashes. A successful
linked-intent close also verifies that the decision file has not changed since
its latest reconciliation. Unlinked intents do not parse the decision log, and
`failed` or `abandoned` remains an escape path when decision recovery cannot
complete. Those terminal statuses cancel recovery for their pending
transactions, and recovery is scoped to the current intent so historical
conflicts cannot block later decision work.

New events carry a schema version. DriftSeal rejects newer unsupported schemas and
fails closed if a legacy client closes a linked intent without reconciliation.
`driftseal init` writes versioned managed blocks and upgrades only exact, recognized
older blocks. Current-version blocks that differ only by log language are also
recognized, so `--lang` can change the language without rewriting policy by hand.
It refuses newer protocol versions and any unrecognized or customized block
without changing `AGENTS.md`.

`--count` prints only the number of records remaining after status filtering.
It cannot be combined with `--last`, whose limiting semantics would make the
count ambiguous. Decision filenames form a lightweight in-memory index: `show`
parses only the requested record, and an unfiltered `--count` reads no MADR
contents. Status-filtered listing and counting parse all records because status
is stored in each MADR document; DriftSeal does not maintain a stale-prone sidecar
index.

## Merging worktrees

Two worktrees allocate intent and decision ids from their local logs, so a
same-day parallel `begin` or `decision add` can collide when the branches
merge. `driftseal absorb` rebuilds a valid log by keeping our ids and remapping
the incoming side, then prints the mapping. A single lineage stays append-only;
absorb is the one cross-lineage rewrite.

```sh
driftseal absorb ../other-worktree/.intent-log/events.jsonl \
  --decisions ../other-worktree/.decision-log
```

With no path, `absorb` repairs the current log after a git conflict or a
concatenated duplicate. If both sides still have an open intent, pass
`--abandon-theirs` or `--abandon-ours`. Concurrent edits of a decision that
already existed in the shared base are not auto-merged.

`driftseal init` writes that absorb rule into `AGENTS.md`, plus `.gitattributes`
and the local git merge driver so `events.jsonl` merges through `absorb --git`.
When decision ids collide, the driver stops the merge before Git can commit an
ambiguous decision catalog. Run `driftseal absorb`, stage the repaired intent
and decision logs, then continue the merge. Clones need `init` again because
the driver lives in local git config.

In a Git worktree, `begin` parks the open intent in Git metadata instead of
appending to the tracked `events.jsonl`. Git can merge while that intent is
still in progress, so you do not need a log-only commit just to get a clean
tree. `end` moves the parked records into the tracked log and writes the closing
record there — never into Git metadata — so an interrupted `end` leaves the
intent open in the log and can simply be run again. If the parked intent's id
collides with incoming merged events, DriftSeal remaps it the same way `absorb`
remaps colliding worktree ids.

When a merge brings in a second open intent, `absorb --abandon-ours` closes the
parked one into the tracked log and `absorb --abandon-theirs` closes the
incoming one and leaves yours parked. `end <id>` also works on the incoming
intent directly, and `begin --force` abandons every open intent at once.

## Storage

- `.intent-log/events.jsonl` is the append-only intent log. All access goes through `driftseal` (CLI or MCP) — never read, edit, move, or delete it directly; use `driftseal reclaim` to retire meaningless records instead of deleting log lines. After a merge collision, use `driftseal absorb` instead of editing the file.
- `.decision-log/` contains numbered MADR decision records.
- Set `DRIFTSEAL_HOME` or `DRIFTSEAL_DECISION_HOME` to store either log outside the current project.

Together, intent events, selective decision records, and Git commits form a layered project log: intent events capture what a work round set out to do and how it would be verified; decision records preserve rationale, rejected paths, or deferred choices that the other layers cannot reconstruct; commits show the coherent change that actually landed. DriftSeal complements Git history rather than duplicating or replacing it.

Keeping the DriftSeal logs in version control makes the project’s working agreements and decision trail travel with the code. The npm package uses an explicit file allowlist, so project-local agent logs are not published to npm.

## Development

```sh
npm test
```

Contributions are welcome. Keep changes focused, add regression coverage for behavior changes, and run the test suite before opening a pull request.

## License

MIT. See [`LICENSE`](LICENSE).
