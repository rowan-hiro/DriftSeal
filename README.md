# DriftSeal

> **Seal the intent. Stop the drift.**

[简体中文](README.zh-CN.md)

Agentic coding moves fast. **DriftSeal keeps it honest.**

Before an agent touches the code, DriftSeal records what this round will accomplish and how completion will be proved. When the work ends, it records what actually happened. The result is a tiny, auditable contract that survives context loss, scope creep, and optimistic “done” claims.

```text
seal intent → do the work → prove the result → close the round
```

**One open intent. One declared proof. One durable trail.** No service and no database—just local Node.js tools and plain files that travel with the repo.

## The problem is not speed. It is drift.

| Without DriftSeal | With DriftSeal |
| --- | --- |
| Scope quietly expands halfway through a task | One visible intent defines the active round |
| “Done” arrives without meaningful evidence | Verification is declared before implementation |
| Context compaction erases the original goal | `status` and `log` restore the exact intent and history |
| Old architectural debates repeat forever | Selective [MADR](https://adr.github.io/madr/) records preserve the reasoning that matters |
| Concurrent or interrupted writes leave uncertainty | Locks, schema checks, atomic writes, and recovery make failures explicit and recoverable |

DriftSeal complements Git instead of competing with it: the intent says what was planned, the decision log preserves why, and the commit shows what landed.

## Start in 30 seconds

```sh
npm install --global driftseal
cd your-project
driftseal init
```

`driftseal init` safely adds the protocol to `AGENTS.md` and can be run again without duplicating it. DriftSeal requires Node.js 18+.

For local development from this checkout:

```sh
npm link
```

## Give your coding agent the complete workflow

The package includes `skills/use-driftseal`, an agent-agnostic companion skill that drives repository work through the complete DriftSeal loop while keeping decision records selective. Install or link it using your agent runtime’s skill discovery convention, then invoke `use-driftseal` by name.

## Use DriftSeal through MCP

The same package includes `driftseal-mcp`, a local stdio MCP server. It exposes
structured tools for the complete intent and decision workflow while reusing the
same locking, WAL, atomic-write, schema, and recovery implementation as the CLI.
The server never shells out to `driftseal` and does not parse CLI output.

Fix the server to one repository when starting it:

```sh
driftseal-mcp --root /absolute/path/to/repository
```

For Codex, add the installed command as a stdio MCP server:

```sh
codex mcp add driftseal -- driftseal-mcp --root /absolute/path/to/repository
```

The root is startup configuration, not a tool input. In MCP mode DriftSeal also
ignores inherited `DRIFTSEAL_HOME` and `DRIFTSEAL_DECISION_HOME` overrides, so a
tool call cannot redirect writes outside the selected repository.

The v1 server provides:

| MCP capability | Purpose |
| --- | --- |
| `driftseal_status`, `driftseal_log` | Read the current intent and intent history. |
| `driftseal_begin`, `driftseal_end` | Open and honestly close a work round. |
| `driftseal_decision_list`, `driftseal_decision_show` | Find and read MADR records. |
| `driftseal_decision_add`, `driftseal_decision_update` | Add selective decisions and reconcile linked ones. |
| `driftseal://intent/current` | Read the current intent as a JSON resource. |
| `driftseal://intents/recent` | Read the ten most recent intents as a JSON resource. |
| `driftseal://decisions` | Read the decision catalog as a JSON resource. |

The companion skill remains important: MCP supplies controlled, structured
operations; the skill teaches the agent when to use them and how to avoid drift.

## A work round

Declare the round before changing files:

```sh
driftseal begin "add rate limiting to /api/login" \
  --verify "npm test test/rate-limit.test.js"
```

Do the work, run the declared check, then reconcile the result:

```sh
driftseal end \
  --status completed \
  --note "Added the limiter and covered the failure path" \
  --verify-result "4 tests pass"
```

If the scope changes, close the current intent as `partial` or `abandoned`, then start a new one. After context loss, use `driftseal status` and `driftseal log --last 3` to re-anchor.

Single-step commands that only build, check, or record work already done — compiling, running tests, `git add`/`git commit` — need no intent of their own. When a commit is authorized, staging and committing only the verified changes and the just-closed intent log finalizes that round. Any content change made while preparing the commit starts a new round.

## Commands

| Command | Purpose |
| --- | --- |
| `driftseal begin "<intent>" [-v "<verify>"] [--decision id] [--force]` | Open a work-round intent and optionally link existing decisions. |
| `driftseal end [id] [-s status] [-n note] [-r verify-result]` | Close an intent honestly. |
| `driftseal status` | Show the intent currently in progress. |
| `driftseal log [-n N]` | Review intent history. |
| `driftseal decision add "<title>" -c "..." -o "..."` | Write a numbered MADR decision. |
| `driftseal decision update <id> [-s status] -n "..."` | Reconcile a linked decision in the open intent. |
| `driftseal decision list [-s status] [--last N \| --count]` | List or count decision records, optionally filtered by status. |
| `driftseal decision show <id>` | Read one decision record. |
| `driftseal init` | Add the adoption protocol to `AGENTS.md`. |
| `driftseal help` | Print CLI usage. |

When `begin` declares one or more `--decision <id>` links, every linked
decision must be reconciled with `driftseal decision update` before that intent can
close as `completed` or `partial`. The update changes the current status when
requested and appends a timestamped history entry tied to the intent. Intents
without decision links keep the ordinary workflow.

## Consistency and recovery

DriftSeal serializes mutating commands with locks on the configured intent and
decision-log roots, acquired in a stable order. Decision reconciliation is
journaled as prepare and commit events around an atomic MADR replacement. If
the process stops between those steps, the next linked `decision update` or
successful `end` recovers the transaction from content hashes. A successful
linked-intent close also verifies that the decision file has not changed since
its latest reconciliation. Unlinked intents do not parse the decision log, and
`failed` or `abandoned` remains an escape path when decision recovery cannot
complete. Those terminal statuses cancel recovery for their pending
transactions, and recovery is scoped to the current intent so historical
conflicts cannot block later decision work.

New events carry a schema version. DriftSeal rejects newer unsupported schemas and
fails closed if a legacy client closes a linked intent without reconciliation.
`driftseal init` writes versioned managed blocks and upgrades only exact, recognized
older blocks. It refuses newer protocol versions and any unrecognized or
customized block without changing `AGENTS.md`.

`--count` prints only the number of records remaining after status filtering.
It cannot be combined with `--last`, whose limiting semantics would make the
count ambiguous. Decision filenames form a lightweight in-memory index: `show`
parses only the requested record, and an unfiltered `--count` reads no MADR
contents. Status-filtered listing and counting parse all records because status
is stored in each MADR document; DriftSeal does not maintain a stale-prone sidecar
index.

## Storage

- `.intent-log/events.jsonl` is the append-only intent log.
- `.decision-log/` contains numbered MADR decision records.
- Set `DRIFTSEAL_HOME` or `DRIFTSEAL_DECISION_HOME` to store either log outside the current project.

Together, intent events, selective decision records, and Git commits form a layered project log: intent events capture what a work round set out to do and how it would be verified; decision records preserve rationale, rejected paths, or deferred choices that the other layers cannot reconstruct; commits show the coherent change that actually landed. DriftSeal complements Git history rather than duplicating or replacing it.

Keeping the DriftSeal logs in version control makes the project’s working agreements and decision trail travel with the code. The npm package uses an explicit file allowlist, so project-local agent logs are not published to npm.

## Development

```sh
npm test
```

Contributions are welcome. Keep changes focused, add regression coverage for behavior changes, and run the test suite before opening a pull request.

## License

MIT. See [`LICENSE`](LICENSE).
