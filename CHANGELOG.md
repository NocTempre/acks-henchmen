# Changelog

## 0.19.4

- **Leaf field-builders consumed from acks-lib.** `num`/`str`/`int` were defined
  identically in both `location-data.mjs` and `henchman-record.mjs`; both now
  import them from acks-lib's `fields.mjs`. Behaviour-neutral. (`choicesOf` was
  left local — henchmen's enums are flat `{key: label}`, a different shape from
  acks-lib's labeled enums, so the two are not interchangeable.)

## 0.19.3

- **LocationData consumes acks-lib's shared compat stub.** The settlement
  sub-type's inline system-compatibility block (thac0 / initiative / movement /
  saves.implements|wand) is replaced by a spread of `acksCompatStubs()` from
  acks-lib — one definition of the fields the acks system touches on every
  actor, instead of a per-module copy. Loss-free and behaviour-neutral (verified
  live: a location constructs cleanly and its own fields survive); it also gains
  `isNew`, which the location previously dropped silently.

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
