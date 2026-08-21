# 16. Require opt-in without local verification provenance

Date: 2026-08-19

## Status

Accepted

## Context and Problem Statement

Acceptance-bound verification executes a shell command stored in the intent log. A repository, archive, or copied log can contain an open intent whose command was not chosen by the current operator or agent. Git tracking alone cannot describe this boundary because DriftSeal also supports non-Git directories and custom log locations. This decision supersedes 0015 by replacing its Git-log-specific trust test with local provenance that works across every supported storage mode.

## Decision Drivers

* Do not execute repository-supplied shell content through an apparently argument-free command
* Preserve the low-friction workflow for intents created locally in Git, non-Git, API, MCP, and custom-log configurations
* Fail safe when local provenance state is missing or damaged

## Considered Options

* Trust every predeclared command because open intents normally stay parked
* Require confirmation for every verification command
* Treat every configuration without the Git park as untrusted
* Record local provenance outside the intent log and require opt-in only when it does not match

## Decision Outcome

Always disclose the exact command before execution. Commands from a local Git park or a matching local provenance marker run normally. An open intent found only in the intent log, without matching local provenance, requires the explicit --allow-tracked-command CLI flag or allowTrackedCommand API/MCP input. Custom-log provenance stays in Git metadata when a worktree is available; non-Git provenance uses a sidecar bound to the local intent log's file identity, so copying the log and sidecar does not transfer trust. Provenance is removed when the intent closes. Missing, malformed, or copied provenance is treated as untrusted.

## Consequences

* Cloned, merged, archived, or copied open intents cannot execute their verifier accidentally
* Locally begun non-Git and relocated-log workflows do not require repetitive opt-in boilerplate
* Automation that intentionally resumes an intent without local provenance must pass an explicit opt-in
* Losing local provenance for an open non-Git intent causes a safe refusal until the operator opts in

## Decision History

<!-- driftseal-reconciliation: 4dc7b840-e8d9-4929-8939-daba55fe5f71 -->
### 2026-08-19T09:05:26.376Z — Intent `2026-08-19-010`

Status: Accepted → Accepted

Expanded the trust boundary from Git tracking to matching local provenance, preserving smooth local workflows while cloned, copied, or provenance-less commands still require explicit opt-in.

<!-- driftseal-reconciliation: ebadc4a5-1a5a-4c12-a771-68c6f1acabfe -->
### 2026-08-21T04:50:40.589Z — Intent `2026-08-21-005`

Status: Accepted → Accepted

Accepted in v2: verification commands without matching local outcome provenance still require explicit inspection and opt-in.
