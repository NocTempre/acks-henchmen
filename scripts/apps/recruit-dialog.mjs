/* global game, ui, foundry, ChatMessage, Hooks */
/**
 * Recruit flow — opens the Reaction to Hiring Offer throw (RR 162) for one
 * candidate, with every modifier explained:
 *   - employer CHA (auto, derived)
 *   - effect-driven bonuses from proficiency/power Items (Diplomacy,
 *     Intimidation, Mystic Aura, Seduction, Bribery…) via effects.mjs —
 *     situational ones arrive as toggles
 *   - signing bonus tiers priced from the candidate's wage (Bribery
 *     proficiency changes the price scale, RR 162 + GM screen)
 *   - cumulative −1 per previous refusal by this party (auto)
 *   - −1 per refuse-and-slander entry in this town (auto)
 * Outcome handling: accept/élan → hire; try again → logged (sweeten the deal
 * and re-open); refuse → logged; refuse & slander → slander registry + the
 * candidate is permanently off-limits to the party.
 */
import { HOOKS } from "../constants.mjs";
import { openThrowDialog } from "./throw-dialog.mjs";
import { collectEffectModifiers, toDialogModifiers } from "../effects.mjs";
import { signingBonusCost } from "../rules/wages.mjs";
import { hire, updateCandidate } from "../engine/hire.mjs";
import * as adapter from "../acks-adapter.mjs";
import { now } from "../time.mjs";

function hasBribery(employer) {
  return (employer?.items ?? []).some(
    (i) => (i.type === "ability" || i.type === "item") && /^bribery/i.test(i.name ?? "")
  );
}

/** Resolve which character is attempting the recruitment. */
async function pickEmployer(preferred) {
  if (preferred) return preferred;
  if (game.user.character) return game.user.character;
  const choices = game.actors.filter((a) => a.type === "character" && !a.system?.retainer?.enabled);
  if (!choices.length) return null;
  if (choices.length === 1) return choices[0];
  const options = choices.map((a) => `<option value="${a.id}">${a.name}</option>`).join("");
  const id = await foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize("ACKS-HENCHMEN.recruit.pickEmployer") },
    content: `<select name="employerId">${options}</select>`,
    ok: {
      callback: (_event, button) => button.form.elements.employerId.value,
    },
  }).catch(() => null);
  return id ? game.actors.get(id) : null;
}

/**
 * @param {Actor} location - the location actor
 * @param {string} candidateId
 * @param {Actor} [preferredEmployer]
 */
export async function openRecruitDialog(location, candidateId, preferredEmployer = null) {
  const candidate = (location.system.candidates ?? []).find((c) => c.id === candidateId);
  if (!candidate) return;
  if (candidate.status === "slandered") {
    ui.notifications.warn(game.i18n.localize("ACKS-HENCHMEN.recruit.slanderedBlock"));
    return;
  }
  if (candidate.status !== "available") {
    ui.notifications.warn(game.i18n.localize("ACKS-HENCHMEN.recruit.notAvailable"));
    return;
  }
  const employer = await pickEmployer(preferredEmployer);
  if (!employer) {
    ui.notifications.warn(game.i18n.localize("ACKS-HENCHMEN.recruit.noEmployer"));
    return;
  }

  // Signing bonus prices scale with the candidate's wage and Bribery.
  const wage = Number(candidate.wageGp) || 12;
  const bribery = hasBribery(employer);
  const optionLabels = { signingBonus: {} };
  for (const tier of [1, 2, 3]) {
    const cost = signingBonusCost(tier, wage, bribery);
    if (cost) {
      optionLabels.signingBonus[`tier${tier}`] = game.i18n.format("ACKS-HENCHMEN.mod.signingBonusTierLabel", {
        gp: cost.gp,
        wages: game.i18n.localize(`ACKS-HENCHMEN.wages.${cost.wages}`),
      });
    }
  }

  const dynamicModifiers = toDialogModifiers(collectEffectModifiers(employer, "hiring"));
  const refusals = (candidate.refusals ?? []).length;
  const slanderCount = location.system.slanderCountFor?.(employer.uuid) ?? 0;

  openThrowDialog("reactionToHiring", {
    title: `${candidate.name} — ${employer.name}`,
    actor: employer,
    derived: {
      chaMod: adapter.getChaMod(employer),
      previousRefusals: refusals,
      slanderCount,
    },
    dynamicModifiers,
    optionLabels,
    infoText: game.i18n.format("ACKS-HENCHMEN.recruit.info", {
      name: candidate.name,
      wage,
      bribery: bribery
        ? game.i18n.localize("ACKS-HENCHMEN.recruit.briberyYes")
        : game.i18n.localize("ACKS-HENCHMEN.recruit.briberyNo"),
    }),
    onResolve: async (result) => {
      const signingTier = result.parts.find((p) => p.id === "signingBonus")?.value ?? 0;
      const signingGp = signingTier > 0 ? (signingBonusCost(signingTier, wage, bribery)?.gp ?? 0) : 0;
      await handleOutcome({ location, candidateId, employer, result, signingGp });
    },
  });
}

async function handleOutcome({ location, candidateId, employer, result, signingGp }) {
  const outcome = result.outcome;
  Hooks.callAll(HOOKS.HIRING_OUTCOME, { location, candidateId, employer, result });

  const pushRefusal = async (kind) => {
    const candidate = (location.system.candidates ?? []).find((c) => c.id === candidateId);
    const refusals = [...(candidate?.refusals ?? []).map((r) => r.toObject?.() ?? r), {
      employerUuid: employer.uuid,
      time: now(),
      result: kind,
    }];
    await updateCandidate(location, candidateId, { refusals });
  };

  switch (outcome) {
    case "acceptElan":
    case "accept": {
      const hired = await hire(location, candidateId, employer, {
        elan: outcome === "acceptElan",
        signingBonusGp: signingGp,
        origin: "market",
      });
      if (hired.error) {
        ui.notifications.error(game.i18n.localize(`ACKS-HENCHMEN.hire.error.${hired.error}`));
      }
      break;
    }
    case "tryAgain": {
      await pushRefusal("tryAgain");
      ChatMessage.create({
        content: game.i18n.format("ACKS-HENCHMEN.recruit.tryAgainChat", { employer: employer.name }),
        speaker: ChatMessage.getSpeaker({ actor: employer }),
      });
      break;
    }
    case "refuse": {
      await pushRefusal("refuse");
      break;
    }
    case "refuseSlander": {
      await pushRefusal("refuseSlander");
      const candidate = (location.system.candidates ?? []).find((c) => c.id === candidateId);
      await updateCandidate(location, candidateId, { status: "slandered" });
      const slander = [
        ...(location.system.slander ?? []).map((s) => s.toObject?.() ?? s),
        {
          partyKey: employer.uuid,
          npcName: candidate?.name ?? "",
          time: now(),
          note: game.i18n.localize("ACKS-HENCHMEN.recruit.slanderNote"),
        },
      ];
      await location.update({ "system.slander": slander });
      break;
    }
  }
}
