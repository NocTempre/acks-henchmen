/* global game, ui, foundry, Hooks, ChatMessage */
/**
 * Loyalty & morale automation (RR 166-167).
 *
 * GM-prompt-first with secret rolls: watchers on the GM client detect
 * calamities (hp crossing ≤0 on a managed hireling) and level gains, then
 * whisper the GM an event card with [Roll Loyalty (secret)] / [Waive]
 * buttons. The `autoRollCalamity` setting collapses prompt→roll. All
 * bookkeeping lands in the HenchmanRecord ledgers; the resulting EFFECTIVE
 * loyalty (base + permanents + employer CHA + employer effects) is written
 * back to core `system.retainer.loyalty` so the system's own button agrees.
 *
 * Wages: every `daysPerMonth` of worldTime per hireling, a per-employer
 * whisper offers [Pay] / [Mark missed]; missed wages are calamities (RR 166).
 */
import { MODULE_ID, HOOKS, FLAG_RECORD } from "../constants.mjs";
import HenchmanRecord from "../data/henchman-record.mjs";
import { effectiveLoyalty, effectiveMorale, loyaltyDeltaForOutcome, outcomeLeavesService, clampScore } from "../rules/loyalty.mjs";
import { henchmanWage } from "../rules/wages.mjs";
import { collectEffectModifiers, sumEffectModifiers, toDialogModifiers, hasEffectFlag } from "../effects.mjs";
import * as adapter from "../acks-adapter.mjs";
import { openThrowDialog } from "../apps/throw-dialog.mjs";
import { postEventCard, registerCardAction, postRevealCard } from "../chat/cards.mjs";
import { getSetting } from "../settings.mjs";
import { now, secondsPerMonth, onTimeAdvanced } from "../time.mjs";

/* ------------------------- effective scores ------------------------- */

/** Employer-derived pieces of a hireling's loyalty. */
export function employerLoyaltyMods(employer) {
  if (!employer) return { chaLoyalty: 0, baseLoyaltyBonus: 0 };
  return {
    chaLoyalty: adapter.getChaLoyalty(employer),
    baseLoyaltyBonus: sumEffectModifiers(employer, "baseLoyalty"),
  };
}

/** Effective loyalty of a hireling actor (record + employer). */
export function effectiveLoyaltyFor(actor) {
  const record = actor.getFlag(MODULE_ID, FLAG_RECORD) ?? {};
  const employer = adapter.getManager(actor);
  return effectiveLoyalty(record, employerLoyaltyMods(employer));
}

/** Effective morale (record base+permanents, falling back to core morale). */
export function effectiveMoraleFor(actor) {
  const record = actor.getFlag(MODULE_ID, FLAG_RECORD) ?? {};
  const base = sumEffectModifiers(adapter.getManager(actor), "moraleBase");
  return clampScore(effectiveMorale(record, adapter.getMorale(actor)) + base);
}

/** Recompute and persist core retainer.loyalty from the record. */
export async function syncLoyalty(actor) {
  await adapter.setLoyalty(actor, effectiveLoyaltyFor(actor));
}

/** Append a permanent loyalty ledger entry and resync. */
export async function addLoyaltyPermanent(actor, delta, reason, note = "") {
  const record = actor.getFlag(MODULE_ID, FLAG_RECORD) ?? {};
  const permanents = [...(record.loyalty?.permanents ?? []), { time: now(), delta, reason, note, compensated: false }];
  await actor.setFlag(MODULE_ID, FLAG_RECORD, {
    ...record,
    loyalty: { ...(record.loyalty ?? { start: 0 }), permanents },
  });
  await syncLoyalty(actor);
  Hooks.callAll(HOOKS.LOYALTY_EVENT, { actor, delta, reason, note });
}

/* ------------------------- loyalty / obedience rolls ------------------------- */

/**
 * Apply a resolved Hireling Loyalty outcome: event log, permanent ±1
 * bookkeeping (Grudging/Fanatic), a departure card when the hireling
 * leaves service, and the LOYALTY_ROLLED hook. Shared by the module's
 * ThrowDialog and the influence-hosted loyalty page.
 */
export async function applyLoyaltyOutcome(actor, { outcome, total = null, note = "" } = {}) {
  const employer = adapter.getManager(actor);
  await HenchmanRecord.logEvent(actor, {
    type: "loyaltyRoll",
    note,
    rollTotal: total,
    outcome,
  });
  const delta = loyaltyDeltaForOutcome(outcome);
  if (delta !== 0) {
    await addLoyaltyPermanent(actor, delta, outcome === "fanatic" ? "fanatic" : "grudging");
  }
  if (outcomeLeavesService(outcome)) {
    await postEventCard({
      titleKey: "ACKS-HENCHMEN.card.leavesService",
      bodyKey: `ACKS-HENCHMEN.outcomeHint.${outcome}`,
      data: { name: actor.name },
      buttons: [
        { action: "dismissHireling", label: "ACKS-HENCHMEN.card.dismiss", icon: "fas fa-door-open", payload: { actorUuid: actor.uuid, outcome } },
      ],
      actor,
    });
  }
  Hooks.callAll(HOOKS.LOYALTY_ROLLED, { actor, employer, result: { outcome, total } });
}

/**
 * Open the secret Hireling Loyalty roll for a hireling — as an influence-
 * hosted page when acks-influence hosts the modes (consistent UI, tones
 * hidden), else the module's own ThrowDialog. Outcome bookkeeping applies
 * automatically either way.
 * @param {Actor} actor - the hireling
 * @param {object} [opts] - { reason, title }
 */
export function openLoyaltyRoll(actor, opts = {}) {
  const employer = adapter.getManager(actor);

  // RR 168 presented-level lie: once the hireling has cause to doubt, the
  // roll takes −1 per level of difference between what was CLAIMED at hire
  // and the truth — auto-applied, GM-overridable like every derived value.
  const record = actor.getFlag(MODULE_ID, FLAG_RECORD) ?? {};
  const claimed = record.terms?.claimedEmployerLevel;
  const apparentLevelDiff =
    claimed != null && employer ? Math.max(0, claimed - adapter.getLevel(employer)) : 0;

  // Influence-hosted page (loyalty is secret: open GM-side; the completion
  // hook routes back through applyLoyaltyOutcome via the integration).
  try {
    // Late import avoids a load-order cycle (integration imports this file).
    const integration = globalThis.acksHenchmen?.integrations?.influence;
    if (integration?.hostsModes?.()) {
      integration.openLoyaltyViaInfluence({
        employer,
        hireling: actor,
        effectiveLoyalty: effectiveLoyaltyFor(actor),
        apparentLevelDiff,
        context: { actorUuid: actor.uuid, reason: opts.reason ?? "" },
      });
      return;
    }
  } catch (err) {
    console.warn("acks-henchmen | influence-hosted loyalty open failed; falling back", err);
  }

  const dynamicModifiers = employer ? toDialogModifiers(collectEffectModifiers(employer, "loyaltyRoll")) : [];
  openThrowDialog("hirelingLoyalty", {
    title: opts.title ?? `${actor.name}${opts.reason ? ` (${opts.reason})` : ""}`,
    actor,
    derived: { effectiveLoyalty: effectiveLoyaltyFor(actor), apparentLevelDiff },
    dynamicModifiers,
    onResolve: (result) => applyLoyaltyOutcome(actor, { outcome: result.outcome, total: result.total, note: opts.reason ?? "" }),
  });
}

/** Open the secret Hireling Obedience throw (RR 167). */
export function openObedienceRoll(actor, opts = {}) {
  const employer = adapter.getManager(actor);

  // Influence-hosted page when available (apiVersion 6+), same as loyalty.
  try {
    const integration = globalThis.acksHenchmen?.integrations?.influence;
    if (integration?.hostsMoraleModes?.()) {
      integration.openObedienceViaInfluence({
        employer,
        hireling: actor,
        effectiveMorale: effectiveMoraleFor(actor),
        context: { actorUuid: actor.uuid, reason: opts.reason ?? "" },
      });
      return;
    }
  } catch (err) {
    console.warn("acks-henchmen | influence-hosted obedience open failed; falling back", err);
  }

  const dynamicModifiers = employer ? toDialogModifiers(collectEffectModifiers(employer, "obedienceRoll")) : [];
  // The employer's morale-modifier effects (Command, Battlefield Prowess…)
  // condition on presence/leadership — offered as toggles on the roll.
  if (employer) dynamicModifiers.push(...toDialogModifiers(collectEffectModifiers(employer, "henchmanMorale")));
  openThrowDialog("hirelingObedience", {
    title: opts.title ?? actor.name,
    actor,
    derived: { moraleScore: effectiveMoraleFor(actor) },
    dynamicModifiers,
    onResolve: (result) =>
      applyObedienceOutcome(actor, { outcome: result.outcome, total: result.total, note: opts.reason ?? "" }),
  });
}

/**
 * Apply an obedience result — log it, and on a refusal offer the "insist"
 * card (RR 167: insisting costs 1 permanent loyalty and forces a reroll).
 *
 * Shared by the module's own ThrowDialog and the influence-hosted page, so the
 * consequences do not depend on which UI produced the roll.
 */
export async function applyObedienceOutcome(actor, { outcome, total, note = "" } = {}) {
  await HenchmanRecord.logEvent(actor, { type: "obedienceRoll", note, rollTotal: total, outcome });
  if (outcome !== "refuses") return;
  await postEventCard({
    titleKey: "ACKS-HENCHMEN.card.refusesTitle",
    bodyKey: "ACKS-HENCHMEN.card.refusesBody",
    data: { name: actor.name },
    buttons: [
      { action: "insistOrder", label: "ACKS-HENCHMEN.card.insist", icon: "fas fa-gavel", payload: { actorUuid: actor.uuid } },
    ],
    actor,
  });
}

/* ------------------------- calamities ------------------------- */

/**
 * Record a calamity: counter +1, permanent −1 loyalty, event log; then a
 * loyalty roll (prompt or auto) unless the record skips calamity rolls
 * (crusader/bladedancer followers, Utter Domination).
 */
export async function recordCalamity(actor, note = "") {
  const record = actor.getFlag(MODULE_ID, FLAG_RECORD) ?? {};
  const counters = { ...(record.counters ?? {}), calamities: (record.counters?.calamities ?? 0) + 1 };
  await actor.setFlag(MODULE_ID, FLAG_RECORD, { ...record, counters });
  await HenchmanRecord.logEvent(actor, { type: "calamity", note });
  await addLoyaltyPermanent(actor, -1, "calamity", note);
  Hooks.callAll(HOOKS.CALAMITY, { actor, note });

  const skip = record.special?.skipCalamityLoyalty || hasEffectFlag(adapter.getManager(actor) ?? actor, "skipCalamityLoyalty");
  if (skip) {
    await postEventCard({
      titleKey: "ACKS-HENCHMEN.card.calamitySkip",
      data: { name: actor.name, note },
      actor,
    });
    return;
  }
  if (getSetting("autoRollCalamity")) {
    openLoyaltyRoll(actor, { reason: note || game.i18n.localize("ACKS-HENCHMEN.event.calamity") });
  } else {
    await postEventCard({
      titleKey: "ACKS-HENCHMEN.card.calamityTitle",
      bodyKey: "ACKS-HENCHMEN.card.calamityBody",
      data: { name: actor.name, note },
      buttons: [
        { action: "rollLoyaltySecret", label: "ACKS-HENCHMEN.card.rollLoyalty", icon: "fas fa-user-secret", payload: { actorUuid: actor.uuid, reason: note } },
        { action: "waiveCalamityRoll", label: "ACKS-HENCHMEN.card.waive", icon: "fas fa-hand", payload: { actorUuid: actor.uuid } },
      ],
      actor,
    });
  }
}

/* ------------------------- wages ------------------------- */

/**
 * Managed hirelings of one employer whose wage month has elapsed. RAW: the
 * FULL monthly wage (RR 168), × retainer quantity for troop-scale entries,
 * × every whole month elapsed since the last payday — no weekly division
 * anywhere in wage payment.
 */
function dueHirelings(employer, currentTime) {
  const due = [];
  const ids = [...adapter.getHenchmenIds(employer), ...(employer.getFlag(MODULE_ID, "monsterHenchmenList") ?? [])];
  for (const id of ids) {
    const actor = game.actors.get(id);
    if (!actor || !adapter.isRetainer(actor)) continue;
    const record = actor.getFlag(MODULE_ID, FLAG_RECORD) ?? {};
    if (record.terms?.vassalDomain) continue; // domain income covers the wage
    const last = record.terms?.lastPaidTime ?? record.hiredTime ?? 0;
    const months = Math.floor((currentTime - last) / secondsPerMonth());
    if (months >= 1) {
      const retainer = adapter.getRetainer(actor);
      const monthly =
        (Number(record.terms?.wageGp ?? retainer.wage) || henchmanWage(adapter.getWageLevel(actor))) *
        Math.max(1, retainer.quantity);
      due.push({ actor, record, months, monthly, amount: monthly * months, paidThrough: last + months * secondsPerMonth() });
    }
  }
  return due;
}

/**
 * Pay all due wages for one employer: gold LEAVES the employer and LANDS on
 * each hireling — into their bank unless the `wagesToBank` setting is off.
 */
export async function payWagesFor(employer, { markMissed = false } = {}) {
  const currentTime = now();
  const due = dueHirelings(employer, currentTime);
  if (!due.length) {
    ui.notifications.info(game.i18n.format("ACKS-HENCHMEN.wage.nothingDue", { name: employer.name }));
    return;
  }
  const total = due.reduce((s, d) => s + d.amount, 0);
  if (!markMissed) {
    const paid = await adapter.spendGold(employer, total, game.i18n.format("ACKS-HENCHMEN.wage.reason", { count: due.length }));
    if (!paid) markMissed = true; // insufficient funds → wages missed
  }
  const toBank = getSetting("wagesToBank");
  for (const { actor, record, amount, paidThrough } of due) {
    if (markMissed) {
      await actor.setFlag(MODULE_ID, FLAG_RECORD, {
        ...record,
        terms: { ...(record.terms ?? {}), lastPaidTime: paidThrough, arrearsGp: (record.terms?.arrearsGp ?? 0) + amount },
      });
      await HenchmanRecord.logEvent(actor, { type: "wageMissed", note: `${amount} gp` });
      await recordCalamity(actor, game.i18n.localize("ACKS-HENCHMEN.wage.missedCalamity"));
    } else {
      // The transfer: credit the hireling (bank by default).
      await adapter.grantGold(actor, amount, { toBank });
      await actor.setFlag(MODULE_ID, FLAG_RECORD, {
        ...record,
        terms: { ...(record.terms ?? {}), lastPaidTime: paidThrough },
      });
      await HenchmanRecord.logEvent(actor, {
        type: "wagePaid",
        note: game.i18n.format(toBank ? "ACKS-HENCHMEN.wage.paidBank" : "ACKS-HENCHMEN.wage.paidHand", { gp: amount }),
      });
    }
  }
  Hooks.callAll(markMissed ? HOOKS.WAGES_MISSED : HOOKS.WAGES_PAID, { employer, total, count: due.length });
}

/** Whisper per-employer wages-due cards (time watcher). */
async function checkWagesDue(currentTime) {
  if (!getSetting("wageReminders")) return;
  const employers = game.actors.filter(
    (a) => a.type === "character" && !a.system?.retainer?.enabled && (a.system?.henchmenList?.length || (a.getFlag(MODULE_ID, "monsterHenchmenList") ?? []).length)
  );
  for (const employer of employers) {
    const due = dueHirelings(employer, currentTime);
    if (!due.length) continue;
    const total = due.reduce((s, d) => s + d.wage, 0);
    await postEventCard({
      titleKey: "ACKS-HENCHMEN.wage.dueTitle",
      bodyKey: "ACKS-HENCHMEN.wage.dueBody",
      data: { name: employer.name, count: due.length, total },
      buttons: [
        { action: "payWages", label: "ACKS-HENCHMEN.wage.pay", icon: "fas fa-coins", payload: { employerUuid: employer.uuid } },
        { action: "missWages", label: "ACKS-HENCHMEN.wage.markMissed", icon: "fas fa-ban", payload: { employerUuid: employer.uuid } },
      ],
      actor: employer,
    });
    // One reminder per month: bump lastPaidTime forward is wrong; instead we
    // rely on the GM acting on the card. A repeat reminder only fires after
    // another full month elapses because lastPaidTime is only set on action.
  }
}

/* ------------------------- watchers ------------------------- */

function isManagedHireling(actor) {
  return actor?.type !== undefined && adapter.isRetainer(actor) && !!adapter.getManager(actor);
}

async function onUpdateActor(actor, changes) {
  if (game.user !== game.users.activeGM) return;
  if (!isManagedHireling(actor)) return;

  // --- Calamity: hp crossing to ≤ 0 (guarded against healing yo-yos) ---
  const newHp = foundry.utils.getProperty(changes, "system.hp.value");
  if (newHp !== undefined) {
    const record = actor.getFlag(MODULE_ID, FLAG_RECORD) ?? {};
    const pending = record.special?.pendingCalamity ?? false;
    if (newHp <= 0 && !pending) {
      await actor.setFlag(MODULE_ID, FLAG_RECORD, {
        ...record,
        special: { ...(record.special ?? {}), pendingCalamity: true },
      });
      await recordCalamity(actor, game.i18n.localize("ACKS-HENCHMEN.card.downedNote"));
    } else if (newHp > 0 && pending) {
      await actor.setFlag(MODULE_ID, FLAG_RECORD, {
        ...record,
        special: { ...(record.special ?? {}), pendingCalamity: false },
      });
    }
  }

  // --- Level gain: +1 permanent loyalty and a loyalty roll (RR 166) ---
  const newLevel = foundry.utils.getProperty(changes, "system.details.level");
  if (newLevel !== undefined) {
    const record = actor.getFlag(MODULE_ID, FLAG_RECORD) ?? {};
    const startLevel = record.counters?.startLevel ?? 0;
    const known = startLevel + (record.counters?.levelsGainedInService ?? 0);
    if (newLevel > known) {
      const counters = {
        ...(record.counters ?? {}),
        levelsGainedInService: (record.counters?.levelsGainedInService ?? 0) + (newLevel - known),
      };
      let morale = record.morale ?? { base: 0, permanents: [] };
      // Permanent morale bumps: 0th → first level, and reaching 5th (RR 166).
      const bumps = [];
      if (known === 0 && newLevel >= 1) bumps.push({ time: now(), delta: 1, reason: "firstLevel", note: "", compensated: false });
      if (known < 5 && newLevel >= 5) bumps.push({ time: now(), delta: 1, reason: "fifthLevel", note: "", compensated: false });
      if (bumps.length) morale = { ...morale, permanents: [...(morale.permanents ?? []), ...bumps] };
      await actor.setFlag(MODULE_ID, FLAG_RECORD, { ...record, counters, morale });
      await addLoyaltyPermanent(actor, newLevel - known, "levelGain");
      await postEventCard({
        titleKey: "ACKS-HENCHMEN.card.levelGainTitle",
        bodyKey: "ACKS-HENCHMEN.card.levelGainBody",
        data: { name: actor.name, level: newLevel },
        buttons: [
          { action: "rollLoyaltySecret", label: "ACKS-HENCHMEN.card.rollLoyalty", icon: "fas fa-user-secret", payload: { actorUuid: actor.uuid, reason: game.i18n.localize("ACKS-HENCHMEN.loyaltyReason.levelGain") } },
        ],
        actor,
      });
    }
  }
}

/* ------------------------- registration ------------------------- */

export function registerEventEngine() {
  Hooks.on("updateActor", (actor, changes) => {
    onUpdateActor(actor, changes).catch((err) => console.error(`${MODULE_ID} | event watcher failed`, err));
  });
  onTimeAdvanced((worldTime) => checkWagesDue(worldTime));

  registerCardAction("rollLoyaltySecret", async ({ actorUuid, reason }) => {
    const actor = await fromUuid(actorUuid);
    if (actor) openLoyaltyRoll(actor, { reason });
  });
  registerCardAction("waiveCalamityRoll", async ({ actorUuid }) => {
    const actor = await fromUuid(actorUuid);
    if (actor) await HenchmanRecord.logEvent(actor, { type: "adjustment", note: game.i18n.localize("ACKS-HENCHMEN.card.waived") });
  });
  registerCardAction("insistOrder", async ({ actorUuid }) => {
    const actor = await fromUuid(actorUuid);
    if (!actor) return;
    await addLoyaltyPermanent(actor, -1, "insistence");
    openObedienceRoll(actor, { reason: game.i18n.localize("ACKS-HENCHMEN.card.insisted") });
  });
  registerCardAction("payWages", async ({ employerUuid }) => {
    const employer = await fromUuid(employerUuid);
    if (employer) await payWagesFor(employer);
  });
  registerCardAction("missWages", async ({ employerUuid }) => {
    const employer = await fromUuid(employerUuid);
    if (employer) await payWagesFor(employer, { markMissed: true });
  });
  registerCardAction("dismissHireling", async ({ actorUuid, outcome }) => {
    const actor = await fromUuid(actorUuid);
    if (!actor) return;
    const employer = adapter.getManager(actor);
    await HenchmanRecord.logEvent(actor, { type: "dismissed", note: outcome ?? "" });
    if (employer) {
      try {
        await adapter.delHenchman(employer, actor.id);
      } catch (err) {
        console.warn(`${MODULE_ID} | delHenchman failed`, err);
      }
      Hooks.callAll(HOOKS.ROSTER_CHANGED, { employer });
    }
  });
}
