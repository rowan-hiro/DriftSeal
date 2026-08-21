# 3. Reconcile explicitly linked decisions before successful intent closure

Date: 2026-07-28

## Status

Accepted

## Context and Problem Statement

Intent events and standalone MADR records can drift when implementation changes an existing decision but no explicit relationship requires the decision record to be revisited. Decision 1 originally kept the lifecycles independent, which left reconciliation to convention.

## Decision Drivers

* Prevent silent divergence between completed work and affected decisions
* Apply enforcement only when the relationship is declared
* Preserve append-only intent evidence and human-readable MADR files

## Considered Options

* Keep both logs fully independent
* Move decisions into the intent JSONL stream
* Link selected intents to decisions and require explicit reconciliation

## Decision Outcome

Keep the logs physically separate, but let adl begin declare existing decisions with repeatable --decision flags. Require each declared decision to receive a decision update tied to that intent before the intent can close as completed or partial. Preserve failed and abandoned as escape paths.

## Consequences

* Good: successful linked work cannot leave an affected decision silently stale.
* Good: unrelated intents retain the lightweight workflow.
* Bad: linked work requires an additional reconciliation command.

## Decision History

<!-- adl-reconciliation: cb259713-45a4-4dab-a73b-4ea7af0c9ac6 -->
### 2026-07-28T12:43:24.163Z — Intent `2026-07-28-015`

Status: Accepted → Accepted

Confirmed with repository-scoped serialization, atomic MADR replacement, recoverable prepare/commit events, stable reconciliation IDs, and content-hash verification at close.

<!-- adl-reconciliation: c9a698e6-5184-440e-97ac-ea45610efccd -->
### 2026-07-28T13:12:42.604Z — Intent `2026-07-28-019`

Status: Accepted → Accepted

Confirmed with schema-v2-only linked reconciliation, mandatory prepare/commit pairing and hashes, durable event fsync, and torn-tail repair.

<!-- adl-reconciliation: 4a9fb4c9-6139-481e-b6d2-774ecfe860bc -->
### 2026-07-28T13:49:37.360Z — Intent `2026-07-28-026`

Status: Accepted → Accepted

Scoped pending reconciliation recovery to the current intent and added terminal cancellation events for failed or abandoned closure, so historical divergent prepares cannot block later linked decision work.

<!-- adl-reconciliation: 0c907cd4-1121-4f61-81af-cb024af452ad -->
### 2026-07-28T13:55:24.003Z — Intent `2026-07-28-027`

Status: Accepted → Accepted

Enforced unique reconciliation IDs, linked prepare ownership, exact commit matching, and exactly one matched terminal event per transaction.

<!-- adl-reconciliation: 85e11b91-25ee-4e44-b7d1-2815ce68621e -->
### 2026-07-28T14:43:47.164Z — Intent `2026-07-28-034`

Status: Accepted → Accepted

Unified begin --force with escape-path cancellation, preserved a previously recorded terminal status after interrupted closure, and rejected all reconciliation events after intent closure.

<!-- adl-reconciliation: c47870fe-6096-450e-a897-459b4446cd66 -->
### 2026-07-28T14:53:12.489Z — Intent `2026-07-28-038`

Status: Accepted → Accepted

Preserved all existing MADR trailing whitespace and blank lines during reconciliation by appending history with only the required EOL separator.

<!-- driftseal-reconciliation: e2d3cc74-3ab3-4a55-8b1f-406f6925aa6a -->
### 2026-08-21T04:50:40.021Z — Intent `2026-08-21-005`

Status: Accepted → Accepted

Accepted in v2: linked MADRs still require explicit reconciliation before completed or partial outcome closure, including links appended by extend.
