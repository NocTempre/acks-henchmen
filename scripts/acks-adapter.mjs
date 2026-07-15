/* global game, ui, ChatMessage */
/**
 * THE ONLY file that reads or writes the acks system's actor schema
 * (acks-domains adapter pattern). Everything degrades gracefully: a missing
 * field returns 0/null rather than throwing, so a system update breaks only
 * this file.
 *
 * Sanctioned writes: coin items (spendGold/grantGold), `system.retainer.*`
 * fields, and roster changes through the system's own addHenchman/delHenchman.
 */
import { MODULE_ID, FLAG_RETAIN_BONUS } from "./constants.mjs";
import { sumEffectModifiers } from "./effects.mjs";

/* ------------------------------ reads ------------------------------ */

export function getChaMod(actor) {
  return Number(actor?.system?.scores?.cha?.mod ?? 0);
}

/** Core derives cha.loyalty = cha.mod (actor.mjs:1027) but never uses it. */
export function getChaLoyalty(actor) {
  return Number(actor?.system?.scores?.cha?.loyalty ?? getChaMod(actor));
}

/** Core derives cha.retain = cha.mod + 4 (the ACKS 4+CHA henchman cap). */
export function getRetainBase(actor) {
  const retain = Number(actor?.system?.scores?.cha?.retain);
  return Number.isFinite(retain) && retain !== 0 ? retain : 4 + getChaMod(actor);
}

/** Max henchmen = 4 + CHA + effect bonuses (Leadership etc.) + manual flag. */
export function getRetainMax(actor) {
  const manual = Number(actor?.getFlag?.(MODULE_ID, FLAG_RETAIN_BONUS) ?? 0);
  return getRetainBase(actor) + sumEffectModifiers(actor, "retainBonus") + (Number.isFinite(manual) ? manual : 0);
}

export function getLevel(actor) {
  return Number(actor?.system?.details?.level ?? 0);
}

export function getMorale(actor) {
  return Number(actor?.system?.details?.morale ?? 0);
}

export function getAlignment(actor) {
  return actor?.system?.details?.alignment ?? "";
}

export function getRetainer(actor) {
  const r = actor?.system?.retainer ?? {};
  return {
    enabled: !!r.enabled,
    loyalty: Number(r.loyalty ?? 0),
    wage: Number(r.wage ?? 0) || 0, // core stores wage as a String
    managerid: r.managerid ?? "",
    category: r.category ?? "henchman",
    quantity: Number(r.quantity ?? 1),
  };
}

export function isRetainer(actor) {
  return !!actor?.system?.retainer?.enabled;
}

export function getManager(actor) {
  const id = actor?.system?.retainer?.managerid;
  return id ? game.actors.get(id) : null;
}

/** Actor ids in the employer's core henchmen list. */
export function getHenchmenIds(actor) {
  return Array.isArray(actor?.system?.henchmenList) ? [...actor.system.henchmenList] : [];
}

/** Parse a monster's HD rating from `system.hp.hd` (e.g. "3d8+1" → 3). */
export function getMonsterHd(actor) {
  const hd = actor?.system?.hp?.hd;
  if (typeof hd === "number") return hd;
  const m = String(hd ?? "").match(/^\s*(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

/**
 * "Level" for wage purposes: class level for characters, HD for monsters
 * (MM 351 — substitute Hit Dice for level). acks-monsters extras win when
 * present (integrations/monsters.mjs passes them through here).
 */
export function getWageLevel(actor) {
  if (actor?.type === "monster") {
    const extras = game.modules.get("acks-monsters")?.api?.getExtras?.(actor);
    const hd = Number(extras?.hd?.count);
    return Number.isFinite(hd) && hd > 0 ? hd : getMonsterHd(actor);
  }
  return getLevel(actor);
}

/* ------------------------------ coins ------------------------------ */

/** Total funds in gp (carried + banked; coppervalue × quantity is copper). */
export function getGold(actor) {
  let copper = 0;
  for (const item of actor?.items ?? []) {
    if (item.type !== "money") continue;
    const cv = Number(item.system?.coppervalue ?? 0);
    copper += cv * (Number(item.system?.quantity ?? 0) + Number(item.system?.quantitybank ?? 0));
  }
  return copper / 100;
}

/**
 * Spend gp from an actor's coin items, largest denominations first, carried
 * before banked. Returns false (and warns) when funds are insufficient.
 * @param {Actor} actor
 * @param {number} gp
 * @param {string} reason - for the chat receipt
 * @param {object} [opts]
 * @param {boolean} [opts.chat=true] - post a receipt to chat
 */
export async function spendGold(actor, gp, reason, { chat = true } = {}) {
  let need = Math.round(gp * 100);
  if (need <= 0) return true;
  if (getGold(actor) * 100 + 0.5 < need) {
    ui?.notifications?.warn(
      game.i18n.format("ACKS-HENCHMEN.gold.insufficient", { name: actor.name, gp: gp.toFixed(0), reason })
    );
    return false;
  }
  const slots = [];
  for (const item of actor.items) {
    if (item.type !== "money") continue;
    slots.push({ item, field: "quantity", cv: Number(item.system.coppervalue ?? 0), qty: Number(item.system.quantity ?? 0) });
    slots.push({ item, field: "quantitybank", cv: Number(item.system.coppervalue ?? 0), qty: Number(item.system.quantitybank ?? 0) });
  }
  slots.sort((a, b) => b.cv - a.cv || (a.field === "quantity" ? -1 : 1));
  const updates = new Map();
  for (const slot of slots) {
    if (need <= 0) break;
    if (slot.cv <= 0 || slot.qty <= 0) continue;
    const take = Math.min(slot.qty, Math.ceil(need / slot.cv));
    need -= take * slot.cv;
    const u = updates.get(slot.item.id) ?? { _id: slot.item.id };
    u[`system.${slot.field}`] = slot.qty - take;
    updates.set(slot.item.id, u);
  }
  // Over-payment in small coin: credit change back on the smallest spent slot.
  if (need < 0) {
    const smallest = slots.filter((s) => updates.has(s.item.id)).sort((a, b) => a.cv - b.cv)[0];
    if (smallest && smallest.cv > 0) {
      const back = Math.floor(-need / smallest.cv);
      if (back > 0) {
        const u = updates.get(smallest.item.id);
        const key = `system.${smallest.field}`;
        u[key] = (u[key] ?? smallest.qty) + back;
      }
    }
  }
  await actor.updateEmbeddedDocuments("Item", [...updates.values()]);
  if (chat) {
    ChatMessage.create({
      content: game.i18n.format("ACKS-HENCHMEN.gold.spent", { name: actor.name, gp: gp.toFixed(0), reason }),
      speaker: ChatMessage.getSpeaker({ actor }),
      whisper: gmIds(),
    });
  }
  return true;
}

/** Credit gp onto the gp denomination (coppervalue 100), else the largest. */
export async function grantGold(actor, gp) {
  const copper = Math.round(gp * 100);
  if (copper <= 0) return 0;
  const coins = actor.items.filter((i) => i.type === "money");
  const target =
    coins.find((c) => Number(c.system.coppervalue) === 100) ??
    coins.sort((a, b) => Number(b.system.coppervalue) - Number(a.system.coppervalue))[0];
  if (!target) {
    ui?.notifications?.warn(game.i18n.format("ACKS-HENCHMEN.gold.noCoins", { name: actor.name }));
    return 0;
  }
  const add = Math.floor(copper / Number(target.system.coppervalue));
  await target.update({ "system.quantity": Number(target.system.quantity ?? 0) + add });
  return (add * Number(target.system.coppervalue)) / 100;
}

/* ------------------------------ writes ------------------------------ */

/** Set retainer fields on a hireling actor (sanctioned core write). */
export async function setRetainer(actor, fields) {
  const update = {};
  for (const [k, v] of Object.entries(fields)) update[`system.retainer.${k}`] = v;
  return actor.update(update);
}

/** Write the effective loyalty score so core's own loyalty button agrees. */
export async function setLoyalty(actor, loyalty) {
  return actor.update({ "system.retainer.loyalty": Math.max(-4, Math.min(4, Math.round(loyalty))) });
}

/** Roster changes go through the system's own methods (character hirelings). */
export async function addHenchman(employer, hirelingId) {
  if (typeof employer?.addHenchman === "function") return employer.addHenchman(hirelingId);
  throw new Error(`${MODULE_ID}: employer.addHenchman missing — incompatible acks version?`);
}

export async function delHenchman(employer, hirelingId) {
  if (typeof employer?.delHenchman === "function") return employer.delHenchman(hirelingId);
  throw new Error(`${MODULE_ID}: employer.delHenchman missing — incompatible acks version?`);
}

/* ------------------------------ misc ------------------------------ */

export function gmIds() {
  return game.users.filter((u) => u.isGM).map((u) => u.id);
}

export function firstActiveGm() {
  return game.users.activeGM ?? game.users.find((u) => u.isGM && u.active) ?? null;
}
