# 15. Require opt-in for verification commands from tracked intent logs

Date: 2026-08-19

## Status

Accepted

## Context and Problem Statement

Acceptance-bound verification executes a shell command stored in the intent log. A repository can commit an open intent whose command was not chosen by the current operator or agent.

## Decision Drivers

* Do not execute repository-supplied shell content through an apparently argument-free command
* Preserve the low-friction workflow for intents created locally in the current worktree

## Considered Options

* Trust every predeclared command because open intents normally stay parked
* Require confirmation for every verification command
* Require explicit opt-in only when the open intent came from the repository log

## Decision Outcome

Always disclose the exact command before execution. Commands from a local parked intent run normally; commands sourced only from the repository intent log require the explicit --allow-tracked-command CLI flag or allowTrackedCommand API/MCP input.

## Consequences

* Cloned or merged open intents cannot execute their verifier accidentally
* Automation that intentionally resumes a tracked open intent must pass an explicit opt-in
