# Agent instructions

This repository is the DriftSeal source (see `bin/driftseal.js` and
`README.md`), and it follows its own protocol for every coherent delivery
outcome. DriftSeal v2 state lives under `.seal/`: outcome events in
`.seal/outcomes/events.jsonl` and MADR records in `.seal/madr/`. Both are meant
to be committed; `$DRIFTSEAL_HOME` overrides the complete seal root.

<!-- driftseal -->
<!-- driftseal-version: 2.1 -->
<!-- driftseal-log-language: en -->

## Agent protocol: outcome write-ahead log

This repository uses DriftSeal (`driftseal`) to prevent agent drift. This
`AGENTS.md` protocol is the source of truth; use the CLI by default, with MCP
and lifecycle hooks as optional adapters.

**Log language:** `en`. Write outcome-log prose (outcome, extension, note,
verify-result, and reclaim/unreclaim reason) in that language. Keep command
names, flags, status tokens, ids, and lane names in English.

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
   Outcomes belong to one named lane (`driftseal lane`). The default lane is
   `main`; untagged history lives there. Re-anchoring and `driftseal log`
   follow the current lane. Close the open outcome before switching lanes.
   Create a lane only for a long-lived capability you expect to leave and resume.
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
   `driftseal log --last 3` before changing durable content. Both follow the
   current lane. Resume the open outcome when it still matches; otherwise close
   it and begin a new one. If the requested work belongs to a different existing
   lane, switch first.

**Log access goes only through DriftSeal.** Never read, edit, move, or delete
`.seal/outcomes/events.jsonl` (or its configured equivalent) directly. Use
`reclaim`/`unreclaim` for visibility markers and `absorb` after merge
collisions or when Decision History outcome references are stale. These operations preserve append-only single-lineage history.

Seal root: `.seal/` (override with `$DRIFTSEAL_HOME`); outcome log:
`.seal/outcomes/events.jsonl`; commit `.seal/` with the code.
<!-- /driftseal -->

<!-- driftseal-decisions -->
<!-- driftseal-decisions-version: 2.1 -->
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
merge, `driftseal absorb` remaps colliding ids and repairs managed Decision History
outcome references; it never auto-merges concurrent edits of a shared MADR.
Commit `.seal/madr/` with the code.
<!-- /driftseal-decisions -->

## Cursor Cloud specific instructions

DriftSeal is a dependency-light Node.js (CommonJS, `>=22.13`) CLI with **no build
step** and **no linter/formatter config**. The startup update script runs
`npm install`; nothing else is required to develop.

- **Test:** `npm test` (runs `node --test test/*.test.js`). The suite spawns the
  real CLI and MCP server as subprocesses, so it takes a while — wait for it
  rather than assuming a hang.
- **Static checks:** there is no ESLint/Prettier. Reuse the same static gate the
  repo's own DriftSeal verifiers use: `node --check bin/driftseal.js`,
  `node --check bin/driftseal-mcp.js`, `node --check lib/*.js`, and
  `git diff --check`.
- **Index benchmark:** `npm run benchmark:recent-log -- --quick` validates the
  synthetic workload and SQLite query plan; omit `--quick` for the 10k-outcome
  development benchmark and use `--large` for the 100k-outcome profile.
- **Package smoke:** `npm run test:package` packs and installs the npm tarball,
  then exercises the packaged SQLite-backed CLI.
- **Run the CLI:** `node bin/driftseal.js <command>` always works from the repo
  root. `npm link` is also wired up so `driftseal` and `driftseal-mcp` are on
  `PATH` in this environment.
- **MCP server:** `driftseal-mcp --root <abs-path>` is a **stdio** server. It
  exits immediately on stdin EOF, so a naive backgrounded start (`... &`) looks
  like it "exited early"; that is expected, not a crash. Its behavior is covered
  by `test/mcp.test.js`.
- **This repo dogfoods its own protocol.** The DriftSeal outcome/decision
  protocol above is mandatory: before changing durable project content, open an
  outcome with `driftseal begin`, then `driftseal verify` and `driftseal end`.
  The v2 seal state under `.seal/` (`.seal/outcomes/events.jsonl` and
  `.seal/madr/`) is committed with the code — never edit it by hand; go through
  the `driftseal` CLI.
