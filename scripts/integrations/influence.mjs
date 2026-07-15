/* global game, Hooks */
/**
 * acks-influence integration (soft — everything is guarded).
 *
 * Consumed:
 *  - `flags.acks-influence.reaction` Active Effects already feed hiring
 *    throws (scripts/effects.mjs).
 *  - `acks-influence.rollComplete` → influence rolls made AGAINST a managed
 *    hireling are logged into its HenchmanRecord event log.
 *  - `api.open(actor, {modifiers})` → `openInfluenceFor()` opens the roller
 *    with the location's slander penalty pre-injected.
 */
import { MODULE_ID } from "../constants.mjs";
import HenchmanRecord from "../data/henchman-record.mjs";
import * as adapter from "../acks-adapter.mjs";

const INFLUENCE_ID = "acks-influence";

export function influenceApi() {
  const module = game.modules.get(INFLUENCE_ID);
  return module?.active ? module.api : null;
}

/**
 * Open the influence roller for an employer, injecting the location's
 * refuse-and-slander penalty as an external modifier (RR 162: the -1 applies
 * to ALL further reaction rolls the party makes in that town/region).
 */
export function openInfluenceFor(employer, location = null, targetActor = null) {
  const api = influenceApi();
  if (!api) return null;
  const modifiers = [];
  const slanderCount = location?.system?.slanderCountFor?.(employer?.uuid) ?? 0;
  if (slanderCount > 0) {
    modifiers.push({
      label: game.i18n.format("ACKS-HENCHMEN.influence.slanderLabel", { name: location.name }),
      value: -slanderCount,
    });
  }
  // apiVersion 2 accepts an options object; older versions ignore it safely.
  return api.open(employer, { targetActor, modifiers });
}

export function registerInfluenceIntegration() {
  if (!game.modules.get(INFLUENCE_ID)?.active) return;
  // Log influence rolls targeting managed hirelings into their record.
  Hooks.on(`${INFLUENCE_ID}.rollComplete`, async ({ actor, target, tone, total, band, newAttitude }) => {
    try {
      if (!target || !adapter.isRetainer(target)) return;
      if (game.user !== game.users.activeGM) return;
      await HenchmanRecord.logEvent(target, {
        type: "adjustment",
        note: game.i18n.format("ACKS-HENCHMEN.influence.rollNote", {
          name: actor?.name ?? "?",
          tone,
          band,
          attitude: newAttitude,
        }),
        rollTotal: total,
        outcome: band,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | influence rollComplete logging failed`, err);
    }
  });
  console.log(`${MODULE_ID} | acks-influence integration active`);
}
