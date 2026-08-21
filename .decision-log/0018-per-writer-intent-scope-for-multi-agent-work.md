# 18. Per-writer intent scope for multi-agent work

Date: 2026-08-21

## Status

Accepted

## Context and Problem Statement

Local and remote agents share workspaces and exchange information through Herdr or similar channels. Open questions: whether a subagent's writes fall under the parent's intent, whether receiving external changes needs a receiving-side intent, whether handoff files inside the worktree need intents, and whether an agent taking over an open intent must close it first.

## Decision Drivers

* Attributing writes to the agent that made them keeps each intent's verify binding meaningful
* Receivers recording nothing avoids duplicate intents for the same change; the workspace fingerprint already detects misalignment
* Ignored files are outside the workspace fingerprint, so unignored handoff files would otherwise make every verify stale

## Considered Options

* Parent intent covers all subagent writes
* Receiving agent records an integration intent
* Handoff always requires closing and reopening the intent

## Decision Outcome

The committed-content rule applies per writer: every agent that changes tracked content, subagents included, holds its own open intent. An agent that only receives another agent's changes into a shared workspace records nothing and lets verify expose misalignment. Handoff files are exempt while gitignored and require an intent once tracked. Taking over mid-intent is the same re-anchor as context loss: resume the open intent when its objective still matches.

## Consequences

* Protocol v14 step 1 and step 4, and the README, document the multi-agent scope rules
