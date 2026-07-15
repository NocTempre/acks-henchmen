/* global game, Hooks */
/**
 * Time helpers — all recruitment/wage state is anchored on
 * `game.time.worldTime` seconds so any worldTime-driven clock (the core
 * combat tracker, Simple Timekeeping, manual advance buttons) moves it.
 * Month length is the `daysPerMonth` world setting (v14's calendar month
 * component advances 0 seconds — acks-domains module/time.mjs documents the
 * bug — so months are day-counted here).
 */
import { SECONDS_PER_DAY, SECONDS_PER_WEEK } from "./constants.mjs";
import { getSetting } from "./settings.mjs";

export function now() {
  return Math.floor(game.time.worldTime);
}

export function secondsPerMonth() {
  return (Number(getSetting("daysPerMonth")) || 30) * SECONDS_PER_DAY;
}

export function daysBetween(t0, t1) {
  return Math.floor((t1 - t0) / SECONDS_PER_DAY);
}

export function weeksBetween(t0, t1) {
  return Math.floor((t1 - t0) / SECONDS_PER_WEEK);
}

export function monthsBetween(t0, t1) {
  return Math.floor((t1 - t0) / secondsPerMonth());
}

/** GM convenience: advance the shared world clock (gated by setting). */
export async function advanceDays(days) {
  if (!game.user.isGM) return;
  if (!getSetting("advanceWorldTime")) {
    ui.notifications.info(game.i18n.localize("ACKS-HENCHMEN.time.advanceDisabled"));
    return;
  }
  await game.time.advance(days * SECONDS_PER_DAY);
}

/**
 * Register a due-processing callback fired on the GM client whenever world
 * time moves forward. Processing must be idempotent — each consumer keeps its
 * own `lastProcessedTime` watermark.
 */
export function onTimeAdvanced(callback) {
  Hooks.on("updateWorldTime", (worldTime, dt) => {
    if (!game.users.activeGM || game.user !== game.users.activeGM) return;
    if (dt <= 0) return;
    callback(Math.floor(worldTime), dt);
  });
}
