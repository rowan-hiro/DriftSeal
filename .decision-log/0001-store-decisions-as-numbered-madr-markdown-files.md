# 1. Store decisions as numbered MADR Markdown files

Date: 2026-07-28

## Status

Superseded

## Context and Problem Statement

The project needs to preserve meaningful choices, including accepted and rejected options, alongside the existing intent log.

## Decision Drivers

* Keep decision rationale human-readable and diff-friendly
* Expose intent and decision logging through one CLI
* Keep decision records independent from intent lifecycle events

## Considered Options

* Standalone numbered MADR Markdown files
* Decision events in the existing JSONL stream

## Decision Outcome

Use the nested adl decision interface to create one numbered MADR Markdown file per decision in .decision-log, rather than placing decision events in the intent JSONL stream.

## Consequences

* Good: each decision is directly readable and can evolve through standard MADR statuses.
* Good: decision records can be reviewed and committed with code.
* Bad: consumers must inspect a second project directory.

## Decision History

### 2026-07-28T11:36:50.520Z — Intent `2026-07-28-013`

Status: Accepted → Superseded

Superseded by decision 3, which replaces full lifecycle independence with explicit links and mandatory reconciliation for successful linked intents.
