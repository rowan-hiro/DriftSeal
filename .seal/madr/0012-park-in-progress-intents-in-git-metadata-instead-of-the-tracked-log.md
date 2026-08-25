# 12. Park in-progress outcomes beside the WAL instead of the tracked log

Date: 2026-08-14

## Status

Accepted

## Context and Problem Statement

driftseal begin appends to the tracked events.jsonl, which dirties the worktree. Git refuses to merge when that file has local changes, so a merge round required a log-only commit before git merge could run.

## Decision Drivers

* Git requires a clean copy of files the merge will update
* Write-ahead logging must still record the open intent locally
* The tracked log remains the committed append-only WAL

## Considered Options

* Commit the begin event before every merge
* Stash events.jsonl around git merge
* Ignore the intent log with a Git skip-worktree bit
* Park the open outcome in a gitignored sidecar beside the WAL until end (chosen)

## Decision Outcome

In a Git worktree using the default seal, begin and later events for the open outcome are parked in a worktree-local gitignored sidecar beside the WAL (`.seal/outcomes/.in-progress.jsonl`). end atomically appends the closed record to the tracked log. If a parked id collides with events that landed during merge, remap it the same way absorb remaps incoming worktree ids. `$DRIFTSEAL_HOME` and non-Git directories keep writing directly to `events.jsonl`. A leftover Git-metadata park is still read and adopted on the next write.

## Consequences

* git merge can run while an intent is in progress without a log-only commit
* Switching branches with an open intent carries that intent with the worktree
* end is the first time the tracked log becomes dirty for that round
* A parked outcome lives only in a gitignored worktree sidecar: removing the worktree or deleting the clone discards the still-open record, and it is never shared by push or clone. Only end makes the round durable in the tracked log, so an in-progress outcome should not be left parked indefinitely.

## Decision History

<!-- driftseal-reconciliation: 5b725aff-6a06-418d-b994-4dcdc0e0576c -->
### 2026-08-14T08:03:42.071Z — Intent `2026-08-14-013`

Status: Accepted → Accepted

Confirmed accepted; added the consequence that a parked intent lives only in local Git metadata and is discarded by worktree removal or clone deletion until end makes it durable.

<!-- driftseal-reconciliation: aec6ef6f-18c3-426b-a40b-57d83b21658d -->
### 2026-08-21T04:50:40.447Z — Intent `2026-08-21-005`

Status: Accepted → Accepted

Accepted in v2: open outcomes remain parked in Git metadata, using a v2-specific park path and flushing closed lineage into .seal/outcomes/events.jsonl.

<!-- driftseal-reconciliation: ecb0b30d-3086-4470-978a-710805d71d52 -->
### 2026-08-25T06:27:52.072Z — Outcome `2026-08-25-003`

Status: Accepted → Accepted

Park the open outcome beside the WAL at outcomes/.in-progress.jsonl, not in Git metadata. Hooks and absorb read that sidecar next to the WAL being folded. A leftover Git-metadata park is still read and adopted on the next write.

<!-- driftseal-reconciliation: e07a4942-f78b-4075-9ea2-55bdb160aca5 -->
### 2026-08-25T06:59:57.493Z — Outcome `2026-08-25-004`

Status: Accepted → Accepted

Title and chosen option now name the WAL-adjacent park sidecar. Open outcomes in a default Git-repository seal stay in outcomes/.in-progress.jsonl; custom homes still write the WAL directly.
