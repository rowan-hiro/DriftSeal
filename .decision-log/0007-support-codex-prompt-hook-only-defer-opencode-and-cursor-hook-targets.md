# 7. Support Codex prompt hook only; defer OpenCode and Cursor hook targets

Date: 2026-08-13

## Status

Deferred

## Context and Problem Statement

Supersedes decision 0006, which deferred Codex based on the outdated assumption that Codex has no hooks. Codex CLI (v0.116+) reads hooks.json at <repo>/.codex/ or ~/.codex/ with the Claude Code group shape; UserPromptSubmit adds plain stdout as developer context. Codex Stop expects JSON on stdout and offers no advisory context injection: plain text is invalid, additionalContext is unsupported there, and decision:block turns the reminder into a forced continuation prompt, violating the advisory design. OpenCode still requires a shipped JS plugin; Cursor beforeSubmitPrompt remains beta with silently stripped context injection.

## Decision Drivers

* Reminders must stay advisory; a forced extra turn on every Stop is not acceptable
* Only documented, reliable context injection paths are installed

## Considered Options

* Codex prompt hook only (chosen)
* Codex Stop via decision:block guarded by stop_hook_active
* Codex Stop via systemMessage UI warning

## Decision Outcome

driftseal hook install supports codex with only the UserPromptSubmit hook (plain format). OpenCode and Cursor remain deferred. Revisit trigger: Codex Stop gains additionalContext support, Cursor beforeSubmitPrompt injection works reliably, or OpenCode gains declarative hook config.

## Consequences

* Codex agents get the pre-answer reminder but no post-answer reminder; open intents are still surfaced by driftseal status and the MCP tools
