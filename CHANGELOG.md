# Changelog

## 0.25.0

- **The character sheet's Hirelings tab is now a grid of Follower Cards.** Each
  Henchmen / Mercenaries / Specialists bucket renders as acks-lib's printed
  Follower Card instead of a list row — the same card a hireling opens as its own
  sheet. The cards are read-only and reuse the system's own hireling actions, so
  opening, loyalty and morale rolls, and dismissal keep working against the right
  hireling; the tab re-renders cleanly on any change. Pure runtime re-skin of the
  system sheet (no core files touched); it degrades to the stock list if acks-lib
  is older than 0.28.0. Requires acks-lib ≥ 0.28.0 for the `acksLib.followerCard`
  renderer.

## 0.24.0

- **GM posts place the named NPC in the pool, random only on the blanks.** A GM
  does not search — a GM-initiated directed post (by class, class+level,
  proficiency, or class+proficiency) now ADDS one candidate honouring exactly
  what the GM specified and rolling only what they left blank (name, culture,
  age, appearance, and any unspecified class or level), available now, as a
  normal shared henchman for its level. No rarity roll, no replacement, no
  search fee, and no once-per-month limit (a GM may place as many as they like).
  Players are unchanged: their directed searches still pay to find people by
  replacement. (GM placements last the current market month; the rollover
  refreshes the pool as usual.)

## 0.23.1

- **Reload is now a pure recovery/refresh, not a second regenerate.** 0.23.0's
  Reload button re-rolled an empty market, duplicating Process time. It now only
  re-loads the persisted rules tables into the registry (recovering a board that
  reads empty because a lost registry blanked its labels or threw the render) and
  re-renders — the existing, stored market reappears. Rolling stays Process
  time's single job. Reload no longer writes the location, so any viewer can run
  it to fix a display glitch. The missing-tables guard (0.23.0) is unchanged.

## 0.23.0

- **Market no longer disappears when the rules tables briefly go missing.** The
  book that seeds the ruledata does not persist on a remote, and a world
  relaunch / GM leaving / module update can leave the registry momentarily
  empty. A month roll REPLACES the whole shared market, so rolling against
  missing tables produced ZERO and persisted an empty market over a full one —
  "values disappear between loads". The monthly roll now defers when the
  availability tables are absent, keeping the existing market intact until they
  return (then it self-heals on the next process).
- **Reload button on the location sheet** (beside Process time). Re-loads the
  world-persisted rules tables into the registry — no book needed — and, if the
  market is blank because a roll was deferred, rolls this month now and applies
  arrivals. GM or location owner. Requires acks-location ≥ 0.4.0 for the
  registry re-mirror (degrades to a plain re-roll without it).

## 0.22.1

- **Hire-group UI: capped stepper grid for troops, dropdown for officers.** The
  hire-as-group dialog renders troop types localised in a grid of − / count / +
  steppers capped at what the market actually holds (enforced in the stepper,
  manual input, and the OK callback); officers are a single localised dropdown
  disambiguated by name. Display-only — the pick shape handed to `hireAsGroup`
  is unchanged.
- **Market: a directed class search reveals ALL of that class.** A directed
  recruitment search by class now reveals every AVAILABLE matching candidate to
  the searcher and routes them to the special bucket, instead of only the few
  the replacement mechanic converted. Additive re-bucketing only (a row is
  special XOR normal, never dropped); GM visibility and pending candidates are
  unchanged.

## 0.22.0

- **A hired group is a PAID unit that costs no henchman-cap slot.** The wage
  cycle now bills the employer's `acks-lib.group` units alongside its henchmen:
  the unit's monthly wage is every living body's troop wage (RR 168, read from
  each stack's troop type), gold leaves the employer at each payday, and the
  group is billed off `unit.employerUuid` — never added to the core
  `henchmenList`, so it never counts against the PC henchman cap and never
  touches acks-core. A missed month accrues arrears on the group and drops its
  morale (RR 166). Pay state lives in a `flags.acks-henchmen.groupPay` flag on
  the group; the "wages due" reminder now surfaces employers who owe a unit.
- **Roll Unit Morale** — a right-click context action on a group actor opens a
  2d6 morale check: the leader-modified base (`commandMorale`) plus the
  situational RR 166 modifiers the Judge ticks (employer present, casualties,
  ordered into danger, …). The roll posts to chat; interpretation stays with the
  table. Lives here, not on the acks-lib group sheet.

## 0.21.0

- **Hire-as-group now feeds the RAW officer mechanics.** Each troop stack is
  tagged `mounted` (cavalry, which count double toward command) and given its
  RR 166 base morale (`mercenaryMorale` by troop type); the officer's RR 171
  morale modifier and level are cached on the group (`unit.officerMoraleBonus` /
  `officerLevel`), so the group's `commandMorale` and `commandCapacity` are real
  numbers, not the inert 0s v0.20.0 shipped. On hire the unit is checked against
  the RR 169 "personally led" limit (a 3rd+ level officer leads a platoon of 30
  infantry / 15 cavalry) and warns if it exceeds what the officer can lead. The
  2d6 unit-morale roll itself stays with acks-influence (the morale-roll owner);
  the group supplies the value.
- Requires acks-lib >= 0.23.0 (the command-capacity + unit-morale derivations).

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
