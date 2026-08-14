# 13. Recognize DriftSeal-installed skills by a release digest allowlist

Date: 2026-08-14

## Status

Accepted

## Context and Problem Statement

skill install compared the target directory against the bundled skill only, so any skill from an earlier DriftSeal release counted as foreign content and could not be upgraded without --force. --force must keep protecting a skill the operator wrote or edited, so the installer needs to tell its own earlier output apart from someone else's file.

## Decision Drivers

* Upgrading an untouched skill must not need --force
* A locally written or edited skill must never be replaced silently
* Old installs must upgrade without first re-installing under the new scheme

## Considered Options

* Write an install receipt into the installed skill directory and compare against it
* Drop the conflict check and always overwrite the skill directory

## Decision Outcome

Ship SKILL_RELEASE_DIGESTS in bin/driftseal.js: the content-only skillTreeDigest of every skill tree DriftSeal has bundled. A target matching one of them is upgraded in place and reported as Upgraded; anything else still needs --force. A test installs with the current release and upgrades with a staged next release, which fails whenever a release forgets to append its digest.

## Consequences

* Every change to the bundled skill must append its digest to the allowlist, enforced by the staged-next-release test
* A skill whose bytes drift for any reason, including an editor or Finder artifact in the directory, is treated as foreign and needs --force
