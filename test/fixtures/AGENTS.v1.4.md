# Existing repository instructions

<!-- driftseal -->
<!-- driftseal-version: 14 -->
<!-- driftseal-log-language: en -->

## Agent protocol: intent write-ahead log

This repo uses DriftSeal (`driftseal`) to prevent agent drift. Every work round:

This `AGENTS.md` protocol is the source of truth. Use the `driftseal` CLI by
default; the companion skill only helps discover and resume the workflow, while
MCP and lifecycle hooks are optional adapters.

**Log language:** `en`. Write intent-log prose (intent, note,
verify-result, and reclaim/unreclaim reason) in that language. Keep command
names, flags, status tokens, and ids in English.

1. **Write intent first**, before changing durable project content:
   `driftseal begin "<what this round will accomplish>" --accept "<observable outcome>" --verify "<exact command that proves it>"`.
   Repeat `--accept` when completion has multiple independently observable criteria.
   Add one `--decision <id>` for each existing decision this round may change.
   Record intents for changes intended to persist in the project: edits to code,
   configuration, documentation, dependencies, and equivalent project files,
   whether or not the project is inside a Git worktree. Everything else is
   exempt: Git operations (Git maintains their history — inspection, branch
   and worktree management, staging, commits, merges, rebases, cherry-picks,
   tags, and pushes); single-step commands that only build or check work
   already done, such as compiling or running tests; auxiliary file or shell
   operations whose results remain outside durable project content (for example
   an rsync scratch copy or temp scaffolding); and state changes to a remote
   machine or the local environment that do not write durable project content
   into this workspace. When an external operation does bring durable content
   into the project, record an intent for that project-content change, not for
   the external operation itself.
   In multi-agent work, one open intent belongs to one worktree, or to one
   configured project root outside Git. Every agent or subagent that changes
   durable project content in the same root first re-anchors and continues its
   matching open intent; agents working in separate worktrees hold separate
   intents. An agent that only receives another agent's changes through Git or
   into a shared worktree records no receiving intent and lets `verify` expose
   misalignment; handoff files are exempt while ignored or otherwise kept
   outside durable project content and require an intent when promoted into it.
   Size an intent to the smallest unit that leaves the tree self-consistent
   and can be verified on its own.
2. **Execute only the intent.** Scope change? Close the current intent
   (`driftseal end -s partial|abandoned -n "<why>"`) and `driftseal begin` a new one.
3. **Reconcile, verify, then close**: for a linked intent, first reconcile every
   declared decision as described below. For an acceptance-bound intent, inspect the
   exact command shown by `driftseal status`, then run `driftseal verify` to execute it
   and bind its exit status to the current Git-visible workspace contents. A command
   sourced from the repository intent log is untrusted and requires
   `--allow-tracked-command` after inspection; locally parked commands do not.
   An intent without `--accept` uses its declared check directly. Then run
   `driftseal end -s completed|partial|failed|abandoned -n "<what happened>" -r "<optional context for the next agent>"`.
   DriftSeal rejects `completed` when machine verification failed, never ran, or
   the workspace changed after it. Ignored files are outside the workspace fingerprint.
   Outside a Git worktree, only the recorded exit status is available.
   Never report success without closing the intent.
   Before closing a linked intent as `completed` or `partial`, reconcile every
   declared decision with `driftseal decision update <id> --status <status> --note "<why>"`.
   DriftSeal rejects a successful close when a declared decision was not reconciled.
   To revise a decision's prose, edit the file, then run `decision update` to
   record the new content hash. Do not edit a decision after reconciling it;
   run `decision update` again so the final content hash is recorded.
   Interrupted reconciliation is recovered
   by the next linked `decision update` or successful `end`. Closing as
   `failed` or `abandoned` cancels pending recovery for that intent.
   Git operations remain subject to normal authorization and safety requirements
   even though they do not require an intent. Any content change made while
   preparing a Git operation still requires an intent when it meets the
   durable-project-content rule in step 1.
4. **Re-anchor after context loss**: run `driftseal status` and `driftseal log --last 3` before
   doing anything else. The open intent is the source of truth: resume it when its
   objective still matches the current task; otherwise close it (`partial` or
   `abandoned`, with a note) and `begin` a new one. Taking over work in the
   same root from another agent is the same re-anchor: resume the open intent
   when its objective still matches.

**Log access goes only through DriftSeal.** Never read, edit, move, or delete
`.intent-log/events.jsonl` (or anything under `$DRIFTSEAL_HOME`) directly; use
`driftseal` commands or the MCP tools. Retire meaningless closed records with
`driftseal reclaim [id ...] --reason "<why>"` — it appends a marker, never
deletes log lines; `driftseal unreclaim <id> --reason "<why>"` restores one.
After a merge collision, run `driftseal absorb` rather than editing the log;
if both sides still have an open intent, add `--abandon-theirs` or
`--abandon-ours`.

Log: `.intent-log/events.jsonl` (override with `$DRIFTSEAL_HOME`); commit it with the code.
<!-- /driftseal -->

<!-- driftseal-decisions -->
<!-- driftseal-decisions-version: 14 -->
<!-- driftseal-log-language: en -->

## Agent protocol: decision log

Record a MADR document only when it preserves decision context that cannot be
recovered from the intent log and Git history: a rejected or deferred path worth
revisiting, non-obvious rationale behind a long-lived or costly-to-reverse accepted
choice, or a deprecated or superseded decision. Do not record routine, local,
readily reversible choices.

**Log language:** `en`. Write decision-log prose (title, context,
outcome, drivers, options, consequences, and update notes) in that language.
Keep MADR section headings, status tokens, and ids in English.

`driftseal decision add "<title>" --context "<problem and constraints>" --outcome "<decision and rationale>" --driver "<decision driver>" --option "<considered option>" --consequence "<result>"`

Add one `--driver`, `--option`, or `--consequence` flag per item. Use
`--status proposed|accepted|rejected|deferred|deprecated|superseded` when needed.
Use `proposed` for a choice still under active consideration. Use `deferred`
for a deliberately postponed choice and include its revisit trigger.
Count postponed choices with `driftseal decision list --status deferred --count`,
then review them with `driftseal decision list --status deferred`.
When an intent declares an existing decision with `--decision <id>`, use
`driftseal decision update` to record its status transition or explicit confirmation.
After a merge, colliding decision ids are remapped with `driftseal absorb`;
concurrent edits of a shared decision are not auto-merged.
Commit `.decision-log/` with the code.
<!-- /driftseal-decisions -->
