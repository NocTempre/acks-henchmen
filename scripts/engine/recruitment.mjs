/* global game, foundry, Roll, Hooks */
/**
 * Recruitment engine — RAW model (RR 162, JJ 118):
 *
 *  - AVAILABILITY IS A PROPERTY OF THE MARKET. Each generic segment
 *    (henchmen of a level, a mercenary troop type, a specialist type) is
 *    rolled ONCE PER GAME MONTH PER LOCATION, using the location's market
 *    class — shared by every recruiter in town. ½ (round up) of the pool
 *    arrives in week 1, ¼ (round down, min 1) in week 2, the rest in week 3.
 *  - A POSTING is a recruiter's PAID SEARCH: the weekly fee (per hireling
 *    type, RR 162) buys access to that segment's arrived candidates.
 *  - SPECIFIC searches (by class or proficiency, JJ 118) are paid and rolled
 *    SEPARATELY, privately, per recruiter — once per month per specification,
 *    capped by the market's base henchman availability.
 *  - Every candidate is a UNIQUE INDIVIDUAL: name, gender, age, culture,
 *    appearance, and (0th level) occupation + class trajectory, generated
 *    from the location's demographics. Class and level are FIXED at pool
 *    roll (anti-fishing); attributes roll once at hire. Only troop-scale
 *    entries (mercenaries, mass laborers) stay aggregated.
 *
 * All processing is idempotent (worldTime watermarks) — updateWorldTime
 * re-fires are safe.
 */
import { MODULE_ID, HOOKS, SECONDS_PER_WEEK } from "../constants.mjs";
import {
  rollMonthlyPool,
  arrivalSplit,
  shiftMarketClass,
  searchFeeFormula,
  clampMarketClass,
} from "../rules/availability.mjs";
import { parseAvailability } from "../rules/dice.mjs";
import { rollClassFromGrid, rollRandomLevel, rollProficiencyLevel } from "../rules/candidates.mjs";
import { generateIdentity } from "../rules/identity.mjs";
import { henchmanWage } from "../rules/wages.mjs";
import { getTable } from "../rules/tables.mjs";
import { sumEffectModifiers } from "../effects.mjs";
import * as adapter from "../acks-adapter.mjs";
import { now, secondsPerMonth } from "../time.mjs";

/** Foundry dice bridge for the pure rules functions. */
export async function rollDice(formula) {
  const roll = await new Roll(formula).evaluate();
  return roll.total;
}

/** Kinds that draw on the shared location pool vs. private JJ searches. */
export const GENERIC_KINDS = ["henchman", "mercenary", "specialist"];
export const PRIVATE_KINDS = ["henchmanByClass", "henchmanByProficiency"];

/** Shared-pool key for a generic spec. */
export function segmentKeyFor(spec) {
  if (spec.kind === "henchman") return `henchman:${spec.level ?? 0}`;
  if (spec.kind === "mercenary") return `mercenary:${spec.troopType}`;
  if (spec.kind === "specialist") return `specialist:${spec.specialistType}`;
  return "";
}

/**
 * Effective market class for a recruiter's own dealings (fees, private
 * searches): Mercantile Network shifts it. The SHARED pool always uses the
 * location's own class — the town's stock doesn't depend on who is asking.
 */
export function effectiveMarketClass(location, employer) {
  const base = location.system.marketClass;
  const shift = employer ? sumEffectModifiers(employer, "marketClass") : 0;
  return shiftMarketClass(base, shift);
}

/**
 * Troop-scale (aggregated) segments: mercenaries always; specialist types
 * whose Class I availability uses a ×multiplier (laborers, rowers, sailors,
 * copyists, street-corner ruffians) — the book counts them by the score.
 */
function isMassSpec(spec) {
  if (spec.kind === "mercenary") return true;
  if (spec.kind !== "specialist") return false;
  const row = getTable("availability", "specialistAvailability").rows.find((r) => r.type === spec.specialistType);
  const parsed = row ? parseAvailability(row.byMarketClass[0]) : null;
  return !!parsed && parsed.mult > 1;
}

function demographicsOf(location) {
  return (location.system.demographics ?? []).map((d) => d.toObject?.() ?? d);
}

/**
 * Build candidate records for one rolled pool.
 * @returns {Promise<object[]>}
 */
async function buildCandidates({ location, spec, total, marketClass, segment, privateToUuid, monthStart, rarity }) {
  const [w1, w2, w3] = arrivalSplit(total);
  const weeks = [
    { week: 1, count: w1 },
    { week: 2, count: w2 },
    { week: 3, count: w3 },
  ];
  const candidates = [];
  const mass = isMassSpec(spec);
  const demographics = demographicsOf(location);
  const rand = Math.random;

  for (const { week, count } of weeks) {
    if (count <= 0) continue;
    const availableFromTime = monthStart + (week - 1) * SECONDS_PER_WEEK;
    const base = {
      segment: segment ?? "",
      privateToUuid: privateToUuid ?? "",
      kind: spec.kind,
      level: spec.level ?? null,
      classKey: spec.classKey ?? "",
      classRarity: rarity ?? "",
      troopType: spec.troopType ?? "",
      specialistType: spec.specialistType ?? "",
      wageGp: null,
      wageUnit: "month",
      availableFromTime,
      status: "pending",
    };

    if (mass) {
      // Troop-scale: one aggregated row per arrival week.
      const row =
        spec.kind === "mercenary"
          ? getTable("wages", "mercenaryWages").rows.find((r) => r.type === spec.troopType)
          : getTable("availability", "specialistAvailability").rows.find((r) => r.type === spec.specialistType);
      candidates.push({
        ...base,
        id: foundry.utils.randomID(),
        name: game.i18n.localize(
          spec.kind === "mercenary" ? `ACKS-HENCHMEN.troop.${spec.troopType}` : `ACKS-HENCHMEN.specialist.${spec.specialistType}`
        ),
        quantity: count,
        wageGp: spec.kind === "mercenary" ? (row?.wages?.man ?? null) : (row?.wage ?? null),
        wageUnit: spec.kind === "mercenary" ? "month" : (row?.wageUnit ?? "month"),
      });
      continue;
    }

    // Individuals: identity + fixed class/level per candidate (anti-fishing).
    for (let i = 0; i < count; i++) {
      const candidate = { ...base, id: foundry.utils.randomID(), quantity: 1 };
      if (spec.kind === "henchman") {
        if ((spec.level ?? 0) > 0) {
          const rolled = await rollClassFromGrid(rollDice);
          candidate.classKey = rolled.classKey;
          candidate.doubleD100 = rolled.rolls;
        }
        candidate.wageGp = henchmanWage(spec.level ?? 0);
      } else if (spec.kind === "henchmanByClass") {
        if (!candidate.level || candidate.level <= 0) {
          const rolled = await rollRandomLevel(rollDice, clampMarketClass(marketClass));
          candidate.level = rolled.level;
        }
        candidate.wageGp = henchmanWage(candidate.level ?? 0);
      } else if (spec.kind === "henchmanByProficiency") {
        const lvl = await rollProficiencyLevel(rollDice, clampMarketClass(marketClass));
        candidate.level = lvl.level;
        if (lvl.level > 0) {
          const cls = await rollClassFromGrid(rollDice);
          candidate.classKey = cls.classKey;
          candidate.doubleD100 = cls.rolls;
        }
        candidate.notes = spec.proficiencyName
          ? `${spec.proficiencyName} ×${spec.proficiencyRanks ?? 1}`
          : "";
        candidate.wageGp = henchmanWage(candidate.level ?? 0);
      } else if (spec.kind === "specialist") {
        const row = getTable("availability", "specialistAvailability").rows.find(
          (r) => r.type === spec.specialistType
        );
        candidate.wageGp = row?.wage ?? null;
        candidate.wageUnit = row?.wageUnit ?? "month";
      }

      const identity = generateIdentity({
        rand,
        demographics,
        level: candidate.level ?? 0,
        classKey: candidate.classKey,
      });
      candidate.name = identity.name;
      candidate.gender = identity.gender;
      candidate.culture = identity.culture;
      candidate.age = identity.age;
      candidate.appearance = identity.appearance;
      if (!candidate.occupation && identity.occupation) candidate.occupation = identity.occupation;
      if (!candidate.classKey && identity.classKey) candidate.classKey = identity.classKey;
      candidates.push(candidate);
    }
  }
  return candidates;
}

/* ------------------------- shared pools ------------------------- */

/**
 * Ensure the location's shared pool for a generic segment is rolled for the
 * current month (RR 162: availability belongs to the market). Idempotent:
 * an existing current-month entry is returned untouched.
 * @returns {Promise<{roll: object, candidates: object[], fresh: boolean}>}
 */
export async function ensureSegmentRolled(location, spec, { marketRollsOverride = null } = {}) {
  const segment = segmentKeyFor(spec);
  const currentTime = now();
  const rolls = (marketRollsOverride ?? location.system.marketRolls ?? []).map(
    (r) => r.toObject?.() ?? foundry.utils.deepClone(r)
  );
  const existing = rolls.find((r) => r.segment === segment && currentTime - r.monthStartTime < secondsPerMonth());
  if (existing) return { roll: existing, candidates: [], fresh: false };

  const marketClass = location.system.marketClass; // location's own stock
  const result = await rollMonthlyPool(spec, marketClass, rollDice);
  if (result.error) return { error: result.error };
  const candidates = await buildCandidates({
    location,
    spec,
    total: result.quantity,
    marketClass,
    segment,
    privateToUuid: "",
    monthStart: currentTime,
  });
  const entry = { segment, monthStartTime: currentTime, total: result.quantity, detail: result.detail };
  const nextRolls = [...rolls.filter((r) => r.segment !== segment), entry];
  return { roll: entry, candidates, fresh: true, nextRolls };
}

/* ------------------------- postings (paid searches) ------------------------- */

async function chargeWeeklyFee(location, employer) {
  const mc = effectiveMarketClass(location, employer);
  const gp = await rollDice(searchFeeFormula(mc));
  let paid = false;
  if (employer) {
    paid = await adapter.spendGold(employer, gp, game.i18n.format("ACKS-HENCHMEN.fee.reason", { name: location.name }));
  }
  return { gp, paid };
}

/**
 * Create a posting (paid search). Generic kinds join the shared segment
 * pool; specific kinds roll a private pool (JJ 118: once per month per
 * specification per recruiter, at the recruiter's effective market class,
 * capped by base henchman availability).
 */
export async function createPosting(location, spec, employer, { dedicatedSearcherUuid = "", playersSeeDetails = true } = {}) {
  const currentTime = now();
  const isPrivate = PRIVATE_KINDS.includes(spec.kind);
  const segment = isPrivate ? "" : segmentKeyFor(spec);

  // Duplicate checks: one active search per employer per segment / spec-month.
  const postings = (location.system.postings ?? []).map((p) => p.toObject?.() ?? foundry.utils.deepClone(p));
  if (!isPrivate) {
    const dup = postings.find((p) => p.status === "active" && p.segment === segment && p.employerUuid === (employer?.uuid ?? ""));
    if (dup) return { error: "duplicate-segment" };
  } else {
    const specKey = JSON.stringify(spec);
    const dup = postings.find(
      (p) =>
        p.status === "active" &&
        p.employerUuid === (employer?.uuid ?? "") &&
        JSON.stringify(p.spec.toObject?.() ?? p.spec) === specKey &&
        currentTime - p.monthStartTime < secondsPerMonth()
    );
    if (dup) return { error: "duplicate-spec-this-month" };
  }

  const posting = {
    id: foundry.utils.randomID(),
    createdTime: currentTime,
    monthStartTime: currentTime,
    segment,
    employerUuid: employer?.uuid ?? "",
    dedicatedSearcherUuid,
    spec,
    commissioned: !!spec.commissioned,
    totalAvailable: 0,
    rollDetail: "",
    arrivalPlan: [],
    feesPaid: [],
    lastProcessedTime: currentTime,
    status: "active",
    playersSeeDetails,
  };

  let newCandidates = [];
  let nextRolls = null;

  if (isPrivate) {
    const mc = effectiveMarketClass(location, employer);
    const result = await rollMonthlyPool(spec, mc, rollDice, Math.random, location.system.classRarityTableId || "default");
    if (result.error) return { error: result.error };
    let total = result.quantity;
    // JJ: capped by the market's base henchman availability.
    const cap = await rollMonthlyPool({ kind: "henchman", level: Math.max(1, spec.level ?? 1) }, mc, rollDice);
    if (!cap.error && cap.quantity < total) total = cap.quantity;
    posting.totalAvailable = total;
    posting.rollDetail = result.detail;
    newCandidates = await buildCandidates({
      location,
      spec,
      total,
      marketClass: mc,
      segment: "",
      privateToUuid: employer?.uuid ?? "",
      monthStart: currentTime,
      rarity: result.rarity,
    });
  } else {
    const ensured = await ensureSegmentRolled(location, spec);
    if (ensured.error) return { error: ensured.error };
    posting.totalAvailable = ensured.roll.total;
    posting.rollDetail = ensured.roll.detail;
    if (ensured.fresh) {
      newCandidates = ensured.candidates;
      nextRolls = ensured.nextRolls;
    }
  }

  const fee = await chargeWeeklyFee(location, employer);
  posting.feesPaid.push({ time: currentTime, gp: fee.gp });

  const update = {
    "system.postings": [...postings, posting],
    "system.searchLedger": [
      ...(location.system.searchLedger ?? []).map((l) => l.toObject?.() ?? l),
      { time: currentTime, gp: fee.gp, postingId: posting.id, paidByUuid: employer?.uuid ?? "" },
    ],
  };
  if (newCandidates.length) {
    update["system.candidates"] = [
      ...(location.system.candidates ?? []).map((c) => c.toObject?.() ?? c),
      ...newCandidates,
    ];
  }
  if (nextRolls) update["system.marketRolls"] = nextRolls;
  await location.update(update);
  Hooks.callAll(HOOKS.POSTING_CREATED, { location, posting, employer });
  return { posting, fee };
}

/* ------------------------- time processing ------------------------- */

/**
 * Idempotent due-processing for one location: arrivals, weekly fees per
 * active posting, monthly pool refresh (shared segments with an active
 * search; private searches re-roll monthly while active — JJ: "paying the
 * fee and rolling again each month").
 */
export async function processLocation(location, currentTime = now()) {
  const sys = location.system;
  const postings = (sys.postings ?? []).map((p) => p.toObject?.() ?? foundry.utils.deepClone(p));
  let candidates = (sys.candidates ?? []).map((c) => c.toObject?.() ?? foundry.utils.deepClone(c));
  let marketRolls = (sys.marketRolls ?? []).map((r) => r.toObject?.() ?? foundry.utils.deepClone(r));
  const ledger = (sys.searchLedger ?? []).map((l) => l.toObject?.() ?? foundry.utils.deepClone(l));
  let changed = false;
  const arrivals = new Map();

  // 1. Arrivals: pending candidates whose week has come.
  for (const c of candidates) {
    if (c.status === "pending" && c.availableFromTime <= currentTime) {
      c.status = "available";
      changed = true;
      const key = c.segment || c.privateToUuid || "private";
      arrivals.set(key, (arrivals.get(key) ?? 0) + (c.quantity ?? 1));
    }
  }

  // 2. Weekly fees per active posting (fee per week per type searched).
  for (const posting of postings) {
    if (posting.status !== "active") continue;
    const employerDoc = posting.employerUuid ? await fromUuid(posting.employerUuid).catch(() => null) : null;
    const employer = employerDoc?.actor ?? employerDoc;
    const weeksElapsed = Math.floor((currentTime - posting.createdTime) / SECONDS_PER_WEEK) + 1;
    const feesPaid = posting.feesPaid.length;
    for (let w = feesPaid; w < weeksElapsed; w++) {
      const fee = await chargeWeeklyFee(location, employer);
      posting.feesPaid.push({ time: currentTime, gp: fee.gp });
      ledger.push({ time: currentTime, gp: fee.gp, postingId: posting.id, paidByUuid: posting.employerUuid });
      changed = true;
    }

    // 3a. Private searches: monthly re-roll while the posting stays active.
    if (PRIVATE_KINDS.includes(posting.spec.kind) && currentTime - posting.monthStartTime >= secondsPerMonth()) {
      candidates = candidates.map((c) => {
        if (c.privateToUuid === posting.employerUuid && ["pending", "available"].includes(c.status)) {
          return { ...c, status: "withdrawn" };
        }
        return c;
      });
      const mc = effectiveMarketClass(location, employer);
      const spec = posting.spec.toObject?.() ?? posting.spec;
      const result = await rollMonthlyPool(spec, mc, rollDice, Math.random, sys.classRarityTableId || "default");
      if (!result.error) {
        let total = result.quantity;
        const cap = await rollMonthlyPool({ kind: "henchman", level: Math.max(1, spec.level ?? 1) }, mc, rollDice);
        if (!cap.error && cap.quantity < total) total = cap.quantity;
        posting.totalAvailable = total;
        posting.rollDetail = result.detail;
        posting.monthStartTime = currentTime;
        candidates.push(
          ...(await buildCandidates({
            location,
            spec,
            total,
            marketClass: mc,
            segment: "",
            privateToUuid: posting.employerUuid,
            monthStart: currentTime,
            rarity: result.rarity,
          }))
        );
      }
      changed = true;
    }
    posting.lastProcessedTime = currentTime;
  }

  // 3b. Shared segments: month rollover — withdraw the stale pool; re-roll
  // while any active posting still covers the segment.
  for (const roll of [...marketRolls]) {
    if (currentTime - roll.monthStartTime < secondsPerMonth()) continue;
    candidates = candidates.map((c) => {
      if (c.segment === roll.segment && ["pending", "available"].includes(c.status)) {
        return { ...c, status: "withdrawn" };
      }
      return c;
    });
    marketRolls = marketRolls.filter((r) => r.segment !== roll.segment);
    changed = true;
    const active = postings.find((p) => p.status === "active" && p.segment === roll.segment);
    if (active) {
      const spec = active.spec.toObject?.() ?? active.spec;
      const ensured = await ensureSegmentRolled(location, spec, { marketRollsOverride: marketRolls });
      if (!ensured.error && ensured.fresh) {
        marketRolls = [...marketRolls, ensured.roll];
        candidates.push(...ensured.candidates);
        active.totalAvailable = ensured.roll.total;
        active.rollDetail = ensured.roll.detail;
        active.monthStartTime = currentTime;
      }
    }
  }

  if (changed) {
    await location.update({
      "system.postings": postings,
      "system.candidates": candidates,
      "system.marketRolls": marketRolls,
      "system.searchLedger": ledger,
    });
    for (const [segment, count] of arrivals) {
      Hooks.callAll(HOOKS.CANDIDATES_ARRIVED, { location, segment, count });
    }
  }
  return { changed, arrived: [...arrivals.values()].reduce((s, n) => s + n, 0) };
}

/** Process every location actor in the world (GM-side time hook target). */
export async function processAllLocations(currentTime = now()) {
  const type = `${MODULE_ID}.location`;
  for (const actor of game.actors.filter((a) => a.type === type)) {
    try {
      await processLocation(actor, currentTime);
    } catch (err) {
      console.error(`${MODULE_ID} | processing ${actor.name} failed`, err);
    }
  }
}
