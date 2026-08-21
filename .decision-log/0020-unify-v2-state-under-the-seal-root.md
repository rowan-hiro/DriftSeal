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
