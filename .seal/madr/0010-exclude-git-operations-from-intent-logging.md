# 10. Exclude Git operations from intent logging

Date: 2026-08-13

## Status

Superseded

## Context and Problem Statement

DriftSeal currently exempts only selected Git commands even though Git already records repository history and state transitions. Logging Git-only rounds duplicates that audit trail and adds noise without preserving distinct intent context.

## Decision Drivers

* Avoid duplicating Git's own history
* Keep the intent log focused on non-Git work objectives
* Apply one predictable rule to read-only and mutating Git commands

## Considered Options

* Log every mutating Git operation
* Exempt only staging and commits
* Exclude all Git operations from intent logging (chosen)

## Decision Outcome

Treat every Git operation as outside DriftSeal intent scope. Do not begin an intent solely for inspection, branch or worktree management, staging, commits, merges, rebases, cherry-picks, tags, or pushes. Normal authorization and safety requirements still apply, and any non-Git content change requires an intent.

## Consequences

* Git-only work does not create intent records
* Git history and reflogs remain the evidence for repository operations
* Authorization and destructive-action safeguards remain unchanged

## Decision History

<!-- driftseal-reconciliation: 9ab22e11-048b-4a31-a467-b552e92116c6 -->
### 2026-08-17T13:56:09.392Z — Intent `2026-08-17-008`

Status: Accepted → Superseded

Superseded by 0014: the reconstructability test in protocol v12 step 1 resolves Git-produced artifacts; the blanket any-non-Git-change wording no longer applies.
