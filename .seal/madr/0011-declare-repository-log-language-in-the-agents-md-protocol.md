# 11. Declare repository log language in the AGENTS.md protocol

Date: 2026-08-14

## Status

Accepted

## Context and Problem Statement

Users need intent and decision prose in a chosen language, but DriftSeal upgrades AGENTS.md by exact match on managed protocol blocks, and decision parsing depends on English MADR headings and English status tokens.

## Decision Drivers

* AGENTS.md is the authoritative policy agents already read
* Managed-block upgrades must remain exact and recoverable
* MADR parsing and CLI tokens are an English schema, not user prose

## Considered Options

* Translate the entire protocol into each supported language
* Translate MADR section headings with the log language
* Accept --lang on every begin and decision command
* Store language in an env var or sidecar config file
* Declare a BCP 47 log language in the managed AGENTS.md protocol (chosen)

## Decision Outcome

Declare a BCP 47 log language inside the managed protocol. Agents write intent and decision prose in that language. Command names, flags, status tokens, ids, and MADR section headings stay in English. init --lang sets or changes the tag; init without --lang preserves it while upgrading the protocol.

## Consequences

* Protocol text stays English and comparable across language choices
* Existing v10 blocks upgrade to v11 with default en unless --lang is passed
* A later language change does not require hand-editing AGENTS.md

## Decision History

<!-- driftseal-reconciliation: 4e7b5407-aa67-485b-8014-cc97ed0cd1ec -->
### 2026-08-14T04:14:02.852Z — Intent `2026-08-14-008`

Status: Accepted → Accepted

Log-language tags are checked against RFC 5646 well-formedness, including private-use, extension, region, and variant subtags. Comment and prose declarations in the same protocol block must agree; a mismatch requires --lang to resolve.
