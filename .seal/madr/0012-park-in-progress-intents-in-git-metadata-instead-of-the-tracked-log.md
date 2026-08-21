# 12. Park in-progress intents in Git metadata instead of the tracked log

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
* Park the open intent in Git metadata until end (chosen)

## Decision Outcome

In a Git worktree using the default .intent-log, begin and later events for the open intent are parked in a worktree-local file under the Git directory. end atomically appends the closed record to the tracked log. If a parked id collides with events that landed during merge, remap it the same way absorb remaps incoming worktree ids. DRIFTSEAL_HOME and non-Git directories keep writing directly to events.jsonl.

## Consequences

* git merge can run while an intent is in progress without a log-only commit
* Switching branches with an open intent carries that intent with the worktree
* end is the first time the tracked log becomes dirty for that round
* A parked intent lives only in local Git metadata: removing the worktree (git worktree remove/prune) or deleting the clone discards the still-open record, and it is never shared by push or clone. Only end makes the round durable in the tracked log, so an in-progress intent should not be left parked indefinitely.

## Decision History

<!-- driftseal-reconciliation: 5b725aff-6a06-418d-b994-4dcdc0e0576c -->
### 2026-08-14T08:03:42.071Z — Intent `2026-08-14-013`

Status: Accepted → Accepted

Confirmed accepted; added the consequence that a parked intent lives only in local Git metadata and is discarded by worktree removal or clone deletion until end makes it durable.

<!-- driftseal-reconciliation: aec6ef6f-18c3-426b-a40b-57d83b21658d -->
### 2026-08-21T04:50:40.447Z — Intent `2026-08-21-005`

Status: Accepted → Accepted

Accepted in v2: open outcomes remain parked in Git metadata, using a v2-specific park path and flushing closed lineage into .seal/outcomes/events.jsonl.
