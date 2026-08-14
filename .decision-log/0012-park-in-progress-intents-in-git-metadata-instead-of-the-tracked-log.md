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
