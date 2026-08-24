# 2. Use an explicit npm package boundary

Date: 2026-07-28

## Status

Accepted

## Context and Problem Statement

The repository should preserve its intent and decision history, while npm consumers only need the runnable CLI, companion skill, and public documentation.

## Decision Drivers

* Preserve project audit history
* Keep the installed package small
* Avoid publishing repository-local agent instructions

## Considered Options

* Publish every tracked file
* Use an explicit package allowlist

## Decision Outcome

Keep .intent-log and .decision-log versioned in Git, and publish only bin, skills, README.md, README.zh-CN.md, and LICENSE through package metadata and npm ignore rules.

## Consequences

* Git retains the full project trail.
* The npm tarball excludes AGENTS.md, tests, and local logs.

## Decision History

<!-- driftseal-reconciliation: 30f3bc0a-723c-4d51-bf88-5e52f78485bd -->
### 2026-08-24T03:05:20.586Z — Outcome `2026-08-24-001`

Status: Accepted → Accepted

The npm allowlist now includes runtime lib modules plus the benchmark and package-smoke entry points referenced by package scripts. Repository-local outcomes, MADRs, agent instructions, and the full test suite remain excluded.
