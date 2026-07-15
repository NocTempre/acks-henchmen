/* global game, ui, foundry, Roll, Hooks, ChatMessage, Actor */
/**
 * Candidate rolling (feature 4 — record the results, generation is a future
 * module) and the hire pipeline.
 */
import { MODULE_ID, HOOKS, FLAG_RECORD } from "../constants.mjs";
import { getTable } from "../rules/tables.mjs";
import { henchmanWage } from "../rules/wages.mjs";
import { startingLoyalty, effectiveLoyalty } from "../rules/loyalty.mjs";
import { sumEffectModifiers, hasEffectFlag } from "../effects.mjs";
import * as adapter from "../acks-adapter.mjs";
import HenchmanRecord from "../data/henchman-record.mjs";
import { now } from "../time.mjs";
import { postEventCard } from "../chat/cards.mjs";

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

/** 3d6 in order, six times (RR: henchmen are rolled up like PCs). */
export async function rollCandidateStats(location, candidateId) {
  const keys = ["str", "int", "wil", "dex", "con", "cha"];
  const attributes = {};
  for (const key of keys) attributes[key] = await roll("3d6");
  const candidate = await updateCandidate(location, candidateId, { attributes });
  await postEventCard({
    titleKey: "ACKS-HENCHMEN.card.statsRolled",
    bodyKey: "ACKS-HENCHMEN.card.statsRolledBody",
    data: {
      name: candidate?.name ?? "?",
      stats: keys.map((k) => `${k.toUpperCase()} ${attributes[k]}`).join(", "),
    },
    actor: location,
  });
  Hooks.callAll(HOOKS.CANDIDATE_ROLLED, { location, candidateId, kind: "stats", attributes });
  return attributes;
}

/**
 * Random class via the JJ GM-screen double-d100 grid: first d100 picks the
 * row band, second picks the column band. "special" → Judge picks from
 * AXIOMS/BTA/HFH/Player's Companion.
 */
export async function rollCandidateClass(location, candidateId) {
  const grid = getTable("rarity", "leveledClassGrid");
  const rowRoll = await roll("1d100");
  const colRoll = await roll("1d100");
  const row = grid.rows.find((r) => rowRoll >= r.min && rowRoll <= r.max);
  const colIndex = grid.columns.findIndex((c) => colRoll >= c.min && colRoll <= c.max);
  const classKey = row?.classes?.[colIndex] ?? "special";
  const candidate = await updateCandidate(location, candidateId, {
    classKey,
    doubleD100: [rowRoll, colRoll],
  });
  await postEventCard({
    titleKey: "ACKS-HENCHMEN.card.classRolled",
    bodyKey: "ACKS-HENCHMEN.card.classRolledBody",
    data: { name: candidate?.name ?? "?", rowRoll, colRoll, classKey },
    actor: location,
  });
  Hooks.callAll(HOOKS.CANDIDATE_ROLLED, { location, candidateId, kind: "class", classKey, rolls: [rowRoll, colRoll] });
  return classKey;
}

/** Random level (JJ): 1d20, −2 in a Class VI market. */
export async function rollCandidateLevel(location, candidateId) {
  const table = getTable("rarity", "randomHenchmanLevel");
  const penalty = location.system.marketClass === 6 ? table.classVIPenalty : 0;
  const die = await roll("1d20");
  const total = die + penalty;
  const row = table.rows.find(
    (r) => (r.min === undefined || total >= r.min) && (r.max === undefined || total <= r.max)
  ) ?? table.rows[0];
  const level = row.level;
  const candidate = await updateCandidate(location, candidateId, { level, wageGp: henchmanWage(level) });
  await postEventCard({
    titleKey: "ACKS-HENCHMEN.card.levelRolled",
    bodyKey: "ACKS-HENCHMEN.card.levelRolledBody",
    data: { name: candidate?.name ?? "?", die, penalty, level },
    actor: location,
  });
  Hooks.callAll(HOOKS.CANDIDATE_ROLLED, { location, candidateId, kind: "level", level });
  return level;
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
      details: { level: candidate.level ?? 0 },
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
