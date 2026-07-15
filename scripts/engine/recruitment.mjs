/* global game, foundry, Roll, Hooks */
/**
 * Recruitment engine — the EXPLICIT MONTHLY MARKET CYCLE (RR 162, JJ 118):
 *
 *  - Availability is rolled ONCE PER GAME MONTH per posting specification,
 *    producing that month's total candidate pool.
 *  - Not all of the pool is hireable in a given week: ½ (round up) arrives in
 *    week 1, ¼ (round down, min 1) in week 2, the remainder in week 3.
 *    Candidates before their availableFromTime are invisible and unhireable.
 *  - Search fees are due weekly per hireling type (availability.searchFees).
 *  - At month end an active posting renews (fresh monthly roll) or closes.
 *  - JJ specific-class searches are limited to once per month per spec;
 *    commissioned searches roll at one rarity lower.
 *
 * All processing is idempotent: postings carry lastProcessedTime and
 * arrivalPlan.materialized watermarks, so updateWorldTime re-fires are safe.
 */
import { MODULE_ID, HOOKS, SECONDS_PER_WEEK } from "../constants.mjs";
import { rollMonthlyPool, arrivalSplit, shiftMarketClass, searchFeeFormula } from "../rules/availability.mjs";
import { henchmanWage } from "../rules/wages.mjs";
import { sumEffectModifiers } from "../effects.mjs";
import * as adapter from "../acks-adapter.mjs";
import { now, secondsPerMonth } from "../time.mjs";

/** Foundry dice bridge for the pure rules functions. */
export async function rollDice(formula) {
  const roll = await new Roll(formula).evaluate();
  return roll.total;
}

/** Effective market class for an employer at a location (effect shifts). */
export function effectiveMarketClass(location, employer) {
  const base = location.system.marketClass;
  const shift = employer ? sumEffectModifiers(employer, "marketClass") : 0;
  return shiftMarketClass(base, shift);
}

function randomName(spec) {
  // Candidates are anonymous until the Judge names them; a readable tag helps.
  const tag = spec.classKey || spec.troopType || spec.specialistType || (spec.level != null ? `L${spec.level}` : "");
  return tag ? `${game.i18n.localize("ACKS-HENCHMEN.candidate.unnamed")} (${tag})` : game.i18n.localize("ACKS-HENCHMEN.candidate.unnamed");
}

/**
 * Roll one month's pool for a posting and build its arrival plan + candidate
 * records. Aggregated kinds (0th-level henchmen, mercenaries, specialists,
 * laborers) get ONE candidate row per week-tranche with a quantity; leveled
 * henchman searches get individual rows.
 */
async function rollMonthForPosting(location, posting, employer) {
  const mc = effectiveMarketClass(location, employer);
  const variant = location.system.classRarityTableId || "default";
  const result = await rollMonthlyPool(posting.spec, mc, rollDice, Math.random, variant);
  if (result.error) return { error: result.error };

  let total = result.quantity;
  // JJ: rarity results are capped by base RR henchman availability (all types).
  if (posting.spec.kind === "henchmanByClass" || posting.spec.kind === "henchmanByProficiency") {
    const capSpec = { kind: "henchman", level: Math.max(1, posting.spec.level ?? 1) };
    const cap = await rollMonthlyPool(capSpec, mc, rollDice);
    if (!cap.error && cap.quantity < total) total = cap.quantity;
  }

  const [w1, w2, w3] = arrivalSplit(total);
  const monthStart = now();
  const candidates = [];
  const individual = ["henchman", "henchmanByClass", "henchmanByProficiency"].includes(posting.spec.kind) && (posting.spec.level ?? 0) > 0;
  const weeks = [
    { week: 1, count: w1 },
    { week: 2, count: w2 },
    { week: 3, count: w3 },
  ];
  for (const { week, count } of weeks) {
    if (count <= 0) continue;
    const availableFromTime = monthStart + (week - 1) * SECONDS_PER_WEEK;
    const base = {
      postingId: posting.id,
      kind: posting.spec.kind,
      level: posting.spec.level ?? null,
      classKey: posting.spec.classKey ?? "",
      classRarity: result.rarity ?? "",
      troopType: posting.spec.troopType ?? "",
      specialistType: posting.spec.specialistType ?? "",
      wageGp: result.wage ?? (posting.spec.level != null ? henchmanWage(posting.spec.level) : null),
      wageUnit: result.wageUnit ?? "month",
      availableFromTime,
      status: "pending",
    };
    if (individual) {
      for (let i = 0; i < count; i++) {
        candidates.push({ ...base, id: foundry.utils.randomID(), name: randomName(posting.spec), quantity: 1 });
      }
    } else {
      candidates.push({ ...base, id: foundry.utils.randomID(), name: randomName(posting.spec), quantity: count });
    }
  }
  return {
    total,
    detail: result.detail,
    arrivalPlan: weeks.map((w) => ({ ...w, materialized: false })),
    candidates,
    monthStartTime: monthStart,
  };
}

/** Charge the weekly search fee (rolled fresh each week, RR 162). */
async function chargeWeeklyFee(location, posting, employer) {
  const mc = effectiveMarketClass(location, employer);
  const formula = searchFeeFormula(mc);
  const gp = await rollDice(formula);
  let paid = false;
  if (employer) {
    paid = await adapter.spendGold(employer, gp, game.i18n.format("ACKS-HENCHMEN.fee.reason", { name: location.name }));
  }
  return { gp, paid };
}

/**
 * Create a posting on a location actor: validates the employer level cap,
 * rolls the first month's pool, charges the week-1 fee.
 * @returns {Promise<{posting: object}|{error: string}>}
 */
export async function createPosting(location, spec, employer, { dedicatedSearcherUuid = "", playersSeeDetails = true } = {}) {
  // Once per month per specification (JJ 118).
  const specKey = JSON.stringify(spec);
  const monthAgo = now() - secondsPerMonth();
  const duplicate = (location.system.postings ?? []).find(
    (p) => p.status === "active" && JSON.stringify({ ...p.spec }) === specKey && p.monthStartTime > monthAgo
  );
  if (duplicate) return { error: "duplicate-spec-this-month" };

  const posting = {
    id: foundry.utils.randomID(),
    createdTime: now(),
    monthStartTime: now(),
    employerUuid: employer?.uuid ?? "",
    dedicatedSearcherUuid,
    spec,
    commissioned: !!spec.commissioned,
    totalAvailable: 0,
    rollDetail: "",
    arrivalPlan: [],
    feesPaid: [],
    lastProcessedTime: now(),
    status: "active",
    playersSeeDetails,
  };

  const month = await rollMonthForPosting(location, posting, employer);
  if (month.error) return { error: month.error };
  posting.totalAvailable = month.total;
  posting.rollDetail = month.detail;
  posting.arrivalPlan = month.arrivalPlan;
  posting.monthStartTime = month.monthStartTime;

  const fee = await chargeWeeklyFee(location, posting, employer);
  posting.feesPaid.push({ time: now(), gp: fee.gp });

  const postings = [...(location.system.postings ?? []).map((p) => p.toObject?.() ?? p), posting];
  const candidates = [
    ...(location.system.candidates ?? []).map((c) => c.toObject?.() ?? c),
    ...month.candidates,
  ];
  const ledger = [
    ...(location.system.searchLedger ?? []).map((l) => l.toObject?.() ?? l),
    { time: now(), gp: fee.gp, postingId: posting.id, paidByUuid: employer?.uuid ?? "" },
  ];
  await location.update({
    "system.postings": postings,
    "system.candidates": candidates,
    "system.searchLedger": ledger,
  });
  Hooks.callAll(HOOKS.POSTING_CREATED, { location, posting, employer });
  return { posting, fee };
}

/**
 * Idempotent due-processing for one location: materialize arrival tranches,
 * charge weekly fees, renew or close postings at month end.
 * Runs on the GM client (time.mjs gates the hook).
 */
export async function processLocation(location, currentTime = now()) {
  const sys = location.system;
  const postings = (sys.postings ?? []).map((p) => p.toObject?.() ?? foundry.utils.deepClone(p));
  const candidates = (sys.candidates ?? []).map((c) => c.toObject?.() ?? foundry.utils.deepClone(c));
  const ledger = (sys.searchLedger ?? []).map((l) => l.toObject?.() ?? foundry.utils.deepClone(l));
  let changed = false;
  const arrivedNow = [];

  for (const posting of postings) {
    if (posting.status !== "active") continue;
    const employer = posting.employerUuid ? await fromUuid(posting.employerUuid).catch(() => null) : null;
    const employerActor = employer?.actor ?? employer;

    // 1. Materialize arrival tranches whose week has begun.
    for (const tranche of posting.arrivalPlan) {
      if (tranche.materialized || tranche.count <= 0) continue;
      const trancheTime = posting.monthStartTime + (tranche.week - 1) * SECONDS_PER_WEEK;
      if (currentTime < trancheTime) continue;
      tranche.materialized = true;
      changed = true;
      let arrived = 0;
      for (const c of candidates) {
        if (c.postingId !== posting.id || c.status !== "pending") continue;
        if (c.availableFromTime <= currentTime) {
          c.status = "available";
          arrived += c.quantity ?? 1;
        }
      }
      if (arrived > 0) arrivedNow.push({ posting, week: tranche.week, count: arrived });
    }

    // 2. Weekly fees: one per elapsed week since the last one paid this month.
    const weeksElapsed = Math.min(3, Math.floor((currentTime - posting.monthStartTime) / SECONDS_PER_WEEK) + 1);
    const feesThisMonth = posting.feesPaid.filter((f) => f.time >= posting.monthStartTime).length;
    for (let w = feesThisMonth; w < weeksElapsed; w++) {
      const fee = await chargeWeeklyFee(location, posting, employerActor);
      posting.feesPaid.push({ time: currentTime, gp: fee.gp });
      ledger.push({ time: currentTime, gp: fee.gp, postingId: posting.id, paidByUuid: posting.employerUuid });
      changed = true;
    }

    // 3. Month rollover: renew (fresh monthly roll) or close.
    if (currentTime - posting.monthStartTime >= secondsPerMonth()) {
      const unhired = candidates.filter((c) => c.postingId === posting.id && ["pending", "available"].includes(c.status));
      for (const c of unhired) c.status = "withdrawn"; // last month's pool disperses
      if (posting.commissioned || posting.renew) {
        const month = await rollMonthForPosting(location, posting, employerActor);
        if (!month.error) {
          posting.totalAvailable = month.total;
          posting.rollDetail = month.detail;
          posting.arrivalPlan = month.arrivalPlan;
          posting.monthStartTime = month.monthStartTime;
          candidates.push(...month.candidates);
        }
      } else {
        posting.status = "closed";
      }
      changed = true;
    }
    posting.lastProcessedTime = currentTime;
  }

  if (changed) {
    await location.update({
      "system.postings": postings,
      "system.candidates": candidates,
      "system.searchLedger": ledger,
    });
    for (const arrival of arrivedNow) {
      Hooks.callAll(HOOKS.CANDIDATES_ARRIVED, { location, ...arrival });
    }
  }
  return { changed, arrived: arrivedNow };
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
