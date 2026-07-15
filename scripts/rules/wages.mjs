/**
 * Wage rules (RR 166-171). Pure module.
 */
import { getTable } from "./tables.mjs";

/** Monthly wage in gp for a henchman of a level (HD for monsters, MM 351). */
export function henchmanWage(level) {
  const byLevel = getTable("wages", "henchmanWageByLevel").byLevel;
  const capped = Math.max(0, Math.min(14, Math.round(level)));
  return byLevel[String(capped)] ?? 0;
}

/** Monthly wage for a mercenary troop type and race ("man" default). */
export function mercenaryWage(troopType, race = "man") {
  const row = getTable("wages", "mercenaryWages").rows.find((r) => r.type === troopType);
  if (!row) return null;
  return row.wages[race] ?? null;
}

/** Base morale for a mercenary troop type (+1 for demi-humans). */
export function mercenaryMorale(troopType, demiHuman = false) {
  const row = getTable("wages", "mercenaryWages").rows.find((r) => r.type === troopType);
  if (!row) return 0;
  return row.morale + (demiHuman ? 1 : 0);
}

/** Base morale for a specialist type (RR 166 role overrides, default -2). */
export function specialistMorale(specialistType) {
  const table = getTable("wages", "baseMorale");
  return table.overrides[specialistType] ?? table.specialistDefault;
}

/** Max hireable henchman level for an employer level (RR 168). */
export function maxHenchmanLevel(employerLevel, isDomainRuler = false) {
  if (isDomainRuler) return Math.max(0, employerLevel - 1);
  if (employerLevel >= 7) return 4 + (employerLevel - 7);
  const row = getTable("wages", "employerLevelCap").rows.find((r) => r.employerLevel === employerLevel);
  return row ? row.maxHenchmanLevel : 0;
}

/**
 * Signing bonus gp for a reaction bonus tier (RR 162 + GM screen refinement).
 * @param {number} tier - +1..+3
 * @param {number} monthlyWage - the candidate's monthly wage in gp
 * @param {boolean} briberyProficient
 * @returns {{gp: number, wages: string}|null}
 */
export function signingBonusCost(tier, monthlyWage, briberyProficient) {
  const table = getTable("wages", "signingBonus");
  const rows = briberyProficient ? table.proficient : table.nonProficient;
  const row = rows.find((r) => r.bonus === tier);
  if (!row) return null;
  const perDay = monthlyWage / 30;
  const gp = { day: perDay, week: perDay * 7, month: monthlyWage, year: monthlyWage * 12 }[row.wages];
  return { gp: Math.ceil(gp), wages: row.wages };
}

/** Expected monthly living expenses of an adventurer = same-level henchman wage. */
export function expectedLivingExpenses(level) {
  return henchmanWage(level);
}

/** Apparent level implied by a monthly spend (largest level whose wage ≤ spend). */
export function apparentLevelFromSpend(gpPerMonth) {
  const byLevel = getTable("wages", "henchmanWageByLevel").byLevel;
  let apparent = 0;
  for (const [lvl, wage] of Object.entries(byLevel)) {
    if (gpPerMonth >= wage) apparent = Math.max(apparent, Number(lvl));
  }
  return apparent;
}
