# 17. Durable-project-content test replaces the reconstructability carve-outs

Date: 2026-08-21

## Status

Accepted

## Context and Problem Statement

Protocol v13 step 1 said what does NOT need an intent: a three-layer exemption list (Git operations, reconstructable command output, single-step builds/checks). Agents reading it still had to infer the positive rule by elimination, and multi-agent collaboration raised cases the list did not settle: shared-worktree writes, external changes landing in project content, handoff files, non-Git projects, and state changes on remote machines or the local environment.

## Decision Drivers

* Positive rules are cheaper for agents to apply than exemption lists assembled by elimination
* The boundary must preserve non-Git project workflows without logging unrelated external state
* Log records about remote-machine or local-environment state cause attention drift for agents elsewhere

## Considered Options

* Keep the v13 exemption list and add multi-agent clauses to it
* Positive durable-project-content rule with explicit exempt classes

## Decision Outcome

Protocol v14 states the rule positively: record an intent for changes intended to persist as project content (code, configuration, documentation, dependencies, and equivalent files), whether or not the project is inside a Git worktree. Git operations, checks, temporary auxiliary work, and external state changes remain exempt when they do not write durable project content into the current workspace. If an external operation does bring durable content into the project, the intent describes that project-content change rather than the external operation. This supersedes decision 0014, which framed the boundary as reconstructability from Git state.

## Consequences

* Protocol step 1 and README now lead with durable project content rather than Git membership
* Non-Git project files remain covered, while unrelated remote and local environment state stays out of the log
* Decision 0014 is superseded

## Decision History

<!-- driftseal-reconciliation: 546d8fab-02f4-48c0-9d59-b0d6c28516cd -->
### 2026-08-21T03:36:40.782Z — Intent `2026-08-21-003`

Status: Accepted → Accepted

Corrected the boundary to durable project content in both Git and non-Git projects; unrelated remote or local environment state remains exempt unless it writes durable content into the current workspace.

<!-- driftseal-reconciliation: 35f4bbaf-070c-4612-aa3a-00c6ed9f3731 -->
### 2026-08-21T04:50:40.732Z — Intent `2026-08-21-005`

Status: Accepted → Accepted

Accepted in v2: durable project content remains the logging boundary; Git operations, checks, temporary work, and external state remain exempt when they do not write durable project content.
