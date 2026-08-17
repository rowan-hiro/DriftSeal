# 14. Reconstructability test for the Git carve-out

Date: 2026-08-17

## Status

Accepted

## Context and Problem Statement

Decision 0010 exempts Git operations from intent logging and requires an intent for non-Git content changes, but it left artifacts produced by Git commands unsettled: in the field study (driftseal-plan.md item 5) an agent opened an intent for git format-patch output, none for git rm --cached, and one for a one-byte .gitignore edit, reasoning differently each time.

## Decision Drivers

* The carve-out must be decidable: one question settles every case an agent hits
* Field notes showed three similar cases decided three different ways

## Considered Options

* Exempt everything a Git command touches (too broad: .gitignore edits would escape the log)
* Require an intent for any file a Git command writes (too strict: patch files and scratch harnesses are regenerable)
* Reconstructability test: no intent when the result can be rebuilt from Git state (chosen)

## Decision Outcome

A command whose result can be reconstructed from Git state (for example a patch file regenerated from a commit range, or a scratch harness that re-runs) needs no intent; content that will be committed and cannot be reconstructed (for example a .gitignore edit) does. The rule ships as prose in protocol v12 step 1, with a pointer in the step 3 Git paragraph.

## Consequences

* git format-patch output and re-runnable harnesses need no intent; committed content like .gitignore edits still does
* Protocol v12 step 1 carries the rule; refines 0010 rather than replacing it
