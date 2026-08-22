# 22. Partition outcome history with named lanes and a derived index

Date: 2026-08-21

## Status

Accepted

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

## Decision History

<!-- driftseal-reconciliation: 820d8f3f-1a0e-4745-b1dd-c0e47d09cc00 -->
### 2026-08-21T14:32:27.702Z — Outcome `2026-08-21-012`

Status: Proposed → Accepted

Named lanes, a derived local index, protocol 2.1, and package 2.1.0 are implemented.

<!-- driftseal-reconciliation: 7df36fcf-0b2d-4a8b-8153-66ca8f04a292 -->
### 2026-08-21T15:47:05.039Z — Outcome `2026-08-21-013`

Status: Accepted → Accepted

Unknown lane names are inferred from the WAL so re-anchor commands stay readable; a stale current-lane pointer falls back to main on status, log, and lane; begin still refuses. Open outcomes remain visible in log across lanes.

<!-- driftseal-reconciliation: a7b38126-b80e-4a93-8dde-8bf819337d73 -->
### 2026-08-22T01:17:37.603Z — Outcome `2026-08-22-001`

Status: Accepted → Accepted

Duplicate lane_add last-writes the description instead of failing the fold. lane_assign infers a missing lane the same way a tagged begin does, so merge-damaged logs stay readable.
