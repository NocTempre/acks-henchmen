/* global game, ui, foundry */
/**
 * LocationSheet — ActorSheetV2 for the `acks-henchmen.location` sub-type.
 * GM view: market-class derivation, postings (monthly pool, arrivals, fees),
 * candidates, slander registry, and the search-fee ledger. Players with
 * OBSERVER permission get the same document rendered by PostingsApp (the
 * recruitment board) — this sheet is the management surface.
 *
 * Stacked collapsible sections instead of tab groups: identical markup works
 * on Foundry v13 and v14 without version-specific tab wiring.
 */
import { MODULE_ID, SECONDS_PER_WEEK } from "../constants.mjs";
import { getTable } from "../rules/tables.mjs";
import { processLocation, effectiveMarketClass } from "../engine/recruitment.mjs";
import { openPostingDialog } from "./posting-dialog.mjs";
import { rollCandidateStats, rollCandidateClass, rollCandidateLevel } from "../engine/hire.mjs";
import { openRecruitDialog } from "./recruit-dialog.mjs";
import { now } from "../time.mjs";
import { advanceDays } from "../time.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;

export class LocationSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["acks-henchmen", "location-sheet"],
    position: { width: 720, height: 700 },
    window: { resizable: true },
    form: { submitOnChange: true },
    actions: {
      createPosting: LocationSheet.#onCreatePosting,
      processNow: LocationSheet.#onProcessNow,
      advanceWeek: LocationSheet.#onAdvanceWeek,
      closePosting: LocationSheet.#onClosePosting,
      renewPosting: LocationSheet.#onRenewPosting,
      togglePlayerDetails: LocationSheet.#onTogglePlayerDetails,
      rollStats: LocationSheet.#onRollStats,
      rollClass: LocationSheet.#onRollClass,
      rollLevel: LocationSheet.#onRollLevel,
      recruit: LocationSheet.#onRecruit,
      removeCandidate: LocationSheet.#onRemoveCandidate,
      addSlander: LocationSheet.#onAddSlander,
      removeSlander: LocationSheet.#onRemoveSlander,
    },
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/location-sheet.hbs` },
  };

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const actor = this.actor;
    const sys = actor.system;
    const t = now();

    context.actor = actor;
    context.system = sys;
    context.isGM = game.user.isGM;
    context.marketClass = sys.marketClass;
    context.marketClassRoman = ["I", "II", "III", "IV", "V", "VI"][sys.marketClass - 1];
    context.marketClassSource = sys.marketClassOverride
      ? game.i18n.localize("ACKS-HENCHMEN.location.sourceOverride")
      : sys.urbanFamilies != null
        ? game.i18n.localize("ACKS-HENCHMEN.location.sourceFamilies")
        : game.i18n.localize("ACKS-HENCHMEN.location.sourceDefault");
    context.rarityVariants = Object.entries(getTable("rarity", "classRarityTables").variants).map(([id, v]) => ({
      id,
      label: game.i18n.localize(v.label),
      selected: id === sys.classRarityTableId,
    }));

    const candidates = sys.candidates ?? [];
    context.postings = (sys.postings ?? []).map((p) => {
      const week = Math.min(4, Math.floor((t - p.monthStartTime) / SECONDS_PER_WEEK) + 1);
      const mine = candidates.filter((c) => c.postingId === p.id);
      return {
        ...(p.toObject?.() ?? p),
        specLabel: this.#specLabel(p.spec),
        week,
        feesTotal: (p.feesPaid ?? []).reduce((s, f) => s + f.gp, 0),
        availableCount: mine.filter((c) => c.status === "available").reduce((s, c) => s + (c.quantity ?? 1), 0),
        pendingCount: mine.filter((c) => c.status === "pending").reduce((s, c) => s + (c.quantity ?? 1), 0),
        hiredCount: mine.filter((c) => c.status === "hired").reduce((s, c) => s + (c.quantity ?? 1), 0),
        statusLabel: game.i18n.localize(`ACKS-HENCHMEN.posting.status.${p.status}`),
        isActive: p.status === "active",
      };
    });

    // Players see only ARRIVED candidates (the board shows "what your post
    // says is available at the moment"), scoped by the visibility setting and
    // per-posting detail masking. Pending/withdrawn rows are GM knowledge.
    const visibility = game.settings.get(MODULE_ID, "playerMarketVisibility");
    const postingById = new Map((sys.postings ?? []).map((p) => [p.id, p]));
    const userCharacterUuids = game.user.isGM
      ? []
      : game.actors.filter((a) => a.testUserPermission(game.user, "OWNER")).map((a) => a.uuid);
    const playerVisible = (c) => {
      if (game.user.isGM) return true;
      if (visibility === "none") return false;
      if (!["available", "hired"].includes(c.status)) return false;
      const posting = postingById.get(c.postingId);
      if (!posting) return false;
      if (visibility === "owned" && !userCharacterUuids.includes(posting.employerUuid)) return false;
      return true;
    };
    context.candidates = candidates
      .filter(playerVisible)
      .map((c) => {
        const obj = c.toObject?.() ?? c;
        const posting = postingById.get(obj.postingId);
        const masked = !game.user.isGM && posting && posting.playersSeeDetails === false;
        return {
          ...obj,
          name: masked ? game.i18n.localize("ACKS-HENCHMEN.candidate.masked") : obj.name,
          classKey: masked ? "" : obj.classKey,
          template: masked ? "" : obj.template,
          statusLabel: game.i18n.localize(`ACKS-HENCHMEN.candidate.status.${obj.status}`),
          isAvailable: obj.status === "available",
          hasStats: obj.attributes?.str != null,
          statLine:
            !masked && obj.attributes?.str != null
              ? `${obj.attributes.str}/${obj.attributes.int}/${obj.attributes.wil}/${obj.attributes.dex}/${obj.attributes.con}/${obj.attributes.cha}`
              : "",
          rollable: game.user.isGM && ["henchman", "henchmanByClass", "henchmanByProficiency"].includes(obj.kind),
        };
      })
      .sort((a, b) => (a.status === b.status ? 0 : a.status === "available" ? -1 : 1));

    context.slander = (sys.slander ?? []).map((s, index) => ({ ...(s.toObject?.() ?? s), index }));
    context.ledger = (sys.searchLedger ?? []).slice(-20).reverse();
    context.ledgerTotal = (sys.searchLedger ?? []).reduce((s, l) => s + l.gp, 0);
    return context;
  }

  #specLabel(spec) {
    const kind = game.i18n.localize(`ACKS-HENCHMEN.posting.kind.${spec.kind}`);
    const detail =
      spec.classKey ||
      spec.troopType ||
      spec.specialistType ||
      spec.proficiencyName ||
      (spec.level != null ? game.i18n.format("ACKS-HENCHMEN.posting.levelN", { level: spec.level }) : "");
    return detail ? `${kind}: ${detail}` : kind;
  }

  #posting(target) {
    const id = target.closest("[data-posting-id]")?.dataset.postingId;
    return (this.actor.system.postings ?? []).find((p) => p.id === id);
  }

  #candidate(target) {
    const id = target.closest("[data-candidate-id]")?.dataset.candidateId;
    return (this.actor.system.candidates ?? []).find((c) => c.id === id);
  }

  async #updatePosting(id, changes) {
    const postings = (this.actor.system.postings ?? []).map((p) => {
      const obj = p.toObject?.() ?? foundry.utils.deepClone(p);
      return obj.id === id ? { ...obj, ...changes } : obj;
    });
    await this.actor.update({ "system.postings": postings });
  }

  static async #onCreatePosting() {
    openPostingDialog(this.actor);
  }

  static async #onProcessNow() {
    const { arrived } = await processLocation(this.actor);
    ui.notifications.info(
      game.i18n.format("ACKS-HENCHMEN.location.processed", {
        arrived: arrived.reduce((s, a) => s + a.count, 0),
      })
    );
  }

  static async #onAdvanceWeek() {
    await advanceDays(7);
  }

  static async #onClosePosting(_event, target) {
    const posting = this.#posting(target);
    if (posting) await this.#updatePosting(posting.id, { status: "closed" });
  }

  static async #onRenewPosting(_event, target) {
    const posting = this.#posting(target);
    if (posting) await this.#updatePosting(posting.id, { renew: true });
  }

  static async #onTogglePlayerDetails(_event, target) {
    const posting = this.#posting(target);
    if (posting) await this.#updatePosting(posting.id, { playersSeeDetails: !posting.playersSeeDetails });
  }

  static async #onRollStats(_event, target) {
    const candidate = this.#candidate(target);
    if (candidate) await rollCandidateStats(this.actor, candidate.id);
  }

  static async #onRollClass(_event, target) {
    const candidate = this.#candidate(target);
    if (candidate) await rollCandidateClass(this.actor, candidate.id);
  }

  static async #onRollLevel(_event, target) {
    const candidate = this.#candidate(target);
    if (candidate) await rollCandidateLevel(this.actor, candidate.id);
  }

  static async #onRecruit(_event, target) {
    const candidate = this.#candidate(target);
    if (candidate) openRecruitDialog(this.actor, candidate.id);
  }

  static async #onRemoveCandidate(_event, target) {
    const candidate = this.#candidate(target);
    if (!candidate) return;
    const candidates = (this.actor.system.candidates ?? [])
      .map((c) => c.toObject?.() ?? c)
      .filter((c) => c.id !== candidate.id);
    await this.actor.update({ "system.candidates": candidates });
  }

  static async #onAddSlander() {
    const slander = [
      ...(this.actor.system.slander ?? []).map((s) => s.toObject?.() ?? s),
      { partyKey: "", npcName: "", time: now(), note: "" },
    ];
    await this.actor.update({ "system.slander": slander });
  }

  static async #onRemoveSlander(_event, target) {
    const index = Number(target.closest("[data-slander-index]")?.dataset.slanderIndex);
    const slander = (this.actor.system.slander ?? []).map((s) => s.toObject?.() ?? s).filter((_, i) => i !== index);
    await this.actor.update({ "system.slander": slander });
  }
}

export { effectiveMarketClass };
