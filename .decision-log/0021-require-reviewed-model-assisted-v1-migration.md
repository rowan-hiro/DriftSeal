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

<!-- driftseal-reconciliation: e99fd0ec-a3e3-4d48-b6c0-c12fe9dc42d0 -->
### 2026-08-21T06:24:31.577Z — Intent `2026-08-21-006`

Status: Accepted → Accepted

Refined migration fingerprints and overlap checks so reviewed migrations survive repository relocation without rejecting safe sibling layouts.
