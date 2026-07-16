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
 * Random class via the JJ GM-screen double-d100 distribution (RAW cells,
 * bucket-first): the first d100 selects the BUCKET, the second resolves the
 * class on that bucket's ladder. A location rarity variant may override the
 * buckets (JJ 118: rarity varies by settlement). "special" = Judge picks
 * from the expansion books.
 * @param {(f: string) => Promise<number>} rollDice
 * @param {string} [variant="default"] - classRarityTables variant id
 * @returns {Promise<{classKey: string, bucket: string, rolls: [number, number]}>}
 */
export async function rollClassFromDistribution(rollDice, variant = "default") {
  const distribution = getTable("rarity", "classDistribution");
  const variants = getTable("rarity", "classRarityTables").variants;
  const buckets = variants[variant]?.buckets ?? distribution.buckets;
  const bucketRoll = await rollDice("1d100");
  const rowRoll = await rollDice("1d100");
  const bucket = buckets.find((b) => bucketRoll >= b.min && bucketRoll <= b.max) ?? buckets[buckets.length - 1];
  const row = bucket.rows.find((r) => rowRoll >= r.min && rowRoll <= r.max);
  return { classKey: row?.class ?? "special", bucket: bucket.id, rolls: [bucketRoll, rowRoll] };
}

/**
 * 0th-level class trajectory: the BUCKET rolls from the JJ 247 level-0
 * archetype weights, then the class resolves on the same bucket ladder.
 * @returns {Promise<{classKey: string, bucket: string, rolls: [number, number]}>}
 */
export async function rollTrajectoryFromDistribution(rollDice, variant = "default") {
  const distribution = getTable("rarity", "classDistribution");
  const variants = getTable("rarity", "classRarityTables").variants;
  const buckets = variants[variant]?.buckets ?? distribution.buckets;
  const weights = distribution.trajectoryBucketWeights.weights;
  const total = Object.values(weights).reduce((s, w) => s + w, 0);
  const bucketRoll = await rollDice(`1d${total}`);
  let running = 0;
  let bucketId = Object.keys(weights)[0];
  for (const [id, w] of Object.entries(weights)) {
    running += w;
    if (bucketRoll <= running) {
      bucketId = id;
      break;
    }
  }
  const bucket = buckets.find((b) => b.id === bucketId) ?? buckets[0];
  const rowRoll = await rollDice("1d100");
  const row = bucket.rows.find((r) => rowRoll >= r.min && rowRoll <= r.max);
  return { classKey: row?.class ?? "special", bucket: bucket.id, rolls: [bucketRoll, rowRoll] };
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
