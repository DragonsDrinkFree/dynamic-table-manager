import { UndoManager } from "../lib/UndoManager.js";
import { JournalTemplateRoller } from "../lib/JournalTemplateRoller.js";
import { DocumentPickerPopup } from "./DocumentPickerPopup.js";
import { JournalPagePickerPopup } from "./JournalPagePickerPopup.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const DIE_OPTIONS = ["d4", "d6", "d8", "d10", "d12", "d20", "d100"];

/**
 * Editor for Journal Template tables.
 * A Journal Template holds a list of key→sourceTable mappings with trigger
 * modes, plus a template JournalEntryPage containing {{KEY}} placeholders.
 * Rolling the template generates a new journal page with all values filled in.
 */
export class JournalTemplateEditorWindow extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @type {Map<string, JournalTemplateEditorWindow>} */
  static _instances = new Map();

  static openForTable(table) {
    let instance = this._instances.get(table.id);
    if (instance) { instance.bringToTop(); return instance; }
    instance = new this({ table });
    this._instances.set(table.id, instance);
    instance.render(true);
    return instance;
  }

  constructor(options = {}) {
    super(options);
    this.table = options.table;
    this.undoManager = new UndoManager();
    this.undoManager.takeSnapshot(this._getState());
  }

  static DEFAULT_OPTIONS = {
    classes: ["dynamic-table-manager", "dtm-jt-editor-window"],
    tag: "div",
    window: {
      title: "Journal Template Editor",
      icon: "fas fa-scroll",
      resizable: true
    },
    position: { width: 720, height: 520 },
    actions: {
      addKey:            JournalTemplateEditorWindow.#onAddKey,
      deleteKey:         JournalTemplateEditorWindow.#onDeleteKey,
      pickSourceTable:   JournalTemplateEditorWindow.#onPickSourceTable,
      pickTemplatePage:  JournalTemplateEditorWindow.#onPickTemplatePage,
      pickOutputJournal: JournalTemplateEditorWindow.#onPickOutputJournal,
      clearOutputJournal:JournalTemplateEditorWindow.#onClearOutputJournal,
      rollTemplate:      JournalTemplateEditorWindow.#onRollTemplate,
      undo:              JournalTemplateEditorWindow.#onUndo,
      redo:              JournalTemplateEditorWindow.#onRedo,
      copyUuid:          JournalTemplateEditorWindow.#onCopyUuid
    }
  };

  get id() { return `dtm-jt-editor-${this.table.id}`; }

  static PARTS = {
    editor: { template: "modules/dynamic-table-manager/templates/journal-template-editor.hbs" }
  };

  get title() { return `Journal Template: ${this.table.name}`; }

  // ---- Context ---------------------------------------------------------------

  /** @override */
  async _prepareContext() {
    const sortedRows = this._sortedRows();
    const templatePageUuid = this.table.getFlag("dynamic-table-manager", "templatePageUuid") ?? null;
    const outputJournalId  = this.table.getFlag("dynamic-table-manager", "outputJournalId") ?? null;

    let templatePageName = null;
    if (templatePageUuid) {
      const page = await fromUuid(templatePageUuid).catch(() => null);
      if (page) templatePageName = `${page.parent?.name ?? ""} — ${page.name}`;
    }

    const outputJournalName = outputJournalId
      ? (game.journal.get(outputJournalId)?.name ?? null)
      : null;

    const keys = await Promise.all(sortedRows.map(async r => {
      const mode = r.getFlag("dynamic-table-manager", "mode") ?? "guaranteed";
      const die  = r.getFlag("dynamic-table-manager", "die") ?? "d6";

      let tableName = null;
      if (r.documentUuid) {
        const t = await fromUuid(r.documentUuid).catch(() => null);
        tableName = t?.name ?? null;
      }

      return {
        id:           r.id,
        key:          r.name ?? "",
        tableUuid:    r.documentUuid ?? null,
        tableName,
        mode,
        isGuaranteed: mode === "guaranteed",
        isPercent:    mode === "percent",
        isDice:       mode === "dice",
        percent:      r.getFlag("dynamic-table-manager", "percent") ?? 50,
        die,
        triggerRange: r.getFlag("dynamic-table-manager", "triggerRange") ?? "1",
        dieOptions:   DIE_OPTIONS.map(d => ({ value: d, label: d, selected: d === die }))
      };
    }));

    // Build per-row dieOptions context — Handlebars needs it inside each key
    // (already embedded above via dieOptions on each key object)

    return {
      tableName: this.table.name,
      templatePageName,
      templatePageUuid,
      outputJournalName,
      outputJournalId,
      keys,
      dieOptions: DIE_OPTIONS.map(d => ({ value: d, label: d })),
      canUndo: this.undoManager.canUndo(),
      canRedo: this.undoManager.canRedo()
    };
  }

  // ---- Render ----------------------------------------------------------------

  /** @override */
  _onRender(_context, _options) {
    const html = this.element;

    // Inject copy-UUID button directly onto the title bar (before the "..." overflow menu)
    const toggleBtn = html.querySelector('.window-header [data-action="toggleControls"]');
    if (toggleBtn && !html.querySelector('.window-header [data-action="copyUuid"]')) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "header-control fa-solid fa-passport icon";
      btn.dataset.action = "copyUuid";
      btn.dataset.tooltip = "Copy UUID";
      btn.setAttribute("aria-label", "Copy UUID");
      toggleBtn.before(btn);
    }

    html.addEventListener("change", ev => this._onFieldChange(ev));
    html.addEventListener("keydown", ev => this._onKeyDown(ev));

    // Prevent Enter on inputs from bubbling
    html.addEventListener("keydown", ev => {
      if (ev.key === "Enter" && ev.target.tagName === "INPUT") {
        ev.preventDefault();
        ev.stopPropagation();
        ev.target.blur();
      }
    });
  }

  // ---- Field change ----------------------------------------------------------

  async _onFieldChange(ev) {
    const target = ev.target;
    const field  = target.dataset.field;
    if (!field) return;

    // Table-level name
    if (target.closest(".dtm-editor-header") && field === "name") {
      const before = this._getState();
      await this.table.update({ name: target.value });
      this._recordUndo("editName", before);
      return;
    }

    // Key-row fields
    const row = target.closest("[data-key-id]");
    if (!row) return;
    const resultId = row.dataset.keyId;

    const before = this._getState();

    if (field === "key") {
      await this.table.updateEmbeddedDocuments("TableResult", [{ _id: resultId, name: target.value }]);

    } else if (field === "mode") {
      await this.table.updateEmbeddedDocuments("TableResult", [{
        _id: resultId,
        flags: { "dynamic-table-manager": { mode: target.value } }
      }]);
      this._recordUndo("editMode", before);
      this.render();
      return;

    } else if (field === "percent") {
      const val = Math.max(1, Math.min(100, parseInt(target.value) || 50));
      await this.table.updateEmbeddedDocuments("TableResult", [{
        _id: resultId,
        flags: { "dynamic-table-manager": { percent: val } }
      }]);

    } else if (field === "die") {
      await this.table.updateEmbeddedDocuments("TableResult", [{
        _id: resultId,
        flags: { "dynamic-table-manager": { die: target.value } }
      }]);

    } else if (field === "triggerRange") {
      await this.table.updateEmbeddedDocuments("TableResult", [{
        _id: resultId,
        flags: { "dynamic-table-manager": { triggerRange: target.value } }
      }]);
    }

    this._recordUndo(`edit_${field}`, before);
  }

  // ---- Keyboard --------------------------------------------------------------

  _onKeyDown(ev) {
    if (ev.ctrlKey && ev.key === "z" && !ev.shiftKey) {
      ev.preventDefault();
      JournalTemplateEditorWindow.#onUndo.call(this);
    } else if ((ev.ctrlKey && ev.key === "y") || (ev.ctrlKey && ev.shiftKey && ev.key === "z")) {
      ev.preventDefault();
      JournalTemplateEditorWindow.#onRedo.call(this);
    }
  }

  // ---- Actions ---------------------------------------------------------------

  static async #onAddKey() {
    const rows = this._sortedRows();
    const maxOrder = rows.length > 0
      ? Math.max(...rows.map(r => r.getFlag("dynamic-table-manager", "order") ?? -1))
      : -1;
    const nextRange = rows.length + 1;

    const before = this._getState();
    await this.table.createEmbeddedDocuments("TableResult", [{
      type: CONST.TABLE_RESULT_TYPES.DOCUMENT,
      name: "",
      range: [nextRange, nextRange],
      weight: 1,
      flags: { "dynamic-table-manager": { mode: "guaranteed", order: maxOrder + 1 } }
    }]);
    this._recordUndo("addKey", before);
    this.render();
  }

  static async #onDeleteKey(_ev, target) {
    const row = target.closest("[data-key-id]");
    if (!row) return;
    const before = this._getState();
    await this.table.deleteEmbeddedDocuments("TableResult", [row.dataset.keyId]);
    this._recordUndo("deleteKey", before);
    this.render();
  }

  static async #onPickSourceTable(_ev, target) {
    const row = target.closest("[data-key-id]");
    if (!row) return;
    const resultId = row.dataset.keyId;
    const anchorRect = target.getBoundingClientRect();

    const selection = await DocumentPickerPopup.open(anchorRect, "", ["RollTable"]);
    if (!selection) return;

    const before = this._getState();
    await this.table.updateEmbeddedDocuments("TableResult", [{
      _id: resultId,
      documentUuid: selection.uuid,
      name: this.table.results.get(resultId)?.name || selection.name
    }]);
    this._recordUndo("pickSource", before);
    this.render();
  }

  static async #onPickTemplatePage(_ev, target) {
    const anchorRect = target.getBoundingClientRect();
    const selection = await JournalPagePickerPopup.open(anchorRect);
    if (!selection) return;

    const before = this._getState();
    await this.table.setFlag("dynamic-table-manager", "templatePageUuid", selection.uuid);
    this._recordUndo("pickTemplate", before);
    this.render();
  }

  static async #onPickOutputJournal(_ev, target) {
    const anchorRect = target.getBoundingClientRect();
    const selection = await DocumentPickerPopup.open(anchorRect, "", ["JournalEntry"]);
    if (!selection) return;

    // DocumentPickerPopup returns uuid; we need the world doc id
    const doc = await fromUuid(selection.uuid).catch(() => null);
    if (!doc) return;

    const before = this._getState();
    await this.table.setFlag("dynamic-table-manager", "outputJournalId", doc.id);
    this._recordUndo("pickOutput", before);
    this.render();
  }

  static async #onClearOutputJournal() {
    const before = this._getState();
    await this.table.unsetFlag("dynamic-table-manager", "outputJournalId");
    this._recordUndo("clearOutput", before);
    this.render();
  }

  static async #onRollTemplate() {
    await JournalTemplateRoller.roll(this.table);
  }

  static async #onUndo() {
    const state = this.undoManager.undo();
    if (!state) return;
    await this._applyState(state);
    this.render();
  }

  static async #onRedo() {
    const state = this.undoManager.redo();
    if (!state) return;
    await this._applyState(state);
    this.render();
  }

  static async #onCopyUuid() {
    await game.clipboard.copyPlainText(this.table.uuid);
    ui.notifications.info(game.i18n.format("DOCUMENT.IdCopied", {
      label: this.table.name, type: "uuid", id: this.table.uuid
    }));
  }

  // ---- State helpers ---------------------------------------------------------

  _sortedRows() {
    return [...this.table.results.contents].sort((a, b) => {
      const ao = a.getFlag("dynamic-table-manager", "order") ?? 0;
      const bo = b.getFlag("dynamic-table-manager", "order") ?? 0;
      return ao - bo || a.id.localeCompare(b.id);
    });
  }

  _getState() {
    return {
      name: this.table.name,
      templatePageUuid: this.table.getFlag("dynamic-table-manager", "templatePageUuid") ?? null,
      outputJournalId:  this.table.getFlag("dynamic-table-manager", "outputJournalId") ?? null,
      results: this.table.results.contents.map(r => r.toObject())
    };
  }

  /** Record an undo entry, capturing after-state automatically. */
  _recordUndo(type, before) {
    this.undoManager.record({ type, before, after: this._getState() });
  }

  async _applyState(state) {
    await this.table.update({ name: state.name });
    await this.table.setFlag("dynamic-table-manager", "templatePageUuid", state.templatePageUuid ?? null);

    if (state.outputJournalId) {
      await this.table.setFlag("dynamic-table-manager", "outputJournalId", state.outputJournalId);
    } else {
      await this.table.unsetFlag("dynamic-table-manager", "outputJournalId");
    }

    const existingIds = this.table.results.contents.map(r => r.id);
    if (existingIds.length) {
      await this.table.deleteEmbeddedDocuments("TableResult", existingIds);
    }
    if (state.results.length) {
      const clean = state.results.map(r => { const c = { ...r }; delete c._id; return c; });
      await this.table.createEmbeddedDocuments("TableResult", clean);
    }
  }

  /** @override */
  _onClose() {
    JournalTemplateEditorWindow._instances.delete(this.table.id);
  }
}
