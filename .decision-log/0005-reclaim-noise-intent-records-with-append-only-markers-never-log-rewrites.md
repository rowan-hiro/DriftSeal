# 5. Reclaim noise intent records with append-only markers, never log rewrites

Date: 2026-08-12

## Status

Accepted

## Context and Problem Statement

Harness- or sandbox-caused failures are recorded honestly as failed intents but carry no project signal, so the intent log needed a reclamation mechanism. The intent log is an append-only WAL: every line is hash-relevant history that fold() validates as a whole, and readers rely on it for re-anchoring after context loss.

## Decision Drivers

* Append-only WAL auditability must survive reclamation
* Noise records (sandbox failures) must leave the default view without losing the honest record
* A mistaken reclaim must be reversible
* Eligibility judgment (failed/abandoned, age, decision links) belongs at command time, not in fold()

## Considered Options

* Append-only reclaim/unreclaim marker events (chosen)
* Markers now plus a later physical compact command
* A gc command that physically rewrites events.jsonl with a backup

## Decision Outcome

Reclaim appends reclaim/unreclaim marker events (event schema v3) with a mandatory --reason; reclaimed records are hidden from log/status output but never deleted, and stay visible via log --all. Rejected physically rewriting or compacting events.jsonl: it breaks the append-only WAL guarantee, destroys the original honest record (including the very failure history an audit may need), and adds crash-recovery surface for no benefit the marker design lacks. Do not reintroduce physical deletion without a new decision superseding this one.

## Consequences

* events.jsonl grows monotonically; no physical compaction exists
* Logs containing reclaim events require event schema v3; older clients refuse them
* Eligibility policy (status, age, decision links) is enforced at command time only; fold() enforces structure so --force reclaims stay valid
* Mistaken reclaims are reversible with driftseal unreclaim, which also requires a reason
