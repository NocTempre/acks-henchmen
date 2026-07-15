/* global game, foundry, Hooks, CONFIG, Actor, ui */
/**
 * ACKS II — Henchmen & Hirelings. Entry point.
 *
 *  init:  location data model + sheet (module sub-types register safely at
 *         init — acks-domains precedent), settings, template preload.
 *  setup: ruledata load (fetch), public API.
 *  ready: system check, GM time watcher, chat commands, card listeners.
 */
import { MODULE_ID, LOCATION_TYPE, RULEDATA, HOOKS, SCHEMA_VERSION } from "./constants.mjs";
import * as config from "./config.mjs";
import { registerSettings, getSetting } from "./settings.mjs";
import { initTables, getTable, getDoc } from "./rules/tables.mjs";
import * as availabilityRules from "./rules/availability.mjs";
import * as wageRules from "./rules/wages.mjs";
import * as loyaltyRules from "./rules/loyalty.mjs";
import * as diceRules from "./rules/dice.mjs";
import * as adapter from "./acks-adapter.mjs";
import { collectEffectModifiers, sumEffectModifiers, hasEffectFlag } from "./effects.mjs";
import { LocationData } from "./data/location-data.mjs";
import HenchmanRecord from "./data/henchman-record.mjs";
import { LocationSheet } from "./apps/location-sheet.mjs";
import { ThrowDialog, openThrowDialog } from "./apps/throw-dialog.mjs";
import { openPostingDialog } from "./apps/posting-dialog.mjs";
import { openRecruitDialog } from "./apps/recruit-dialog.mjs";
import { createPosting, processLocation, processAllLocations, effectiveMarketClass } from "./engine/recruitment.mjs";
import { hire, checkHenchmanLimit } from "./engine/hire.mjs";
import * as candidateRules from "./rules/candidates.mjs";
import * as identityRules from "./rules/identity.mjs";
import { onTimeAdvanced, advanceDays, now } from "./time.mjs";
import { bindCardListeners, registerCardAction } from "./chat/cards.mjs";
import { registerSockets, executeAsGM, registerSocketAction } from "./sockets.mjs";
import { registerEventEngine, openLoyaltyRoll, openObedienceRoll, recordCalamity, payWagesFor, effectiveLoyaltyFor, effectiveMoraleFor } from "./engine/events.mjs";
import { openRosterApp } from "./apps/roster-app.mjs";
import { recruitMonster, hireMonster, validateMonsterRecruit } from "./engine/monster.mjs";
import { openFollowersDialog } from "./apps/followers-dialog.mjs";
import * as slaveryRules from "./rules/slavery.mjs";
import * as facts from "./facts.mjs";
import { registerInfluenceIntegration, openInfluenceFor } from "./integrations/influence.mjs";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing`);

  Object.assign(CONFIG.Actor.dataModels, { [LOCATION_TYPE]: LocationData });
  foundry.applications.apps.DocumentSheetConfig.registerSheet(Actor, MODULE_ID, LocationSheet, {
    types: [LOCATION_TYPE],
    makeDefault: true,
    label: "ACKS-HENCHMEN.sheet.location",
  });

  registerSettings();

  try {
    const T = `modules/${MODULE_ID}/templates`;
    foundry.applications.handlebars.loadTemplates([
      `${T}/location-sheet.hbs`,
      `${T}/posting-dialog.hbs`,
      `${T}/throw-dialog.hbs`,
      `${T}/roster-app.hbs`,
      `${T}/chat/throw-card.hbs`,
      `${T}/chat/reveal-card.hbs`,
      `${T}/chat/event-card.hbs`,
    ]);
  } catch (err) {
    console.warn(`${MODULE_ID} | template preload skipped`, err);
  }
});

Hooks.once("setup", async () => {
  // Load ruledata. All rules functions read through rules/tables.mjs so the
  // data stays swappable (Node tests load the same JSON from disk).
  for (const id of RULEDATA) {
    try {
      const doc = await foundry.utils.fetchJsonWithTimeout(`modules/${MODULE_ID}/ruledata/${id}.json`);
      initTables(doc);
    } catch (err) {
      console.error(`${MODULE_ID} | failed to load ruledata/${id}.json`, err);
    }
  }

  // Public API: macros and other modules reach the module through here.
  const api = {
    MODULE_ID,
    HOOKS,
    config,
    // apps
    openThrowDialog,
    ThrowDialog,
    openPostingDialog,
    openRecruitDialog,
    openRosterApp,
    LocationSheet,
    // loyalty automation
    openLoyaltyRoll,
    openObedienceRoll,
    recordCalamity,
    payWagesFor,
    effectiveLoyaltyFor,
    effectiveMoraleFor,
    // monsters, followers, integrations
    recruitMonster,
    hireMonster,
    validateMonsterRecruit,
    openFollowersDialog,
    openInfluenceFor,
    facts,
    // engine
    createPosting,
    processLocation,
    processAllLocations,
    effectiveMarketClass,
    hire,
    checkHenchmanLimit,
    // data
    HenchmanRecord,
    getRecord: (actor) => HenchmanRecord.fromActor(actor),
    // rules (pure; slavery rules only function with enableSlavery on)
    rules: { ...availabilityRules, ...wageRules, ...loyaltyRules, ...diceRules, ...candidateRules, ...identityRules, slavery: slaveryRules },
    tables: { getTable, getDoc },
    // adapter + effects (the data-driven modifier contract)
    adapter,
    effects: { collectEffectModifiers, sumEffectModifiers, hasEffectFlag },
    time: { now, advanceDays },
  };
  const module = game.modules.get(MODULE_ID);
  if (module) module.api = api;
  globalThis.acksHenchmen = api;
});

Hooks.once("ready", () => {
  if (game.system?.id !== "acks") {
    console.warn(`${MODULE_ID} | Active system is not "acks"; this module expects the ACKS II system.`);
    return;
  }

  registerSockets();
  registerEventEngine();
  registerInfluenceIntegration();

  // Location schema migration (GM): v2 moved availability from per-posting
  // pools to the location's shared market — old-shape postings/candidates
  // (pre-0.3.0 test data) cannot be converted and are cleared.
  if (game.user === game.users.activeGM) {
    for (const location of game.actors.filter((a) => a.type === LOCATION_TYPE)) {
      if ((location.system.schemaVersion ?? 1) >= SCHEMA_VERSION) continue;
      const hadData = (location.system.postings?.length ?? 0) + (location.system.candidates?.length ?? 0) > 0;
      location
        .update({
          "system.postings": [],
          "system.candidates": [],
          "system.marketRolls": [],
          "system.schemaVersion": SCHEMA_VERSION,
        })
        .then(() => {
          if (hadData) {
            ui.notifications.warn(game.i18n.format("ACKS-HENCHMEN.migration.wiped", { name: location.name }));
          }
        })
        .catch((err) => console.error(`${MODULE_ID} | migration failed for ${location.name}`, err));
    }
  }

  // GM-side due-processing whenever world time moves (posting aging, arrival
  // tranches, weekly fees, month rollover). Idempotent per posting.
  onTimeAdvanced((worldTime) => processAllLocations(worldTime));

  // Chat command: /recruit opens the recruitment board for the user's actor.
  try {
    game.acks?.commands?.registerCommand?.({
      path: "/recruit",
      desc: game.i18n.localize("ACKS-HENCHMEN.command.recruit"),
      func: () => {
        const locations = game.actors.filter((a) => a.type === LOCATION_TYPE);
        if (!locations.length) {
          ui.notifications.warn(game.i18n.localize("ACKS-HENCHMEN.command.noLocations"));
          return;
        }
        (locations.find((l) => l.testUserPermission?.(game.user, "OBSERVER")) ?? locations[0])?.sheet?.render(true);
      },
    });
  } catch (err) {
    console.warn(`${MODULE_ID} | chat command registration failed`, err);
  }
});

/* Bind event-card buttons (v14 AppV2 convention: HTMLElement hook only —
 * registering the legacy jQuery hook triggers a deprecation warning). */
Hooks.on("renderChatMessageHTML", (_message, html) => bindCardListeners(html));

/* Roster button on acks character sheets (additive DOM only — the
 * acks-domains/acks-influence injection pattern, dedupe-guarded). */
Hooks.on("renderActorSheetV2", (app, element) => {
  if (game.system?.id !== "acks") return;
  const actor = app.actor ?? app.document;
  if (actor?.type !== "character" || actor.system?.retainer?.enabled) return;
  if (!actor.isOwner) return;
  const root = element instanceof HTMLElement ? element : element?.[0];
  const header = root?.querySelector(".window-header");
  if (!header || header.querySelector(".acks-henchmen-roster-button")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "header-control icon fa-solid fa-people-group acks-henchmen-roster-button";
  button.dataset.tooltip = game.i18n.localize("ACKS-HENCHMEN.roster.open");
  button.addEventListener("click", () => openRosterApp(actor));
  const closeButton = header.querySelector('[data-action="close"]');
  if (closeButton) header.insertBefore(button, closeButton);
  else header.append(button);
});

export { registerCardAction, getSetting };
