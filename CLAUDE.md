# Henchmen & Hirelings (acks-henchmen)

Foundry VTT module for the ACKS II system (`acks`), part of the NocTempre ACKS
module family. Canonical conventions and shared toolchain:
`C:\Proj\acks-module-template` — read its `docs/TOOLCHAIN.md` before changing
build/release plumbing.

## Layout

- `scripts/` — ESM runtime, entry `scripts/module.mjs`; `templates/` — .hbs;
  `styles/`; `lang/en.json` — flat i18n keys prefixed `ACKS-HENCHMEN.`
- `packs/_source/` — JSON pack sources (committed) → compiled LevelDB in
  `packs/` (committed and shipped; binary — protected by `.gitattributes`,
  never weaken it)
- `tools/` — dev harness. `build-packs.mjs` and `validate.mjs` are **synced
  from acks-module-template — never hand-edit**; change the template, then run
  `/acks-sync-toolchain`. `pack-data.mjs` (and data files it re-exports) are
  module-owned.
- `docs/RULES.md` — canonical ACKS II rules extract; cite it instead of
  re-deriving rules. `docs/MODEL.md` — design decisions.
- `ruledata/` (if present) — runtime-fetched JSON rule content; ships in the zip.

## Commands

- `npm install` once, then `npm run build:packs` and `npm run validate`
  (`npm test` where `tools/test-logic.mjs` exists).
- After a local build with unchanged sources, discard LevelDB timestamp churn:
  `git restore packs/ && git clean -fd packs/`. Commit rebuilt packs only when
  `packs/_source` actually changed.
- Foundry dev install (junction, not copy):
  `New-Item -ItemType Junction -Path "$env:LOCALAPPDATA\FoundryVTT\Data\modules\acks-henchmen" -Target "C:\Proj\acks-henchmen"`

## Release

1. Bump `module.json` version; update changelog if present.
2. Build + validate + test; commit.
3. `git tag v<version>` (must equal module.json version) and push branch + tag.
4. Watch the Release workflow (`gh run watch`), then verify
   `https://github.com/NocTempre/acks-henchmen/releases/latest/download/module.json`
   shows the new version. The `/acks-release` skill walks all of this.

## Conventions

- Branch `main`; tags `v<semver>`.
- `compatibility` minimum 14 / verified 14.364; system `acks` minimum 14.
- Every `relationships.requires` entry carries a `reason` and
  `compatibility.minimum` (lib-wrapper for wrapping, socketlib for GM-routed
  writes).
- Declare a pack in `module.json` only once it has content.
- Design doctrine: **reuse → extend → enhance → invent** — reuse core system
  documents; extend only via `flags["acks-henchmen"]`; enhance with alternate
  sheets/wrappers; invent nothing the system provides (see docs/MODEL.md).
