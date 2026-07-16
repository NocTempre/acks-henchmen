/* global game, ui, foundry, Roll, Hooks, ChatMessage, Actor */
/**
 * Candidate rolling (feature 4 — record the results, generation is a future
 * module) and the hire pipeline.
 */
import { MODULE_ID, HOOKS, FLAG_RECORD } from "../constants.mjs";
import { henchmanWage } from "../rules/wages.mjs";
import { startingLoyalty, effectiveLoyalty } from "../rules/loyalty.mjs";
import { rollAttributes } from "../rules/candidates.mjs";
import { sumEffectModifiers, hasEffectFlag } from "../effects.mjs";
import * as adapter from "../acks-adapter.mjs";
import HenchmanRecord from "../data/henchman-record.mjs";
import { now } from "../time.mjs";

async function roll(formula) {
  return (await new Roll(formula).evaluate()).total;
}

/** Update one candidate record inside a location actor. */
export async function updateCandidate(location, candidateId, changes) {
  const candidates = (location.system.candidates ?? []).map((c) => {
    const obj = c.toObject?.() ?? foundry.utils.deepClone(c);
    return obj.id === candidateId ? foundry.utils.mergeObject(obj, changes) : obj;
  });
  await location.update({ "system.candidates": candidates });
  return candidates.find((c) => c.id === candidateId);
}

function getCandidate(location, candidateId) {
  const c = (location.system.candidates ?? []).find((x) => x.id === candidateId);
  return c ? (c.toObject?.() ?? foundry.utils.deepClone(c)) : null;
}

/** Update one special-hire entry on a location actor. */
export async function updateSpecialHire(location, specialHireId, changes) {
  const entries = (location.system.specialHires ?? []).map((s) => {
    const obj = s.toObject?.() ?? foundry.utils.deepClone(s);
    return obj.id === specialHireId ? foundry.utils.mergeObject(obj, changes) : obj;
  });
  await location.update({ "system.specialHires": entries });
  return entries.find((s) => s.id === specialHireId);
}

/**
 * Register a real actor as a special hire at a location. GM entries have no
 * time limit unless one is set; found recruits default to the end of the
 * current market month.
 */
export async function addSpecialHire(location, actor, { origin = "gm", expiresTime = null, notes = "" } = {}) {
  const { secondsPerMonth } = await import("../time.mjs");
  const anchor = location.system.monthAnchorTime || now();
  const defaultExpiry = origin === "found" ? anchor + secondsPerMonth() : 0;
  const entry = {
    id: foundry.utils.randomID(),
    actorUuid: actor.uuid,
    name: actor.name,
    img: actor.img,
    addedTime: now(),
    expiresTime: expiresTime ?? defaultExpiry,
    origin,
    status: "available",
    refusals: [],
    notes,
  };
  await location.update({
    "system.specialHires": [...(location.system.specialHires ?? []).map((s) => s.toObject?.() ?? s), entry],
  });
  return entry;
}

/**
 * Hire an EXISTING actor (special hire): characters wire through the core
 * roster; monsters through the monster path. The record notes the origin.
 */
export async function hireExistingActor(location, specialHireId, employer, opts = {}) {
  const entry = (location.system.specialHires ?? []).find((s) => s.id === specialHireId);
  if (!entry) return { error: "no-candidate" };
  if (entry.status !== "available") return { error: "not-available" };
  const actor = await fromUuid(entry.actorUuid);
  const target = actor?.actor ?? actor;
  if (!target) return { error: "no-candidate" };

  let result;
  if (target.type === "monster") {
    const { hireMonster } = await import("./monster.mjs");
    result = await hireMonster(target, employer, { ...opts });
  } else {
    const loyaltyStart = startingLoyalty({ base: opts.baseLoyalty ?? 0, elan: !!opts.elan });
    const wage = Number(target.system?.retainer?.wage) || henchmanWage(adapter.getWageLevel(target));
    await adapter.setRetainer(target, {
      enabled: true,
      loyalty: loyaltyStart,
      wage: String(wage),
      managerid: employer.id,
      category: opts.category ?? "henchman",
      quantity: 1,
    });
    try {
      await adapter.addHenchman(employer, target.id);
    } catch (err) {
      console.warn(`${MODULE_ID} | core addHenchman failed for special hire`, err);
    }
    const record = new HenchmanRecord({
      origin: entry.origin === "found" ? "adventure" : "manual",
      locationUuid: location.uuid,
      settlementName: location.name,
      employerUuid: employer.uuid,
      hiredTime: now(),
      terms: { wageGp: wage, wageBasis: "level", lastPaidTime: now(), signingBonusGp: opts.signingBonusGp ?? null },
      loyalty: { start: loyaltyStart, permanents: [] },
      morale: { base: adapter.getMorale(target) || 0, permanents: [] },
      counters: { calamities: 0, levelsGainedInService: 0, startLevel: adapter.getLevel(target) },
      special: { skipCalamityLoyalty: hasEffectFlag(employer, "skipCalamityLoyalty") },
    });
    await target.setFlag(MODULE_ID, FLAG_RECORD, record.toObject());
    await HenchmanRecord.logEvent(target, {
      type: "hired",
      note: game.i18n.format("ACKS-HENCHMEN.event.hiredNote", { employer: employer.name, location: location.name }),
    });
    await adapter.setLoyalty(
      target,
      effectiveLoyalty(record.toObject(), {
        chaLoyalty: adapter.getChaLoyalty(employer),
        baseLoyaltyBonus: sumEffectModifiers(employer, "baseLoyalty"),
      })
    );
    Hooks.callAll(HOOKS.HIRED, { employer, actor: target, location, record: record.toObject(), candidate: null });
    Hooks.callAll(HOOKS.ROSTER_CHANGED, { employer });
    result = { actor: target };
  }
  if (!result?.error) {
    await updateSpecialHire(location, specialHireId, { status: "hired" });
    if (opts.signingBonusGp > 0) {
      await adapter.spendGold(
        employer,
        opts.signingBonusGp,
        game.i18n.format("ACKS-HENCHMEN.hire.signingBonusReason", { name: entry.name })
      );
    }
  }
  return result;
}

/**
 * Henchman-limit check for an employer: 4 + CHA (core cha.retain) + effect
 * bonuses (Leadership, Blood of Kings…), against core henchmenList + our
 * monster roster, minus record.special.noSlot members (follower companions).
 * @returns {{count:number, max:number, ok:boolean}}
 */
export function checkHenchmanLimit(employer) {
  const max = adapter.getRetainMax(employer);
  const ids = [
    ...adapter.getHenchmenIds(employer),
    ...(employer.getFlag(MODULE_ID, "monsterHenchmenList") ?? []),
  ];
  let count = 0;
  for (const id of ids) {
    const actor = game.actors.get(id);
    if (!actor) continue;
    if (actor.system?.retainer?.category && actor.system.retainer.category !== "henchman") continue;
    const record = actor.getFlag(MODULE_ID, FLAG_RECORD);
    if (record?.special?.noSlot) continue;
    count += 1;
  }
  return { count, max, ok: count < max };
}

/**
 * Hire a candidate: create the hireling actor, wire it into the core roster,
 * write the HenchmanRecord, compute and store effective loyalty.
 *
 * @param {Actor} location
 * @param {string} candidateId
 * @param {Actor} employer
 * @param {object} [opts] - { elan, irrefusable, signingBonusGp, baseLoyalty,
 *                            category, origin, skipLimit }
 * @returns {Promise<{actor: Actor}|{error: string}>}
 */
export async function hire(location, candidateId, employer, opts = {}) {
  const candidate = getCandidate(location, candidateId);
  if (!candidate) return { error: "no-candidate" };
  if (!["available"].includes(candidate.status)) return { error: "not-available" };

  // Attributes roll ONCE, at hire (3d6 ×6 in order, RR 168) — class and
  // level were fixed when the monthly pool was rolled.
  if (candidate.attributes?.str == null) {
    candidate.attributes = await rollAttributes(roll);
    await updateCandidate(location, candidateId, { attributes: candidate.attributes });
  }

  const category = opts.category ?? (candidate.kind === "mercenary" ? "mercenary" : candidate.kind === "specialist" ? "specialist" : "henchman");

  // Limit enforcement (setting-gated) — only true henchmen consume slots.
  if (category === "henchman" && !opts.skipLimit) {
    const mode = game.settings.get(MODULE_ID, "enforceHenchmanLimit");
    const limit = checkHenchmanLimit(employer);
    if (!limit.ok && mode !== "off") {
      const msg = game.i18n.format("ACKS-HENCHMEN.hire.limitReached", {
        name: employer.name,
        count: limit.count,
        max: limit.max,
      });
      if (mode === "block") {
        ui.notifications.error(msg);
        return { error: "limit" };
      }
      ui.notifications.warn(msg);
    }
  }

  const loyaltyStart = startingLoyalty({
    base: opts.baseLoyalty ?? 0,
    elan: !!opts.elan,
    irrefusable: opts.irrefusable ?? null,
  });

  // 1. Create the hireling actor with retainer fields pre-set so every guard
  //    in core addHenchman passes (actor.mjs:236-272).
  const actorData = {
    name: candidate.name || game.i18n.localize("ACKS-HENCHMEN.candidate.unnamed"),
    type: "character",
    prototypeToken: { actorLink: true },
    system: {
      retainer: {
        enabled: true,
        loyalty: loyaltyStart,
        wage: String(candidate.wageGp ?? ""),
        managerid: employer.id,
        category,
        quantity: candidate.quantity ?? 1,
      },
      details: {
        level: candidate.level ?? 0,
        age: candidate.age ?? undefined,
        class: candidate.classKey || candidate.occupation || "",
      },
    },
  };
  if (candidate.attributes?.str != null) {
    actorData.system.scores = {
      str: { value: candidate.attributes.str },
      int: { value: candidate.attributes.int },
      wis: { value: candidate.attributes.wil },
      dex: { value: candidate.attributes.dex },
      con: { value: candidate.attributes.con },
      cha: { value: candidate.attributes.cha },
    };
  }
  const actor = await Actor.create(actorData);

  // 2. Core roster (reuse, not reimplement).
  try {
    await adapter.addHenchman(employer, actor.id);
  } catch (err) {
    console.warn(`${MODULE_ID} | core addHenchman failed; roster link incomplete`, err);
  }

  // 3. Module record.
  const record = new HenchmanRecord({
    origin: opts.origin ?? "market",
    locationUuid: location.uuid,
    settlementName: location.name,
    employerUuid: employer.uuid,
    hiredTime: now(),
    identity: {
      gender: candidate.gender ?? "",
      culture: candidate.culture ?? "",
      age: candidate.age ?? null,
      occupation: candidate.occupation ?? "",
      appearance: candidate.appearance ?? "",
    },
    rolled: {
      attributes: candidate.attributes ?? {},
      classKey: candidate.classKey ?? "",
      classRarity: candidate.classRarity ?? "",
      template: candidate.template ?? "",
      level: candidate.level ?? null,
      hpRoll: candidate.hpRoll ?? null,
      doubleD100: candidate.doubleD100 ?? [],
    },
    terms: {
      wageGp: candidate.wageGp ?? null,
      wageBasis: category === "mercenary" ? "mercenary" : category === "specialist" ? "specialist" : "level",
      signingBonusGp: opts.signingBonusGp ?? null,
      lastPaidTime: now(),
    },
    loyalty: { start: loyaltyStart, permanents: [] },
    morale: { base: opts.baseMorale ?? 0, permanents: [] },
    counters: { calamities: 0, levelsGainedInService: 0, startLevel: candidate.level ?? 0 },
    special: {
      skipCalamityLoyalty: hasEffectFlag(employer, "skipCalamityLoyalty"),
      noSlot: !!opts.noSlot,
      irrefusableResult: opts.irrefusableOutcome ?? "",
    },
  });
  await actor.setFlag(MODULE_ID, FLAG_RECORD, record.toObject());
  await HenchmanRecord.logEvent(actor, {
    type: "hired",
    note: game.i18n.format("ACKS-HENCHMEN.event.hiredNote", { employer: employer.name, location: location.name }),
  });

  // 4. Effective loyalty (employer CHA + baseLoyalty effects) → core field so
  //    the system's own loyalty roll button shows the right score.
  const employerMods = {
    chaLoyalty: adapter.getChaLoyalty(employer),
    baseLoyaltyBonus: sumEffectModifiers(employer, "baseLoyalty"),
  };
  await adapter.setLoyalty(actor, effectiveLoyalty(record.toObject(), employerMods));

  // 5. Mark the candidate hired and pay the signing bonus if any.
  await updateCandidate(location, candidateId, { status: "hired" });
  if (opts.signingBonusGp > 0) {
    await adapter.spendGold(
      employer,
      opts.signingBonusGp,
      game.i18n.format("ACKS-HENCHMEN.hire.signingBonusReason", { name: actor.name })
    );
  }

  Hooks.callAll(HOOKS.HIRED, { employer, actor, location, record: record.toObject(), candidate });
  Hooks.callAll(HOOKS.ROSTER_CHANGED, { employer });
  ChatMessage.create({
    content: game.i18n.format("ACKS-HENCHMEN.hire.hiredChat", {
      name: actor.name,
      employer: employer.name,
      wage: candidate.wageGp ?? "?",
    }),
    speaker: ChatMessage.getSpeaker({ actor: employer }),
  });
  return { actor };
}
