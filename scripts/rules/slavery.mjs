/**
 * Slavery rules (JJ 409-411) — OPTIONAL, gated behind the `enableSlavery`
 * world setting. Pure module; all content isolated here + ruledata/slavery.json.
 */
import { optTable } from "./tables.mjs";

/** Purchase cost + upkeep + loyalty/morale presets for a common slave type. */
export function commonSlave(type) {
  return (optTable("slavery", "commonSlaves")?.rows ?? []).find((r) => r.type === type) ?? null;
}

/** Purchase cost for a slave soldier of a troop type and race. */
export function slaveTroopCost(troopType, race = "man") {
  const row = (optTable("slavery", "slaveTroopCosts")?.rows ?? []).find((r) => r.type === troopType);
  return row?.costs?.[race] ?? null;
}

/** Monthly upkeep for slave soldiers (ogres cost more; missing it = calamity). */
export function slaveUpkeep(race = "man") {
  const rules = optTable("slavery", "soldierRules")?.upkeep ?? {};
  return race === "ogre" ? rules.ogre : rules.default;
}

/** Loyalty preset for how the slave entered servitude. */
export function slaveLoyalty({ enslavedAsAdult = true, servingTrainer = false } = {}) {
  if (enslavedAsAdult) return -4;
  return servingTrainer ? 1 : 0;
}
