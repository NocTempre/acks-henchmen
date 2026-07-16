/* global game, ui, foundry, fromUuidSync */
/**
 * LocationSheet — ActorSheetV2 for the `acks-henchmen.location` sub-type.
 *
 * Sections: market settings + demographics, THE MARKET (the location's
 * shared monthly pools — availability belongs to the town, RR 162), paid
 * searches (postings), candidates (unique individuals), slander registry,
 * fee ledger. Players with OBSERVER permission see the candidates their
 * paid searches cover; GMs see everything.
 */
import { MODULE_ID, SECONDS_PER_DAY, SECONDS_PER_WEEK } from "../constants.mjs";
import { getTable } from "../rules/tables.mjs";
import { processLocation, closePosting } from "../engine/recruitment.mjs";
import { executeAsGM } from "../sockets.mjs";
import { addSpecialHire, updateSpecialHire } from "../engine/hire.mjs";
import { openPostingDialog } from "./posting-dialog.mjs";
import { openRecruitDialog, openRecruitSpecial } from "./recruit-dialog.mjs";
import { now, advanceDays } from "../time.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;

export class LocationSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["acks-henchmen", "location-sheet"],
    position: { width: 760, height: 720 },
    window: { resizable: true },
    form: { submitOnChange: true },
    actions: {
      createPosting: LocationSheet.#onCreatePosting,
      processNow: LocationSheet.#onProcessNow,
      advanceWeek: LocationSheet.#onAdvanceWeek,
      closePosting: LocationSheet.#onClosePosting,
      togglePlayerDetails: LocationSheet.#onTogglePlayerDetails,
      recruit: LocationSheet.#onRecruit,
      recruitSpecial: LocationSheet.#onRecruitSpecial,
      removeSpecial: LocationSheet.#onRemoveSpecial,
      setSpecialLimit: LocationSheet.#onSetSpecialLimit,
      removeCandidate: LocationSheet.#onRemoveCandidate,
      addSlander: LocationSheet.#onAddSlander,
      removeSlander: LocationSheet.#onRemoveSlander,
      addDemographic: LocationSheet.#onAddDemographic,
      removeDemographic: LocationSheet.#onRemoveDemographic,
    },
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/location-sheet.hbs` },
  };

  /** Localized label for a shared-pool segment key. */
  #segmentLabel(segment) {
    const [kind, key] = String(segment ?? "").split(":");
    if (kind === "henchman") return game.i18n.format("ACKS-HENCHMEN.market.henchmanSegment", { level: key });
    if (kind === "mercenary") return game.i18n.localize(`ACKS-HENCHMEN.troop.${key}`);
    if (kind === "specialist") return game.i18n.localize(`ACKS-HENCHMEN.specialist.${key}`);
    return segment;
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
    context.cultureOptions = Object.entries(getTable("people", "cultures").list).map(([id, c]) => ({
      id,
      label: c.label,
    }));
    context.demographics = (sys.demographics ?? []).map((d, index) => ({
      ...(d.toObject?.() ?? d),
      index,
    }));

    const candidates = (sys.candidates ?? []).map((c) => c.toObject?.() ?? c);
    const postings = (sys.postings ?? []).map((p) => p.toObject?.() ?? p);

    // --- The market: shared monthly pools ---
    context.market = (sys.marketRolls ?? []).map((r) => {
      const roll = r.toObject?.() ?? r;
      const mine = candidates.filter((c) => c.segment === roll.segment);
      const week = Math.min(4, Math.floor((t - roll.monthStartTime) / SECONDS_PER_WEEK) + 1);
      return {
        ...roll,
        label: this.#segmentLabel(roll.segment),
        week,
        arrived: mine.filter((c) => c.status === "available").reduce((s, c) => s + (c.quantity ?? 1), 0),
        pending: mine.filter((c) => c.status === "pending").reduce((s, c) => s + (c.quantity ?? 1), 0),
        hired: mine.filter((c) => c.status === "hired").reduce((s, c) => s + (c.quantity ?? 1), 0),
      };
    });

    // --- Paid searches ---
    const myActorUuids = game.user.isGM
      ? []
      : game.actors.filter((a) => a.testUserPermission(game.user, "OWNER")).map((a) => a.uuid);
    context.postings = postings.map((p) => {
      let employer = null;
      try {
        employer = p.employerUuid ? fromUuidSync(p.employerUuid) : null;
      } catch {
        /* unresolved */
      }
      const lied = p.presentedLevel != null && employer && p.presentedLevel !== (employer.system?.details?.level ?? null);
      return {
        ...p,
        specLabel: this.#specLabel(p.spec),
        employerName: employer?.name ?? "",
        feesTotal: (p.feesPaid ?? []).reduce((s, f) => s + f.gp, 0),
        statusLabel: game.i18n.localize(`ACKS-HENCHMEN.posting.status.${p.status}`),
        isActive: p.status === "active",
        isPrivate: !p.segment,
        isMine: game.user.isGM || myActorUuids.includes(p.employerUuid),
        liedLevel: game.user.isGM && lied ? p.presentedLevel : null,
      };
    });

    // --- Candidates: visibility per paid-search coverage ---
    const visibility = game.settings.get(MODULE_ID, "playerMarketVisibility");
    const ownedUuids = game.user.isGM
      ? []
      : game.actors.filter((a) => a.testUserPermission(game.user, "OWNER")).map((a) => a.uuid);
    const coveredSegments = new Set(
      postings
        .filter((p) => p.status === "active" && p.segment && (game.user.isGM || ownedUuids.includes(p.employerUuid)))
        .map((p) => p.segment)
    );
    const maskedSegments = new Set(
      postings.filter((p) => p.segment && p.playersSeeDetails === false).map((p) => p.segment)
    );
    const playerVisible = (c) => {
      if (game.user.isGM) return true;
      if (c.privateToUuid) return ownedUuids.includes(c.privateToUuid) && ["available", "hired"].includes(c.status);
      if (visibility === "none") return false;
      if (!["available", "hired"].includes(c.status)) return false;
      if (visibility === "all") return true;
      return coveredSegments.has(c.segment);
    };

    const cultures = getTable("people", "cultures").list;
    const henchKinds = ["henchman", "henchmanByClass", "henchmanByProficiency"];
    const rows = candidates
      .filter(playerVisible)
      .filter((c) => game.user.isGM || c.status !== "withdrawn")
      .map((c) => {
        const masked = !game.user.isGM && c.segment && maskedSegments.has(c.segment);
        const isHench = henchKinds.includes(c.kind);
        let identityLine = "";
        if (!masked) {
          if (isHench) {
            identityLine = [c.level != null ? `L${c.level}` : "", c.classKey, c.occupation]
              .filter(Boolean)
              .join(" · ");
            if (c.notes) identityLine = [identityLine, c.notes].filter(Boolean).join(" · ");
          } else if (c.kind === "specialist") {
            identityLine = game.i18n.localize(`ACKS-HENCHMEN.specialist.${c.specialistType}`);
          }
        }
        return {
          ...c,
          name: masked ? game.i18n.localize("ACKS-HENCHMEN.candidate.masked") : c.name,
          cultureLabel: masked ? "" : (cultures[c.culture]?.label ?? c.culture ?? ""),
          identityLine,
          appearanceTip: masked ? "" : c.appearance,
          isAggregate: (c.quantity ?? 1) > 1,
          isPrivate: !!c.privateToUuid,
          refusalCount: (c.refusals ?? []).length,
          statusLabel: game.i18n.localize(`ACKS-HENCHMEN.candidate.status.${c.status}`),
          isAvailable: c.status === "available",
        };
      })
      .sort((a, b) => (a.status === b.status ? 0 : a.status === "available" ? -1 : 1));
    // Directed-search results (private candidates) live in the SPECIAL
    // bucket: they stay until hired or the month re-rolls.
    context.directedRows = rows.filter((c) => c.isPrivate);
    context.henchmenRows = rows.filter((c) => henchKinds.includes(c.kind) && !c.isPrivate);
    context.mercenaryRows = rows.filter((c) => c.kind === "mercenary" && !c.isPrivate);
    context.specialistRows = rows.filter((c) => c.kind === "specialist" && !c.isPrivate);
    context.candidateCount = rows.length - context.directedRows.length;

    // Special hires: real actors placed by the GM (no time limit unless
    // set) or found on adventures (until hired that month, RAW default).
    context.specialHires = (sys.specialHires ?? [])
      .map((s) => s.toObject?.() ?? s)
      .filter((s) => game.user.isGM || s.status === "available")
      .map((s) => ({
        ...s,
        originLabel: game.i18n.localize(`ACKS-HENCHMEN.special.origin.${s.origin}`),
        statusLabel: game.i18n.localize(`ACKS-HENCHMEN.special.status.${s.status}`),
        isAvailable: s.status === "available",
        refusalCount: (s.refusals ?? []).length,
        limitLabel:
          s.expiresTime > 0
            ? game.i18n.format("ACKS-HENCHMEN.special.daysLeft", {
                days: Math.max(0, Math.ceil((s.expiresTime - t) / SECONDS_PER_DAY)),
              })
            : game.i18n.localize("ACKS-HENCHMEN.special.noLimit"),
      }));

    context.slander = (sys.slander ?? []).map((s, index) => ({ ...(s.toObject?.() ?? s), index }));
    context.ledger = (sys.searchLedger ?? []).slice(-20).reverse();
    context.ledgerTotal = (sys.searchLedger ?? []).reduce((s, l) => s + l.gp, 0);
    return context;
  }

  /**
   * Candidate-list ergonomics for big markets: a text filter and
   * click-to-sort headers, both pure DOM (no re-render, keeps the sheet
   * snappy at Class I scale).
   * @override
   */
  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;

    const filterInput = root.querySelector("[data-candidate-filter]");
    if (filterInput) {
      filterInput.addEventListener("input", () => {
        const needle = filterInput.value.trim().toLowerCase();
        root.querySelectorAll(".candidates-table tbody tr").forEach((tr) => {
          tr.style.display = !needle || tr.textContent.toLowerCase().includes(needle) ? "" : "none";
        });
      });
    }

    root.querySelectorAll(".candidates-table th[data-sortable]").forEach((th) => {
      th.addEventListener("click", () => {
        const table = th.closest("table");
        const tbody = table.querySelector("tbody");
        const index = [...th.parentElement.children].indexOf(th);
        const ascending = th.dataset.sortDir !== "asc";
        table.querySelectorAll("th[data-sortable]").forEach((h) => delete h.dataset.sortDir);
        th.dataset.sortDir = ascending ? "asc" : "desc";
        const rows = [...tbody.querySelectorAll("tr")];
        rows.sort((a, b) => {
          const av = a.children[index]?.textContent.trim() ?? "";
          const bv = b.children[index]?.textContent.trim() ?? "";
          const an = parseFloat(av);
          const bn = parseFloat(bv);
          const cmp = Number.isFinite(an) && Number.isFinite(bn) ? an - bn : av.localeCompare(bv);
          return ascending ? cmp : -cmp;
        });
        rows.forEach((r) => tbody.appendChild(r));
      });
    });
  }

  /**
   * Indexed form arrays (slander rows, demographics rows) arrive as
   * numeric-keyed objects; rebuild them, merging over stored rows.
   * @override
   */
  _prepareSubmitData(event, form, formData, updateData) {
    const data = super._prepareSubmitData(event, form, formData, updateData);
    for (const path of ["system.slander", "system.demographics"]) {
      const submitted = foundry.utils.getProperty(data, path);
      if (submitted && !Array.isArray(submitted)) {
        const existing = (foundry.utils.getProperty(this.actor, path) ?? []).map((s) => s.toObject?.() ?? s);
        const merged = Object.entries(submitted)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([index, row]) => ({ ...(existing[Number(index)] ?? {}), ...row }));
        foundry.utils.setProperty(data, path, merged);
      }
    }
    return data;
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
    ui.notifications.info(game.i18n.format("ACKS-HENCHMEN.location.processed", { arrived }));
  }

  static async #onAdvanceWeek() {
    await advanceDays(7);
  }

  /** Take a notice down. Players relay through the GM socket (they cannot
   *  write the location actor); ownership of the posting is enforced there. */
  static async #onClosePosting(_event, target) {
    const posting = this.#posting(target);
    if (!posting) return;
    if (game.user.isGM) {
      await closePosting(this.actor, posting.id);
    } else {
      await executeAsGM("closePosting", {
        locationUuid: this.actor.uuid,
        postingId: posting.id,
        requestUserId: game.user.id,
      });
    }
  }

  static async #onTogglePlayerDetails(_event, target) {
    const posting = this.#posting(target);
    if (posting) await this.#updatePosting(posting.id, { playersSeeDetails: !posting.playersSeeDetails });
  }

  static async #onRecruit(_event, target) {
    const candidate = this.#candidate(target);
    if (candidate) openRecruitDialog(this.actor, candidate.id);
  }

  /** GM drag-drop: register a dropped actor as a special hire. */
  async _onDropActor(_event, actor) {
    if (!game.user.isGM || !actor) return;
    if (actor.type === `${MODULE_ID}.location`) return;
    const existing = (this.actor.system.specialHires ?? []).find(
      (s) => s.actorUuid === actor.uuid && s.status === "available"
    );
    if (existing) {
      ui.notifications.info(game.i18n.format("ACKS-HENCHMEN.special.already", { name: actor.name }));
      return;
    }
    await addSpecialHire(this.actor, actor, { origin: "gm" });
    ui.notifications.info(game.i18n.format("ACKS-HENCHMEN.special.added", { name: actor.name }));
  }

  #specialHire(target) {
    const id = target.closest("[data-special-id]")?.dataset.specialId;
    return (this.actor.system.specialHires ?? []).find((s) => s.id === id);
  }

  static async #onRecruitSpecial(_event, target) {
    const entry = this.#specialHire(target);
    if (entry) openRecruitSpecial(this.actor, entry.id);
  }

  static async #onRemoveSpecial(_event, target) {
    const entry = this.#specialHire(target);
    if (!entry) return;
    const entries = (this.actor.system.specialHires ?? [])
      .map((s) => s.toObject?.() ?? s)
      .filter((s) => s.id !== entry.id);
    await this.actor.update({ "system.specialHires": entries });
  }

  /** GM: set/clear a decision time limit (in days from now; 0 = none). */
  static async #onSetSpecialLimit(_event, target) {
    const entry = this.#specialHire(target);
    if (!entry) return;
    const days = await foundry.applications.api.DialogV2.prompt({
      window: { title: game.i18n.format("ACKS-HENCHMEN.special.limitTitle", { name: entry.name }) },
      content: `<input type="number" name="days" min="0" step="1" placeholder="${game.i18n.localize("ACKS-HENCHMEN.special.limitPlaceholder")}" />`,
      ok: { callback: (_e, button) => button.form.elements.days.value },
    }).catch(() => null);
    if (days === null) return;
    const n = Math.max(0, Number(days) || 0);
    await updateSpecialHire(this.actor, entry.id, { expiresTime: n > 0 ? now() + n * SECONDS_PER_DAY : 0 });
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

  static async #onAddDemographic() {
    const demographics = [
      ...(this.actor.system.demographics ?? []).map((d) => d.toObject?.() ?? d),
      { culture: "auran", weight: 1 },
    ];
    await this.actor.update({ "system.demographics": demographics });
  }

  static async #onRemoveDemographic(_event, target) {
    const index = Number(target.closest("[data-demographic-index]")?.dataset.demographicIndex);
    const demographics = (this.actor.system.demographics ?? [])
      .map((d) => d.toObject?.() ?? d)
      .filter((_, i) => i !== index);
    await this.actor.update({ "system.demographics": demographics });
  }
}
