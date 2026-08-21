# 22. Partition outcome history with named lanes and a derived index

Date: 2026-08-21

## Status

Proposed

## Context and Problem Statement

Orthogonal capabilities share one append-only events.jsonl. After merge, log --last 3 shows global recency, so an agent resuming one capability is fed another capability's narrative. Git worktrees already isolate one open outcome per working copy, but that isolation disappears once lineages are absorbed. Scanning the whole WAL to recover a lane's recent outcomes also gets more expensive as unrelated features append events.

## Decision Drivers

* Re-anchor context should stay inside one long-lived capability
* Verification remains bound to the worktree fingerprint, so one open outcome per worktree still holds
* The WAL stays append-only and single-lineage; the index must be reconstructable

## Considered Options

* Separate events.jsonl files per capability
* Wrap Git worktrees as log partitions
* Named lanes as a WAL projection plus a derived local index

## Decision Outcome

Keep a single WAL. Tag each outcome with one named lane (default main). Store the current lane per worktree in Git metadata. Default log and re-anchor follow the current lane. Refuse switching while an outcome is open. Persist a derived, local lane index of per-lane heads, reverse links, and WAL byte ranges; rebuild when the log identity changes. Do not put parent pointers in canonical events, and do not allow one open outcome per lane in a shared worktree.

## Consequences

* Older clients fail-closed on lane_add, lane_assign, or begin events that name a non-default lane
* Cross-cutting work stays on main or a dedicated integration lane; an outcome cannot belong to two lanes
