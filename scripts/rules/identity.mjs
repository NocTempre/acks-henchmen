/**
 * Candidate identity generation (RR 495-503 People + JJ 245-257 NPCs).
 * Pure module. Every candidate is a UNIQUE INDIVIDUAL: name, gender, age,
 * appearance, and (for 0th level) an occupation plus a class trajectory —
 * all generated from the LOCATION's demographics (weighted culture mix).
 */
import { getTable, optTable } from "./tables.mjs";

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

/** Registry entry for a class ({bucket, rarity, race?, cultures?, sex?}). */
export function classInfo(classKey) {
  const registry = optTable("people", "classRegistry")?.classes;
  return registry?.[String(classKey ?? "").toLowerCase().trim()] ?? null;
}

/** The race a class belongs to ("human" when the registry declares none). */
export function raceForClass(classKey) {
  const declared = classInfo(classKey)?.race;
  if (declared) return declared;
  // Until the class registry is importable, the race-bound classes announce
  // their race in their own key ("elven spellsword", "dwarven vaultguard") —
  // derive it so cultures align (no Zaharan humans, no elven vaultguards).
  const m = String(classKey ?? "").toLowerCase().match(/^(elven|dwarven|zaharan|nobiran|thrassian)\b/);
  return m ? { elven: "elf", dwarven: "dwarf", zaharan: "zaharan", nobiran: "nobiran", thrassian: "thrassian" }[m[1]] : "human";
}

/** Optional per-class culture whitelist (barbarians, shamans…). */
export function culturesForClass(classKey) {
  return classInfo(classKey)?.cultures ?? null;
}

/** Sex restriction for a class ("female", "male", or null). */
export function sexForClass(classKey) {
  return classInfo(classKey)?.sex ?? null;
}

/** The race of a culture ("human" when the entry declares none). */
export function raceOfCulture(cultureId) {
  return getTable("people", "cultures").list[cultureId]?.race ?? "human";
}

/**
 * Resolve a culture id from the location's demographics weights,
 * CONSTRAINED to a race so culture and class always align (no Zaharan
 * humans, no elven vaultguards). Falls back to the race's own culture(s)
 * when the demographics don't include one; Nobiran and other human-passing
 * bloodlines use `classRegistry.raceCultures`.
 */
export function pickCulture(rand, demographics, race = null, cultureWhitelist = null) {
  const cultures = getTable("people", "cultures").list;
  // Nobiran are a human-passing bloodline of the empire — the book gives them
  // Auran names rather than a list of their own.
  if (race === "nobiran" && cultures.auran) return "auran";
  const matchesRace = (id) => {
    if (cultureWhitelist && !cultureWhitelist.includes(id)) return false;
    if (!race) return true;
    if (race === "human") return raceOfCulture(id) === "human";
    const raceCultures = optTable("people", "classRegistry")?.raceCultures?.[race];
    if (raceCultures) return raceCultures.includes(id);
    return raceOfCulture(id) === race;
  };
  const weighted = (demographics ?? []).filter((d) => d.culture in cultures && d.weight > 0 && matchesRace(d.culture));
  if (weighted.length) return pickWeighted(rand, weighted, (d) => d.weight).culture;
  const ids = Object.keys(cultures).filter(matchesRace);
  if (!ids.length) return Object.keys(cultures)[0];
  return ids[Math.floor(rand() * ids.length)];
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
  // Appearance palettes are book PROSE, not imported as data — a culture may
  // carry only its names. No palette → no generated line (the sheet can show
  // a @PdfText reference to the culture description instead).
  if (!culture?.hair?.length || !culture?.eyes?.length || !culture?.skin?.length) return "";
  const hair = pick(rand, culture.hair);
  const eyes = pick(rand, culture.eyes);
  const skin = pick(rand, culture.skin);
  return `${hair} hair, ${eyes} eyes, ${skin} skin; ${culture.build}`;
}

/** Age column for a class per JJ 248's class groups. */
function ageColumnFor(table, classKey) {
  const wanted = String(classKey ?? "").toLowerCase();
  for (const [column, classes] of Object.entries(table.classGroups ?? {})) {
    if (classes.some((c) => wanted.includes(c))) return column;
  }
  return "noble";
}

/**
 * Plausible age for a candidate of a level/class: the JJ minimum for the
 * class group plus small variance; 0th level = young adult. When the age
 * table has not been imported, every candidate is a young adult (18+).
 */
export function generateAge(rand, level, classKey) {
  const table = optTable("people", "ageByClass");
  if (!table) return 18 + Math.floor(rand() * 7);
  const column = table.columns[ageColumnFor(table, classKey)];
  const base = Number(column?.[String(Math.max(0, Math.min(14, level ?? 0)))]) || 18;
  const variance = Math.floor(rand() * 7); // +0..6 years past the minimum
  return base + variance;
}

/**
 * 0th-level occupation. Humans roll the JJ 254-257 profession lists; races
 * with their own society table (occupations.byRace — dwarves roll CASTE per
 * the BTA ethnicity text) use it instead. A category with no entries (the
 * dwarven Oathsworn) means the occupation IS the sworn order — the class
 * trajectory carries it, and the caste label alone is recorded.
 */
export function generateOccupation(rand, race = "human") {
  const table = optTable("people", "occupations");
  if (!table) {
    // The category table (JJ 252) is not imported yet; draw uniformly from
    // the harvested occupation packages so 0th candidates still get a trade
    // and a proficiency grant. Category WEIGHTS arrive with that table.
    const packs = optTable("people", "occupationPackages");
    const keys = packs ? Object.keys(packs) : [];
    if (!keys.length) return { category: "", occupation: "" };
    const k = keys[Math.floor(rand() * keys.length)];
    return { category: "", occupation: k.replace(/\b\w/g, (c) => c.toUpperCase()) };
  }
  const raceTable = table.byRace?.[race];
  if (raceTable) {
    const category = pickWeighted(rand, raceTable.categories, (c) => c.weight);
    const occupation = category.entries.length
      ? `${category.label}: ${pick(rand, category.entries)}`
      : category.label;
    return { category: category.id, occupation };
  }
  const category = pickWeighted(rand, table.categories, (c) => c.weight);
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
  // GENERATION ORDER: class → culture → sex → name/age/appearance. The
  // class was rolled FIRST (bucket distribution, engine-side); here it
  // resolves downstream: culture follows the REGION distribution unless the
  // class registry restricts race/cultures (the restriction overrides the
  // region), and sex follows the registry's class restriction when present.
  // No class (specialists, mass labor) = unrestricted human.
  const resolvedClass = classKey || "";
  const culture = pickCulture(rand, demographics, resolvedClass ? raceForClass(resolvedClass) : "human", culturesForClass(resolvedClass));
  const gender = sexForClass(resolvedClass) ?? (rand() < 0.5 ? "male" : "female");
  const name = generateName(rand, culture, gender);
  let occupation = "";
  let occupationCategory = "";
  if ((level ?? 0) <= 0) {
    const occ = generateOccupation(rand, raceOfCulture(culture));
    occupation = occ.occupation;
    occupationCategory = occ.category;
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
