# Agent instructions

This repository is the DriftSeal source (see `bin/driftseal.js` and
`README.md`), and it follows its own protocol for every coherent delivery
outcome. DriftSeal v2 state lives under `.seal/`: outcome events in
`.seal/outcomes/events.jsonl` and MADR records in `.seal/madr/`. Both are meant
to be committed; `$DRIFTSEAL_HOME` overrides the complete seal root.

<!-- driftseal -->
<!-- driftseal-version: 2.0 -->
<!-- driftseal-log-language: en -->

## Agent protocol: outcome write-ahead log

This repository uses DriftSeal (`driftseal`) to prevent agent drift. This
`AGENTS.md` protocol is the source of truth; use the CLI by default, with MCP
and lifecycle hooks as optional adapters.

**Log language:** `en`. Write outcome-log prose (outcome, extension, note,
verify-result, and reclaim/unreclaim reason) in that language. Keep command
names, flags, status tokens, and ids in English.

1. **Write the outcome first**, before changing durable project content:
   `driftseal begin "<coherent delivery outcome>" --accept "<observable result>" --verify "<exact command that proves the cumulative contract>"`.
   Repeat `--accept` for independently observable criteria and add one
   `--decision <id>` for each existing MADR this outcome may change.
   Record outcomes for changes intended to persist in the project: code,
   configuration, documentation, dependencies, and equivalent files, inside or
   outside Git. Git operations, checks, temporary auxiliary work, and external
   state changes are exempt when they do not write durable project content here.
2. **Extend only the same outcome.** For another step toward the same coherent
   delivery goal, append `driftseal extend "<addition>"`. It may add
   `--accept`, `--decision`, and a replacement `--verify`; adding acceptance
   requires a replacement verifier that proves the complete accumulated contract.
   Every extension invalidates earlier verification and MADR reconciliation. If
   the delivery goal changes, close the current outcome honestly and begin a new one.
   One open outcome belongs to one worktree, or one configured non-Git project
   root. Every agent changing durable content in the same root re-anchors and
   continues it; separate worktrees hold separate outcomes.
3. **Reconcile, verify, then close.** After the final extension, reconcile every
   linked MADR with `driftseal decision update`. Inspect `driftseal status`,
   then run `driftseal verify` for an acceptance-bound outcome. A verifier
   without matching local provenance is untrusted and requires
   `--allow-tracked-command` after inspection. Finish with
   `driftseal end -s completed|partial|failed|abandoned -n "<what happened>"`.
   Completed outcomes require fresh successful verification bound to both the
   current contract hash and Git-visible workspace. Never report success without
   closing the outcome.
4. **Re-anchor after context loss or handoff:** run `driftseal status` and
   `driftseal log --last 3` before changing durable content. Resume the open
   outcome when it still matches; otherwise close it and begin a new one.

**Log access goes only through DriftSeal.** Never read, edit, move, or delete
`.seal/outcomes/events.jsonl` (or its configured equivalent) directly. Use
`reclaim`/`unreclaim` for visibility markers and `absorb` after merge
collisions. These operations preserve append-only single-lineage history.

Seal root: `.seal/` (override with `$DRIFTSEAL_HOME`); outcome log:
`.seal/outcomes/events.jsonl`; commit `.seal/` with the code.
<!-- /driftseal -->

<!-- driftseal-decisions -->
<!-- driftseal-decisions-version: 2.0 -->
<!-- driftseal-log-language: en -->

## Agent protocol: decision log

Record a MADR only when it preserves context that the outcome log and Git cannot
recover: rejected or deferred paths worth revisiting, non-obvious rationale for
long-lived or costly-to-reverse choices, and deprecated or superseded decisions.
Do not record routine, local, readily reversible choices.

**Log language:** `en`. Write decision-log prose (title, context,
outcome, drivers, options, consequences, and update notes) in that language.
Keep MADR section headings, status tokens, and ids in English.

`driftseal decision add "<title>" --context "<problem and constraints>" --outcome "<decision and rationale>" --driver "<decision driver>" --option "<considered option>" --consequence "<result>"`

Use `proposed|accepted|rejected|deferred|deprecated|superseded` statuses. Link
existing MADRs from `begin` or `extend`, then reconcile each linked record
with `driftseal decision update` before successful or partial closure. After a
merge, `driftseal absorb` remaps colliding ids; it never auto-merges concurrent
edits of a shared MADR.
Commit `.seal/madr/` with the code.
<!-- /driftseal-decisions -->
