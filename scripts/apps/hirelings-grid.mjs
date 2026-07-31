/* global game, Hooks, document, globalThis, console */
/**
 * Re-skin the core character sheet's Hirelings tab as a grid of Follower Cards.
 *
 * Pure runtime DOM augmentation of the SYSTEM sheet (the acks-domains / acks-influence
 * injection pattern) — no core files are touched. Each hireling row becomes acks-lib's
 * read-only Follower Card, which reuses the system's OWN hireling actions
 * (hirelingShow / hirelingLoyalty / hirelingMorale / hirelingDelete) through
 * ApplicationV2's delegated action dispatch, so open / loyalty / morale / delete keep
 * working against the right hireling (resolved by the data-item-id on the card root).
 * Degrades to the stock list when acks-lib is too old to expose `followerCard`.
 */
import { MODULE_ID } from "../constants.mjs";

const GRID_CLASS = "acks-henchmen-follower-grid";

async function gridifyHirelings(app, element) {
  if (game.system?.id !== "acks") return;
  const api = globalThis.acksLib?.followerCard;
  if (!api?.render) return; // older acks-lib — leave the stock list intact
  const actor = app.actor ?? app.document;
  if (actor?.type !== "character") return;
  const root = element instanceof HTMLElement ? element : element?.[0];
  const tab = root?.querySelector('.tab[data-tab="hirelings"]');
  if (!tab) return;

  for (const section of tab.querySelectorAll(".item-list-section")) {
    if (section.dataset.acksGrid) continue; // claimed this render (sync, before await)
    section.dataset.acksGrid = "1";

    const rows = [...section.querySelectorAll("li.item[data-item-id]")];
    if (!rows.length) continue; // empty bucket — leave core's own "none" state

    const title = section.querySelector(".list-header .item__name")?.textContent?.trim() ?? "";
    const cells = await Promise.all(
      rows.map(async (li) => {
        const id = li.dataset.itemId;
        const hireling = game.actors.get(id);
        if (!hireling) return "";
        const card = await api.render(hireling, { editable: false });
        // The .item wrapper carries data-item-id so the system's own hireling
        // actions resolve the hireling — core reads closest(".item").dataset.itemId.
        return `<div class="item acks-henchmen-fc-cell" data-item-id="${id}">${card}</div>`;
      }),
    );

    const head = document.createElement("div");
    head.className = "acks-henchmen-grid-head";
    head.textContent = title;

    const grid = document.createElement("div");
    grid.className = GRID_CLASS;
    grid.innerHTML = cells.join("");

    // Atomic swap: the original list stays until the cards are ready.
    section.replaceChildren(head, grid);
  }
}

export function installHirelingsGrid() {
  Hooks.on("renderActorSheetV2", (app, element) => {
    gridifyHirelings(app, element).catch((err) => console.warn(`${MODULE_ID} | hirelings grid failed`, err));
  });
}
