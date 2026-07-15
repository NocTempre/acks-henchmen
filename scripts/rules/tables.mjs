/**
 * Table access for rules data. Pure module — no Foundry imports.
 * Ported from acks-domains module/rules/tables.mjs (same contract) so rules
 * functions stay unit-testable and the data source stays swappable: the
 * Foundry entry point loads `ruledata/*.json` via fetch and calls
 * `initTables()`; Node tooling loads the same JSON from disk.
 */

const _data = new Map();

/** Register one parsed ruledata document (must carry `id`). */
export function initTables(doc) {
  if (!doc?.id) throw new Error("initTables: invalid ruledata document");
  _data.set(doc.id, doc);
}

/** Remove all registered ruledata (tests). */
export function resetTables() {
  _data.clear();
}

/** @returns {object} the whole ruledata document */
export function getDoc(docId) {
  const doc = _data.get(docId);
  if (!doc) throw new Error(`getDoc: ruledata "${docId}" not loaded`);
  return doc;
}

/** @returns {object} one table of a ruledata document */
export function getTable(docId, tableId) {
  const doc = getDoc(docId);
  const table = doc.tables?.[tableId];
  if (!table) throw new Error(`getTable: no table "${tableId}" in ruledata "${docId}"`);
  return table;
}

/** @returns {object} one throw definition of a ruledata document */
export function getThrowDef(docId, throwId) {
  const doc = getDoc(docId);
  const def = doc.throws?.[throwId];
  if (!def) throw new Error(`getThrowDef: no throw "${throwId}" in ruledata "${docId}"`);
  return def;
}

/**
 * Find the row of a bracket table whose [min, max] contains `value`.
 * Rows with a null/undefined max are open-ended.
 */
export function bracketRow(rows, value, minKey = "min", maxKey = "max") {
  return rows.find((r) => value >= (r[minKey] ?? -Infinity) && (r[maxKey] == null || value <= r[maxKey]));
}
