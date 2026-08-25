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

Keep a single WAL. Tag each outcome with one named lane (default main). Store the current lane per worktree in a gitignored sidecar beside the WAL (`outcomes/.current-lane`). A shared `$DRIFTSEAL_HOME` shares that pointer. Default log and re-anchor follow the current lane. Refuse switching while an outcome is open. Persist a derived, local lane index as a reconstructable fold cache beside the WAL; rebuild incrementally from indexedThrough and indexedLines, or fully when the log identity changes. Do not put parent pointers in canonical events, and do not allow one open outcome per lane in a shared worktree.

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

<!-- driftseal-reconciliation: a6e34fcd-febd-445e-aa67-5ec03805c5c0 -->
### 2026-08-22T01:24:45.972Z — Outcome `2026-08-22-002`

Status: Accepted → Accepted

Heads, reverse links, and WAL byte ranges remain in the derived index for a seek path that is not consumed yet; incremental rebuild uses indexedThrough and indexedLines. Custom-home sidecar gitignore is written only when the WAL sits inside a Git worktree.

<!-- driftseal-reconciliation: cf785e0f-42c1-49bf-b890-660ef98921ad -->
### 2026-08-22T07:09:25.513Z — Outcome `2026-08-22-003`

Status: Accepted → Accepted

Hot log --last N now follows persisted lane heads and reverse links until it selects N visible outcomes, while parked overlays, unbounded logs, and all-lanes reads retain the full fold path. WAL byte ranges and compact random-access sidecars remain deferred.

<!-- driftseal-reconciliation: ec5edafc-5589-4f8e-98dd-130c9acf0711 -->
### 2026-08-24T03:05:20.495Z — Outcome `2026-08-24-001`

Status: Accepted → Accepted

Named lanes now use relational indexes over lane, reclaimed, status, and ordinal instead of persisted head/reverse-link JSON snapshots. Park overlays and migration preflight consume indexed committed facts; events.jsonl remains canonical.

<!-- driftseal-reconciliation: c7c825b7-1729-4eb6-b390-a16732813ecb -->
### 2026-08-25T03:04:30.862Z — Outcome `2026-08-25-002`

Status: Accepted → Accepted

Store the current-lane pointer beside the WAL at outcomes/.current-lane so agent sandboxes that deny .git writes can switch lanes. Each worktree keeps its own ignored sidecar; a leftover Git-metadata pointer is read until the next write, then removed.

<!-- driftseal-reconciliation: e98a23d9-82a0-47cb-a2f9-f328c5283ea0 -->
### 2026-08-25T06:27:52.227Z — Outcome `2026-08-25-003`

Status: Accepted → Accepted

Retired Git-metadata current-lane cleanup is best-effort and cannot fail lane switch after the workspace sidecar is written. status and log on an unupgraded default repo do not plant the WAL-directory gitignore.

<!-- driftseal-reconciliation: a55202d6-122e-4900-a38f-65fef91ab568 -->
### 2026-08-25T07:21:00.127Z — Outcome `2026-08-25-005`

Status: Accepted → Accepted

v3 current-lane state is only outcomes/.current-lane. Leftover Git-metadata lane pointers are no longer read or removed.
