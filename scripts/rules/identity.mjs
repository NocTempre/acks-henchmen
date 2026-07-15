/**
 * Candidate identity generation (RR 495-503 People + JJ 245-257 NPCs).
 * Pure module. Every candidate is a UNIQUE INDIVIDUAL: name, gender, age,
 * appearance, and (for 0th level) an occupation plus a class trajectory —
 * all generated from the LOCATION's demographics (weighted culture mix).
 */
import { getTable } from "./tables.mjs";

function pick(rand, list) {
  return list[Math.floor(rand() * list.length)];
}

function pickWeighted(rand, entries, weightOf) {
  const total = entries.reduce((s, e) => s + weightOf(e), 0);
  if (total <= 0) return entries[0];
  let roll = rand() * total;
  for (const entry of entries) {
    roll -= weightOf(entry);
    if (roll <= 0) return entry;
  }
  return entries[entries.length - 1];
}

/** Resolve a culture id from the location's demographics weights. */
export function pickCulture(rand, demographics) {
  const cultures = getTable("people", "cultures").list;
  const weighted = (demographics ?? []).filter((d) => d.culture in cultures && d.weight > 0);
  if (!weighted.length) {
    const ids = Object.keys(cultures);
    return ids[Math.floor(rand() * ids.length)];
  }
  return pickWeighted(rand, weighted, (d) => d.weight).culture;
}

/** Full name per the culture's naming customs (patronym or surname). */
export function generateName(rand, cultureId, gender) {
  const culture = getTable("people", "cultures").list[cultureId];
  if (!culture) return { given: "Nameless", full: "Nameless" };
  const pool = gender === "female" ? culture.female : culture.male;
  const given = pick(rand, pool);
  let full = given;
  if (culture.surnames?.length) {
    full = `${given} ${pick(rand, culture.surnames)}`;
  } else if (culture.patronym) {
    const pattern = gender === "female" ? culture.patronym.female : culture.patronym.male;
    let parent = pick(rand, culture.male); // patronyms derive from the father
    if (parent === given) parent = pick(rand, culture.male);
    const patronym = pattern.replace("{parent}", parent);
    if (patronym && patronym !== given) full = `${given} ${patronym}`;
  }
  return { given, full };
}

/** One-line appearance from the culture's palette. */
export function generateAppearance(rand, cultureId) {
  const culture = getTable("people", "cultures").list[cultureId];
  if (!culture) return "";
  const hair = pick(rand, culture.hair);
  const eyes = pick(rand, culture.eyes);
  const skin = pick(rand, culture.skin);
  return `${hair} hair, ${eyes} eyes, ${skin} skin; ${culture.build}`;
}

/** Age column for a class per JJ 248's class groups. */
function ageColumnFor(classKey) {
  const table = getTable("people", "ageByClass");
  const wanted = String(classKey ?? "").toLowerCase();
  for (const [column, classes] of Object.entries(table.classGroups)) {
    if (classes.some((c) => wanted.includes(c))) return column;
  }
  return "noble";
}

/**
 * Plausible age for a candidate of a level/class: the JJ minimum for the
 * class group plus small variance; 0th level = young adult.
 */
export function generateAge(rand, level, classKey) {
  const table = getTable("people", "ageByClass");
  const column = table.columns[ageColumnFor(classKey)];
  const base = Number(column?.[String(Math.max(0, Math.min(14, level ?? 0)))]) || 18;
  const variance = Math.floor(rand() * 7); // +0..6 years past the minimum
  return base + variance;
}

/** 0th-level occupation from the weighted category lists (JJ 254-257). */
export function generateOccupation(rand) {
  const categories = getTable("people", "occupations").categories;
  const category = pickWeighted(rand, categories, (c) => c.weight);
  return { category: category.id, occupation: pick(rand, category.entries) };
}

/** Class trajectory from the JJ 247 percentage table (level 0 row included). */
export function generateTrajectoryClass(rand, level) {
  const rows = getTable("people", "classPercentages").rows;
  const row = rows.find((r) => level >= r.minLevel && level <= r.maxLevel) ?? rows[0];
  const entries = Object.entries(row.weights);
  return pickWeighted(rand, entries, ([, w]) => w)[0];
}

/**
 * Generate a full identity for one candidate.
 * @param {object} o - { rand, demographics, level, classKey }
 *   For 0th level with no classKey: rolls occupation + class trajectory.
 * @returns {{name, gender, culture, cultureLabel, age, appearance,
 *            occupation, occupationCategory, classKey}}
 */
export function generateIdentity({ rand = Math.random, demographics = [], level = 0, classKey = "" } = {}) {
  const cultures = getTable("people", "cultures").list;
  const culture = pickCulture(rand, demographics);
  const gender = rand() < 0.5 ? "male" : "female";
  const name = generateName(rand, culture, gender);
  let occupation = "";
  let occupationCategory = "";
  let resolvedClass = classKey;
  if ((level ?? 0) <= 0) {
    const occ = generateOccupation(rand);
    occupation = occ.occupation;
    occupationCategory = occ.category;
    // "Level 0 have classes": the trajectory they would advance into (JJ 247).
    if (!resolvedClass) resolvedClass = generateTrajectoryClass(rand, 0);
  }
  return {
    name: name.full,
    gender,
    culture,
    cultureLabel: cultures[culture]?.label ?? culture,
    age: generateAge(rand, level ?? 0, resolvedClass),
    appearance: generateAppearance(rand, culture),
    occupation,
    occupationCategory,
    classKey: resolvedClass,
  };
}
