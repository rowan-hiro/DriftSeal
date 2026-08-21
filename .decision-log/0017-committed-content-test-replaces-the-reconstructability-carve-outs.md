# 17. Committed-content test replaces the reconstructability carve-outs

Date: 2026-08-21

## Status

Accepted

## Context and Problem Statement

Protocol v13 step 1 said what does NOT need an intent: a three-layer exemption list (Git operations, reconstructable command output, single-step builds/checks). Agents reading it still had to infer the positive rule by elimination, and multi-agent collaboration raised cases the list did not settle: subagent writes, external changes landing in a shared workspace, handoff files inside the worktree, and state changes on remote machines or the local environment.

## Decision Drivers

* Positive rules are cheaper for agents to apply than exemption lists assembled by elimination
* Log records about out-of-worktree state cause attention drift for agents on other machines

## Considered Options

* Keep the v13 exemption list and add multi-agent clauses to it
* Positive committed-content rule with explicit exempt classes

## Decision Outcome

Protocol v14 states the rule positively: record an intent for changes that alter what the project commits (code, configuration, documentation, dependencies). Everything else is exempt, including work outside any Git worktree, which never belongs in the intent log because a record of another machine's environment change misdirects agents that read the log elsewhere. Supersedes decision 0014, which framed the boundary as reconstructability from Git state.

## Consequences

* Protocol step 1 and README now lead with what to record; the reconstructability examples survive only as illustration
* Decision 0014 is superseded
