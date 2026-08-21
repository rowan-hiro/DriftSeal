# 9. Allow absorb to rewrite divergent intent logs when remapping colliding ids

Date: 2026-08-13

## Status

Accepted

## Context and Problem Statement

Two worktrees allocate YYYY-MM-DD-NNN intent ids and sequential decision ids from their local logs. Those logs are committed, so a same-day parallel begin or decision add collides on merge. fold() and decisionIndex() reject duplicates. Decision 0005 forbids rewriting a single-lineage WAL, which would also forbid the only practical merge repair.

## Decision Drivers

* Worktrees share git history but not locks or working copies
* Human-readable sequential ids must stay typeable
* Single-lineage append-only auditability from decision 0005 must survive

## Considered Options

* Change ids to UUIDs or worktree-prefixed ids
* Share one DRIFTSEAL_HOME across worktrees
* Require agents to rekey ids by hand
* Remap incoming ids at absorb/merge time (chosen)

## Decision Outcome

Add driftseal absorb (and a git merge driver) that builds a new merged WAL by remapping the incoming side's colliding intent and decision ids. This is a cross-lineage merge, not an in-lineage compact: a single lineage remains append-only. Keep the existing id format. Fail when both sides still have an in_progress intent unless --abandon-theirs or --abandon-ours is given. Fail on concurrent edits of a decision that already existed in the shared base.

## Consequences

* events.jsonl may be atomically replaced during absorb; the output remains valid schema v3
* Incoming colliding ids are rewritten and printed as a mapping; callers must not assume those original ids survive the merge
* Two open intents still require an explicit abandon flag

## Decision History

<!-- driftseal-reconciliation: ecb271f6-e7c0-4b91-87e7-946460cedb4c -->
### 2026-08-13T14:13:36.309Z — Intent `2026-08-13-015`

Status: Accepted → Accepted

Confirmed the accepted absorb design while making decision handling three-way and fail-safe: Git stops before ambiguous decision ids are committed, and no-arg absorb reconstructs exact side ownership from merge metadata.

<!-- driftseal-reconciliation: e08a53de-977d-462d-878c-a73adaa06948 -->
### 2026-08-21T04:50:40.306Z — Intent `2026-08-21-005`

Status: Accepted → Accepted

Accepted in v2: absorb remains the only lineage rewrite for collision repair, now remaps outcome starts and rebinds contract hashes affected by decision-id changes.
