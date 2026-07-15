/* global foundry, game */
/**
 * LocationData — the `acks-henchmen.location` actor sub-type: a settlement
 * where hirelings are recruited. Holds the market-class derivation inputs,
 * recruitment postings, candidate records, the per-town slander registry,
 * and a search-fee ledger.
 *
 * DESIGNED FOR EXTENSION by the future domain-module family: other modules
 * (e.g. a structures/strongholds module) store their own data in their own
 * flag namespace on the same location actor; this schema stays minimal.
 *
 * Candidates are plain records, NOT actors — a Class I market can roll
 * hundreds of 0th-level candidates; a real Actor is created only on hire.
 */
import { marketClassFromFamilies, clampMarketClass } from "../rules/availability.mjs";

const fields = foundry.data.fields;

const num = (opts = {}) => new fields.NumberField({ required: false, nullable: true, initial: null, ...opts });
const int = (initial = 0, opts = {}) =>
  new fields.NumberField({ required: true, nullable: false, integer: true, initial, ...opts });
const str = (opts = {}) => new fields.StringField({ required: false, blank: true, initial: "", ...opts });

/** One recruitment posting (a paid, ongoing search for one hireling spec). */
function postingField() {
  return new fields.SchemaField({
    id: str(),
    createdTime: int(),
    monthStartTime: int(), // start of the current availability month
    employerUuid: str(),
    dedicatedSearcherUuid: str(), // occupies one ancillary activity per day (informational)
    spec: new fields.SchemaField({
      kind: new fields.StringField({
        required: true,
        initial: "henchman",
        choices: ["henchman", "henchmanByClass", "henchmanByProficiency", "mercenary", "specialist"],
      }),
      level: num({ integer: true, min: 0, max: 14 }),
      classKey: str(),
      rarityOverride: str(),
      levelShift: int(0),
      proficiencyName: str(),
      proficiencyRanks: num({ integer: true, min: 1, max: 3 }),
      troopType: str(),
      specialistType: str(),
    }),
    commissioned: new fields.BooleanField({ initial: false }),
    totalAvailable: int(0),
    rollDetail: str(),
    arrivalPlan: new fields.ArrayField(
      new fields.SchemaField({
        week: int(1),
        count: int(0),
        materialized: new fields.BooleanField({ initial: false }),
      })
    ),
    feesPaid: new fields.ArrayField(
      new fields.SchemaField({ time: int(), gp: int(0) })
    ),
    lastProcessedTime: int(),
    status: new fields.StringField({ required: true, initial: "active", choices: ["active", "closed", "exhausted"] }),
    playersSeeDetails: new fields.BooleanField({ initial: true }),
  });
}

/** One candidate rolled up by a posting (plain record until hired). */
function candidateField() {
  return new fields.SchemaField({
    id: str(),
    postingId: str(),
    name: str(),
    kind: new fields.StringField({ required: true, initial: "henchman" }),
    quantity: int(1), // aggregated rows for masses (0th-level, mercs, laborers)
    level: num({ integer: true }),
    classKey: str(),
    classRarity: str(),
    template: str(),
    attributes: new fields.SchemaField({
      str: num({ integer: true }),
      int: num({ integer: true }),
      wil: num({ integer: true }),
      dex: num({ integer: true }),
      con: num({ integer: true }),
      cha: num({ integer: true }),
    }),
    hpRoll: num({ integer: true }),
    doubleD100: new fields.ArrayField(new fields.NumberField({ integer: true })),
    wageGp: num(),
    wageUnit: str(),
    troopType: str(),
    specialistType: str(),
    availableFromTime: int(),
    status: new fields.StringField({
      required: true,
      initial: "pending",
      choices: ["pending", "available", "hired", "refused", "slandered", "withdrawn"],
    }),
    refusals: new fields.ArrayField(
      new fields.SchemaField({
        employerUuid: str(),
        time: int(),
        result: str(),
      })
    ),
    notes: str(),
  });
}

export class LocationData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      region: str(),
      notes: new fields.HTMLField({ required: false, blank: true, initial: "" }),
      // Market-class derivation inputs: explicit override wins, then urban
      // families (local bracket table), then acks-domains courtesy read,
      // then default IV.
      marketClassOverride: num({ integer: true, min: 1, max: 6 }),
      urbanFamilies: num({ integer: true, min: 0 }),
      domainUuid: str(),
      classRarityTableId: new fields.StringField({ required: true, initial: "default" }),
      desertRealm: new fields.BooleanField({ initial: false }), // camel troops available
      compositeVariant: new fields.StringField({
        required: true,
        initial: "composite",
        choices: ["composite", "longbow"],
      }),
      postings: new fields.ArrayField(postingField()),
      candidates: new fields.ArrayField(candidateField()),
      slander: new fields.ArrayField(
        new fields.SchemaField({
          partyKey: str(), // employer uuid or party label the penalty applies to
          npcName: str(),
          time: int(),
          note: str(),
        })
      ),
      searchLedger: new fields.ArrayField(
        new fields.SchemaField({
          time: int(),
          gp: int(0),
          postingId: str(),
          paidByUuid: str(),
        })
      ),
    };
  }

  /** Effective market class 1..6 (1 = largest), before per-actor effect shifts. */
  get marketClass() {
    if (this.marketClassOverride) return clampMarketClass(this.marketClassOverride);
    if (this.urbanFamilies !== null && this.urbanFamilies !== undefined) {
      try {
        return marketClassFromFamilies(this.urbanFamilies);
      } catch {
        /* tables not loaded yet */
      }
    }
    // Courtesy read of a linked acks-domains domain (heavy WIP — guarded).
    try {
      const domains = game?.modules?.get?.("acks-domains");
      if (domains?.active && this.domainUuid) {
        const domain = fromUuidSync?.(this.domainUuid);
        const urban = domain?.system?.families?.urban;
        const profile = domains.api?.rules?.settlementProfile?.(Number(urban) || 0);
        if (profile?.marketClass) return clampMarketClass(profile.marketClass);
      }
    } catch {
      /* domains API changed — fall through */
    }
    return 4;
  }

  /** Count of active refuse-and-slander entries against one party/employer. */
  slanderCountFor(partyKey) {
    return (this.slander ?? []).filter((s) => !partyKey || s.partyKey === partyKey || s.partyKey === "").length;
  }
}
