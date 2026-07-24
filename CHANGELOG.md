# Changelog

## 0.20.0

- **Hire a whole unit from the market as one group.** A new "Hire as Group"
  action on the location's Mercenaries tab assembles the available market into a
  single `acks-lib.group` owned by the employer: each troop row becomes a counted
  merc **stack** (per-body HP and casualties, no `retainer.quantity` label and no
  actor-per-body — a platoon of 30 is one prototype + one stack of 30), and an
  optional officer (the `mercOfficer*` / `marshal*` leader specialists) is hired
  as a lone leveled actor and linked as the group's commander (RR 171). The
  dialog lets the hirer pick troops with quantities and an officer; utility
  specialists and individual henchmen still hire as lone actors. Engine:
  `engine/hire-group.mjs` (`hireAsGroup`); UI: `apps/hire-group-dialog.mjs`.
- Requires acks-lib >= 0.22.0 (the group actor + its officer troops-addendum).

## 0.19.5

- **Generic actor reads consumed from acks-lib.** `getChaMod`, `getLevel` and
  `getMonsterHd` are now thin re-exports of acks-lib's `abilityMod` /
  `classLevel` / `monsterHd` (acks-influence read the same schema). The
  henchman-specific reads (retainer, henchmen list, gold) stay local. Side
  benefit: the shared `monsterHd` union parses `"1/2"`-HD monsters as 0.5, which
  this module's own parser had read as 0 — so ½-HD hirelings now get the right
  wage level.

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
