# 20. Unify v2 state under the seal root

Date: 2026-08-21

## Status

Accepted

## Context and Problem Statement

The v1 intent and decision logs use separate top-level directories and separate environment overrides, obscuring that they form one protocol state boundary.

## Decision Drivers

* Give repositories one recognizable protocol namespace.
* Allow log-format and protocol-text compatibility to evolve independently.

## Considered Options

* Keep .intent-log and .decision-log as v2 runtime aliases.
* Rename only the intent directory.
* Adopt one .seal root as a clean v2 boundary.

## Decision Outcome

Use .seal as the unified root, with outcome events in .seal/outcomes/events.jsonl and MADR records in .seal/madr. DRIFTSEAL_HOME overrides the complete root. Version stored events independently with logVersion 2 and schemaVersion 1, and start the generated protocol series at 2.0.

## Consequences

* v1 paths are migration inputs rather than runtime aliases.
* All public CLI, API, MCP, hook, merge, and documentation surfaces use outcome terminology.

## Decision History

<!-- driftseal-reconciliation: fe532de2-c499-45d7-a819-7f42fb41b9aa -->
### 2026-08-21T05:35:24.546Z — Outcome `2026-08-21-003`

Status: Accepted → Accepted

Confirmed the unified v2 seal root while adding explicit migration source and destination paths for legacy custom storage.

<!-- driftseal-reconciliation: 25cbb390-a4b6-4f40-91c1-4dfff0613f7e -->
### 2026-08-21T06:09:28.742Z — Outcome `2026-08-21-005`

Status: Accepted → Accepted

Kept CLI and API destination overrides while fixing MCP migration to the server repository seal root and making in-repository source identities portable.
