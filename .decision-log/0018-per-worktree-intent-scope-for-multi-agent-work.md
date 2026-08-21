# 18. Per-worktree intent scope for multi-agent work

Date: 2026-08-21

## Status

Accepted

## Context and Problem Statement

Local and remote agents share workspaces and exchange information through Herdr or similar channels. Open questions: whether agents sharing one worktree may hold separate intents, whether receiving external changes needs a receiving-side intent, whether handoff files inside the worktree need intents, and whether an agent taking over an open intent must close it first.

## Decision Drivers

* DriftSeal enforces at most one open intent in a worktree, so the protocol must not require an impossible per-agent state
* One worktree-wide intent keeps its verify binding aligned with the content all agents in that root can change
* Receivers recording nothing avoids duplicate intents for the same change; the workspace fingerprint already detects misalignment
* Ignored files are outside the workspace fingerprint, so unignored handoff files would otherwise make every verify stale

## Considered Options

* Every agent holds a separate intent inside the same worktree
* One open intent belongs to the worktree and all agents sharing it re-anchor before writing
* Receiving agent records an integration intent
* Handoff always requires closing and reopening the intent

## Decision Outcome

Intent scope belongs to the worktree, not the writer. One worktree has at most one open intent; every agent or subagent changing durable project content there first re-anchors and continues the matching intent. Agents in separate worktrees hold separate intents, and a configured project root outside Git follows the same single-intent rule. An agent that only receives another agent's changes through Git or into a shared worktree records no receiving intent and lets verify expose misalignment. Handoff files are exempt while ignored or otherwise outside durable project content and require an intent when promoted into it. Taking over work in the same root is the same re-anchor as context loss: resume the open intent when its objective still matches.

## Consequences

* Protocol v14 step 1 and step 4, and the README, document the worktree-scoped multi-agent rules
* Shared-worktree agents continue one intent; separate worktrees preserve independent intent histories

## Decision History

<!-- driftseal-reconciliation: e4884f85-e12e-45bf-8158-5eb4822b803e -->
### 2026-08-21T03:36:40.889Z — Intent `2026-08-21-003`

Status: Accepted → Accepted

Corrected multi-agent ownership from per writer to per worktree: agents sharing one root resume the same open intent, while separate worktrees keep separate intents.
