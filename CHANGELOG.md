# Changelog

## Unreleased

- Slander registry: entries now carry a structured `subject {scope, uuid}`
  ("all" | "party" | "character") instead of a bare party key, so one
  location-held entry can target a party or an individual without double
  counting (docs/RELATIONSHIPS_PROPOSAL.md, in effect). Legacy `partyKey`
  data migrates on load; `slanderCountFor` takes
  `{ employerUuid, characterUuid }` (bare-string shim kept for one release).
- New `HOOKS.SLANDER_CHANGED` fires on every registry write; new api read
  helper `slanderedAt(query)` answers "where am I slandered" from the
  character/party side.

Releases up to and including 0.17.1 predate this file; see the git history
and GitHub releases for earlier changes.
