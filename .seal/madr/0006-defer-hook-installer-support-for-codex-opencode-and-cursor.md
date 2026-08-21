# 6. Defer hook installer support for Codex, OpenCode, and Cursor

Date: 2026-08-13

## Status

Superseded

## Context and Problem Statement

driftseal hook install launches with kimi-code and claude-code targets only. Codex has no lifecycle hook mechanism (only turn-complete notify); OpenCode hooks require shipping a JS plugin rather than declarative config; Cursor's hooks.json beforeSubmitPrompt is beta and community reports show injected prompt context is silently stripped, so a prompt-side reminder cannot be relied on.

## Decision Drivers

* Hooks must inject context reliably; a reminder that never reaches the model is worse than none
* Keep the installer declarative: config-file edits only, no shipped plugin code

## Considered Options

* kimi-code and claude-code only (chosen)
* Include Cursor stop hook only
* Ship an OpenCode JS plugin

## Decision Outcome

Ship hook install for kimi-code and claude-code first; revisit Codex, OpenCode, and Cursor when their hook APIs stabilize. Revisit trigger: Cursor beforeSubmitPrompt context injection works reliably, Codex ships a prompt/stop hook event, or OpenCode gains declarative hook config.

## Consequences

* Codex, OpenCode, and Cursor users get no hook install; they still have AGENTS.md, the skill, and MCP

## Decision History

<!-- driftseal-reconciliation: 6fe3fd43-3af2-41ea-82dd-e5bfe7d2cdb4 -->
### 2026-08-13T06:22:29.465Z — Intent `2026-08-13-006`

Status: Deferred → Superseded

Superseded by 0007: the premise that Codex has no hook mechanism was wrong. Codex hooks.json (documented since CLI v0.116) supports UserPromptSubmit with plain-stdout context injection, so the codex target ships with the prompt hook only; OpenCode and Cursor stay deferred under 0007.
