import { UndoManager } from "../lib/UndoManager.js";
import { ItemTemplateRoller } from "../lib/ItemTemplateRoller.js";
import { DocumentPickerPopup } from "./DocumentPickerPopup.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function _esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const DEFAULT_CONFIG = () => ({
  itemType: "",
  outputFolderId: null,
  baseItem: { mode: "none", uuid: null, tableUuid: null },
  img: { mode: "none", path: null },
  actions: []
});

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
    this._attrFilter = "";
    this._attrFilterDebounce = null;
    this._drag = null;
    this._dropTarget = null;
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
      addAttrFromBrowser: ItemTemplateEditorWindow.#onAddAttrFromBrowser,
      addAttributeHere:   ItemTemplateEditorWindow.#onAddAttributeHere,
      addConditionalHere: ItemTemplateEditorWindow.#onAddConditionalHere,
      addGroupHere:       ItemTemplateEditorWindow.#onAddGroupHere,
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

  get id() { return `dtm-it-editor-${this.table.id}`; }

  static PARTS = {
    editor: { template: "modules/dynamic-table-manager/templates/item-template-editor.hbs" }
  };

  get title() { return `Item Template: ${this.table.name}`; }

  // ---- Config helpers --------------------------------------------------------

  _getConfig() {
    const config = foundry.utils.deepClone(
      this.table.getFlag("dynamic-table-manager", "itemTemplateConfig") ?? DEFAULT_CONFIG()
    );
    this._migrateActions(config.actions);
    return config;
  }

  _migrateActions(actions) {
    for (const action of (actions ?? [])) {
      // Attribute: old source-object → flat format
      if (action.type === "attribute" && action.source && !action.sourceType) {
        const src = action.source;
        if (src.type === "table") {
          action.sourceType = "table";
          action.tableUuid = src.tableUuid ?? null;
          action.tableName = src.tableName ?? null;
        } else {
          action.sourceType = "text";
          action.value = src.value ?? "";
        }
        delete action.source;
      }

      // Conditional: old simple condition → multi-branch
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

      // Recurse
      this._migrateActions(action.children);
      for (const branch of (action.branches ?? [])) {
        this._migrateActions(branch.actions);
      }
    }
  }

  async _saveConfig(config) {
    await this.table.setFlag("dynamic-table-manager", "itemTemplateConfig", config);
  }

  _getState() {
    return { name: this.table.name, config: this._getConfig() };
  }

  async _applyState(state) {
    await this.table.update({ name: state.name });
    await this.table.setFlag("dynamic-table-manager", "itemTemplateConfig", state.config);
  }

  _recordUndo(type, before) {
    const after = this._getState();
    this.undoManager.record({ type, before, after });
  }

  // ---- Context ---------------------------------------------------------------

  /** @override */
  async _prepareContext() {
    const config = this._getConfig();

    const itemTypes = (game.documentTypes?.Item ?? [])
      .filter(t => t !== "base")
      .map(t => ({ value: t, label: t, selected: t === config.itemType }));

    const outputFolderName = config.outputFolderId
      ? (game.folders.get(config.outputFolderId)?.name ?? config.outputFolderId)
      : null;

    let baseItemName = null;
    if (config.baseItem.mode === "fixed" && config.baseItem.uuid) {
      const doc = await fromUuid(config.baseItem.uuid).catch(() => null);
      baseItemName = doc?.name ?? "(not found)";
    }
    let baseTableName = null;
    if (config.baseItem.mode === "table" && config.baseItem.tableUuid) {
      const tbl = await fromUuid(config.baseItem.tableUuid).catch(() => null);
      baseTableName = tbl?.name ?? "(not found)";
    }

    if (!this._attributePaths.length && config.itemType) {
      await this._loadAttributePaths(config.itemType);
    }

    const actionTreeHtml = await this._buildTreeHtml(config.actions, null, null, 0);
    const attrRows = this._buildAttributeRows(this._attrFilter);

    const baseItemModes = ["none", "fixed", "table"].map(v => ({
      value: v, label: { none: "None", fixed: "Fixed Item", table: "Roll from Table" }[v],
      selected: config.baseItem.mode === v
    }));
    const imgModes = ["none", "fixed", "folder"].map(v => ({
      value: v, label: { none: "None", fixed: "Fixed Path", folder: "Random from Folder" }[v],
      selected: config.img.mode === v
    }));

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
      attrRows,
      attrFilter: this._attrFilter,
      canUndo: this.undoManager.canUndo(),
      canRedo: this.undoManager.canRedo()
    };
  }

  // ---- Tree HTML builder -----------------------------------------------------

  async _buildTreeHtml(actions, parentId, parentSection, depth) {
    const parts = [];
    for (const action of (actions ?? [])) {
      if (action.type === "attribute") {
        parts.push(this._renderAttrRow(action, parentId, parentSection, depth));
      } else if (action.type === "group") {
        parts.push(await this._renderGroupBlock(action, parentId, parentSection, depth));
      } else if (action.type === "conditional") {
        parts.push(await this._renderConditionalBlock(action, parentId, parentSection, depth));
      }
    }
    return parts.join("\n");
  }

  _renderAttrRow(action, parentId, parentSection, depth) {
    const id = _esc(action.id);
    const pid = _esc(parentId ?? "");
    const ps = _esc(parentSection ?? "");
    const path = _esc(action.path ?? "");
    const writeMode = action.writeMode ?? "overwrite";
    const sourceType = action.sourceType ?? "text";
    const value = _esc(action.value ?? "");
    const tableName = action.tableName ?? "";
    const indent = depth * 20;

    const valueHtml = sourceType === "text"
      ? `<input class="dtm-it-col-value" type="text" data-field="attrValue" data-action-id="${id}" value="${value}" placeholder="Value…" />`
      : `<span class="dtm-it-table-name dtm-it-col-value" title="${_esc(tableName) || "No table"}">${tableName ? _esc(tableName) : "<em>No table</em>"}</span>
         <button type="button" class="dtm-icon-btn" data-action="pickAttrTable" data-action-id="${id}" title="Pick table"><i class="fas fa-table"></i></button>`;

    // Separator controls shown for both append and prepend modes
    let appendHtml = "";
    if (writeMode === "append" || writeMode === "prepend") {
      const appendMode = action.appendMode ?? "newline";
      const appendSeparator = _esc(action.appendSeparator ?? "");
      const appendOpts = [
        ["newline", "↵ Line"], ["space", "Space"], ["comma", "Comma"],
        ["dash", "Dash"], ["colon", "Colon"], ["list", "List"], ["custom", "Custom"]
      ].map(([v, l]) => `<option value="${v}" ${appendMode === v ? "selected" : ""}>${l}</option>`).join("");

      const customSep = appendMode === "custom"
        ? `<input class="dtm-it-col-sep" style="flex:0 0 52px;width:52px" type="text" data-field="attrAppendSeparator" data-action-id="${id}" value="${appendSeparator}" placeholder="Sep…" title="Custom separator" />`
        : "";

      appendHtml = `<select class="dtm-it-col-append" style="flex:0 0 68px;width:68px" data-field="attrAppendMode" data-action-id="${id}" title="Separator">${appendOpts}</select>${customSep}`;
    }

    return `<div class="dtm-it-action-row" data-action-id="${id}" data-parent-id="${pid}" data-parent-section="${ps}" style="padding-left:${indent}px">
  <span class="dtm-drag-handle" data-drag-id="${id}" title="Drag to reorder"><i class="fas fa-grip-vertical"></i></span>
  <input class="dtm-it-col-path" type="text" data-field="attrPath" data-action-id="${id}" value="${path}" placeholder="attribute.path" title="${path}" />
  <select class="dtm-it-col-wmode" style="flex:0 0 68px;width:68px" data-field="attrWriteMode" data-action-id="${id}" title="Write mode">
    <option value="overwrite" ${writeMode === "overwrite" ? "selected" : ""}>Overwrite</option>
    <option value="append"    ${writeMode === "append"    ? "selected" : ""}>Append</option>
    <option value="prepend"   ${writeMode === "prepend"   ? "selected" : ""}>Prepend</option>
  </select>
  ${appendHtml}
  <select class="dtm-it-col-srctype" style="flex:0 0 66px;width:66px" data-field="attrSourceType" data-action-id="${id}" title="Source type">
    <option value="text" ${sourceType === "text" ? "selected" : ""}>Text</option>
    <option value="table" ${sourceType === "table" ? "selected" : ""}>Table</option>
  </select>
  ${valueHtml}
  <button type="button" class="dtm-icon-btn dtm-danger" data-action="deleteAction" data-action-id="${id}" title="Remove"><i class="fas fa-trash"></i></button>
</div>`;
  }

  async _renderGroupBlock(action, parentId, parentSection, depth) {
    const id = _esc(action.id);
    const pid = _esc(parentId ?? "");
    const ps = _esc(parentSection ?? "");
    const label = _esc(action.label ?? "Group");
    const indent = depth * 20;
    const childIndent = (depth + 1) * 20;

    const childrenHtml = await this._buildTreeHtml(action.children ?? [], action.id, null, depth + 1);

    return `<div class="dtm-it-block dtm-it-group-block" data-action-id="${id}" data-parent-id="${pid}" data-parent-section="${ps}">
  <div class="dtm-it-block-header" style="padding-left:${indent}px">
    <span class="dtm-drag-handle" data-drag-id="${id}" title="Drag to reorder"><i class="fas fa-grip-vertical"></i></span>
    <i class="fas fa-layer-group dtm-it-block-icon"></i>
    <input class="dtm-it-col-label" type="text" data-field="groupLabel" data-action-id="${id}" value="${label}" placeholder="Group label…" />
    <button type="button" class="dtm-icon-btn dtm-danger" data-action="deleteAction" data-action-id="${id}" title="Remove group"><i class="fas fa-trash"></i></button>
  </div>
  <div class="dtm-it-group-body" data-parent-id="${id}" data-parent-section="">
    ${childrenHtml}
    <div class="dtm-it-add-row" style="padding-left:${childIndent}px">
      <button type="button" data-action="addAttributeHere" data-parent-id="${id}" data-parent-section=""><i class="fas fa-plus"></i> Attr</button>
      <button type="button" data-action="addConditionalHere" data-parent-id="${id}" data-parent-section=""><i class="fas fa-code-branch"></i> Cond</button>
    </div>
  </div>
</div>`;
  }

  async _renderConditionalBlock(action, parentId, parentSection, depth) {
    const id = _esc(action.id);
    const pid = _esc(parentId ?? "");
    const ps = _esc(parentSection ?? "");
    const label = _esc(action.label ?? "Conditional");
    const die = action.die ?? "d6";
    const indent = depth * 20;
    const childIndent = (depth + 1) * 20;

    const branchSections = [];
    for (const branch of (action.branches ?? [])) {
      const bid = _esc(branch.id);
      const bLabel = _esc(branch.label ?? "");
      const bLow = branch.low ?? 1;
      const bHigh = branch.high ?? 1;
      const branchActionsHtml = await this._buildTreeHtml(branch.actions ?? [], action.id, branch.id, depth + 1);

      const rangeHtml = branch.isElse
        ? `<span class="dtm-it-section-label">ELSE</span>`
        : `<input type="number" class="dtm-it-branch-num" data-field="branchLow" data-action-id="${id}" data-branch-id="${bid}" value="${bLow}" min="1" title="Range low" />
           <span class="dtm-it-branch-sep">–</span>
           <input type="number" class="dtm-it-branch-num" data-field="branchHigh" data-action-id="${id}" data-branch-id="${bid}" value="${bHigh}" min="1" title="Range high" />`;

      branchSections.push(`  <div class="dtm-it-block-section" data-parent-id="${id}" data-parent-section="${bid}">
    <div class="dtm-it-section-bar" style="padding-left:${childIndent}px">
      ${rangeHtml}
      <input type="text" class="dtm-it-col-label dtm-it-branch-label" data-field="branchLabel" data-action-id="${id}" data-branch-id="${bid}" value="${bLabel}" placeholder="Label…" />
      <button type="button" data-action="addAttributeHere" data-parent-id="${id}" data-parent-section="${bid}"><i class="fas fa-plus"></i> Attr</button>
      <button type="button" data-action="addConditionalHere" data-parent-id="${id}" data-parent-section="${bid}"><i class="fas fa-code-branch"></i> Cond</button>
      <button type="button" data-action="addGroupHere" data-parent-id="${id}" data-parent-section="${bid}"><i class="fas fa-layer-group"></i> Group</button>
      <button type="button" class="dtm-icon-btn dtm-danger" data-action="deleteBranch" data-action-id="${id}" data-branch-id="${bid}" title="Delete branch"><i class="fas fa-times"></i></button>
    </div>
    <div class="dtm-it-section-body" data-parent-id="${id}" data-parent-section="${bid}">${branchActionsHtml}</div>
  </div>`);
    }

    return `<div class="dtm-it-block dtm-it-cond-block" data-action-id="${id}" data-parent-id="${pid}" data-parent-section="${ps}">
  <div class="dtm-it-block-header dtm-it-cond-header" style="padding-left:${indent}px">
    <span class="dtm-drag-handle" data-drag-id="${id}" title="Drag to reorder"><i class="fas fa-grip-vertical"></i></span>
    <i class="fas fa-code-branch dtm-it-block-icon"></i>
    <input type="text" class="dtm-it-cond-die" style="flex:0 0 68px;width:68px" data-field="condDie" data-action-id="${id}" value="${_esc(die)}" placeholder="d6" title="Die formula (e.g. d6, 2d6, d100)" />
    <input class="dtm-it-col-label" style="flex:0.75 1 0" type="text" data-field="condLabel" data-action-id="${id}" value="${label}" placeholder="Label…" />
    <button type="button" class="dtm-icon-btn" data-action="addBranch" data-action-id="${id}" title="Add range branch"><i class="fas fa-plus"></i> Branch</button>
    <button type="button" class="dtm-icon-btn dtm-danger" data-action="deleteAction" data-action-id="${id}" title="Remove"><i class="fas fa-trash"></i></button>
  </div>
${branchSections.join("\n")}
</div>`;
  }

  // ---- Attribute browser -----------------------------------------------------

  async _loadAttributePaths(itemType) {
    if (!itemType) { this._attributePaths = []; return; }

    let paths = [];

    try {
      const model = CONFIG.Item.dataModels?.[itemType];
      if (model?.schema?.fields) {
        paths = ItemTemplateEditorWindow._flattenSchema(model.schema.fields, "system");
      }
    } catch (_) { /* fall through */ }

    if (!paths.length) {
      try {
        const tmpItem = new Item({ name: "_tmp", type: itemType });
        const obj = tmpItem.toObject();
        if (obj.system && typeof obj.system === "object") {
          paths = ItemTemplateEditorWindow._flattenObject(obj.system, "system");
        }
      } catch (_) { /* fall through */ }
    }

    if (!paths.length) {
      try {
        const tmpl = game.system.template?.Item?.[itemType];
        if (tmpl && typeof tmpl === "object") {
          paths = ItemTemplateEditorWindow._flattenObject(tmpl, "system");
        }
      } catch (_) { /* fall through */ }
    }

    this._attributePaths = [
      { path: "name", label: "name" },
      { path: "img", label: "img" },
      { path: "system.description.value", label: "system.description.value" },
      ...paths.filter(p => p.path !== "system.description.value")
    ];
  }

  static _flattenSchema(fields, prefix) {
    const paths = [];
    for (const [key, field] of Object.entries(fields)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (field?.fields) {
        paths.push(...ItemTemplateEditorWindow._flattenSchema(field.fields, path));
      } else {
        paths.push({ path, label: path });
      }
    }
    return paths;
  }

  static _flattenObject(obj, prefix) {
    const paths = [];
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        paths.push(...ItemTemplateEditorWindow._flattenObject(value, path));
      } else {
        paths.push({ path, label: path });
      }
    }
    return paths;
  }

  _buildAttributeRows(filter) {
    if (!filter) return this._attributePaths;
    const lc = filter.toLowerCase();
    return this._attributePaths.filter(p => p.path.toLowerCase().includes(lc));
  }

  _refreshAttrPane() {
    const list = this.element?.querySelector(".dtm-it-attr-list");
    if (!list) return;
    const rows = this._buildAttributeRows(this._attrFilter);
    if (!rows.length) {
      const msg = this._attributePaths.length
        ? "No attributes match your filter."
        : (this._getConfig().itemType ? "Loading attributes…" : "Select an item type to browse attributes.");
      list.innerHTML = `<div class="dtm-region-empty">${msg}</div>`;
      return;
    }
    list.innerHTML = rows.map(r => `
      <div class="dtm-it-attr-row" data-path="${_esc(r.path)}">
        <span class="dtm-it-attr-path" title="${_esc(r.path)}">${_esc(r.path)}</span>
        <button type="button" class="dtm-it-attr-add" data-action="addAttrFromBrowser"
                data-path="${_esc(r.path)}" title="Add to tree">
          <i class="fas fa-plus"></i>
        </button>
      </div>
    `).join("");
  }

  // ---- Render ----------------------------------------------------------------

  /** @override */
  _onRender(_context, _options) {
    const html = this.element;

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

    html.addEventListener("keydown", ev => {
      if (ev.key === "Enter" && ev.target.tagName === "INPUT") {
        ev.preventDefault();
        ev.stopPropagation();
        ev.target.blur();
      }
    });

    const filterInput = html.querySelector(".dtm-it-attr-filter");
    filterInput?.addEventListener("input", ev => {
      clearTimeout(this._attrFilterDebounce);
      this._attrFilterDebounce = setTimeout(() => {
        this._attrFilter = ev.target.value;
        this._refreshAttrPane();
      }, 150);
    });

    const tree = html.querySelector(".dtm-it-tree");
    if (tree) this._setupDragDrop(tree);
  }

  // ---- Drag-and-drop ---------------------------------------------------------

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
      draggable.addEventListener("dragend", cleanup, { once: true });
      draggable.addEventListener("pointerup", cleanup, { once: true });
    });

    tree.addEventListener("dragstart", ev => this._onDragStart(ev, tree));
    tree.addEventListener("dragover",  ev => this._onDragOver(ev, tree));
    tree.addEventListener("dragleave", ev => this._onDragLeave(ev, tree));
    tree.addEventListener("drop",      ev => this._onDrop(ev, tree));
    tree.addEventListener("dragend",   ev => this._onDragEnd(ev, tree));
  }

  _onDragStart(ev, tree) {
    const el = ev.target.closest("[data-action-id]");
    if (!el || !el.hasAttribute("draggable")) return;
    const actionId = el.dataset.actionId;
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", actionId);
    this._drag = { actionId };
    requestAnimationFrame(() => el.classList.add("dtm-dragging"));
  }

  _findDropZone(ev, tree) {
    const elements = document.elementsFromPoint(ev.clientX, ev.clientY);
    for (const el of elements) {
      if (el.classList.contains("dtm-it-section-body")) return el;
      if (el.classList.contains("dtm-it-group-body")) return el;
      if (el.classList.contains("dtm-it-block-section")) {
        return el.querySelector(".dtm-it-section-body") ?? el;
      }
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

    tree.querySelectorAll(".dtm-drop-line").forEach(el => el.remove());
    tree.querySelectorAll(".dtm-drag-over").forEach(el => el.classList.remove("dtm-drag-over"));

    const zone = this._findDropZone(ev, tree);
    const idx = this._getInsertIndex(zone, ev, this._drag.actionId);
    const actionChildren = [...zone.querySelectorAll(":scope > .dtm-it-action-row, :scope > .dtm-it-block")]
      .filter(el => el.dataset.actionId !== this._drag.actionId);

    zone.classList.add("dtm-drag-over");

    const line = document.createElement("div");
    line.className = "dtm-drop-line";
    if (idx < actionChildren.length) {
      actionChildren[idx].before(line);
    } else {
      const addRow = zone.querySelector(":scope > .dtm-it-add-row");
      if (addRow) addRow.before(line);
      else zone.appendChild(line);
    }

    this._dropTarget = { zone, index: idx };
  }

  _onDragLeave(ev, tree) {
    if (!tree.contains(ev.relatedTarget)) {
      tree.querySelectorAll(".dtm-drop-line").forEach(el => el.remove());
      tree.querySelectorAll(".dtm-drag-over").forEach(el => el.classList.remove("dtm-drag-over"));
      this._dropTarget = null;
    }
  }

  async _onDrop(ev, tree) {
    ev.preventDefault();

    tree.querySelectorAll(".dtm-drop-line").forEach(el => el.remove());
    tree.querySelectorAll(".dtm-drag-over").forEach(el => el.classList.remove("dtm-drag-over"));
    tree.querySelectorAll(".dtm-dragging").forEach(el => el.classList.remove("dtm-dragging"));

    if (!this._drag || !this._dropTarget) return;

    const { actionId } = this._drag;
    const { zone, index } = this._dropTarget;

    let targetParentId = null;
    let targetParentSection = null;

    if (zone !== tree) {
      targetParentId = zone.dataset.parentId || null;
      targetParentSection = zone.dataset.parentSection || null;
    }

    this._drag = null;
    this._dropTarget = null;

    const before = this._getState();
    const config = this._getConfig();

    const moved = this._moveAction(config.actions, actionId, targetParentId, targetParentSection, index);
    if (!moved) return;

    await this._saveConfig(config);
    this._recordUndo("moveAction", before);
    this.render();
  }

  _onDragEnd(ev, tree) {
    this._drag = null;
    this._dropTarget = null;
    tree.querySelectorAll(".dtm-drop-line").forEach(el => el.remove());
    tree.querySelectorAll(".dtm-drag-over").forEach(el => el.classList.remove("dtm-drag-over"));
    tree.querySelectorAll(".dtm-dragging").forEach(el => el.classList.remove("dtm-dragging"));
    tree.querySelectorAll("[draggable='true']").forEach(el => el.removeAttribute("draggable"));
  }

  // ---- Tree mutation helpers -------------------------------------------------

  _findAndMutate(actions, id, fn) {
    for (const action of (actions ?? [])) {
      if (action.id === id) { fn(action); return true; }
      if (this._findAndMutate(action.children, id, fn)) return true;
      for (const branch of (action.branches ?? [])) {
        if (this._findAndMutate(branch.actions, id, fn)) return true;
      }
    }
    return false;
  }

  _removeFromActions(actions, id) {
    for (let i = (actions ?? []).length - 1; i >= 0; i--) {
      if (actions[i].id === id) { actions.splice(i, 1); return true; }
      if (this._removeFromActions(actions[i].children, id)) return true;
      for (const branch of (actions[i].branches ?? [])) {
        if (this._removeFromActions(branch.actions, id)) return true;
      }
    }
    return false;
  }

  _extractFromActions(actions, id, fn) {
    for (let i = 0; i < (actions ?? []).length; i++) {
      if (actions[i].id === id) { fn(actions.splice(i, 1)[0]); return true; }
      if (this._extractFromActions(actions[i].children, id, fn)) return true;
      for (const branch of (actions[i].branches ?? [])) {
        if (this._extractFromActions(branch.actions, id, fn)) return true;
      }
    }
    return false;
  }

  _containsId(action, id) {
    if (!action) return false;
    if (action.id === id) return true;
    for (const child of (action.children ?? [])) if (this._containsId(child, id)) return true;
    for (const branch of (action.branches ?? [])) {
      for (const child of (branch.actions ?? [])) if (this._containsId(child, id)) return true;
    }
    return false;
  }

  _resolveTargetArray(rootActions, parentId, parentSection) {
    if (!parentId) return rootActions;
    let found = null;
    this._findAndMutate(rootActions, parentId, action => { found = action; });
    if (!found) return null;
    if (found.type === "group") return found.children ?? (found.children = []);
    if (found.type === "conditional") {
      const branch = (found.branches ?? []).find(b => b.id === parentSection);
      if (branch) return branch.actions ?? (branch.actions = []);
      return null;
    }
    return null;
  }

  _moveAction(rootActions, actionId, targetParentId, targetParentSection, insertIndex) {
    if (targetParentId) {
      if (targetParentId === actionId) return false;
      let actionRef = null;
      this._findAndMutate(rootActions, actionId, a => { actionRef = a; });
      if (actionRef && this._containsId(actionRef, targetParentId)) return false;
    }

    let extracted = null;
    this._extractFromActions(rootActions, actionId, act => { extracted = act; });
    if (!extracted) return false;

    const targetArr = targetParentId
      ? this._resolveTargetArray(rootActions, targetParentId, targetParentSection)
      : rootActions;

    if (!targetArr) { rootActions.push(extracted); return false; }

    const idx = Math.min(Math.max(0, insertIndex), targetArr.length);
    targetArr.splice(idx, 0, extracted);
    return true;
  }

  // ---- Field change handler --------------------------------------------------

  async _onFieldChange(ev) {
    const target = ev.target;
    const field = target.dataset.field;
    if (!field) return;

    const before = this._getState();
    const config = this._getConfig();

    // Top-level fields
    if (field === "tableName") {
      await this.table.update({ name: target.value });
      this._recordUndo("editName", before);
      return;
    }
    if (field === "itemType") {
      config.itemType = target.value;
      await this._saveConfig(config);
      this._recordUndo("editItemType", before);
      await this._loadAttributePaths(target.value);
      this.render();
      return;
    }
    if (field === "baseItemMode") {
      config.baseItem.mode = target.value;
      await this._saveConfig(config);
      this._recordUndo("editBaseItemMode", before);
      this.render();
      return;
    }
    if (field === "imgMode") {
      config.img.mode = target.value;
      await this._saveConfig(config);
      this._recordUndo("editImgMode", before);
      this.render();
      return;
    }
    if (field === "imgPath") {
      config.img.path = target.value;
      await this._saveConfig(config);
      this._recordUndo("editImgPath", before);
      return;
    }

    // Action fields (require data-action-id)
    const actionId = target.dataset.actionId ?? target.closest("[data-action-id]")?.dataset.actionId;
    if (!actionId) return;

    if (field === "attrPath") {
      this._findAndMutate(config.actions, actionId, a => { a.path = target.value; });
      await this._saveConfig(config);
      this._recordUndo("editAttrPath", before);
      return;
    }
    if (field === "attrWriteMode") {
      this._findAndMutate(config.actions, actionId, a => { a.writeMode = target.value; });
      await this._saveConfig(config);
      this._recordUndo("editWriteMode", before);
      this.render();
      return;
    }
    if (field === "attrSourceType") {
      this._findAndMutate(config.actions, actionId, a => {
        a.sourceType = target.value;
        if (target.value === "text") { a.value = a.value ?? ""; }
        if (target.value === "table") { a.tableUuid = a.tableUuid ?? null; a.tableName = a.tableName ?? null; }
      });
      await this._saveConfig(config);
      this._recordUndo("editSourceType", before);
      this.render();
      return;
    }
    if (field === "attrValue") {
      this._findAndMutate(config.actions, actionId, a => { a.value = target.value; });
      await this._saveConfig(config);
      this._recordUndo("editAttrValue", before);
      return;
    }
    if (field === "attrAppendMode") {
      this._findAndMutate(config.actions, actionId, a => { a.appendMode = target.value; });
      await this._saveConfig(config);
      this._recordUndo("editAppendMode", before);
      this.render();
      return;
    }
    if (field === "attrAppendSeparator") {
      this._findAndMutate(config.actions, actionId, a => { a.appendSeparator = target.value; });
      await this._saveConfig(config);
      this._recordUndo("editAppendSep", before);
      return;
    }
    if (field === "groupLabel") {
      this._findAndMutate(config.actions, actionId, a => { a.label = target.value; });
      await this._saveConfig(config);
      this._recordUndo("editGroupLabel", before);
      return;
    }
    if (field === "condLabel") {
      this._findAndMutate(config.actions, actionId, a => { a.label = target.value; });
      await this._saveConfig(config);
      this._recordUndo("editCondLabel", before);
      return;
    }
    if (field === "condDie") {
      this._findAndMutate(config.actions, actionId, a => { a.die = target.value; });
      await this._saveConfig(config);
      this._recordUndo("editCondDie", before);
      return;
    }

    // Branch fields (require data-branch-id)
    const branchId = target.dataset.branchId;
    if (!branchId) return;

    const updateBranch = (fn) => {
      this._findAndMutate(config.actions, actionId, a => {
        const branch = (a.branches ?? []).find(b => b.id === branchId);
        if (branch) fn(branch);
      });
    };

    if (field === "branchLow") {
      updateBranch(b => { b.low = parseInt(target.value) || 1; });
      await this._saveConfig(config);
      this._recordUndo("editBranchLow", before);
      return;
    }
    if (field === "branchHigh") {
      updateBranch(b => { b.high = parseInt(target.value) || 1; });
      await this._saveConfig(config);
      this._recordUndo("editBranchHigh", before);
      return;
    }
    if (field === "branchLabel") {
      updateBranch(b => { b.label = target.value; });
      await this._saveConfig(config);
      this._recordUndo("editBranchLabel", before);
      return;
    }
  }

  // ---- Keyboard shortcuts ----------------------------------------------------

  _onKeyDown(ev) {
    if (ev.ctrlKey && ev.key === "z" && !ev.shiftKey) {
      ev.preventDefault();
      ItemTemplateEditorWindow.#onUndo.call(this);
    } else if ((ev.ctrlKey && ev.key === "y") || (ev.ctrlKey && ev.shiftKey && ev.key === "z")) {
      ev.preventDefault();
      ItemTemplateEditorWindow.#onRedo.call(this);
    }
  }

  // ---- Actions ---------------------------------------------------------------

  static async #onAddConditional(_ev, target) {
    const parentId = target.dataset.parentId || null;
    const parentSection = target.dataset.parentSection || null;
    const before = this._getState();
    const config = this._getConfig();
    const arr = this._resolveTargetArray(config.actions, parentId, parentSection);
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
    await this._saveConfig(config);
    this._recordUndo("addConditional", before);
    this.render();
  }

  static async #onAddGroup(_ev, target) {
    const parentId = target.dataset.parentId || null;
    const parentSection = target.dataset.parentSection || null;
    const before = this._getState();
    const config = this._getConfig();
    const arr = this._resolveTargetArray(config.actions, parentId, parentSection);
    if (!arr) return;
    arr.push({
      id: foundry.utils.randomID(),
      type: "group",
      label: "Group",
      children: []
    });
    await this._saveConfig(config);
    this._recordUndo("addGroup", before);
    this.render();
  }

  static async #onAddBranch(_ev, target) {
    const actionId = target.dataset.actionId;
    if (!actionId) return;
    const before = this._getState();
    const config = this._getConfig();
    this._findAndMutate(config.actions, actionId, a => {
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
    await this._saveConfig(config);
    this._recordUndo("addBranch", before);
    this.render();
  }

  static async #onDeleteBranch(_ev, target) {
    const actionId = target.dataset.actionId;
    const branchId = target.dataset.branchId;
    if (!actionId || !branchId) return;
    const before = this._getState();
    const config = this._getConfig();
    this._findAndMutate(config.actions, actionId, a => {
      if (a.type === "conditional" && a.branches) {
        a.branches = a.branches.filter(b => b.id !== branchId);
      }
    });
    await this._saveConfig(config);
    this._recordUndo("deleteBranch", before);
    this.render();
  }

  static async #onDeleteAction(_ev, target) {
    const id = target.dataset.actionId ?? target.closest("[data-action-id]")?.dataset.actionId;
    if (!id) return;
    const before = this._getState();
    const config = this._getConfig();
    this._removeFromActions(config.actions, id);
    await this._saveConfig(config);
    this._recordUndo("deleteAction", before);
    this.render();
  }

  static async #onAddAttrFromBrowser(_ev, target) {
    const path = target.dataset.path;
    if (!path) return;
    const before = this._getState();
    const config = this._getConfig();
    config.actions.push({
      id: foundry.utils.randomID(),
      type: "attribute",
      path,
      writeMode: "overwrite",
      sourceType: "text",
      value: "",
      tableUuid: null,
      tableName: null
    });
    await this._saveConfig(config);
    this._recordUndo("addAttr", before);
    this.render();
  }

  static async #onAddAttributeHere(_ev, target) {
    const parentId = target.dataset.parentId || null;
    const parentSection = target.dataset.parentSection || null;
    const before = this._getState();
    const config = this._getConfig();
    const arr = this._resolveTargetArray(config.actions, parentId, parentSection);
    if (!arr) return;
    arr.push({
      id: foundry.utils.randomID(),
      type: "attribute",
      path: "name",
      writeMode: "overwrite",
      sourceType: "text",
      value: "",
      tableUuid: null,
      tableName: null
    });
    await this._saveConfig(config);
    this._recordUndo("addAttrHere", before);
    this.render();
  }

  static async #onAddConditionalHere(_ev, target) {
    await ItemTemplateEditorWindow.#onAddConditional.call(this, _ev, target);
  }

  static async #onAddGroupHere(_ev, target) {
    await ItemTemplateEditorWindow.#onAddGroup.call(this, _ev, target);
  }

  static async #onPickAttrTable(_ev, target) {
    const actionId = target.dataset.actionId;
    if (!actionId) return;
    const anchorRect = target.getBoundingClientRect();
    const result = await DocumentPickerPopup.open(anchorRect, "", ["RollTable"]);
    if (!result?.uuid) return;
    const before = this._getState();
    const config = this._getConfig();
    this._findAndMutate(config.actions, actionId, a => {
      a.tableUuid = result.uuid;
      a.tableName = result.name;
    });
    await this._saveConfig(config);
    this._recordUndo("pickAttrTable", before);
    this.render();
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
        {
          action: "pick",
          label: "Select",
          default: true,
          callback: (_ev, _btn, dialog) => dialog.element.querySelector("[name='folderId']")?.value ?? null
        },
        { action: "cancel", label: "Cancel" }
      ]
    });

    if (!folderId || folderId === "cancel") return;

    const before = this._getState();
    const config = this._getConfig();
    config.outputFolderId = folderId;
    await this._saveConfig(config);
    this._recordUndo("pickFolder", before);
    this.render();
  }

  static async #onPickBaseItem(_ev, target) {
    const anchorRect = target.getBoundingClientRect();
    const result = await DocumentPickerPopup.open(anchorRect, "", ["Item"]);
    if (!result?.uuid) return;
    const before = this._getState();
    const config = this._getConfig();
    config.baseItem.uuid = result.uuid;
    await this._saveConfig(config);
    this._recordUndo("pickBaseItem", before);
    this.render();
  }

  static async #onPickBaseTable(_ev, target) {
    const anchorRect = target.getBoundingClientRect();
    const result = await DocumentPickerPopup.open(anchorRect, "", ["RollTable"]);
    if (!result?.uuid) return;
    const before = this._getState();
    const config = this._getConfig();
    config.baseItem.tableUuid = result.uuid;
    await this._saveConfig(config);
    this._recordUndo("pickBaseTable", before);
    this.render();
  }

  static async #onClearBaseItem() {
    const before = this._getState();
    const config = this._getConfig();
    config.baseItem.uuid = null;
    config.baseItem.tableUuid = null;
    await this._saveConfig(config);
    this._recordUndo("clearBaseItem", before);
    this.render();
  }

  static #onPickImgPath() {
    new FilePicker({
      type: "image",
      callback: async (path) => {
        const before = this._getState();
        const config = this._getConfig();
        config.img.path = path;
        await this._saveConfig(config);
        this._recordUndo("pickImgPath", before);
        this.render();
      }
    }).render(true);
  }

  static #onPickImgFolder() {
    new FilePicker({
      type: "imagevideo",
      callback: async (path) => {
        const folderPath = path.includes("/")
          ? path.substring(0, path.lastIndexOf("/"))
          : "";
        const before = this._getState();
        const config = this._getConfig();
        config.img.path = folderPath || path;
        await this._saveConfig(config);
        this._recordUndo("pickImgFolder", before);
        this.render();
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

  // ---- Close -----------------------------------------------------------------

  _onClose(_options) {
    ItemTemplateEditorWindow._instances.delete(this.table.id);
  }
}
