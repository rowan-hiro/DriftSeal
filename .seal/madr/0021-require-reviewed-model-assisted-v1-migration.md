# 21. Require reviewed model-assisted v1 migration

Date: 2026-08-21

## Status

Accepted

## Context and Problem Statement

Combining step-sized v1 intents into delivered v2 outcomes requires semantic judgment that a deterministic converter cannot recover safely.

## Decision Drivers

* Preserve semantic outcome boundaries rather than mechanically renaming records.
* Make migration retryable, auditable, and non-destructive.

## Considered Options

* Convert every v1 intent into one v2 outcome.
* Let the migration command infer groups without review.
* Use a reviewed model-generated plan with strict validation.

## Decision Outcome

Provide inspect, apply, and check phases. A model proposes an ordered complete grouping plan, the user reviews it, and apply validates the source fingerprint and partition before staging .seal beside v1. Copy MADRs byte-for-byte, permit exclusions only for already-reclaimed records with reasons, and never delete v1 data.

## Consequences

* Removal of .intent-log and .decision-log remains a manual action after explicit user approval.
* Source fingerprints and plan digests make repeated apply operations safe and detect stale plans.

## Decision History

<!-- driftseal-reconciliation: dba5e8cd-dd4d-401d-b777-90a64aa431d8 -->
### 2026-08-21T05:35:24.662Z — Outcome `2026-08-21-003`

Status: Accepted → Accepted

Hardened reviewed migration with fail-closed v1 detection, durable MADR manifests, and valid empty visible partitions.

<!-- driftseal-reconciliation: 3298bf55-7919-4503-8e6d-fa44f7951ad2 -->
### 2026-08-21T06:09:28.860Z — Outcome `2026-08-21-005`

Status: Accepted → Accepted

Completed migration hardening for MADR-only v1 state, authoritative source paths, latest reconciliation hashes, and non-overlapping removal boundaries.

<!-- driftseal-reconciliation: e23a9ce3-13bd-4e7f-884f-7362638b0999 -->
### 2026-08-21T07:05:39.099Z — Outcome `2026-08-21-006`

Status: Accepted → Accepted

Fail-closed v1 detection now keeps custom MADR-only homes distinct from v2 storage, canonical-excludes aliased decision paths, and stores portable fingerprints when a legacy absolute plan is applied.

<!-- driftseal-reconciliation: 0a2c35c1-89d4-4f0a-a274-6e38a44a628e -->
### 2026-08-21T07:34:43.179Z — Outcome `2026-08-21-007`

Status: Accepted → Accepted

Fail-closed now treats a leftover DRIFTSEAL_HOME as unsafe when the repository .seal already holds v2 state, and it re-blocks v1 sources that introduce records not already present in the staged migration.

<!-- driftseal-reconciliation: 9f81efa4-58a3-4dd6-b5ce-de0beceaac76 -->
### 2026-08-21T07:50:53.583Z — Outcome `2026-08-21-008`

Status: Accepted → Accepted

Field testing confirmed reviewed append-only migration refresh is required when v1 gains closed work after staging; the refresh preserves native v2 outcomes and reconciled MADRs.

<!-- driftseal-reconciliation: 3726abd2-3d1c-4a4a-9e8c-cacd0a4cc255 -->
### 2026-08-21T08:05:54.147Z — Outcome `2026-08-21-010`

Status: Accepted → Accepted

Fail-closed now treats leftover DRIFTSEAL_HOME as unsafe for any discovered staged seal root, including custom destinations, and attests leftover v1 records only via imported or excluded source ids plus MADR sha256.

<!-- driftseal-reconciliation: cff82170-6f7f-4b40-abc4-a784d7c866f1 -->
### 2026-08-21T08:30:34.657Z — Outcome `2026-08-21-011`

Status: Accepted → Accepted

Fail-closed now prefers the real custom v1 log over default .decision-log, ignores empty outcomes directories, lets end close a parked v1 intent, keeps both sides of a v1 absorb --git merge, and prints rm -rf when v1 paths are untracked.
