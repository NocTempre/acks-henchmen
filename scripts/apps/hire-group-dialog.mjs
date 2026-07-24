/* global game, foundry, ui */
/**
 * "Hire as Group" — assemble a unit from the location's available market and
 * hire it as ONE acks-lib.group: pick troop rows (with quantities) and an
 * optional officer, and the engine turns troops into counted merc stacks and
 * links the officer as commander (see engine/hire-group.mjs). Troops = the
 * mercenary rows; officers = the mercOfficer/marshal leader specialists.
 */
import { hireAsGroup } from "../engine/hire-group.mjs";
import { pickEmployer } from "./recruit-dialog.mjs";

const isOfficer = (c) => /^(mercOfficer|marshal)/i.test(c.specialistType ?? "");
const isTroop = (c) => c.kind === "mercenary" || !!c.troopType;

export async function openHireGroupDialog(location) {
  const employer = await pickEmployer(game.user.character);
  if (!employer) return ui.notifications.warn(game.i18n.localize("ACKS-HENCHMEN.group.noEmployer"));

  const available = (location.system.candidates ?? []).map((c) => c.toObject?.() ?? c).filter((c) => c.status === "available");
  const troops = available.filter(isTroop);
  const officers = available.filter(isOfficer);
  if (!troops.length && !officers.length) return ui.notifications.warn(game.i18n.localize("ACKS-HENCHMEN.group.noneAvailable"));

  const esc = foundry.utils.escapeHTML;
  const troopRows = troops
    .map(
      (c) => `<label class="hg-row"><input type="checkbox" name="t_${c.id}" />
        <span class="hg-name">${esc(c.troopType || c.name || "Trooper")}</span>
        <span class="hg-qty">×<input type="number" name="q_${c.id}" value="${c.quantity ?? 1}" min="1" /></span></label>`
    )
    .join("");
  const officerRows = officers.length
    ? `<fieldset class="hg-officers"><legend>${game.i18n.localize("ACKS-HENCHMEN.group.officer")}</legend>
        <label><input type="radio" name="officer" value="" checked /> ${game.i18n.localize("ACKS-HENCHMEN.group.noOfficer")}</label>
        ${officers.map((c) => `<label><input type="radio" name="officer" value="${c.id}" /> ${esc(c.specialistType || c.name || "Officer")}</label>`).join("")}</fieldset>`
    : "";

  const content = `<div class="hire-group-dialog">
      <p>${game.i18n.format("ACKS-HENCHMEN.group.forEmployer", { name: esc(employer.name) })}</p>
      ${troops.length ? `<fieldset><legend>${game.i18n.localize("ACKS-HENCHMEN.group.troops")}</legend>${troopRows}</fieldset>` : ""}
      ${officerRows}
    </div>`;

  const picks = await foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize("ACKS-HENCHMEN.group.hireTitle") },
    content,
    ok: {
      label: game.i18n.localize("ACKS-HENCHMEN.group.hireButton"),
      callback: (_event, button) => {
        const f = button.form.elements;
        const chosen = troops
          .filter((c) => f[`t_${c.id}`]?.checked)
          .map((c) => ({ candidateId: c.id, quantity: Number(f[`q_${c.id}`]?.value) || (c.quantity ?? 1) }));
        return { troops: chosen, officerCandidateId: f.officer?.value || null };
      },
    },
  }).catch(() => null);
  if (!picks || (!picks.troops.length && !picks.officerCandidateId)) return;

  const result = await hireAsGroup(location, employer, picks);
  if (result.error) {
    return ui.notifications.warn(game.i18n.format("ACKS-HENCHMEN.group.hireFailed", { reason: result.error }));
  }
  ui.notifications.info(
    game.i18n.format("ACKS-HENCHMEN.group.hiredInfo", { group: result.group.name, stacks: result.stacks.length })
  );
  result.group.sheet?.render(true);
  location.sheet?.render(false);
}
