---
name: use-driftseal
description: Follow DriftSeal-managed repository work when AGENTS.md requires `driftseal`, the user invokes DriftSeal, or an interrupted intent must be resumed. Use this skill to locate the authoritative repository policy, re-anchor state after context loss, and choose the execution surface; prefer the `driftseal` CLI, using MCP only when the repository or user explicitly selects it.
---

# Use DriftSeal

Treat the target repository's applicable `AGENTS.md` as the source of truth.
This skill helps locate and resume that workflow; it does not restate or extend
the policy.

## Locate DriftSeal

- Read the applicable `AGENTS.md` before making changes.
- Prefer `driftseal` from `PATH`. In a DriftSeal source checkout, fall back to
  `node bin/driftseal.js`.
- Use an explicitly configured, repository-pinned MCP server only when the user
  or repository selects it, or when shell execution is unavailable. Its tool
  schemas, not `driftseal help`, define the MCP interface.
- Use one interface consistently within a round.
- If DriftSeal is unavailable, limit activity to read-only discovery and report
  the blocker. Do not mutate the repository without the required log.

## Re-anchor When Needed

After context loss or when intent state is uncertain, run:

```sh
driftseal status
driftseal log --last 3
```

Then resume, replace, verify, or close the intent exactly as `AGENTS.md`
requires. For command syntax, run:

```sh
driftseal help
```

## After a merge

If `status` or `log` fails with a duplicate id or with `multiple intents in
progress`, or the intent log has conflict markers, run `driftseal absorb`
instead of editing `.intent-log/events.jsonl`. When both sides still have an
open intent, add `--abandon-theirs` or `--abandon-ours`; this works whether your
open intent sits in the log or is parked in Git metadata. `driftseal init` also
configures the local git merge driver; clones need `init` again for that driver.

In a Git worktree, `begin` does not dirty the tracked intent log, so `git merge`
can run with an intent still in progress. `end` writes the closed record to
`.intent-log/events.jsonl`; if it is interrupted, the intent stays open there
and `end` can be run again.

Do not treat this skill, MCP descriptions, or lifecycle-hook reminders as
additional policy. If they conflict with `AGENTS.md`, follow `AGENTS.md`.
