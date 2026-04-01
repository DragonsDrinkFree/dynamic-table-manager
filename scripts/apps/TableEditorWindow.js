import { DiceFormulaParser } from "../lib/DiceFormulaParser.js";
import { UndoManager } from "../lib/UndoManager.js";
import { TableSync } from "../lib/TableSync.js";
import { LinkMatcher } from "../lib/LinkMatcher.js";
import { DetectLinksDialog } from "./DetectLinksDialog.js";
import { DocumentPickerPopup } from "./DocumentPickerPopup.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Single-table editor popout window.
 * Opened from the sidebar when a user clicks a table entry.
 * Provides formula-based row generation, inline editing, undo/redo, and auto-save.
 */
export class TableEditorWindow extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @type {Map<string, TableEditorWindow>} Track open editors by table ID */
  static _instances = new Map();

  /**
   * Open (or focus) the editor for a given RollTable.
   * @param {RollTable} table
   * @returns {TableEditorWindow}
   */
  static openForTable(table) {
    let instance = this._instances.get(table.id);
    if (instance) {
      instance.bringToTop();
      return instance;
    }
    instance = new this({ table });
    this._instances.set(table.id, instance);
    instance.render(true);
    return instance;
  }

  constructor(options = {}) {
    super(options);
    this.table = options.table;
    this.undoManager = new UndoManager();
    this.tableSync = new TableSync(this.table);

    // Take initial snapshot for revert
    this.undoManager.takeSnapshot(this._getTableState());
  }

  static DEFAULT_OPTIONS = {
    classes: ["dynamic-table-manager", "dtm-editor"],
    tag: "div",
    window: {
      title: "Table Editor",
      icon: "fas fa-table",
      resizable: true
    },
    position: {
      width: 700,
      height: 600
    },
    actions: {
      addRow: TableEditorWindow.#onAddRow,
      addRowsFromFormula: TableEditorWindow.#onAddRowsFromFormula,
      deleteRow: TableEditorWindow.#onDeleteRow,
      editDescription: TableEditorWindow.#onEditDescription,
      openDocument: TableEditorWindow.#onOpenDocument,
      rollTable: TableEditorWindow.#onRollTable,
      undo: TableEditorWindow.#onUndo,
      redo: TableEditorWindow.#onRedo,
      revertSnapshot: TableEditorWindow.#onRevertSnapshot,
      toggleLink: TableEditorWindow.#onToggleLink,
      linkAll: TableEditorWindow.#onLinkAll,
      autoFormula:  TableEditorWindow.#onAutoFormula,
      detectLinks:  TableEditorWindow.#onDetectLinks
    }
  };

  /** @override - unique ID per table */
  get id() {
    return `dtm-table-editor-${this.table.id}`;
  }

  static PARTS = {
    editor: {
      template: "modules/dynamic-table-manager/templates/table-editor.hbs"
    }
  };

  /** @override */
  get title() {
    return `Table Editor: ${this.table.name}`;
  }

  /** @override */
  async _prepareContext() {
    await this._ensureRowOrder();
    const sortedResults = this._sortedResults();
    const mappedResults = sortedResults.map((r, i) => ({
      id: r.id,
      rangeLow: r.range[0],
      rangeHigh: r.range[1],
      rangeDisplay: r.range[0] === r.range[1] ? `${r.range[0]}` : `${r.range[0]}-${r.range[1]}`,
      name: r.name,
      description: r.description,
      type: r.type,
      isText: r.type === CONST.TABLE_RESULT_TYPES.TEXT,
      typeLabel: this._getResultTypeLabel(r.type),
      documentUuid: r.documentUuid,
      img: r.img,
      weight: r.weight,
      drawn: r.drawn,
      linked: i > 0 && !!r.getFlag("dynamic-table-manager", "linked")
    }));
    const linkedAll = mappedResults.length > 1 && mappedResults.slice(1).every(r => r.linked);
    return {
      table: this.table,
      tableName: this.table.name,
      formula: this.table.formula,
      description: this.table.description,
      results: mappedResults,
      isCompound: !!this.table.getFlag("dynamic-table-manager", "isCompound"),
      linkedAll,
      canUndo: this.undoManager.canUndo(),
      canRedo: this.undoManager.canRedo(),
      resultTypeOptions: [
        { value: CONST.TABLE_RESULT_TYPES.TEXT, label: "Text" },
        { value: CONST.TABLE_RESULT_TYPES.DOCUMENT, label: "Document" }
      ]
    };
  }

  /**
   * Returns results sorted by visual order: primary by range[0], secondary by
   * the explicit order flag (tiebreaker for same-range groups), then by id.
   * @returns {TableResult[]}
   */
  _sortedResults() {
    return [...this.table.results.contents].sort((a, b) => {
      if (a.range[0] !== b.range[0]) return a.range[0] - b.range[0];
      const aOrd = a.getFlag("dynamic-table-manager", "order") ?? Number.MAX_SAFE_INTEGER;
      const bOrd = b.getFlag("dynamic-table-manager", "order") ?? Number.MAX_SAFE_INTEGER;
      if (aOrd !== bOrd) return aOrd - bOrd;
      return a.id < b.id ? -1 : 1;
    });
  }

  /**
   * Ensure every TableResult has an order flag. Runs lazily on first render
   * and re-runs after revert-to-snapshot (which can restore results without flags).
   * Concurrent calls are coalesced — only one migration runs at a time.
   */
  async _ensureRowOrder() {
    if (this._orderInitializing) return;
    const needsOrder = this.table.results.contents.filter(
      r => r.getFlag("dynamic-table-manager", "order") == null
    );
    if (needsOrder.length === 0) return;
    this._orderInitializing = true;
    try {
      const sorted = [...this.table.results.contents].sort((a, b) => a.range[0] - b.range[0]);
      await this.table.updateEmbeddedDocuments("TableResult",
        sorted.map((r, i) => ({ _id: r.id, flags: { "dynamic-table-manager": { order: i } } }))
      );
    } finally {
      this._orderInitializing = false;
    }
  }

  /**
   * Get a human-readable label for a result type.
   * @param {number} type
   * @returns {string}
   */
  _getResultTypeLabel(type) {
    switch (type) {
      case CONST.TABLE_RESULT_TYPES.TEXT: return "Text";
      case CONST.TABLE_RESULT_TYPES.DOCUMENT: return "Document";
      default: return "Text";
    }
  }

  /**
   * Calculate weight from a range — the number of values it covers.
   * e.g. [6, 8] → 3, [5, 5] → 1
   * @param {number[]} range [low, high]
   * @returns {number}
   */
  _weightFromRange(range) {
    return Math.max(1, range[1] - range[0] + 1);
  }

  /**
   * Capture the current table state for undo/snapshot purposes.
   * @returns {object}
   */
  _getTableState() {
    return {
      name: this.table.name,
      formula: this.table.formula,
      description: this.table.description,
      results: this.table.results.contents.map(r => r.toObject())
    };
  }

  // ---- Actions ----

  static async #onAddRow() {
    const existing = this.table.results.contents;
    const maxOrder = existing.length > 0
      ? Math.max(...existing.map(r => r.getFlag("dynamic-table-manager", "order") ?? -1))
      : -1;
    const lastRange = existing.length > 0
      ? Math.max(...existing.map(r => r.range[1]))
      : 0;
    const newRange = [lastRange + 1, lastRange + 1];

    const beforeState = this._getTableState();
    await this.table.createEmbeddedDocuments("TableResult", [{
      type: CONST.TABLE_RESULT_TYPES.TEXT,
      name: "",
      range: newRange,
      weight: this._weightFromRange(newRange),
      flags: { "dynamic-table-manager": { order: maxOrder + 1, linked: false } }
    }]);
    const afterState = this._getTableState();

    this.undoManager.record({ type: "addRow", before: beforeState, after: afterState });
    this.render();
  }

  static async #onAddRowsFromFormula() {
    const formula = this.table.formula;
    if (!DiceFormulaParser.isValid(formula)) {
      ui.notifications.warn("Please set a valid dice formula first (e.g., d6, 2d6, d100+5).");
      return;
    }

    const parsed = DiceFormulaParser.parse(formula);
    const rows = DiceFormulaParser.generateRows(formula);

    // Show preview dialog
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Add Rows from Formula" },
      content: `<p>Formula: <strong>${formula}</strong></p>
        <p>Range: <strong>${parsed.min}</strong> to <strong>${parsed.max}</strong></p>
        <p>This will create <strong>${rows.length}</strong> rows.</p>
        <p>Proceed?</p>`,
      rejectClose: false
    });

    if (!confirmed) return;

    const beforeState = this._getTableState();
    const newResults = rows.map(row => ({
      type: CONST.TABLE_RESULT_TYPES.TEXT,
      name: "",
      range: [row.low, row.high],
      weight: this._weightFromRange([row.low, row.high])
    }));

    await this.table.createEmbeddedDocuments("TableResult", newResults);

    // Update the table formula
    await this.table.update({ formula });

    const afterState = this._getTableState();
    this.undoManager.record({ type: "bulkAdd", before: beforeState, after: afterState });
    this.render();
  }

  static async #onDeleteRow(event, target) {
    const rowId = target.closest("[data-result-id]")?.dataset.resultId;
    if (!rowId) return;

    const beforeState = this._getTableState();
    await this.table.deleteEmbeddedDocuments("TableResult", [rowId]);
    const afterState = this._getTableState();

    this.undoManager.record({ type: "deleteRow", before: beforeState, after: afterState });
    this.render();
  }

  static async #onEditDescription(event, target) {
    const row = target.closest("[data-result-id]");
    const resultId = row?.dataset.resultId;
    if (!resultId) return;

    const result = this.table.results.get(resultId);
    if (!result) return;

    // Build a simple dialog with a textarea for the full description
    const current = result.description ?? "";
    const content = `
      <div style="display:flex; flex-direction:column; gap:6px; padding:4px;">
        <label style="font-size:11px; font-weight:bold; text-transform:uppercase; color:#999;">
          Full Description for: <em>${result.name || "Untitled"}</em>
        </label>
        <textarea name="description" rows="10" style="width:100%; resize:vertical; font-size:13px; padding:6px; box-sizing:border-box;">${current}</textarea>
      </div>`;

    const value = await foundry.applications.api.DialogV2.wait({
      window: { title: "Edit Description" },
      content,
      rejectClose: false,
      buttons: [
        {
          action: "save",
          label: "Save",
          icon: "fas fa-save",
          default: true,
          callback: (_ev, _btn, dialog) =>
            dialog.element.querySelector("[name='description']")?.value ?? ""
        },
        { action: "cancel", label: "Cancel", icon: "fas fa-times" }
      ]
    });

    if (value === null || value === "cancel") return;
    const beforeState = this._getTableState();
    await this.table.updateEmbeddedDocuments("TableResult", [{ _id: resultId, description: value }]);
    const afterState = this._getTableState();
    this.undoManager.record({ type: "editDescription", before: beforeState, after: afterState });
  }

  static async #onOpenDocument(event, target) {
    const row = target.closest("[data-result-id]");
    const resultId = row?.dataset.resultId;
    if (!resultId) return;
    const result = this.table.results.get(resultId);
    if (!result?.documentUuid) return;
    const doc = await fromUuid(result.documentUuid);
    if (!doc) return;
    if (doc instanceof RollTable) {
      TableEditorWindow.openForTable(doc);
    } else {
      doc.sheet?.render(true);
    }
  }

  static async #onRollTable() {
    // Roll the formula once, then find every result whose range contains the total.
    // If multiple results share the same range (linked rows), all of them fire.
    const roll = await new Roll(this.table.formula).evaluate();
    const rollTotal = roll.total;

    const matching = this.table.results.contents.filter(
      r => rollTotal >= r.range[0] && rollTotal <= r.range[1]
    );

    // Single or no match — delegate to native Foundry draw using the already-evaluated roll
    if (matching.length <= 1) {
      await this.table.draw({ roll });
      return;
    }

    // Multiple results share this range — draw all of them
    await this.table.updateEmbeddedDocuments("TableResult",
      matching.map(r => ({ _id: r.id, drawn: true }))
    );

    const lines = [];
    for (const result of matching) {
      if (result.documentUuid) {
        const doc = await fromUuid(result.documentUuid);
        if (doc instanceof RollTable) {
          const draw = await doc.draw({ displayChat: false });
          const names = draw.results.map(r => r.name || "???").join(", ");
          lines.push(`<strong>${doc.name}:</strong> ${names}`);
        } else if (doc) {
          lines.push(`<strong>${result.name || doc.name}</strong>`);
        }
      } else {
        lines.push(result.name || "???");
      }
    }

    await ChatMessage.create({
      content: `<div class="dtm-compound-roll"><p><em>${this.table.name}</em></p>${lines.map(l => `<p>${l}</p>`).join("")}</div>`,
      type: CONST.CHAT_MESSAGE_TYPES?.ROLL ?? 0,
      rolls: [roll]
    });
  }

  static async #onUndo() {
    if (!this.undoManager.canUndo()) return;
    const state = this.undoManager.undo();
    await this.tableSync.applyState(state);
    this.render();
  }

  static async #onRedo() {
    if (!this.undoManager.canRedo()) return;
    const state = this.undoManager.redo();
    await this.tableSync.applyState(state);
    this.render();
  }

  static async #onRevertSnapshot() {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Revert to Snapshot" },
      content: "<p>Revert this table to the state when you opened the editor? All changes will be lost.</p>",
      rejectClose: false
    });

    if (!confirmed) return;
    const state = this.undoManager.revertToSnapshot();
    await this.tableSync.applyState(state);
    this.render();
  }

  static async #onAutoFormula() {
    const count = this.table.results.size;
    if (count === 0) {
      ui.notifications.warn("Add rows first before setting the formula.");
      return;
    }
    const formula = `d${count}`;
    const beforeState = this._getTableState();
    await this.table.update({ formula });
    const afterState = this._getTableState();
    this.undoManager.record({ type: "edit_formula", before: beforeState, after: afterState });
    this.render();
  }

  static async #onDetectLinks() {
    // ── Phase 1: Source picker ────────────────────────────────────────────
    const validTypes = new Set(["Actor", "Item", "JournalEntry"]);
    const packs = game.packs.contents.filter(p => validTypes.has(p.metadata.type));
    const worldFolders = game.folders.contents.filter(
      f => validTypes.has(f.type) && !f.folder  // top-level only in picker
    );

    const packOptions = packs.map(p =>
      `<option value="pack:${p.collection}">${p.metadata.label} (${p.metadata.type})</option>`
    ).join("");
    const folderOptions = worldFolders.map(f =>
      `<option value="folder:${f.id}">${f.name} [${f.type}]</option>`
    ).join("");

    if (!packOptions && !folderOptions) {
      ui.notifications.warn("No valid compendium packs or world folders found.");
      return;
    }

    const content = `
      <div style="padding:8px; display:flex; flex-direction:column; gap:8px;">
        <label style="font-size:11px; font-weight:bold; text-transform:uppercase;
                      letter-spacing:.5px; color:#999;">Search Source</label>
        <select name="source" style="width:100%; height:30px; border:1px solid #555;
                                     border-radius:3px; padding:2px 6px; font-size:13px;
                                     background:rgba(0,0,0,.15); color:#eee;">
          ${packOptions ? `<optgroup label="Compendium Packs">${packOptions}</optgroup>` : ""}
          ${folderOptions ? `<optgroup label="World Folders">${folderOptions}</optgroup>` : ""}
        </select>
        <p style="font-size:11px; color:#888; margin:0;">Sub-folders are included automatically.</p>
      </div>`;

    const sourceValue = await foundry.applications.api.DialogV2.wait({
      window: { title: "Detect Links — Choose Source" },
      content,
      rejectClose: false,
      buttons: [
        {
          action: "pick",
          label: "Search",
          icon: "fas fa-search",
          default: true,
          callback: (_ev, _btn, dialog) =>
            dialog.element.querySelector("[name='source']")?.value ?? null
        },
        { action: "cancel", label: "Cancel", icon: "fas fa-times" }
      ]
    });

    if (!sourceValue || sourceValue === "cancel") return;

    // ── Phase 2: Load source entries ──────────────────────────────────────
    let sourceEntries;
    if (sourceValue.startsWith("pack:")) {
      const pack = game.packs.get(sourceValue.slice(5));
      if (!pack) { ui.notifications.error("Pack not found."); return; }
      ui.notifications.info("Detect Links: loading index…");
      sourceEntries = await LinkMatcher.entriesFromPack(pack);
    } else {
      const folder = game.folders.get(sourceValue.slice(7));
      if (!folder) { ui.notifications.error("Folder not found."); return; }
      sourceEntries = LinkMatcher.entriesFromFolder(folder);
    }

    if (!sourceEntries.length) {
      ui.notifications.warn("Detect Links: source has no documents.");
      return;
    }

    // ── Phase 3: Run matching ─────────────────────────────────────────────
    const textResults = this.table.results.contents.filter(
      r => r.type === CONST.TABLE_RESULT_TYPES.TEXT
    );
    if (!textResults.length) {
      ui.notifications.warn("Detect Links: table has no Text-type results.");
      return;
    }

    const matchResults = LinkMatcher.match(textResults, sourceEntries);
    if (!matchResults.length) {
      ui.notifications.info("Detect Links: no matches found.");
      return;
    }

    // ── Phase 4: Open results dialog ──────────────────────────────────────
    new DetectLinksDialog({ table: this.table, matchResults, sourceEntries, editorWindow: this }).render(true);
  }

  static async #onToggleLink(event, target) {
    const row = target.closest("[data-result-id]");
    const resultId = row?.dataset.resultId;
    if (!resultId) return;

    const sorted = this._sortedResults();
    const index = sorted.findIndex(r => r.id === resultId);
    if (index <= 0) return; // First row cannot be linked

    const currentlyLinked = !!sorted[index].getFlag("dynamic-table-manager", "linked");
    const newLinked = !currentlyLinked;

    // Compute new ranges for all rows, accounting for the toggled link state
    let currentRange = 0;
    const updates = sorted.map((r, i) => {
      const linked = i > 0 && (r.id === resultId ? newLinked : !!r.getFlag("dynamic-table-manager", "linked"));
      if (!linked) currentRange++;
      const update = { _id: r.id, range: [currentRange, currentRange], weight: 1 };
      if (r.id === resultId) update.flags = { "dynamic-table-manager": { linked: newLinked } };
      return update;
    });

    const beforeState = this._getTableState();
    await this.table.updateEmbeddedDocuments("TableResult", updates);
    const afterState = this._getTableState();
    this.undoManager.record({ type: "toggleLink", before: beforeState, after: afterState });
    this.render();
  }

  static async #onLinkAll() {
    const sorted = this._sortedResults();
    if (sorted.length <= 1) return;

    const nonFirstLinked = sorted.slice(1).every(r => !!r.getFlag("dynamic-table-manager", "linked"));
    const newLinkedState = !nonFirstLinked;

    let currentRange = 0;
    const updates = sorted.map((r, i) => {
      const linked = i > 0 && newLinkedState;
      if (!linked) currentRange++;
      return {
        _id: r.id,
        range: [currentRange, currentRange],
        weight: 1,
        flags: { "dynamic-table-manager": { linked } }
      };
    });

    const beforeState = this._getTableState();
    await this.table.updateEmbeddedDocuments("TableResult", updates);
    const afterState = this._getTableState();
    this.undoManager.record({ type: "linkAll", before: beforeState, after: afterState });
    this.render();
  }

  // ---- Inline Editing ----

  /** @override */
  _onRender(context, options) {
    const html = this.element;

    // Set type dropdown selected values — Handlebars can't compare strings reliably
    html.querySelectorAll("select[data-field='type']").forEach(select => {
      select.value = select.dataset.currentType;
    });

    // Use a single delegated change listener on the container.
    // This is attached once and never accumulates across re-renders because
    // _onRender replaces the inner HTML, giving us a fresh DOM each time.
    html.addEventListener("change", (ev) => this._onFieldChange(ev));
    html.addEventListener("keydown", (ev) => this._onKeyDown(ev));

    // Prevent Enter on single-line inputs from triggering any form submit
    html.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && ev.target.tagName === "INPUT") {
        ev.preventDefault();
        ev.stopPropagation();
        ev.target.blur(); // commit the value via the change event
      }
    });

    // Document picker: clicking the drop-target on Document-type rows
    html.querySelectorAll(".dtm-drop-target").forEach(dropTarget => {
      dropTarget.addEventListener("click", ev => {
        const row = dropTarget.closest("[data-result-id]");
        if (!row) return;
        this._openDocumentPicker(row.dataset.resultId, dropTarget);
      });
    });

    // Drag-and-drop: full row-list handling
    this._dragState = null;
    const rowList = html.querySelector(".dtm-row-list");
    if (rowList) {
      const indicator = document.createElement("div");
      indicator.classList.add("dtm-insert-indicator");
      indicator.style.display = "none";
      rowList.appendChild(indicator);

      rowList.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "link";
        this._onDragOver(ev, rowList, indicator);
      });

      rowList.addEventListener("dragleave", (ev) => {
        if (!rowList.contains(ev.relatedTarget)) {
          this._clearDragVisuals(rowList, indicator);
          this._dragState = null;
        }
      });

      rowList.addEventListener("drop", async (ev) => {
        ev.preventDefault();
        const state = this._dragState;
        this._clearDragVisuals(rowList, indicator);
        this._dragState = null;
        const data = TextEditor.getDragEventData(ev);
        if (data?.type === "Compendium") {
          await this._handleDropCompendium(data, ev);
          return;
        }
        if (!data?.uuid) return;
        if (state?.mode === "replace") {
          await this._handleDropOnRow(state.rowId, data);
        } else {
          await this._handleDropInsert(state?.insertIndex ?? -1, data);
        }
      });
    }
  }

  /**
   * Open the document picker popup for a Document-type result row.
   * @param {string} resultId
   * @param {HTMLElement} anchor  - the .dtm-drop-target element to anchor the popup to
   */
  async _openDocumentPicker(resultId, anchor) {
    const selection = await DocumentPickerPopup.open(anchor);
    if (!selection) return;

    const beforeState = this._getTableState();
    await this.table.updateEmbeddedDocuments("TableResult", [{
      _id: resultId,
      type: CONST.TABLE_RESULT_TYPES.DOCUMENT,
      documentUuid: selection.uuid,
      name: selection.name,
      img: selection.img ?? null
    }]);
    const afterState = this._getTableState();
    this.undoManager.record({ type: "editRowPicker", before: beforeState, after: afterState });
    this.render();
  }

  /**
   * Single delegated change handler — routes all field edits from one listener.
   * Attached once per render; no accumulation.
   */
  async _onFieldChange(ev) {
    const target = ev.target;
    const field = target.dataset.field;
    if (!field) return;

    // ---- Table-level fields (inside .dtm-editor-header) ----
    if (target.closest(".dtm-editor-header")) {
      const beforeState = this._getTableState();
      if (field === "name")        await this.table.update({ name: target.value });
      else if (field === "formula") await this.table.update({ formula: target.value });
      else if (field === "description") await this.table.update({ description: target.value });
      else return;
      const afterState = this._getTableState();
      this.undoManager.record({ type: `edit_${field}`, before: beforeState, after: afterState });
      return;
    }

    // ---- Row-level fields ----
    const row = target.closest("[data-result-id]");
    if (!row) return;
    const resultId = row.dataset.resultId;

    if (field === "range") {
      const range = this._parseRange(target.value.trim());
      if (!range) {
        ui.notifications.warn("Invalid range format. Use a number (5) or range (3-8).");
        this.render();
        return;
      }
      await this._updateRowRange(resultId, range);

    } else if (field === "name") {
      const beforeState = this._getTableState();
      await this.table.updateEmbeddedDocuments("TableResult", [{ _id: resultId, name: target.value }]);
      const afterState = this._getTableState();
      this.undoManager.record({ type: "editRow", before: beforeState, after: afterState });

    } else if (field === "type") {
      const newType = target.value;
      const beforeState = this._getTableState();
      await this.table.updateEmbeddedDocuments("TableResult", [{
        _id: resultId,
        type: newType,
        ...(newType === CONST.TABLE_RESULT_TYPES.TEXT ? { documentUuid: "" } : {})
      }]);
      const afterState = this._getTableState();
      this.undoManager.record({ type: "editRowType", before: beforeState, after: afterState });
      this.render();
    }
  }

  /**
   * Keyboard shortcut handler for undo/redo and column-aware Tab navigation.
   */
  _onKeyDown(ev) {
    if (ev.ctrlKey && ev.key === "z" && !ev.shiftKey) {
      ev.preventDefault();
      TableEditorWindow.#onUndo.call(this);
    } else if ((ev.ctrlKey && ev.key === "y") || (ev.ctrlKey && ev.shiftKey && ev.key === "z")) {
      ev.preventDefault();
      TableEditorWindow.#onRedo.call(this);
    } else if (ev.key === "Tab") {
      this._onColumnTab(ev);
    }
  }

  /**
   * Tab within a column (Range or Content) instead of across columns.
   *
   * Range column  — Tab/Shift+Tab jumps to the same column in the next/prev row.
   *
   * Content column — Tab cycles through a flat sequence of all focusable content
   *   items across every row in visual order:
   *     [desc-btn(row0), name-input(row0), desc-btn(row1), name-input(row1), …]
   *   One Tab steps forward, one Shift+Tab steps backward.  A "double tab" from
   *   the last item in a row (name-input) naturally lands on the desc-btn of the
   *   next row, matching the requested "double-tab to advance a row" feel.
   *   Document-type rows have no name-input, so they contribute only their btn.
   */
  _onColumnTab(ev) {
    const target = ev.target;
    const rows = [...this.element.querySelectorAll(".dtm-row-list .dtm-row")];
    const currentRow = target.closest(".dtm-row");
    if (!currentRow) return;

    const step = ev.shiftKey ? -1 : 1;

    // ── Range column ──────────────────────────────────────────────────────────
    if (target.matches("input.dtm-col-range")) {
      const idx = rows.indexOf(currentRow);
      for (let i = idx + step; i >= 0 && i < rows.length; i += step) {
        const next = rows[i].querySelector("input.dtm-col-range");
        if (next && !next.disabled) {
          ev.preventDefault();
          next.focus();
          next.select();
          return;
        }
      }
      return;
    }

    // ── Content column ────────────────────────────────────────────────────────
    const isDescBtn   = target.matches(".dtm-col-content .dtm-desc-btn");
    const isNameInput = target.matches(".dtm-col-content input[data-field='name']");
    if (!isDescBtn && !isNameInput) return;

    // Build flat ordered list: [btn, input?] per row, skipping disabled elements
    const focusables = [];
    for (const row of rows) {
      const btn   = row.querySelector(".dtm-col-content .dtm-desc-btn");
      const input = row.querySelector(".dtm-col-content input[data-field='name']");
      if (btn   && !btn.disabled)   focusables.push(btn);
      if (input && !input.disabled) focusables.push(input);
    }

    const cur = focusables.indexOf(target);
    if (cur === -1) return;

    const next = focusables[cur + step];
    if (!next) return;

    ev.preventDefault();
    next.focus();
    if (next.tagName === "INPUT") next.select();
  }

  /**
   * Parse a user-entered range string into [low, high].
   * Supports: "5", "3-8", "-3", "-5-2", "-5--2"
   * @param {string} value
   * @returns {number[]|null}
   */
  _parseRange(value) {
    // Match patterns like: "5", "-3", "3-8", "-5-2", "-5--2"
    const match = value.match(/^(-?\d+)(?:\s*-\s*(-?\d+))?$/);
    if (!match) return null;
    const low = parseInt(match[1]);
    const high = match[2] !== undefined ? parseInt(match[2]) : low;
    if (high < low) return null;
    return [low, high];
  }

  /**
   * Update a row's range with smart merge logic.
   * @param {string} resultId
   * @param {number[]} newRange [low, high]
   */
  async _updateRowRange(resultId, newRange) {
    const [newLow, newHigh] = newRange;

    // Find rows that would be consumed by this new range
    const consumed = this.table.results.filter(r => {
      if (r.id === resultId) return false;
      return r.range[0] >= newLow && r.range[1] <= newHigh;
    });

    // Smart merge: check if consumed rows have content
    if (consumed.length > 0) {
      const withContent = consumed.filter(r => r.name?.trim() || r.description?.trim());
      if (withContent.length > 0) {
        const names = withContent.map(r => `Row ${r.range[0]}-${r.range[1]}: "${r.name || r.description}"`).join("<br>");
        const confirmed = await foundry.applications.api.DialogV2.confirm({
          window: { title: "Merge Rows" },
          content: `<p>The following rows have content and will be removed:</p><p>${names}</p><p>Continue?</p>`,
          rejectClose: false
        });
        if (!confirmed) {
          this.render();
          return;
        }
      }
    }

    // Capture before state BEFORE any mutations
    const beforeState = this._getTableState();

    // Delete consumed rows
    if (consumed.length > 0) {
      await this.table.deleteEmbeddedDocuments("TableResult", consumed.map(r => r.id));
    }

    // Update the target row's range and recalculate weight
    await this.table.updateEmbeddedDocuments("TableResult", [{
      _id: resultId,
      range: [newLow, newHigh],
      weight: this._weightFromRange([newLow, newHigh])
    }]);

    const afterState = this._getTableState();
    this.undoManager.record({ type: "editRange", before: beforeState, after: afterState });
    this.render();
  }

  /**
   * Determine drag target from cursor position.
   * Top 30% of a row → insert before, bottom 30% → insert after, middle 40% → replace.
   * @param {DragEvent} ev
   * @param {HTMLElement} rowList
   * @returns {{ mode: "replace"|"insert", rowId?: string, insertIndex: number }}
   */
  _getDragTarget(ev, rowList) {
    const rows = [...rowList.querySelectorAll(".dtm-row")];
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect();
      if (ev.clientY < rect.top || ev.clientY > rect.bottom) continue;
      const relY = ev.clientY - rect.top;
      const h = rect.height;
      if (relY < h * 0.3) return { mode: "insert", insertIndex: i };
      if (relY > h * 0.7) return { mode: "insert", insertIndex: i + 1 };
      return { mode: "replace", rowId: rows[i].dataset.resultId, insertIndex: i };
    }
    // Below all rows → insert at end
    return { mode: "insert", insertIndex: rows.length };
  }

  /**
   * Update drag visuals: row highlight or insert indicator line.
   */
  _onDragOver(ev, rowList, indicator) {
    const state = this._getDragTarget(ev, rowList);
    this._dragState = state;
    const rows = [...rowList.querySelectorAll(".dtm-row")];

    // Clear existing highlights
    rows.forEach(r => r.classList.remove("dtm-drag-over"));
    indicator.style.display = "none";

    if (state.mode === "replace") {
      rows.find(r => r.dataset.resultId === state.rowId)?.classList.add("dtm-drag-over");
    } else {
      // Position the insert indicator line
      indicator.style.display = "block";
      if (state.insertIndex === 0) {
        rowList.insertBefore(indicator, rows[0] ?? null);
      } else if (state.insertIndex >= rows.length) {
        rowList.appendChild(indicator);
      } else {
        rowList.insertBefore(indicator, rows[state.insertIndex]);
      }
    }
  }

  /**
   * Clear all drag visuals.
   */
  _clearDragVisuals(rowList, indicator) {
    rowList.querySelectorAll(".dtm-drag-over").forEach(r => r.classList.remove("dtm-drag-over"));
    indicator.style.display = "none";
  }

  /**
   * Resolve a uuid-based drop into a result data object.
   * @param {object} data - drag event data
   * @returns {Promise<{type, name, img, documentUuid}|null>}
   */
  async _resolveDropData(data) {
    if (!data.uuid) return null;
    const doc = await fromUuid(data.uuid);
    if (!doc) return null;
    return {
      type: CONST.TABLE_RESULT_TYPES.DOCUMENT,
      documentUuid: data.uuid,
      name: doc.name,
      img: doc.img ?? doc.thumb ?? null
    };
  }

  /**
   * Handle a compendium drop — confirm then bulk-import all entries as new rows.
   * @param {object} data  - parsed drag event data (type "Compendium")
   * @param {DragEvent} ev - raw drag event, used as fallback to read dataTransfer directly
   */
  async _handleDropCompendium(data, ev) {
    // Foundry uses data.collection for the pack id (e.g. "world.compendia")
    let packId = data.collection || data.id || data.pack;
    if (!packId && data.metadata) {
      packId = [data.metadata.package, data.metadata.name].filter(Boolean).join(".");
    }
    if (!packId) {
      try {
        const raw = JSON.parse(ev?.dataTransfer?.getData("text/plain") ?? "{}");
        packId = raw.id || raw.pack || raw.collection;
      } catch { /* ignore parse errors */ }
    }

    if (!packId) {
      ui.notifications.warn("Could not read compendium ID from drop data.");
      return;
    }

    const pack = game.packs.get(packId);
    if (!pack) {
      ui.notifications.warn(`Compendium "${packId}" not found.`);
      return;
    }

    await pack.getIndex();
    const entries = pack.index.contents;
    const packLabel = pack.metadata.label || pack.collection;

    if (entries.length === 0) {
      ui.notifications.warn(`"${packLabel}" has no entries.`);
      return;
    }

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Import Compendium" },
      content: `<p>Add <strong>${entries.length}</strong> entr${entries.length === 1 ? "y" : "ies"} from <strong>${packLabel}</strong> to this table?</p>`,
      rejectClose: false
    });
    if (!confirmed) return;

    const existing = this.table.results.contents;
    const maxOrder = existing.length > 0
      ? Math.max(...existing.map(r => r.getFlag("dynamic-table-manager", "order") ?? -1))
      : -1;
    const lastRange = existing.length > 0
      ? Math.max(...existing.map(r => r.range[1]))
      : 0;

    const getEntryUuid = (entry) =>
      pack.getUuid ? pack.getUuid(entry._id) : `Compendium.${pack.collection}.${entry._id}`;

    const newResults = entries.map((entry, i) => ({
      type: CONST.TABLE_RESULT_TYPES.DOCUMENT,
      documentUuid: getEntryUuid(entry),
      name: entry.name,
      img: entry.img ?? null,
      range: [lastRange + i + 1, lastRange + i + 1],
      weight: 1,
      flags: { "dynamic-table-manager": { order: maxOrder + i + 1, linked: false } }
    }));

    const beforeState = this._getTableState();
    await this.table.createEmbeddedDocuments("TableResult", newResults);
    const afterState = this._getTableState();
    this.undoManager.record({ type: "importCompendium", before: beforeState, after: afterState });
    this.render();
  }

  /**
   * Handle drop onto an existing row.
   * Empty row → auto-populate. Row with content → prompt to replace.
   */
  async _handleDropOnRow(resultId, data) {
    const result = this.table.results.get(resultId);
    if (!result) return;

    const resolved = await this._resolveDropData(data);
    if (!resolved) return;

    const hasContent = result.name?.trim() || result.documentUuid;
    if (hasContent) {
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Replace Result" },
        content: `<p>Row already has content (<strong>${result.name || "linked document"}</strong>). Replace it?</p>`,
        rejectClose: false
      });
      if (!confirmed) return;
    }

    const beforeState = this._getTableState();
    await this.table.updateEmbeddedDocuments("TableResult", [{ _id: resultId, ...resolved }]);
    const afterState = this._getTableState();
    this.undoManager.record({ type: "editRowDrop", before: beforeState, after: afterState });
    this.render();
  }

  /**
   * Handle drop between rows — insert a new result at the given visual index.
   * Shifts subsequent row ranges up by 1 if there is no gap to absorb the new row.
   * @param {number} insertIndex - visual index in the sorted row list
   * @param {object} data - drag event data
   */
  async _handleDropInsert(insertIndex, data) {
    const resolved = await this._resolveDropData(data);
    if (!resolved) return;

    const sorted = this.table.results.contents.sort((a, b) => a.range[0] - b.range[0]);

    let newLow;
    if (sorted.length === 0) {
      newLow = 1;
    } else if (insertIndex <= 0) {
      // Before all rows — use one below the first row's low
      newLow = sorted[0].range[0] - 1;
    } else if (insertIndex >= sorted.length) {
      // After all rows — use one above the last row's high
      newLow = sorted[sorted.length - 1].range[1] + 1;
    } else {
      const prev = sorted[insertIndex - 1];
      const next = sorted[insertIndex];
      const gap = next.range[0] - prev.range[1];
      if (gap > 1) {
        // There's a natural gap — use the first number in it
        newLow = prev.range[1] + 1;
      } else {
        // No gap — insert and shift all subsequent rows up by 1
        newLow = prev.range[1] + 1;
        const toShift = sorted.slice(insertIndex);
        const beforeState = this._getTableState();
        await this.table.updateEmbeddedDocuments("TableResult",
          toShift.map(r => ({ _id: r.id, range: [r.range[0] + 1, r.range[1] + 1] }))
        );
        const afterState = this._getTableState();
        this.undoManager.record({ type: "shiftRanges", before: beforeState, after: afterState });
      }
    }

    const newRange = [newLow, newLow];
    const beforeState = this._getTableState();
    await this.table.createEmbeddedDocuments("TableResult", [{
      ...resolved,
      range: newRange,
      weight: this._weightFromRange(newRange)
    }]);
    const afterState = this._getTableState();
    this.undoManager.record({ type: "insertRowDrop", before: beforeState, after: afterState });
    this.render();
  }

  /** @override */
  async close(options = {}) {
    TableEditorWindow._instances.delete(this.table.id);
    return super.close(options);
  }
}
