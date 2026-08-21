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
