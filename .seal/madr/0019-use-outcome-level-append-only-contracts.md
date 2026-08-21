# 19. Use outcome-level append-only contracts

Date: 2026-08-21

## Status

Accepted

## Context and Problem Statement

Step-sized intent records force agents to close a coherent delivery merely to start the next contributing step, fragmenting attention and history.

## Decision Drivers

* Keep agent attention on the delivered result rather than incidental steps.
* Preserve an append-only audit trail without allowing silent scope mutation.

## Considered Options

* Keep step-sized intents and close between every step.
* Allow mutable in-place edits to an open record.
* Append extensions to one outcome contract.

## Decision Outcome

Treat one coherent deliverable as an outcome opened by begin and append same-outcome scope with extend. Accumulate acceptance, verifier, and decision links; bind verification to the resulting contract hash; require a new outcome only when the delivery goal changes.

## Consequences

* Every extension invalidates earlier machine verification.
* The CLI retains begin, verify, end, status, and log while adding extend and using outcome terminology.
