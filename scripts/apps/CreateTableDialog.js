import { TableEditorWindow } from "./TableEditorWindow.js";
import { PasteTableParser } from "../lib/PasteTableParser.js";

const MODULE_ID = "dynamic-table-manager";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class CreateTableDialog extends HandlebarsApplicationMixin(ApplicationV2) {

  #method    = "manual";
  #parsed    = null;      // last PasteTableParser result
  #splitMode = true;      // true = split into separate tables, false = merge into one
  #makeCompound = true;   // create top-level compound table when splitting
  #name      = "";        // persisted across re-renders
  #folderId  = null;      // folder to place new tables in (null = root)

  constructor(options = {}) {
    super(options);
    this.#folderId = options.folderId ?? null;
  }

  static DEFAULT_OPTIONS = {
    id: "dtm-create-table",
    classes: ["dynamic-table-manager", "dtm-create-dialog"],
    tag: "div",
    window: { title: "Create New Table", icon: "fas fa-plus", resizable: true },
    position: { width: 500, height: "auto" },
    actions: {
      create: CreateTableDialog.#onCreate,
      cancel: CreateTableDialog.#onCancel,
      parse:  CreateTableDialog.#onParse
    }
  };

  static PARTS = {
    form: { template: "modules/dynamic-table-manager/templates/create-table-dialog.hbs" }
  };

  /**
   * Find the next available "Table N" default name by scanning existing tables.
   * @returns {string}
   */
  static #getDefaultTableName() {
    const existing = game.tables?.contents ?? [];
    let max = 0;
    for (const t of existing) {
      const match = t.name.match(/^Table (\d+)$/);
      if (match) max = Math.max(max, parseInt(match[1]));
    }
    return `Table ${max + 1}`;
  }

  /** @override */
  async _prepareContext() {
    const parsed = this.#parsed;
    const isMulti = parsed?.isMultiColumn ?? false;

    return {
      name: this.#name,
      defaultName: CreateTableDialog.#getDefaultTableName(),
      tableTypes: [{ value: "basic", label: "Basic Table" }],
      creationMethods: [
        { value: "manual",   label: "Manual" },
        { value: "paste",    label: "Paste Table" },
        { value: "scan-pdf", label: "Scan PDF (Coming Soon)", disabled: true }
      ],
      method:    this.#method,
      isPaste:   this.#method === "paste",
      parsed,
      isMulti,
      splitMode: this.#splitMode,
      makeCompound: this.#makeCompound,
      // For single-column preview
      singleEntries: (!isMulti && parsed) ? parsed.entries : null,
      // For multi-column preview: column headers + first 3 rows sample
      multiColumns: isMulti ? parsed.columns.map(c => ({
        header: c.header,
        count: c.entries.length,
        sample: c.entries.slice(0, 3)
      })) : null
    };
  }

  /** @override */
  _onRender(context, options) {
    const form = this.element.querySelector("form");
    form?.addEventListener("submit", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      CreateTableDialog.#onCreate.call(this, ev, ev.target);
    });

    // Restore fields after re-render
    const nameInput = this.element.querySelector("[name='name']");
    if (nameInput) {
      nameInput.value = this.#name;
      // Keep #name in sync as user types
      nameInput.addEventListener("input", (ev) => { this.#name = ev.target.value; });
    }

    const methodSelect = this.element.querySelector("[name='creationMethod']");
    if (methodSelect) methodSelect.value = this.#method;

    methodSelect?.addEventListener("change", (ev) => {
      this.#method = ev.target.value;
      this.#parsed = null;
      this.render();
    });

    // Multi-column mode toggles
    this.element.querySelector("[name='splitMode']")?.addEventListener("change", (ev) => {
      this.#splitMode = ev.target.value === "split";
      this.render();
    });

    this.element.querySelector("[name='makeCompound']")?.addEventListener("change", (ev) => {
      this.#makeCompound = ev.target.checked;
    });
  }

  // ---- Actions ----

  static #onParse() {
    const raw = this.element.querySelector("[name='pasteContent']")?.value ?? "";
    if (!raw.trim()) { ui.notifications.warn("Paste some table text first."); return; }

    const result = PasteTableParser.parse(raw);
    if (!result.isMultiColumn && result.entries.length === 0) {
      ui.notifications.warn("Could not detect any numbered rows.");
      return;
    }
    if (result.isMultiColumn && result.columns[0].entries.length === 0) {
      ui.notifications.warn("Could not detect any numbered rows.");
      return;
    }
    this.#parsed = result;
    this.render();
  }

  static async #onCreate() {
    const form  = this.element.querySelector("form");
    const name  = form.querySelector("[name='name']")?.value.trim()
               || CreateTableDialog.#getDefaultTableName();

    if (this.#method === "paste") {
      // Re-parse if user edited the text after last parse
      const raw = form.querySelector("[name='pasteContent']")?.value ?? "";
      if (raw.trim()) this.#parsed = PasteTableParser.parse(raw);

      if (!this.#parsed) { ui.notifications.warn("Parse the pasted text first."); return; }

      if (this.#parsed.isMultiColumn && this.#splitMode) {
        await CreateTableDialog.#createSplitTables.call(this, name, this.#parsed);
      } else if (this.#parsed.isMultiColumn && !this.#splitMode) {
        await CreateTableDialog.#createMergedTable.call(this, name, this.#parsed);
      } else {
        await CreateTableDialog.#createSingleTable.call(this, name, this.#parsed);
      }
    } else {
      const table = await RollTable.create({ name, formula: "", description: "", folder: this.#folderId });
      TableEditorWindow.openForTable(table);
    }

    this.close();
  }

  /** Create one table per column, optionally a compound table linking them all. */
  static async #createSplitTables(baseName, parsed) {
    const subTables = [];

    for (const col of parsed.columns) {
      const tableName = `${baseName} — ${col.header}`;
      const table = await RollTable.create({ name: tableName, formula: parsed.formula, description: "", folder: this.#folderId });
      await table.createEmbeddedDocuments("TableResult", col.entries.map(e => ({
        type: CONST.TABLE_RESULT_TYPES.TEXT,
        name: e.name,
        range: [e.low, e.high],
        weight: e.high - e.low + 1
      })));
      subTables.push(table);
      TableEditorWindow.openForTable(table);
    }

    if (this.#makeCompound) {
      await CreateTableDialog.#createCompoundTable.call(this, baseName, subTables);
    }
  }

  /** Create a single flat table merging all columns (entries from all columns interleaved). */
  static async #createMergedTable(baseName, parsed) {
    const allEntries = parsed.columns.flatMap((col, ci) =>
      col.entries.map(e => ({ ...e, name: `[${col.header}] ${e.name}` }))
    );
    allEntries.sort((a, b) => a.low - b.low);

    const table = await RollTable.create({ name: baseName, formula: parsed.formula, description: "", folder: this.#folderId });
    await table.createEmbeddedDocuments("TableResult", allEntries.map(e => ({
      type: CONST.TABLE_RESULT_TYPES.TEXT,
      name: e.name,
      range: [e.low, e.high],
      weight: e.high - e.low + 1
    })));
    TableEditorWindow.openForTable(table);
  }

  /** Create a single-column table. */
  static async #createSingleTable(baseName, parsed) {
    const table = await RollTable.create({ name: baseName, formula: parsed.formula, description: "", folder: this.#folderId });
    await table.createEmbeddedDocuments("TableResult", parsed.entries.map(e => ({
      type: CONST.TABLE_RESULT_TYPES.TEXT,
      name: e.name,
      range: [e.low, e.high],
      weight: e.high - e.low + 1
    })));
    TableEditorWindow.openForTable(table);
  }

  /**
   * Create a compound table: one Document-linked result per sub-table.
   * Marked with a module flag so the editor rolls all of them together.
   */
  static async #createCompoundTable(baseName, subTables) {
    const compound = await RollTable.create({
      name: `${baseName} (Compound)`,
      formula: "1",
      description: `Rolls once on each of: ${subTables.map(t => t.name).join(", ")}`,
      flags: { [MODULE_ID]: { isCompound: true } },
      folder: this.#folderId
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

    TableEditorWindow.openForTable(compound);
  }

  static #onCancel() { this.close(); }
}
