/* global game, ui, foundry */
/**
 * PostingDialog — create a recruitment posting on a location: pick the
 * specification (henchman by level / by class rarity / by proficiency /
 * mercenary / specialist), the hiring employer, and options. Validates the
 * employer level cap (RR 168) before rolling the month's pool.
 */
import { MODULE_ID } from "../constants.mjs";
import { getTable } from "../rules/tables.mjs";
import { createPosting } from "../engine/recruitment.mjs";
import { maxHenchmanLevel } from "../rules/wages.mjs";
import * as adapter from "../acks-adapter.mjs";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class PostingDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor({ location, ...options } = {}) {
    super(options);
    this.location = location;
  }

  static DEFAULT_OPTIONS = {
    id: "acks-henchmen-posting-{id}",
    tag: "form",
    classes: ["acks-henchmen", "posting-dialog"],
    position: { width: 480 },
    window: { resizable: false, contentClasses: ["standard-form"] },
    form: { handler: PostingDialog.#onSubmit, closeOnSubmit: true },
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/posting-dialog.hbs` },
  };

  get title() {
    return game.i18n.format("ACKS-HENCHMEN.posting.createTitle", { name: this.location.name });
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.employers = game.actors
      .filter((a) => a.type === "character" && a.hasPlayerOwner && !a.system?.retainer?.enabled)
      .map((a) => ({ id: a.id, name: a.name, level: adapter.getLevel(a) }));
    if (!context.employers.length) {
      context.employers = game.actors
        .filter((a) => a.type === "character" && !a.system?.retainer?.enabled)
        .map((a) => ({ id: a.id, name: a.name, level: adapter.getLevel(a) }));
    }
    context.levels = [0, 1, 2, 3, 4].map((l) => ({ level: l }));
    context.mercTypes = getTable("availability", "mercenaryAvailability").rows.map((r) => ({
      id: r.type,
      label: game.i18n.localize(`ACKS-HENCHMEN.troop.${r.type}`),
    }));
    context.specialistTypes = getTable("availability", "specialistAvailability").rows.map((r) => ({
      id: r.type,
      label: game.i18n.localize(`ACKS-HENCHMEN.specialist.${r.type}`),
    }));
    const variant = this.location.system.classRarityTableId || "default";
    const variants = getTable("rarity", "classRarityTables").variants;
    const tiers = (variants[variant] ?? variants.default).tiers;
    context.classes = Object.entries(tiers).flatMap(([tier, list]) =>
      list.map((c) => ({ id: c, label: `${c} (${game.i18n.localize(`ACKS-HENCHMEN.rarity.${tier}`)})` }))
    );
    return context;
  }

  /** Show only the fields relevant to the selected posting kind. */
  _onRender(context, options) {
    super._onRender(context, options);
    const sync = () => {
      const kind = this.element.querySelector("[data-posting-kind]")?.value;
      this.element.querySelectorAll("[data-kind-field]").forEach((el) => {
        const kinds = el.dataset.kindField.split(" ");
        el.style.display = kinds.includes(kind) ? "" : "none";
      });
    };
    this.element.querySelector("[data-posting-kind]")?.addEventListener("change", sync);
    sync();
  }

  static async #onSubmit(_event, _form, formData) {
    const data = foundry.utils.expandObject(formData.object);
    const employer = game.actors.get(data.employerId) ?? null;
    const kind = data.kind;
    const spec = { kind };

    if (kind === "henchman" || kind === "henchmanByClass") {
      spec.level = Number(data.level) || 0;
    }
    if (kind === "henchmanByClass") {
      spec.classKey = data.classKey ?? "";
      spec.levelShift = Math.max(0, (Number(data.level) || 1) - 1);
      spec.commissioned = !!data.commissioned;
    }
    if (kind === "henchmanByProficiency") {
      spec.proficiencyName = data.proficiencyName ?? "";
      spec.proficiencyRanks = Number(data.proficiencyRanks) || 1;
      spec.commissioned = !!data.commissioned;
    }
    if (kind === "mercenary") spec.troopType = data.troopType;
    if (kind === "specialist") spec.specialistType = data.specialistType;

    // Employer level cap (RR 168) for leveled henchman searches.
    if (employer && (kind === "henchman" || kind === "henchmanByClass") && (spec.level ?? 0) > 0) {
      const cap = maxHenchmanLevel(adapter.getLevel(employer), !!data.domainRuler);
      if (spec.level > cap) {
        ui.notifications.error(
          game.i18n.format("ACKS-HENCHMEN.posting.levelCapError", {
            employer: employer.name,
            level: spec.level,
            cap,
          })
        );
        return;
      }
    }

    const result = await createPosting(this.location, spec, employer, {
      playersSeeDetails: data.playersSeeDetails !== false,
    });
    if (result.error) {
      ui.notifications.error(game.i18n.localize(`ACKS-HENCHMEN.posting.error.${result.error}`));
      return;
    }
    ui.notifications.info(
      game.i18n.format("ACKS-HENCHMEN.posting.created", {
        total: result.posting.totalAvailable,
        fee: result.fee.gp,
      })
    );
  }
}

export function openPostingDialog(location) {
  new PostingDialog({ location }).render(true);
}
