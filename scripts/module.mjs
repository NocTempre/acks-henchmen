/* global game, foundry, Hooks, CONFIG, Actor, ui */
/**
 * ACKS II — Henchmen & Hirelings. Entry point.
 *
 *  init:  location data model + sheet (module sub-types register safely at
 *         init — acks-domains precedent), settings, template preload.
 *  setup: ruledata load (fetch), public API.
 *  ready: system check, GM time watcher, chat commands, card listeners.
 */
import { MODULE_ID, LOCATION_TYPE, RULEDATA, HOOKS } from "./constants.mjs";
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
import { hire, checkHenchmanLimit, rollCandidateStats, rollCandidateClass, rollCandidateLevel } from "./engine/hire.mjs";
import { onTimeAdvanced, advanceDays, now } from "./time.mjs";
import { bindCardListeners, registerCardAction } from "./chat/cards.mjs";

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
    LocationSheet,
    // engine
    createPosting,
    processLocation,
    processAllLocations,
    effectiveMarketClass,
    hire,
    checkHenchmanLimit,
    rollCandidateStats,
    rollCandidateClass,
    rollCandidateLevel,
    // data
    HenchmanRecord,
    getRecord: (actor) => HenchmanRecord.fromActor(actor),
    // rules (pure)
    rules: { ...availabilityRules, ...wageRules, ...loyaltyRules, ...diceRules },
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

/* Bind event-card buttons (v13 jQuery + v14 HTMLElement signatures). */
Hooks.on("renderChatMessageHTML", (_message, html) => bindCardListeners(html));
Hooks.on("renderChatMessage", (_message, html) => bindCardListeners(html));

export { registerCardAction, getSetting };
