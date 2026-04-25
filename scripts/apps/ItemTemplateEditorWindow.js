import { UndoManager } from "../lib/UndoManager.js";
import { ItemTemplateRoller } from "../lib/ItemTemplateRoller.js";
import { DocumentPickerPopup } from "./DocumentPickerPopup.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const MODULE_ID = "dynamic-table-manager";

// ═══════════════════════════════════════════════════════════════════════════
//  Module-level constants
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG = () => ({
  itemType: "",
  outputFolderId: null,
  baseItem: { mode: "none", uuid: null, tableUuid: null },
  img: { mode: "none", path: null },
  actions: []
});

const WRITE_MODES = [
  ["overwrite", "Overwrite"],
  ["append",    "Append"],
  ["prepend",   "Prepend"],
  ["add",       "Add (INT)"]
];

const APPEND_OPTIONS = [
  ["newline", "↵ Line"], ["space", "Space"], ["comma", "Comma"],
  ["dash",    "Dash"],   ["colon", "Colon"], ["list",  "List"],
  ["custom",  "Custom"]
];

const TABLE_FIELDS = [
  ["name",        "Name"],
  ["description", "Desc"],
  ["both",        "Both"]
];

const BASE_ITEM_MODE_LABELS = { none: "None", fixed: "Fixed Item", table: "Roll from Table" };
const IMG_MODE_LABELS       = { none: "None", fixed: "Fixed Path", folder: "Random from Folder" };

// ═══════════════════════════════════════════════════════════════════════════
//  Pure helpers
// ═══════════════════════════════════════════════════════════════════════════

function _esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Migrate older shapes of the action tree to the current format, in place. Idempotent. */
function migrateActions(actions) {
  for (const action of (actions ?? [])) {
    // Attribute: old source-object → flat fields
    if (action.type === "attribute" && action.source && !action.sourceType) {
      const src = action.source;
      if (src.type === "table") {
        action.sourceType = "table";
        action.tableUuid  = src.tableUuid ?? null;
        action.tableName  = src.tableName ?? null;
      } else {
        action.sourceType = "text";
        action.value      = src.value ?? "";
      }
      delete action.source;
    }

    // Conditional: old condition+then/else → multi-branch
    if (action.type === "conditional" && action.condition && !action.branches) {
      const cond = action.condition;
      if (cond.mode === "percent") {
        const threshold = cond.percent ?? 50;
        action.die = "d100";
        action.branches = [
          { id: foundry.utils.randomID(), label: "THEN", low: 1, high: threshold, actions: action.thenActions ?? [] },
          { id: foundry.utils.randomID(), label: "ELSE", low: threshold + 1, high: 100, actions: action.elseActions ?? [] }
        ];
      } else {
        action.die = cond.die ?? "d6";
        action.branches = [
          { id: foundry.utils.randomID(), label: "THEN", low: cond.low ?? 1, high: cond.high ?? 1, actions: action.thenActions ?? [] }
        ];
        if (action.elseActions?.length) {
          action.branches.push({ id: foundry.utils.randomID(), label: "ELSE", isElse: true, actions: action.elseActions });
        }
      }
      delete action.condition;
      delete action.thenActions;
      delete action.elseActions;
    }

    migrateActions(action.children);
    for (const branch of (action.branches ?? [])) migrateActions(branch.actions);
  }
}

function flattenSchema(fields, prefix) {
  const paths = [];
  for (const [key, field] of Object.entries(fields)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (field?.fields) paths.push(...flattenSchema(field.fields, path));
    else paths.push({ path, label: path });
  }
  return paths;
}

function flattenObject(obj, prefix) {
  const paths = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      paths.push(...flattenObject(value, path));
    } else {
      paths.push({ path, label: path });
    }
  }
  return paths;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Editor Window
// ═══════════════════════════════════════════════════════════════════════════

export class ItemTemplateEditorWindow extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @type {Map<string, ItemTemplateEditorWindow>} */
  static _instances = new Map();

  static openForTable(table) {
    let inst = this._instances.get(table.id);
    if (inst) { inst.bringToTop(); return inst; }
    inst = new this({ table });
    this._instances.set(table.id, inst);
    inst.render(true);
    return inst;
  }

  constructor(options = {}) {
    super(options);
    this.table = options.table;
    this.undoManager = new UndoManager();
    this._attributePaths = [];
    this._drag = null;
    this._dropTarget = null;
    /** @type {Set<string>} IDs of collapsed groups/conditionals — ephemeral UI state. */
    this._collapsed = new Set();
    /** @type {number|null} Scroll position captured before a full render so we can restore it after. */
    this._savedScrollTop = null;
    // Display name caches keyed by uuid — avoid re-fetching on every render.
    this._nameCache = {
      base:      { uuid: null, name: null },
      baseTable: { uuid: null, name: null }
    };
    this.undoManager.takeSnapshot(this._getState());
  }

  static DEFAULT_OPTIONS = {
    classes: ["dynamic-table-manager", "dtm-it-window"],
    tag: "div",
    window: { title: "Item Template Editor", icon: "fas fa-hat-wizard", resizable: true },
    position: { width: 1060, height: 700 },
    actions: {
      addConditional:     ItemTemplateEditorWindow.#onAddConditional,
      addGroup:           ItemTemplateEditorWindow.#onAddGroup,
      addBranch:          ItemTemplateEditorWindow.#onAddBranch,
      deleteBranch:       ItemTemplateEditorWindow.#onDeleteBranch,
      deleteAction:       ItemTemplateEditorWindow.#onDeleteAction,
      duplicateAction:    ItemTemplateEditorWindow.#onDuplicateAction,
      toggleCollapse:     ItemTemplateEditorWindow.#onToggleCollapse,
      addAttributeHere:   ItemTemplateEditorWindow.#onAddAttributeHere,
      addConditionalHere: ItemTemplateEditorWindow.#onAddConditional,
      addGroupHere:       ItemTemplateEditorWindow.#onAddGroup,
      pickAttrTable:      ItemTemplateEditorWindow.#onPickAttrTable,
      pickOutputFolder:   ItemTemplateEditorWindow.#onPickOutputFolder,
      pickBaseItem:       ItemTemplateEditorWindow.#onPickBaseItem,
      pickBaseTable:      ItemTemplateEditorWindow.#onPickBaseTable,
      clearBaseItem:      ItemTemplateEditorWindow.#onClearBaseItem,
      pickImgPath:        ItemTemplateEditorWindow.#onPickImgPath,
      pickImgFolder:      ItemTemplateEditorWindow.#onPickImgFolder,
      generate:           ItemTemplateEditorWindow.#onGenerate,
      undo:               ItemTemplateEditorWindow.#onUndo,
      redo:               ItemTemplateEditorWindow.#onRedo,
      copyUuid:           ItemTemplateEditorWindow.#onCopyUuid
    }
  };

  static PARTS = {
    editor: { template: "modules/dynamic-table-manager/templates/item-template-editor.hbs" }
  };

  get id()    { return `dtm-it-editor-${this.table.id}`; }
  get title() { return `Item Template: ${this.table.name}`; }

  /** Capture scroll before a full render so `_onRender` can restore it. */
  render(...args) {
    const tree = this.element?.querySelector?.(".dtm-it-tree");
    if (tree) this._savedScrollTop = tree.scrollTop;
    return super.render(...args);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Config I/O
  // ─────────────────────────────────────────────────────────────────────────

  _getConfig() {
    const config = foundry.utils.deepClone(
      this.table.getFlag(MODULE_ID, "itemTemplateConfig") ?? DEFAULT_CONFIG()
    );
    migrateActions(config.actions);
    return config;
  }

  async _saveConfig(config) {
    await this.table.setFlag(MODULE_ID, "itemTemplateConfig", config);
  }

  _getState() {
    return { name: this.table.name, config: this._getConfig() };
  }

  async _applyState(state) {
    await this.table.update({ name: state.name });
    await this.table.setFlag(MODULE_ID, "itemTemplateConfig", state.config);
  }

  /**
   * Central edit pipeline.
   * - Snapshots current state
   * - Clones config
   * - Applies `mutate` (sync or async)
   * - Persists, records undo entry
   * - Updates DOM per `render` option
   *
   * @param {(cfg: object) => (void|Promise<void>)} mutate
   * @param {object}  [opts]
   * @param {"full"|"row"|"none"} [opts.render="full"]
   * @param {string}  [opts.rowId]   Required when render="row"
   */
  async _editConfig(mutate, { render = "full", rowId = null } = {}) {
    const flag = this.table.getFlag(MODULE_ID, "itemTemplateConfig") ?? DEFAULT_CONFIG();

    const before = { name: this.table.name, config: foundry.utils.deepClone(flag) };
    migrateActions(before.config.actions);

    const config = foundry.utils.deepClone(flag);
    migrateActions(config.actions);

    await mutate(config);

    await this._saveConfig(config);
    this.undoManager.record({ before, after: { name: this.table.name, config } });

    if (render === "full") this.render();
    else if (render === "row" && rowId) this._rerenderRow(config, rowId);
  }

  /** Replace a single attribute row's DOM in place — avoids full tree re-render. */
  _rerenderRow(config, rowId) {
    const oldRow = this.element?.querySelector(`.dtm-it-action-row[data-action-id="${CSS.escape(rowId)}"]`);
    if (!oldRow) return;
    const ref = this._findAction(config.actions, rowId);
    if (!ref) return;
    const depth = parseInt(oldRow.dataset.depth ?? "0", 10) || 0;
    const parentId = oldRow.dataset.parentId || null;
    const parentSection = oldRow.dataset.parentSection || null;
    const tmp = document.createElement("div");
    tmp.innerHTML = this._renderAttrRow(ref.action, parentId, parentSection, depth);
    oldRow.replaceWith(tmp.firstElementChild);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Action tree — unified visitor
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * DFS walk of the action tree. Visitor receives `{action, array, index, parent}`
   * and may return "stop" to halt or "remove" to splice the action and halt.
   * @returns {boolean} true if visitor stopped/removed
   */
  _visitActions(actions, visitor, parent = null) {
    if (!actions) return false;
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const ctrl = visitor({ action, array: actions, index: i, parent });
      if (ctrl === "remove") { actions.splice(i, 1); return true; }
      if (ctrl === "stop")   return true;
      if (this._visitActions(action.children, visitor, action)) return true;
      for (const branch of (action.branches ?? [])) {
        if (this._visitActions(branch.actions, visitor, action)) return true;
      }
    }
    return false;
  }

  _findAction(actions, id) {
    let found = null;
    this._visitActions(actions, ctx => {
      if (ctx.action.id === id) { found = ctx; return "stop"; }
    });
    return found;
  }

  _containsId(action, id) {
    if (!action) return false;
    if (action.id === id) return true;
    let match = false;
    const probe = ctx => { if (ctx.action.id === id) { match = true; return "stop"; } };
    this._visitActions(action.children, probe);
    if (match) return true;
    for (const branch of (action.branches ?? [])) {
      this._visitActions(branch.actions, probe);
      if (match) return true;
    }
    return false;
  }

  _removeAction(rootActions, id) {
    return this._visitActions(rootActions, ctx => ctx.action.id === id ? "remove" : undefined);
  }

  _extractAction(rootActions, id) {
    let extracted = null;
    this._visitActions(rootActions, ctx => {
      if (ctx.action.id === id) {
        extracted = ctx.array.splice(ctx.index, 1)[0];
        return "stop";
      }
    });
    return extracted;
  }

  _resolveTargetArray(rootActions, parentId, parentSection) {
    if (!parentId) return rootActions;
    const ref = this._findAction(rootActions, parentId);
    if (!ref) return null;
    const parent = ref.action;
    if (parent.type === "group")       return parent.children ?? (parent.children = []);
    if (parent.type === "conditional") {
      const branch = (parent.branches ?? []).find(b => b.id === parentSection);
      return branch ? (branch.actions ?? (branch.actions = [])) : null;
    }
    return null;
  }

  /** Deep-clone an action subtree, assigning fresh IDs to the clone and every descendant. */
  _cloneActionWithNewIds(action) {
    const dup = foundry.utils.deepClone(action);
    const reassign = (act) => {
      act.id = foundry.utils.randomID();
      for (const child of (act.children ?? [])) reassign(child);
      for (const branch of (act.branches ?? [])) {
        branch.id = foundry.utils.randomID();
        for (const child of (branch.actions ?? [])) reassign(child);
      }
    };
    reassign(dup);
    return dup;
  }

  _moveAction(rootActions, actionId, targetParentId, targetParentSection, insertIndex) {
    if (targetParentId) {
      if (targetParentId === actionId) return false;
      const ref = this._findAction(rootActions, actionId);
      if (ref && this._containsId(ref.action, targetParentId)) return false;
    }

    const extracted = this._extractAction(rootActions, actionId);
    if (!extracted) return false;

    const targetArr = targetParentId
      ? this._resolveTargetArray(rootActions, targetParentId, targetParentSection)
      : rootActions;

    if (!targetArr) { rootActions.push(extracted); return false; }

    const idx = Math.min(Math.max(0, insertIndex), targetArr.length);
    targetArr.splice(idx, 0, extracted);
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Helper mutators (used by _FIELD_HANDLERS and #onXxx)
  // ─────────────────────────────────────────────────────────────────────────

  _mutateAction(cfg, id, fn) {
    const ref = this._findAction(cfg.actions, id);
    if (ref) fn(ref.action);
  }

  _mutateBranch(cfg, id, branchId, fn) {
    const ref = this._findAction(cfg.actions, id);
    if (!ref) return;
    const branch = (ref.action.branches ?? []).find(b => b.id === branchId);
    if (branch) fn(branch);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Context (Handlebars)
  // ─────────────────────────────────────────────────────────────────────────

  async _prepareContext() {
    const config = this._getConfig();

    const itemTypes = (game.documentTypes?.Item ?? [])
      .filter(t => t !== "base")
      .map(t => ({ value: t, label: t, selected: t === config.itemType }));

    const outputFolderName = config.outputFolderId
      ? (game.folders.get(config.outputFolderId)?.name ?? config.outputFolderId)
      : null;

    const baseItemName = (config.baseItem.mode === "fixed")
      ? await this._resolveName("base", config.baseItem.uuid)
      : null;
    const baseTableName = (config.baseItem.mode === "table")
      ? await this._resolveName("baseTable", config.baseItem.tableUuid)
      : null;

    if (!this._attributePaths.length && config.itemType) {
      await this._loadAttributePaths(config.itemType);
    }

    const actionTreeHtml = await this._buildTreeHtml(config.actions, null, null, 0);

    const baseItemModes = Object.entries(BASE_ITEM_MODE_LABELS)
      .map(([value, label]) => ({ value, label, selected: config.baseItem.mode === value }));
    const imgModes = Object.entries(IMG_MODE_LABELS)
      .map(([value, label]) => ({ value, label, selected: config.img.mode === value }));

    return {
      tableName: this.table.name,
      config,
      itemTypes,
      outputFolderName,
      baseItemName,
      baseTableName,
      baseItemModes,
      imgModes,
      actionTreeHtml,
      canUndo: this.undoManager.canUndo(),
      canRedo: this.undoManager.canRedo()
    };
  }

  async _resolveName(kind, uuid) {
    if (!uuid) return null;
    const cache = this._nameCache[kind];
    if (cache.uuid === uuid) return cache.name;
    const doc = await fromUuid(uuid).catch(() => null);
    const name = doc?.name ?? "(not found)";
    this._nameCache[kind] = { uuid, name };
    return name;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Tree HTML builders
  // ─────────────────────────────────────────────────────────────────────────

  async _buildTreeHtml(actions, parentId, parentSection, depth) {
    const parts = [];
    for (const action of (actions ?? [])) {
      if      (action.type === "attribute")   parts.push(this._renderAttrRow(action, parentId, parentSection, depth));
      else if (action.type === "group")       parts.push(await this._renderGroupBlock(action, parentId, parentSection, depth));
      else if (action.type === "conditional") parts.push(await this._renderConditionalBlock(action, parentId, parentSection, depth));
    }
    return parts.join("\n");
  }

  _renderAttrRow(action, parentId, parentSection, depth) {
    const id        = _esc(action.id);
    const pid       = _esc(parentId ?? "");
    const ps        = _esc(parentSection ?? "");
    const path      = _esc(action.path ?? "");
    const writeMode = action.writeMode ?? "overwrite";
    const sourceType = action.sourceType ?? "text";
    const indent    = depth * 20;

    const writeOpts = WRITE_MODES
      .map(([v, l]) => `<option value="${v}" ${writeMode === v ? "selected" : ""}>${l}</option>`)
      .join("");

    let appendHtml = "";
    if (writeMode === "append" || writeMode === "prepend") {
      const appendMode = action.appendMode ?? "newline";
      const opts = APPEND_OPTIONS
        .map(([v, l]) => `<option value="${v}" ${appendMode === v ? "selected" : ""}>${l}</option>`)
        .join("");
      const customSep = appendMode === "custom"
        ? `<input class="dtm-it-col-sep" type="text" data-field="attrAppendSeparator" data-action-id="${id}" value="${_esc(action.appendSeparator ?? "")}" placeholder="Sep…" title="Custom separator" />`
        : "";
      appendHtml = `<select class="dtm-it-col-append" data-field="attrAppendMode" data-action-id="${id}" title="Separator">${opts}</select>${customSep}`;
    }

    let valueHtml;
    if (sourceType === "text") {
      valueHtml = `<input class="dtm-it-col-value" type="text" data-field="attrValue" data-action-id="${id}" value="${_esc(action.value ?? "")}" placeholder="Value…" />`;
    } else {
      const tableField = action.tableField ?? "name";
      const tfOpts = TABLE_FIELDS
        .map(([v, l]) => `<option value="${v}" ${tableField === v ? "selected" : ""}>${l}</option>`)
        .join("");
      valueHtml = `<select class="dtm-it-col-tfield" data-field="attrTableField" data-action-id="${id}" title="Field to extract from rolled result">${tfOpts}</select>
         <span class="dtm-it-table-name dtm-it-col-value" title="${_esc(action.tableName) || "No table"}">${action.tableName ? _esc(action.tableName) : "<em>No table</em>"}</span>
         <button type="button" class="dtm-icon-btn" data-action="pickAttrTable" data-action-id="${id}" title="Pick table"><i class="fas fa-table"></i></button>`;
    }

    return `<div class="dtm-it-action-row" data-action-id="${id}" data-parent-id="${pid}" data-parent-section="${ps}" data-depth="${depth}" style="padding-left:${indent}px">
  <span class="dtm-drag-handle" data-drag-id="${id}" title="Drag to reorder"><i class="fas fa-grip-vertical"></i></span>
  <input class="dtm-it-col-path" type="text" data-field="attrPath" data-action-id="${id}" value="${path}" placeholder="attribute.path" title="${path}" />
  <select class="dtm-it-col-wmode" data-field="attrWriteMode" data-action-id="${id}" title="Write mode">${writeOpts}</select>
  ${appendHtml}
  <span class="dtm-it-col-divider" aria-hidden="true"></span>
  <select class="dtm-it-col-srctype" data-field="attrSourceType" data-action-id="${id}" title="Source type">
    <option value="text"  ${sourceType === "text"  ? "selected" : ""}>Text</option>
    <option value="table" ${sourceType === "table" ? "selected" : ""}>Table</option>
  </select>
  ${valueHtml}
  <button type="button" class="dtm-icon-btn dtm-danger" data-action="deleteAction" data-action-id="${id}" title="Remove"><i class="fas fa-trash"></i></button>
</div>`;
  }

  async _renderGroupBlock(action, parentId, parentSection, depth) {
    const id    = _esc(action.id);
    const pid   = _esc(parentId ?? "");
    const ps    = _esc(parentSection ?? "");
    const label = _esc(action.label ?? "Group");
    const indent      = depth * 20;
    const childIndent = (depth + 1) * 20;
    const childrenHtml = await this._buildTreeHtml(action.children ?? [], action.id, null, depth + 1);

    return `<div class="dtm-it-block dtm-it-group-block" data-action-id="${id}" data-parent-id="${pid}" data-parent-section="${ps}">
  <div class="dtm-it-block-header" style="padding-left:${indent}px">
    <span class="dtm-drag-handle" data-drag-id="${id}" title="Drag to reorder"><i class="fas fa-grip-vertical"></i></span>
    <span class="dtm-it-collapse-toggle" data-action="toggleCollapse" data-action-id="${id}" title="Collapse / expand">
      <i class="fas fa-caret-down dtm-it-collapse-chevron"></i>
      <i class="fas fa-layer-group dtm-it-block-icon"></i>
    </span>
    <input class="dtm-it-col-label" type="text" data-field="groupLabel" data-action-id="${id}" value="${label}" placeholder="Group label…" />
    <button type="button" class="dtm-icon-btn"            data-action="duplicateAction" data-action-id="${id}" title="Duplicate group (with children)"><i class="fas fa-clone"></i></button>
    <button type="button" class="dtm-icon-btn dtm-danger" data-action="deleteAction"    data-action-id="${id}" title="Remove group"><i class="fas fa-trash"></i></button>
  </div>
  <div class="dtm-it-group-body" data-parent-id="${id}" data-parent-section="">
    ${childrenHtml}
    <div class="dtm-it-add-row" style="padding-left:${childIndent}px">
      <button type="button" data-action="addAttributeHere"   data-parent-id="${id}" data-parent-section=""><i class="fas fa-plus"></i> Attr</button>
      <button type="button" data-action="addConditionalHere" data-parent-id="${id}" data-parent-section=""><i class="fas fa-code-branch"></i> Cond</button>
      <button type="button" data-action="addGroupHere"       data-parent-id="${id}" data-parent-section=""><i class="fas fa-layer-group"></i> Group</button>
    </div>
  </div>
</div>`;
  }

  async _renderConditionalBlock(action, parentId, parentSection, depth) {
    const id    = _esc(action.id);
    const pid   = _esc(parentId ?? "");
    const ps    = _esc(parentSection ?? "");
    const label = _esc(action.label ?? "Conditional");
    const die   = action.die ?? "d6";
    const indent      = depth * 20;
    const childIndent = (depth + 1) * 20;

    const branchSections = [];
    for (const branch of (action.branches ?? [])) {
      const bid    = _esc(branch.id);
      const bLabel = _esc(branch.label ?? "");
      const bLow   = branch.low  ?? 1;
      const bHigh  = branch.high ?? 1;
      const branchActionsHtml = await this._buildTreeHtml(branch.actions ?? [], action.id, branch.id, depth + 1);

      const rangeHtml = branch.isElse
        ? `<span class="dtm-it-section-label">ELSE</span>`
        : `<input type="number" class="dtm-it-branch-num" data-field="branchLow"  data-action-id="${id}" data-branch-id="${bid}" value="${bLow}"  min="1" title="Range low" />
           <span class="dtm-it-branch-sep">–</span>
           <input type="number" class="dtm-it-branch-num" data-field="branchHigh" data-action-id="${id}" data-branch-id="${bid}" value="${bHigh}" min="1" title="Range high" />`;

      branchSections.push(`  <div class="dtm-it-block-section" data-parent-id="${id}" data-parent-section="${bid}">
    <div class="dtm-it-section-bar" style="padding-left:${childIndent}px">
      ${rangeHtml}
      <input type="text" class="dtm-it-col-label dtm-it-branch-label" data-field="branchLabel" data-action-id="${id}" data-branch-id="${bid}" value="${bLabel}" placeholder="Label…" />
      <button type="button" data-action="addAttributeHere"   data-parent-id="${id}" data-parent-section="${bid}"><i class="fas fa-plus"></i> Attr</button>
      <button type="button" data-action="addConditionalHere" data-parent-id="${id}" data-parent-section="${bid}"><i class="fas fa-code-branch"></i> Cond</button>
      <button type="button" data-action="addGroupHere"       data-parent-id="${id}" data-parent-section="${bid}"><i class="fas fa-layer-group"></i> Group</button>
      <button type="button" class="dtm-icon-btn dtm-danger"  data-action="deleteBranch" data-action-id="${id}" data-branch-id="${bid}" title="Delete branch"><i class="fas fa-times"></i></button>
    </div>
    <div class="dtm-it-section-body" data-parent-id="${id}" data-parent-section="${bid}">${branchActionsHtml}</div>
  </div>`);
    }

    return `<div class="dtm-it-block dtm-it-cond-block" data-action-id="${id}" data-parent-id="${pid}" data-parent-section="${ps}">
  <div class="dtm-it-block-header dtm-it-cond-header" style="padding-left:${indent}px">
    <span class="dtm-drag-handle" data-drag-id="${id}" title="Drag to reorder"><i class="fas fa-grip-vertical"></i></span>
    <span class="dtm-it-collapse-toggle" data-action="toggleCollapse" data-action-id="${id}" title="Collapse / expand">
      <i class="fas fa-caret-down dtm-it-collapse-chevron"></i>
      <i class="fas fa-code-branch dtm-it-block-icon"></i>
    </span>
    <input type="text" class="dtm-it-cond-die" data-field="condDie" data-action-id="${id}" value="${_esc(die)}" placeholder="d6" title="Die formula (e.g. d6, 2d6, d100)" />
    <input class="dtm-it-col-label dtm-it-cond-label" type="text" data-field="condLabel" data-action-id="${id}" value="${label}" placeholder="Label…" />
    <button type="button" class="dtm-icon-btn"               data-action="addBranch"       data-action-id="${id}" title="Add range branch"><i class="fas fa-plus"></i> Branch</button>
    <button type="button" class="dtm-icon-btn"               data-action="duplicateAction" data-action-id="${id}" title="Duplicate conditional (with children)"><i class="fas fa-clone"></i></button>
    <button type="button" class="dtm-icon-btn dtm-danger"    data-action="deleteAction"    data-action-id="${id}" title="Remove"><i class="fas fa-trash"></i></button>
  </div>
${branchSections.join("\n")}
</div>`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Attribute paths (system field discovery)
  // ─────────────────────────────────────────────────────────────────────────

  async _loadAttributePaths(itemType) {
    if (!itemType) { this._attributePaths = []; return; }

    let paths = [];

    try {
      const model = CONFIG.Item.dataModels?.[itemType];
      if (model?.schema?.fields) paths = flattenSchema(model.schema.fields, "system");
    } catch (_) { /* fall through */ }

    if (!paths.length) {
      try {
        const obj = new Item({ name: "_tmp", type: itemType }).toObject();
        if (obj.system && typeof obj.system === "object") paths = flattenObject(obj.system, "system");
      } catch (_) { /* fall through */ }
    }

    if (!paths.length) {
      try {
        const tmpl = game.system.template?.Item?.[itemType];
        if (tmpl && typeof tmpl === "object") paths = flattenObject(tmpl, "system");
      } catch (_) { /* fall through */ }
    }

    this._attributePaths = [
      { path: "name", label: "name" },
      { path: "img",  label: "img" },
      { path: "system.description.value", label: "system.description.value" },
      ...paths.filter(p => p.path !== "system.description.value")
    ];
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Attribute picker popup
  // ─────────────────────────────────────────────────────────────────────────

  _showAttrPicker(anchorEl, parentId, parentSection) {
    document.querySelector(".dtm-attr-picker")?.remove();

    if (!this._attributePaths.length) {
      ui.notifications.warn("Select an item type first to browse attributes.");
      return;
    }

    const renderItems = (filter) => {
      const f = filter.toLowerCase();
      const paths = f ? this._attributePaths.filter(p => p.path.toLowerCase().includes(f)) : this._attributePaths;
      if (!paths.length) return `<div class="dtm-attr-picker-empty">No matches</div>`;
      return paths.map(r => `<div class="dtm-attr-picker-item" data-path="${_esc(r.path)}" title="${_esc(r.path)}">${_esc(r.path)}</div>`).join("");
    };

    const picker = document.createElement("div");
    picker.className = "dtm-attr-picker";
    picker.innerHTML = `
      <div class="dtm-attr-picker-search"><i class="fas fa-search"></i><input type="text" placeholder="Filter attributes…" /></div>
      <div class="dtm-attr-picker-list">${renderItems("")}</div>
    `;

    const rect = anchorEl.getBoundingClientRect();
    const pickerW = 280;
    let left = rect.left;
    if (left + pickerW > window.innerWidth - 8) left = window.innerWidth - pickerW - 8;
    picker.style.cssText = `left:${left}px;top:${rect.bottom + 4}px`;
    document.body.appendChild(picker);

    const input = picker.querySelector("input");
    const list  = picker.querySelector(".dtm-attr-picker-list");
    input.focus();
    input.addEventListener("input", ev => { list.innerHTML = renderItems(ev.target.value); });

    const closePicker = () => {
      picker.remove();
      document.removeEventListener("pointerdown", outsideHandler, { capture: true });
    };

    picker.addEventListener("click", async ev => {
      const item = ev.target.closest(".dtm-attr-picker-item");
      if (!item) return;
      closePicker();
      await this._addAttribute(item.dataset.path, parentId, parentSection);
    });

    const outsideHandler = (ev) => { if (!picker.contains(ev.target)) closePicker(); };
    setTimeout(() => document.addEventListener("pointerdown", outsideHandler, { capture: true }), 50);
  }

  async _addAttribute(path, parentId, parentSection) {
    await this._editConfig(cfg => {
      const arr = this._resolveTargetArray(cfg.actions, parentId || null, parentSection || null);
      if (!arr) return;
      arr.push({
        id: foundry.utils.randomID(),
        type: "attribute",
        path,
        writeMode: "overwrite",
        sourceType: "text",
        value: "",
        tableUuid: null,
        tableName: null,
        tableField: "name"
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Render lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  _onRender(_context, _options) {
    const html = this.element;

    // Inject "Copy UUID" header button next to Foundry's built-in window controls.
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

    html.addEventListener("change",  ev => this._onFieldChange(ev));
    html.addEventListener("keydown", ev => this._onKeyDown(ev));

    const tree = html.querySelector(".dtm-it-tree");
    if (tree) this._setupDragDrop(tree);

    this._applyCollapsedState();

    if (tree && this._savedScrollTop != null) {
      tree.scrollTop = this._savedScrollTop;
      this._savedScrollTop = null;
    }
  }

  /** Re-apply the collapsed UI state to fresh DOM after a render. Prunes stale IDs. */
  _applyCollapsedState() {
    if (!this._collapsed.size) return;
    const root = this.element;
    if (!root) return;
    for (const id of [...this._collapsed]) {
      const block = root.querySelector(`.dtm-it-block[data-action-id="${CSS.escape(id)}"]`);
      if (block) block.classList.add("dtm-it-collapsed");
      else this._collapsed.delete(id);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Field change dispatch
  // ─────────────────────────────────────────────────────────────────────────

  async _onFieldChange(ev) {
    const target = ev.target;
    const field = target.dataset.field;
    if (!field) return;
    const handler = ItemTemplateEditorWindow._FIELD_HANDLERS[field];
    if (handler) await handler.call(this, target);
  }

  _onKeyDown(ev) {
    if (ev.key === "Enter" && ev.target.tagName === "INPUT") {
      ev.preventDefault();
      ev.stopPropagation();
      ev.target.blur();
      return;
    }
    if (ev.ctrlKey && ev.key === "z" && !ev.shiftKey) {
      ev.preventDefault();
      ItemTemplateEditorWindow.#onUndo.call(this);
    } else if ((ev.ctrlKey && ev.key === "y") || (ev.ctrlKey && ev.shiftKey && ev.key === "z")) {
      ev.preventDefault();
      ItemTemplateEditorWindow.#onRedo.call(this);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Drag and drop
  // ─────────────────────────────────────────────────────────────────────────

  _setupDragDrop(tree) {
    tree.addEventListener("pointerdown", ev => {
      const handle = ev.target.closest(".dtm-drag-handle");
      if (!handle) return;
      const dragId = handle.dataset.dragId;
      if (!dragId) return;
      const draggable = tree.querySelector(`[data-action-id="${CSS.escape(dragId)}"]`);
      if (!draggable) return;
      draggable.setAttribute("draggable", "true");
      const cleanup = () => draggable.removeAttribute("draggable");
      draggable.addEventListener("dragend",   cleanup, { once: true });
      draggable.addEventListener("pointerup", cleanup, { once: true });
    });

    tree.addEventListener("dragstart", ev => this._onDragStart(ev, tree));
    tree.addEventListener("dragover",  ev => this._onDragOver(ev,  tree));
    tree.addEventListener("dragleave", ev => this._onDragLeave(ev, tree));
    tree.addEventListener("drop",      ev => this._onDrop(ev,      tree));
    tree.addEventListener("dragend",   ev => this._onDragEnd(ev,   tree));

    // Manual wheel-scroll while dragging — browsers suppress default
    // wheel scrolling during HTML5 drag operations.
    tree.addEventListener("wheel", ev => {
      if (!this._drag) return;
      ev.preventDefault();
      tree.scrollTop += ev.deltaY;
    }, { passive: false });
  }

  // Edge auto-scroll while dragging — runs a RAF loop fed by `dragover` Y.
  _startAutoScroll(tree) {
    this._stopAutoScroll();
    const EDGE = 50;       // distance from edge (px) at which scrolling begins
    const MAX_SPEED = 18;  // max scroll delta per frame at the very edge

    const tick = () => {
      if (!this._drag) { this._autoScrollRaf = null; return; }
      const y = this._dragLastY;
      if (y != null) {
        const rect = tree.getBoundingClientRect();
        let dy = 0;
        if (y < rect.top + EDGE) {
          dy = -MAX_SPEED * Math.min(1, (rect.top + EDGE - y) / EDGE);
        } else if (y > rect.bottom - EDGE) {
          dy =  MAX_SPEED * Math.min(1, (y - (rect.bottom - EDGE)) / EDGE);
        }
        if (dy !== 0) tree.scrollTop += dy;
      }
      this._autoScrollRaf = requestAnimationFrame(tick);
    };
    this._autoScrollRaf = requestAnimationFrame(tick);
  }

  _stopAutoScroll() {
    if (this._autoScrollRaf) {
      cancelAnimationFrame(this._autoScrollRaf);
      this._autoScrollRaf = null;
    }
    this._dragLastY = null;
  }

  _clearDragVisuals(tree) {
    tree.querySelectorAll(".dtm-drop-line").forEach(el => el.remove());
    tree.querySelectorAll(".dtm-drag-over").forEach(el => el.classList.remove("dtm-drag-over"));
  }

  _onDragStart(ev, tree) {
    const el = ev.target.closest("[data-action-id]");
    if (!el || !el.hasAttribute("draggable")) return;
    const actionId = el.dataset.actionId;
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", actionId);
    this._drag = { actionId };
    this._dragLastY = ev.clientY;
    this._startAutoScroll(tree);
    requestAnimationFrame(() => el.classList.add("dtm-dragging"));
  }

  _findDropZone(ev, tree) {
    const elements = document.elementsFromPoint(ev.clientX, ev.clientY);
    for (const el of elements) {
      if (el.classList.contains("dtm-it-section-body")) return el;
      if (el.classList.contains("dtm-it-group-body"))   return el;
      if (el.classList.contains("dtm-it-block-section")) return el.querySelector(".dtm-it-section-body") ?? el;
      if (el === tree) return tree;
    }
    return tree;
  }

  _getInsertIndex(zone, ev, excludeId) {
    const children = [...zone.querySelectorAll(":scope > .dtm-it-action-row, :scope > .dtm-it-block")]
      .filter(el => el.dataset.actionId !== excludeId);
    for (let i = 0; i < children.length; i++) {
      const rect = children[i].getBoundingClientRect();
      if (ev.clientY < rect.top + rect.height / 2) return i;
    }
    return children.length;
  }

  _onDragOver(ev, tree) {
    if (!this._drag) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    this._dragLastY = ev.clientY;

    this._clearDragVisuals(tree);

    const zone = this._findDropZone(ev, tree);
    const idx  = this._getInsertIndex(zone, ev, this._drag.actionId);
    const children = [...zone.querySelectorAll(":scope > .dtm-it-action-row, :scope > .dtm-it-block")]
      .filter(el => el.dataset.actionId !== this._drag.actionId);

    zone.classList.add("dtm-drag-over");

    const line = document.createElement("div");
    line.className = "dtm-drop-line";
    if (idx < children.length) children[idx].before(line);
    else {
      const addRow = zone.querySelector(":scope > .dtm-it-add-row");
      if (addRow) addRow.before(line);
      else zone.appendChild(line);
    }

    this._dropTarget = { zone, index: idx };
  }

  _onDragLeave(ev, tree) {
    if (!tree.contains(ev.relatedTarget)) {
      this._clearDragVisuals(tree);
      this._dropTarget = null;
    }
  }

  async _onDrop(ev, tree) {
    ev.preventDefault();
    this._stopAutoScroll();
    this._clearDragVisuals(tree);
    tree.querySelectorAll(".dtm-dragging").forEach(el => el.classList.remove("dtm-dragging"));

    if (!this._drag || !this._dropTarget) return;

    const { actionId }      = this._drag;
    const { zone, index }   = this._dropTarget;
    this._drag = null;
    this._dropTarget = null;

    const targetParentId      = zone === tree ? null : (zone.dataset.parentId      || null);
    const targetParentSection = zone === tree ? null : (zone.dataset.parentSection || null);

    await this._editConfig(cfg => {
      this._moveAction(cfg.actions, actionId, targetParentId, targetParentSection, index);
    });
  }

  _onDragEnd(_ev, tree) {
    this._drag = null;
    this._dropTarget = null;
    this._stopAutoScroll();
    this._clearDragVisuals(tree);
    tree.querySelectorAll(".dtm-dragging").forEach(el => el.classList.remove("dtm-dragging"));
    tree.querySelectorAll("[draggable='true']").forEach(el => el.removeAttribute("draggable"));
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Action handlers (toolbar / button data-action="…")
  // ─────────────────────────────────────────────────────────────────────────

  static async #onAddConditional(_ev, target) {
    const parentId      = target.dataset.parentId      || null;
    const parentSection = target.dataset.parentSection || null;
    await this._editConfig(cfg => {
      const arr = this._resolveTargetArray(cfg.actions, parentId, parentSection);
      if (!arr) return;
      arr.push({
        id: foundry.utils.randomID(),
        type: "conditional",
        label: "Conditional",
        die: "d6",
        branches: [
          { id: foundry.utils.randomID(), label: "Branch 1", low: 1, high: 3, actions: [] },
          { id: foundry.utils.randomID(), label: "Branch 2", low: 4, high: 6, actions: [] }
        ]
      });
    });
  }

  static async #onAddGroup(_ev, target) {
    const parentId      = target.dataset.parentId      || null;
    const parentSection = target.dataset.parentSection || null;
    await this._editConfig(cfg => {
      const arr = this._resolveTargetArray(cfg.actions, parentId, parentSection);
      if (!arr) return;
      arr.push({
        id: foundry.utils.randomID(),
        type: "group",
        label: "Group",
        children: []
      });
    });
  }

  static async #onAddBranch(_ev, target) {
    const id = target.dataset.actionId;
    if (!id) return;
    await this._editConfig(cfg => {
      this._mutateAction(cfg, id, a => {
        if (a.type !== "conditional") return;
        if (!a.branches) a.branches = [];
        const n = a.branches.filter(b => !b.isElse).length;
        a.branches.push({
          id: foundry.utils.randomID(),
          label: `Branch ${n + 1}`,
          low: 1,
          high: 1,
          actions: []
        });
      });
    });
  }

  static async #onDeleteBranch(_ev, target) {
    const id  = target.dataset.actionId;
    const bid = target.dataset.branchId;
    if (!id || !bid) return;
    await this._editConfig(cfg => {
      this._mutateAction(cfg, id, a => {
        if (a.type === "conditional" && a.branches) {
          a.branches = a.branches.filter(b => b.id !== bid);
        }
      });
    });
  }

  static async #onDeleteAction(_ev, target) {
    const id = target.dataset.actionId ?? target.closest("[data-action-id]")?.dataset.actionId;
    if (!id) return;
    await this._editConfig(cfg => { this._removeAction(cfg.actions, id); });
  }

  static async #onDuplicateAction(_ev, target) {
    const id = target.dataset.actionId;
    if (!id) return;
    await this._editConfig(cfg => {
      const ref = this._findAction(cfg.actions, id);
      if (!ref) return;
      const dup = this._cloneActionWithNewIds(ref.action);
      ref.array.splice(ref.index + 1, 0, dup);
    });
  }

  static #onToggleCollapse(_ev, target) {
    const id = target.dataset.actionId ?? target.closest("[data-action-id]")?.dataset.actionId;
    if (!id) return;
    const block = this.element?.querySelector(`.dtm-it-block[data-action-id="${CSS.escape(id)}"]`);
    if (!block) return;
    if (this._collapsed.has(id)) { this._collapsed.delete(id); block.classList.remove("dtm-it-collapsed"); }
    else                          { this._collapsed.add(id);    block.classList.add("dtm-it-collapsed"); }
  }

  static async #onAddAttributeHere(_ev, target) {
    const parentId      = target.dataset.parentId      || null;
    const parentSection = target.dataset.parentSection || null;
    this._showAttrPicker(target, parentId, parentSection);
  }

  static async #onPickAttrTable(_ev, target) {
    const id = target.dataset.actionId;
    if (!id) return;
    const result = await DocumentPickerPopup.open(target.getBoundingClientRect(), "", ["RollTable"]);
    if (!result?.uuid) return;
    await this._editConfig(cfg => {
      this._mutateAction(cfg, id, a => {
        a.tableUuid = result.uuid;
        a.tableName = result.name;
      });
    }, { render: "row", rowId: id });
  }

  static async #onPickOutputFolder() {
    const folders = game.folders.filter(f => f.type === "Item")
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!folders.length) {
      ui.notifications.warn("No Item folders exist. Create one in the Items sidebar first.");
      return;
    }
    const options = folders.map(f => `<option value="${f.id}">${_esc(f.name)}</option>`).join("");
    const content = `<div style="padding:8px"><label>Choose folder:<br>
      <select name="folderId" style="width:100%;margin-top:4px">${options}</select></label></div>`;

    const folderId = await foundry.applications.api.DialogV2.wait({
      window: { title: "Choose Output Folder" },
      content,
      rejectClose: false,
      buttons: [
        { action: "pick", label: "Select", default: true,
          callback: (_ev, _btn, dialog) => dialog.element.querySelector("[name='folderId']")?.value ?? null },
        { action: "cancel", label: "Cancel" }
      ]
    });
    if (!folderId || folderId === "cancel") return;

    await this._editConfig(cfg => { cfg.outputFolderId = folderId; });
  }

  static async #onPickBaseItem(_ev, target) {
    const result = await DocumentPickerPopup.open(target.getBoundingClientRect(), "", ["Item"]);
    if (!result?.uuid) return;
    this._nameCache.base = { uuid: result.uuid, name: result.name };
    await this._editConfig(cfg => { cfg.baseItem.uuid = result.uuid; });
  }

  static async #onPickBaseTable(_ev, target) {
    const result = await DocumentPickerPopup.open(target.getBoundingClientRect(), "", ["RollTable"]);
    if (!result?.uuid) return;
    this._nameCache.baseTable = { uuid: result.uuid, name: result.name };
    await this._editConfig(cfg => { cfg.baseItem.tableUuid = result.uuid; });
  }

  static async #onClearBaseItem() {
    await this._editConfig(cfg => {
      cfg.baseItem.uuid = null;
      cfg.baseItem.tableUuid = null;
    });
  }

  static #onPickImgPath() {
    new FilePicker({
      type: "image",
      callback: (path) => this._editConfig(cfg => { cfg.img.path = path; })
    }).render(true);
  }

  static #onPickImgFolder() {
    new FilePicker({
      type: "imagevideo",
      callback: (path) => {
        const folderPath = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : "";
        return this._editConfig(cfg => { cfg.img.path = folderPath || path; });
      }
    }).render(true);
  }

  static async #onGenerate() {
    try {
      await ItemTemplateRoller.generate(this.table);
    } catch (err) {
      console.error("DTM | Item Template generation failed", err);
      ui.notifications.error("Item generation failed. Check the console for details.");
    }
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

  static #onCopyUuid() {
    const uuid = this.table.uuid;
    game.clipboard?.copyPlainText(uuid);
    ui.notifications.info(`Copied UUID: ${uuid}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Cleanup
  // ─────────────────────────────────────────────────────────────────────────

  _onClose(_options) {
    ItemTemplateEditorWindow._instances.delete(this.table.id);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Field handler dispatch table
  //  - render: "full" → re-render whole window
  //  - render: "row"  → swap only the affected attribute row's DOM
  //  - render: "none" → save only (used for free-text inputs)
  // ─────────────────────────────────────────────────────────────────────────

  static _FIELD_HANDLERS = {

    // Top-level fields ──────────────────────────────────────────────────────

    tableName: async function (t) {
      const before = this._getState();
      await this.table.update({ name: t.value });
      this.undoManager.record({ before, after: this._getState() });
    },

    itemType: async function (t) {
      await this._editConfig(cfg => { cfg.itemType = t.value; }, { render: "none" });
      await this._loadAttributePaths(t.value);
      this.render();
    },

    baseItemMode: async function (t) {
      await this._editConfig(cfg => { cfg.baseItem.mode = t.value; });
    },

    imgMode: async function (t) {
      await this._editConfig(cfg => { cfg.img.mode = t.value; });
    },

    imgPath: async function (t) {
      await this._editConfig(cfg => { cfg.img.path = t.value; }, { render: "none" });
    },

    // Attribute action fields — structural (need row re-render) ─────────────

    attrWriteMode: async function (t) {
      const id = t.dataset.actionId;
      await this._editConfig(cfg => this._mutateAction(cfg, id, a => { a.writeMode = t.value; }),
        { render: "row", rowId: id });
    },

    attrSourceType: async function (t) {
      const id = t.dataset.actionId;
      await this._editConfig(cfg => this._mutateAction(cfg, id, a => {
        a.sourceType = t.value;
        if (t.value === "text") a.value = a.value ?? "";
        else { a.tableUuid = a.tableUuid ?? null; a.tableName = a.tableName ?? null; }
      }), { render: "row", rowId: id });
    },

    attrAppendMode: async function (t) {
      const id = t.dataset.actionId;
      await this._editConfig(cfg => this._mutateAction(cfg, id, a => { a.appendMode = t.value; }),
        { render: "row", rowId: id });
    },

    // Affects roll-time output, not the row's visible layout — no re-render needed.
    attrTableField: async function (t) {
      const id = t.dataset.actionId;
      await this._editConfig(cfg => this._mutateAction(cfg, id, a => { a.tableField = t.value; }),
        { render: "none" });
    },

    // Attribute action fields — text only (no DOM update) ──────────────────

    attrPath: async function (t) {
      const id = t.dataset.actionId;
      await this._editConfig(cfg => this._mutateAction(cfg, id, a => { a.path = t.value; }), { render: "none" });
    },

    attrValue: async function (t) {
      const id = t.dataset.actionId;
      await this._editConfig(cfg => this._mutateAction(cfg, id, a => { a.value = t.value; }), { render: "none" });
    },

    attrAppendSeparator: async function (t) {
      const id = t.dataset.actionId;
      await this._editConfig(cfg => this._mutateAction(cfg, id, a => { a.appendSeparator = t.value; }), { render: "none" });
    },

    groupLabel: async function (t) {
      const id = t.dataset.actionId;
      await this._editConfig(cfg => this._mutateAction(cfg, id, a => { a.label = t.value; }), { render: "none" });
    },

    condLabel: async function (t) {
      const id = t.dataset.actionId;
      await this._editConfig(cfg => this._mutateAction(cfg, id, a => { a.label = t.value; }), { render: "none" });
    },

    condDie: async function (t) {
      const id = t.dataset.actionId;
      await this._editConfig(cfg => this._mutateAction(cfg, id, a => { a.die = t.value; }), { render: "none" });
    },

    // Branch fields ────────────────────────────────────────────────────────

    branchLow: async function (t) {
      const id = t.dataset.actionId, bid = t.dataset.branchId;
      await this._editConfig(cfg => this._mutateBranch(cfg, id, bid, b => { b.low = parseInt(t.value) || 1; }),
        { render: "none" });
    },

    branchHigh: async function (t) {
      const id = t.dataset.actionId, bid = t.dataset.branchId;
      await this._editConfig(cfg => this._mutateBranch(cfg, id, bid, b => { b.high = parseInt(t.value) || 1; }),
        { render: "none" });
    },

    branchLabel: async function (t) {
      const id = t.dataset.actionId, bid = t.dataset.branchId;
      await this._editConfig(cfg => this._mutateBranch(cfg, id, bid, b => { b.label = t.value; }),
        { render: "none" });
    }
  };
}
