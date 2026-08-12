---
name: use-driftseal
description: Run repository work through the DriftSeal (`driftseal`) intent, verification, and selective decision workflow. Use when the user asks to use DriftSeal, invokes the skill by name, or works in a repository whose instructions require `driftseal`; also use to resume a DriftSeal-managed task after context loss, reconcile scope changes, close work honestly, or preserve decision context that Git and the intent log cannot recover.
---

# Use DriftSeal

This skill is the usage guide for DriftSeal: how to find it and which command
or tool to reach for. The binding protocol — when an intent is required, how
to close one honestly, when a decision record is warranted, how reclamation
works — lives in the target repository's `AGENTS.md` (injected by
`driftseal init`). Follow that file; do not substitute this guide or memory
for it.

## Locate DriftSeal

- Prefer the `driftseal_*` MCP tools when the DriftSeal MCP server is available
  for the target repository: `driftseal_status`, `driftseal_begin`,
  `driftseal_end`, `driftseal_log`, `driftseal_reclaim`, `driftseal_unreclaim`,
  and the `driftseal_decision_*` tools. Their input schemas come from the MCP
  client, not from `driftseal help`. The server keeps state in its fixed
  repository root and ignores storage-override environment variables.
- Otherwise prefer `driftseal` from `PATH`, where `DRIFTSEAL_HOME` and
  `DRIFTSEAL_DECISION_HOME` overrides apply. In a DriftSeal source checkout,
  fall back to `node bin/driftseal.js`.
- Use one interface consistently within a round.
- If DriftSeal is unavailable, limit activity to read-only discovery and report
  the blocker. Do not mutate the repository without the required log.

## Command Map

Re-anchor after context loss or uncertainty; when `status` reports an open
intent, the repository protocol defines whether to resume or replace it:

```sh
driftseal status
driftseal log --last 3        # add --all to include reclaimed records
```

Run each work round as the repository's protocol directs (`-v`, `-s`, `-n`,
and `-r` are the short forms of `--verify`, `--status`, `--note`, and
`--verify-result`):

```sh
driftseal begin "<objective>" --verify "<proof>" [--decision <id>]
# ... do only what the intent covers ...
driftseal end --status <status> --note "<what happened>" --verify-result "<proof output>"
```

Record and reconcile decisions as the repository's decision protocol directs:

```sh
driftseal decision add "<title>" --context "..." --outcome "..."
driftseal decision update <id> [--status <status>] --note "<what changed or was confirmed>"
driftseal decision list --status deferred
```

Retire meaningless closed records as the repository's protocol directs:

```sh
driftseal reclaim [id ...] --reason "<why>" [--dry-run]
driftseal unreclaim <id> --reason "<why>"
```

For exact flags, eligibility rules, and recovery behavior, run
`driftseal help` and read the repository's `AGENTS.md`.
