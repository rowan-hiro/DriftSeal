# Agent instructions

This repository is the DriftSeal source (see `bin/driftseal.js` and
`README.md`), and it follows its own protocol for **every** work round. The
intent log lives in `.intent-log/events.jsonl` (override with `$DRIFTSEAL_HOME`)
and decision records in `.decision-log/` (override with
`$DRIFTSEAL_DECISION_HOME`); both are meant to be committed.

<!-- driftseal -->
<!-- driftseal-version: 11 -->
<!-- driftseal-log-language: en -->

## Agent protocol: intent write-ahead log

This repo uses DriftSeal (`driftseal`) to prevent agent drift. Every work round:

This `AGENTS.md` protocol is the source of truth. Use the `driftseal` CLI by
default; the companion skill only helps discover and resume the workflow, while
MCP and lifecycle hooks are optional adapters.

**Log language:** `en`. Write intent-log prose (intent, note,
verify-result, and reclaim/unreclaim reason) in that language. Keep command
names, flags, status tokens, and ids in English.

1. **Write intent first**, before modifying, creating, or deleting files, or
   making any other non-Git change that may need a rollback:
   `driftseal begin "<what this round will accomplish>" --verify "<command or check that proves it>"`.
   Add one `--decision <id>` for each existing decision this round may change.
   Git operations never need an intent and are not included in the intent log;
   Git maintains their history. This includes inspection, branch and worktree
   management, staging, commits, merges, rebases, cherry-picks, tags, and pushes.
   Single-step commands that only build or check work already done, such as
   compiling or running tests, also need no intent.
2. **Execute only the intent.** Scope change? Close the current intent
   (`driftseal end -s partial|abandoned -n "<why>"`) and `driftseal begin` a new one.
3. **Verify, then close**: run the declared verification, then
   `driftseal end -s completed|partial|failed|abandoned -n "<what happened>" -r "<verify output>"`.
   Never report success without closing the intent.
   Before closing a linked intent as `completed` or `partial`, reconcile every
   declared decision with `driftseal decision update <id> --status <status> --note "<why>"`.
   DriftSeal rejects a successful close when a declared decision was not reconciled.
   Do not edit a decision after reconciling it; run `decision update` again so
   the final content hash is recorded. Interrupted reconciliation is recovered
   by the next linked `decision update` or successful `end`. Closing as
   `failed` or `abandoned` cancels pending recovery for that intent.
   Git operations remain subject to normal authorization and safety requirements
   even though they do not require an intent. Any non-Git content change made while
   preparing a Git operation does require a new intent.
4. **Re-anchor after context loss**: run `driftseal status` and `driftseal log --last 3` before
   doing anything else. The open intent is the source of truth: resume it when its
   objective still matches the current task; otherwise close it (`partial` or
   `abandoned`, with a note) and `begin` a new one.

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
<!-- driftseal-decisions-version: 11 -->
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
