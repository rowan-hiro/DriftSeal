# 23. Use SQLite as the derived outcome read model

Date: 2026-08-24

## Status

Accepted

## Context and Problem Statement

The JSON sidecar must be parsed in full for every read, so bounded record selection does not improve end-to-end latency. DriftSeal needs scalable indexed queries while preserving events.jsonl as the canonical append-only audit log.

## Decision Drivers

* Recent outcome queries should read work proportional to their result set
* Query, migration, transaction, and integrity behavior should rely on a maintained storage engine
* The npm package should avoid native addons and third-party database bindings

## Considered Options

* Keep the full JSON fold cache
* Build a Git-style binary pack and index
* Use LMDB or better-sqlite3
* Use built-in node:sqlite

## Decision Outcome

Raise the runtime floor to Node.js 22.13 and use built-in node:sqlite for a disposable, source-bound read model. Keep the WAL canonical, rebuild the database on mismatch or corruption, and fall back to a full fold when a trustworthy database snapshot is unavailable.

## Consequences

* Node.js 18 and 20 are no longer supported
* The derived index becomes a SQLite sidecar that can be deleted and rebuilt
* Future filters and search projections can evolve through schema migrations and an OutcomeIndex API

## Decision History

<!-- driftseal-reconciliation: c4bb9611-b682-4a9c-bc49-5422c37f1851 -->
### 2026-08-24T03:05:20.402Z — Outcome `2026-08-24-001`

Status: Accepted → Accepted

DriftSeal 3.0 uses built-in node:sqlite on Node.js 22.13+ for a reconstructable outcome read model. One canonical fold bulk-builds the database; WAL tails update affected rows transactionally; exact source and projection checks trigger safe rebuilds or canonical fallback.

<!-- driftseal-reconciliation: f83ad242-6cf5-4cfc-b3b9-7b9f53371118 -->
### 2026-08-25T02:55:43.161Z — Outcome `2026-08-25-001`

Status: Accepted → Accepted

Keep the disposable SQLite index beside the WAL at outcomes/.outcome-index.sqlite so agent sandboxes that deny .git writes can rebuild it. Reject Git metadata for the database; current lane can stay there. Init plants the sidecar gitignore before begin parks an outcome.

<!-- driftseal-reconciliation: 6e0e17a4-ea70-41fb-8d9a-a0a728a5e946 -->
### 2026-08-25T06:27:52.302Z — Outcome `2026-08-25-003`

Status: Accepted → Accepted

Retired Git-metadata SQLite cleanup is best-effort after adopting a leftover database. The WAL-directory gitignore covers rebuild journals named ..outcome-index.sqlite.*.tmp-*. status and log do not plant that ignore file. Current lane also lives beside the WAL, not in Git metadata.

<!-- driftseal-reconciliation: 9208149d-7f43-43bd-86ca-e9b27544f482 -->
### 2026-08-25T06:59:57.568Z — Outcome `2026-08-25-004`

Status: Accepted → Accepted

Index persistence inside a Git worktree requires the complete WAL-directory ignore contract, including atomic temp names for lane, park, and provenance sidecars. status and log fold instead of planting or upgrading that file.
