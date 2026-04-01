import { TableEditorWindow } from "../apps/TableEditorWindow.js";

const MODULE_ID = "dynamic-table-manager";

/**
 * Shared utility for creating RollTable documents from parsed table data.
 * Used by both CreateTableDialog and PDFScannerWindow.
 */
export class TableCreator {

  /**
   * Create a single-column RollTable from parsed data.
   * @param {string} name
   * @param {{ formula: string, entries: {low,high,name}[] }} parsed
   * @param {string|null} folderId
   * @returns {Promise<RollTable>}
   */
  static async createSingleTable(name, parsed, folderId) {
    const table = await RollTable.create({ name, formula: parsed.formula, description: "", folder: folderId });
    await table.createEmbeddedDocuments("TableResult",
      parsed.entries.map(e => TableCreator.#toResult(e)).filter(Boolean)
    );
    return table;
  }

  /**
   * Create one RollTable per column, optionally wrapped in a compound table.
   * @param {string} baseName
   * @param {{ formula: string, columns: {header,entries}[] }} parsed
   * @param {string|null} folderId
   * @param {boolean} makeCompound
   * @returns {Promise<RollTable[]>}  sub-tables first; compound last (if created)
   */
  static async createSplitTables(baseName, parsed, folderId, makeCompound) {
    const subTables = [];
    for (const col of parsed.columns) {
      const tableName = `${baseName} — ${col.header}`;
      const table = await RollTable.create({ name: tableName, formula: parsed.formula, description: "", folder: folderId });
      await table.createEmbeddedDocuments("TableResult",
        col.entries.map(e => TableCreator.#toResult(e)).filter(Boolean)
      );
      subTables.push(table);
    }
    if (makeCompound) {
      const compound = await TableCreator.createCompoundTable(baseName, subTables, folderId);
      return [...subTables, compound];
    }
    return subTables;
  }

  /**
   * Create a single merged RollTable from all columns (interleaved, prefixed with column name).
   * @param {string} baseName
   * @param {{ formula: string, columns: {header,entries}[] }} parsed
   * @param {string|null} folderId
   * @returns {Promise<RollTable>}
   */
  static async createMergedTable(baseName, parsed, folderId) {
    const allEntries = parsed.columns.flatMap(col =>
      col.entries.map(e => ({ ...e, name: `[${col.header}] ${e.name}` }))
    );
    allEntries.sort((a, b) => a.low - b.low);
    const table = await RollTable.create({ name: baseName, formula: parsed.formula, description: "", folder: folderId });
    await table.createEmbeddedDocuments("TableResult",
      allEntries.map(e => TableCreator.#toResult(e)).filter(Boolean)
    );
    return table;
  }

  /**
   * Convert a parsed entry { low, high, name } to a valid TableResult data object.
   * Returns null for any entry where low/high are not finite positive integers,
   * which skips corrupt rows rather than crashing the whole batch.
   */
  static #toResult(e) {
    const low  = Math.round(Number(e.low));
    const high = Math.round(Number(e.high));
    if (!Number.isFinite(low) || !Number.isFinite(high) || low < 1 || high < low) return null;
    return {
      type:   CONST.TABLE_RESULT_TYPES.TEXT,
      name:   e.name,
      range:  [low, high],
      weight: high - low + 1
    };
  }

  /**
   * Create a compound RollTable that links all provided sub-tables.
   * @param {string} baseName
   * @param {RollTable[]} subTables
   * @param {string|null} folderId
   * @returns {Promise<RollTable>}
   */
  static async createCompoundTable(baseName, subTables, folderId) {
    const compound = await RollTable.create({
      name: `${baseName} (Compound)`,
      formula: "1",
      description: `Rolls once on each of: ${subTables.map(t => t.name).join(", ")}`,
      flags: { [MODULE_ID]: { isCompound: true } },
      folder: folderId
    });
    await compound.createEmbeddedDocuments("TableResult",
      subTables.map((t, i) => ({
        type: CONST.TABLE_RESULT_TYPES.DOCUMENT,
        documentUuid: t.uuid,
        name: t.name,
        img: t.img,
        range: [i + 1, i + 1],
        weight: 1
      }))
    );
    return compound;
  }

  /**
   * Open the TableEditorWindow for each table in the array.
   * @param {RollTable[]} tables
   */
  static openEditors(tables) {
    for (const table of tables) TableEditorWindow.openForTable(table);
  }
}
