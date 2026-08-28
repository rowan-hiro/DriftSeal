# 4. Adopt DriftSeal as the public product identity

Date: 2026-07-29

## Status

Accepted

## Context and Problem Statement

The project needs a distinctive, memorable identity before its first public release, and no compatibility contract exists for the development-only ADL name.

## Decision Drivers

* Create an eye-catching public identity
* Avoid carrying pre-release compatibility baggage

## Considered Options

* Keep the descriptive anti-drift-log name and adl CLI
* Use ScopeForge
* Use Oathlog

## Decision Outcome

Use DriftSeal consistently for the product, npm package, repository, CLI, protocol, environment variables, locks, skill, documentation, and tests. Do not retain the old binary or environment-variable aliases.

## Consequences

* The first public release has one coherent DriftSeal brand.
* Development checkouts using the old binary or environment variables must migrate.

## Decision History

<!-- driftseal-reconciliation: ab261f00-7c6f-4103-b27d-595bfe3cc0bb -->
### 2026-08-28T08:17:34.421Z — Outcome `2026-08-28-001`

Status: Accepted → Accepted

Add ds as an optional short alias for the existing driftseal CLI. DriftSeal remains the product and package identity, driftseal remains the canonical command, and no pre-release binary or environment-variable aliases are restored.
