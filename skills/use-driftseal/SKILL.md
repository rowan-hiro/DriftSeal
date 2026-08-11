---
name: use-driftseal
description: Run repository work through the DriftSeal (`driftseal`) intent, verification, and selective decision workflow. Use when the user asks to use DriftSeal, invokes the skill by name, or works in a repository whose instructions require `driftseal`; also use to resume a DriftSeal-managed task after context loss, reconcile scope changes, close work honestly, or preserve decision context that Git and the intent log cannot recover.
---

# Use DriftSeal

Run repository work as small, closed, auditable rounds. Treat the intent log,
decision log, and Git history as complementary records rather than duplicate
activity streams.

## Locate DriftSeal

- Work from the repository root unless its instructions specify another scope.
- Prefer `driftseal` from `PATH`. In a DriftSeal source checkout, fall back to
  `node bin/driftseal.js` when the global command is unavailable.
- Follow the repository's `AGENTS.md` and storage overrides such as `DRIFTSEAL_HOME`.
- If DriftSeal is unavailable, limit activity to read-only discovery and report the
  blocker. Do not mutate the repository without the required log.

Use one command form consistently within a round. The examples below use
`driftseal`; substitute the local source command when necessary.

## Re-anchor Before Acting

1. Run `driftseal status` at the start of work.
2. Run `driftseal log --last 3` after compaction, a resumed session, or uncertainty.
3. Continue an open intent when it matches the requested work. Treat it as the
   source of truth; do not open a duplicate intent.
4. Close a conflicting intent as `partial` or `abandoned` with an honest note,
   then begin the replacement round.

Do not use `--force` merely for convenience. If another live actor owns the
open intent, stop mutating and coordinate instead of abandoning its work.

## Begin the Round

Before modifying, creating, or deleting files — or making any other change that
may need a rollback — declare one objective and its proof:

```sh
driftseal begin "<small objective for this round>" \
  --verify "<exact command or outcome check>"
```

Make the intent small enough to finish and verify in one round. Prefer an
outcome-focused check over a vague activity such as "inspect the result."
Starting the intent is the first permitted mutation. Single-step commands that
only build, check, or record work already done — compiling, running tests,
`git add`/`git commit` — need no intent of their own.

When the round may change or confirm an existing decision, declare each one at
the boundary with `--decision <id>`. Do not add decision links speculatively.

Read-only inspection needed to choose the objective or verifier may happen
before `begin`. Do not let that inspection turn into unlogged implementation.

## Execute Without Drift

- Change only what the open intent covers.
- Preserve unrelated worktree changes and other actors' edits.
- If the objective expands or changes, close the current intent as `partial`
  or `abandoned`, then start a new round before continuing.
- If the declared verifier becomes invalid, record that honestly and start a
  new round with the correct verifier instead of silently substituting proof.
- If the user replaces the active request, reconcile the open intent before
  acting on the replacement.

## Record Decisions Selectively

Before adding a decision record, ask what useful information would disappear
if only the intent log and final Git commit remained.

Add a MADR record only when it preserves at least one of these:

- a rejected path worth preventing future agents from retrying;
- an unresolved or deliberately deferred path with a concrete revisit trigger;
- non-obvious rationale or trade-offs behind an accepted choice that is
  long-lived, cross-cutting, or costly to reverse;
- the reason an earlier decision became deprecated or superseded.

Skip routine, local, readily reversible choices. Do not restate an accepted
change that the intent and commit already explain.

Use `proposed` for unresolved choices still under active consideration. Use
`deferred` for choices that are deliberately postponed, and state the revisit
trigger in the outcome or consequences. Use `rejected` for an explicitly
ruled-out choice. Reserve `accepted` for the exceptional accepted decisions
whose rationale would otherwise be lost.

Count postponed choices with `driftseal decision list --status deferred --count`,
then review them with `driftseal decision list --status deferred` so they do not
disappear into the chronological log.

For every decision explicitly linked by the open intent, reconcile its current
status and rationale before a successful close:

```sh
driftseal decision update <id> \
  --status <proposed|accepted|rejected|deferred|deprecated|superseded> \
  --note "<what changed or was confirmed, and why>"
```

The update appends a decision history entry tied to the open intent. An
unchanged decision still needs an explicit confirmation note. DriftSeal rejects a
`completed` or `partial` close if any declared decision remains unreconciled;
`failed` and `abandoned` remain available as escape paths.

Do not edit a linked decision after reconciling it. Run `decision update` again
so the final content hash is recorded. If an update is interrupted, rerun it or
successfully close the linked intent; DriftSeal recovers only that intent's pending
transaction. Closing as `failed` or `abandoned` cancels its pending recovery so
historical conflicts cannot block future decision work.

```sh
driftseal decision add "<decision title>" \
  --status deferred \
  --context "<problem and constraints>" \
  --outcome "<current disposition, rationale, and revisit trigger>" \
  --option "<considered option>" \
  --consequence "<result of this disposition>"
```

## Verify and Close

Run the declared verification exactly as written. Then close the intent before
reporting success:

```sh
driftseal end \
  --status completed \
  --note "<what actually happened>" \
  --verify-result "<concise, honest result>"
```

Choose the status from evidence:

- `completed`: achieve the objective and pass the declared verification.
- `partial`: leave useful work but do not achieve the whole objective.
- `failed`: fail to produce a usable result or fail essential verification.
- `abandoned`: intentionally stop or replace the round.

Never leave an intent open merely because the work failed. Never report a
completed result while the log still says `in_progress`.

## Persist the Round in Git

Treat a focused Git commit as the third record: the intent says what was
planned and how it was checked, the decision log preserves otherwise-lost
context, and the commit shows what actually landed.

When the user has authorized a commit, stage and commit only the verified
changes, the closed intent events, and any relevant decision record. This
bookkeeping finalizes the just-closed round and does not require a new intent.

Keep this exception narrow. Open a new intent before making content changes,
fixing a hook failure, rewriting history, rebasing, pushing, or including work
outside the closed round.
