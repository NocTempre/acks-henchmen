# ACKS II — Henchmen & Hirelings

Companion module for the official ACKS II system (`acks`) for Foundry VTT
(v13/v14). Completes the hireling ruleset the core engine only sketches:

- **Roll for available henchmen in a city** — market-class-driven availability
  for henchmen by level, henchmen by class rarity (Judges Journal), 16
  mercenary troop types, and ~45 specialist types, on a per-settlement
  **Location** actor.
- **Recruitment postings with time tracking** — the pool is rolled **once per
  game month per specification**; ½ arrives in week 1, ¼ in week 2, the rest
  in week 3; weekly search fees are charged automatically as world time
  advances; commissioned searches re-roll monthly at one rarity lower.
- **Player recruitment board** — players see exactly what their posting has
  turned up *so far* (arrived candidates only) and attempt to recruit:
  Reaction to Hiring Offer with Charisma, proficiency effects, signing
  bonuses (Bribery-aware pricing), sweeten-the-deal re-rolls, cumulative
  refusal penalties, and the refuse-and-slander town registry.
- **Stat & template rolling — record the result** — each candidate's class
  (JJ double-d100 grid) and level (1d20 table) are **fixed when the monthly
  pool is rolled** — no rerolling until you like the result; attributes
  (3d6×6) roll exactly once, at hire. Everything is recorded on the hired
  actor (`HenchmanRecord`); class auto-generation is a future module that
  consumes these records via the `acks-henchmen.hired` hook.
- **Loyalty & morale automation** — secret (GM-whispered) Hireling Loyalty
  and Obedience throws with natural-2/12 clamps; calamity detection when a
  hireling drops to 0 hp; level-up loyalty rolls; the full permanent-modifier
  ledger; monthly wage cycle with missed-wage calamities; the 4 + CHA
  henchman limit (warn/block).
- **Monstrous henchmen, followers, and (optional) slavery** — MM 351
  recruitment incl. the Irrefusable Offer table and HD-as-level wages;
  RR 334 follower generation; JJ 409 slavery rules behind a default-off
  setting.

Design principle: **reuse → extend → enhance → invent.** Hired candidates
become ordinary acks `character` actors wired into the system's own
`henchmenList`/`retainer` plumbing; the module adds what the core lacks and
never patches it.

**Modifiers are data-driven.** Every proficiency/power bonus (Leadership,
Command, Blood of Ancient Kings, Diplomacy, Mercantile Network, Utter
Domination…) is read from **Active Effects on ability Items** using the
`flags.acks-henchmen.*` change-key contract — see
[docs/MODEL.md](docs/MODEL.md). A compendium of ready-made proficiency/power
items ships with the module, and classic item names are recovered by a
fallback matcher.

## Installation

Manifest URL:

```
https://github.com/NocTempre/acks-henchmen/releases/latest/download/module.json
```

Requires the ACKS II system. Plays well with (all optional): Simple
Timekeeping (clock UI), acks-influence (reaction effects feed hiring rolls),
acks-monsters (monster HD/values), acks-domains (market class from domain
actors), socketlib.

## Usage

1. Create a **Location** actor (new actor type) per settlement; set urban
   families or a market-class override.
2. **New Posting** on the location sheet: pick who is hiring and what they
   seek; the month's pool is rolled and the week-1 search fee charged.
3. Advance world time (Simple Timekeeping, the sheet's *Advance 1 week*
   button, or any other clock) — arrivals materialize, fees accrue, months
   roll over.
4. Players open the board (`/recruit` or the location sheet with OBSERVER
   permission) and **Attempt to Recruit**; on Accept the hire pipeline creates
   the actor, wires the roster, records the rolled results, and computes
   effective loyalty.
5. Loyalty automation runs from there: calamity prompts, level-up rolls,
   wages — all whispered to the GM first (secret rolls per the book).

## Development

```
npm install
npm run build:packs   # compile compendium packs (Foundry CLI, LevelDB)
npm run validate      # JS syntax, template compile, JSON, i18n keys
```

Cutting a release: bump `module.json` version, `git tag vX.Y.Z && git push
origin vX.Y.Z` — the workflow builds packs, validates, zips, and attaches
`module.json` + `module.zip` to the GitHub release.

## Layout

```
scripts/          raw ESM (no bundler): entry, adapter, effects, rules/, engine/, apps/, chat/
ruledata/         book-cited JSON tables (availability, rarity, wages, throws, followers…)
templates/        Handlebars (dialogs, sheet, chat cards)
packs/_source/    compendium JSON sources (compiled LevelDB in packs/)
docs/RULES.md     canonical rules extract with citations
docs/MODEL.md     data model + Active Effect contract + extension points
```

## License

Module code © NocTempre. ACKS II is a trademark of Autarch LLC; this module
contains paraphrased rules references with citations and no verbatim book
text or art.
