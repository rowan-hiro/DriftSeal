# Agent protocol: intent write-ahead log

This project (and any repo adopting it) uses DriftSeal (the `driftseal` CLI;
see `bin/driftseal.js` and `README.md`) to prevent agent drift. Follow this
protocol for **every** work round:

1. **Write intent first.** Before modifying, creating, or deleting files — or
   making any other change that may need a rollback:

   ```sh
   driftseal begin "<what this round will accomplish>" --verify "<command or check that proves it>"
   ```

   Keep the intent small enough to close in one round. If an intent is already
   open, `begin` refuses — close the stale one first (`driftseal end -s abandoned -n "<why>"`).
   Add one `--decision <id>` for each existing decision this round may change.
   Single-step commands that only build, check, or record work already done
   (compiling, running tests, `git add`/`git commit`) do not need an intent.

2. **Execute only the intent.** If you discover the scope must change, do not
   silently drift: close the current intent (`partial` or `abandoned`, with a
   note) and `begin` a new one.

3. **Verify, then close.** Run the verification you declared, then:

   ```sh
   driftseal end --status completed|partial|failed|abandoned \
           --note "<what actually happened>" \
           --verify-result "<verification output, honestly>"
   ```

   Never report success to the user without closing the intent first.

   Before closing a linked intent as `completed` or `partial`, reconcile every
   declared decision with
   `driftseal decision update <id> --status <status> --note "<why>"`. DriftSeal rejects a
   successful close when a declared decision was not reconciled. A `failed` or
   `abandoned` intent remains closable as an escape path.
   Do not edit a linked decision after reconciling it; run `decision update`
   again so the final content hash is recorded. The next linked `decision
   update` or successful `end` recovers interrupted reconciliation for that
   intent. Closing as `failed` or `abandoned` cancels its pending recovery.

   When the user has authorized a Git commit, staging and committing only the
   verified changes and the just-closed log is the persistence step for that
   round; it does not require a new intent. Any content change made while
   preparing the commit does require a new intent.

4. **Re-anchor after context loss.** After compaction, a resumed session, or
   any moment of uncertainty: run `driftseal status` and `driftseal log --last 3` before
   doing anything else. The open intent is your source of truth, not your
   memory.

The log lives in `.intent-log/events.jsonl` (override with `$DRIFTSEAL_HOME`) and is
meant to be committed.

## Agent protocol: decision log

Record a MADR document only when it preserves decision context that cannot be
recovered from the intent log and Git history. Typical cases are a rejected or
deferred path worth revisiting, non-obvious rationale behind a long-lived or
costly-to-reverse accepted choice, or a deprecated or superseded decision.
Do not record routine, local, readily reversible choices.

```sh
driftseal decision add "<title>" \
  --context "<problem and constraints>" \
  --outcome "<decision and rationale>" \
  --option "<considered option>" \
  --consequence "<result>"
```

Repeat `--driver`, `--option`, and `--consequence` for multiple items. Use
`--status proposed|accepted|rejected|deferred|deprecated|superseded` when needed.
Use `proposed` for a choice still under active consideration. Use `deferred`
for a deliberately postponed choice and include its revisit trigger.
Count postponed choices with `driftseal decision list --status deferred --count`,
then review them with `driftseal decision list --status deferred`.
When an intent declares an existing decision with `--decision <id>`, use
`driftseal decision update` to record its status transition or explicit confirmation.
Decision records live in `.decision-log/` (override with
`$DRIFTSEAL_DECISION_HOME`) and are meant to be committed.
