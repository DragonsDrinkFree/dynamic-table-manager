import { TableEditorWindow } from "./TableEditorWindow.js";
import { JournalTemplateEditorWindow } from "./JournalTemplateEditorWindow.js";
import { PDFScannerWindow } from "./PDFScannerWindow.js";
import { PasteTableParser } from "../lib/PasteTableParser.js";
import { TableCreator } from "../lib/TableCreator.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class CreateTableDialog extends HandlebarsApplicationMixin(ApplicationV2) {

  #method    = "manual";
  #tableType = "basic";   // "basic" | "journal-template"
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
      tableTypes: [
        { value: "basic",            label: "Basic Table" },
        { value: "journal-template", label: "Journal Template" }
      ],
      isJournalTemplate: this.#tableType === "journal-template",
      creationMethods: [
        { value: "manual",   label: "Manual" },
        { value: "paste",    label: "Paste Table" },
        { value: "scan-pdf", label: "Scan PDF" }
      ],
      method:    this.#method,
      isPaste:   this.#method === "paste",
      parsed,
      isMulti,
      splitMode: this.#splitMode,
      makeCompound: this.#makeCompound,
      singleEntries: (!isMulti && parsed) ? parsed.entries : null,
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

    const nameInput = this.element.querySelector("[name='name']");
    if (nameInput) {
      nameInput.value = this.#name;
      nameInput.addEventListener("input", (ev) => { this.#name = ev.target.value; });
    }

    const typeSelect = this.element.querySelector("[name='tableType']");
    if (typeSelect) typeSelect.value = this.#tableType;
    typeSelect?.addEventListener("change", (ev) => {
      this.#tableType = ev.target.value;
      this.#parsed = null;
      this.render();
    });

    const methodSelect = this.element.querySelector("[name='creationMethod']");
    if (methodSelect) methodSelect.value = this.#method;

    methodSelect?.addEventListener("change", (ev) => {
      this.#method = ev.target.value;
      this.#parsed = null;
      if (this.#method === "scan-pdf") {
        CreateTableDialog.#onOpenScanner.call(this);
      } else {
        this.render();
      }
    });

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
    const form = this.element.querySelector("form");
    const name = form.querySelector("[name='name']")?.value.trim()
               || CreateTableDialog.#getDefaultTableName();

    if (this.#tableType === "journal-template") {
      const table = await RollTable.create({
        name,
        formula: "1",
        folder: this.#folderId,
        flags: { "dynamic-table-manager": { tableType: "journal-template" } }
      });
      JournalTemplateEditorWindow.openForTable(table);
      this.close();
      return;
    }

    if (this.#method === "paste") {
      const raw = form.querySelector("[name='pasteContent']")?.value ?? "";
      if (raw.trim()) this.#parsed = PasteTableParser.parse(raw);
      if (!this.#parsed) { ui.notifications.warn("Parse the pasted text first."); return; }

      if (this.#parsed.isMultiColumn && this.#splitMode) {
        const tables = await TableCreator.createSplitTables(name, this.#parsed, this.#folderId, this.#makeCompound);
        TableCreator.openEditors(tables);
      } else if (this.#parsed.isMultiColumn && !this.#splitMode) {
        const table = await TableCreator.createMergedTable(name, this.#parsed, this.#folderId);
        TableCreator.openEditors([table]);
      } else {
        const table = await TableCreator.createSingleTable(name, this.#parsed, this.#folderId);
        TableCreator.openEditors([table]);
      }
    } else {
      const table = await RollTable.create({ name, formula: "", description: "", folder: this.#folderId });
      TableEditorWindow.openForTable(table);
    }

    this.close();
  }

  static #onOpenScanner() {
    const name = this.element.querySelector("[name='name']")?.value.trim()
               || CreateTableDialog.#getDefaultTableName();
    this.close();
    new PDFScannerWindow({ folderId: this.#folderId, suggestedName: name }).render(true);
  }

  static #onCancel() { this.close(); }
}
