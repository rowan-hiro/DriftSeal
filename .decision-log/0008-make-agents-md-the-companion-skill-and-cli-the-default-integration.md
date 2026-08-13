# 8. Make AGENTS.md, the companion skill, and CLI the default integration

Date: 2026-08-13

## Status

Accepted

## Context and Problem Statement

Across Codex, Cursor, Kimi Code, and OpenCode, enabling AGENTS.md instructions, a skill, MCP, and lifecycle hooks together repeats the same workflow guidance and consumes prompt, tool, and startup budget. Current agents reliably follow repository-scoped AGENTS.md instructions.

## Decision Drivers

* Portable behavior across agent harnesses
* Minimal duplicated context and tool surface
* Repository-local, reviewable policy

## Considered Options

* Enable AGENTS.md, skill, MCP, and hooks by default
* Make MCP the preferred execution surface
* Use AGENTS.md plus a thin skill and CLI by default

## Decision Outcome

Treat the repository's AGENTS.md as the authoritative policy, keep use-driftseal as a thin discovery and recovery guide, and use the driftseal CLI as the default execution surface. Keep MCP and lifecycle hooks available only as explicitly selected adapters for host constraints or reminder needs.

## Consequences

* Most users need only driftseal init, the companion skill, and the CLI
* MCP remains useful for shell-restricted or structured integrations
* Lifecycle hooks remain advisory and opt-in
