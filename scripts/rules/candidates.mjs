/**
 * Candidate identity rolls. Pure module — dice arrive via an injected async
 * roller.
 *
 * DESIGN RULE (anti-fishing): a candidate's class and level are FIXED when
 * the monthly pool is rolled — the market offers what it offers, subdivided
 * into weekly arrival tranches. There is no per-candidate reroll surface.
 * Attributes (3d6 ×6) are rolled once, at HIRE time, and recorded.
 */
import { getTable } from "./tables.mjs";

/**
 * Random class via the JJ GM-screen double-d100 grid: first d100 picks the
 * row band, second the column band. "special" = Judge picks from the
 * expansion books.
 * @param {(f: string) => Promise<number>} rollDice
 * @returns {Promise<{classKey: string, rolls: [number, number]}>}
 */
export async function rollClassFromGrid(rollDice) {
  const grid = getTable("rarity", "leveledClassGrid");
  const rowRoll = await rollDice("1d100");
  const colRoll = await rollDice("1d100");
  const row = grid.rows.find((r) => rowRoll >= r.min && rowRoll <= r.max);
  const colIndex = grid.columns.findIndex((c) => colRoll >= c.min && colRoll <= c.max);
  return { classKey: row?.classes?.[colIndex] ?? "special", rolls: [rowRoll, colRoll] };
}

/**
 * Random Henchman Level (JJ 118): 1d20, −2 in a Class VI market.
 * @returns {Promise<{level: number, die: number, penalty: number}>}
 */
export async function rollRandomLevel(rollDice, marketClass) {
  const table = getTable("rarity", "randomHenchmanLevel");
  const penalty = marketClass === 6 ? table.classVIPenalty : 0;
  const die = await rollDice("1d20");
  const total = die + penalty;
  const row =
    table.rows.find((r) => (r.min === undefined || total >= r.min) && (r.max === undefined || total <= r.max)) ??
    table.rows[0];
  return { level: row.level, die, penalty };
}

/**
 * General-proficiency searches (JJ 119): 1d4 — on 1-3 the henchman is 0th
 * level, on 4 roll the Random Henchman Level table.
 */
export async function rollProficiencyLevel(rollDice, marketClass) {
  const d4 = await rollDice("1d4");
  if (d4 <= 3) return { level: 0, die: d4, penalty: 0 };
  return rollRandomLevel(rollDice, marketClass);
}

/**
 * Attributes, 3d6 in order (RR 168: henchmen are rolled up like PCs).
 * Rolled at HIRE only.
 * @returns {Promise<{str:number,int:number,wil:number,dex:number,con:number,cha:number}>}
 */
export async function rollAttributes(rollDice) {
  const attributes = {};
  for (const key of ["str", "int", "wil", "dex", "con", "cha"]) {
    attributes[key] = await rollDice("3d6");
  }
  return attributes;
}
