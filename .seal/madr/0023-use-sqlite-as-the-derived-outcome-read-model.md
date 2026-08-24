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
